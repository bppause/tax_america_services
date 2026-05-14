// Audit helper — write side of the platform audit trail.
//
// One store:
//   audit_logs — generic platform audit (every module emits here)
//
// Returned as a factory so the supabase client doesn't have to be a global
// singleton. The read side (admin GET /api/platform/audit/logs) was removed
// when the Airbnb owners app split out — its readers were Airbnb-only.

'use strict';

const { v4: uuidv4 } = require('uuid');
const { warn } = require('../../logger');

module.exports = function createAuditHelpers(supabase, deps={}) {
  const getAppConfig = deps.getAppConfig || (async () => ({}));

  // Kill-switch + per-event-type gate. Reads app_config and decides whether to
  // skip the insert. Returns true to allow the insert, false to skip.
  // Both the global flag and the per-event toggle map are stored as strings
  // ('true'/'false' for the bool, JSON for the map) to match the existing
  // app_config storage pattern (no schema-typed bools in that key/value table).
  const shouldRecordAudit = async (entity, action) => {
    try {
      const cfg = await getAppConfig();
      if (String(cfg.audit_kill_switch || 'false') === 'true') return false;
      const togglesRaw = cfg.audit_event_toggles || '{}';
      let toggles = {};
      try { toggles = JSON.parse(togglesRaw) || {}; } catch(e) { toggles = {}; }
      const key = `${entity}.${action}`;
      if (toggles[key] === false) return false;
    } catch(e) { warn('audit gate read failed: ' + (e?.message || e)); }
    return true;
  };

  const auditLog = async ({ entity, entityId='', action, actorUid='', actorEmail='', actorName='', before=null, after=null, reason='', communityId='' }) => {
    if (!(await shouldRecordAudit(entity, action))) return;
    try {
      const row = {
        id: 'log_' + uuidv4().slice(0,10),
        entity: String(entity || ''),
        entity_id: String(entityId || ''),
        action: String(action || ''),
        actor_uid: String(actorUid || ''),
        actor_email: String(actorEmail || '').toLowerCase(),
        actor_name: String(actorName || ''),
        reason: String(reason || ''),
        before_data: before || null,
        after_data: after || null,
        created_at: new Date().toISOString(),
      };
      if (communityId) row.community_id = String(communityId);
      await supabase.from('audit_logs').insert(row);
    } catch(e) { warn('Audit log save failed: ' + (e?.message || e)); }
  };

  return { auditLog };
};
