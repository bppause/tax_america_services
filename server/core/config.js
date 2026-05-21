// App config + email notification config + SLA defaults + the small
// `getCommunity` lookup. Lifted byte-identical from server.js stage 4e.
//
// Public exports (returned by the factory):
//   constants — DEFAULT_EMAIL_NOTIFICATION_CONFIG, DEFAULT_SLA_HOURS,
//               DEFAULT_ESCALATION_CC_EMAILS, OVERRIDABLE_COMMUNITY_KEYS
//   getCommunity              — single-row lookup against the communities table
//   getAppConfig              — defaults + global overrides + community overlay
//                               + community-branding overlay (calls getCommunity)
//   getSlaHours               — SLA hours scalar reader
//   getEscalationCcEmails     — escalation CC emails reader
//   getEmailNotificationConfig — merged routing matrix
//
// `getCommunity` lives here (not in core/roles.js) because getAppConfig
// calls it for the layer-3 branding overlay; keeping both in one file
// avoids a circular dep between config and roles.
//
// See docs/platform/PLATFORM_ARCHITECTURE.md §11.

'use strict';

const { warn } = require('../../logger');
const { safeJsonObject, normalizeRecipients } = require('./utils');

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_EMAIL_NOTIFICATION_CONFIG = {
  incident_new:              { enabled:true,  reporter:true,  owner:true,  operator:true,  globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  incident_sla_notification: { enabled:true,  reporter:true,  owner:true,  operator:true,  globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  incident_sla_reminder:     { enabled:true,  reporter:true,  owner:true,  operator:true,  globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  incident_sla:              { enabled:true,  reporter:true,  owner:true,  operator:true,  globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  incident_verified:         { enabled:true,  reporter:true,  owner:true,  operator:true,  globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  incident_resolution_added: { enabled:true,  reporter:true,  owner:true,  operator:true,  globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  incident_resolved:         { enabled:true,  reporter:true,  owner:true,  operator:true,  globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  incident_general_sla:      { enabled:true,  reporter:false, owner:false, operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  registration_submitted:    { enabled:true,  owner:true,  operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  registration_approved:     { enabled:true,  owner:true,  operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  registration_declined:     { enabled:true,  owner:true,  operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  registration_status_admin: { enabled:true,  owner:false, operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  registration_reviewer:     { enabled:true,  owner:true,  operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  listing_created:           { enabled:true,  owner:true,  operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  listing_updated:           { enabled:true,  owner:true,  operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
  listing_deleted:           { enabled:true,  owner:true,  operator:false, globalAdmin:true,  delegateAdmin:true,  communityAdmin:true  },
};

const DEFAULT_SLA_HOURS = Number(process.env.DEFAULT_SLA_HOURS || 24);
const DEFAULT_ESCALATION_CC_EMAILS = String(process.env.DEFAULT_ESCALATION_CC_EMAILS || process.env.SLA_CC_EMAILS || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);

// Per-event SLA policy defaults. Used when app_config.sla_policies is missing
// a key, or as the fallback when sla_policies itself isn't set yet.
// `enabled:false` halts the SLA clock for that event entirely.
const DEFAULT_SLA_POLICIES = {
  step1_verify:  { enabled: true, hours: DEFAULT_SLA_HOURS, maxReminders: 3 },
  step2_resolve: { enabled: true, hours: DEFAULT_SLA_HOURS, maxReminders: 3 },
  admin_close:   { enabled: true, hours: 48,                maxReminders: 3 },
};
// Owner-facing events the community admin is allowed to override via
// community_config. admin_close is platform-only.
const COMMUNITY_OVERRIDABLE_SLA_EVENTS = ['step1_verify', 'step2_resolve'];

const OVERRIDABLE_COMMUNITY_KEYS = ['mission_title_es','mission_body_es','mission_title_en','mission_body_en','mission_sections_es','mission_sections_en','escalation_cc_emails','community_admin_default_permissions','tooltips_es','tooltips_en','ui_labels_es','ui_labels_en','email_enabled','sla_policies'];

// Canonical list of every audit event type the platform writes. Built by
// scanning every auditLog({entity:'X', action:'Y'}) call site. The admin UI
// renders a checkbox per entry so admins can disable individual event types
// without flipping the global audit kill-switch.
//
// Adding a new event type: append `<entity>.<action>` here AND make sure
// somewhere in server/ does `auditLog({entity, action, ...})` with the same
// strings. The grid auto-picks it up after a server restart.
const KNOWN_AUDIT_EVENT_TYPES = [
  'app_config.update',
  'community.create', 'community.update', 'community.delete',
  'community_config.set_overrides_enabled', 'community_config.update_overrides',
  'community_email_routing.update',
  'community_membership.promote_admin', 'community_membership.demote_admin', 'community_membership.update_permissions',
  'contact_email.send',
  'email_templates.update',
  'incident.create', 'incident.verify', 'incident.add-resolution', 'incident.assign', 'incident.close-general', 'incident.resolve', 'incident.delete',
  'listing.create', 'listing.update', 'listing.delete',
  'user_role.delegate_update',
];

module.exports = function createConfigHelpers(supabase, { EMAIL_FROM }) {
  const getCommunity = async (communityId='tax-america-services') => {
    try {
      const { data } = await supabase.from('communities').select('*').eq('id', communityId).maybeSingle();
      return data || null;
    } catch(e) { warn('getCommunity failed: ' + (e?.message || e)); return null; }
  };

  const getAppConfig = async (communityId='tax-america-services') => {
    const cfg = {
      sla_hours:String(DEFAULT_SLA_HOURS||24),
      escalation_cc_emails:DEFAULT_ESCALATION_CC_EMAILS.join(','),
      // Master switches — both default to off (transmission allowed). Toggle ON in
      // admin UI to halt all outbound emails / audit-log writes platform-wide.
      // Used by sendTemplatedEmail/sendSplitEmail (core/email.js) and auditLog
      // (core/audit.js) to short-circuit when the kill-switch is engaged.
      email_kill_switch:'false',
      audit_kill_switch:'false',
      // Per-event-type audit toggles. Stored as a JSON string in app_config to
      // keep the table key/value-typed. Missing entries default to ENABLED;
      // explicit `false` for an "<entity>.<action>" key disables that single
      // event type. The full canonical event list is KNOWN_AUDIT_EVENT_TYPES
      // below — the admin UI builds its checkbox grid from that list.
      audit_event_toggles:'{}',
      // Per-community email enable flag — defaults to true. Listed in
      // OVERRIDABLE_COMMUNITY_KEYS so each community can opt out of email
      // delivery without affecting other communities. The global kill-switch
      // takes precedence: if email_kill_switch is true, no community sends.
      email_enabled:'true',
      // Tax-app fallback brand strings. The communities table row (Layer 3
      // of getAppConfig) overrides these via community.name / community.name_en
      // for the practice the email is being sent on behalf of. Kept neutral
      // so a missing/misconfigured community row never leaks Airbnb-era
      // strings ("Morros KAI", "Airbnb KAI") into tax outbound emails.
      complex_name_es: 'Tax America Services',
      complex_name_en: 'Tax America Services',
      complex_location: '',
      complex_logo: '',
      complex_bg: '',
      email_from_name: 'Tax America Services',
      email_from_address: (EMAIL_FROM.match(/<([^>]+)>/) || [])[1]?.trim() || EMAIL_FROM,
      email_from_name_en: 'Tax America Services',
      email_from_address_en: (EMAIL_FROM.match(/<([^>]+)>/) || [])[1]?.trim() || EMAIL_FROM,
      mission_title_es:'Misión y normas de la comunidad',
      mission_body_es:'Crear una comunidad organizada, informada y proactiva que proteja el valor de nuestras propiedades y eleve la experiencia en Morros KAI.',
      mission_title_en:'Mission and community rules',
      mission_body_en:'Create an organized, informed, and proactive community that protects property value and improves the Morros KAI guest experience.',
      mission_sections_es:'{"title": "Misión y normas de la comunidad", "subtitle": "Referencia para propietarios aprobados · Propietarios Airbnb KAI", "sectionLabel": "Nuestra misión", "heading": "Crear una comunidad organizada, informada y proactiva.", "body": "La aplicación ayuda a proteger el valor de nuestras propiedades, mejorar la coordinación entre propietarios y elevar la experiencia de los huéspedes en Morros KAI.", "cards": [{"icon": "🏡", "title": "Gestión centralizada", "text": "Organizar apartamentos, contactos, emails de notificación y enlaces importantes en un solo lugar."}, {"icon": "⚠️", "title": "Reportes transparentes", "text": "Documentar incidentes de manera rápida para que el propietario correcto reciba aviso y pueda tomar acción."}, {"icon": "🤝", "title": "Colaboración comunitaria", "text": "Compartir información útil entre propietarios aprobados para operar mejor y prevenir problemas repetidos."}, {"icon": "📊", "title": "Mejora continua", "text": "Usar datos y tendencias para elevar la calidad del servicio, la comunicación y la experiencia del huésped."}], "participationTitle": "📌 Reglas de participación", "participationRules": ["Reportar incidentes con información clara, objetiva y verificable.", "Incluir detalles útiles: apartamento, huésped, fecha, tipo de incidente y descripción.", "Mantener respeto y confidencialidad en los comentarios.", "No publicar contenido ofensivo, especulativo o no relacionado con la operación.", "Usar los reportes para prevenir, corregir y mejorar; no para conflictos personales."], "accessTitle": "🔐 Acceso y responsabilidad", "accessRules": ["El acceso requiere Google Sign-In.", "Cada apartamento solo puede pertenecer a una cuenta aprobada.", "Los nuevos registros quedan pendientes hasta revisión.", "Los propietarios aprobados pueden revisar solicitudes pendientes y aprobar o rechazar con motivo.", "Las notificaciones se envían al email de Google y al email del listing cuando son diferentes."]}'
    };
    // Layer 1: global app_config overrides
    try { const { data, error } = await supabase.from('app_config').select('key,value'); if (!error) (data||[]).forEach(r=>cfg[r.key]=r.value); }
    catch(e) { warn('App config read failed: ' + (e?.message || e)); }
    // Layer 2: per-community config overrides (community_config table)
    if (communityId) {
      try {
        const { data } = await supabase.from('community_config').select('key,value').eq('community_id', communityId);
        (data||[]).forEach(r=>cfg[r.key]=r.value);
      } catch(e) { warn('Community config read failed: ' + (e?.message || e)); }
      // Layer 3: community table branding fields override matching config keys
      try {
        const community = await getCommunity(communityId);
        if (community) {
          if (community.name) cfg.complex_name_es = community.name;
          if (community.name_en) cfg.complex_name_en = community.name_en;
          if (community.logo_url) cfg.complex_logo = community.logo_url;
          if (community.background_url) cfg.complex_bg = community.background_url;
          if (community.city && community.country) cfg.complex_location = `${community.city} · ${community.country}`;
          if (community.tower) cfg.community_tower = community.tower;
        }
      } catch(e) { warn('Community branding override failed: ' + (e?.message || e)); }
    }
    cfg.mission_title = cfg.mission_title_es;
    cfg.mission_body = cfg.mission_body_es;
    return cfg;
  };

  const getSlaHours = async () => { const cfg = await getAppConfig(); const h = Number(cfg.sla_hours || DEFAULT_SLA_HOURS || 24); return Number.isFinite(h) && h > 0 ? h : 24; };

  // Resolved per-event SLA policy. Layers:
  //   1) DEFAULT_SLA_POLICIES (constant fallback)
  //   2) app_config.sla_policies (platform-wide JSON)
  //   3) community_config.sla_policies (per-community, owner events only)
  //
  // Returns the fully-merged policies object. Callers can index by event
  // name. Unknown event names fall back to the step1_verify policy.
  const getSlaPolicies = async (communityId='kai') => {
    const cfg = await getAppConfig(communityId);
    const result = JSON.parse(JSON.stringify(DEFAULT_SLA_POLICIES));
    // Layer 1→2: platform JSON. cfg already has community_config overlaid on
    // top of app_config (see getAppConfig), so we read sla_policies once and
    // then strip out any admin_close override that came from community_config.
    const platformRaw = safeJsonObject(cfg.sla_policies, {});
    for (const [event, policy] of Object.entries(platformRaw)) {
      if (!result[event]) continue;
      const hours = Number(policy?.hours);
      const maxReminders = Number(policy?.maxReminders);
      if (Number.isFinite(hours) && hours > 0) result[event].hours = hours;
      if (Number.isFinite(maxReminders) && maxReminders >= 0) result[event].maxReminders = maxReminders;
      if (typeof policy?.enabled === 'boolean') result[event].enabled = policy.enabled;
    }
    // Re-fetch the platform-only sla_policies so we can ignore community
    // overrides on platform-only events (admin_close).
    if (communityId && communityId !== 'kai') {
      try {
        const { data: gRow } = await supabase.from('app_config').select('value').eq('key','sla_policies').maybeSingle();
        const platformOnly = safeJsonObject(gRow?.value, {});
        const adminPolicy = platformOnly.admin_close;
        if (adminPolicy && typeof adminPolicy === 'object') {
          const hours = Number(adminPolicy.hours);
          const maxReminders = Number(adminPolicy.maxReminders);
          if (Number.isFinite(hours) && hours > 0) result.admin_close.hours = hours;
          if (Number.isFinite(maxReminders) && maxReminders >= 0) result.admin_close.maxReminders = maxReminders;
          if (typeof adminPolicy.enabled === 'boolean') result.admin_close.enabled = adminPolicy.enabled;
        }
      } catch(e) { warn('SLA platform-only re-read failed: ' + (e?.message || e)); }
    }
    return result;
  };

  // Convenience: resolve a single event's policy. Defaults to step1_verify
  // if an unknown event name is passed.
  const getSlaPolicy = async (event='step1_verify', communityId='kai') => {
    const policies = await getSlaPolicies(communityId);
    return policies[event] || policies.step1_verify;
  };

  const getEscalationCcEmails = async () => normalizeRecipients(String((await getAppConfig()).escalation_cc_emails || '').split(','));

  const getEmailNotificationConfig = async () => {
    const cfg = await getAppConfig();
    const raw = safeJsonObject(cfg.email_notification_config, {});
    const result = {};
    for (const [key, def] of Object.entries(DEFAULT_EMAIL_NOTIFICATION_CONFIG)) {
      const stored = (raw[key] && typeof raw[key] === 'object') ? raw[key] : {};
      result[key] = { ...def, ...stored };
    }
    return result;
  };

  return {
    DEFAULT_EMAIL_NOTIFICATION_CONFIG,
    DEFAULT_SLA_HOURS,
    DEFAULT_SLA_POLICIES,
    COMMUNITY_OVERRIDABLE_SLA_EVENTS,
    DEFAULT_ESCALATION_CC_EMAILS,
    OVERRIDABLE_COMMUNITY_KEYS,
    KNOWN_AUDIT_EVENT_TYPES,
    getCommunity,
    getAppConfig,
    getSlaHours,
    getSlaPolicies,
    getSlaPolicy,
    getEscalationCcEmails,
    getEmailNotificationConfig,
  };
};

// Top-level constant exports for callers that don't need the supabase-bound factory.
module.exports.DEFAULT_EMAIL_NOTIFICATION_CONFIG = DEFAULT_EMAIL_NOTIFICATION_CONFIG;
module.exports.DEFAULT_SLA_HOURS = DEFAULT_SLA_HOURS;
module.exports.DEFAULT_SLA_POLICIES = DEFAULT_SLA_POLICIES;
module.exports.COMMUNITY_OVERRIDABLE_SLA_EVENTS = COMMUNITY_OVERRIDABLE_SLA_EVENTS;
module.exports.DEFAULT_ESCALATION_CC_EMAILS = DEFAULT_ESCALATION_CC_EMAILS;
module.exports.OVERRIDABLE_COMMUNITY_KEYS = OVERRIDABLE_COMMUNITY_KEYS;
module.exports.KNOWN_AUDIT_EVENT_TYPES = KNOWN_AUDIT_EVENT_TYPES;
