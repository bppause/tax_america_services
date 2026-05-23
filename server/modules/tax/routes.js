// Tax module — HTTP routes.
//
// Mounted at /api/m/tax/* from server/index.js.
//
// Phase 1 endpoints:
//   GET  /community/:slug          — public; community branding + enabled products for the landing page
//   POST /leads                    — public; anonymous contact-form submission
//   GET  /leads                    — owner-only (deferred to Phase 4); returns 501 for now
//
// Phase 1.5 endpoints (compliance reminders):
//   GET  /respond/:token           — public; verify magic-link token, return period info + checklist
//   POST /respond/:token           — public; accept customer response, mark info_received
//   POST /admin/cron/run           — global-admin; run one reminder cron cycle
//   GET  /admin/customers          — global-admin; list tax customers + subscriptions for a community
//
// Phase 2+ will add: /auth/*, /engagements/*, /documents/*, /messages/*, /products/*.

'use strict';

const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { warn } = require('../../../logger');
const { isValidEmail, normalizeLanguage } = require('../../core/utils');
const {
  parsePersonName, normalizeNameParts, composePersonName,
  resolveNamePayload, firstNameOf, displayNameOf,
} = require('./names');
const { suggestionsForSlug } = require('./task-suggestions');
const {
  PERMISSIONS: TAX_PERMISSIONS,
  hasEmployeePermission,
  sanitizePermissions,
} = require('./permissions');
const { generatePeriods: generateSchedulePeriods } = require('./schedule');

const TAX_BUSINESS_TYPE = 'tax';
const MAX_TEXT_LEN = 4000;
const MAX_NAME_LEN = 200;
const MAX_PHONE_LEN = 40;
const MAX_TOKEN_LEN = 64;

const trim = (v, max) => String(v || '').trim().slice(0, max);
const localeOf = (v) => (normalizeLanguage(v) === 'en' ? 'en' : 'es');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = function createTaxRouter(deps) {
  const {
    supabase, requireSupabaseEnv, sendSupabaseError,
    auditLog,
    sendTaxLeadEmail,
    sendTaxTaskAssignedEmail,
    sendTaxReminderEmail,
    sendTaxDocumentEmail,
    sendTaxMessageEmail,
    sendTaxMessagePracticeEmail,
    sendTaxMessageEmployeeEmail,
    sendTaxWelcomeEmail,
    sendTaxStaffWelcomeEmail,
    sendTaxSignatureRequestEmail,
    sendTaxSignatureSignedEmail,
    previewTaxEmail,
    getTemplateDefaults,
    publicAppUrl,
    emailFrom: PLATFORM_EMAIL_FROM,
    isGlobalAdmin,
    isEnvGlobalAdminEmail,
    runReminderCron,
    fireReminderForPeriod,
  } = deps;

  const router = express.Router();

  // Builds a customer-facing URL: portal URL when the community has the
  // portal enabled, otherwise the public landing page. Used by every email
  // sender that would otherwise drop the customer onto a closed portal.
  async function customerLandingOrPortalUrl(communityId, portalSuffix = '') {
    const base = (typeof publicAppUrl === 'function' ? publicAppUrl() : '');
    const { data: comm } = await supabase.from('communities')
      .select('tax_customer_portal_enabled').eq('id', communityId).maybeSingle();
    const portalOn = !!comm?.tax_customer_portal_enabled;
    if (portalOn) return `${base}/tax/${communityId}/portal${portalSuffix}`;
    return `${base}/tax/${communityId}`;
  }

  // One-time backfill of structured-name parts for legacy rows where
  // `name` was the only stored value. Fire-and-forget on first request:
  // we run the backfill once per process, in the background, and only
  // touch rows whose first_name/middle_name/last_name are all empty.
  // Subsequent boots are no-ops (the WHERE filter excludes already-split
  // rows). Errors are warned but never block routing.
  let namesBackfillStarted = false;
  function runNamesBackfillOnce() {
    if (namesBackfillStarted) return;
    namesBackfillStarted = true;
    (async () => {
      const tables = ['tax_customers', 'tax_employees', 'tax_leads'];
      for (const table of tables) {
        try {
          const { data } = await supabase.from(table)
            .select('id, name, first_name, middle_name, last_name')
            .eq('first_name', '').eq('middle_name', '').eq('last_name', '')
            .neq('name', '').limit(2000);
          if (!data || !data.length) continue;
          for (const row of data) {
            const parts = normalizeNameParts(parsePersonName(row.name));
            const composed = composePersonName(parts);
            await supabase.from(table).update({
              first_name: parts.first,
              middle_name: parts.middle,
              last_name: parts.last,
              // Keep `name` synced to the normalized form so legacy
              // displays stop being shouty.
              name: composed || row.name,
            }).eq('id', row.id);
          }
        } catch (e) {
          warn(`[tax] names backfill failed on ${table}`, e?.message || e);
        }
      }
    })();
  }
  router.use((req, _res, next) => { runNamesBackfillOnce(); next(); });

  // ── GET /health ─────────────────────────────────────────────────────────────
  // Lightweight readiness probe for Render and uptime checks. Confirms the tax
  // module is mounted and Supabase env vars are present (no DB round-trip).
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      module: 'tax',
      version: '0.1.5',
      supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      ts: new Date().toISOString(),
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Phase 5: platform admin (cross-tenant tax-module operations)
  //
  // Distinct from /admin/* (per-community) — these endpoints operate ACROSS
  // every tax community on this deployment. Strict gate: only emails listed
  // in GLOBAL_ADMIN_EMAILS pass. role='admin' employees of a community do
  // NOT have platform access (they manage their community, not the platform).
  // ════════════════════════════════════════════════════════════════════════════

  // Strict platform-admin gate. Returns the verified email or null
  // (after sending a 403). Accepts either:
  //   - x-firebase-uid + x-firebase-email (dashboard logged-in path)
  //   - x-admin-email (curl path)
  async function requirePlatformAdmin(req, res) {
    if (!requireSupabaseEnv(res)) return null;
    const email = trim(
      req.get('x-firebase-email') || req.get('x-admin-email') || req.query.adminEmail || '',
      200
    ).toLowerCase();
    if (!email) {
      res.status(401).json({ error: 'Authentication required.' });
      return null;
    }
    if (typeof isEnvGlobalAdminEmail !== 'function' || !isEnvGlobalAdminEmail(email)) {
      res.status(403).json({ error: 'Platform administrator access required.' });
      return null;
    }
    return email;
  }

  // POST /platform/auth/verify
  // Lets the frontend confirm the signed-in Firebase email is a platform
  // admin without actually performing a sensitive action. Returns 200 ok or
  // 403; the dashboard renders accordingly.
  router.post('/platform/auth/verify', async (req, res) => {
    if (!(await requirePlatformAdmin(req, res))) return;
    res.json({ ok: true });
  });

  // GET /platform/communities
  // Returns every tax community on this deployment with key stats. Powers
  // the platform dashboard's overview table.
  router.get('/platform/communities', async (req, res) => {
    if (!(await requirePlatformAdmin(req, res))) return;

    const { data: communities, error } = await supabase.from('communities')
      .select('id, name, contact_email, phone, default_locale, brand_primary_color, brand_secondary_color, tax_allow_customer_notif_pref_change, created_at')
      .eq('business_type', TAX_BUSINESS_TYPE)
      .order('created_at', { ascending: true });
    if (error) return sendSupabaseError(res, error);

    // For each community, gather count stats in parallel. Each .select('id',
    // { count: 'exact', head: true }) hits the DB with HEAD only — no rows
    // come back, just the count. Cheap.
    const stats = await Promise.all((communities || []).map(async (c) => {
      const [custs, emps, leads, docs, threads] = await Promise.all([
        supabase.from('tax_customers').select('id', { count: 'exact', head: true })
          .eq('community_id', c.id).eq('status', 'active'),
        supabase.from('tax_employees').select('id', { count: 'exact', head: true })
          .eq('community_id', c.id).eq('status', 'active'),
        supabase.from('tax_leads').select('id', { count: 'exact', head: true })
          .eq('community_id', c.id).in('status', ['new', 'contacted']),
        supabase.from('tax_documents').select('id', { count: 'exact', head: true })
          .eq('community_id', c.id).is('deleted_at', null).eq('status', 'uploaded'),
        supabase.from('tax_message_threads').select('id', { count: 'exact', head: true })
          .eq('community_id', c.id).eq('status', 'open'),
      ]);
      return {
        ...c,
        stats: {
          customers: custs.count || 0,
          employees: emps.count || 0,
          openLeads: leads.count || 0,
          documents: docs.count || 0,
          openThreads: threads.count || 0,
        },
      };
    }));
    res.json({ communities: stats });
  });

  // POST /platform/communities
  // Provisions a new tax community: communities row + initial admin employee
  // + the standard active=true status. Optional brand colors and locale.
  router.post('/platform/communities', async (req, res) => {
    const adminEmail = await requirePlatformAdmin(req, res); if (!adminEmail) return;
    const body = req.body || {};
    const id = trim(body.id, 100).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const name = trim(body.name, 200);
    const contactEmail = trim(body.contactEmail, 200).toLowerCase();
    const phone = trim(body.phone, 40);
    const defaultLocale = body.defaultLocale === 'en' ? 'en' : 'es';
    const brandPrimary = trim(body.brandPrimaryColor, 24) || '';
    const brandSecondary = trim(body.brandSecondaryColor, 24) || '';
    const ownerEmail = trim(body.ownerEmail, 200).toLowerCase();
    const ownerName = trim(body.ownerName, 200);

    if (!id || !name || !contactEmail || !ownerEmail) {
      return res.status(400).json({ error: 'id, name, contactEmail, and ownerEmail are required.' });
    }
    if (!isValidEmail(contactEmail) || !isValidEmail(ownerEmail)) {
      return res.status(400).json({ error: 'contactEmail and ownerEmail must be valid email addresses.' });
    }

    // Reject existing slug — caller picks a different one.
    const { data: existing } = await supabase.from('communities')
      .select('id').eq('id', id).maybeSingle();
    if (existing) return res.status(409).json({ error: 'A community with this slug already exists.' });

    const insert = {
      id,
      name,
      contact_email: contactEmail,
      phone,
      default_locale: defaultLocale,
      business_type: TAX_BUSINESS_TYPE,
    };
    if (brandPrimary)   insert.brand_primary_color   = brandPrimary;
    if (brandSecondary) insert.brand_secondary_color = brandSecondary;

    const { error: cErr } = await supabase.from('communities').insert(insert);
    if (cErr) return sendSupabaseError(res, cErr);

    // Create the first admin employee. This lets the owner sign in at
    // /tax/{id}/employee immediately (their first sign-in links Firebase
    // UID to the seeded row via Phase 2a /employee/auth/link).
    const empId = 'emp_' + uuidv4().slice(0, 12);
    const { error: eErr } = await supabase.from('tax_employees').insert({
      id: empId,
      community_id: id,
      email: ownerEmail,
      name: ownerName || name + ' (owner)',
      locale: defaultLocale,
      role: 'admin',
    });
    if (eErr) {
      // Roll back the community insert so the operator can retry cleanly.
      await supabase.from('communities').delete().eq('id', id);
      return sendSupabaseError(res, eErr);
    }

    try {
      await auditLog({
        entity: 'tax.platform.community', entityId: id,
        action: 'provision', actorEmail: adminEmail,
        after: { name, contactEmail, ownerEmail, defaultLocale },
      });
    } catch (_e) {}

    res.json({ ok: true, communityId: id, ownerEmployeeId: empId });
  });

  // Admin gate (Phase 4d: requireGlobalAdmin retired — all /admin/* now
  // use requireOwnerAdmin below). Accepts EITHER auth path:
  //   (a) Global admin via x-admin-email header matching GLOBAL_ADMIN_EMAILS
  //       (legacy curl flows from Phases 1.5–3b stay working unchanged)
  //   (b) Firebase auth from a tax_employees row with role='admin' for the
  //       targeted community (the dashboard logged-in path; lets additional
  //       admin employees use the dashboard without being in the env var).
  // Returns { email, source, employee? } on success; writes 403 + returns
  // null on failure. Always await this.
  // Resolves the caller to either a global admin (email allow-list) or a
  // role='admin' tax_employees row. When `permissionKey` is supplied, the
  // employee's `permissions` map is also checked — owners can revoke
  // individual keys per employee (the user requested "default = same as
  // owner"). Global-admin actors always pass regardless of the key.
  async function requireOwnerAdmin(req, res, permissionKey = null) {
    if (!requireSupabaseEnv(res)) return null;
    const headerEmail = trim(req.get('x-admin-email') || req.query.adminEmail || '', 200).toLowerCase();
    if (headerEmail) {
      const envOk = typeof isEnvGlobalAdminEmail === 'function' && isEnvGlobalAdminEmail(headerEmail);
      const dbOk  = !envOk && typeof isGlobalAdmin === 'function'
        ? await isGlobalAdmin('', headerEmail)
        : false;
      if (envOk || dbOk) return { email: headerEmail, source: 'global' };
    }
    const uid = trim(req.get('x-firebase-uid') || '', 200);
    const email = trim(req.get('x-firebase-email') || '', 200).toLowerCase();
    const communitySlug = trim(req.get('x-tax-community') || '', 200);
    if (uid && email && communitySlug) {
      const { data: emp } = await supabase.from('tax_employees')
        .select('id, community_id, email, role, status, firebase_uid, permissions')
        .eq('email', email).eq('community_id', communitySlug).maybeSingle();
      if (emp && emp.status === 'active' && emp.role === 'admin' &&
          (!emp.firebase_uid || emp.firebase_uid === uid)) {
        if (permissionKey && !hasEmployeePermission(emp, permissionKey)) {
          res.status(403).json({
            error: 'permission_revoked',
            message: `Your owner revoked the "${permissionKey}" permission.`,
          });
          return null;
        }
        return { email, source: 'employee', employee: emp };
      }
    }
    res.status(403).json({ error: 'Admin authentication required.' });
    return null;
  }

  // ── GET /community/:slug ────────────────────────────────────────────────────
  router.get('/community/:slug', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const slug = trim(req.params.slug, 200);
    if (!slug) return res.status(400).json({ error: 'Community slug required.' });

    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('*')
      .eq('id', slug)
      .eq('business_type', TAX_BUSINESS_TYPE)
      .maybeSingle();
    if (cErr) return sendSupabaseError(res, cErr);
    if (!community) return res.status(404).json({ error: 'Tax community not found.' });

    const { data: products, error: pErr } = await supabase
      .from('tax_products')
      .select('id, slug, category, enabled, display_order, name_i18n, description_i18n, long_description_i18n, required_documents, icon, video_url, cadence_kind, anchor_rule, employee_notes_i18n')
      .eq('community_id', slug)
      .eq('enabled', true)
      .order('display_order', { ascending: true });
    if (pErr) return sendSupabaseError(res, pErr);

    res.json({ community, products: products || [] });
  });

  // ── GET /community/:slug/faqs ───────────────────────────────────────────
  // Public landing-page feed of FAQs. Surfaces the merged "effective"
  // set across every active relationship type for the community (no
  // customer filter — anyone reading the marketing page sees the full
  // catalog grouped by relationship). Empty `groups` is a legitimate
  // result for new communities; the frontend hides the section.
  router.get('/community/:slug/faqs', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const slug = trim(req.params.slug, 200);
    if (!slug) return res.status(400).json({ error: 'Community slug required.' });
    const { data: community } = await supabase.from('communities')
      .select('id, business_type').eq('id', slug).maybeSingle();
    if (!community || community.business_type !== TAX_BUSINESS_TYPE) {
      return res.status(404).json({ error: 'Tax community not found.' });
    }
    try {
      const data = await loadEffectiveFaqs({ communityId: slug, filterTypeIds: null });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e?.message || 'Failed to load FAQs.' }); }
  });

  // ── GET /community/:slug/team ───────────────────────────────────────────
  // Public feed of employees the owner has opted into the Meet-the-team
  // section. name, optional title + photo + bilingual bio. Hidden
  // employees never appear; the section renders iff at least one row.
  router.get('/community/:slug/team', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const slug = trim(req.params.slug, 200);
    if (!slug) return res.status(400).json({ error: 'Community slug required.' });
    const { data: community } = await supabase.from('communities')
      .select('id, business_type').eq('id', slug).maybeSingle();
    if (!community || community.business_type !== TAX_BUSINESS_TYPE) {
      return res.status(404).json({ error: 'Tax community not found.' });
    }
    const { data, error } = await supabase.from('tax_employees')
      .select('id, name, first_name, middle_name, last_name, photo_url, title_i18n, bio_i18n, role_i18n, highlights_i18n, education_i18n, experience_i18n, homepage_display_order')
      .eq('community_id', slug)
      .eq('show_on_homepage', true)
      .eq('status', 'active')
      .order('homepage_display_order', { ascending: true })
      .limit(50);
    if (error) return sendSupabaseError(res, error);
    res.json({ members: data || [] });
  });

  // ── GET /community/:slug/articles ───────────────────────────────────────
  // Public landing-page feed of help articles. Surfaces the effective
  // owner-audience articles (the "How we work" set the practice
  // publishes), no customer filter. relationship_type joined so the
  // frontend can group by service if helpful.
  router.get('/community/:slug/articles', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const slug = trim(req.params.slug, 200);
    if (!slug) return res.status(400).json({ error: 'Community slug required.' });
    const { data: community } = await supabase.from('communities')
      .select('id, business_type').eq('id', slug).maybeSingle();
    if (!community || community.business_type !== TAX_BUSINESS_TYPE) {
      return res.status(404).json({ error: 'Tax community not found.' });
    }
    try {
      const articles = await loadEffectiveHelp({
        communityId: slug, audience: 'customer',
        customerRelationshipTypeIds: null,
      });
      res.json({ articles: Array.isArray(articles) ? articles : [] });
    } catch (e) { res.status(500).json({ error: e?.message || 'Failed to load articles.' }); }
  });

  // ── POST /leads ─────────────────────────────────────────────────────────────
  router.post('/leads', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const nameParts = resolveNamePayload(body);
    const name = nameParts.name;
    const email = trim(body.email, MAX_NAME_LEN).toLowerCase();
    const phone = trim(body.phone, MAX_PHONE_LEN);
    // WhatsApp is optional. Empty string is fine; anything else must
    // normalize to E.164 or we refuse the submission so the value the
    // owner sees on the lead row is always something they can click.
    let whatsapp = '';
    if (body.whatsapp !== undefined && String(body.whatsapp || '').trim() !== '') {
      const norm = normalizeWhatsapp(String(body.whatsapp));
      if (!norm) {
        return res.status(400).json({ error: 'whatsapp_invalid',
          message: 'WhatsApp must be in international format, e.g., +14155551234.' });
      }
      whatsapp = norm;
    }
    // Phase 4n.12: accept multi-select. `productSlugs` is the new
    // source-of-truth; fall back to the legacy single `productSlug` so
    // older clients keep working until they redeploy.
    const productSlugsRaw = Array.isArray(body.productSlugs) ? body.productSlugs
                          : (body.productSlug ? [body.productSlug] : []);
    const productSlugs = productSlugsRaw
      .map(s => trim(s, 200)).filter(Boolean)
      .filter((s, i, arr) => arr.indexOf(s) === i)    // dedupe
      .slice(0, 20);                                  // cap so we can't be flooded
    const productSlug = productSlugs[0] || '';
    const message = trim(body.message, MAX_TEXT_LEN);
    const customerType = (String(body.customerType || '').toLowerCase() === 'business')
      ? 'business' : 'individual';
    // For individuals we deliberately drop any company string the
    // client might still send — keeps the row tidy and prevents a
    // stale "(formerly business)" value from sticking around if the
    // visitor flipped the toggle mid-form.
    const company = customerType === 'business' ? trim(body.company, 200) : '';
    const preferredLocale = localeOf(body.locale);
    const userAgent = trim(req.get('user-agent') || '', 500);
    const ip = trim((req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0], 80);

    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (customerType === 'business' && !company) {
      return res.status(400).json({ error: 'business_name_required',
        message: 'Business name is required for a business lead.' });
    }
    if (productSlugs.length === 0) {
      return res.status(400).json({ error: 'service_required',
        message: 'Please pick at least one service so we route you to the right specialist.' });
    }
    if (!phone) return res.status(400).json({ error: 'phone_required',
      message: 'A phone number is required so we can reach you.' });

    // Honeypot — bots fill the hidden field; real users never see it.
    if (trim(body.website, 200)) {
      return res.json({ ok: true });
    }

    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, contact_email, business_type, default_locale')
      .eq('id', communitySlug)
      .eq('business_type', TAX_BUSINESS_TYPE)
      .maybeSingle();
    if (cErr) return sendSupabaseError(res, cErr);
    if (!community) return res.status(404).json({ error: 'Tax community not found.' });

    const lead = {
      id: 'lead_' + uuidv4().slice(0, 12),
      community_id: community.id,
      name, email, phone, whatsapp,
      first_name: nameParts.first,
      middle_name: nameParts.middle,
      last_name: nameParts.last,
      company,
      customer_type: customerType,
      product_slug: productSlug,
      product_slugs: productSlugs,
      message,
      preferred_locale: preferredLocale,
      status: 'new',
      source: 'landing',
      user_agent: userAgent,
      ip,
    };

    const { data: inserted, error: iErr } = await supabase
      .from('tax_leads').insert(lead).select('*').single();
    if (iErr) return sendSupabaseError(res, iErr);

    try {
      await auditLog({
        entity: 'tax.lead', entityId: inserted.id,
        action: 'create', actorEmail: email, actorName: name,
        after: { communityId: community.id, productSlugs, preferredLocale },
      });
    } catch (e) { warn('[tax] audit log failed', e?.message || e); }

    if (typeof sendTaxLeadEmail === 'function'
        && await communityStaffEmailFlag(community.id, 'tax_staff_email_lead_enabled')) {
      try { await sendTaxLeadEmail({ community, lead: inserted }); }
      catch (e) { warn('[tax] lead notification email failed', e?.message || e); }
    }

    res.json({ ok: true, id: inserted.id });
  });

  // Phase 4b: lead inbox lives at /admin/leads — see below. /leads stays
  // 501 so legacy callers don't accidentally hit it without auth.
  router.get('/leads', (_req, res) => {
    res.status(501).json({ error: 'Use /admin/leads (admin-authenticated).' });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 1.5: customer magic-link response endpoints
  // ────────────────────────────────────────────────────────────────────────────

  // ── GET /respond/:token ──
  // Public. Verifies token, returns the period + checklist for the customer.
  // No PII is leaked: only the customer's own name/email + the filing details
  // the token is bound to.
  router.get('/respond/:token', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const raw = trim(req.params.token, MAX_TOKEN_LEN);
    if (!raw) return res.status(400).json({ error: 'Token required.' });

    const tokenRow = await fetchValidToken(raw);
    if (!tokenRow.ok) return res.status(tokenRow.status).json({ error: tokenRow.error });

    res.json({
      community: tokenRow.community,
      customer: tokenRow.customer,   // restricted set, see fetchValidToken
      period: tokenRow.period,
      schedule: tokenRow.schedule,
      checklist: tokenRow.checklist,
      alreadyReceived: tokenRow.period.status === 'info_received'
        || tokenRow.period.status === 'in_prep'
        || tokenRow.period.status === 'filed',
    });
  });

  // ── POST /respond/:token ──
  // Public. Accepts a `data` object of checklist responses + optional notes,
  // saves the response, marks the period info_received, invalidates the token.
  router.post('/respond/:token', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const raw = trim(req.params.token, MAX_TOKEN_LEN);
    if (!raw) return res.status(400).json({ error: 'Token required.' });

    const body = req.body || {};
    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};
    const notes = trim(body.notes, MAX_TEXT_LEN);
    const userAgent = trim(req.get('user-agent') || '', 500);
    const ip = trim((req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0], 80);

    const tokenRow = await fetchValidToken(raw);
    if (!tokenRow.ok) return res.status(tokenRow.status).json({ error: tokenRow.error });
    if (tokenRow.period.status === 'filed') {
      return res.status(409).json({ error: 'This filing has already been completed.' });
    }

    // Validate required fields per checklist.
    const missing = [];
    for (const item of tokenRow.checklist) {
      if (!item.required) continue;
      const v = data[item.key];
      if (v === undefined || v === null || String(v).trim() === '') missing.push(item.key);
    }
    if (missing.length) return res.status(400).json({ error: 'Missing required fields', missing });

    const respId = 'tresp_' + uuidv4().slice(0, 12);
    const { error: rErr } = await supabase.from('tax_filing_responses').insert({
      id: respId,
      period_id: tokenRow.period.id,
      customer_id: tokenRow.customer.id,
      data, notes, ip, user_agent: userAgent,
    });
    if (rErr) return sendSupabaseError(res, rErr);

    await supabase.from('tax_filing_periods')
      .update({
        status: 'info_received',
        info_received_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', tokenRow.period.id);

    await supabase.from('tax_response_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', tokenRow.tokenId);

    try {
      await auditLog({
        entity: 'tax.filing_response', entityId: respId,
        action: 'create', actorEmail: tokenRow.customer.email, actorName: tokenRow.customer.name,
        after: { periodId: tokenRow.period.id, scheduleSlug: tokenRow.schedule.slug },
      });
    } catch (_e) {}

    res.json({ ok: true, id: respId });
  });

  // Internal helper — validates a magic-link token and returns the joined
  // record. Limits what's returned to what the customer is allowed to see.
  async function fetchValidToken(raw) {
    const tokenHash = sha256(raw);
    const { data: t, error: tErr } = await supabase
      .from('tax_response_tokens')
      .select('id, period_id, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (tErr) return { ok: false, status: 500, error: tErr.message };
    if (!t) return { ok: false, status: 404, error: 'Invalid or expired link.' };
    if (t.used_at) return { ok: false, status: 410, error: 'This link has already been used.' };
    if (new Date(t.expires_at) < new Date()) {
      return { ok: false, status: 410, error: 'This link has expired.' };
    }

    const { data: period, error: pErr } = await supabase
      .from('tax_filing_periods')
      .select('id, community_id, subscription_id, customer_id, schedule_id, status, period_label, period_start, period_end, due_date')
      .eq('id', t.period_id).maybeSingle();
    if (pErr) return { ok: false, status: 500, error: pErr.message };
    if (!period) return { ok: false, status: 404, error: 'Filing period not found.' };

    const [{ data: customer }, { data: schedule }, { data: subscription }, { data: community }] = await Promise.all([
      supabase.from('tax_customers').select('id, email, name, locale').eq('id', period.customer_id).maybeSingle(),
      supabase.from('tax_filing_schedules')
        .select('id, slug, jurisdiction, cadence, info_checklist, name_i18n, description_i18n')
        .eq('id', period.schedule_id).maybeSingle(),
      supabase.from('tax_subscriptions').select('id, custom_info_checklist').eq('id', period.subscription_id).maybeSingle(),
      supabase.from('communities')
        .select('id, name, logo_url, brand_primary_color, brand_secondary_color, default_locale, tagline, tagline_en, contact_email')
        .eq('id', period.community_id).maybeSingle(),
    ]);
    if (!customer || !schedule || !community) {
      return { ok: false, status: 404, error: 'Filing not available.' };
    }

    const checklist = (Array.isArray(subscription?.custom_info_checklist) && subscription.custom_info_checklist.length)
      ? subscription.custom_info_checklist
      : (Array.isArray(schedule.info_checklist) ? schedule.info_checklist : []);

    return {
      ok: true,
      tokenId: t.id,
      community, customer, period, schedule, checklist,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 1.5: admin endpoints (minimal — full UI in Phase 4a)
  // ────────────────────────────────────────────────────────────────────────────

  router.post('/admin/cron/run', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    if (typeof runReminderCron !== 'function') {
      return res.status(503).json({ error: 'Reminder cron not configured.' });
    }
    const result = await runReminderCron();
    res.json({ ok: true, result });
  });

  router.get('/admin/customers', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug || '', 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });

    try {
      const customers = await searchCustomers({
        communitySlug,
        q: req.query.q,
        relationshipTypeIds: parseCsvList(req.query.relationshipTypeIds),
        customerType: req.query.customerType,
        includeArchived: String(req.query.includeArchived || '').toLowerCase() === 'true',
        scopedCustomerIds: null,            // admin sees the whole community
      });
      res.json({ customers });
    } catch (e) {
      return sendSupabaseError(res, e);
    }
  });

  // Shared search/list helper used by both /admin/customers and
  // /employee/customers. Returns the customer rows with their active
  // relationships joined in.
  //
  // Args:
  //   communitySlug         — required
  //   q                     — optional search term; ILIKE-matched against
  //                           name, email, phone, whatsapp, preferred email,
  //                           and address subfields (line1, city, state,
  //                           postal_code)
  //   relationshipTypeIds   — optional array; when set, only customers
  //                           tagged with ANY of these types are returned
  //   scopedCustomerIds     — null (no scope filter) or array (intersect
  //                           with this set; empty array → return [])
  //
  // Implementation notes:
  //   • Search uses Supabase .or() with the JSONB ->> arrow syntax so
  //     address subfields are matched without a SQL function.
  //   • Search-term sanitization: PostgREST's or() filter splits on commas
  //     and dots, so we strip those plus % and _ to avoid breaking the
  //     filter and producing accidental wildcards.
  //   • Relationships are fetched as a second query keyed by customer_id
  //     to keep the select string simple and to avoid embedded-resource
  //     pagination quirks.
  async function searchCustomers({ communitySlug, q, relationshipTypeIds, customerType, includeArchived, scopedCustomerIds }) {
    let query = supabase.from('tax_customers')
      .select(`
        id, email, name, business_name, customer_type, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email,
        locale, status, last_sign_in_at, created_at,
        tax_subscriptions ( id, product_id, status, active_schedule_slugs, reminder_channels, reminder_offsets_days )
      `)
      .eq('community_id', communitySlug);

    // Hide archived customers by default so the working list stays
    // focused on people the practice is currently serving. Callers
    // pass includeArchived=true (the "Show archived" toggle on
    // OwnerCustomers) to widen the view.
    if (!includeArchived) {
      query = query.neq('status', 'archived');
    }

    if (Array.isArray(scopedCustomerIds)) {
      if (!scopedCustomerIds.length) return [];
      query = query.in('id', scopedCustomerIds);
    }
    // Filter by classification when the caller asks. Unknown / blank
    // values fall through (no filter) so the legacy "no type chip"
    // browse experience keeps working.
    const ctNorm = String(customerType || '').toLowerCase().trim();
    if (ctNorm === 'business' || ctNorm === 'individual') {
      query = query.eq('customer_type', ctNorm);
    }

    if (Array.isArray(relationshipTypeIds) && relationshipTypeIds.length) {
      const { data: relRows, error: relErr } = await supabase.from('tax_customer_relationships')
        .select('customer_id')
        .eq('active', true)
        .in('relationship_type_id', relationshipTypeIds);
      if (relErr) throw new Error(relErr.message);
      const matchedIds = [...new Set((relRows || []).map(r => r.customer_id))];
      if (!matchedIds.length) return [];
      query = query.in('id', matchedIds);
    }

    const rawTerm = String(q || '').trim();
    if (rawTerm) {
      // Strip characters that would break PostgREST's or-filter parsing
      // and escape SQL wildcards we don't want to expose.
      const safe = rawTerm.replace(/[,.%_()*]/g, ' ').trim();
      if (safe) {
        const pat = `%${safe}%`;
        // JSONB->>field uses PostgREST's arrow syntax inside the column
        // reference. Spaces and quotes are NOT allowed in filter values
        // passed through `.or()`, so the term has already been sanitized.
        query = query.or([
          `name.ilike.${pat}`,
          `business_name.ilike.${pat}`,
          `email.ilike.${pat}`,
          `phone.ilike.${pat}`,
          `whatsapp.ilike.${pat}`,
          `preferred_communication_email.ilike.${pat}`,
          `address->>line1.ilike.${pat}`,
          `address->>line2.ilike.${pat}`,
          `address->>city.ilike.${pat}`,
          `address->>state.ilike.${pat}`,
          `address->>postal_code.ilike.${pat}`,
        ].join(','));
      }
    }

    const { data: customers, error } = await query.order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    // Hydrate active relationships in one extra query.
    const ids = (customers || []).map(c => c.id);
    if (!ids.length) return [];
    const { data: rels } = await supabase.from('tax_customer_relationships')
      .select(`
        customer_id, relationship_type_id, active,
        type:tax_relationship_types ( id, slug, category, name_i18n, display_order )
      `)
      .in('customer_id', ids).eq('active', true);
    const byCustomer = new Map();
    for (const r of rels || []) {
      const arr = byCustomer.get(r.customer_id) || [];
      arr.push(r);
      byCustomer.set(r.customer_id, arr);
    }

    // Phase 4n.44: per-customer task health. Counts open + overdue
    // tasks so the customer list can show a small chip at a glance.
    // Done in one extra query keyed by customer_id; the counts are
    // computed in JS off the lightweight task rows since Supabase
    // doesn't expose a sane GROUP BY through PostgREST.
    const today = new Date().toISOString().slice(0, 10);
    const { data: openTasks } = await supabase.from('tax_tasks')
      .select('customer_id, status_key, due_date, completed_at')
      .eq('community_id', communitySlug)
      .in('customer_id', ids)
      .is('archived_at', null)
      .is('completed_at', null);
    const { data: statusOpts } = await supabase.from('tax_task_status_options')
      .select('key, is_terminal').eq('community_id', communitySlug);
    const terminalKeys = new Set((statusOpts || []).filter(s => s.is_terminal).map(s => s.key));
    const healthByCustomer = new Map();
    for (const t of openTasks || []) {
      if (t.completed_at) continue;
      if (terminalKeys.has(t.status_key)) continue;
      const slot = healthByCustomer.get(t.customer_id)
                || { open: 0, overdue: 0, in_progress: 0 };
      slot.open += 1;
      if (t.status_key === 'in_progress') slot.in_progress += 1;
      if (t.due_date && t.due_date < today) slot.overdue += 1;
      healthByCustomer.set(t.customer_id, slot);
    }

    return (customers || []).map(c => ({
      ...c,
      relationships: byCustomer.get(c.id) || [],
      health: healthByCustomer.get(c.id) || { open: 0, overdue: 0, in_progress: 0 },
    }));
  }

  function parseCsvList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  }

  // ── POST /admin/customers ── (Phase 4a)
  // Creates a customer row. The portal can then magic-link them in (Phase 1.5)
  // or they can self-link by signing in (Phase 2a). No subscription is
  // created — owner adds those via SQL/curl until Phase 4b ships subscription UI.
  router.post('/admin/customers', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const email = trim(body.email, 200).toLowerCase();
    const np = resolveNamePayload(body);
    const customerType = (String(body.customerType || '').toLowerCase() === 'business')
      ? 'business' : 'individual';
    // Drop businessName when the row is marked individual so a flipped
    // toggle never leaves a stale company name on the customer.
    const businessName = customerType === 'business' ? trim(body.businessName, 200) : '';
    const phone = trim(body.phone, MAX_PHONE_LEN);
    const locale = (body.locale === 'en') ? 'en' : 'es';
    // Phase: relationships (array of type ids) + sendWelcomeEmail (bool,
    // default true). Both are optional but the Add form sends them.
    const requestedRels = Array.isArray(body.relationshipTypeIds)
      ? body.relationshipTypeIds.map(s => String(s)).filter(Boolean) : [];
    const sendWelcome = body.sendWelcomeEmail === false ? false : true;

    if (!communitySlug || !email) return res.status(400).json({ error: 'communitySlug and email required.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Email is not valid.' });
    if (customerType === 'business' && !businessName) {
      return res.status(400).json({ error: 'business_name_required',
        message: 'Business name is required for a business customer.' });
    }
    if (requestedRels.length === 0) {
      return res.status(400).json({ error: 'service_required',
        message: 'Pick at least one service so the customer\'s tasks can be generated.' });
    }

    // Reject if a customer with this email already exists in the community.
    const { data: existing } = await supabase.from('tax_customers')
      .select('id').eq('community_id', communitySlug).eq('email', email).maybeSingle();
    if (existing) return res.status(409).json({ error: 'A customer with this email already exists in this community.' });

    const id = 'cust_' + uuidv4().slice(0, 16);
    const { error } = await supabase.from('tax_customers').insert({
      id, community_id: communitySlug, email,
      name: np.name, first_name: np.first, middle_name: np.middle, last_name: np.last,
      business_name: businessName,
      customer_type: customerType,
      phone, locale, status: 'active',
    });
    if (error) return sendSupabaseError(res, error);

    // Insert relationship tags. Unknown ids are warned but don't fail
    // the customer create (mirrors CSV-import semantics).
    let createdRelTypeIds = [];
    let unknownRels = [];
    if (requestedRels.length) {
      const { data: types } = await supabase.from('tax_relationship_types')
        .select('id, community_id').eq('active', true);
      const validTypeIds = new Set((types || [])
        .filter(t => t.community_id == null || t.community_id === communitySlug)
        .map(t => t.id));
      const validRels = requestedRels.filter(id => validTypeIds.has(id));
      unknownRels = requestedRels.filter(id => !validTypeIds.has(id));
      if (validRels.length) {
        const relRows = validRels.map(typeId => ({
          id: 'crel_' + uuidv4().slice(0, 12),
          customer_id: id,
          relationship_type_id: typeId,
          created_by_email: 'admin_add',
          active: true,
        }));
        const { error: relErr } = await supabase.from('tax_customer_relationships').insert(relRows);
        if (!relErr) createdRelTypeIds = validRels;
      }
    }

    // Auto-create internal tasks for each newly-added relationship. Best-
    // effort: a failure to provision tasks shouldn't roll back the
    // customer create. Relationships with no workflow rule short-circuit
    // and contribute zero tasks.
    let tasksCreated = 0;
    for (const relTypeId of createdRelTypeIds) {
      try {
        const r = await generateTasksForRelationship({
          customerId: id, relationshipTypeId: relTypeId,
          actorEmail: email,
        });
        tasksCreated += r.created || 0;
      } catch (e) { warn('[tax-customer-create] task gen failed', e?.message || e); }
    }

    // Welcome email — best-effort, never blocks the create. Looks up the
    // joined relationship rows so the email body can render localized
    // service names. Gated by the community-wide welcome-email toggle:
    // if the owner has the type off, the create-time send is skipped.
    // The manual "Resend welcome email" route stays unconditional so
    // an owner can still kick one out one-off when needed.
    let welcomeResult = { sent: false, skipped: true };
    if (sendWelcome) {
      if (await communityEmailFlag(communitySlug, 'tax_email_welcome_enabled')) {
        welcomeResult = await sendWelcomeForCustomer(id);
      } else {
        welcomeResult = { sent: false, skipped: true, reason: 'welcome_emails_disabled' };
      }
    }

    res.json({
      ok: true, id,
      relationshipsAdded: createdRelTypeIds,
      unknownRelationships: unknownRels,
      tasksCreated,
      welcomeEmail: welcomeResult,
    });
  });

  // POST /admin/customers/:id/send-welcome
  // Manual resend of the welcome email — useful after adding more
  // relationships, or if the original send failed/got missed by the
  // customer. Always uses the current relationship set + customer locale.
  router.post('/admin/customers/:id/send-welcome', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const result = await sendWelcomeForCustomer(customerId);
    if (result.skipped) {
      // Common case: email not configured on this deploy. Return 200 with
      // the skip reason so the UI can show a clear message instead of a
      // generic error.
      return res.json(result);
    }
    if (result.sent === false) {
      return res.status(500).json({ ok: false, ...result });
    }
    res.json({ ok: true, ...result });
  });

  // ── Task generator for (customer, relationship_type) ────────────────────
  //
  // Phase 4n.36: customer relationships now drive internal task
  // scheduling instead of customer-facing reminder emails. When a
  // relationship is added (either on customer create or via the
  // add-relationship endpoint), this helper:
  //   1. Resolves the workflow rule(s) for that relationship type,
  //      preferring community-scoped overrides over the global default
  //   2. Looks up the matching filing_schedule (slug + community) so we
  //      can get the cadence + product_id
  //   3. generatePeriods up to LOOKAHEAD_MONTHS into the future
  //   4. Upserts one task per period using the unique index
  //      (customer_id, schedule_id, period_key) so re-runs are safe.
  //
  // Skips silently when the relationship type has no workflow rule
  // wired up — owners may use relationship tags for non-recurring
  // service buckets where no schedule applies.
  const RELATIONSHIP_TASK_LOOKAHEAD_DEFAULT = 6;

  async function generateTasksForRelationship({ customerId, relationshipTypeId, actorEmail = '' }) {
    if (!customerId || !relationshipTypeId) return { created: 0, skipped: 'missing_args' };

    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id, locale').eq('id', customerId).maybeSingle();
    if (!cust) return { created: 0, skipped: 'customer_not_found' };

    // Per-community look-ahead window. Falls back to 6 months when
    // the community row is missing the new column (pre-migration).
    const { data: commRow } = await supabase.from('communities')
      .select('tax_task_lookahead_months').eq('id', cust.community_id).maybeSingle();
    const lookaheadMonths = Math.max(1, Math.min(24,
      Number(commRow?.tax_task_lookahead_months) || RELATIONSHIP_TASK_LOOKAHEAD_DEFAULT));

    const todayIso = new Date().toISOString().slice(0, 10);
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() + lookaheadMonths);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const { data: statusOpts } = await supabase.from('tax_task_status_options')
      .select('key, display_order, is_terminal')
      .eq('community_id', cust.community_id).eq('active', true)
      .order('display_order', { ascending: true });
    const defaultStatus =
      (statusOpts || []).find(s => !s.is_terminal)?.key
      || (statusOpts || [])[0]?.key
      || 'not_started';

    // Phase 4n.46: walk the per-service auto-tasks list. Each
    // auto-task is its own generation unit — a service can have many
    // (Bookkeeping = monthly reconciliation + quarterly P&L +
    // annual close). Fall back to the legacy product-cadence
    // single-stream path when a service has no auto-tasks yet, then
    // to the workflow_rule chain for even older tenants.
    const { data: relType } = await supabase.from('tax_relationship_types')
      .select('id, product_id').eq('id', relationshipTypeId).maybeSingle();
    let productSchedules = [];
    if (relType?.product_id) {
      const { data: autoTasks } = await supabase.from('tax_service_auto_tasks')
        .select('id, title_i18n, cadence_kind, anchor_rule, default_priority, default_assignee_employee_id, display_order')
        .eq('product_id', relType.product_id)
        .eq('active', true)
        .order('display_order', { ascending: true });
      if (autoTasks && autoTasks.length) {
        for (const at of autoTasks) {
          if (!at.cadence_kind || at.cadence_kind === 'none') continue;
          productSchedules.push({
            id: at.id,
            slug: `at-${at.id}`,
            name_i18n: at.title_i18n || {},
            anchor_rule: at.anchor_rule || {},
            product_id: relType.product_id,
            service_auto_task_id: at.id,
            priority: at.default_priority || 'normal',
            assignedEmployeeId: at.default_assignee_employee_id || null,
            source: 'auto_task',
          });
        }
      }
      // Backwards-compat single-cadence path — only used when the
      // service hasn't been migrated to auto-tasks yet.
      if (!productSchedules.length) {
        const { data: prod } = await supabase.from('tax_products')
          .select('id, slug, community_id, name_i18n, cadence_kind, anchor_rule')
          .eq('id', relType.product_id).maybeSingle();
        if (prod && prod.cadence_kind && prod.cadence_kind !== 'none') {
          productSchedules = [{
            id: prod.id, slug: prod.slug,
            name_i18n: prod.name_i18n || {},
            anchor_rule: prod.anchor_rule || {},
            product_id: prod.id,
            source: 'product_cadence',
          }];
        }
      }
    }

    let legacySchedules = [];
    if (!productSchedules.length) {
      const { data: rules } = await supabase.from('tax_relationship_workflow_rules')
        .select('id, community_id, filing_schedule_slug, active, name_i18n')
        .eq('relationship_type_id', relationshipTypeId).eq('active', true);
      if (rules && rules.length) {
        rules.sort((a, b) => {
          const aCom = a.community_id === cust.community_id ? 0 : 1;
          const bCom = b.community_id === cust.community_id ? 0 : 1;
          return aCom - bCom;
        });
        for (const rule of rules) {
          const { data: sched } = await supabase.from('tax_filing_schedules')
            .select('id, slug, community_id, anchor_rule, name_i18n, product_id, cadence')
            .eq('community_id', cust.community_id)
            .eq('slug', rule.filing_schedule_slug).maybeSingle();
          if (sched) legacySchedules.push({ ...sched, source: 'workflow_rule' });
        }
      }
    }

    const allSchedules = productSchedules.length ? productSchedules : legacySchedules;
    if (!allSchedules.length) return { created: 0, skipped: 'no_schedule' };

    let created = 0;
    const seenScheduleIds = new Set();

    for (const sched of allSchedules) {
      if (seenScheduleIds.has(sched.id)) continue;
      seenScheduleIds.add(sched.id);

      const periods = generateSchedulePeriods(sched.anchor_rule, todayIso, 24, {
        lang: cust.locale === 'en' ? 'en' : 'es',
      });
      const scheduleName =
        sched.name_i18n?.[cust.locale === 'en' ? 'en' : 'es']
        || sched.name_i18n?.en || sched.name_i18n?.es || sched.slug;

      const isAutoTask = sched.source === 'auto_task';
      const isProductCadence = sched.source === 'product_cadence';
      const rows = [];
      for (const p of periods) {
        if (!p.dueDate) continue;
        if (p.dueDate > cutoffIso) break;
        if (p.dueDate < todayIso) continue;
        // Period key namespaces by source so auto-task and legacy
        // rows never collide on the partial unique indexes.
        const periodKey = isAutoTask
          ? `at:${sched.service_auto_task_id}:${p.periodStart || p.dueDate}`
          : `${sched.slug}:${p.periodStart || p.dueDate}`;
        rows.push({
          id: 'task_' + uuidv4().slice(0, 12),
          community_id: cust.community_id,
          customer_id: cust.id,
          product_id: sched.product_id || null,
          relationship_type_id: relationshipTypeId,
          // Auto-task and product-cadence rows aren't anchored to a
          // filing_schedules row; the appropriate partial unique
          // index handles idempotency on each path.
          schedule_id: (isAutoTask || isProductCadence) ? null : sched.id,
          service_auto_task_id: isAutoTask ? sched.service_auto_task_id : null,
          period_key: periodKey,
          source: 'relationship_schedule',
          title: `${scheduleName} — ${p.periodLabel || p.dueDate}`,
          status_key: defaultStatus,
          priority: sched.priority || 'normal',
          // Pre-route the new task to the auto-task's default owner
          // when one is configured (Phase 4n.51). Falls back to
          // unassigned so the existing behavior is preserved when
          // the column is null.
          assigned_employee_id: isAutoTask ? (sched.assignedEmployeeId || null) : null,
          due_date: p.dueDate,
          notes: '',
        });
      }
      if (!rows.length) continue;

      // Idempotency by SELECT-then-INSERT. The partial unique indexes
      // on tax_tasks (all gated on `archived_at is null`) can't be
      // used as ON CONFLICT arbiters without a matching WHERE
      // predicate on the INSERT statement, which PostgREST's upsert
      // helper doesn't emit — the upsert would error out and zero
      // rows would land. Looking up existing period_keys for this
      // (customer, arbiter) and inserting only the missing rows is
      // equivalent and unambiguous.
      const periodKeys = rows.map(r => r.period_key);
      let existingKeys = new Set();
      if (periodKeys.length) {
        let existingQ = supabase.from('tax_tasks')
          .select('period_key')
          .eq('customer_id', cust.id)
          .in('period_key', periodKeys)
          .is('archived_at', null);
        if (isAutoTask) {
          existingQ = existingQ.eq('service_auto_task_id', sched.service_auto_task_id);
        } else if (isProductCadence) {
          existingQ = existingQ.eq('product_id', sched.product_id).is('schedule_id', null);
        } else {
          existingQ = existingQ.eq('schedule_id', sched.id);
        }
        const { data: existing, error: selErr } = await existingQ;
        if (selErr) {
          warn('[tax-task-gen] dedup select failed', selErr.message);
          continue;
        }
        existingKeys = new Set((existing || []).map(r => r.period_key));
      }
      const fresh = rows.filter(r => !existingKeys.has(r.period_key));
      if (!fresh.length) continue;
      const { error: insertErr, count } = await supabase.from('tax_tasks')
        .insert(fresh, { count: 'exact' });
      if (insertErr) {
        warn('[tax-task-gen] insert failed', insertErr.message);
        continue;
      }
      created += count || fresh.length;
    }

    if (created > 0) {
      try {
        await auditLog({
          entity: 'tax.customer', entityId: customerId, action: 'tasks_generated',
          actorEmail: actorEmail || '',
          after: { relationshipTypeId, created },
        });
      } catch (_e) {}
    }
    return { created };
  }

  // Walk every active customer-relationship in every tax community
  // and re-run the task generator. Idempotent: existing periods are
  // no-ops, new periods get created as time rolls forward. This is
  // what keeps the Tasks page from running dry on a long-cadence
  // service after a few months pass.
  //
  // Triggered by the daily setInterval below and by the manual
  // POST /admin/tasks/refresh endpoint. Safe to call repeatedly.
  async function refreshAllRelationshipTasks() {
    if (!isSupabaseConfigured) return { skipped: 'supabase_not_configured' };
    let scanned = 0, created = 0;

    // Phase 4n.48: walk the new tax_customer_services join first.
    // Each (customer, product) row fires the per-product generator;
    // idempotent — existing tasks are no-ops.
    const { data: svcRows } = await supabase
      .from('tax_customer_services')
      .select('customer_id, product_id')
      .eq('active', true)
      .limit(20000);
    for (const r of svcRows || []) {
      scanned++;
      try {
        const out = await generateTasksForService({
          customerId: r.customer_id, productId: r.product_id,
          actorEmail: 'task-cron',
        });
        created += out.created || 0;
      } catch (e) { warn('[tax-task-cron] svc gen failed', e?.message || e); }
    }

    // Phase 4n.50: the legacy tax_customer_relationships table is
    // retired for customer tagging — services drive everything now,
    // and the schema migration cleared those rows. The cron loop
    // intentionally no longer iterates that table.
    return { scanned, created };
  }

  // Per-community variant of refreshAllRelationshipTasks. Walks just
  // the customers in `communityId` and regenerates recurring tasks via
  // the same idempotent path. Used by the lookahead-change handler so
  // an admin's setting change reflects on the board within one request
  // instead of waiting for the next refresh cron.
  async function refreshRecurringTasksForCommunity(communityId) {
    if (!isSupabaseConfigured || !communityId) return { scanned: 0, created: 0 };
    const { data: custs } = await supabase.from('tax_customers')
      .select('id').eq('community_id', communityId);
    const custIds = (custs || []).map(c => c.id);
    if (!custIds.length) return { scanned: 0, created: 0 };
    const { data: svcRows } = await supabase.from('tax_customer_services')
      .select('customer_id, product_id')
      .eq('active', true).in('customer_id', custIds).limit(20000);
    let scanned = 0, created = 0;
    for (const r of (svcRows || [])) {
      scanned++;
      try {
        const out = await generateTasksForService({
          customerId: r.customer_id, productId: r.product_id,
          actorEmail: 'lookahead-update',
        });
        created += out.created || 0;
      } catch (e) { warn('[tax-task-prune] gen failed', e?.message || e); }
    }
    return { scanned, created };
  }

  // Trim auto-generated recurring tasks whose due_date now falls
  // outside the lookahead window. Only touches open
  // (source='relationship_schedule', not completed, not archived)
  // rows — completed history and manual one-offs are always preserved.
  async function pruneTasksBeyondLookahead({ communityId, lookaheadMonths }) {
    if (!isSupabaseConfigured || !communityId) return { deleted: 0 };
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() + Math.max(1, lookaheadMonths));
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const { data: rows } = await supabase.from('tax_tasks')
      .select('id')
      .eq('community_id', communityId)
      .eq('source', 'relationship_schedule')
      .is('archived_at', null)
      .is('completed_at', null)
      .gt('due_date', cutoffIso)
      .limit(20000);
    const dropIds = (rows || []).map(t => t.id);
    if (!dropIds.length) return { deleted: 0 };
    const { error } = await supabase.from('tax_tasks').delete().in('id', dropIds);
    if (error) {
      warn('[tax-task-prune] delete failed', error.message);
      return { deleted: 0, error: error.message };
    }
    return { deleted: dropIds.length };
  }

  // Manual trigger — useful for development + as a one-off
  // "extend my window now" button. Gated on the same permission as
  // any other reminder-style operation.
  router.post('/admin/tasks/refresh', async (req, res) => {
    const actor = await requireOwnerAdmin(req, res, 'manage_settings');
    if (!actor) return;
    const out = await refreshAllRelationshipTasks();
    res.json({ ok: true, ...out });
  });

  // Auto-cron disabled in this repo to avoid double-firing while the Airbnb
  // mirror (kai-airbnb-owners-app) still serves the same Supabase DB. The
  // Airbnb repo's cron remains the single tick source; admins can also call
  // POST /admin/tasks/refresh in this repo at any time. Re-enable here once
  // the Airbnb repo has tax code stripped out and its cron is disabled.

  // Hard-delete open tasks for a (customer, relationship_type) — used
  // when the relationship is removed. Completed tasks (completed_at set)
  // are preserved so the work-done history survives; everything else
  // belonging to the removed relationship goes, because keeping
  // mid-flight work pinned to a relationship that no longer exists just
  // leaves orphans on the board.
  async function removeTasksForRelationship({ customerId, relationshipTypeId, actorEmail = '', skipAudit = false }) {
    if (!customerId || !relationshipTypeId) return { deleted: 0 };
    const { data: cur } = await supabase.from('tax_tasks')
      .select('id')
      .eq('customer_id', customerId)
      .eq('relationship_type_id', relationshipTypeId)
      .eq('source', 'relationship_schedule')
      .is('archived_at', null)
      .is('completed_at', null);
    const dropIds = (cur || []).map(t => t.id);
    if (!dropIds.length) return { deleted: 0 };
    const { error } = await supabase.from('tax_tasks')
      .delete().in('id', dropIds);
    if (error) {
      warn('[tax-task-gen] delete failed', error.message);
      return { deleted: 0, error: error.message };
    }
    // Audit suppression is used by callers that write a richer
    // higher-level audit (e.g., DELETE /admin/customers/:id/relationships/:relId
    // writes a single `relationship_remove` row instead of the generic
    // `tasks_deleted` so the activity timeline shows one undoable event).
    if (!skipAudit) {
      try {
        await auditLog({
          entity: 'tax.customer', entityId: customerId, action: 'tasks_deleted',
          actorEmail: actorEmail || '',
          after: { relationshipTypeId, deleted: dropIds.length },
        });
      } catch (_e) {}
    }
    return { deleted: dropIds.length };
  }

  // ── Service-tagging variants (Phase 4n.48) ─────────────────────────────
  //
  // These wrap the relationship-based helpers because the underlying
  // task-generation logic walks auto-tasks per product anyway — the
  // only thing changing is the entry point. Customer-side tagging now
  // happens by product_id; we just synthesize a "virtual" relationship
  // context so the existing generator can run unchanged.
  async function generateTasksForService({ customerId, productId, actorEmail = '' }) {
    if (!customerId || !productId) return { created: 0, skipped: 'missing_args' };
    // Find a relationship_type that points at this product (if any)
    // so the generated tasks still carry a relationship_type_id for
    // legacy code paths. When none exists, the task rows just have
    // a null relationship_type_id, which all current consumers
    // handle.
    const { data: relType } = await supabase.from('tax_relationship_types')
      .select('id').eq('product_id', productId)
      .eq('active', true).limit(1).maybeSingle();
    if (relType?.id) {
      return generateTasksForRelationship({
        customerId, relationshipTypeId: relType.id, actorEmail,
      });
    }
    // Direct path — no relationship type exists. Build minimal
    // schedule context from auto-tasks directly.
    return generateTasksDirectFromProduct({ customerId, productId, actorEmail });
  }

  async function generateTasksDirectFromProduct({ customerId, productId, actorEmail = '' }) {
    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id, locale').eq('id', customerId).maybeSingle();
    if (!cust) return { created: 0, skipped: 'customer_not_found' };
    const { data: commRow } = await supabase.from('communities')
      .select('tax_task_lookahead_months').eq('id', cust.community_id).maybeSingle();
    const lookaheadMonths = Math.max(1, Math.min(24,
      Number(commRow?.tax_task_lookahead_months) || RELATIONSHIP_TASK_LOOKAHEAD_DEFAULT));
    const todayIso = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(); cutoff.setUTCMonth(cutoff.getUTCMonth() + lookaheadMonths);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const { data: statusOpts } = await supabase.from('tax_task_status_options')
      .select('key, display_order, is_terminal')
      .eq('community_id', cust.community_id).eq('active', true)
      .order('display_order', { ascending: true });
    const defaultStatus = (statusOpts || []).find(s => !s.is_terminal)?.key
      || (statusOpts || [])[0]?.key || 'not_started';
    const { data: autoTasks } = await supabase.from('tax_service_auto_tasks')
      .select('id, title_i18n, cadence_kind, anchor_rule, default_priority, default_assignee_employee_id')
      .eq('product_id', productId).eq('active', true);
    let created = 0;
    for (const at of autoTasks || []) {
      if (!at.cadence_kind || at.cadence_kind === 'none') continue;
      const periods = generateSchedulePeriods(at.anchor_rule, todayIso, 24, {
        lang: cust.locale === 'en' ? 'en' : 'es',
      });
      const titleBase = at.title_i18n?.[cust.locale === 'en' ? 'en' : 'es']
                     || at.title_i18n?.en || at.title_i18n?.es || 'Auto task';
      const rows = [];
      for (const p of periods) {
        if (!p.dueDate) continue;
        if (p.dueDate > cutoffIso) break;
        if (p.dueDate < todayIso) continue;
        rows.push({
          id: 'task_' + uuidv4().slice(0, 12),
          community_id: cust.community_id,
          customer_id: cust.id,
          product_id: productId,
          relationship_type_id: null,
          schedule_id: null,
          service_auto_task_id: at.id,
          period_key: `at:${at.id}:${p.periodStart || p.dueDate}`,
          source: 'relationship_schedule',
          title: `${titleBase} — ${p.periodLabel || p.dueDate}`,
          status_key: defaultStatus,
          priority: at.default_priority || 'normal',
          assigned_employee_id: at.default_assignee_employee_id || null,
          due_date: p.dueDate,
          notes: '',
        });
      }
      if (!rows.length) continue;
      // SELECT existing keys, INSERT only what's missing. See the
      // note in generateTasksForRelationship for why we avoid
      // PostgREST upsert here — the partial unique index can't be
      // inferred as an ON CONFLICT arbiter.
      const periodKeys = rows.map(r => r.period_key);
      const { data: existing, error: selErr } = await supabase.from('tax_tasks')
        .select('period_key')
        .eq('customer_id', cust.id)
        .eq('service_auto_task_id', at.id)
        .in('period_key', periodKeys)
        .is('archived_at', null);
      if (selErr) {
        warn('[tax-task-gen-direct] dedup select failed', selErr.message);
        continue;
      }
      const existingKeys = new Set((existing || []).map(r => r.period_key));
      const fresh = rows.filter(r => !existingKeys.has(r.period_key));
      if (!fresh.length) continue;
      const { error: insertErr, count } = await supabase.from('tax_tasks')
        .insert(fresh, { count: 'exact' });
      if (insertErr) {
        warn('[tax-task-gen-direct] insert failed', insertErr.message);
        continue;
      }
      created += count || fresh.length;
    }
    if (created > 0) {
      try {
        await auditLog({
          entity: 'tax.customer', entityId: customerId, action: 'tasks_generated',
          actorEmail: actorEmail || '',
          after: { productId, created },
        });
      } catch (_e) {}
    }
    return { created };
  }

  async function removeTasksForService({ customerId, productId, actorEmail = '' }) {
    if (!customerId || !productId) return { deleted: 0 };
    const { data: cur } = await supabase.from('tax_tasks')
      .select('id')
      .eq('customer_id', customerId)
      .eq('product_id', productId)
      .eq('source', 'relationship_schedule')
      .is('archived_at', null)
      .is('completed_at', null);
    const dropIds = (cur || []).map(t => t.id);
    if (!dropIds.length) return { deleted: 0 };
    const { error } = await supabase.from('tax_tasks').delete().in('id', dropIds);
    if (error) { warn('[tax-cust-svc] delete failed', error.message); return { deleted: 0, error: error.message }; }
    try {
      await auditLog({
        entity: 'tax.customer', entityId: customerId, action: 'tasks_deleted',
        actorEmail: actorEmail || '',
        after: { productId, deleted: dropIds.length },
      });
    } catch (_e) {}
    return { deleted: dropIds.length };
  }

  // Fire a task-assigned notification email to the new assignee. Safe
  // to call from anywhere — silently no-ops when the assignee can't
  // be resolved, has no email, or matches the actor (no need to email
  // yourself for assigning your own task). Loads the customer +
  // community lazily so callers don't have to hand the world over.
  async function notifyTaskAssignee({ taskId, newAssigneeId, prevAssigneeId, actor }) {
    if (typeof sendTaxTaskAssignedEmail !== 'function') return;
    if (!newAssigneeId) return;
    if (newAssigneeId === prevAssigneeId) return;
    if (actor && newAssigneeId === actor.id) return;
    try {
      const { data: task } = await supabase.from('tax_tasks')
        .select(`
          id, community_id, title, due_date, priority, assigned_employee_id,
          customer:tax_customers ( id, name, business_name, email )
        `).eq('id', taskId).maybeSingle();
      if (!task || task.assigned_employee_id !== newAssigneeId) return;
      const [{ data: assignee }, { data: community }] = await Promise.all([
        supabase.from('tax_employees')
          .select('id, email, name, first_name, last_name, locale, status')
          .eq('id', newAssigneeId).maybeSingle(),
        supabase.from('communities')
          .select('id, name').eq('id', task.community_id).maybeSingle(),
      ]);
      if (!assignee || !assignee.email || assignee.status === 'archived') return;
      if (!await communityStaffEmailFlag(task.community_id, 'tax_staff_email_task_assigned_enabled')) return;
      await sendTaxTaskAssignedEmail({
        community: community || { id: task.community_id, name: '' },
        task, assignee, actor,
      });
    } catch (e) {
      warn('[tax-task-assign] notify failed', e?.message || e);
    }
  }

  // Shared welcome-email plumbing — loads the customer, community, and the
  // current relationships, builds the portal URL, hands off to the email
  // sender. Audit-logged.
  async function sendWelcomeForCustomer(customerId) {
    const [{ data: cust }] = await Promise.all([
      supabase.from('tax_customers')
        .select('id, community_id, email, name, locale, status')
        .eq('id', customerId).maybeSingle(),
    ]);
    if (!cust) return { sent: false, error: 'Customer not found.' };
    if (cust.status !== 'active') return { sent: false, error: 'Customer is not active.' };

    const [{ data: community }, { data: rels }] = await Promise.all([
      supabase.from('communities')
        .select('id, name, contact_email').eq('id', cust.community_id).maybeSingle(),
      supabase.from('tax_customer_relationships')
        .select(`
          relationship_type_id, active,
          type:tax_relationship_types ( id, name_i18n, display_order )
        `).eq('customer_id', customerId).eq('active', true),
    ]);

    const portalUrl = await customerLandingOrPortalUrl(cust.community_id);
    const relationships = (rels || []).slice().sort((a, b) =>
      (a.type?.display_order || 0) - (b.type?.display_order || 0));

    let result = { sent: false, skipped: true, reason: 'no_sender' };
    if (typeof sendTaxWelcomeEmail === 'function') {
      try {
        result = await sendTaxWelcomeEmail({ cust, community, relationships, portalUrl });
      } catch (e) {
        warn('[tax] welcome email failed', e?.message || e);
        result = { sent: false, error: e?.message || 'Send failed.' };
      }
    }
    try {
      await auditLog({
        entity: 'tax.customer', entityId: customerId,
        action: 'send_welcome_email',
        actorEmail: '',
        after: {
          to: cust.email,
          locale: cust.locale,
          relationshipsCount: relationships.length,
          sent: !!result.sent,
        },
      });
    } catch (_e) {}
    return result;
  }

  // ── POST /admin/customers/import ── (Phase 4h — bulk CSV import)
  //
  // Body { communitySlug, csv: string } — the CSV is sent as raw text in the
  // JSON body (no multipart). Columns (lowercase, snake_case in the header):
  //   email                              REQUIRED, unique per community
  //   name
  //   phone                              format-permissive
  //   whatsapp                           E.164; normalized server-side
  //   locale                             'en' or 'es' (default 'es')
  //   address_line1 / address_line2 / city / state / postal_code / country
  //   preferred_communication_email
  //   notes
  //   relationships                      comma-separated tax_relationship_types
  //                                      ids (e.g. business.llc,individual.taxes)
  //
  // Behavior: insert-only. Existing email in this community → skip with an
  // entry in the errors array (so the importer can see which rows were
  // skipped). Per-row errors don't fail the whole batch — the response
  // summarizes created / skipped / errors.
  // ── Phase 4n.15: dual-role + lifecycle ──────────────────────────────────
  //
  // Promote an existing customer to a staff/admin employee. Creates a
  // tax_employees row with the same email so the existing dual-role
  // auth wiring (staffAccess / customerAccess flags on /portal/me +
  // /employee/me) lights up automatically. Sends the welcome email by
  // default — owner can suppress with sendWelcomeEmail: false.
  router.post('/admin/customers/:id/promote-to-staff', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const body = req.body || {};
    const role = body.role === 'admin' ? 'admin' : 'staff';
    const overrideName = trim(body.name || '', MAX_NAME_LEN);
    const sendWelcome = body.sendWelcomeEmail === false ? false : true;

    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id, email, name, locale')
      .eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    const { data: existing } = await supabase.from('tax_employees')
      .select('id, role, status')
      .eq('community_id', cust.community_id).eq('email', cust.email).maybeSingle();
    if (existing) {
      return res.status(409).json({
        error: 'already_employee',
        message: 'This customer already has a staff account.',
        employeeId: existing.id,
      });
    }

    const empId = 'emp_' + uuidv4().slice(0, 12);
    const { error } = await supabase.from('tax_employees').insert({
      id: empId, community_id: cust.community_id,
      email: cust.email,
      name: overrideName || cust.name || '',
      role, locale: cust.locale === 'es' ? 'es' : 'en',
    });
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.employee', entityId: empId, action: 'promote_from_customer',
        actorEmail: '',
        after: { customerId, role, email: cust.email, community: cust.community_id },
      });
    } catch (_e) {}

    let welcomeResult = { sent: false, skipped: true };
    if (sendWelcome) {
      if (await communityStaffEmailFlag(cust.community_id, 'tax_staff_email_welcome_enabled')) {
        welcomeResult = await sendWelcomeForEmployee(empId);
      } else {
        welcomeResult = { sent: false, skipped: true, reason: 'staff_welcome_emails_disabled' };
      }
    }

    res.json({ ok: true, employeeId: empId, welcomeEmail: welcomeResult });
  });

  // Archive (or restore) a customer. Soft-delete via status — tax practices
  // typically must retain customer records for compliance, so this is a
  // status flip rather than a hard delete. Archiving also deactivates the
  // customer's relationships so the relationship-driven cron stops
  // generating new periods.
  router.put('/admin/customers/:id/status', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const body = req.body || {};
    const status = String(body.status || '').toLowerCase();
    if (!['active', 'paused', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|paused|archived.' });
    }

    const { data: existing } = await supabase.from('tax_customers')
      .select('id, status, community_id, email').eq('id', customerId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Customer not found.' });

    const { error } = await supabase.from('tax_customers')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', customerId);
    if (error) return sendSupabaseError(res, error);

    // When archiving, deactivate relationships AND clean up open tasks
    // tied to them so the Tasks page + Service-progress dashboard stop
    // showing work for someone who's no longer a customer. Completed
    // tasks (completed_at set) survive for the work-done history — same
    // rule the per-relationship removal already applies. Restoring
    // (-> active) leaves the deactivated relationships untouched; owner
    // re-activates per-relationship via the customer-detail editor.
    if (status === 'archived') {
      const { data: rels } = await supabase.from('tax_customer_relationships')
        .select('relationship_type_id').eq('customer_id', customerId).eq('active', true);
      await supabase.from('tax_customer_relationships')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('customer_id', customerId).eq('active', true);
      const actorEmail = trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase();
      for (const r of (rels || [])) {
        try {
          await removeTasksForRelationship({
            customerId, relationshipTypeId: r.relationship_type_id, actorEmail,
          });
        } catch (e) { warn('[tax-customer-archive] task delete failed', e?.message || e); }
      }
    }

    try {
      await auditLog({
        entity: 'tax.customer', entityId: customerId, action: 'set_status',
        actorEmail: '',
        before: { status: existing.status },
        after: { status },
      });
    } catch (_e) {}
    res.json({ ok: true, status });
  });

  router.post('/admin/customers/import', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const csvText = String(body.csv || '');
    // Phase: mode='skip' (default — duplicate emails leave existing row
    // alone) or 'update' (duplicate emails get field-level merged with
    // the CSV — blank cells are preserved; non-blank cells overwrite).
    const mode = body.mode === 'update' ? 'update' : 'skip';

    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    if (!csvText.trim()) return res.status(400).json({ error: 'csv body is empty.' });

    const rows = parseCsv(csvText);
    if (!rows.length) {
      return res.json({ created: 0, updated: 0, skipped: 0, errors: [] });
    }

    const headers = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/\s+/g, '_'));
    if (!headers.includes('email')) {
      return res.status(400).json({ error: 'csv must include an "email" column.' });
    }

    // Look up valid relationship-type IDs once. Unknown IDs in a row are
    // logged as warnings but don't fail the row.
    const { data: types } = await supabase.from('tax_relationship_types')
      .select('id, community_id').eq('active', true);
    const validTypeIds = new Set((types || [])
      .filter(t => t.community_id == null || t.community_id === communitySlug)
      .map(t => t.id));

    // Pre-fetch existing customers in this community so we can detect
    // duplicates and (in update mode) merge their fields. Index by lower-
    // cased email for case-insensitive matching.
    const { data: existing } = await supabase.from('tax_customers')
      .select('id, email, name, business_name, customer_type, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, notes')
      .eq('community_id', communitySlug);
    const byEmail = new Map();
    for (const c of existing || []) {
      byEmail.set(String(c.email || '').toLowerCase(), c);
    }

    // Pre-fetch existing relationship tags so we can additively merge.
    let existingRels = new Map();
    if (mode === 'update' && existing && existing.length) {
      const { data: relRows } = await supabase.from('tax_customer_relationships')
        .select('customer_id, relationship_type_id')
        .in('customer_id', existing.map(c => c.id))
        .eq('active', true);
      for (const r of relRows || []) {
        const set = existingRels.get(r.customer_id) || new Set();
        set.add(r.relationship_type_id);
        existingRels.set(r.customer_id, set);
      }
    }

    const created = [];
    const updated = [];
    const skipped = [];
    const errors = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every(c => !c || !String(c).trim())) continue;     // blank row

      const r = {};
      for (let j = 0; j < headers.length; j++) r[headers[j]] = String(row[j] || '').trim();

      const rowNum = i + 1;     // 1-based, matches what owner sees in Excel

      const email = (r.email || '').toLowerCase();
      if (!email) { errors.push({ row: rowNum, email: '', message: 'Missing email' }); continue; }
      if (!isValidEmail(email)) { errors.push({ row: rowNum, email, message: 'Invalid email' }); continue; }

      // WhatsApp validation (applies to both create + update).
      let whatsapp = null;       // null = "field absent from this row, leave alone"
      if (r.whatsapp !== undefined && r.whatsapp !== '') {
        whatsapp = normalizeWhatsapp(r.whatsapp);
        if (!whatsapp) {
          errors.push({ row: rowNum, email, message: `Invalid WhatsApp: ${r.whatsapp}` });
          continue;
        }
      }

      const preferredEmail = (r.preferred_communication_email || '').toLowerCase();
      if (preferredEmail && !isValidEmail(preferredEmail)) {
        errors.push({ row: rowNum, email, message: `Invalid preferred email: ${r.preferred_communication_email}` });
        continue;
      }

      // Parse relationships (comma-separated). Unknown IDs warn.
      const requestedRels = (r.relationships || '').split(',').map(s => s.trim()).filter(Boolean);
      const validRels = [];
      const unknownRels = [];
      for (const id of requestedRels) {
        if (validTypeIds.has(id)) validRels.push(id);
        else unknownRels.push(id);
      }

      const existingCust = byEmail.get(email);

      if (existingCust) {
        // ── Existing email ─────────────────────────────────────────
        if (mode === 'skip') {
          skipped.push({ row: rowNum, email, message: 'Already in this community — skipped' });
          continue;
        }

        // mode === 'update': field-level merge. Blank CSV cells are
        // preserved (no change); non-blank cells overwrite. Address
        // subfields update independently.
        const update = { updated_at: new Date().toISOString() };
        if (r.name || r.first_name || r.middle_name || r.last_name) {
          const np = resolveNamePayload({
            name: r.name,
            firstName: r.first_name,
            middleName: r.middle_name,
            lastName: r.last_name,
          });
          update.name = np.name;
          update.first_name = np.first;
          update.middle_name = np.middle;
          update.last_name = np.last;
        }
        if (r.phone) update.phone = r.phone.slice(0, MAX_PHONE_LEN);
        if (whatsapp !== null) update.whatsapp = whatsapp;
        if (preferredEmail)  update.preferred_communication_email = preferredEmail.slice(0, MAX_NAME_LEN);
        if (r.locale === 'en' || r.locale === 'es') update.locale = r.locale;
        if (r.notes) update.notes = r.notes.slice(0, MAX_TEXT_LEN);

        // Address: merge subfields independently with the existing JSONB.
        const addrPatch = {};
        if (r.address_line1) addrPatch.line1 = r.address_line1.slice(0, MAX_NAME_LEN);
        if (r.address_line2) addrPatch.line2 = r.address_line2.slice(0, MAX_NAME_LEN);
        if (r.city)          addrPatch.city = r.city.slice(0, MAX_NAME_LEN);
        if (r.state)         addrPatch.state = r.state.slice(0, MAX_NAME_LEN);
        if (r.postal_code)   addrPatch.postal_code = r.postal_code.slice(0, 20);
        if (r.country)       addrPatch.country = r.country.slice(0, 4);
        if (Object.keys(addrPatch).length) {
          update.address = { ...(existingCust.address || {}), ...addrPatch };
        }

        const hasFieldChanges = Object.keys(update).length > 1;
        // Additive relationship merge — add any new ones; never remove.
        const currentRels = existingRels.get(existingCust.id) || new Set();
        const newRels = validRels.filter(id => !currentRels.has(id));

        if (!hasFieldChanges && !newRels.length && !unknownRels.length) {
          // Nothing actually new to apply.
          skipped.push({ row: rowNum, email, message: 'No changes from existing row — skipped' });
          continue;
        }

        if (hasFieldChanges) {
          const { error: uErr } = await supabase.from('tax_customers')
            .update(update).eq('id', existingCust.id);
          if (uErr) {
            errors.push({ row: rowNum, email, message: `Update failed: ${uErr.message}` });
            continue;
          }
        }

        if (newRels.length) {
          const relRows = newRels.map(typeId => ({
            id: 'crel_' + uuidv4().slice(0, 12),
            customer_id: existingCust.id,
            relationship_type_id: typeId,
            created_by_email: 'import',
            active: true,
          }));
          const { error: relErr } = await supabase.from('tax_customer_relationships').insert(relRows);
          if (relErr) {
            errors.push({ row: rowNum, email,
              message: `Updated, relationships failed: ${relErr.message}`,
              warning: true });
          } else {
            for (const id of newRels) currentRels.add(id);
            existingRels.set(existingCust.id, currentRels);
          }
        }

        if (unknownRels.length) {
          errors.push({ row: rowNum, email,
            message: `Updated; unknown relationship IDs skipped: ${unknownRels.join(', ')}`,
            warning: true });
        }

        updated.push({ id: existingCust.id, email });
        continue;
      }

      // ── New email: create ────────────────────────────────────────
      const address = {};
      if (r.address_line1) address.line1 = r.address_line1.slice(0, MAX_NAME_LEN);
      if (r.address_line2) address.line2 = r.address_line2.slice(0, MAX_NAME_LEN);
      if (r.city)          address.city = r.city.slice(0, MAX_NAME_LEN);
      if (r.state)         address.state = r.state.slice(0, MAX_NAME_LEN);
      if (r.postal_code)   address.postal_code = r.postal_code.slice(0, 20);
      if (r.country)       address.country = r.country.slice(0, 4);
      else if (address.line1) address.country = 'US';

      const customerId = 'cust_' + uuidv4().slice(0, 16);
      const np = resolveNamePayload({
        name: r.name,
        firstName: r.first_name,
        middleName: r.middle_name,
        lastName: r.last_name,
      });
      const customerRow = {
        id: customerId,
        community_id: communitySlug,
        email,
        name: np.name,
        first_name: np.first,
        middle_name: np.middle,
        last_name: np.last,
        business_name: (r.business_name || '').slice(0, 200),
        phone: (r.phone || '').slice(0, MAX_PHONE_LEN),
        whatsapp: whatsapp || '',
        address,
        preferred_communication_email: preferredEmail.slice(0, MAX_NAME_LEN),
        locale: r.locale === 'en' ? 'en' : 'es',
        notes: (r.notes || '').slice(0, MAX_TEXT_LEN),
        status: 'active',
      };

      const { error: insErr } = await supabase.from('tax_customers').insert(customerRow);
      if (insErr) {
        errors.push({ row: rowNum, email, message: `Insert failed: ${insErr.message}` });
        continue;
      }

      if (validRels.length) {
        const relRows = validRels.map(typeId => ({
          id: 'crel_' + uuidv4().slice(0, 12),
          customer_id: customerId,
          relationship_type_id: typeId,
          created_by_email: 'import',
          active: true,
        }));
        const { error: relErr } = await supabase.from('tax_customer_relationships').insert(relRows);
        if (relErr) {
          errors.push({ row: rowNum, email,
            message: `Customer created, relationships failed: ${relErr.message}`,
            warning: true });
        }
      }
      if (unknownRels.length) {
        errors.push({ row: rowNum, email,
          message: `Customer created, unknown relationship IDs skipped: ${unknownRels.join(', ')}`,
          warning: true });
      }

      // Track in-batch so a CSV with duplicate rows for the same email
      // doesn't insert twice. Treat the second occurrence as either
      // skip or update depending on mode.
      byEmail.set(email, { ...customerRow });
      existingRels.set(customerId, new Set(validRels));
      created.push({ id: customerId, email });
    }

    try {
      await auditLog({
        entity: 'tax.customer', entityId: communitySlug,
        action: 'import_csv',
        actorEmail: trim(req.get('x-admin-email') || req.get('x-firebase-email') || '', 200).toLowerCase(),
        after: { mode, created: created.length, updated: updated.length,
                 skipped: skipped.length, errorCount: errors.filter(e => !e.warning).length },
      });
    } catch (_e) {}

    res.json({
      mode,
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
      errors,                        // mixed hard-errors + warnings (each flagged)
      createdRows: created,
      updatedRows: updated,
      skippedRows: skipped,
    });
  });

  // Minimal RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes
  // (""), CRLF/LF/CR line endings, trailing newlines. Returns string[][].
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let i = 0;
    let inQuotes = false;
    const len = text.length;
    while (i < len) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < len && text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') {
        if (i + 1 < len && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      field += ch; i++;
    }
    // Flush final field/row
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // Strip fully-empty trailing rows
    while (rows.length && rows[rows.length - 1].every(c => !c || c === '')) rows.pop();
    // Drop comment rows — anything where the first non-blank field starts
    // with "#". Lets the shareable template include documentation inline
    // without forcing the owner to manually delete it before upload. We
    // never drop the first row (header) regardless, even if someone names
    // a column starting with "#" — unlikely but defensive.
    return rows.filter((r, i) => {
      if (i === 0) return true;
      const firstFilled = r.find(c => c && String(c).trim());
      return !firstFilled || !String(firstFilled).trim().startsWith('#');
    });
  }

  // ── GET /admin/customers/:id ── (Phase 4a)
  // Single-customer detail view: profile + active relationships + active
  // subscriptions + counts for documents and threads. The dashboard composes
  // these into the customer detail page in one round trip.
  router.get('/admin/customers/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const id = trim(req.params.id, 200);
    const { data: cust, error: cErr } = await supabase.from('tax_customers')
      .select('id, community_id, email, name, business_name, customer_type, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, status, notes, firebase_uid, last_sign_in_at, created_at, updated_at')
      .eq('id', id).maybeSingle();
    if (cErr) return sendSupabaseError(res, cErr);
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    const [rels, subs, docs, threads, assignments, periods, emailLogs] = await Promise.all([
      supabase.from('tax_customer_relationships')
        .select(`
          id, relationship_type_id, notes, active, created_at,
          type:tax_relationship_types ( id, category, slug, name_i18n, display_order )
        `).eq('customer_id', id).eq('active', true),
      supabase.from('tax_subscriptions')
        .select('id, product_id, status, reminder_channels, reminder_offsets_days, active_schedule_slugs, custom_info_checklist, start_date, created_at')
        .eq('customer_id', id),
      supabase.from('tax_documents')
        .select('id, source, kind, file_name, mime_type, size_bytes, status, uploaded_at, uploaded_by_role, uploaded_by_email, created_at')
        .eq('customer_id', id).is('deleted_at', null).eq('status', 'uploaded')
        .order('created_at', { ascending: false }).limit(100),
      supabase.from('tax_message_threads')
        .select('id, subject, status, last_message_at, last_message_preview, last_message_by_role, practice_unread, created_at')
        .eq('customer_id', id)
        .order('last_message_at', { ascending: false, nullsFirst: false }).limit(50),
      supabase.from('tax_employee_customer_assignments')
        .select(`
          id, is_primary, created_at,
          employee:tax_employees ( id, email, name, role )
        `).eq('customer_id', id).eq('active', true),
      // Phase 4d: include filing periods so the owner detail page can render
      // a Filings section with per-period status overrides without an extra
      // round trip. Window: next 12 due plus most recent 12 by due_date.
      supabase.from('tax_filing_periods')
        .select(`
          id, period_label, period_start, period_end, due_date,
          status, info_received_at, filed_at, created_at,
          workflow_rule_id, relationship_type_id,
          schedule:tax_filing_schedules ( id, slug, jurisdiction, cadence, name_i18n ),
          workflow:tax_relationship_workflow_rules ( id, filing_schedule_slug, cadence, name_i18n )
        `)
        .eq('customer_id', id)
        .order('due_date', { ascending: false }).limit(24),
      // Phase 4n: reminder send + open/click history. Bounded so we don't
      // pull every email this customer ever got; the UI shows the 20 most
      // recent reminder events.
      supabase.from('email_delivery_logs')
        .select('id, event_type, subject, related_id, created_at, delivered_at, opened_at, clicked_at, bounced_at, open_count, click_count')
        .eq('customer_id', id).eq('event_type', 'reminder')
        .order('created_at', { ascending: false }).limit(20),
    ]);

    res.json({
      customer: cust,
      relationships: rels.data || [],
      subscriptions: subs.data || [],
      documents: docs.data || [],
      threads: threads.data || [],
      periods: periods.data || [],
      assignments: assignments.data || [],
      emailLogs: emailLogs.data || [],
    });
  });

  router.get('/admin/periods', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug || '', 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });

    const { data, error } = await supabase
      .from('tax_filing_periods')
      .select(`
        id, period_label, due_date, status, info_received_at, filed_at,
        customer:tax_customers ( id, email, name ),
        schedule:tax_filing_schedules ( id, slug, name_i18n, jurisdiction )
      `)
      .eq('community_id', communitySlug)
      .order('due_date', { ascending: true })
      .limit(200);
    if (error) return sendSupabaseError(res, error);
    res.json({ periods: data || [] });
  });

  // ── PUT /admin/periods/:id ── (Phase 4d)
  // Manual override of a filing period's status. Common owner action: mark
  // a period 'skipped' when the customer's business was closed that month,
  // or advance to 'filed' after submitting through agency portal. The
  // reminder cron respects status — periods in 'filed' or 'skipped' stop
  // generating reminders.
  router.put('/admin/periods/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const periodId = trim(req.params.id, 200);
    const body = req.body || {};
    const update = { updated_at: new Date().toISOString() };

    if (body.status !== undefined) {
      const s = String(body.status);
      if (!['pending', 'info_requested', 'info_received', 'in_prep', 'filed', 'skipped'].includes(s)) {
        return res.status(400).json({
          error: 'status must be pending|info_requested|info_received|in_prep|filed|skipped.',
        });
      }
      update.status = s;
      // Auto-stamp the timestamp for entry into terminal states. Owner can
      // also pass infoReceivedAt / filedAt explicitly to override the stamp.
      const nowIso = new Date().toISOString();
      if (s === 'info_received' && body.infoReceivedAt === undefined) update.info_received_at = nowIso;
      if (s === 'filed' && body.filedAt === undefined) update.filed_at = nowIso;
    }
    if (body.infoReceivedAt !== undefined) {
      update.info_received_at = body.infoReceivedAt ? new Date(body.infoReceivedAt).toISOString() : null;
    }
    if (body.filedAt !== undefined) {
      update.filed_at = body.filedAt ? new Date(body.filedAt).toISOString() : null;
    }

    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    const { error } = await supabase.from('tax_filing_periods').update(update).eq('id', periodId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── PUT /admin/customers/:id ── (Phase 4d)
  // Admin override of customer profile fields. The customer self-serves
  // these via /portal/profile (Phase 2e); this endpoint exists so the
  // owner can fix typos / fill in fields before the customer has signed
  // in. The login email is NOT editable here — it's the Firebase auth
  // identity. Schema for changing the login email lives in Phase 5 with
  // a proper re-link flow.
  router.put('/admin/customers/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const body = req.body || {};
    const update = { updated_at: new Date().toISOString() };

    // Name: accept either {firstName, middleName, lastName} or legacy {name}.
    // Either form repopulates the three parts AND the denormalized `name`.
    const sentNameField =
      body.firstName !== undefined || body.middleName !== undefined ||
      body.lastName  !== undefined || body.name       !== undefined;
    if (sentNameField) {
      const np = resolveNamePayload(body);
      update.name = np.name;
      update.first_name = np.first;
      update.middle_name = np.middle;
      update.last_name = np.last;
    }
    if (body.businessName !== undefined) {
      update.business_name = trim(body.businessName, 200);
    }
    if (body.phone !== undefined) update.phone = trim(body.phone, MAX_PHONE_LEN);

    if (body.whatsapp !== undefined) {
      const raw = String(body.whatsapp || '').trim();
      if (raw === '') update.whatsapp = '';
      else {
        const norm = normalizeWhatsapp(raw);
        if (!norm) {
          return res.status(400).json({ error: 'whatsapp_invalid',
            message: 'WhatsApp must be in international format starting with + and country code.' });
        }
        update.whatsapp = norm;
      }
    }
    if (body.address !== undefined) update.address = sanitizeAddress(body.address);

    if (body.preferredCommunicationEmail !== undefined) {
      const raw = String(body.preferredCommunicationEmail || '').trim().toLowerCase();
      if (raw === '') update.preferred_communication_email = '';
      else if (!isValidEmail(raw)) {
        return res.status(400).json({ error: 'preferred_email_invalid' });
      } else update.preferred_communication_email = raw.slice(0, MAX_NAME_LEN);
    }
    if (body.locale !== undefined) {
      update.locale = (body.locale === 'en') ? 'en' : 'es';
    }
    if (body.status !== undefined) {
      const s = String(body.status);
      if (!['active', 'paused', 'archived'].includes(s)) {
        return res.status(400).json({ error: 'status must be active|paused|archived.' });
      }
      update.status = s;
    }
    if (body.notes !== undefined) update.notes = trim(body.notes, MAX_TEXT_LEN);

    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    const { error } = await supabase.from('tax_customers').update(update).eq('id', customerId);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.customer', entityId: customerId, action: 'admin_update_profile',
        actorEmail: trim(req.get('x-admin-email') || req.get('x-firebase-email') || '', 200).toLowerCase(),
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── GET /admin/audit?communitySlug=&entity=&action=&actor=&from=&to=&offset=
  //
  // Tax-scoped audit log viewer. Filters audit_logs to rows where
  //   entity LIKE 'tax.%'  AND
  //   (optional) entity matches exactly,
  //   (optional) action ilike,
  //   (optional) actor_email ilike,
  //   (optional) created_at >= dateFrom + dateTo+'T23:59:59Z'
  // Returns up to 100 rows per page; total count for pagination UI.
  //
  // NOTE: audit_logs is platform-wide and has no community_id column, so we
  // can't strictly scope by community. In practice every tax row has its
  // actor in the same community via tax_customers/tax_employees, and entity
  // ids are community-scoped. For multi-community deployments, Phase 5 will
  // add explicit per-community filtering.
  router.get('/admin/audit', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'view_audit_logs'))) return;
    const { entity, action, actor, dateFrom, dateTo, limit: limitParam, offset: offsetParam } = req.query || {};

    let q = supabase.from('audit_logs')
      .select('id, entity, entity_id, action, actor_uid, actor_email, actor_name, before_data, after_data, reason, created_at',
              { count: 'exact' })
      .like('entity', 'tax.%')
      .order('created_at', { ascending: false });

    if (entity && entity !== 'all') q = q.eq('entity', String(entity));
    if (action) q = q.ilike('action', `%${String(action)}%`);
    if (actor)  q = q.ilike('actor_email', `%${String(actor)}%`);
    if (dateFrom) q = q.gte('created_at', String(dateFrom));
    if (dateTo)   q = q.lte('created_at', String(dateTo) + 'T23:59:59Z');

    const pageLimit  = Math.min(parseInt(limitParam) || 50, 100);
    const pageOffset = parseInt(offsetParam) || 0;
    q = q.range(pageOffset, pageOffset + pageLimit - 1);
    const { data, error, count } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ logs: data || [], total: count || 0, limit: pageLimit, offset: pageOffset });
  });

  router.put('/admin/community-settings/notif-lock', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    const allowChange = Boolean(req.body?.allowCustomerChange);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { error } = await supabase.from('communities')
      .update({ tax_allow_customer_notif_pref_change: allowChange, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true, allowCustomerChange: allowChange });
  });

  // Owner toggle for the customer-facing reminder cron. Default is OFF
  // (the practice now uses internal tasks). Turn back on per-community
  // when the owner still wants the cron to email customers reminders.
  // Configurable look-ahead window for the task generator + daily
  // refresh cron. Default is 6 months; clamped to [1, 24].
  // PUT /admin/community-settings/task-thresholds — replace the three
  // urgency thresholds. Values are clamped server-side and re-checked
  // so urgent < soon < upcoming (anything else is nonsense — would
  // mean "urgent for 30 days but soon for only 7").
  // PUT /admin/community-settings/task-color-overrides
  // Body: { priorityColors?: { urgent, high, normal, low },
  //         urgencyColors?:  { overdue, urgent, soon, later } }
  // Each value is a 7-char hex string (#rrggbb). Unknown keys are
  // dropped; missing keys leave the previous override in place.
  // Passing an empty string clears that key (falls back to default).
  router.put('/admin/community-settings/task-color-overrides', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const PRIORITY_KEYS = ['urgent','high','normal','low'];
    const URGENCY_KEYS  = ['overdue','urgent','soon','later'];
    const sanitizeMap = (raw, allowed) => {
      const out = {};
      if (!raw || typeof raw !== 'object') return out;
      for (const k of allowed) {
        const v = raw[k];
        if (v === '' || v === null) continue; // omit → falls back to default
        if (typeof v !== 'string') continue;
        const trimmed = v.trim().toLowerCase();
        // Accept #rrggbb or #rgb. Anything else is dropped.
        if (/^#[0-9a-f]{6}$/.test(trimmed) || /^#[0-9a-f]{3}$/.test(trimmed)) {
          out[k] = trimmed;
        }
      }
      return out;
    };
    const update = { updated_at: new Date().toISOString() };
    if (req.body?.priorityColors !== undefined) {
      update.tax_task_priority_colors = sanitizeMap(req.body.priorityColors, PRIORITY_KEYS);
    }
    if (req.body?.urgencyColors !== undefined) {
      update.tax_task_urgency_colors  = sanitizeMap(req.body.urgencyColors, URGENCY_KEYS);
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    const { error } = await supabase.from('communities')
      .update(update).eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.settings', entityId: communitySlug,
        action: 'task_color_overrides_set',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { priority: update.tax_task_priority_colors, urgency: update.tax_task_urgency_colors },
      });
    } catch (_e) {}
    res.json({
      ok: true,
      priorityColors: update.tax_task_priority_colors,
      urgencyColors:  update.tax_task_urgency_colors,
    });
  });

  router.put('/admin/community-settings/task-thresholds', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const clamp = (n, min, max, fallback) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return fallback;
      return Math.max(min, Math.min(max, Math.round(v)));
    };
    let urgent   = clamp(req.body?.urgentDays,   0,  60, 3);
    let soon     = clamp(req.body?.soonDays,     0,  90, 7);
    let upcoming = clamp(req.body?.upcomingDays, 0, 365, 30);
    if (soon < urgent) soon = urgent;
    if (upcoming < soon) upcoming = soon;
    const { error } = await supabase.from('communities')
      .update({
        tax_task_urgent_days:   urgent,
        tax_task_soon_days:     soon,
        tax_task_upcoming_days: upcoming,
        updated_at: new Date().toISOString(),
      })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.settings', entityId: communitySlug,
        action: 'task_thresholds_set',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { urgent, soon, upcoming },
      });
    } catch (_e) {}
    res.json({ ok: true, urgent, soon, upcoming });
  });

  router.put('/admin/community-settings/task-lookahead-months', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    const raw = Number(req.body?.months);
    const months = Math.max(1, Math.min(24, Math.round(Number.isFinite(raw) ? raw : 6)));
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { error } = await supabase.from('communities')
      .update({ tax_task_lookahead_months: months, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);

    // Keep recurring tasks consistent with the new horizon. Both helpers
    // are idempotent and only touch source='relationship_schedule' rows
    // that are still open — completed history and manual one-offs are
    // preserved regardless of direction.
    //   • Prune: drops auto-generated tasks whose due_date now falls
    //     past the new cutoff (no-op when the value increased).
    //   • Refresh: regenerates the missing future tasks across all
    //     active customer-services in this community (no-op when the
    //     value decreased, since the existing rows already cover the
    //     shorter horizon).
    let tasksDeleted = 0, tasksCreated = 0;
    try {
      const r = await pruneTasksBeyondLookahead({ communityId: communitySlug, lookaheadMonths: months });
      tasksDeleted = r.deleted || 0;
    } catch (e) { warn('[tax-lookahead] prune failed', e?.message || e); }
    try {
      const r = await refreshRecurringTasksForCommunity(communitySlug);
      tasksCreated = r.created || 0;
    } catch (e) { warn('[tax-lookahead] refresh failed', e?.message || e); }

    try {
      await auditLog({
        entity: 'tax.community.settings', entityId: communitySlug,
        action: 'task_lookahead_set',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { months, tasksDeleted, tasksCreated },
      });
    } catch (_e) {}
    res.json({ ok: true, months, tasksDeleted, tasksCreated });
  });

  router.put('/admin/community-settings/reminders-enabled', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    const enabled = Boolean(req.body?.enabled);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { error } = await supabase.from('communities')
      .update({ tax_customer_reminders_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.settings', entityId: communitySlug,
        action: enabled ? 'reminders_enable' : 'reminders_disable',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
      });
    } catch (_e) {}
    res.json({ ok: true, enabled });
  });

  // Per-type customer-email toggles. Each maps to one boolean column on
  // communities and gates the automatic send paths below. Owners flip
  // each on from Settings → Customer email notifications; defaults
  // are off so a fresh community never quietly emails customers.
  const EMAIL_TYPE_COLUMNS = {
    welcome:   'tax_email_welcome_enabled',
    document:  'tax_email_document_enabled',
    message:   'tax_email_message_enabled',
    signature: 'tax_email_signature_enabled',
  };
  router.put('/admin/community-settings/customer-email-enabled', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const type = trim(body.type, 40);
    const column = EMAIL_TYPE_COLUMNS[type];
    if (!communitySlug || !column) {
      return res.status(400).json({ error: 'communitySlug and a known type required.' });
    }
    const enabled = Boolean(body.enabled);
    const { error } = await supabase.from('communities')
      .update({ [column]: enabled, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.email', entityId: communitySlug,
        action: `set_${type}_enabled`,
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { [column]: enabled },
      });
    } catch (_e) {}
    res.json({ ok: true, type, enabled });
  });

  // Owner master switch for every automatic customer email. Off →
  // every per-type flag below is overridden so the practice goes
  // quiet without losing the per-type config. On → per-type flags
  // control individual sends as usual.
  router.put('/admin/community-settings/customer-emails-master', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    const enabled = Boolean(req.body?.enabled);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { error } = await supabase.from('communities')
      .update({ tax_customer_emails_master_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.email', entityId: communitySlug,
        action: 'set_master_enabled',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { tax_customer_emails_master_enabled: enabled },
      });
    } catch (_e) {}
    res.json({ ok: true, enabled });
  });

  // Helper: read one of the customer-email flags for a community. Used
  // by the automatic send paths below to skip the email when the owner
  // has the type turned off. Honors the master switch first — if the
  // master is off the per-type result doesn't matter.
  async function communityEmailFlag(communityId, column) {
    if (!communityId || !column) return false;
    try {
      const { data } = await supabase.from('communities')
        .select(`tax_customer_emails_master_enabled, ${column}`)
        .eq('id', communityId).maybeSingle();
      if (!data || data.tax_customer_emails_master_enabled !== true) return false;
      return data[column] === true;
    } catch { return false; }
  }

  // Mirror of the customer-side helpers but for owner/staff emails
  // (lead notifications, task-assignment, customer-messaged-practice,
  // signed-confirmation, staff welcome). Defaults are ON so existing
  // tenants keep their current behavior; the owner flips them off
  // from Settings → Team email notifications.
  const STAFF_EMAIL_TYPE_COLUMNS = {
    lead:              'tax_staff_email_lead_enabled',
    task_assigned:     'tax_staff_email_task_assigned_enabled',
    message:           'tax_staff_email_message_enabled',
    signature_signed:  'tax_staff_email_signature_signed_enabled',
    staff_welcome:     'tax_staff_email_welcome_enabled',
    digest:            'tax_staff_email_digest_enabled',
  };
  router.put('/admin/community-settings/staff-email-enabled', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const type = trim(body.type, 40);
    const column = STAFF_EMAIL_TYPE_COLUMNS[type];
    if (!communitySlug || !column) {
      return res.status(400).json({ error: 'communitySlug and a known type required.' });
    }
    const enabled = Boolean(body.enabled);
    const { error } = await supabase.from('communities')
      .update({ [column]: enabled, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.email', entityId: communitySlug,
        action: `set_staff_${type}_enabled`,
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { [column]: enabled },
      });
    } catch (_e) {}
    res.json({ ok: true, type, enabled });
  });
  router.put('/admin/community-settings/staff-emails-master', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    const enabled = Boolean(req.body?.enabled);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { error } = await supabase.from('communities')
      .update({ tax_staff_emails_master_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.email', entityId: communitySlug,
        action: 'set_staff_master_enabled',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { tax_staff_emails_master_enabled: enabled },
      });
    } catch (_e) {}
    res.json({ ok: true, enabled });
  });

  // Daily-digest schedule. Accepts an hour (0–23), a comma-delimited
  // weekday list (subset of sun,mon,tue,wed,thu,fri,sat), and an IANA
  // timezone string. The cron honors all three on each tick — see
  // server/modules/tax/digest.js. Body is partial: anything not in
  // the payload keeps its current value, so the UI can save each
  // control independently if needed.
  const DAY_CODE_SET = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  router.put('/admin/community-settings/digest-schedule', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });

    const update = { updated_at: new Date().toISOString() };
    if (body.sendHour !== undefined) {
      const h = Number(body.sendHour);
      if (!Number.isFinite(h) || h < 0 || h > 23) {
        return res.status(400).json({ error: 'invalid_hour',
          message: 'Send hour must be 0–23 (24-hour clock).' });
      }
      update.tax_digest_send_hour = Math.floor(h);
    }
    if (body.timezone !== undefined) {
      const tz = trim(body.timezone, 100);
      // Verify the timezone is recognized by the runtime — if Intl
      // rejects it the cron would silently fall back to UTC, which
      // would surprise the owner.
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
      catch {
        return res.status(400).json({ error: 'invalid_timezone',
          message: 'Timezone must be a valid IANA identifier (e.g. America/New_York).' });
      }
      update.tax_digest_send_timezone = tz;
    }
    if (body.sendDays !== undefined) {
      const codes = Array.isArray(body.sendDays)
        ? body.sendDays
        : String(body.sendDays || '').split(',');
      const cleaned = codes
        .map(d => String(d || '').trim().toLowerCase())
        .filter(d => DAY_CODE_SET.has(d));
      if (!cleaned.length) {
        return res.status(400).json({ error: 'no_days',
          message: 'Pick at least one day the digest should send.' });
      }
      update.tax_digest_send_days = Array.from(new Set(cleaned)).join(',');
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error } = await supabase.from('communities')
      .update(update)
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.email', entityId: communitySlug,
        action: 'set_digest_schedule',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: Object.fromEntries(Object.entries(update).filter(([k]) => k !== 'updated_at')),
      });
    } catch (_e) {}
    res.json({ ok: true, schedule: update });
  });

  async function communityStaffEmailFlag(communityId, column) {
    if (!communityId || !column) return false;
    try {
      const { data } = await supabase.from('communities')
        .select(`tax_staff_emails_master_enabled, ${column}`)
        .eq('id', communityId).maybeSingle();
      if (!data || data.tax_staff_emails_master_enabled !== true) return false;
      return data[column] === true;
    } catch { return false; }
  }

  // Owner toggle for the customer portal itself. Default is OFF — when
  // disabled, the portal routes redirect to the landing page and every
  // outbound email swaps portal links for landing-page links.
  router.put('/admin/community-settings/portal-enabled', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    const enabled = Boolean(req.body?.enabled);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { error } = await supabase.from('communities')
      .update({ tax_customer_portal_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.settings', entityId: communitySlug,
        action: enabled ? 'portal_enable' : 'portal_disable',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
      });
    } catch (_e) {}
    res.json({ ok: true, enabled });
  });

  // Owner toggle for customer-side document uploads. Default is OFF — the
  // schema column defaults to false. When enabled, the customer portal
  // exposes the Documents page and the upload endpoints accept new files;
  // when disabled, both UI and API reject.
  router.put('/admin/community-settings/documents-enabled', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const communitySlug = trim(req.body?.communitySlug, 200);
    const enabled = Boolean(req.body?.enabled);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { error } = await supabase.from('communities')
      .update({ tax_customer_documents_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.settings', entityId: communitySlug,
        action: enabled ? 'documents_enable' : 'documents_disable',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
      });
    } catch (_e) {}
    res.json({ ok: true, enabled });
  });

  // ── Phase 4b admin endpoints ───────────────────────────────────────────────

  // GET /admin/community-settings?communitySlug=  — companion read for the
  // PUT /admin/community-settings/notif-lock that exists since Phase 2a.
  router.get('/admin/community-settings', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { data, error } = await supabase.from('communities')
      .select(`
        id, name, name_en, tax_allow_customer_notif_pref_change, tax_customer_documents_enabled,
        tax_customer_portal_enabled, tax_customer_reminders_enabled, tax_task_lookahead_months,
        tax_task_urgent_days, tax_task_soon_days, tax_task_upcoming_days,
        tax_task_priority_colors, tax_task_urgency_colors,
        tax_customer_emails_master_enabled,
        tax_email_welcome_enabled, tax_email_document_enabled,
        tax_email_message_enabled, tax_email_signature_enabled,
        tax_staff_emails_master_enabled,
        tax_staff_email_lead_enabled, tax_staff_email_task_assigned_enabled,
        tax_staff_email_message_enabled, tax_staff_email_signature_signed_enabled,
        tax_staff_email_welcome_enabled, tax_staff_email_digest_enabled,
        tax_digest_send_hour, tax_digest_send_timezone, tax_digest_send_days,
        tax_email_from_name, tax_email_from_name_en,
        tax_email_from_address, tax_email_from_address_en,
        contact_email, phone, whatsapp,
        address_line1, address_line2, city, state, postal_code, country,
        default_locale, calendly_url, landing_copy_i18n
      `)
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE).maybeSingle();
    if (error) return sendSupabaseError(res, error);
    if (!data) return res.status(404).json({ error: 'Community not found.' });
    // Surface the platform's outbound-email defaults so the From-name /
    // From-address editor can show owners exactly what they're inheriting
    // when their override fields are blank. The address half comes from
    // the EMAIL_FROM env (parsed out of "Name <addr>" if wrapped); the
    // display-name half is just the community's own name.
    const fromRaw = String(PLATFORM_EMAIL_FROM || '');
    const fromAddrMatch = fromRaw.match(/<([^>]+)>/);
    const platform_email_from_address = (fromAddrMatch ? fromAddrMatch[1] : fromRaw).trim();
    res.json({
      settings: data,
      platform_defaults: {
        email_from_address: platform_email_from_address,
      },
    });
  });

  // Phase 4n.14: contact-info editor for the public landing page. Admin-only;
  // every field is optional (empty string clears it). WhatsApp must be
  // E.164 — same normalizer the customer/employee profile editors use.
  router.put('/admin/community-settings/contact', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });

    const update = { updated_at: new Date().toISOString() };
    const txt = (k, max = 200) => {
      if (body[k] === undefined) return;
      update[k] = trim(String(body[k] || ''), max);
    };
    txt('phone',         MAX_PHONE_LEN);
    txt('contact_email', MAX_NAME_LEN);
    txt('address_line1', 400);
    txt('address_line2', 400);
    txt('city',          200);
    txt('state',         200);
    txt('postal_code',   60);
    txt('country',       100);
    if (body.whatsapp !== undefined) {
      const raw = String(body.whatsapp || '').trim();
      if (raw === '') update.whatsapp = '';
      else {
        const norm = normalizeWhatsapp(raw);
        if (!norm) {
          return res.status(400).json({ error: 'whatsapp_invalid',
            message: 'WhatsApp must be in international format, e.g., +14155551234.' });
        }
        update.whatsapp = norm;
      }
    }
    if (body.calendly_url !== undefined) {
      const raw = String(body.calendly_url || '').trim();
      if (raw === '') update.calendly_url = '';
      else {
        // Accept only canonical Calendly URLs so a typo doesn't end up
        // embedding an arbitrary site in an iframe on the landing page.
        if (!/^https:\/\/(www\.)?calendly\.com\/[A-Za-z0-9._\-/?=&]+$/i.test(raw)) {
          return res.status(400).json({ error: 'calendly_invalid',
            message: 'Calendly URL must be https://calendly.com/your-handle (or .../your-handle/event).' });
        }
        update.calendly_url = raw.slice(0, 500);
      }
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    if (update.contact_email && !isValidEmail(update.contact_email)) {
      return res.status(400).json({ error: 'contact_email_invalid',
        message: 'Contact email is not a valid address.' });
    }

    const { error } = await supabase.from('communities').update(update)
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.contact', entityId: communitySlug,
        action: 'update_contact', actorEmail: '',
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // PUT /admin/community-settings/email-from — owner-set From-name and
  // From-address used as the sender on outbound notifications. Per-locale
  // because the practice may want a Spanish name on Spanish emails and an
  // English name on English emails. Empty strings clear the override and
  // the platform falls back to the community name + EMAIL_FROM env.
  //
  // The address's domain must be verified with the configured Resend
  // sending account or Resend will reject the send; we accept the value
  // and let the send-time error surface if the domain isn't allowed.
  router.put('/admin/community-settings/email-from', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });

    const update = { updated_at: new Date().toISOString() };
    const name = (k, max = 120) => {
      if (body[k] === undefined) return;
      update[`tax_${k}`] = trim(String(body[k] || ''), max);
    };
    const addr = (k) => {
      if (body[k] === undefined) return;
      const raw = String(body[k] || '').trim();
      if (raw === '') { update[`tax_${k}`] = ''; return null; }
      if (!isValidEmail(raw)) return `${k}_invalid`;
      update[`tax_${k}`] = raw.slice(0, 200);
      return null;
    };
    name('email_from_name');
    name('email_from_name_en');
    const e1 = addr('email_from_address');
    const e2 = addr('email_from_address_en');
    if (e1 || e2) {
      return res.status(400).json({
        error: e1 || e2,
        message: 'From-address must be a valid email (e.g., notifications@yourpractice.com). The domain must be verified with the platform email provider.',
      });
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error } = await supabase.from('communities').update(update)
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.email_from', entityId: communitySlug,
        action: 'update_email_from', actorEmail: '',
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // PUT /admin/community-settings/landing-copy — owner-customizable copy
  // for the public landing page. Body shape:
  //   { communitySlug, copy: { "<i18n.key>": { en, es }, ... } }
  // Keys are allowlisted so an owner can't smuggle arbitrary HTML/script
  // into the marketing page via a random translation key. Each value is
  // trimmed and capped; empty strings remove the override (the row falls
  // back to the platform default).
  const LANDING_COPY_KEYS = new Set([
    'hero.subtitle', 'hero.cta_primary', 'hero.cta_book', 'hero.cta_secondary',
    'services.heading', 'services.subheading',
    'landing.team.heading', 'landing.team.subheading',
    'landing.articles.heading', 'landing.articles.subheading',
    'landing.faqs.heading', 'landing.faqs.subheading',
    'about.heading', 'about.body',
    'getStarted.heading', 'getStarted.subheading',
    'getStarted.scheduleHeading', 'getStarted.scheduleBody',
    'landing.calendly.cta',
    'getStarted.messageHeading', 'getStarted.messageBody',
  ]);
  const LANDING_COPY_MAX_LEN = 800;
  router.put('/admin/community-settings/landing-copy', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_settings'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const incoming = body.copy && typeof body.copy === 'object' ? body.copy : {};

    const sanitized = {};
    for (const key of Object.keys(incoming)) {
      if (!LANDING_COPY_KEYS.has(key)) continue;
      const v = incoming[key];
      if (!v || typeof v !== 'object') continue;
      const en = String(v.en || '').trim().slice(0, LANDING_COPY_MAX_LEN);
      const es = String(v.es || '').trim().slice(0, LANDING_COPY_MAX_LEN);
      // Skip entries that are entirely empty so the column stays tidy.
      if (!en && !es) continue;
      sanitized[key] = { en, es };
    }

    const { error } = await supabase.from('communities')
      .update({ landing_copy_i18n: sanitized, updated_at: new Date().toISOString() })
      .eq('id', communitySlug).eq('business_type', TAX_BUSINESS_TYPE);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.community.copy', entityId: communitySlug,
        action: 'update_landing_copy', actorEmail: '',
        after: { keys: Object.keys(sanitized) },
      });
    } catch (_e) {}
    res.json({ ok: true, copy: sanitized });
  });

  // GET /admin/products?communitySlug=  — products with their schedules.
  // Used by the OwnerCustomerDetail subscription editor to populate the
  // product + schedule pickers.
  router.get('/admin/products', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { data, error } = await supabase.from('tax_products')
      .select(`
        id, slug, category, enabled, display_order, icon,
        name_i18n, description_i18n, long_description_i18n, required_documents, video_url,
        cadence_kind, anchor_rule, employee_notes_i18n,
        schedules:tax_filing_schedules ( id, slug, jurisdiction, cadence, enabled, name_i18n, info_checklist )
      `)
      .eq('community_id', communitySlug)
      .order('display_order', { ascending: true });
    if (error) return sendSupabaseError(res, error);
    // Enrich each product with its auto-task count so the catalog page
    // can show a "N recurring task(s)" badge at-a-glance without the
    // owner having to expand the editor to find out.
    const products = data || [];
    if (products.length) {
      const { data: counts } = await supabase.from('tax_service_auto_tasks')
        .select('product_id, active')
        .in('product_id', products.map(p => p.id));
      const totals = new Map();
      const actives = new Map();
      for (const r of (counts || [])) {
        totals.set(r.product_id, (totals.get(r.product_id) || 0) + 1);
        if (r.active !== false) actives.set(r.product_id, (actives.get(r.product_id) || 0) + 1);
      }
      for (const p of products) {
        p.auto_tasks_total  = totals.get(p.id)  || 0;
        p.auto_tasks_active = actives.get(p.id) || 0;
      }
    }
    res.json({ products });
  });

  // ── PUT /admin/products/:id ─────────────────────────────────────────────
  // Owner-admin override of service-card copy. Editable fields:
  //   • name_i18n             { en, es }
  //   • description_i18n      short one-liner shown on the card
  //   • long_description_i18n richer prose shown in the detail modal
  //   • required_documents    array of strings (or {label_i18n}) shown as a
  //                           "what we'll need from you" bullet list
  //   • enabled               toggle the card on/off without deleting
  // Other fields (slug, category, workflow, sla_hours, pricing) stay
  // owner-edit-via-SQL for now.
  // POST /admin/products — owner-created service.
  // Body: { communitySlug, slug, category?, nameI18n, descriptionI18n?,
  //         longDescriptionI18n?, requiredDocuments?, displayOrder?,
  //         videoUrl?, icon? }
  // Slug is the per-community unique handle (lowercased, dash-separated).
  // The composite primary key is `${communitySlug}:${slug}` to match the
  // pattern the seed inserts use, so the public landing page picks the
  // service up without a separate routing layer.
  router.post('/admin/products', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_services'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const rawSlug = trim(body.slug, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!communitySlug || !rawSlug) {
      return res.status(400).json({ error: 'communitySlug and slug required.' });
    }
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(rawSlug)) {
      return res.status(400).json({ error: 'invalid_slug',
        message: 'Slug must be lowercase letters, digits, and dashes (e.g., "annual-report").' });
    }
    const nameEn = String(body.nameI18n?.en || '').slice(0, MAX_NAME_LEN).trim();
    const nameEs = String(body.nameI18n?.es || '').slice(0, MAX_NAME_LEN).trim();
    if (!nameEn && !nameEs) {
      return res.status(400).json({ error: 'name_required',
        message: 'Provide the service name in English or Spanish.' });
    }
    // Reject collisions explicitly so the owner gets a clean message
    // instead of a Postgres unique-violation echo.
    const id = `${communitySlug}:${rawSlug}`;
    const { data: existing } = await supabase.from('tax_products')
      .select('id').eq('id', id).maybeSingle();
    if (existing) {
      return res.status(409).json({ error: 'slug_in_use',
        message: 'A service with that slug already exists in this community.' });
    }

    const allowedCategories = ['tax_prep','recurring','one_off'];
    const category = allowedCategories.includes(String(body.category || ''))
      ? body.category : 'one_off';

    const row = {
      id, community_id: communitySlug, slug: rawSlug, category,
      enabled: true,
      display_order: Math.max(0, Math.min(10000, Number(body.displayOrder) || 0)),
      icon: String(body.icon || '').slice(0, 40),
      name_i18n: {
        en: nameEn || nameEs,
        es: nameEs || nameEn,
      },
      description_i18n: (body.descriptionI18n && typeof body.descriptionI18n === 'object') ? {
        en: String(body.descriptionI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.descriptionI18n.es || '').slice(0, MAX_TEXT_LEN),
      } : {},
      long_description_i18n: (body.longDescriptionI18n && typeof body.longDescriptionI18n === 'object') ? {
        en: String(body.longDescriptionI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.longDescriptionI18n.es || '').slice(0, MAX_TEXT_LEN),
      } : {},
      required_documents: Array.isArray(body.requiredDocuments)
        ? body.requiredDocuments.slice(0, 30).map(d => {
            if (typeof d === 'string') return String(d).slice(0, MAX_NAME_LEN);
            if (d && typeof d === 'object') return {
              en: String(d.en || '').slice(0, MAX_NAME_LEN),
              es: String(d.es || '').slice(0, MAX_NAME_LEN),
            };
            return '';
          }).filter(d => (typeof d === 'string' ? d : (d.en || d.es)))
        : [],
      video_url: String(body.videoUrl || '').trim().slice(0, 500),
    };

    const { error } = await supabase.from('tax_products').insert(row);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.product', entityId: id, action: 'create',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { slug: rawSlug, category },
      });
    } catch (_e) {}

    res.json({ ok: true, id, slug: rawSlug });
  });

  router.put('/admin/products/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_services'))) return;
    const productId = trim(req.params.id, 200);
    const body = req.body || {};

    // Pull current row so we can confirm community scope before write.
    const { data: cur, error: cErr } = await supabase.from('tax_products')
      .select('id, community_id').eq('id', productId).maybeSingle();
    if (cErr) return sendSupabaseError(res, cErr);
    if (!cur) return res.status(404).json({ error: 'Product not found.' });

    const update = { updated_at: new Date().toISOString() };
    if (body.nameI18n && typeof body.nameI18n === 'object') {
      update.name_i18n = {
        en: String(body.nameI18n.en || '').slice(0, MAX_NAME_LEN),
        es: String(body.nameI18n.es || '').slice(0, MAX_NAME_LEN),
      };
    }
    if (body.descriptionI18n && typeof body.descriptionI18n === 'object') {
      update.description_i18n = {
        en: String(body.descriptionI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.descriptionI18n.es || '').slice(0, MAX_TEXT_LEN),
      };
    }
    if (body.longDescriptionI18n && typeof body.longDescriptionI18n === 'object') {
      update.long_description_i18n = {
        en: String(body.longDescriptionI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.longDescriptionI18n.es || '').slice(0, MAX_TEXT_LEN),
      };
    }
    if (Array.isArray(body.requiredDocuments)) {
      // Each entry is either a string (single-language label) or a
      // localized object {en, es}. Cap each entry length and total count.
      update.required_documents = body.requiredDocuments.slice(0, 30).map(d => {
        if (typeof d === 'string') return String(d).slice(0, MAX_NAME_LEN);
        if (d && typeof d === 'object') {
          return {
            en: String(d.en || '').slice(0, MAX_NAME_LEN),
            es: String(d.es || '').slice(0, MAX_NAME_LEN),
          };
        }
        return '';
      }).filter(d => (typeof d === 'string' ? d : (d.en || d.es)));
    }
    if (body.enabled !== undefined) update.enabled = !!body.enabled;
    if (body.videoUrl !== undefined) {
      update.video_url = String(body.videoUrl || '').trim().slice(0, 500);
    }
    if (body.cadenceKind !== undefined) {
      const allowed = ['none','weekly','monthly','quarterly','annual'];
      const k = String(body.cadenceKind || 'none');
      update.cadence_kind = allowed.includes(k) ? k : 'none';
    }
    if (body.anchorRule !== undefined) {
      update.anchor_rule = (body.anchorRule && typeof body.anchorRule === 'object')
        ? body.anchorRule : {};
    }
    if (body.employeeNotesI18n && typeof body.employeeNotesI18n === 'object') {
      update.employee_notes_i18n = {
        en: String(body.employeeNotesI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.employeeNotesI18n.es || '').slice(0, MAX_TEXT_LEN),
      };
    }
    if (body.displayOrder !== undefined) {
      const n = Number(body.displayOrder);
      if (!Number.isNaN(n)) update.display_order = Math.max(0, Math.min(10000, Math.round(n)));
    }

    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error } = await supabase.from('tax_products').update(update).eq('id', productId);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.product', entityId: productId, action: 'update',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}

    res.json({ ok: true });
  });

  // ── GET /admin/products/:id/auto-tasks ──────────────────────────────────
  // List the recurring auto-tasks owned by a service. One service can
  // have many — a Bookkeeping engagement might have a monthly
  // reconciliation + quarterly P&L + annual close, each its own
  // row. Generator walks every active row when a customer is tagged.
  router.get('/admin/products/:id/auto-tasks', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_services'))) return;
    const productId = trim(req.params.id, 200);
    const { data: prod } = await supabase.from('tax_products')
      .select('id, community_id').eq('id', productId).maybeSingle();
    if (!prod) return res.status(404).json({ error: 'Product not found.' });
    const { data, error } = await supabase.from('tax_service_auto_tasks')
      .select('id, community_id, product_id, title_i18n, description_i18n, cadence_kind, anchor_rule, default_priority, default_assignee_employee_id, display_order, active')
      .eq('product_id', productId)
      .order('display_order', { ascending: true });
    if (error) return sendSupabaseError(res, error);
    res.json({ autoTasks: data || [] });
  });

  // ── PUT /admin/products/:id/auto-tasks ──────────────────────────────────
  // Bulk-replace the auto-tasks for one service. Body:
  //   { autoTasks: [
  //       { id?, titleI18n, descriptionI18n, cadenceKind, anchorRule,
  //         defaultPriority, displayOrder, active },
  //       ...
  //   ] }
  // Rows with an `id` matching an existing row are UPDATEd; rows
  // without are INSERTed; existing rows not present in the payload
  // are DELETEd. Each delete is FK-safe because tax_tasks
  // .service_auto_task_id is ON DELETE SET NULL.
  router.put('/admin/products/:id/auto-tasks', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_services'))) return;
    const productId = trim(req.params.id, 200);
    const { data: prod } = await supabase.from('tax_products')
      .select('id, community_id').eq('id', productId).maybeSingle();
    if (!prod) return res.status(404).json({ error: 'Product not found.' });

    const incoming = Array.isArray(req.body?.autoTasks) ? req.body.autoTasks : [];
    const ALLOWED_CADENCE = new Set(['none','weekly','monthly','quarterly','annual']);
    const ALLOWED_PRIORITY = new Set(['urgent','high','normal','low']);
    const sanitized = incoming.map((row, i) => {
      const cadence = ALLOWED_CADENCE.has(row.cadenceKind) ? row.cadenceKind : 'monthly';
      const priority = ALLOWED_PRIORITY.has(row.defaultPriority) ? row.defaultPriority : 'normal';
      return {
        idIfExisting: typeof row.id === 'string' && row.id ? row.id : null,
        title_i18n: {
          en: String(row.titleI18n?.en || '').slice(0, MAX_NAME_LEN),
          es: String(row.titleI18n?.es || '').slice(0, MAX_NAME_LEN),
        },
        description_i18n: {
          en: String(row.descriptionI18n?.en || '').slice(0, MAX_TEXT_LEN),
          es: String(row.descriptionI18n?.es || '').slice(0, MAX_TEXT_LEN),
        },
        cadence_kind: cadence,
        anchor_rule: (row.anchorRule && typeof row.anchorRule === 'object') ? row.anchorRule : {},
        default_priority: priority,
        default_assignee_employee_id:
          row.defaultAssigneeEmployeeId
            ? trim(row.defaultAssigneeEmployeeId, 200) || null
            : null,
        display_order: Number.isFinite(Number(row.displayOrder))
          ? Math.max(0, Math.min(10000, Math.round(Number(row.displayOrder))))
          : (i + 1) * 10,
        active: row.active === false ? false : true,
      };
    });
    // Drop rows whose titles are entirely empty — likely placeholders
    // the owner added then abandoned.
    const valid = sanitized.filter(r => r.title_i18n.en || r.title_i18n.es);

    const { data: existing } = await supabase.from('tax_service_auto_tasks')
      .select('id').eq('product_id', productId);
    const existingIds = new Set((existing || []).map(r => r.id));
    const keepIds = new Set();
    const inserts = [];
    const updates = [];
    for (const row of valid) {
      const { idIfExisting, ...rest } = row;
      if (idIfExisting && existingIds.has(idIfExisting)) {
        keepIds.add(idIfExisting);
        updates.push({ id: idIfExisting, ...rest, updated_at: new Date().toISOString() });
      } else {
        inserts.push({
          id: 'sat_' + uuidv4().slice(0, 16),
          community_id: prod.community_id,
          product_id: productId,
          ...rest,
        });
      }
    }
    const removeIds = Array.from(existingIds).filter(id => !keepIds.has(id));

    // Apply changes. Each statement is independent so a partial
    // failure surfaces clearly. Updates run first so the owner
    // doesn't lose history if an insert errors.
    for (const u of updates) {
      const { error } = await supabase.from('tax_service_auto_tasks')
        .update(u).eq('id', u.id);
      if (error) return sendSupabaseError(res, error);
    }
    if (inserts.length) {
      const { error } = await supabase.from('tax_service_auto_tasks').insert(inserts);
      if (error) return sendSupabaseError(res, error);
    }
    // When an owner deletes auto-tasks, also drop any open customer
    // tasks that the generator created for them. Completed tasks
    // (completed_at set) survive so the work-done history isn't lost,
    // but everything else for the removed auto-task goes — otherwise
    // those rows would just hang on the board pointing at a template
    // that no longer exists.
    let autoTaskTasksDeleted = 0;
    if (removeIds.length) {
      try {
        const { data: openRows } = await supabase.from('tax_tasks')
          .select('id')
          .in('service_auto_task_id', removeIds)
          .is('completed_at', null)
          .is('archived_at', null);
        const dropIds = (openRows || []).map(r => r.id);
        if (dropIds.length) {
          const { error: delErr } = await supabase.from('tax_tasks')
            .delete().in('id', dropIds);
          if (delErr) {
            warn('[tax-auto-tasks-replace] open task delete failed', delErr.message);
          } else {
            autoTaskTasksDeleted = dropIds.length;
          }
        }
      } catch (e) {
        warn('[tax-auto-tasks-replace] open task cleanup failed', e?.message || e);
      }
      const { error } = await supabase.from('tax_service_auto_tasks')
        .delete().in('id', removeIds);
      if (error) return sendSupabaseError(res, error);
    }

    // Fan out task generation to every customer currently tagged
    // with this service so a freshly-added auto-task immediately
    // produces tasks (otherwise the owner has to wait for the daily
    // cron, which feels broken). Idempotent — existing periods are
    // no-ops, only the new auto-task's periods show up.
    let tasksCreated = 0;
    try {
      const { data: tagged } = await supabase.from('tax_customer_services')
        .select('customer_id').eq('product_id', productId).eq('active', true);
      const actorEmail = trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase();
      for (const row of tagged || []) {
        try {
          const r = await generateTasksForService({
            customerId: row.customer_id, productId, actorEmail,
          });
          tasksCreated += r.created || 0;
        } catch (e) {
          warn('[tax-auto-tasks-replace] fanout gen failed', e?.message || e);
        }
      }
    } catch (e) {
      warn('[tax-auto-tasks-replace] fanout query failed', e?.message || e);
    }

    try {
      await auditLog({
        entity: 'tax.product', entityId: productId, action: 'auto_tasks_replace',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { updated: updates.length, inserted: inserts.length, deleted: removeIds.length, tasksCreated, openTasksDeleted: autoTaskTasksDeleted },
      });
    } catch (_e) {}

    const { data: fresh } = await supabase.from('tax_service_auto_tasks')
      .select('id, community_id, product_id, title_i18n, description_i18n, cadence_kind, anchor_rule, default_priority, default_assignee_employee_id, display_order, active')
      .eq('product_id', productId)
      .order('display_order', { ascending: true });
    res.json({ ok: true, autoTasks: fresh || [], tasksCreated, openTasksDeleted: autoTaskTasksDeleted });
  });

  // ── DELETE /admin/products/:id ──────────────────────────────────────────
  // Hard-delete a product. The FKs from tax_filing_schedules and
  // tax_subscriptions both cascade, so removing a product silently
  // wipes customer subscriptions — we refuse the delete when any
  // subscription references the product unless `force=1` is passed,
  // and surface counts so the owner can decide. Filing schedules
  // alone cascade-delete (they're cheap to recreate from the workflow
  // editor). Past leads with this product_slug stay intact because
  // tax_leads.product_slug is a plain text column, not an FK.
  //
  // Soft-delete via the Hide toggle (PUT /admin/products/:id with
  // enabled:false) remains the recommended non-destructive option;
  // delete is for catalog rows the owner genuinely never wants back.
  router.delete('/admin/products/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_services'))) return;
    const productId = trim(req.params.id, 200);
    const force = req.query.force === '1' || req.query.force === 'true';

    const { data: cur } = await supabase.from('tax_products')
      .select('id, community_id, slug, name_i18n').eq('id', productId).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Product not found.' });

    const [{ count: subCount }, { count: scheduleCount }, { count: leadCount }] = await Promise.all([
      supabase.from('tax_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId).eq('status', 'active'),
      supabase.from('tax_filing_schedules')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId),
      supabase.from('tax_leads')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', cur.community_id).eq('product_slug', cur.slug),
    ]);

    if (!force && (subCount > 0)) {
      return res.status(409).json({
        error: 'product_in_use',
        message: 'This service has active customer subscriptions. Pass force=1 to delete anyway (their subscriptions will be removed) or hide the service instead.',
        usage: {
          active_subscriptions: subCount || 0,
          filing_schedules:     scheduleCount || 0,
          historical_leads:     leadCount || 0,
        },
      });
    }

    const { error } = await supabase.from('tax_products').delete().eq('id', productId);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.product', entityId: productId, action: 'delete',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        before: { slug: cur.slug, name_i18n: cur.name_i18n },
        after: {
          force,
          cascaded_subscriptions: subCount || 0,
          cascaded_schedules:     scheduleCount || 0,
        },
      });
    } catch (_e) {}

    res.json({
      ok: true,
      cascaded: {
        active_subscriptions: subCount || 0,
        filing_schedules:     scheduleCount || 0,
      },
    });
  });

  // POST /admin/customers/:id/subscriptions — body { productId,
  // activeScheduleSlugs?, status?, startDate? }. Defaults: status='active',
  // active_schedule_slugs=null (= all schedules), reminder_offsets_days &
  // reminder_channels use platform defaults from the column DEFAULTs.
  router.post('/admin/customers/:id/subscriptions', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const body = req.body || {};
    const productId = trim(body.productId, 200);
    if (!productId) return res.status(400).json({ error: 'productId required.' });

    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });
    // Sanity: product must exist in the same community.
    const { data: product } = await supabase.from('tax_products')
      .select('id, community_id').eq('id', productId).maybeSingle();
    if (!product || product.community_id !== cust.community_id) {
      return res.status(400).json({ error: 'Product not available in this community.' });
    }
    // Duplicate guard: tax_subscriptions has unique (customer_id, product_id).
    const { data: existing } = await supabase.from('tax_subscriptions')
      .select('id').eq('customer_id', customerId).eq('product_id', productId).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Customer already has this subscription.' });

    const activeScheduleSlugs = Array.isArray(body.activeScheduleSlugs) && body.activeScheduleSlugs.length
      ? body.activeScheduleSlugs.map(s => String(s).slice(0, 80)) : null;
    const status = (body.status === 'paused' || body.status === 'cancelled') ? body.status : 'active';
    const startDate = trim(body.startDate, 32) || null;

    const id = 'sub_' + uuidv4().slice(0, 16);
    const { error } = await supabase.from('tax_subscriptions').insert({
      id,
      community_id: cust.community_id,
      customer_id: customerId,
      product_id: productId,
      active_schedule_slugs: activeScheduleSlugs,
      status,
      start_date: startDate,
    });
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true, id });
  });

  // PUT /admin/subscriptions/:id — body { status?, activeScheduleSlugs?,
  // reminderOffsetsDays?, reminderChannels?, startDate? }. Each field is
  // optional; only provided ones are updated.
  router.put('/admin/subscriptions/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const subId = trim(req.params.id, 200);
    const body = req.body || {};
    const update = { updated_at: new Date().toISOString() };

    if (body.status !== undefined) {
      const s = String(body.status);
      if (!['active', 'paused', 'cancelled'].includes(s)) {
        return res.status(400).json({ error: 'status must be active|paused|cancelled.' });
      }
      update.status = s;
    }
    if (body.activeScheduleSlugs !== undefined) {
      // null/empty array means "all schedules under this product".
      const arr = Array.isArray(body.activeScheduleSlugs) ? body.activeScheduleSlugs : null;
      update.active_schedule_slugs = (arr && arr.length) ? arr.map(s => String(s).slice(0, 80)) : null;
    }
    if (Array.isArray(body.reminderOffsetsDays)) {
      const ints = body.reminderOffsetsDays
        .map(n => Number(n)).filter(Number.isFinite).map(n => Math.trunc(n))
        .filter(n => n >= -120 && n <= 30);
      if (!ints.length) return res.status(400).json({ error: 'reminderOffsetsDays must contain at least one valid offset.' });
      update.reminder_offsets_days = ints;
    }
    if (Array.isArray(body.reminderChannels)) {
      const channels = body.reminderChannels.map(c => String(c).toLowerCase())
        .filter(c => c === 'email' || c === 'in_app');
      if (!channels.length) return res.status(400).json({ error: 'reminderChannels must include at least one channel.' });
      update.reminder_channels = ['email', 'in_app'].filter(c => channels.includes(c));
    }
    if (body.startDate !== undefined) {
      update.start_date = trim(body.startDate, 32) || null;
    }

    // Phase 4g: customInfoChecklist
    //   null / empty array → clear the override (revert to schedule default)
    //   array of items     → store the override; each item is shape-normalized
    if (body.customInfoChecklist !== undefined) {
      if (body.customInfoChecklist === null) {
        update.custom_info_checklist = null;
      } else if (!Array.isArray(body.customInfoChecklist)) {
        return res.status(400).json({ error: 'customInfoChecklist must be an array or null.' });
      } else {
        const items = [];
        const seen = new Set();
        for (const raw of body.customInfoChecklist) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const key = trim(raw.key, 80).toLowerCase().replace(/[^a-z0-9_]/g, '_');
          if (!key) continue;
          if (seen.has(key)) {
            return res.status(400).json({ error: `customInfoChecklist contains a duplicate key: ${key}` });
          }
          seen.add(key);
          const type = ['currency', 'number', 'text'].includes(raw.type) ? raw.type : 'text';
          const required = Boolean(raw.required);
          const label_i18n = {};
          const en = typeof raw.label_i18n?.en === 'string' ? raw.label_i18n.en.trim().slice(0, 240) : '';
          const es = typeof raw.label_i18n?.es === 'string' ? raw.label_i18n.es.trim().slice(0, 240) : '';
          if (en) label_i18n.en = en;
          if (es) label_i18n.es = es;
          if (!label_i18n.en && !label_i18n.es) {
            return res.status(400).json({ error: `customInfoChecklist item "${key}" needs a label in at least one language.` });
          }
          items.push({ key, type, required, label_i18n });
        }
        // Empty array after filtering → treat as clear.
        update.custom_info_checklist = items.length ? items : null;
      }
    }

    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error } = await supabase.from('tax_subscriptions').update(update).eq('id', subId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // DELETE /admin/subscriptions/:id — soft cancel via status='cancelled'.
  // Hard delete would cascade-delete filing_periods which we want to keep
  // for the audit trail. If the owner truly needs to purge a subscription,
  // they can do it via SQL.
  router.delete('/admin/subscriptions/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const subId = trim(req.params.id, 200);
    const { error } = await supabase.from('tax_subscriptions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', subId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // GET /admin/leads?communitySlug=&status= — lead inbox.
  // Status values come from the schema check constraint:
  //   new | contacted | converted | closed
  router.get('/admin/leads', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    let q = supabase.from('tax_leads')
      .select('id, name, first_name, middle_name, last_name, email, phone, whatsapp, company, customer_type, product_slug, product_slugs, message, preferred_locale, status, notes, contacted_at, converted_customer_id, close_reason, close_reason_note, closed_at, created_at')
      .eq('community_id', communitySlug)
      .order('created_at', { ascending: false }).limit(500);
    const statusFilter = trim(req.query.status, 40);
    if (statusFilter) q = q.eq('status', statusFilter);
    const ctNorm = String(req.query.customerType || '').toLowerCase().trim();
    if (ctNorm === 'business' || ctNorm === 'individual') q = q.eq('customer_type', ctNorm);
    // Optional business-name fragment filter, surfaces when the
    // owner picks "Business" in the inbox and wants to narrow to a
    // specific company without typing the full string.
    const bizName = trim(req.query.businessName, 200);
    if (bizName) q = q.ilike('company', `%${bizName.replace(/[%_]/g, ' ')}%`);
    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ leads: data || [] });
  });

  // PUT /admin/leads/:id — body { status?, notes? }. Setting status to
  // 'contacted' for the first time stamps contacted_at; transitioning to
  // any other status leaves the existing stamp in place.
  router.put('/admin/leads/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_leads'))) return;
    const leadId = trim(req.params.id, 200);
    const body = req.body || {};
    const update = { updated_at: new Date().toISOString() };

    if (body.status !== undefined) {
      const s = String(body.status);
      if (!['new', 'contacted', 'converted', 'closed'].includes(s)) {
        return res.status(400).json({ error: 'status must be new|contacted|converted|closed.' });
      }
      update.status = s;
      if (s === 'contacted') {
        // Only stamp the first transition to contacted; preserve later edits.
        const { data: cur } = await supabase.from('tax_leads')
          .select('contacted_at').eq('id', leadId).maybeSingle();
        if (cur && !cur.contacted_at) update.contacted_at = new Date().toISOString();
      }
      if (s === 'closed') {
        update.closed_at = new Date().toISOString();
        // Close-reason fields are required by the simplified flow but the
        // server is permissive: an empty string falls through so admins
        // can clear a stale reason if they re-close a lead.
        if (body.closeReason !== undefined) {
          update.close_reason = trim(body.closeReason, 80);
        }
        if (body.closeReasonNote !== undefined) {
          update.close_reason_note = trim(body.closeReasonNote, MAX_TEXT_LEN);
        }
      } else {
        // Re-opening or converting clears the close-reason fields so a
        // stale "not interested" doesn't follow a customer around.
        update.close_reason = '';
        update.close_reason_note = '';
        update.closed_at = null;
      }
    } else {
      if (body.closeReason !== undefined) {
        update.close_reason = trim(body.closeReason, 80);
      }
      if (body.closeReasonNote !== undefined) {
        update.close_reason_note = trim(body.closeReasonNote, MAX_TEXT_LEN);
      }
    }
    if (body.notes !== undefined) update.notes = trim(body.notes, MAX_TEXT_LEN);

    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    const { error } = await supabase.from('tax_leads').update(update).eq('id', leadId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── POST /admin/leads/:id/convert ────────────────────────────────────────
  // Convert a lead into a customer in one click. Copies the lead's identity
  // (name parts, email, phone, locale) into a new tax_customers row, drops
  // the message + interested services into the customer's notes so the
  // owner can review intent, marks the lead status='converted', and links
  // the new customer back via converted_customer_id for the leads list.
  //
  // Idempotency: if a customer with the same email already exists in this
  // community, we re-link the lead to that customer instead of erroring.
  router.post('/admin/leads/:id/convert', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_leads'))) return;
    const leadId = trim(req.params.id, 200);

    const { data: lead, error: lErr } = await supabase.from('tax_leads')
      .select('id, community_id, name, first_name, middle_name, last_name, email, phone, whatsapp, company, customer_type, product_slugs, product_slug, message, preferred_locale, status, converted_customer_id')
      .eq('id', leadId).maybeSingle();
    if (lErr) return sendSupabaseError(res, lErr);
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    const email = String(lead.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Lead has no email to convert.' });

    const { data: existing } = await supabase.from('tax_customers')
      .select('id, email')
      .eq('community_id', lead.community_id).eq('email', email).maybeSingle();

    let customerId;
    let isExistingCustomer = false;

    if (existing) {
      customerId = existing.id;
      isExistingCustomer = true;
    } else {
      // Compose parts from whichever shape the lead has — older rows may
      // only have `name` populated until the boot backfill runs.
      const parts = (lead.first_name || lead.middle_name || lead.last_name)
        ? normalizeNameParts({ first: lead.first_name, middle: lead.middle_name, last: lead.last_name })
        : normalizeNameParts(parsePersonName(lead.name));
      const name = [parts.first, parts.middle, parts.last].filter(Boolean).join(' ');

      // Carry the lead's intent into the customer's notes field so the
      // owner has the context handy on the new customer's detail page.
      const services = Array.isArray(lead.product_slugs) && lead.product_slugs.length
        ? lead.product_slugs.join(', ')
        : (lead.product_slug || '');
      const noteLines = [
        `Converted from lead ${lead.id}`,
        services ? `Interested in: ${services}` : '',
        lead.message ? `Original message:\n${lead.message}` : '',
      ].filter(Boolean);

      customerId = 'cust_' + uuidv4().slice(0, 16);
      const { error: insErr } = await supabase.from('tax_customers').insert({
        id: customerId,
        community_id: lead.community_id,
        email,
        name, first_name: parts.first, middle_name: parts.middle, last_name: parts.last,
        phone: lead.phone || '',
        whatsapp: lead.whatsapp || '',
        business_name: lead.company || '',
        customer_type: lead.customer_type === 'business' ? 'business' : 'individual',
        locale: lead.preferred_locale === 'en' ? 'en' : 'es',
        status: 'active',
        notes: noteLines.join('\n\n').slice(0, MAX_TEXT_LEN),
      });
      if (insErr) return sendSupabaseError(res, insErr);
    }

    // Phase 4n.44: optionally attach relationships at conversion
    // time. The new Convert dialog pre-fills the picker from the
    // lead's product_slugs, so by the time we land here the owner
    // has confirmed which services this customer is signing up for.
    // Each successful relationship insert kicks off task generation
    // for that (customer, relationship_type) so the team has work
    // queued the moment the convert succeeds.
    // Phase 4n.48: prefer direct productIds. Fall back to the old
    // relationshipTypeIds shape if a stale client sends it (resolve
    // each relationship to its linked product).
    let requestedProductIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds.map(s => String(s)).filter(Boolean) : [];
    if (!requestedProductIds.length && Array.isArray(req.body?.relationshipTypeIds)) {
      const relIds = req.body.relationshipTypeIds.map(s => String(s)).filter(Boolean);
      if (relIds.length) {
        const { data: rt } = await supabase.from('tax_relationship_types')
          .select('id, product_id').in('id', relIds);
        requestedProductIds = (rt || []).map(r => r.product_id).filter(Boolean);
      }
    }
    if (requestedProductIds.length === 0) {
      return res.status(400).json({ error: 'service_required',
        message: 'Pick at least one service so the customer\'s tasks can be generated.' });
    }
    let servicesAdded = 0;
    let tasksCreated = 0;
    if (requestedProductIds.length) {
      const { data: prods } = await supabase.from('tax_products')
        .select('id, community_id').eq('community_id', lead.community_id)
        .in('id', requestedProductIds);
      const validIds = (prods || []).map(p => p.id);
      if (validIds.length) {
        const rows = validIds.map(pid => ({
          id: 'ccs_' + uuidv4().slice(0, 16),
          community_id: lead.community_id,
          customer_id: customerId,
          product_id: pid,
          created_by_email: trim(req.get('x-admin-email') || '', 200).toLowerCase() || 'lead_convert',
          active: true,
        }));
        const { error: linkErr } = await supabase.from('tax_customer_services').upsert(rows, {
          onConflict: 'customer_id,product_id',
        });
        if (!linkErr) {
          servicesAdded = validIds.length;
          for (const pid of validIds) {
            try {
              const r = await generateTasksForService({
                customerId, productId: pid, actorEmail: 'lead_convert',
              });
              tasksCreated += r.created || 0;
            } catch (e) { warn('[tax-lead-convert] task gen failed', e?.message || e); }
          }
        }
      }
    }
    // Keep response field for legacy client compat — relationshipsAdded
    // now == servicesAdded (the practical thing both sides care about).
    const relationshipsAdded = servicesAdded;

    const { error: updErr } = await supabase.from('tax_leads').update({
      status: 'converted',
      converted_customer_id: customerId,
      updated_at: new Date().toISOString(),
    }).eq('id', leadId);
    if (updErr) return sendSupabaseError(res, updErr);

    try {
      await auditLog({
        entity: 'tax.lead', entityId: leadId, action: 'convert',
        actorEmail: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase(),
        after: { customerId, isExistingCustomer, relationshipsAdded, tasksCreated },
      });
    } catch (_e) {}

    res.json({ ok: true, customerId, isExistingCustomer, relationshipsAdded, tasksCreated });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 2a: customer portal endpoints
  //
  // Auth approach for Phase 2a: the frontend signs in via Firebase (Google or
  // email/password), then sends `x-firebase-uid`, `x-firebase-email`, and
  // `x-tax-community` headers on every portal request. The middleware below
  // validates these against `tax_customers`. This matches the existing
  // platform pattern (server trusts the frontend-asserted identity).
  //
  // SECURITY NOTE: Tax data is more sensitive than the Airbnb listings the
  // existing platform handles. Before exposing this portal beyond a trusted
  // pilot, harden the middleware to verify the Firebase ID token signature
  // against Google's JWKS (firebase-admin SDK or hand-rolled JOSE). The
  // function shape stays the same; only the implementation hardens.
  // ────────────────────────────────────────────────────────────────────────────

  // Phase 4n.18: a user who has only a tax_employees row in this community
  // (or only a tax_customers row, when hitting /employee) used to see
  // "Account not provisioned" — opaque and dead-ended. Now we detect the
  // mismatch and return a `wrong_portal` payload that the client renders
  // as "Sign in at the staff portal instead" with a redirect button.
  async function detectCrossPortalRedirect({ email, communitySlug, currentType }) {
    if (!email || !communitySlug) return null;
    try {
      if (currentType === 'customer') {
        const { data: emp } = await supabase.from('tax_employees')
          .select('id, status').eq('email', email).eq('community_id', communitySlug).maybeSingle();
        if (emp && emp.status !== 'archived') {
          return { type: 'employee', redirectTo: `/tax/${communitySlug}/employee` };
        }
      } else if (currentType === 'employee') {
        const { data: cust } = await supabase.from('tax_customers')
          .select('id, status').eq('email', email).eq('community_id', communitySlug).maybeSingle();
        if (cust && cust.status !== 'archived') {
          return { type: 'customer', redirectTo: `/tax/${communitySlug}/portal` };
        }
      }
    } catch (_e) { /* fall through — caller still returns the 403 */ }
    return null;
  }

  async function requireTaxCustomer(req, res) {
    if (!requireSupabaseEnv(res)) return null;

    // Impersonation path: if the admin has an active session targeting a
    // customer, the session token replaces Firebase auth. The middleware
    // resolves the target customer and stamps req.impersonation so
    // downstream handlers can attribute actions to the real admin.
    const imp = await loadImpersonationFromRequest(req, res, 'customer');
    if (imp === false) return null;            // invalid/expired token, 401 already sent
    if (imp) {
      const { data: customer, error } = await supabase.from('tax_customers')
        .select('id, community_id, email, name, business_name, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, status, firebase_uid, last_sign_in_at')
        .eq('id', imp.target_id).maybeSingle();
      if (error) { sendSupabaseError(res, error); return null; }
      if (!customer) { res.status(404).json({ error: 'Impersonation target not found.' }); return null; }
      req.impersonation = imp;
      return customer;
    }

    // Normal Firebase auth path.
    const uid = trim(req.get('x-firebase-uid') || '', 200);
    const email = trim(req.get('x-firebase-email') || '', 200).toLowerCase();
    const communitySlug = trim(req.get('x-tax-community') || '', 200);
    if (!uid || !email || !communitySlug) {
      res.status(401).json({ error: 'Authentication required.' });
      return null;
    }
    const { data: customer, error } = await supabase.from('tax_customers')
      .select('id, community_id, email, name, business_name, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, status, firebase_uid, last_sign_in_at')
      .eq('email', email).eq('community_id', communitySlug).maybeSingle();
    if (error) { sendSupabaseError(res, error); return null; }
    if (!customer) {
      const redirect = await detectCrossPortalRedirect({ email, communitySlug, currentType: 'customer' });
      if (redirect) {
        res.status(403).json({
          error: 'wrong_portal',
          message: 'You have a staff account at this practice. Sign in at the staff portal instead.',
          redirectTo: redirect.redirectTo,
          accountType: redirect.type,
        });
      } else {
        res.status(403).json({ error: 'Account not provisioned. Contact your tax practice.' });
      }
      return null;
    }
    if (customer.status !== 'active') {
      res.status(403).json({ error: 'Account is not active.' });
      return null;
    }
    if (customer.firebase_uid && customer.firebase_uid !== uid) {
      res.status(403).json({ error: 'Account collision. Contact your tax practice.' });
      return null;
    }
    // Portal toggle: when the community has disabled the customer portal,
    // every portal endpoint refuses with portal_disabled. The frontend
    // catches this and bounces to the landing page.
    const { data: portalComm } = await supabase.from('communities')
      .select('tax_customer_portal_enabled')
      .eq('id', communitySlug).maybeSingle();
    if (!portalComm?.tax_customer_portal_enabled) {
      res.status(403).json({
        error: 'portal_disabled',
        message: 'The customer portal is currently disabled. Contact your tax practice for next steps.',
      });
      return null;
    }
    return customer;
  }

  // ── POST /auth/link ────────────────────────────────────────────────────────
  // On first portal sign-in, links the Firebase UID to the existing
  // tax_customers row identified by (community_slug, email). Idempotent.
  router.post('/auth/link', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const body = req.body || {};
    const uid = trim(body.uid, 200);
    const email = trim(body.email, 200).toLowerCase();
    const communitySlug = trim(body.communitySlug, 200);
    if (!uid || !email || !communitySlug) {
      return res.status(400).json({ error: 'uid, email, and communitySlug required.' });
    }
    const { data: customer, error } = await supabase.from('tax_customers')
      .select('id, community_id, email, name, locale, status, firebase_uid')
      .eq('email', email).eq('community_id', communitySlug).maybeSingle();
    if (error) return sendSupabaseError(res, error);
    if (!customer) {
      const redirect = await detectCrossPortalRedirect({ email, communitySlug, currentType: 'customer' });
      if (redirect) {
        return res.status(403).json({
          error: 'wrong_portal',
          message: 'You have a staff account at this practice. Sign in at the staff portal instead.',
          redirectTo: redirect.redirectTo,
          accountType: redirect.type,
        });
      }
      return res.status(403).json({ error: 'Account not provisioned. Contact your tax practice.' });
    }
    if (customer.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active. Contact your tax practice.' });
    }
    if (customer.firebase_uid && customer.firebase_uid !== uid) {
      return res.status(403).json({ error: 'Account collision. Contact your tax practice.' });
    }
    if (!customer.firebase_uid) {
      const { error: uErr } = await supabase.from('tax_customers')
        .update({ firebase_uid: uid, updated_at: new Date().toISOString() })
        .eq('id', customer.id);
      if (uErr) return sendSupabaseError(res, uErr);
      try {
        await auditLog({
          entity: 'tax.customer', entityId: customer.id,
          action: 'link_firebase', actorEmail: email, actorName: customer.name,
          after: { firebaseUidLinked: true },
        });
      } catch (_e) {}
    }
    res.json({ ok: true, customer: { ...customer, firebase_uid: uid } });
  });

  // ── GET /portal/me ──
  router.get('/portal/me', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    stampLastSignIn('tax_customers', customer.id, customer.last_sign_in_at);
    const [{ data: community }, { data: subs }, { data: rels }, { data: companion }] = await Promise.all([
      supabase.from('communities')
        .select('id, name, logo_url, brand_primary_color, brand_secondary_color, default_locale, tax_allow_customer_notif_pref_change, tax_customer_documents_enabled, tax_customer_portal_enabled, tax_customer_reminders_enabled, tax_task_lookahead_months, tax_task_urgent_days, tax_task_soon_days, tax_task_upcoming_days, tax_task_priority_colors, tax_task_urgency_colors, contact_email, phone')
        .eq('id', customer.community_id).maybeSingle(),
      supabase.from('tax_subscriptions')
        .select('id, product_id, status, reminder_channels, reminder_offsets_days')
        .eq('customer_id', customer.id),
      supabase.from('tax_customer_relationships')
        .select(`
          id, relationship_type_id, active, created_at,
          type:tax_relationship_types ( id, category, slug, name_i18n, display_order )
        `)
        .eq('customer_id', customer.id).eq('active', true),
      // Companion check: does the same email also exist as an active
      // tax_employees row in this community? When yes, the portal nav
      // surfaces a "Switch to staff view" link so the owner/staff member
      // doesn't have to memorize the /employee URL.
      supabase.from('tax_employees')
        .select('id, role').eq('community_id', customer.community_id)
        .eq('email', customer.email).eq('status', 'active').maybeSingle(),
    ]);
    const allChannels = uniqueChannels(subs);
    res.json({
      customer: pickCustomer(customer),
      community,
      preferences: {
        channels: allChannels,
        allowChange: Boolean(community?.tax_allow_customer_notif_pref_change),
      },
      relationships: rels || [],
      staffAccess: companion
        ? { hasEmployeeRow: true, role: companion.role }
        : { hasEmployeeRow: false, role: null },
    });
  });

  // ── GET /portal/filings ──
  router.get('/portal/filings', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    // Phase 4n.6: include the workflow rule + relationship type so the
    // dashboard can prefer the owner's editable name/description when set,
    // group by relationship, and show which relationship drove each item.
    const { data, error } = await supabase.from('tax_filing_periods')
      .select(`
        id, period_label, period_start, period_end, due_date, status, info_received_at, filed_at,
        workflow_rule_id, relationship_type_id,
        schedule:tax_filing_schedules ( id, slug, jurisdiction, cadence, name_i18n, description_i18n ),
        workflow:tax_relationship_workflow_rules ( id, filing_schedule_slug, cadence, name_i18n, description_i18n, info_checklist ),
        relationship:tax_relationship_types ( id, slug, category, name_i18n )
      `)
      .eq('customer_id', customer.id)
      .order('due_date', { ascending: true })
      .limit(100);
    if (error) return sendSupabaseError(res, error);
    res.json({ filings: data || [] });
  });

  // ── GET /portal/filings/:id ──
  router.get('/portal/filings/:id', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const id = trim(req.params.id, 200);
    const { data: period, error } = await supabase.from('tax_filing_periods')
      .select('id, community_id, subscription_id, schedule_id, workflow_rule_id, customer_id, status, period_label, period_start, period_end, due_date, info_received_at, filed_at')
      .eq('id', id).maybeSingle();
    if (error) return sendSupabaseError(res, error);
    if (!period || period.customer_id !== customer.id) {
      return res.status(404).json({ error: 'Filing not found.' });
    }
    // Phase 4n.6 / 4n.8: precedence is
    //   per-customer override → subscription override → workflow rule →
    //   schedule default.
    const [{ data: rule }, { data: schedule }, { data: subscription }, { data: custOverride }] = await Promise.all([
      period.workflow_rule_id
        ? supabase.from('tax_relationship_workflow_rules')
            .select('id, filing_schedule_slug, cadence, info_checklist, name_i18n, description_i18n')
            .eq('id', period.workflow_rule_id).maybeSingle()
        : Promise.resolve({ data: null }),
      period.schedule_id
        ? supabase.from('tax_filing_schedules')
            .select('id, slug, jurisdiction, cadence, info_checklist, name_i18n, description_i18n')
            .eq('id', period.schedule_id).maybeSingle()
        : Promise.resolve({ data: null }),
      period.subscription_id
        ? supabase.from('tax_subscriptions').select('id, custom_info_checklist').eq('id', period.subscription_id).maybeSingle()
        : Promise.resolve({ data: null }),
      period.workflow_rule_id
        ? supabase.from('tax_customer_workflow_overrides')
            .select('custom_info_checklist')
            .eq('customer_id', period.customer_id)
            .eq('workflow_rule_id', period.workflow_rule_id)
            .eq('active', true).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const overrideChecklist = Array.isArray(custOverride?.custom_info_checklist) && custOverride.custom_info_checklist.length
      ? custOverride.custom_info_checklist : null;
    const ruleChecklist = Array.isArray(rule?.info_checklist) && rule.info_checklist.length ? rule.info_checklist : null;
    const scheduleChecklist = Array.isArray(schedule?.info_checklist) && schedule.info_checklist.length ? schedule.info_checklist : null;
    const checklist = overrideChecklist
      || ((Array.isArray(subscription?.custom_info_checklist) && subscription.custom_info_checklist.length)
        ? subscription.custom_info_checklist
        : (ruleChecklist || scheduleChecklist || []));
    // Build a unified `schedule` shape the frontend already reads.
    const effectiveSchedule = schedule || (rule ? {
      id: rule.id, slug: rule.filing_schedule_slug, cadence: rule.cadence,
      name_i18n: rule.name_i18n || {}, description_i18n: rule.description_i18n || {},
      info_checklist: rule.info_checklist || [],
    } : null);
    res.json({
      period, schedule: effectiveSchedule, checklist,
      alreadyReceived: ['info_received', 'in_prep', 'filed'].includes(period.status),
    });
  });

  // ── POST /portal/filings/:id/respond ──
  router.post('/portal/filings/:id/respond', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const id = trim(req.params.id, 200);
    const body = req.body || {};
    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};
    const notes = trim(body.notes, MAX_TEXT_LEN);

    const { data: period } = await supabase.from('tax_filing_periods')
      .select('id, status, schedule_id, subscription_id, customer_id')
      .eq('id', id).maybeSingle();
    if (!period || period.customer_id !== customer.id) {
      return res.status(404).json({ error: 'Filing not found.' });
    }
    if (period.status === 'filed') {
      return res.status(409).json({ error: 'This filing has already been completed.' });
    }

    const [{ data: schedule }, { data: subscription }] = await Promise.all([
      supabase.from('tax_filing_schedules').select('info_checklist').eq('id', period.schedule_id).maybeSingle(),
      supabase.from('tax_subscriptions').select('custom_info_checklist').eq('id', period.subscription_id).maybeSingle(),
    ]);
    const checklist = (Array.isArray(subscription?.custom_info_checklist) && subscription.custom_info_checklist.length)
      ? subscription.custom_info_checklist
      : (Array.isArray(schedule?.info_checklist) ? schedule.info_checklist : []);

    const missing = checklist.filter(it => it.required).filter(it => {
      const v = data[it.key];
      return v === undefined || v === null || String(v).trim() === '';
    }).map(it => it.key);
    if (missing.length) return res.status(400).json({ error: 'Missing required fields', missing });

    const respId = 'tresp_' + uuidv4().slice(0, 12);
    const { error: rErr } = await supabase.from('tax_filing_responses').insert({
      id: respId, period_id: period.id, customer_id: customer.id,
      data, notes,
      ip: trim((req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0], 80),
      user_agent: trim(req.get('user-agent') || '', 500),
    });
    if (rErr) return sendSupabaseError(res, rErr);

    await supabase.from('tax_filing_periods').update({
      status: 'info_received',
      info_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', period.id);

    try {
      await auditLog({
        entity: 'tax.filing_response', entityId: respId,
        action: 'create_via_portal', actorEmail: customer.email, actorName: customer.name,
        after: { periodId: period.id },
      });
    } catch (_e) {}
    res.json({ ok: true, id: respId });
  });

  // ── GET /portal/notifications ──
  router.get('/portal/notifications', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const { data, error } = await supabase.from('tax_notifications')
      .select('id, type, title_i18n, body_i18n, payload, read_at, created_at')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return sendSupabaseError(res, error);
    res.json({ notifications: data || [] });
  });

  // ── POST /portal/notifications/:id/read ──
  router.post('/portal/notifications/:id/read', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const id = trim(req.params.id, 200);
    const { error } = await supabase.from('tax_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id).eq('customer_id', customer.id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── PUT /portal/profile ── (Phase 2e)
  // Customer-editable profile fields. Login `email` stays read-only (it's the
  // Firebase auth identity) and goes through /auth/link when a new account
  // links. Everything else here is at the customer's discretion.
  router.put('/portal/profile', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const body = req.body || {};

    const update = { updated_at: new Date().toISOString() };

    const sentName =
      body.firstName !== undefined || body.middleName !== undefined ||
      body.lastName  !== undefined || body.name       !== undefined;
    if (sentName) {
      const np = resolveNamePayload(body);
      update.name = np.name;
      update.first_name = np.first;
      update.middle_name = np.middle;
      update.last_name = np.last;
    }
    if (body.phone !== undefined) {
      update.phone = trim(body.phone, MAX_PHONE_LEN);
    }
    if (body.whatsapp !== undefined) {
      const raw = String(body.whatsapp || '').trim();
      if (raw === '') {
        update.whatsapp = '';
      } else {
        const normalized = normalizeWhatsapp(raw);
        if (!normalized) {
          return res.status(400).json({ error: 'whatsapp_invalid',
            message: 'WhatsApp must be in international format starting with + and country code, e.g., +14155551234.' });
        }
        update.whatsapp = normalized;
      }
    }
    if (body.address !== undefined) {
      update.address = sanitizeAddress(body.address);
    }
    if (body.preferredCommunicationEmail !== undefined) {
      const raw = String(body.preferredCommunicationEmail || '').trim().toLowerCase();
      if (raw === '') {
        update.preferred_communication_email = '';
      } else if (!isValidEmail(raw)) {
        return res.status(400).json({ error: 'preferred_email_invalid',
          message: 'Preferred communication email is not valid.' });
      } else {
        update.preferred_communication_email = raw.slice(0, MAX_NAME_LEN);
      }
    }
    if (body.locale !== undefined) {
      const v = String(body.locale || '').trim().toLowerCase();
      if (v !== 'en' && v !== 'es') {
        return res.status(400).json({ error: 'locale_invalid',
          message: "locale must be 'en' or 'es'." });
      }
      update.locale = v;
    }

    const { error } = await supabase.from('tax_customers')
      .update(update).eq('id', customer.id);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.customer', entityId: customer.id,
        action: 'update_profile', actorEmail: customer.email, actorName: customer.name,
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}

    const { data: refreshed } = await supabase.from('tax_customers')
      .select('id, email, name, business_name, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, status')
      .eq('id', customer.id).maybeSingle();
    res.json({ ok: true, customer: refreshed });
  });

  // ── PUT /portal/preferences ──
  // Updates reminder_channels on ALL of the customer's subscriptions in this
  // community. Refused with 403 when the community lock is on.
  router.put('/portal/preferences', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const { data: community } = await supabase.from('communities')
      .select('tax_allow_customer_notif_pref_change')
      .eq('id', customer.community_id).maybeSingle();
    if (!community?.tax_allow_customer_notif_pref_change) {
      return res.status(403).json({ error: 'Notification preferences are managed by your tax practice.' });
    }
    const channels = (Array.isArray(req.body?.channels) ? req.body.channels : [])
      .map(c => String(c).toLowerCase()).filter(c => c === 'email' || c === 'in_app');
    if (!channels.length) {
      return res.status(400).json({ error: 'Select at least one notification channel.' });
    }
    const { error } = await supabase.from('tax_subscriptions')
      .update({ reminder_channels: channels, updated_at: new Date().toISOString() })
      .eq('customer_id', customer.id);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.customer', entityId: customer.id,
        action: 'update_preferences', actorEmail: customer.email, actorName: customer.name,
        after: { channels },
      });
    } catch (_e) {}
    res.json({ ok: true, channels });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 2b: customer relationships + FAQ tailoring
  //
  // A customer can have many "relationships" with the business (LLC, ITIN,
  // Sales Tax Filing, etc.). The catalog lives in tax_relationship_types and
  // is platform-curated; each type carries default FAQs from public sources,
  // which communities may override or supplement via tax_relationship_faqs.
  // ────────────────────────────────────────────────────────────────────────────

  // ── GET /portal/relationships ── (auth-gated)
  router.get('/portal/relationships', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const { data, error } = await supabase.from('tax_customer_relationships')
      .select(`
        id, relationship_type_id, notes, active, created_at,
        type:tax_relationship_types ( id, category, slug, name_i18n, description_i18n, display_order )
      `)
      .eq('customer_id', customer.id).eq('active', true);
    if (error) return sendSupabaseError(res, error);
    res.json({ relationships: data || [] });
  });

  // ── GET /portal/tips ── (auth-gated)
  // Returns ALL tips (both contexts) for the customer's active relationship
  // types, grouped by relationship type so the dashboard can render them.
  router.get('/portal/tips', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const typeIds = await activeTypeIdsForCustomer(customer.id);
    if (!typeIds.length) return res.json({ groups: [] });
    const [{ data: types }, { data: tips }] = await Promise.all([
      supabase.from('tax_relationship_types')
        .select('id, category, slug, name_i18n, display_order')
        .in('id', typeIds).order('display_order', { ascending: true }),
      supabase.from('tax_relationship_default_tips')
        .select('id, relationship_type_id, context, display_order, tip_i18n, source_note')
        .in('relationship_type_id', typeIds)
        .order('display_order', { ascending: true }),
    ]);
    const byType = new Map();
    for (const t of tips || []) {
      const arr = byType.get(t.relationship_type_id) || [];
      arr.push(t); byType.set(t.relationship_type_id, arr);
    }
    const groups = (types || [])
      .map(t => ({ type: t, tips: byType.get(t.id) || [] }))
      .filter(g => g.tips.length > 0);
    res.json({ groups });
  });

  // ── GET /portal/help ── (Phase 4c, auth-gated)
  // Returns active customer-audience help articles filtered to:
  //   relationship_type_id IS NULL  (general portal-usage articles)
  //   OR relationship_type_id matches one of the customer's active
  //   relationships. Grouped by category for the help-center UI.
  router.get('/portal/help', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const typeIds = await activeTypeIdsForCustomer(customer.id);
    const articles = await loadEffectiveHelp({
      communityId: customer.community_id,
      audience: 'customer',
      customerRelationshipTypeIds: typeIds,
    });
    res.json({ articles });
  });

  // ── GET /portal/faqs ── (auth-gated)
  // Returns effective FAQs (defaults + community overrides + custom additions)
  // for the customer's relationship types only.
  router.get('/portal/faqs', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const data = await loadEffectiveFaqs({
      communityId: customer.community_id,
      filterTypeIds: await activeTypeIdsForCustomer(customer.id),
    });
    res.json(data);
  });

  // ── GET /admin/relationship-types ── (owner admin)
  // Returns platform defaults (community_id IS NULL) UNION community-scoped
  // types for the given community. By default only active rows; passing
  // ?includeInactive=1 returns inactive too (for the manage page).
  router.get('/admin/relationship-types', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    let q = supabase.from('tax_relationship_types')
      .select('id, community_id, category, slug, name_i18n, description_i18n, display_order, active, product_id')
      .order('display_order', { ascending: true });
    if (!includeInactive) q = q.eq('active', true);
    // community_id IS NULL OR community_id = $1
    if (communitySlug) q = q.or(`community_id.is.null,community_id.eq.${communitySlug}`);
    else q = q.is('community_id', null);
    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ types: data || [] });
  });

  // ── POST /admin/relationship-types ──
  // Create a community-scoped relationship type. Owner can pick any of the
  // 4 standard categories. Slug must be unique within the community.
  router.post('/admin/relationship-types', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_services'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const category = trim(body.category, 40);
    const slug = trim(body.slug, 80).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    const nameEn = trim(body.nameEn, 200);
    const nameEs = trim(body.nameEs, 200);
    const descEn = trim(body.descriptionEn, 1000);
    const descEs = trim(body.descriptionEs, 1000);
    const displayOrder = Number.isFinite(Number(body.displayOrder)) ? Math.round(Number(body.displayOrder)) : 500;
    if (!communitySlug || !slug || !category) {
      return res.status(400).json({ error: 'communitySlug, category, slug required.' });
    }
    if (!['business', 'individual', 'general', 'audit'].includes(category)) {
      return res.status(400).json({ error: 'category must be business, individual, general, or audit.' });
    }
    if (!nameEn && !nameEs) {
      return res.status(400).json({ error: 'At least one of nameEn / nameEs is required.' });
    }
    // ID uses the community slug to avoid collisions with platform defaults
    // ('business.llc') and with other communities' custom types.
    const id = `${communitySlug}.${category}.${slug}`.slice(0, 200);

    const { data: existing } = await supabase.from('tax_relationship_types')
      .select('id').eq('id', id).maybeSingle();
    if (existing) return res.status(409).json({ error: 'A service with this category + slug already exists for this community.' });

    const row = {
      id, community_id: communitySlug, category, slug,
      name_i18n: { en: nameEn || nameEs, es: nameEs || nameEn },
      description_i18n: { en: descEn, es: descEs },
      display_order: displayOrder,
      active: true,
    };
    const { error } = await supabase.from('tax_relationship_types').insert(row);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.relationship_type', entityId: id, action: 'create',
        actorEmail: '', after: { community: communitySlug, category, slug },
      });
    } catch (_e) {}
    res.json({ ok: true, type: row });
  });

  // ── PUT /admin/relationship-types/:id ── (community-scoped only)
  router.put('/admin/relationship-types/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_services'))) return;
    const id = trim(req.params.id, 200);
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    if (!id || !communitySlug) return res.status(400).json({ error: 'id and communitySlug required.' });

    const { data: existing } = await supabase.from('tax_relationship_types')
      .select('id, community_id').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Relationship type not found.' });
    // Owners can only edit their own community-scoped types — platform
    // defaults (community_id NULL) are read-only here.
    if (existing.community_id !== communitySlug) {
      return res.status(403).json({ error: 'Platform-default services are read-only.' });
    }

    const update = {};
    if (typeof body.nameEn === 'string' || typeof body.nameEs === 'string') {
      const { data: cur } = await supabase.from('tax_relationship_types')
        .select('name_i18n').eq('id', id).maybeSingle();
      const next = { ...(cur?.name_i18n || {}) };
      if (typeof body.nameEn === 'string') next.en = body.nameEn.slice(0, 200);
      if (typeof body.nameEs === 'string') next.es = body.nameEs.slice(0, 200);
      update.name_i18n = next;
    }
    if (typeof body.descriptionEn === 'string' || typeof body.descriptionEs === 'string') {
      const { data: cur } = await supabase.from('tax_relationship_types')
        .select('description_i18n').eq('id', id).maybeSingle();
      const next = { ...(cur?.description_i18n || {}) };
      if (typeof body.descriptionEn === 'string') next.en = body.descriptionEn.slice(0, 1000);
      if (typeof body.descriptionEs === 'string') next.es = body.descriptionEs.slice(0, 1000);
      update.description_i18n = next;
    }
    if (Number.isFinite(Number(body.displayOrder))) update.display_order = Math.round(Number(body.displayOrder));
    if (typeof body.active === 'boolean') update.active = body.active;
    // Phase 4n.38: link a relationship type to the product that drives
    // its task cadence. Empty string / null clears the link (and the
    // task generator falls back to the legacy workflow-rule path).
    if (body.productId !== undefined) {
      const pid = trim(body.productId || '', 200);
      if (pid) {
        const { data: prod } = await supabase.from('tax_products')
          .select('id, community_id').eq('id', pid).maybeSingle();
        if (!prod) return res.status(404).json({ error: 'Product not found.' });
        if (prod.community_id !== communitySlug) {
          return res.status(403).json({ error: 'Product belongs to a different community.' });
        }
        update.product_id = pid;
      } else {
        update.product_id = null;
      }
    }

    if (!Object.keys(update).length) return res.status(400).json({ error: 'No editable fields supplied.' });
    const { error } = await supabase.from('tax_relationship_types').update(update).eq('id', id);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.relationship_type', entityId: id, action: 'update',
        actorEmail: '', after: { community: communitySlug, changes: Object.keys(update) },
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── Phase 4j: per-relationship workflow rules ────────────────────────────
  // GET  /admin/filing-schedules?communitySlug=...     list this community's schedules
  // GET  /admin/relationship-workflow-rules?communitySlug=...
  // PUT  /admin/relationship-workflow-rules/:relTypeId/:scheduleSlug
  // DELETE /admin/relationship-workflow-rules/:relTypeId/:scheduleSlug
  router.get('/admin/filing-schedules', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { data, error } = await supabase.from('tax_filing_schedules')
      .select('id, slug, product_id, jurisdiction, cadence, anchor_rule, info_checklist, name_i18n, description_i18n, enabled, display_order')
      .eq('community_id', communitySlug)
      .order('display_order', { ascending: true });
    if (error) return sendSupabaseError(res, error);
    res.json({ schedules: data || [] });
  });

  // Phase 4n.3: owner-created filing schedule. Inserts a new row in
  // tax_filing_schedules and (when relationshipTypeId is given) auto-binds
  // a tax_relationship_workflow_rules row so the schedule immediately shows
  // up under that relationship. Cadence + day inputs are folded into the
  // canonical anchor_rule shapes; supported types: weekly_following,
  // monthly_following, quarterly_following, annual.
  router.post('/admin/filing-schedules', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_workflows'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });

    const cadence = String(body.cadence || '').trim();
    if (!['weekly', 'monthly', 'quarterly', 'annual'].includes(cadence)) {
      return res.status(400).json({ error: 'cadence must be weekly|monthly|quarterly|annual.' });
    }
    const nameEn = trim(body.nameEn || '', 200);
    const nameEs = trim(body.nameEs || '', 200);
    if (!nameEn && !nameEs) return res.status(400).json({ error: 'name required (en or es).' });

    // Build the anchor_rule from the user-friendly inputs.
    let anchorRule;
    if (cadence === 'weekly') {
      const dayOfWeek = Math.max(1, Math.min(7, parseInt(body.dayOfWeek, 10) || 5));
      anchorRule = { type: 'weekly_following', dayOfWeek };
    } else if (cadence === 'monthly') {
      const day = Math.max(1, Math.min(28, parseInt(body.dayOfMonth, 10) || 20));
      anchorRule = { type: 'monthly_following', day };
    } else if (cadence === 'quarterly') {
      const day = Math.max(1, Math.min(28, parseInt(body.dayOfMonth, 10) || 15));
      anchorRule = { type: 'quarterly_following', day };
    } else {
      // annual — expect a MM-DD string or use 12-31 default.
      const date = String(body.date || '12-31').trim();
      if (!/^\d{1,2}-\d{1,2}$/.test(date)) return res.status(400).json({ error: 'date must be MM-DD for annual cadence.' });
      anchorRule = { type: 'annual', date };
    }

    // Each schedule needs a product. Find or create a 'custom-workflows'
    // product for this community so owners don't have to manage a separate
    // service catalog for free-form schedules.
    let productId = trim(body.productId || '', 200);
    if (!productId) {
      const customSlug = 'custom-workflows';
      const { data: existingProd } = await supabase.from('tax_products')
        .select('id').eq('community_id', communitySlug).eq('slug', customSlug).maybeSingle();
      if (existingProd) {
        productId = existingProd.id;
      } else {
        productId = `tp_${communitySlug}_${customSlug}`.slice(0, 200);
        const { error: prodErr } = await supabase.from('tax_products').insert({
          id: productId, community_id: communitySlug, slug: customSlug,
          category: 'custom', display_order: 900,
          name_i18n: { en: 'Custom workflows', es: 'Flujos personalizados' },
          description_i18n: { en: 'Owner-defined filing schedules.', es: 'Calendarios de declaraciones definidos por el dueño.' },
          icon: '',
        });
        if (prodErr) return sendSupabaseError(res, prodErr);
      }
    }

    // Generate a stable slug from the name; uniqueness check inside community.
    const baseSlug = (nameEn || nameEs).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workflow';
    let slug = baseSlug;
    let scheduleId = `tfs_${communitySlug}_${slug}`.slice(0, 200);
    // Ensure unique slug — append a suffix if taken.
    for (let i = 1; i < 50; i++) {
      const { data: clash } = await supabase.from('tax_filing_schedules')
        .select('id').eq('community_id', communitySlug).eq('slug', slug).maybeSingle();
      if (!clash) break;
      slug = `${baseSlug}-${i + 1}`;
      scheduleId = `tfs_${communitySlug}_${slug}`.slice(0, 200);
    }

    const infoChecklist = Array.isArray(body.infoChecklist) ? body.infoChecklist : [];

    const { error: schedErr } = await supabase.from('tax_filing_schedules').insert({
      id: scheduleId, community_id: communitySlug, product_id: productId,
      slug, jurisdiction: trim(body.jurisdiction || 'federal', 60),
      cadence, anchor_rule: anchorRule, info_checklist: infoChecklist,
      name_i18n: { en: nameEn, es: nameEs },
      description_i18n: { en: trim(body.descriptionEn || '', 1000), es: trim(body.descriptionEs || '', 1000) },
      enabled: true, display_order: 100,
    });
    if (schedErr) return sendSupabaseError(res, schedErr);

    // Optional: auto-bind to a relationship type so the schedule shows up
    // immediately on the Workflows page under that relationship.
    const relTypeId = trim(body.relationshipTypeId || '', 200);
    if (relTypeId) {
      // Parse offsets (positive ints up to 10 entries, dedup).
      let offsets = [];
      if (Array.isArray(body.reminderOffsetsDays)) {
        offsets = body.reminderOffsetsDays
          .map(n => parseInt(n, 10))
          .filter(n => Number.isFinite(n) && n >= 0 && n <= 365);
      }
      const ruleId = `trwr_${communitySlug}_${relTypeId}_${slug}`.slice(0, 200);
      // Phase 4n.5: also persist the workflow spec onto the rule row so the
      // upcoming relationship-driven cron can read it without joining through
      // tax_filing_schedules. Mirrors the schedule row we just inserted.
      const { error: ruleErr } = await supabase.from('tax_relationship_workflow_rules').upsert({
        id: ruleId, community_id: communitySlug,
        relationship_type_id: relTypeId, filing_schedule_slug: slug,
        reminder_offsets_days: offsets,
        required_documents: Array.isArray(body.extraDocs) ? body.extraDocs : [],
        name_i18n: { en: nameEn, es: nameEs },
        description_i18n: { en: trim(body.descriptionEn || '', 1000), es: trim(body.descriptionEs || '', 1000) },
        cadence,
        anchor_rule: anchorRule,
        info_checklist: infoChecklist,
        active: true, updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (ruleErr) return sendSupabaseError(res, ruleErr);
    }

    try {
      await auditLog({
        entity: 'tax.filing_schedule', entityId: scheduleId,
        action: 'create', actorEmail: '',
        after: { community: communitySlug, slug, cadence, relTypeId: relTypeId || null },
      });
    } catch (_e) {}
    res.json({ ok: true, scheduleId, slug });
  });

  // ── Phase 4n.8: per-customer workflow overrides ─────────────────────────
  // List every workflow active for a customer (resolved through their
  // active relationships) and join the override row if one exists. Used by
  // the customer detail page to render the override editor.
  router.get('/admin/customers/:id/workflow-overrides', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    if (!customerId) return res.status(400).json({ error: 'customerId required.' });
    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    const { data: rels } = await supabase.from('tax_customer_relationships')
      .select('relationship_type_id').eq('customer_id', customerId).eq('active', true);
    const typeIds = (rels || []).map(r => r.relationship_type_id);
    if (!typeIds.length) return res.json({ workflows: [] });

    const { data: rules } = await supabase.from('tax_relationship_workflow_rules')
      .select('id, relationship_type_id, filing_schedule_slug, cadence, name_i18n, description_i18n, info_checklist, reminder_offsets_days')
      .eq('community_id', cust.community_id)
      .eq('active', true)
      .in('relationship_type_id', typeIds);
    const { data: overrides } = await supabase.from('tax_customer_workflow_overrides')
      .select('workflow_rule_id, custom_info_checklist, reminder_offsets_days, active, updated_at')
      .eq('customer_id', customerId);
    const ovByRule = new Map();
    for (const o of overrides || []) ovByRule.set(o.workflow_rule_id, o);

    const workflows = (rules || []).map(rule => ({
      rule,
      override: ovByRule.get(rule.id) || null,
    }));
    res.json({ workflows });
  });

  router.put('/admin/customers/:customerId/workflow-overrides/:ruleId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.customerId, 200);
    const ruleId = trim(req.params.ruleId, 200);
    const body = req.body || {};
    if (!customerId || !ruleId) return res.status(400).json({ error: 'customerId + ruleId required.' });

    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    // Validate offsets — same shape as the workflow rule editor.
    let offsets = null;
    if (Array.isArray(body.reminderOffsetsDays)) {
      const parsed = body.reminderOffsetsDays
        .map(n => parseInt(n, 10))
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 365);
      offsets = parsed.length ? parsed.slice(0, 10) : null;
    }
    const checklist = Array.isArray(body.customInfoChecklist) ? body.customInfoChecklist : null;

    const id = `tcwo_${customerId}_${ruleId}`.slice(0, 200);
    const row = {
      id, community_id: cust.community_id, customer_id: customerId,
      workflow_rule_id: ruleId,
      custom_info_checklist: checklist,
      reminder_offsets_days: offsets,
      active: body.active === false ? false : true,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('tax_customer_workflow_overrides').upsert(row, { onConflict: 'id' });
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.customer_workflow_override', entityId: id,
        action: 'upsert', actorEmail: '',
        after: { customer: customerId, rule: ruleId,
                 offsets: Array.isArray(offsets) ? offsets.length : 0,
                 docs: Array.isArray(checklist) ? checklist.length : 0 },
      });
    } catch (_e) {}
    res.json({ ok: true, override: row });
  });

  router.delete('/admin/customers/:customerId/workflow-overrides/:ruleId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.customerId, 200);
    const ruleId = trim(req.params.ruleId, 200);
    const id = `tcwo_${customerId}_${ruleId}`.slice(0, 200);
    const { error } = await supabase.from('tax_customer_workflow_overrides').delete().eq('id', id);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.customer_workflow_override', entityId: id,
        action: 'delete', actorEmail: '',
        after: { customer: customerId, rule: ruleId },
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── Phase 4n.9: per-workflow engagement panel ───────────────────────────
  // Aggregates email_delivery_logs over a sliding window. Owner sees at a
  // glance how a particular workflow's reminders are landing — open / click
  // rates are the signal that a workflow's wording is working.
  router.get('/admin/workflows/:ruleId/engagement', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const ruleId = trim(req.params.ruleId, 200);
    const windowDays = Math.max(1, Math.min(365, parseInt(req.query.windowDays, 10) || 90));
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    const { data, error } = await supabase.from('email_delivery_logs')
      .select('id, event_type, customer_id, created_at, delivered_at, opened_at, clicked_at, bounced_at, open_count, click_count')
      .eq('workflow_rule_id', ruleId).eq('event_type', 'reminder')
      .gte('created_at', since);
    if (error) return sendSupabaseError(res, error);
    const rows = data || [];
    const summary = {
      windowDays,
      sent: rows.length,
      delivered: rows.filter(r => r.delivered_at).length,
      opened: rows.filter(r => r.opened_at).length,
      clicked: rows.filter(r => r.clicked_at).length,
      bounced: rows.filter(r => r.bounced_at).length,
      uniqueCustomers: new Set(rows.map(r => r.customer_id).filter(Boolean)).size,
    };
    summary.openRate = summary.sent ? summary.opened / summary.sent : 0;
    summary.clickRate = summary.sent ? summary.clicked / summary.sent : 0;
    res.json({ summary });
  });

  // ── Phase 4n.9: send a test reminder ────────────────────────────────────
  // Builds a stub period for the workflow and sends the actual reminder
  // email to the requested recipient (defaults to the calling owner's
  // email). No DB write — does NOT create a real period or response token,
  // and is intentionally silent on email_delivery_logs so test sends don't
  // pollute the engagement panel.
  router.post('/admin/workflows/:ruleId/test-reminder', async (req, res) => {
    const email = await requireOwnerAdmin(req, res);
    if (!email) return;
    if (typeof sendTaxReminderEmail !== 'function') {
      return res.status(500).json({ error: 'reminder sender not configured' });
    }
    const ruleId = trim(req.params.ruleId, 200);
    const body = req.body || {};
    const toEmail = trim(body.toEmail || email, 200);
    if (!toEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
      return res.status(400).json({ error: 'Invalid recipient email.' });
    }
    const lang = body.lang === 'en' ? 'en' : 'es';

    const { data: rule } = await supabase.from('tax_relationship_workflow_rules')
      .select('id, community_id, filing_schedule_slug, name_i18n, description_i18n, info_checklist, reminder_offsets_days, required_documents')
      .eq('id', ruleId).maybeSingle();
    if (!rule) return res.status(404).json({ error: 'Workflow not found.' });

    // Stub objects mirror what fireReminders normally passes to the sender.
    const offsetDays = Math.abs(parseInt(body.offsetDays, 10)) || 14;
    const stubRow = {
      id: 'preview',
      period_label: lang === 'en' ? 'Test period' : 'Período de prueba',
      due_date: body.dueDate || '2026-12-31',
    };
    const stubCust = {
      id: 'preview',
      community_id: rule.community_id,
      email: toEmail,
      name: lang === 'en' ? 'Test recipient' : 'Destinatario de prueba',
      locale: lang,
    };
    const stubSch = {
      id: rule.id,
      slug: rule.filing_schedule_slug,
      name_i18n: rule.name_i18n || {},
      description_i18n: rule.description_i18n || {},
      info_checklist: rule.info_checklist || [],
    };
    const magicUrl = `${typeof publicAppUrl === 'function' ? publicAppUrl() : ''}/tax/respond/preview-test`;
    try {
      const result = await sendTaxReminderEmail({
        row: stubRow, cust: stubCust, sch: stubSch, sub: null,
        magicUrl, offsetDays, tips: [], extraDocs: rule.required_documents || null,
        // Test sends are excluded from engagement aggregation.
        skipLog: true,
      });
      if (result?.sent === false && !result.skipped) {
        return res.status(500).json({ error: result.reason || 'send failed' });
      }
      return res.json({ ok: true, to: toEmail, skipped: !!result?.skipped, reason: result?.reason || null });
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'send failed' });
    }
  });

  // ── Task progress dashboard ─────────────────────────────────────────────
  //
  // Aggregates tax_tasks by (product, customer, status) so the owner
  // can scan completion across the customer base at a glance.
  // Response shape:
  //   {
  //     totals: { open, in_progress, done, overdue },
  //     byService: [{
  //       product: { id, slug, name_i18n },
  //       totals:  { open, in_progress, done, overdue, total },
  //       customers: [{ id, name, email, open, in_progress, done, overdue, total }],
  //     }],
  //   }
  // Staff see only customers in their assignment set.
  // ── GET /admin/dashboard ────────────────────────────────────────────────
  // Today-page feed for the staff portal. One call returns the four KPI
  // numbers + three short lists the operator most needs at a glance:
  //   • Top urgent tasks (overdue + due-today), capped at 8
  //   • Newest leads from the last 7 days, capped at 6
  //   • Customers needing attention (sorted by overdue count), capped at 5
  // Staff users get every list scoped to their assigned customers; admin
  // sees the whole community.
  router.get('/admin/dashboard', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const communitySlug = trim(req.query.communitySlug, 200) || emp.community_id;
    if (communitySlug !== emp.community_id && emp.role !== 'admin') {
      return res.status(403).json({ error: 'Wrong community.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const ninetyDaysAgo = new Date(); ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 90);
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const sevenDaysAgo  = new Date(); sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);

    // Determine the visible-customers set ONCE; reuse across queries.
    let allowedCustomerIds = null; // null = all (admin)
    if (emp.role !== 'admin') {
      const visible = await getVisibleCustomerIdsForEmployee(emp);
      allowedCustomerIds = Array.isArray(visible) ? visible : [];
    }
    const scopedToNothing = Array.isArray(allowedCustomerIds) && allowedCustomerIds.length === 0;

    // Terminal statuses to exclude from "open" counts.
    const { data: statusOpts } = await supabase.from('tax_task_status_options')
      .select('key, is_terminal').eq('community_id', communitySlug);
    const terminalKeys = (statusOpts || []).filter(s => s.is_terminal).map(s => s.key);

    // Open tasks (everything not completed and not in a terminal status).
    let openQ = supabase.from('tax_tasks')
      .select(`
        id, customer_id, product_id, title, status_key, priority, due_date, completed_at,
        assigned_employee_id,
        customer:tax_customers ( id, name, business_name, first_name, middle_name, last_name, email ),
        product:tax_products ( id, slug, name_i18n )
      `)
      .eq('community_id', communitySlug)
      .is('archived_at', null)
      .is('completed_at', null);
    if (terminalKeys.length) openQ = openQ.not('status_key', 'in', `(${terminalKeys.map(k => `"${k}"`).join(',')})`);
    if (scopedToNothing) openQ = openQ.eq('id', '__none__'); // returns nothing
    else if (allowedCustomerIds) openQ = openQ.in('customer_id', allowedCustomerIds);
    const { data: openTasks, error: openErr } = await openQ.limit(2000);
    if (openErr) return sendSupabaseError(res, openErr);

    // Completion rate over the last 30 days. Count tasks that completed
    // in the window vs tasks whose due_date fell in the window.
    let completedQ = supabase.from('tax_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', communitySlug)
      .gte('completed_at', thirtyDaysAgo.toISOString())
      .is('archived_at', null);
    if (scopedToNothing) completedQ = completedQ.eq('id', '__none__');
    else if (allowedCustomerIds) completedQ = completedQ.in('customer_id', allowedCustomerIds);
    const { count: completedCount } = await completedQ;

    let dueQ = supabase.from('tax_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', communitySlug)
      .gte('due_date', thirtyDaysAgo.toISOString().slice(0, 10))
      .lte('due_date', today)
      .is('archived_at', null);
    if (scopedToNothing) dueQ = dueQ.eq('id', '__none__');
    else if (allowedCustomerIds) dueQ = dueQ.in('customer_id', allowedCustomerIds);
    const { count: dueCount } = await dueQ;

    // Leads — admin only (staff can't access leads in this app). Last 7
    // days + 30-day conversion rate.
    let newLeads = [];
    let newLeads7d = 0;
    let leadsCount30d = 0;
    let convertedCount30d = 0;
    if (emp.role === 'admin') {
      const { data: recent } = await supabase.from('tax_leads')
        .select('id, community_id, name, first_name, last_name, email, phone, product_slugs, product_slug, message, status, created_at')
        .eq('community_id', communitySlug)
        .gte('created_at', sevenDaysAgo.toISOString())
        .order('created_at', { ascending: false })
        .limit(50);
      newLeads = (recent || []).filter(l => l.status !== 'converted' && l.status !== 'closed').slice(0, 6);
      newLeads7d = (recent || []).length;

      const { count: leadCount } = await supabase.from('tax_leads')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', communitySlug)
        .gte('created_at', thirtyDaysAgo.toISOString());
      leadsCount30d = leadCount || 0;

      const { count: convCount } = await supabase.from('tax_leads')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', communitySlug)
        .eq('status', 'converted')
        .gte('updated_at', thirtyDaysAgo.toISOString());
      convertedCount30d = convCount || 0;
    }

    // Tally KPIs + sort the urgent task list.
    let dueToday = 0, overdue = 0, inProgress = 0;
    const taskHealthByCustomer = new Map();
    for (const t of openTasks || []) {
      if (t.due_date === today) dueToday++;
      if (t.due_date && t.due_date < today) overdue++;
      if (t.status_key === 'in_progress') inProgress++;
      if (!t.customer_id) continue;
      const slot = taskHealthByCustomer.get(t.customer_id)
                || { customer: t.customer, open: 0, overdue: 0 };
      slot.open++;
      if (t.due_date && t.due_date < today) slot.overdue++;
      taskHealthByCustomer.set(t.customer_id, slot);
    }

    // Sort tasks so the most urgent surface first: overdue → due today
    // → upcoming. Within each bucket, highest priority first.
    const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
    const sortedTasks = (openTasks || []).slice().sort((a, b) => {
      const aOverdue = a.due_date && a.due_date < today ? 0 : 1;
      const bOverdue = b.due_date && b.due_date < today ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      const aToday = a.due_date === today ? 0 : 1;
      const bToday = b.due_date === today ? 0 : 1;
      if (aToday !== bToday) return aToday - bToday;
      const pa = priorityRank[a.priority] ?? 4;
      const pb = priorityRank[b.priority] ?? 4;
      if (pa !== pb) return pa - pb;
      return (a.due_date || '9999-99-99').localeCompare(b.due_date || '9999-99-99');
    });
    const urgentTasks = sortedTasks.slice(0, 8);

    // Customers needing attention — sorted by overdue desc, open desc.
    const needsAttention = Array.from(taskHealthByCustomer.entries())
      .map(([id, slot]) => ({ id, ...slot }))
      .filter(s => s.overdue > 0)
      .sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open))
      .slice(0, 5);

    res.json({
      role: emp.role,
      kpis: {
        tasks_due_today: dueToday,
        tasks_overdue: overdue,
        tasks_in_progress: inProgress,
        tasks_open_total: (openTasks || []).length,
        new_leads_7d: newLeads7d,
        completion_rate_30d: {
          completed: completedCount || 0,
          due: dueCount || 0,
          pct: (dueCount || 0) > 0
            ? Math.round(((completedCount || 0) / (dueCount || 1)) * 100)
            : null,
        },
        lead_conversion_30d: {
          converted: convertedCount30d,
          total: leadsCount30d,
          pct: leadsCount30d > 0
            ? Math.round((convertedCount30d / leadsCount30d) * 100)
            : null,
        },
      },
      urgentTasks,
      newLeads,
      needsAttention,
    });
  });

  router.get('/admin/progress', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const communitySlug = trim(req.query.communitySlug, 200) || emp.community_id;
    if (communitySlug !== emp.community_id && emp.role !== 'admin') {
      return res.status(403).json({ error: 'Wrong community.' });
    }

    let allowedCustomers = null; // null = all
    if (emp.role !== 'admin') {
      const visible = await getVisibleCustomerIdsForEmployee(emp);
      if (Array.isArray(visible)) allowedCustomers = new Set(visible);
    }

    // Optional filters applied at the SQL layer so the rollup recomputes
    // automatically — KPI cards reflect only what's visible.
    const filterAssignee = trim(req.query.assignedTo || '', 200);
    const filterCustomer = trim(req.query.customerId || '', 200);
    // Same customer-type filter as the Tasks page so the Service-
    // progress dashboard matches what an owner is looking at when
    // they cross over from the Tasks list. Resolves matching
    // customer IDs once and intersects with any specific customerId
    // the caller also passed.
    const ctNorm = String(req.query.customerType || '').toLowerCase().trim();
    let typeCustomerIds = null;
    if (ctNorm === 'business' || ctNorm === 'individual') {
      const { data: matched } = await supabase.from('tax_customers')
        .select('id').eq('community_id', communitySlug).eq('customer_type', ctNorm);
      typeCustomerIds = (matched || []).map(r => r.id);
      if (!typeCustomerIds.length) {
        return res.json({ totals: { open: 0, in_progress: 0, done: 0, overdue: 0 }, byService: [] });
      }
    }
    let q = supabase.from('tax_tasks')
      .select(`
        id, customer_id, product_id, status_key, due_date, completed_at,
        customer:tax_customers ( id, name, business_name, first_name, middle_name, last_name, email ),
        product:tax_products ( id, slug, name_i18n )
      `)
      .eq('community_id', communitySlug)
      .is('archived_at', null)
      .limit(5000);
    if (filterAssignee) q = q.eq('assigned_employee_id', filterAssignee);
    if (filterCustomer) q = q.eq('customer_id', filterCustomer);
    if (typeCustomerIds) q = q.in('customer_id', typeCustomerIds);
    const { data: tasks, error } = await q;
    if (error) return sendSupabaseError(res, error);

    const { data: statusOpts } = await supabase.from('tax_task_status_options')
      .select('key, is_terminal').eq('community_id', communitySlug);
    const terminalKeys = new Set((statusOpts || []).filter(s => s.is_terminal).map(s => s.key));

    const today = new Date().toISOString().slice(0, 10);
    const byService = new Map();
    const totals = { open: 0, in_progress: 0, done: 0, overdue: 0 };

    for (const t of tasks || []) {
      if (allowedCustomers && t.customer_id && !allowedCustomers.has(t.customer_id)) continue;
      if (!t.product_id) continue;

      const isDone = !!t.completed_at || terminalKeys.has(t.status_key);
      const isOverdue = !isDone && t.due_date && t.due_date < today;
      const isInProgress = !isDone && t.status_key === 'in_progress';
      const isOpen = !isDone && !isInProgress;

      if (isDone) totals.done++;
      else if (isInProgress) totals.in_progress++;
      else totals.open++;
      if (isOverdue) totals.overdue++;

      const skey = t.product_id;
      let svc = byService.get(skey);
      if (!svc) {
        svc = {
          product: t.product || { id: t.product_id, slug: t.product_id, name_i18n: {} },
          totals: { open: 0, in_progress: 0, done: 0, overdue: 0, total: 0 },
          customersMap: new Map(),
        };
        byService.set(skey, svc);
      }
      svc.totals.total++;
      if (isDone) svc.totals.done++;
      else if (isInProgress) svc.totals.in_progress++;
      else svc.totals.open++;
      if (isOverdue) svc.totals.overdue++;

      if (t.customer_id) {
        let row = svc.customersMap.get(t.customer_id);
        if (!row) {
          row = {
            id: t.customer_id, customer: t.customer || null,
            open: 0, in_progress: 0, done: 0, overdue: 0, total: 0,
          };
          svc.customersMap.set(t.customer_id, row);
        }
        row.total++;
        if (isDone) row.done++;
        else if (isInProgress) row.in_progress++;
        else row.open++;
        if (isOverdue) row.overdue++;
      }
    }

    const byServiceOut = Array.from(byService.values()).map(svc => ({
      product: svc.product,
      totals: svc.totals,
      customers: Array.from(svc.customersMap.values())
        .sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open)),
    })).sort((a, b) => b.totals.total - a.totals.total);

    res.json({ totals, byService: byServiceOut });
  });

  // ── Upcoming reminders page ─────────────────────────────────────────────
  // Lists tax_filing_periods with their next-up reminder context, plus
  // engagement (last reminder email + opened?). Filters mirror the
  // customer-search UX: q (customer name/email), service (product_id),
  // status, due window, assigned employee.
  //
  // Staff scope: non-admin sees only periods whose customer is in their
  // assigned set (or assigned directly to them, when we add that).
  router.get('/admin/upcoming-reminders', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const communitySlug = trim(req.query.communitySlug, 200) || emp.community_id;
    if (communitySlug !== emp.community_id && emp.role !== 'admin') {
      return res.status(403).json({ error: 'Cross-community access requires admin.' });
    }

    let q = supabase.from('tax_filing_periods')
      .select(`
        id, community_id, customer_id, schedule_id, workflow_rule_id,
        period_label, due_date, status, info_received_at,
        customer:tax_customers!inner ( id, email, name, first_name, middle_name, last_name, phone, locale ),
        schedule:tax_filing_schedules ( id, slug, name_i18n, product_id ),
        workflow:tax_relationship_workflow_rules ( id, filing_schedule_slug, name_i18n )
      `)
      .eq('community_id', communitySlug);

    if (emp.role !== 'admin') {
      const visible = await getVisibleCustomerIdsForEmployee(emp);
      if (Array.isArray(visible)) {
        if (!visible.length) return res.json({ rows: [] });
        q = q.in('customer_id', visible);
      }
    }

    // Status filter: default to "active" = pending + info_requested. Empty
    // string or "all" returns everything.
    const status = trim(req.query.status || '', 40);
    if (!status || status === 'active') {
      q = q.in('status', ['pending', 'info_requested']);
    } else if (status !== 'all') {
      q = q.eq('status', status);
    }

    // Due window. Defaults to "next 30 days" to keep the page focused.
    const today = new Date().toISOString().slice(0, 10);
    const due = trim(req.query.due || '', 20);
    if (due === 'overdue') {
      q = q.lt('due_date', today);
    } else if (due === 'today') {
      q = q.eq('due_date', today);
    } else if (due === 'week') {
      const wk = new Date(); wk.setUTCDate(wk.getUTCDate() + 7);
      q = q.gte('due_date', today).lte('due_date', wk.toISOString().slice(0, 10));
    } else if (due === 'month') {
      const mo = new Date(); mo.setUTCDate(mo.getUTCDate() + 30);
      q = q.gte('due_date', today).lte('due_date', mo.toISOString().slice(0, 10));
    } else if (due === 'all') {
      // no bound
    } else {
      // default: next 30 days (matches the cron lookahead).
      const mo = new Date(); mo.setUTCDate(mo.getUTCDate() + 30);
      q = q.gte('due_date', today).lte('due_date', mo.toISOString().slice(0, 10));
    }

    const productId = trim(req.query.productId || '', 200);
    if (productId) {
      const { data: schedIds } = await supabase.from('tax_filing_schedules')
        .select('id').eq('community_id', communitySlug).eq('product_id', productId);
      const ids = (schedIds || []).map(s => s.id);
      if (!ids.length) return res.json({ rows: [] });
      q = q.in('schedule_id', ids);
    }

    q = q.order('due_date', { ascending: true }).limit(500);
    const { data: rows, error } = await q;
    if (error) return sendSupabaseError(res, error);

    // Customer-substring filter (name / email). Cheap client-side filter on
    // the result set — fine while we cap at 500 rows.
    let filtered = rows || [];
    const search = trim(req.query.q || '', 200).toLowerCase();
    if (search) {
      filtered = filtered.filter(r => {
        const c = r.customer || {};
        const hay = `${c.name || ''} ${c.first_name || ''} ${c.last_name || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase();
        return hay.includes(search);
      });
    }

    // Engagement: latest sent reminder email per period + open/click stamps.
    const periodIds = filtered.map(r => r.id);
    let logsByPeriod = new Map();
    if (periodIds.length) {
      const { data: logs } = await supabase.from('email_delivery_logs')
        .select('id, period_id, email_type, status, sent_at, delivered_at, opened_at, clicked_at, bounced_at, complained_at, open_count, click_count, created_at')
        .in('period_id', periodIds)
        .order('created_at', { ascending: false });
      for (const l of logs || []) {
        const cur = logsByPeriod.get(l.period_id);
        if (!cur || new Date(l.created_at) > new Date(cur.created_at)) {
          logsByPeriod.set(l.period_id, l);
        }
      }
    }
    const out = filtered.map(r => ({ ...r, lastEmail: logsByPeriod.get(r.id) || null }));
    res.json({ rows: out });
  });

  // POST /admin/upcoming-reminders/:periodId/send — fire a reminder email now.
  router.post('/admin/upcoming-reminders/:periodId/send', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    if (!hasEmployeePermission(emp, 'send_reminders')) {
      return res.status(403).json({ error: 'permission_revoked', message: 'send_reminders revoked.' });
    }
    if (typeof fireReminderForPeriod !== 'function') {
      return res.status(500).json({ error: 'reminder sender not configured' });
    }
    const periodId = trim(req.params.periodId, 200);

    const { data: period } = await supabase.from('tax_filing_periods')
      .select('id, community_id, customer_id').eq('id', periodId).maybeSingle();
    if (!period) return res.status(404).json({ error: 'Period not found.' });
    if (period.community_id !== emp.community_id) return res.status(403).json({ error: 'Wrong community.' });
    if (emp.role !== 'admin' && period.customer_id) {
      const ok = await canEmployeeSeeCustomer(emp, period.customer_id);
      if (!ok) return res.status(403).json({ error: 'Not assigned to this customer.' });
    }

    const r = await fireReminderForPeriod(periodId, {
      channels: ['email'],
      force: !!req.body?.force,
    });
    if (r.error) return res.status(500).json({ error: r.error });
    try {
      await auditLog({
        entity: 'tax.filing_period', entityId: periodId, action: 'manual_reminder',
        actorEmail: emp.email || '', actorName: emp.name || '',
        after: { channels: r.channels || [], skipped: r.skipped || [] },
      });
    } catch (_e) {}
    res.json({ ok: true, ...r });
  });

  // ── Phase 4n.10: workflow template library ──────────────────────────────
  // GET  /admin/workflow-templates                      → catalog
  // POST /admin/workflow-templates/:templateId/clone    → clone into a
  //   community + (optional) auto-bind to a relationship type. Same writes
  //   as POST /admin/filing-schedules, just with the fields pre-filled.
  const taxTemplates = require('./workflow-templates');
  router.get('/admin/workflow-templates', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    res.json({ templates: taxTemplates.listTemplates() });
  });

  router.post('/admin/workflow-templates/:templateId/clone', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_workflows'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const templateId = trim(req.params.templateId, 200);
    const relTypeId = trim(body.relationshipTypeId || '', 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const tpl = taxTemplates.getTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'Template not found.' });

    // Find or create a "custom-workflows" product so the new schedule has
    // a parent (FK requirement). Same fallback used by create-from-scratch.
    let productId = trim(body.productId || '', 200);
    if (!productId) {
      const customSlug = 'custom-workflows';
      const { data: existingProd } = await supabase.from('tax_products')
        .select('id').eq('community_id', communitySlug).eq('slug', customSlug).maybeSingle();
      if (existingProd) productId = existingProd.id;
      else {
        productId = `tp_${communitySlug}_${customSlug}`.slice(0, 200);
        const { error: prodErr } = await supabase.from('tax_products').insert({
          id: productId, community_id: communitySlug, slug: customSlug,
          category: 'custom', display_order: 900,
          name_i18n: { en: 'Custom workflows', es: 'Flujos personalizados' },
          description_i18n: { en: 'Owner-defined filing schedules.', es: 'Calendarios definidos por el dueño.' },
        });
        if (prodErr) return sendSupabaseError(res, prodErr);
      }
    }

    // Build a unique slug, suffix on collision.
    const baseSlug = tpl.suggested_slug || tpl.id;
    let slug = baseSlug;
    let scheduleId = `tfs_${communitySlug}_${slug}`.slice(0, 200);
    for (let i = 1; i < 50; i++) {
      const { data: clash } = await supabase.from('tax_filing_schedules')
        .select('id').eq('community_id', communitySlug).eq('slug', slug).maybeSingle();
      if (!clash) break;
      slug = `${baseSlug}-${i + 1}`;
      scheduleId = `tfs_${communitySlug}_${slug}`.slice(0, 200);
    }

    const { error: schedErr } = await supabase.from('tax_filing_schedules').insert({
      id: scheduleId, community_id: communitySlug, product_id: productId,
      slug, jurisdiction: tpl.jurisdiction || 'federal',
      cadence: tpl.cadence, anchor_rule: tpl.anchor_rule,
      info_checklist: tpl.info_checklist,
      name_i18n: tpl.name_i18n, description_i18n: tpl.description_i18n,
      enabled: true, display_order: 100,
    });
    if (schedErr) return sendSupabaseError(res, schedErr);

    if (relTypeId) {
      const ruleId = `trwr_${communitySlug}_${relTypeId}_${slug}`.slice(0, 200);
      const { error: ruleErr } = await supabase.from('tax_relationship_workflow_rules').upsert({
        id: ruleId, community_id: communitySlug,
        relationship_type_id: relTypeId, filing_schedule_slug: slug,
        reminder_offsets_days: Array.isArray(tpl.suggested_offsets) ? tpl.suggested_offsets : [],
        required_documents: [],
        name_i18n: tpl.name_i18n, description_i18n: tpl.description_i18n,
        cadence: tpl.cadence, anchor_rule: tpl.anchor_rule,
        info_checklist: tpl.info_checklist,
        active: true, updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (ruleErr) return sendSupabaseError(res, ruleErr);
    }

    try {
      await auditLog({
        entity: 'tax.workflow_template', entityId: templateId,
        action: 'clone', actorEmail: '',
        after: { community: communitySlug, slug, relTypeId: relTypeId || null },
      });
    } catch (_e) {}
    res.json({ ok: true, scheduleId, slug });
  });

  // ── Phase 4n.10: per-workflow audit history ─────────────────────────────
  router.get('/admin/workflows/:ruleId/audit', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const ruleId = trim(req.params.ruleId, 200);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const { data, error } = await supabase.from('audit_logs')
      .select('id, action, actor_email, actor_name, before_data, after_data, created_at, reason')
      .eq('entity', 'tax.relationship_workflow_rule')
      .eq('entity_id', ruleId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return sendSupabaseError(res, error);
    res.json({ events: data || [] });
  });

  router.get('/admin/relationship-workflow-rules', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { data, error } = await supabase.from('tax_relationship_workflow_rules')
      .select('id, relationship_type_id, filing_schedule_slug, reminder_offsets_days, required_documents, active, updated_at')
      .eq('community_id', communitySlug);
    if (error) return sendSupabaseError(res, error);
    res.json({ rules: data || [] });
  });

  router.put('/admin/relationship-workflow-rules/:relTypeId/:scheduleSlug', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const relTypeId = trim(req.params.relTypeId, 200);
    const scheduleSlug = trim(req.params.scheduleSlug, 200);
    if (!communitySlug || !relTypeId || !scheduleSlug) {
      return res.status(400).json({ error: 'communitySlug, relTypeId, scheduleSlug required.' });
    }
    // Validate offsets — array of positive ints, max 10 entries, dedup.
    let offsets = null;
    if (Array.isArray(body.reminderOffsetsDays)) {
      const parsed = body.reminderOffsetsDays
        .map(v => Number(v))
        .filter(v => Number.isFinite(v) && v >= 0 && v <= 365)
        .map(v => Math.round(Math.abs(v)));
      const dedup = Array.from(new Set(parsed)).slice(0, 10);
      offsets = dedup;
    }
    // Required docs — passed through as JSONB; light shape check.
    let requiredDocs = null;
    if (Array.isArray(body.requiredDocuments)) {
      requiredDocs = body.requiredDocuments
        .filter(d => d && typeof d === 'object' && typeof d.key === 'string' && d.key)
        .slice(0, 50)
        .map(d => ({
          key: String(d.key).slice(0, 80),
          label_i18n: (d.label_i18n && typeof d.label_i18n === 'object')
            ? { en: String(d.label_i18n.en || '').slice(0, 500), es: String(d.label_i18n.es || '').slice(0, 500) }
            : { en: '', es: '' },
          type: typeof d.type === 'string' ? d.type.slice(0, 40) : 'text',
          required: d.required !== false,
        }));
    }

    const id = `trwr_${communitySlug}_${relTypeId}_${scheduleSlug}`.slice(0, 200);
    // Phase 4n.10: snapshot the existing row so the audit history can diff
    // before/after. Skip when it's a fresh insert (the after is the whole
    // story).
    const { data: existingRow } = await supabase.from('tax_relationship_workflow_rules')
      .select('reminder_offsets_days, required_documents, active, name_i18n, description_i18n, cadence, anchor_rule, info_checklist')
      .eq('id', id).maybeSingle();
    const row = {
      id, community_id: communitySlug,
      relationship_type_id: relTypeId,
      filing_schedule_slug: scheduleSlug,
      reminder_offsets_days: offsets,
      required_documents: requiredDocs,
      active: body.active === false ? false : true,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('tax_relationship_workflow_rules').upsert(row, { onConflict: 'id' });
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.relationship_workflow_rule', entityId: id,
        action: 'upsert', actorEmail: '',
        before: existingRow || null,
        after: {
          reminder_offsets_days: offsets,
          required_documents: requiredDocs,
          active: row.active,
        },
      });
    } catch (_e) {}
    res.json({ ok: true, rule: row });
  });

  router.delete('/admin/relationship-workflow-rules/:relTypeId/:scheduleSlug', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    const relTypeId = trim(req.params.relTypeId, 200);
    const scheduleSlug = trim(req.params.scheduleSlug, 200);
    if (!communitySlug || !relTypeId || !scheduleSlug) {
      return res.status(400).json({ error: 'communitySlug, relTypeId, scheduleSlug required.' });
    }
    const id = `trwr_${communitySlug}_${relTypeId}_${scheduleSlug}`.slice(0, 200);
    const { data: existingRow } = await supabase.from('tax_relationship_workflow_rules')
      .select('reminder_offsets_days, required_documents, active, name_i18n, description_i18n, cadence, anchor_rule, info_checklist')
      .eq('id', id).maybeSingle();
    const { error } = await supabase.from('tax_relationship_workflow_rules').delete().eq('id', id);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.relationship_workflow_rule', entityId: id,
        action: 'delete', actorEmail: '',
        before: existingRow || null,
        after: null,
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── Phase 4n.27: per-customer activity timeline ─────────────────────────
  //
  // Aggregates every meaningful event involving this customer into one
  // chronological feed. Lets the owner answer "what's been going on with
  // Maria?" without scrolling through 7 sibling sections. Sources:
  //   • tax_customer_notes               → note_added
  //   • tax_signature_requests           → sig_requested / sig_signed
  //                                        / sig_declined / sig_cancelled
  //   • tax_filing_periods (info_received_at, filed_at)
  //                                      → filing_responded / filing_filed
  //   • tax_message_threads              → thread_created / thread_message
  //   • email_delivery_logs              → reminder_sent / reminder_opened
  //                                        / reminder_clicked / bounced
  //   • audit_logs (entity=tax.customer) → status / contact / promote events
  //
  // Same scope rules as the rest of customer detail: admin → any customer
  // in the community; staff → only customers they're assigned to.
  router.get('/admin/customers/:id/activity', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const customerId = trim(req.params.id, 200);
    if (!(await canEmployeeSeeCustomer(emp, customerId))) {
      return res.status(403).json({ error: 'Not assigned to this customer.' });
    }
    const limit = Math.max(10, Math.min(200, parseInt(req.query.limit, 10) || 100));

    const events = [];
    function push(ts, evt) {
      if (!ts) return;
      events.push({ ts, ...evt });
    }

    const [
      notesQ, sigsQ, periodsQ, threadsQ, emailLogsQ, customerQ, auditQ,
    ] = await Promise.all([
      supabase.from('tax_customer_notes')
        .select('id, body, author_email, author_name, author_role, created_at')
        .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(limit),
      supabase.from('tax_signature_requests')
        .select('id, title, status, requested_by_name, signer_name, signed_at, cancelled_at, created_at, updated_at')
        .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(limit),
      supabase.from('tax_filing_periods')
        .select(`
          id, period_label, due_date, info_received_at, filed_at, status,
          workflow:tax_relationship_workflow_rules ( id, name_i18n, filing_schedule_slug ),
          schedule:tax_filing_schedules ( id, slug, name_i18n )
        `)
        .eq('customer_id', customerId).order('due_date', { ascending: false }).limit(limit),
      supabase.from('tax_message_threads')
        .select('id, subject, last_message_at, last_message_preview, last_message_by_role, created_at')
        .eq('customer_id', customerId).order('last_message_at', { ascending: false, nullsFirst: false }).limit(50),
      supabase.from('email_delivery_logs')
        .select('id, event_type, subject, created_at, delivered_at, opened_at, clicked_at, bounced_at')
        .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(limit),
      supabase.from('tax_customers')
        .select('email, name, created_at').eq('id', customerId).maybeSingle(),
      supabase.from('audit_logs')
        .select('id, entity, action, before_data, after_data, actor_email, actor_name, created_at')
        .or(`entity_id.eq.${customerId},and(entity.eq.tax.customer,entity_id.eq.${customerId})`)
        .order('created_at', { ascending: false }).limit(50),
    ]);

    for (const n of (notesQ.data || [])) {
      push(n.created_at, {
        kind: 'note_added', tone: 'info',
        title: 'Note added', detail: n.body.slice(0, 200),
        actor: n.author_name || n.author_email, actorRole: n.author_role,
        ref: { kind: 'note', id: n.id },
      });
    }

    for (const s of (sigsQ.data || [])) {
      push(s.created_at, {
        kind: 'sig_requested', tone: 'info',
        title: `Signature requested: ${s.title}`,
        actor: s.requested_by_name || null, ref: { kind: 'signature', id: s.id },
      });
      if (s.status === 'signed' && s.signed_at) {
        push(s.signed_at, {
          kind: 'sig_signed', tone: 'ok',
          title: `Signed: ${s.title}`, actor: s.signer_name,
          ref: { kind: 'signature', id: s.id },
        });
      } else if (s.status === 'declined') {
        push(s.updated_at, {
          kind: 'sig_declined', tone: 'warn',
          title: `Declined to sign: ${s.title}`, actor: null,
          ref: { kind: 'signature', id: s.id },
        });
      } else if (s.status === 'cancelled') {
        push(s.cancelled_at || s.updated_at, {
          kind: 'sig_cancelled', tone: 'muted',
          title: `Signature cancelled: ${s.title}`,
          ref: { kind: 'signature', id: s.id },
        });
      }
    }

    for (const p of (periodsQ.data || [])) {
      const filingName = (p.workflow?.name_i18n && (p.workflow.name_i18n.es || p.workflow.name_i18n.en))
                     || (p.schedule?.name_i18n && (p.schedule.name_i18n.es || p.schedule.name_i18n.en))
                     || p.workflow?.filing_schedule_slug || p.schedule?.slug || 'Filing';
      if (p.info_received_at) {
        push(p.info_received_at, {
          kind: 'filing_responded', tone: 'ok',
          title: `Customer submitted info: ${filingName}`,
          detail: p.period_label || p.due_date,
          ref: { kind: 'period', id: p.id },
        });
      }
      if (p.filed_at) {
        push(p.filed_at, {
          kind: 'filing_filed', tone: 'ok',
          title: `Filed: ${filingName}`,
          detail: p.period_label || p.due_date,
          ref: { kind: 'period', id: p.id },
        });
      }
    }

    for (const th of (threadsQ.data || [])) {
      if (th.last_message_at) {
        const byRole = th.last_message_by_role === 'customer' ? 'customer' : 'practice';
        push(th.last_message_at, {
          kind: byRole === 'customer' ? 'message_in' : 'message_out',
          tone: byRole === 'customer' ? 'info' : 'muted',
          title: byRole === 'customer'
            ? `Customer messaged: ${th.subject || ''}`
            : `Practice replied: ${th.subject || ''}`,
          detail: (th.last_message_preview || '').slice(0, 200),
          ref: { kind: 'thread', id: th.id },
        });
      } else if (th.created_at) {
        push(th.created_at, {
          kind: 'thread_created', tone: 'muted',
          title: `Thread started: ${th.subject || ''}`,
          ref: { kind: 'thread', id: th.id },
        });
      }
    }

    for (const e of (emailLogsQ.data || [])) {
      const label = e.event_type === 'reminder' ? 'Reminder' : (e.event_type || 'Email');
      push(e.created_at, {
        kind: 'email_sent', tone: 'muted',
        title: `${label} sent`, detail: e.subject || '',
        ref: { kind: 'email', id: e.id },
      });
      if (e.delivered_at && e.delivered_at !== e.created_at) {
        push(e.delivered_at, {
          kind: 'email_delivered', tone: 'muted',
          title: `${label} delivered`, ref: { kind: 'email', id: e.id },
        });
      }
      if (e.opened_at) {
        push(e.opened_at, {
          kind: 'email_opened', tone: 'ok',
          title: `${label} opened`, detail: e.subject || '',
          ref: { kind: 'email', id: e.id },
        });
      }
      if (e.clicked_at) {
        push(e.clicked_at, {
          kind: 'email_clicked', tone: 'ok',
          title: `${label} link clicked`, detail: e.subject || '',
          ref: { kind: 'email', id: e.id },
        });
      }
      if (e.bounced_at) {
        push(e.bounced_at, {
          kind: 'email_bounced', tone: 'warn',
          title: `${label} bounced`, ref: { kind: 'email', id: e.id },
        });
      }
    }

    // Customer creation marker so the timeline has a clean "start of
    // relationship" entry.
    if (customerQ.data?.created_at) {
      push(customerQ.data.created_at, {
        kind: 'customer_created', tone: 'muted',
        title: `Customer added to the practice`,
      });
    }

    // Look up product + relationship names referenced by audit rows so
    // the timeline can render friendly labels ("Service removed:
    // Bookkeeping") instead of opaque action strings. Cheap because the
    // audit set is already capped at 50 rows.
    const auditProductIds = new Set();
    const auditRelTypeIds = new Set();
    for (const a of (auditQ.data || [])) {
      const after = (a.after_data && typeof a.after_data === 'object') ? a.after_data : {};
      if (after.productId) auditProductIds.add(String(after.productId));
      if (after.relationshipTypeId) auditRelTypeIds.add(String(after.relationshipTypeId));
    }
    const productNameById = new Map();
    if (auditProductIds.size) {
      const { data } = await supabase.from('tax_products')
        .select('id, slug, name_i18n').in('id', Array.from(auditProductIds));
      for (const p of (data || [])) {
        productNameById.set(p.id, p.name_i18n?.es || p.name_i18n?.en || p.slug || p.id);
      }
    }
    const relTypeNameById = new Map();
    if (auditRelTypeIds.size) {
      const { data } = await supabase.from('tax_relationship_types')
        .select('id, slug, name_i18n').in('id', Array.from(auditRelTypeIds));
      for (const r of (data || [])) {
        relTypeNameById.set(r.id, r.name_i18n?.es || r.name_i18n?.en || r.slug || r.id);
      }
    }
    // Undo is offered only for recent removals — a week is long enough
    // for a typical "oops, didn't mean to do that" loop but short enough
    // that the team's intervening work doesn't get clobbered by a stale
    // restore. The button hides itself once the window closes.
    const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const nowMs = Date.now();

    for (const a of (auditQ.data || [])) {
      if (a.entity !== 'tax.customer' && a.entity !== 'tax.customer.contact') continue;
      const after = (a.after_data && typeof a.after_data === 'object') ? a.after_data : {};
      const ageMs = nowMs - new Date(a.created_at).getTime();
      const inUndoWindow = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= UNDO_WINDOW_MS;

      // Service removal: friendly title + undo button. The audit row
      // carries the productId in after_data, so the undo endpoint can
      // re-activate the service link and regenerate tasks.
      if (a.action === 'service_remove' && after.productId) {
        const pname = productNameById.get(String(after.productId)) || String(after.productId);
        push(a.created_at, {
          kind: 'service_removed', tone: 'danger',
          title: `Service removed: ${pname}`,
          detail: after.tasksDeleted
            ? `${after.tasksDeleted} recurring task(s) removed`
            : '',
          actor: a.actor_name || a.actor_email || null,
          ref: { kind: 'audit', id: a.id },
          undoable: inUndoWindow,
          undoAction: 'service_restore',
        });
        continue;
      }
      // Relationship removal: new `relationship_remove` audit (carries
      // both the customer-relationship row id and the relationship-type
      // id) is undoable. Legacy `tasks_deleted` audits — pre-dating the
      // endpoint-level audit — still get the friendly label but no
      // button, since the soft-deleted relationship row's id wasn't
      // recorded with them.
      if (a.action === 'relationship_remove' && after.relationshipTypeId) {
        const rname = relTypeNameById.get(String(after.relationshipTypeId)) || String(after.relationshipTypeId);
        push(a.created_at, {
          kind: 'relationship_removed', tone: 'danger',
          title: `Relationship removed: ${rname}`,
          detail: after.tasksDeleted
            ? `${after.tasksDeleted} recurring task(s) removed`
            : '',
          actor: a.actor_name || a.actor_email || null,
          ref: { kind: 'audit', id: a.id },
          undoable: inUndoWindow,
          undoAction: 'relationship_restore',
        });
        continue;
      }
      if (a.action === 'tasks_deleted' && after.relationshipTypeId) {
        const rname = relTypeNameById.get(String(after.relationshipTypeId)) || String(after.relationshipTypeId);
        push(a.created_at, {
          kind: 'relationship_removed', tone: 'warn',
          title: `Relationship removed: ${rname}`,
          detail: after.deleted
            ? `${after.deleted} recurring task(s) removed`
            : '',
          actor: a.actor_name || a.actor_email || null,
          ref: { kind: 'audit', id: a.id },
        });
        continue;
      }

      push(a.created_at, {
        kind: 'audit', tone: 'muted',
        title: `${a.entity}.${a.action}`,
        detail: a.before_data && a.after_data
          ? `${JSON.stringify(a.before_data).slice(0, 100)} → ${JSON.stringify(a.after_data).slice(0, 100)}`
          : '',
        actor: a.actor_name || a.actor_email || null,
        ref: { kind: 'audit', id: a.id },
      });
    }

    events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    res.json({ events: events.slice(0, limit) });
  });

  // ── Phase 4n.21: threaded customer notes ────────────────────────────────
  //
  // Any active employee in the customer's community can view + add notes.
  // Notes are stamped with the author's email/name/role at write time so
  // the timeline survives staff turnover (no FK to tax_employees).
  // Delete is intentionally omitted in v1 — notes are an audit record;
  // edits would defeat that. Owners can soft-delete via SQL if needed.
  router.get('/admin/customers/:id/notes', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const customerId = trim(req.params.id, 200);
    // Scope check: staff can only read notes for customers they're
    // assigned to (or any customer when they're admin). Mirrors the
    // customer-detail visibility already enforced elsewhere.
    if (!(await canEmployeeSeeCustomer(emp, customerId))) {
      return res.status(403).json({ error: 'Not assigned to this customer.' });
    }
    const { data, error } = await supabase.from('tax_customer_notes')
      .select('id, body, author_email, author_name, author_role, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(200);
    if (error) return sendSupabaseError(res, error);
    res.json({ notes: data || [] });
  });

  router.post('/admin/customers/:id/notes', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const customerId = trim(req.params.id, 200);
    const body = trim(req.body?.body || '', MAX_TEXT_LEN);
    if (!body) return res.status(400).json({ error: 'Note body is required.' });
    if (!(await canEmployeeSeeCustomer(emp, customerId))) {
      return res.status(403).json({ error: 'Not assigned to this customer.' });
    }
    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });
    if (cust.community_id !== emp.community_id) {
      return res.status(403).json({ error: 'Customer is in a different community.' });
    }

    const noteId = 'note_' + uuidv4().slice(0, 12);
    const row = {
      id: noteId, community_id: cust.community_id, customer_id: customerId,
      body,
      author_email: emp.email || '',
      author_name:  emp.name || emp.email || '',
      author_role:  emp.role === 'admin' ? 'admin' : 'staff',
    };
    const { error } = await supabase.from('tax_customer_notes').insert(row);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.customer_note', entityId: noteId, action: 'create',
        actorEmail: emp.email || '', actorName: emp.name || '',
        after: { customerId, length: body.length },
      });
    } catch (_e) {}
    res.json({ ok: true, note: row });
  });

  // ── Task tracker ────────────────────────────────────────────────────────
  // Replaces the owner's spreadsheet workflow. Tasks can be tied to a
  // customer and/or a service (tax_products) or live as practice-wide
  // todos. Status values are editable per community via the status-
  // options endpoints below.

  // GET /admin/task-statuses?communitySlug=
  router.get('/admin/task-statuses', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { data, error } = await supabase.from('tax_task_status_options')
      .select('id, key, label_i18n, color, display_order, is_terminal')
      .eq('community_id', communitySlug)
      .order('display_order', { ascending: true });
    if (error) return sendSupabaseError(res, error);
    res.json({ statuses: data || [] });
  });

  // POST /admin/task-statuses — add a new status option.
  // body: { communitySlug, key, labelI18n, color?, displayOrder?, isTerminal? }
  router.post('/admin/task-statuses', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const key = trim(body.key, 60).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!communitySlug || !key) return res.status(400).json({ error: 'communitySlug and key required.' });
    const labelI18n = (body.labelI18n && typeof body.labelI18n === 'object') ? {
      en: String(body.labelI18n.en || '').slice(0, 80),
      es: String(body.labelI18n.es || '').slice(0, 80),
    } : { en: key, es: key };
    const row = {
      id: 'tas:' + communitySlug + ':' + key,
      community_id: communitySlug,
      key,
      label_i18n: labelI18n,
      color: trim(body.color, 24),
      display_order: Number.isFinite(Number(body.displayOrder)) ? Number(body.displayOrder) : 100,
      is_terminal: !!body.isTerminal,
    };
    const { error } = await supabase.from('tax_task_status_options').insert(row);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true, status: row });
  });

  // PATCH /admin/task-statuses/:id
  router.patch('/admin/task-statuses/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const id = trim(req.params.id, 200);
    const body = req.body || {};
    const update = { updated_at: new Date().toISOString() };
    if (body.labelI18n && typeof body.labelI18n === 'object') {
      update.label_i18n = {
        en: String(body.labelI18n.en || '').slice(0, 80),
        es: String(body.labelI18n.es || '').slice(0, 80),
      };
    }
    if (body.color !== undefined) update.color = trim(body.color, 24);
    if (body.displayOrder !== undefined && Number.isFinite(Number(body.displayOrder))) {
      update.display_order = Number(body.displayOrder);
    }
    if (body.isTerminal !== undefined) update.is_terminal = !!body.isTerminal;
    if (Object.keys(update).length === 1) return res.status(400).json({ error: 'Nothing to update.' });
    const { error } = await supabase.from('tax_task_status_options').update(update).eq('id', id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // DELETE /admin/task-statuses/:id
  // Refuses deletion when tasks still reference the key, to avoid orphans.
  router.delete('/admin/task-statuses/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const id = trim(req.params.id, 200);
    const { data: opt } = await supabase.from('tax_task_status_options')
      .select('community_id, key').eq('id', id).maybeSingle();
    if (!opt) return res.status(404).json({ error: 'Status option not found.' });
    const { count } = await supabase.from('tax_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', opt.community_id).eq('status_key', opt.key);
    if ((count || 0) > 0) {
      return res.status(409).json({
        error: 'status_in_use',
        message: `Cannot delete — ${count} task(s) still use this status.`,
      });
    }
    const { error } = await supabase.from('tax_task_status_options').delete().eq('id', id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // GET /admin/task-suggestions?productSlug=  — default title suggestions.
  router.get('/admin/task-suggestions', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const slug = trim(req.query.productSlug || '', 200);
    res.json({ suggestions: suggestionsForSlug(slug) });
  });

  // GET /admin/tasks — list tasks with filters.
  // Query params: communitySlug (req), status, priority, assignedTo,
  //   customerId, productId, due ('overdue' | 'today' | 'week' | 'all'),
  //   q (substring search), limit (default 200).
  router.get('/admin/tasks', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const communitySlug = trim(req.query.communitySlug, 200) || emp.community_id;

    let q = supabase.from('tax_tasks')
      .select(`
        id, community_id, customer_id, product_id, title, status_key, priority,
        assigned_employee_id, created_by_employee_id, service_auto_task_id,
        due_date, notes, completed_at, created_at, updated_at,
        blocked_by_task_id, requires_review, reviewer_employee_id,
        pending_review_at, reviewed_at, reviewed_by_employee_id, review_note,
        customer:tax_customers ( id, name, business_name, first_name, middle_name, last_name, email, phone, whatsapp, address ),
        product:tax_products ( id, slug, name_i18n, category ),
        auto_task:tax_service_auto_tasks ( id, title_i18n, cadence_kind, anchor_rule ),
        assignee:tax_employees!tax_tasks_assigned_employee_id_fkey ( id, name, email ),
        creator:tax_employees!tax_tasks_created_by_employee_id_fkey ( id, name, email ),
        reviewer:tax_employees!tax_tasks_reviewer_employee_id_fkey ( id, name, email )
      `)
      .eq('community_id', communitySlug)
      .is('archived_at', null);

    // Non-admin staff scope: only tasks assigned to them or to customers
    // they have visibility on. Admin sees everything.
    if (emp.role !== 'admin') {
      const visible = await getVisibleCustomerIdsForEmployee(emp);
      if (Array.isArray(visible)) {
        // Build an OR: assigned to me, OR customer in my scope, OR
        // practice-wide (customer_id IS NULL) and assigned to me.
        if (!visible.length) {
          q = q.eq('assigned_employee_id', emp.id);
        } else {
          q = q.or(`assigned_employee_id.eq.${emp.id},customer_id.in.(${visible.join(',')})`);
        }
      }
    }

    // Filter values can be scalar ("foo") or a comma-list ("foo,bar").
    // Scalars use eq for a clean index hit; multi-value lists use in.
    const applyListFilter = (qIn, raw, column, perItemLen) => {
      const s = trim(raw || '', 2000);
      if (!s) return qIn;
      const ids = s.split(',').map(x => trim(x, perItemLen)).filter(Boolean);
      if (ids.length === 0) return qIn;
      if (ids.length === 1) return qIn.eq(column, ids[0]);
      return qIn.in(column, ids);
    };
    q = applyListFilter(q, req.query.status,     'status_key',           60);
    q = applyListFilter(q, req.query.assignedTo, 'assigned_employee_id', 200);
    q = applyListFilter(q, req.query.customerId, 'customer_id',          200);
    q = applyListFilter(q, req.query.productId,  'product_id',           200);
    // Narrow to tasks whose customer is the chosen type. Pre-resolves
    // matching customer IDs because PostgREST embedded-resource
    // filters get awkward when combined with the customer_id list
    // filter above. Stacks as an intersection with that filter.
    const ctNorm = String(req.query.customerType || '').toLowerCase().trim();
    if (ctNorm === 'business' || ctNorm === 'individual') {
      const { data: matchedCust } = await supabase.from('tax_customers')
        .select('id').eq('community_id', communitySlug).eq('customer_type', ctNorm);
      const matchedIds = (matchedCust || []).map(r => r.id);
      if (!matchedIds.length) return res.json({ tasks: [] });
      q = q.in('customer_id', matchedIds);
    }
    if (req.query.priority) q = q.eq('priority', trim(req.query.priority, 20));
    // Period-rollup drill-down: caller wants every task generated
    // by a specific auto-task on a specific due-date.
    if (req.query.serviceAutoTaskId) {
      q = q.eq('service_auto_task_id', trim(req.query.serviceAutoTaskId, 200));
    }
    if (req.query.dueDateExact) {
      q = q.eq('due_date', trim(req.query.dueDateExact, 20));
    }

    const due = trim(req.query.due, 20);
    if (due === 'overdue') {
      q = q.lt('due_date', new Date().toISOString().slice(0, 10));
    } else if (due === 'today') {
      const today = new Date().toISOString().slice(0, 10);
      q = q.eq('due_date', today);
    } else if (due === 'week') {
      const today = new Date();
      const week = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
      q = q.gte('due_date', today.toISOString().slice(0, 10))
           .lte('due_date', week.toISOString().slice(0, 10));
    } else if (due === 'month' || due === 'month60' || due === 'month90') {
      const days = due === 'month90' ? 90 : (due === 'month60' ? 60 : 30);
      const today = new Date();
      const horizon = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
      q = q.gte('due_date', today.toISOString().slice(0, 10))
           .lte('due_date', horizon.toISOString().slice(0, 10));
    }

    // Search spans the task title and the customer's contact fields:
    // company name, person name, email, phone, WhatsApp, and the
    // free-text portions of the address JSON. Customer-side matches
    // are resolved by pre-fetching matching customer IDs in this
    // community, then OR-joining to the task query so a single search
    // box covers both.
    const search = trim(req.query.q || '', 200);
    if (search) {
      const safe = search.replace(/[,.%_()*]/g, ' ').trim();
      if (safe) {
        const like = `%${safe}%`;
        let matchedCustomerIds = [];
        try {
          const { data: matched } = await supabase.from('tax_customers')
            .select('id')
            .eq('community_id', communitySlug)
            .or([
              `name.ilike.${like}`,
              `business_name.ilike.${like}`,
              `first_name.ilike.${like}`,
              `last_name.ilike.${like}`,
              `email.ilike.${like}`,
              `phone.ilike.${like}`,
              `whatsapp.ilike.${like}`,
              `address::text.ilike.${like}`,
            ].join(','))
            .limit(500);
          matchedCustomerIds = (matched || []).map(r => r.id);
        } catch (e) {
          warn('[tax-tasks-search] customer prefetch failed', e?.message || e);
        }
        const orClauses = [`title.ilike.${like}`];
        if (matchedCustomerIds.length) {
          orClauses.push(`customer_id.in.(${matchedCustomerIds.join(',')})`);
        }
        q = q.or(orClauses.join(','));
      }
    }

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    // Sort keys come from the UI's Sort dropdown — see OwnerTasks.
    // The priority key sorts client-side because the underlying column
    // is text with no natural rank ordering. `dueAsc` is the legacy
    // default. Each branch ends with a stable tiebreaker so the same
    // set of tasks doesn't reshuffle between requests.
    const sort = trim(req.query.sort || '', 32);
    if (sort === 'dueDesc') {
      q = q.order('due_date', { ascending: false, nullsFirst: false })
           .order('created_at', { ascending: false });
    } else if (sort === 'createdDesc') {
      q = q.order('created_at', { ascending: false });
    } else if (sort === 'createdAsc') {
      q = q.order('created_at', { ascending: true });
    } else {
      q = q.order('due_date', { ascending: true, nullsFirst: false })
           .order('created_at', { ascending: false });
    }
    q = q.limit(limit);

    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ tasks: data || [] });
  });

  // GET /admin/tasks/periods — rollup view.
  // Groups generator-produced tasks by (service_auto_task_id, due_date)
  // and returns per-period counts so a practice with hundreds of
  // customers can see "Monthly Reconciliation — May 2026, 300 total,
  // 220 done" in a single row instead of 300 individual rows. Manual
  // tasks (no auto-task) are excluded — the flat list view is still
  // where those belong.
  //
  // Same filter surface as /admin/tasks (status, assignedTo,
  // customerId, productId, priority, due bucket, q-search) so the
  // FilterBar applies identically. The shared filter machinery sits
  // inline below to keep both endpoints aligned without a refactor.
  router.get('/admin/tasks/periods', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const communitySlug = trim(req.query.communitySlug, 200) || emp.community_id;

    let q = supabase.from('tax_tasks')
      .select(`
        id, customer_id, service_auto_task_id, product_id,
        status_key, priority, due_date, completed_at,
        product:tax_products ( id, slug, name_i18n ),
        auto_task:tax_service_auto_tasks ( id, title_i18n, default_priority, cadence_kind, anchor_rule )
      `)
      .eq('community_id', communitySlug)
      .is('archived_at', null)
      .not('service_auto_task_id', 'is', null);

    if (emp.role !== 'admin') {
      const visible = await getVisibleCustomerIdsForEmployee(emp);
      if (Array.isArray(visible)) {
        if (!visible.length) {
          q = q.eq('assigned_employee_id', emp.id);
        } else {
          q = q.or(`assigned_employee_id.eq.${emp.id},customer_id.in.(${visible.join(',')})`);
        }
      }
    }

    const applyListFilter = (qIn, raw, column, perItemLen) => {
      const s = trim(raw || '', 2000);
      if (!s) return qIn;
      const ids = s.split(',').map(x => trim(x, perItemLen)).filter(Boolean);
      if (ids.length === 0) return qIn;
      if (ids.length === 1) return qIn.eq(column, ids[0]);
      return qIn.in(column, ids);
    };
    q = applyListFilter(q, req.query.status,     'status_key',           60);
    q = applyListFilter(q, req.query.assignedTo, 'assigned_employee_id', 200);
    q = applyListFilter(q, req.query.customerId, 'customer_id',          200);
    q = applyListFilter(q, req.query.productId,  'product_id',           200);
    // Same customer-type filter as /admin/tasks above so the Periods
    // view stays in sync when the owner picks Individual / Business.
    const ctNormP = String(req.query.customerType || '').toLowerCase().trim();
    if (ctNormP === 'business' || ctNormP === 'individual') {
      const { data: matchedCust } = await supabase.from('tax_customers')
        .select('id').eq('community_id', communitySlug).eq('customer_type', ctNormP);
      const matchedIds = (matchedCust || []).map(r => r.id);
      if (!matchedIds.length) return res.json({ periods: [] });
      q = q.in('customer_id', matchedIds);
    }
    if (req.query.priority) q = q.eq('priority', trim(req.query.priority, 20));

    const due = trim(req.query.due, 20);
    const today = new Date().toISOString().slice(0, 10);
    if (due === 'overdue') {
      q = q.lt('due_date', today);
    } else if (due === 'today') {
      q = q.eq('due_date', today);
    } else if (due === 'week') {
      const w = new Date(); w.setUTCDate(w.getUTCDate() + 7);
      q = q.gte('due_date', today).lte('due_date', w.toISOString().slice(0, 10));
    } else if (due === 'month' || due === 'month60' || due === 'month90') {
      const days = due === 'month90' ? 90 : (due === 'month60' ? 60 : 30);
      const h = new Date(); h.setUTCDate(h.getUTCDate() + days);
      q = q.gte('due_date', today).lte('due_date', h.toISOString().slice(0, 10));
    }

    // Bumped limit — rollup is the whole point at large scale and we
    // only pull a thin column slice. 10k rows ≈ 1.5MB on the wire
    // which is still well within range.
    q = q.limit(10000);

    const { data: rows, error } = await q;
    if (error) return sendSupabaseError(res, error);

    const { data: statusOpts } = await supabase.from('tax_task_status_options')
      .select('key, is_terminal').eq('community_id', communitySlug);
    const terminalKeys = new Set((statusOpts || []).filter(s => s.is_terminal).map(s => s.key));

    const groups = new Map();
    for (const r of rows || []) {
      const key = `${r.service_auto_task_id}|${r.due_date || ''}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          serviceAutoTaskId: r.service_auto_task_id,
          dueDate: r.due_date || null,
          product: r.product || null,
          autoTask: r.auto_task || null,
          totals: { open: 0, in_progress: 0, done: 0, overdue: 0, total: 0 },
          // Highest priority seen in the group — drives the row's
          // priority badge in the UI.
          topPriority: 'low',
        };
        groups.set(key, g);
      }
      const isDone = !!r.completed_at || terminalKeys.has(r.status_key);
      const isOverdue = !isDone && r.due_date && r.due_date < today;
      const isInProgress = !isDone && r.status_key === 'in_progress';
      g.totals.total++;
      if (isDone) g.totals.done++;
      else if (isInProgress) g.totals.in_progress++;
      else g.totals.open++;
      if (isOverdue) g.totals.overdue++;
      const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
      if ((rank[r.priority] ?? 9) < (rank[g.topPriority] ?? 9)) {
        g.topPriority = r.priority;
      }
    }

    // Sort: overdue first, then by due date ascending, then by service.
    const periods = Array.from(groups.values()).sort((a, b) => {
      const ao = a.totals.overdue > 0 ? 0 : 1;
      const bo = b.totals.overdue > 0 ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ad = a.dueDate || '9999-12-31';
      const bd = b.dueDate || '9999-12-31';
      if (ad !== bd) return ad.localeCompare(bd);
      const an = a.product?.name_i18n?.en || a.product?.slug || '';
      const bn = b.product?.name_i18n?.en || b.product?.slug || '';
      return an.localeCompare(bn);
    });

    res.json({ periods });
  });

  // POST /admin/tasks — create.
  router.post('/admin/tasks', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200) || emp.community_id;
    if (communitySlug !== emp.community_id && emp.role !== 'admin') {
      return res.status(403).json({ error: 'Cross-community task creation requires admin.' });
    }
    const title = trim(body.title, 300);
    if (!title) return res.status(400).json({ error: 'Task title is required.' });

    const customerId = trim(body.customerId || '', 200) || null;
    if (customerId && !(await canEmployeeSeeCustomer(emp, customerId))) {
      return res.status(403).json({ error: 'Not assigned to this customer.' });
    }
    const productId   = trim(body.productId   || '', 200) || null;
    const statusKey   = trim(body.statusKey   || 'not_started', 60);
    const priority    = ['urgent','high','normal','low'].includes(body.priority) ? body.priority : 'normal';
    const assignedTo  = trim(body.assignedEmployeeId || '', 200) || null;
    const dueDate     = body.dueDate ? String(body.dueDate).slice(0, 10) : null;
    const notes       = trim(body.notes || '', MAX_TEXT_LEN);

    const id = 'task_' + uuidv4().slice(0, 16);
    const row = {
      id,
      community_id: communitySlug,
      customer_id: customerId,
      product_id: productId,
      title,
      status_key: statusKey,
      priority,
      assigned_employee_id: assignedTo,
      created_by_employee_id: emp.id,
      due_date: dueDate,
      notes,
    };
    const { error } = await supabase.from('tax_tasks').insert(row);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.task', entityId: id, action: 'create',
        actorEmail: emp.email || '', actorName: emp.name || '',
        after: { title, customerId, productId, assignedTo, dueDate, priority, statusKey },
      });
    } catch (_e) {}
    if (assignedTo) {
      await notifyTaskAssignee({ taskId: id, newAssigneeId: assignedTo, prevAssigneeId: null, actor: emp });
    }
    res.json({ ok: true, id, task: row });
  });

  // PATCH /admin/tasks/:id — partial update.
  router.patch('/admin/tasks/:id', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const taskId = trim(req.params.id, 200);
    const body = req.body || {};

    const { data: cur, error: cErr } = await supabase.from('tax_tasks')
      .select('id, community_id, customer_id, assigned_employee_id, status_key, notes, blocked_by_task_id, requires_review, reviewer_employee_id, pending_review_at, reviewed_at')
      .eq('id', taskId).maybeSingle();
    if (cErr) return sendSupabaseError(res, cErr);
    if (!cur) return res.status(404).json({ error: 'Task not found.' });
    if (cur.community_id !== emp.community_id) return res.status(403).json({ error: 'Wrong community.' });
    if (emp.role !== 'admin') {
      // staff can edit tasks they own or that are scoped to a customer they see
      const isMine = cur.assigned_employee_id === emp.id;
      const inScope = cur.customer_id && (await canEmployeeSeeCustomer(emp, cur.customer_id));
      if (!isMine && !inScope) {
        return res.status(403).json({ error: 'Not authorized to edit this task.' });
      }
    }

    const update = { updated_at: new Date().toISOString() };
    if (body.title !== undefined)              update.title = trim(body.title, 300);
    if (body.statusKey !== undefined)          update.status_key = trim(body.statusKey, 60);
    if (body.priority !== undefined && ['urgent','high','normal','low'].includes(body.priority)) {
      update.priority = body.priority;
    }
    if (body.assignedEmployeeId !== undefined) update.assigned_employee_id = trim(body.assignedEmployeeId || '', 200) || null;
    if (body.customerId !== undefined)         update.customer_id = trim(body.customerId || '', 200) || null;
    if (body.productId !== undefined)          update.product_id = trim(body.productId || '', 200) || null;
    if (body.dueDate !== undefined)            update.due_date = body.dueDate ? String(body.dueDate).slice(0, 10) : null;
    if (body.notes !== undefined)              update.notes = trim(body.notes || '', MAX_TEXT_LEN);
    // Phase 4n.56: dependencies + review queue.
    if (body.blockedByTaskId !== undefined) {
      const v = trim(body.blockedByTaskId || '', 200);
      if (v === taskId) return res.status(400).json({ error: 'A task cannot block itself.' });
      update.blocked_by_task_id = v || null;
    }
    if (body.requiresReview !== undefined) update.requires_review = !!body.requiresReview;
    if (body.reviewerEmployeeId !== undefined) {
      update.reviewer_employee_id = trim(body.reviewerEmployeeId || '', 200) || null;
    }

    // Auto-stamp completed_at when moving into a terminal status. Two
    // gates run first:
    //   1) Blocker must be completed — refusing the transition surfaces
    //      a clear "Finish X before completing this" error.
    //   2) When requires_review is on, hold the task in pending-review
    //      state instead of completing. The status_key still moves
    //      (so the board reflects the preparer's call), but completed_at
    //      stays null until the reviewer approves via /admin/tasks/:id/review.
    if (update.status_key && update.status_key !== cur.status_key) {
      const { data: opt } = await supabase.from('tax_task_status_options')
        .select('is_terminal').eq('community_id', cur.community_id).eq('key', update.status_key).maybeSingle();
      if (opt?.is_terminal) {
        const effectiveNotes = (body.notes !== undefined
          ? String(body.notes || '')
          : String(cur.notes || ''));
        if (!effectiveNotes.trim()) {
          return res.status(400).json({
            error: 'notes_required_on_complete',
            message: 'Add a note describing what was done before completing this task.',
          });
        }
        if (cur.blocked_by_task_id) {
          const { data: blocker } = await supabase.from('tax_tasks')
            .select('id, title, completed_at').eq('id', cur.blocked_by_task_id).maybeSingle();
          if (blocker && !blocker.completed_at) {
            return res.status(400).json({
              error: 'task_blocked',
              message: `Complete "${blocker.title}" first — this task depends on it.`,
              blockerId: blocker.id,
            });
          }
        }
        const stillRequiresReview = (update.requires_review !== undefined
          ? update.requires_review : cur.requires_review)
          && !cur.reviewed_at;
        if (stillRequiresReview) {
          update.pending_review_at = new Date().toISOString();
          // completed_at stays null until the reviewer approves.
        } else {
          update.completed_at = new Date().toISOString();
        }
      } else {
        update.completed_at = null;
        // Re-opening a previously pending task clears the in-flight
        // review state — reviewer has to re-approve once it's done again.
        if (cur.pending_review_at && !cur.reviewed_at) {
          update.pending_review_at = null;
        }
      }
    }

    if (Object.keys(update).length === 1) return res.status(400).json({ error: 'Nothing to update.' });

    const { error } = await supabase.from('tax_tasks').update(update).eq('id', taskId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.task', entityId: taskId, action: 'update',
        actorEmail: emp.email || '', actorName: emp.name || '',
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}
    if (Object.prototype.hasOwnProperty.call(update, 'assigned_employee_id')) {
      await notifyTaskAssignee({
        taskId,
        newAssigneeId: update.assigned_employee_id,
        prevAssigneeId: cur.assigned_employee_id,
        actor: emp,
      });
    }
    res.json({ ok: true });
  });

  // POST /admin/tasks/:id/review
  // Body: { decision: 'approve'|'reject', note?: string }
  // The designated reviewer (or any admin) signs off on a task sitting
  // in pending-review state. Approve completes the task; reject clears
  // pending_review_at + stores the rejection note so the preparer can
  // pick it back up.
  router.post('/admin/tasks/:id/review', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const taskId = trim(req.params.id, 200);
    const decision = trim(req.body?.decision, 40);
    const note = trim(req.body?.note, MAX_TEXT_LEN);
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approve or reject.' });
    }
    const { data: cur } = await supabase.from('tax_tasks')
      .select('id, community_id, reviewer_employee_id, pending_review_at, reviewed_at, status_key, notes')
      .eq('id', taskId).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Task not found.' });
    if (cur.community_id !== emp.community_id) return res.status(403).json({ error: 'Wrong community.' });
    // Reviewer or admin can sign off. Staff who happen to be assigned
    // to the task but aren't the designated reviewer can't approve
    // their own work — separation of duties is the point of the queue.
    const isReviewer = cur.reviewer_employee_id && cur.reviewer_employee_id === emp.id;
    if (emp.role !== 'admin' && !isReviewer) {
      return res.status(403).json({ error: 'Only the designated reviewer (or an admin) can review this task.' });
    }
    if (!cur.pending_review_at || cur.reviewed_at) {
      return res.status(409).json({ error: 'This task is not awaiting review.' });
    }
    const nowIso = new Date().toISOString();
    const update = { updated_at: nowIso, review_note: note };
    if (decision === 'approve') {
      update.reviewed_at = nowIso;
      update.reviewed_by_employee_id = emp.id;
      update.completed_at = nowIso;
    } else {
      update.pending_review_at = null; // back to in-flight; preparer fixes and re-completes
    }
    const { error } = await supabase.from('tax_tasks').update(update).eq('id', taskId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.task', entityId: taskId, action: `review_${decision}`,
        actorEmail: emp.email || '', actorName: emp.name || '',
        after: { note: note ? note.slice(0, 200) : '' },
      });
    } catch (_e) {}
    res.json({ ok: true, decision });
  });

  // GET /admin/tasks/awaiting-review
  // Today-dashboard widget data: tasks where the caller is the
  // reviewer and pending_review_at is set but reviewed_at isn't.
  // Admins see every task awaiting review in their community.
  router.get('/admin/tasks/awaiting-review', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    let q = supabase.from('tax_tasks')
      .select(`
        id, title, due_date, priority, status_key, customer_id, product_id, pending_review_at,
        customer:tax_customers ( id, name, business_name, first_name, last_name, email ),
        product:tax_products ( id, slug, name_i18n ),
        assigned_employee:tax_employees!tax_tasks_assigned_employee_id_fkey ( id, name, first_name, last_name, email )
      `)
      .eq('community_id', emp.community_id)
      .not('pending_review_at', 'is', null)
      .is('reviewed_at', null)
      .is('archived_at', null)
      .order('pending_review_at', { ascending: true })
      .limit(50);
    if (emp.role !== 'admin') q = q.eq('reviewer_employee_id', emp.id);
    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ tasks: data || [] });
  });

  // PATCH /admin/tasks/bulk — apply the same patch to many tasks.
  // Body: { ids: ['task_xxx', ...], patch: { statusKey?, priority?,
  //         assignedEmployeeId? } }. Scoped to the caller's
  // community; tasks outside it are dropped silently. For non-admin
  // staff the per-task scope rule (ownership or customer
  // visibility) applies — out-of-scope IDs are dropped.
  router.patch('/admin/tasks/bulk', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const body = req.body || {};
    const ids = Array.isArray(body.ids)
      ? body.ids.map(x => trim(x, 200)).filter(Boolean).slice(0, 500)
      : [];
    if (!ids.length) return res.status(400).json({ error: 'No task IDs supplied.' });
    const patch = body.patch || {};

    const update = { updated_at: new Date().toISOString() };
    if (patch.statusKey !== undefined) update.status_key = trim(patch.statusKey, 60);
    if (patch.priority !== undefined && ['urgent','high','normal','low'].includes(patch.priority)) {
      update.priority = patch.priority;
    }
    if (patch.assignedEmployeeId !== undefined) {
      update.assigned_employee_id = trim(patch.assignedEmployeeId || '', 200) || null;
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    // Load current rows so we can filter by scope and stamp
    // completed_at correctly per row when the new status is
    // terminal.
    const { data: rows, error: selErr } = await supabase.from('tax_tasks')
      .select('id, community_id, customer_id, assigned_employee_id, status_key')
      .in('id', ids);
    if (selErr) return sendSupabaseError(res, selErr);

    let allowedIds = (rows || []).filter(r => r.community_id === emp.community_id).map(r => r.id);
    if (emp.role !== 'admin') {
      const visible = await getVisibleCustomerIdsForEmployee(emp);
      const visSet = Array.isArray(visible) ? new Set(visible) : null;
      allowedIds = (rows || [])
        .filter(r => r.community_id === emp.community_id)
        .filter(r => r.assigned_employee_id === emp.id
                  || (r.customer_id && visSet && visSet.has(r.customer_id)))
        .map(r => r.id);
    }
    if (!allowedIds.length) return res.json({ ok: true, updated: 0 });

    // Resolve terminal-ness for the new status_key (single fetch
    // applied uniformly across the batch).
    let setCompletedAt = null;
    let clearCompletedAt = false;
    if (update.status_key) {
      const { data: opt } = await supabase.from('tax_task_status_options')
        .select('is_terminal')
        .eq('community_id', emp.community_id)
        .eq('key', update.status_key)
        .maybeSingle();
      if (opt?.is_terminal) {
        // Completion requires notes — bulk-complete only works when the
        // owner can stamp a common closing note across the batch (e.g.
        // "Q1 returns filed"). Tasks are completed one at a time
        // otherwise so each row's notes are meaningful on their own.
        return res.status(400).json({
          error: 'bulk_complete_unsupported',
          message: 'Bulk completion is disabled — complete tasks individually so each has a closing note.',
        });
      }
      clearCompletedAt = true;
    }

    const finalUpdate = { ...update };
    if (setCompletedAt) finalUpdate.completed_at = setCompletedAt;
    else if (clearCompletedAt) finalUpdate.completed_at = null;

    const { error } = await supabase.from('tax_tasks')
      .update(finalUpdate).in('id', allowedIds);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.task', entityId: 'bulk', action: 'bulk_update',
        actorEmail: emp.email || '', actorName: emp.name || '',
        after: { ids: allowedIds.length, fields: Object.keys(update).filter(k => k !== 'updated_at') },
      });
    } catch (_e) {}

    // Fire one assignment notification per row that actually changed
    // assignee. Skip rows where the assignee already matched the patch
    // so a bulk status flip doesn't email the prior owner about
    // "their" task again.
    if (Object.prototype.hasOwnProperty.call(update, 'assigned_employee_id')) {
      const newAssigneeId = update.assigned_employee_id;
      const allowedSet = new Set(allowedIds);
      const changed = (rows || []).filter(r =>
        allowedSet.has(r.id) && r.assigned_employee_id !== newAssigneeId);
      // Best-effort, fire-and-forget per row so we don't slow the
      // response on a 100-row bulk reassign.
      for (const r of changed) {
        notifyTaskAssignee({
          taskId: r.id, newAssigneeId,
          prevAssigneeId: r.assigned_employee_id, actor: emp,
        }).catch(() => {});
      }
    }

    res.json({ ok: true, updated: allowedIds.length });
  });

  // DELETE /admin/tasks/:id — admin-only by default. Staff can edit /
  // complete a task they're assigned to but cannot remove it; an owner
  // who wants to delegate deletion can promote the employee to admin
  // or grant the action through a future permission key.
  router.delete('/admin/tasks/:id', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const taskId = trim(req.params.id, 200);
    const { data: cur } = await supabase.from('tax_tasks')
      .select('id, community_id, assigned_employee_id, created_by_employee_id').eq('id', taskId).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Task not found.' });
    if (cur.community_id !== emp.community_id) return res.status(403).json({ error: 'Wrong community.' });
    if (emp.role !== 'admin') {
      return res.status(403).json({ error: 'task_delete_admin_only',
        message: 'Only an admin can delete a task.' });
    }
    const { error } = await supabase.from('tax_tasks').delete().eq('id', taskId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.task', entityId: taskId, action: 'delete',
        actorEmail: emp.email || '', actorName: emp.name || '',
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── Phase 4n.55: per-task time tracking ────────────────────────────────
  //
  // Time entries are individual start/stop intervals an employee logs on
  // a task. Running timers leave ended_at null; the partial unique index
  // on (employee_id) where ended_at is null enforces one-running-at-a-
  // time at the DB layer. Closed entries store duration_seconds so
  // reports don't have to subtract timestamps on every read.

  // Visibility rule for time entries: assigned employee + admins can
  // always log; staff can only edit/delete their own entries.
  async function canEmployeeLogTimeOnTask(emp, task) {
    if (!emp || !task) return false;
    if (task.community_id !== emp.community_id) return false;
    if (emp.role === 'admin') return true;
    if (task.assigned_employee_id === emp.id) return true;
    if (task.created_by_employee_id === emp.id) return true;
    // Staff with customer-level access to this task's customer can log
    // time even when the task isn't directly assigned to them.
    if (task.customer_id) {
      return await canEmployeeSeeCustomer(emp, task.customer_id);
    }
    return false;
  }

  function calcDurationSeconds(startedAt, endedAt) {
    const s = new Date(startedAt).getTime();
    const e = new Date(endedAt).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
    return Math.max(0, Math.round((e - s) / 1000));
  }

  router.get('/admin/tasks/:id/time-entries', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const taskId = trim(req.params.id, 200);
    const { data: task } = await supabase.from('tax_tasks')
      .select('id, community_id, customer_id, assigned_employee_id, created_by_employee_id').eq('id', taskId).maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (task.community_id !== emp.community_id) return res.status(403).json({ error: 'Wrong community.' });
    const { data: entries, error } = await supabase.from('tax_task_time_entries')
      .select(`
        id, task_id, employee_id, started_at, ended_at, duration_seconds, note, billable, created_at,
        employee:tax_employees ( id, name, first_name, last_name, email )
      `)
      .eq('task_id', taskId)
      .order('started_at', { ascending: false }).limit(200);
    if (error) return sendSupabaseError(res, error);
    const total = (entries || []).reduce((acc, e) => {
      if (e.ended_at) return acc + (e.duration_seconds || 0);
      // Include the running portion of an in-flight timer so the total
      // moves while a timer is on.
      const live = calcDurationSeconds(e.started_at, new Date().toISOString());
      return acc + live;
    }, 0);
    res.json({ entries: entries || [], total_seconds: total });
  });

  // Start a timer. Caller's currently-running entry (across any task)
  // is stopped first so the one-running invariant holds even when the
  // employee forgets to stop the previous one — the closed entry keeps
  // its original start/stop on the prior task.
  router.post('/admin/tasks/:id/time-entries/start', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const taskId = trim(req.params.id, 200);
    const note = trim(req.body?.note, MAX_TEXT_LEN);
    const { data: task } = await supabase.from('tax_tasks')
      .select('id, community_id, customer_id, assigned_employee_id, created_by_employee_id').eq('id', taskId).maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!(await canEmployeeLogTimeOnTask(emp, task))) {
      return res.status(403).json({ error: 'Not allowed to log time on this task.' });
    }

    const nowIso = new Date().toISOString();
    // Auto-stop any in-flight timer for this employee on any task.
    const { data: running } = await supabase.from('tax_task_time_entries')
      .select('id, started_at').eq('employee_id', emp.id).is('ended_at', null).limit(1);
    if (running && running.length) {
      const r = running[0];
      const dur = calcDurationSeconds(r.started_at, nowIso);
      await supabase.from('tax_task_time_entries').update({
        ended_at: nowIso, duration_seconds: dur, updated_at: nowIso,
      }).eq('id', r.id);
    }

    const id = 'tt_' + uuidv4().slice(0, 16);
    const { data: row, error } = await supabase.from('tax_task_time_entries').insert({
      id, community_id: task.community_id, task_id: taskId, employee_id: emp.id,
      started_at: nowIso, note, billable: true,
    }).select('id, task_id, employee_id, started_at, ended_at, duration_seconds, note, billable')
      .maybeSingle();
    if (error) return sendSupabaseError(res, error);
    res.json({ entry: row, stoppedRunningId: running && running[0]?.id || null });
  });

  router.post('/admin/tasks/:id/time-entries/stop', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const taskId = trim(req.params.id, 200);
    const note = req.body?.note !== undefined ? trim(req.body.note, MAX_TEXT_LEN) : null;
    // Find the running entry for this employee on this task. If none,
    // look across all tasks (the UI sometimes calls stop from the
    // header) but only when the body explicitly says so via any=1.
    const { data: running } = await supabase.from('tax_task_time_entries')
      .select('id, started_at, note')
      .eq('employee_id', emp.id).eq('task_id', taskId).is('ended_at', null).limit(1);
    const r = running && running[0];
    if (!r) return res.status(404).json({ error: 'No running timer found for this task.' });
    const nowIso = new Date().toISOString();
    const update = {
      ended_at: nowIso,
      duration_seconds: calcDurationSeconds(r.started_at, nowIso),
      updated_at: nowIso,
    };
    if (note !== null) update.note = note;
    const { error } = await supabase.from('tax_task_time_entries').update(update).eq('id', r.id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true, id: r.id, duration_seconds: update.duration_seconds });
  });

  // Manual entry — owner backfilling time after the fact. Requires
  // both startedAt and endedAt (no open-ended manual entries).
  router.post('/admin/tasks/:id/time-entries', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const taskId = trim(req.params.id, 200);
    const { data: task } = await supabase.from('tax_tasks')
      .select('id, community_id, customer_id, assigned_employee_id, created_by_employee_id').eq('id', taskId).maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!(await canEmployeeLogTimeOnTask(emp, task))) {
      return res.status(403).json({ error: 'Not allowed to log time on this task.' });
    }
    const startedAt = trim(req.body?.startedAt, 50);
    const endedAt   = trim(req.body?.endedAt, 50);
    if (!startedAt || !endedAt) return res.status(400).json({ error: 'startedAt and endedAt required.' });
    const dur = calcDurationSeconds(startedAt, endedAt);
    if (dur <= 0) return res.status(400).json({ error: 'endedAt must be after startedAt.' });
    if (dur > 24 * 3600 * 7) return res.status(400).json({ error: 'Time entry longer than a week — split it into separate rows.' });
    const billable = req.body?.billable === false ? false : true;
    const note = trim(req.body?.note, MAX_TEXT_LEN);
    // Allow logging on behalf of another employee — admins only — via
    // employeeId in the body. Staff always log under their own id.
    let employeeId = emp.id;
    if (emp.role === 'admin' && req.body?.employeeId) {
      employeeId = trim(req.body.employeeId, 200);
    }
    const id = 'tt_' + uuidv4().slice(0, 16);
    const { data: row, error } = await supabase.from('tax_task_time_entries').insert({
      id, community_id: task.community_id, task_id: taskId, employee_id: employeeId,
      started_at: startedAt, ended_at: endedAt, duration_seconds: dur,
      note, billable,
    }).select('id, task_id, employee_id, started_at, ended_at, duration_seconds, note, billable')
      .maybeSingle();
    if (error) return sendSupabaseError(res, error);
    res.json({ entry: row });
  });

  router.put('/admin/time-entries/:id', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const entryId = trim(req.params.id, 200);
    const { data: cur } = await supabase.from('tax_task_time_entries')
      .select('id, community_id, employee_id, task_id').eq('id', entryId).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Time entry not found.' });
    if (cur.community_id !== emp.community_id) return res.status(403).json({ error: 'Wrong community.' });
    if (emp.role !== 'admin' && cur.employee_id !== emp.id) {
      return res.status(403).json({ error: 'Staff can only edit their own time entries.' });
    }
    const update = { updated_at: new Date().toISOString() };
    if (req.body?.startedAt) update.started_at = trim(req.body.startedAt, 50);
    if (req.body?.endedAt)   update.ended_at   = trim(req.body.endedAt, 50);
    if (update.started_at && update.ended_at) {
      const dur = calcDurationSeconds(update.started_at, update.ended_at);
      if (dur <= 0) return res.status(400).json({ error: 'endedAt must be after startedAt.' });
      update.duration_seconds = dur;
    }
    if (req.body?.note !== undefined)     update.note     = trim(req.body.note, MAX_TEXT_LEN);
    if (req.body?.billable !== undefined) update.billable = !!req.body.billable;
    const { error } = await supabase.from('tax_task_time_entries').update(update).eq('id', entryId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  router.delete('/admin/time-entries/:id', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const entryId = trim(req.params.id, 200);
    const { data: cur } = await supabase.from('tax_task_time_entries')
      .select('id, community_id, employee_id').eq('id', entryId).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Time entry not found.' });
    if (cur.community_id !== emp.community_id) return res.status(403).json({ error: 'Wrong community.' });
    if (emp.role !== 'admin' && cur.employee_id !== emp.id) {
      return res.status(403).json({ error: 'Staff can only delete their own time entries.' });
    }
    const { error } = await supabase.from('tax_task_time_entries').delete().eq('id', entryId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // GET /admin/employees/me/running-timer — returns the caller's
  // currently in-flight time entry (if any). Lets the employee shell
  // surface a small "timer running on <task>" reminder so they don't
  // forget to stop it at the end of the day.
  router.get('/admin/employees/me/running-timer', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const { data } = await supabase.from('tax_task_time_entries')
      .select(`
        id, task_id, started_at, note,
        task:tax_tasks ( id, title, customer_id )
      `)
      .eq('employee_id', emp.id).is('ended_at', null).limit(1);
    res.json({ running: (data && data[0]) || null });
  });

  // ── Phase 4n.57: smart lists / saved searches ─────────────────────────
  //
  // Each row is one employee's named filter preset on a scope. Server
  // stores + returns the opaque params blob; the page (Tasks / Customers
  // / Leads) owns the shape. List endpoint returns the caller's own
  // rows; create/update/delete are scoped to ownership.
  const SAVED_SEARCH_SCOPES = ['tasks','customers','leads'];

  router.get('/admin/saved-searches', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const scope = trim(req.query.scope, 40);
    let q = supabase.from('tax_saved_searches')
      .select('id, scope, name, params, is_pinned, display_order, created_at, updated_at')
      .eq('community_id', emp.community_id)
      .eq('employee_id', emp.id)
      .order('display_order', { ascending: true })
      .order('created_at',   { ascending: true });
    if (scope) {
      if (!SAVED_SEARCH_SCOPES.includes(scope)) {
        return res.status(400).json({ error: 'Invalid scope.' });
      }
      q = q.eq('scope', scope);
    }
    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ searches: data || [] });
  });

  router.post('/admin/saved-searches', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const body = req.body || {};
    const scope = trim(body.scope, 40);
    const name = trim(body.name, 120);
    if (!SAVED_SEARCH_SCOPES.includes(scope)) return res.status(400).json({ error: 'Invalid scope.' });
    if (!name) return res.status(400).json({ error: 'name required.' });
    const params = (body.params && typeof body.params === 'object') ? body.params : {};
    // Caller-supplied params can be arbitrary client state; cap the
    // serialized size so a misbehaving client can't store megabytes
    // per row. 4KB is generous for a filter preset.
    if (JSON.stringify(params).length > 4096) {
      return res.status(413).json({ error: 'params too large (max 4KB).' });
    }
    const id = 'ss_' + uuidv4().slice(0, 12);
    const { data, error } = await supabase.from('tax_saved_searches').insert({
      id, community_id: emp.community_id, employee_id: emp.id,
      scope, name, params,
      is_pinned: !!body.isPinned,
      display_order: Number.isFinite(Number(body.displayOrder)) ? Math.round(Number(body.displayOrder)) : 0,
    }).select('id, scope, name, params, is_pinned, display_order')
      .maybeSingle();
    if (error) return sendSupabaseError(res, error);
    res.json({ search: data });
  });

  router.put('/admin/saved-searches/:id', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const id = trim(req.params.id, 200);
    const { data: cur } = await supabase.from('tax_saved_searches')
      .select('id, employee_id, community_id').eq('id', id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Saved search not found.' });
    if (cur.employee_id !== emp.id) {
      return res.status(403).json({ error: 'You can only edit your own saved searches.' });
    }
    const body = req.body || {};
    const update = { updated_at: new Date().toISOString() };
    if (body.name !== undefined)         update.name = trim(body.name, 120);
    if (body.params !== undefined) {
      const p = (body.params && typeof body.params === 'object') ? body.params : {};
      if (JSON.stringify(p).length > 4096) {
        return res.status(413).json({ error: 'params too large (max 4KB).' });
      }
      update.params = p;
    }
    if (body.isPinned !== undefined)     update.is_pinned = !!body.isPinned;
    if (body.displayOrder !== undefined) update.display_order = Math.round(Number(body.displayOrder) || 0);
    const { error } = await supabase.from('tax_saved_searches').update(update).eq('id', id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  router.delete('/admin/saved-searches/:id', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const id = trim(req.params.id, 200);
    const { data: cur } = await supabase.from('tax_saved_searches')
      .select('id, employee_id').eq('id', id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Saved search not found.' });
    if (cur.employee_id !== emp.id) {
      return res.status(403).json({ error: 'You can only delete your own saved searches.' });
    }
    const { error } = await supabase.from('tax_saved_searches').delete().eq('id', id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── Phase 4n.24: e-signature requests ──────────────────────────────────
  //
  // Owner creates a request → customer sees it in the portal → customer
  // reviews + types their legal name + clicks "I agree" → status flips
  // to 'signed' with the typed name + IP + timestamp captured. ESIGN-Act
  // compliant: typed name + clear consent language + audit trail = a
  // valid e-signature in the US (and Colombia's Ley 527).
  router.get('/admin/customers/:id/signature-requests', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const customerId = trim(req.params.id, 200);
    if (!(await canEmployeeSeeCustomer(emp, customerId))) {
      return res.status(403).json({ error: 'Not assigned to this customer.' });
    }
    const { data, error } = await supabase.from('tax_signature_requests')
      .select('id, title, description, status, expires_at, signed_at, signer_name, signer_email, requested_by_email, requested_by_name, document_id, cancelled_at, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(100);
    if (error) return sendSupabaseError(res, error);
    res.json({ requests: data || [] });
  });

  router.post('/admin/customers/:id/signature-requests', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const customerId = trim(req.params.id, 200);
    if (!(await canEmployeeSeeCustomer(emp, customerId))) {
      return res.status(403).json({ error: 'Not assigned to this customer.' });
    }
    const body = req.body || {};
    const title = trim(body.title || '', 300);
    if (!title) return res.status(400).json({ error: 'title required.' });
    const description = trim(body.description || '', MAX_TEXT_LEN * 4);
    const consentText = trim(body.consentText || '', MAX_TEXT_LEN * 2)
      || `By typing my name and clicking "I agree", I acknowledge that this constitutes my legal electronic signature under the U.S. ESIGN Act and applicable state and international laws. I have read and agree to the contents of "${title}".`;
    const documentId = trim(body.documentId || '', 200) || null;
    let expiresAt = null;
    if (body.expiresAt) {
      const d = new Date(body.expiresAt);
      if (!isNaN(d)) expiresAt = d.toISOString();
    }

    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    const id = 'sig_' + uuidv4().slice(0, 12);
    const row = {
      id, community_id: cust.community_id, customer_id: customerId,
      title, description, consent_text: consentText,
      document_id: documentId,
      requested_by_email: emp.email || '',
      requested_by_name:  emp.name || emp.email || '',
      expires_at: expiresAt,
      status: 'pending',
    };
    const { error } = await supabase.from('tax_signature_requests').insert(row);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.signature_request', entityId: id, action: 'create',
        actorEmail: emp.email || '', actorName: emp.name || '',
        after: { customerId, title, hasDoc: !!documentId },
      });
    } catch (_e) {}

    // Phase 4n.25: email the customer so they're not waiting for a coincidence
    // login to discover the request. Resolution failure here is non-fatal —
    // we want the request to exist even if the email is misconfigured.
    let emailResult = { sent: false, skipped: true };
    if (typeof sendTaxSignatureRequestEmail === 'function'
        && await communityEmailFlag(emp.community_id, 'tax_email_signature_enabled')) {
      try {
        const [{ data: cust }, { data: community }] = await Promise.all([
          supabase.from('tax_customers')
            .select('id, community_id, email, name, locale, preferred_communication_email')
            .eq('id', customerId).maybeSingle(),
          supabase.from('communities')
            .select('id, name').eq('id', cust?.community_id || emp.community_id).maybeSingle(),
        ]);
        if (cust) {
          const signUrl = await customerLandingOrPortalUrl(cust.community_id, `/sign/${encodeURIComponent(id)}`);
          emailResult = await sendTaxSignatureRequestEmail({
            cust, community, request: row, signUrl,
          });
        }
      } catch (e) { warn('[tax-sig] request email failed', e?.message || e); }
    } else {
      emailResult = { sent: false, skipped: true, reason: 'signature_emails_disabled' };
    }
    res.json({ ok: true, request: row, customerEmail: emailResult });
  });

  router.post('/admin/customers/:id/signature-requests/:reqId/cancel', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const customerId = trim(req.params.id, 200);
    const reqId = trim(req.params.reqId, 200);
    if (!(await canEmployeeSeeCustomer(emp, customerId))) {
      return res.status(403).json({ error: 'Not assigned to this customer.' });
    }
    const { data: existing } = await supabase.from('tax_signature_requests')
      .select('id, status, customer_id').eq('id', reqId).maybeSingle();
    if (!existing || existing.customer_id !== customerId) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: `Cannot cancel a ${existing.status} request.` });
    }
    const { error } = await supabase.from('tax_signature_requests').update({
      status: 'cancelled', cancelled_at: new Date().toISOString(),
      cancelled_by_email: emp.email || '', updated_at: new Date().toISOString(),
    }).eq('id', reqId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.signature_request', entityId: reqId, action: 'cancel',
        actorEmail: emp.email || '',
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // Customer-facing list — pending + completed for THIS signed-in customer.
  router.get('/portal/signature-requests', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const { data, error } = await supabase.from('tax_signature_requests')
      .select('id, title, description, status, expires_at, signed_at, requested_by_name, document_id, created_at')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false }).limit(100);
    if (error) return sendSupabaseError(res, error);
    res.json({ requests: data || [] });
  });

  router.get('/portal/signature-requests/:id', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const reqId = trim(req.params.id, 200);
    const { data: r, error } = await supabase.from('tax_signature_requests')
      .select('*').eq('id', reqId).maybeSingle();
    if (error) return sendSupabaseError(res, error);
    if (!r || r.customer_id !== customer.id) {
      return res.status(404).json({ error: 'Signature request not found.' });
    }
    res.json({ request: r });
  });

  router.post('/portal/signature-requests/:id/sign', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const reqId = trim(req.params.id, 200);
    const body = req.body || {};
    const signerName = trim(body.signerName || '', 200);
    const consented  = body.consented === true || body.consented === 'true';
    if (!signerName) return res.status(400).json({ error: 'Please type your legal name to sign.' });
    if (!consented)  return res.status(400).json({ error: 'You must check the consent box to sign.' });
    // Loose sanity check: typed name should be at least two characters.
    if (signerName.length < 2) return res.status(400).json({ error: 'Name is too short.' });

    const { data: existing } = await supabase.from('tax_signature_requests')
      .select('id, status, customer_id, expires_at, consent_text, title').eq('id', reqId).maybeSingle();
    if (!existing || existing.customer_id !== customer.id) {
      return res.status(404).json({ error: 'Signature request not found.' });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: `This request is already ${existing.status}.` });
    }
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      // Auto-flip to expired on the way out so the next read shows the
      // correct state without needing a cron.
      await supabase.from('tax_signature_requests').update({
        status: 'expired', updated_at: new Date().toISOString(),
      }).eq('id', reqId);
      return res.status(409).json({ error: 'This request has expired.' });
    }

    const ip = trim((req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0], 80);
    const userAgent = trim(req.get('user-agent') || '', 500);
    const signatureData = {
      typed_name: signerName,
      consent_text_snapshot: existing.consent_text || '',
      consent_checked_at: new Date().toISOString(),
      user_agent: userAgent,
    };
    const { error } = await supabase.from('tax_signature_requests').update({
      status: 'signed',
      signed_at: new Date().toISOString(),
      signer_name: signerName,
      signer_email: customer.email,
      signer_ip: ip,
      signature_data: signatureData,
      updated_at: new Date().toISOString(),
    }).eq('id', reqId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.signature_request', entityId: reqId, action: 'sign',
        actorEmail: customer.email, actorName: signerName,
        after: { title: existing.title, ip, userAgent: userAgent.slice(0, 80) },
      });
    } catch (_e) {}

    // Phase 4n.25: notify the practice (admins + assigned staff) per each
    // employee's per-type notification preference. Mirrors the customer-
    // message fan-out at line ~3640 — in-portal row always when the
    // employee's signature_signed pref includes 'in_app', plus an email
    // when the pref includes 'email'.
    try {
      await notifyPracticeSignatureSigned({
        customerId: customer.id, customerEmail: customer.email,
        communityId: customer.community_id,
        requestId: reqId, requestTitle: existing.title,
        signerName,
      });
    } catch (e) { warn('[tax-sig] practice fan-out failed', e?.message || e); }

    res.json({ ok: true });
  });

  // Internal helper for /portal/signature-requests/:id/sign — fans the
  // "customer signed" event out to all employees who should know.
  async function notifyPracticeSignatureSigned({ customerId, customerEmail, communityId, requestId, requestTitle, signerName }) {
    if (!supabase) return;
    const [{ data: cust }, { data: community }, { data: admins }, { data: assignedRows }] = await Promise.all([
      supabase.from('tax_customers')
        .select('id, name, email, community_id').eq('id', customerId).maybeSingle(),
      supabase.from('communities')
        .select('id, name').eq('id', communityId).maybeSingle(),
      supabase.from('tax_employees')
        .select('id, email, name, locale, notification_channels, notification_prefs, permissions, preferred_communication_email, role, status')
        .eq('community_id', communityId).eq('status', 'active').eq('role', 'admin'),
      supabase.from('tax_employee_customer_assignments')
        .select(`
          id,
          employee:tax_employees ( id, email, name, locale, notification_channels, notification_prefs, permissions, preferred_communication_email, role, status )
        `).eq('customer_id', customerId).eq('active', true),
    ]);
    const recipientById = new Map();
    for (const emp of admins || []) recipientById.set(emp.id, emp);
    for (const row of assignedRows || []) {
      const emp = row.employee;
      if (emp && emp.status === 'active' && emp.role === 'staff') {
        recipientById.set(emp.id, emp);
      }
    }
    const empList = [...recipientById.values()];
    const customerUrl = `${typeof publicAppUrl === 'function' ? publicAppUrl() : ''}/tax/${communityId}/employee/customers/${encodeURIComponent(customerId)}`;
    const titleSnippet = (requestTitle || '').slice(0, 80);

    for (const emp of empList) {
      const channels = getEmployeeChannels(emp, 'signature_signed');
      if (channels.includes('in_app')) {
        await supabase.from('tax_employee_notifications').insert({
          id: 'tenot_' + uuidv4().slice(0, 12),
          community_id: communityId,
          employee_id: emp.id,
          type: 'signature_signed',
          title_i18n: {
            es: `${cust?.name || customerEmail} firmó: ${titleSnippet}`,
            en: `${cust?.name || customerEmail} signed: ${titleSnippet}`,
          },
          body_i18n: {
            es: `Firmado por ${signerName}. La firma quedó registrada.`,
            en: `Signed by ${signerName}. Signature has been captured.`,
          },
          payload: { customerId, requestId },
        });
      }
      if (channels.includes('email')
          && typeof sendTaxSignatureSignedEmail === 'function'
          && await communityStaffEmailFlag(community.id, 'tax_staff_email_signature_signed_enabled')) {
        try {
          await sendTaxSignatureSignedEmail({
            emp, customer: cust || { name: '', email: customerEmail },
            community, request: { title: titleSnippet }, customerUrl,
          });
        } catch (e) { warn('[tax-sig] employee email failed', e?.message || e); }
      }
    }
  }

  router.post('/portal/signature-requests/:id/decline', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const reqId = trim(req.params.id, 200);
    const { data: existing } = await supabase.from('tax_signature_requests')
      .select('id, status, customer_id').eq('id', reqId).maybeSingle();
    if (!existing || existing.customer_id !== customer.id) {
      return res.status(404).json({ error: 'Signature request not found.' });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: `Cannot decline a ${existing.status} request.` });
    }
    const { error } = await supabase.from('tax_signature_requests').update({
      status: 'declined', updated_at: new Date().toISOString(),
    }).eq('id', reqId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.signature_request', entityId: reqId, action: 'decline',
        actorEmail: customer.email,
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── GET /admin/customers/:id/relationships ── (global admin)
  router.get('/admin/customers/:id/relationships', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const id = trim(req.params.id, 200);
    const { data, error } = await supabase.from('tax_customer_relationships')
      .select(`
        id, relationship_type_id, notes, active, created_at, created_by_email,
        type:tax_relationship_types ( id, category, slug, name_i18n, display_order )
      `)
      .eq('customer_id', id);
    if (error) return sendSupabaseError(res, error);
    res.json({ relationships: data || [] });
  });

  // GET /admin/customers/:id/default-product
  // Resolves "what product should we pre-fill on a new task for this
  // customer?". Walks the chain
  //   customer → first active relationship (by display_order)
  //         → tax_relationship_workflow_rules (for that relationship type)
  //         → tax_filing_schedules.product_id
  // Returns { productId, productSlug, scheduleSlug, relationshipTypeId, relationshipName_i18n } or
  // { productId: null } if no mapping exists.
  router.get('/admin/customers/:id/default-product', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const id = trim(req.params.id, 200);

    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', id).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });
    if (cust.community_id !== emp.community_id) {
      return res.status(403).json({ error: 'Wrong community.' });
    }
    if (emp.role !== 'admin') {
      const ok = await canEmployeeSeeCustomer(emp, id);
      if (!ok) return res.status(403).json({ error: 'Not assigned to this customer.' });
    }

    const { data: rels } = await supabase.from('tax_customer_relationships')
      .select(`
        relationship_type_id, active,
        type:tax_relationship_types ( id, name_i18n, display_order )
      `)
      .eq('customer_id', id).eq('active', true);
    if (!rels || !rels.length) return res.json({ productId: null });

    const sorted = rels.slice().sort((a, b) =>
      ((a.type?.display_order ?? 999) - (b.type?.display_order ?? 999))
    );
    const first = sorted[0];
    const relTypeId = first.relationship_type_id;

    // Pull workflow rules for this relationship type, preferring the
    // owner-customized override (community_id == cust.community_id) over
    // the global default.
    const { data: rules } = await supabase.from('tax_relationship_workflow_rules')
      .select('id, community_id, filing_schedule_slug, active')
      .eq('relationship_type_id', relTypeId).eq('active', true);
    if (!rules || !rules.length) {
      return res.json({
        productId: null, relationshipTypeId: relTypeId,
        relationshipName_i18n: first.type?.name_i18n || null,
      });
    }
    rules.sort((a, b) => {
      const aCom = a.community_id === cust.community_id ? 0 : 1;
      const bCom = b.community_id === cust.community_id ? 0 : 1;
      return aCom - bCom;
    });
    const rule = rules[0];

    const { data: sched } = await supabase.from('tax_filing_schedules')
      .select('id, slug, product_id, community_id')
      .eq('slug', rule.filing_schedule_slug)
      .eq('community_id', cust.community_id).maybeSingle();
    if (!sched?.product_id) {
      return res.json({
        productId: null, relationshipTypeId: relTypeId,
        relationshipName_i18n: first.type?.name_i18n || null,
        scheduleSlug: rule.filing_schedule_slug,
      });
    }
    const { data: prod } = await supabase.from('tax_products')
      .select('id, slug').eq('id', sched.product_id).maybeSingle();
    res.json({
      productId: sched.product_id,
      productSlug: prod?.slug || null,
      scheduleSlug: sched.slug,
      relationshipTypeId: relTypeId,
      relationshipName_i18n: first.type?.name_i18n || null,
    });
  });

  // ── POST /admin/customers/:id/relationships ── (global admin)
  // ── GET /admin/customers/:id/services ──────────────────────────────────
  // Phase 4n.48: customer ↔ service direct tagging. Replaces the
  // relationship → service indirection for the customer-side flow.
  router.get('/admin/customers/:id/services', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_customers'))) return;
    const customerId = trim(req.params.id, 200);
    const { data, error } = await supabase.from('tax_customer_services')
      .select(`
        id, customer_id, product_id, notes, active, created_at, created_by_email,
        product:tax_products ( id, slug, name_i18n, category )
      `)
      .eq('customer_id', customerId).eq('active', true)
      .order('created_at', { ascending: true });
    if (error) return sendSupabaseError(res, error);
    res.json({ services: data || [] });
  });

  // POST /admin/customers/:id/services
  // Body: { productId, notes? }. Upserts the join row (reactivates
  // any soft-deleted prior row) and immediately fires the task
  // generator for that customer + product.
  router.post('/admin/customers/:id/services', async (req, res) => {
    const actor = await requireOwnerAdmin(req, res, 'manage_customers');
    if (!actor) return;
    const customerId = trim(req.params.id, 200);
    const productId  = trim(req.body?.productId, 200);
    const notes      = trim(req.body?.notes || '', MAX_TEXT_LEN);
    if (!customerId || !productId) {
      return res.status(400).json({ error: 'customerId and productId required.' });
    }
    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });
    const { data: prod } = await supabase.from('tax_products')
      .select('id, community_id').eq('id', productId).maybeSingle();
    if (!prod) return res.status(404).json({ error: 'Service not found.' });
    if (prod.community_id !== cust.community_id) {
      return res.status(403).json({ error: 'Service belongs to a different community.' });
    }
    const rowId = 'ccs_' + uuidv4().slice(0, 16);
    const { error } = await supabase.from('tax_customer_services').upsert({
      id: rowId, community_id: cust.community_id,
      customer_id: customerId, product_id: productId,
      notes, active: true,
      created_by_email: trim(req.get('x-firebase-email') || req.get('x-admin-email') || '', 200).toLowerCase() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'customer_id,product_id' });
    if (error) return sendSupabaseError(res, error);
    let tasksCreated = 0;
    try {
      const r = await generateTasksForService({
        customerId, productId,
        actorEmail: actor.email || '',
      });
      tasksCreated = r.created || 0;
    } catch (e) { warn('[tax-cust-svc-add] task gen failed', e?.message || e); }
    try {
      await auditLog({
        entity: 'tax.customer', entityId: customerId, action: 'service_add',
        actorEmail: actor.email || '',
        after: { productId, tasksCreated },
      });
    } catch (_e) {}
    res.json({ ok: true, tasksCreated });
  });

  // DELETE /admin/customers/:id/services/:linkId
  // Soft-deletes the join (active=false), then hard-deletes any open
  // generator tasks for that (customer, product). Completed tasks
  // (completed_at set) are preserved for history; everything else
  // tied to the removed service goes.
  router.delete('/admin/customers/:id/services/:linkId', async (req, res) => {
    const actor = await requireOwnerAdmin(req, res, 'manage_customers');
    if (!actor) return;
    const customerId = trim(req.params.id, 200);
    const linkId     = trim(req.params.linkId, 200);
    const { data: row } = await supabase.from('tax_customer_services')
      .select('id, customer_id, product_id').eq('id', linkId).maybeSingle();
    if (!row || row.customer_id !== customerId) {
      return res.status(404).json({ error: 'Service link not found.' });
    }
    const { error } = await supabase.from('tax_customer_services')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', linkId);
    if (error) return sendSupabaseError(res, error);
    let tasksDeleted = 0;
    try {
      const r = await removeTasksForService({
        customerId, productId: row.product_id,
        actorEmail: actor.email || '',
      });
      tasksDeleted = r.deleted || 0;
    } catch (e) { warn('[tax-cust-svc-del] task delete failed', e?.message || e); }
    try {
      await auditLog({
        entity: 'tax.customer', entityId: customerId, action: 'service_remove',
        actorEmail: actor.email || '',
        after: { productId: row.product_id, tasksDeleted },
      });
    } catch (_e) {}
    res.json({ ok: true, tasksDeleted });
  });

  // POST /admin/customers/:id/activity/undo
  // Body { auditId }. Reverses an undoable action recorded in the
  // activity timeline. Only `service_remove` is currently undoable;
  // older or non-matching audits return 400 so the owner gets a clear
  // "can't undo this" instead of a silent no-op. Re-uses the
  // generate-tasks helper so the restore lands exactly where the
  // original add would have.
  router.post('/admin/customers/:id/activity/undo', async (req, res) => {
    const actor = await requireOwnerAdmin(req, res, 'manage_customers');
    if (!actor) return;
    const customerId = trim(req.params.id, 200);
    const auditId = trim(req.body?.auditId, 200);
    if (!customerId || !auditId) return res.status(400).json({ error: 'customerId and auditId required.' });

    const { data: audit } = await supabase.from('audit_logs')
      .select('id, entity, entity_id, action, before_data, after_data, created_at')
      .eq('id', auditId).maybeSingle();
    if (!audit) return res.status(404).json({ error: 'Audit row not found.' });
    if (audit.entity !== 'tax.customer' || String(audit.entity_id) !== String(customerId)) {
      return res.status(403).json({ error: 'Audit row does not belong to this customer.' });
    }
    const ageMs = Date.now() - new Date(audit.created_at).getTime();
    if (!(ageMs >= 0 && ageMs <= 7 * 24 * 60 * 60 * 1000)) {
      return res.status(400).json({ error: 'undo_window_expired',
        message: 'This action is older than the undo window (7 days).' });
    }

    const after = (audit.after_data && typeof audit.after_data === 'object') ? audit.after_data : {};
    if (audit.action === 'service_remove' && after.productId) {
      const productId = String(after.productId);
      // Re-activate the existing link (or upsert a fresh one). Either
      // way the row ends up active=true and task generation runs.
      const { data: link } = await supabase.from('tax_customer_services')
        .select('id, active').eq('customer_id', customerId).eq('product_id', productId).maybeSingle();
      if (link) {
        const { error } = await supabase.from('tax_customer_services')
          .update({ active: true, updated_at: new Date().toISOString() })
          .eq('id', link.id);
        if (error) return sendSupabaseError(res, error);
      } else {
        const { error } = await supabase.from('tax_customer_services').insert({
          id: 'csvc_' + uuidv4().slice(0, 12),
          customer_id: customerId, product_id: productId,
          active: true,
        });
        if (error) return sendSupabaseError(res, error);
      }
      let tasksCreated = 0;
      try {
        const r = await generateTasksForService({
          customerId, productId, actorEmail: actor.email || '',
        });
        tasksCreated = r.created || 0;
      } catch (e) { warn('[tax-cust-svc-undo] task gen failed', e?.message || e); }
      try {
        await auditLog({
          entity: 'tax.customer', entityId: customerId, action: 'service_restore',
          actorEmail: actor.email || '',
          after: { productId, tasksCreated, undoOfAuditId: auditId },
        });
      } catch (_e) {}
      return res.json({ ok: true, action: 'service_restore', tasksCreated });
    }

    if (audit.action === 'relationship_remove' && after.customerRelationshipId) {
      const relId = String(after.customerRelationshipId);
      const { data: rel } = await supabase.from('tax_customer_relationships')
        .select('id, customer_id, relationship_type_id, active').eq('id', relId).maybeSingle();
      if (!rel || rel.customer_id !== customerId) {
        return res.status(404).json({ error: 'Relationship row not found for this customer.' });
      }
      if (!rel.active) {
        const { error } = await supabase.from('tax_customer_relationships')
          .update({ active: true, updated_at: new Date().toISOString() })
          .eq('id', relId);
        if (error) return sendSupabaseError(res, error);
      }
      let tasksCreated = 0;
      if (rel.relationship_type_id) {
        try {
          const r = await generateTasksForRelationship({
            customerId, relationshipTypeId: rel.relationship_type_id,
            actorEmail: actor.email || '',
          });
          tasksCreated = r.created || 0;
        } catch (e) { warn('[tax-rel-undo] task gen failed', e?.message || e); }
      }
      try {
        await auditLog({
          entity: 'tax.customer', entityId: customerId, action: 'relationship_restore',
          actorEmail: actor.email || '',
          after: {
            customerRelationshipId: relId,
            relationshipTypeId: rel.relationship_type_id,
            tasksCreated, undoOfAuditId: auditId,
          },
        });
      } catch (_e) {}
      return res.json({ ok: true, action: 'relationship_restore', tasksCreated });
    }

    return res.status(400).json({ error: 'not_undoable',
      message: 'This activity is not undoable.' });
  });

  router.post('/admin/customers/:id/relationships', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const typeId = trim(req.body?.relationshipTypeId, 200);
    const notes = trim(req.body?.notes, MAX_TEXT_LEN);
    if (!customerId || !typeId) return res.status(400).json({ error: 'customerId and relationshipTypeId required.' });
    const { data: cust } = await supabase.from('tax_customers').select('id, email, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });
    const { data: type } = await supabase.from('tax_relationship_types')
      .select('id, community_id, active').eq('id', typeId).maybeSingle();
    if (!type) return res.status(404).json({ error: 'Relationship type not found.' });
    if (type.community_id != null && type.community_id !== cust.community_id) {
      return res.status(403).json({ error: 'Service belongs to a different community.' });
    }
    if (type.active === false) {
      return res.status(409).json({ error: 'Service is disabled.' });
    }
    const relId = 'crel_' + uuidv4().slice(0, 12);
    const actor = trim(req.get('x-admin-email') || '', 200).toLowerCase();
    // Upsert-on-conflict: if the customer already has this relationship, reactivate it.
    const { error } = await supabase.from('tax_customer_relationships').upsert({
      id: relId,
      customer_id: customerId,
      relationship_type_id: typeId,
      notes: notes || null,
      active: true,
      created_by_email: actor || null,
    }, { onConflict: 'customer_id,relationship_type_id' });
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.customer_relationship', entityId: relId,
        action: 'add', actorEmail: actor || 'system',
        after: { customerId, typeId },
      });
    } catch (_e) {}
    // Generate scheduled tasks for this newly-added relationship.
    let tasksCreated = 0;
    try {
      const r = await generateTasksForRelationship({
        customerId, relationshipTypeId: typeId, actorEmail: actor || '',
      });
      tasksCreated = r.created || 0;
    } catch (e) { warn('[tax-rel-add] task gen failed', e?.message || e); }
    res.json({ ok: true, tasksCreated });
  });

  // ── DELETE /admin/customers/:id/relationships/:relId ── (global admin)
  router.delete('/admin/customers/:id/relationships/:relId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const relId = trim(req.params.relId, 200);
    const actorEmail = trim(req.get('x-admin-email') || '', 200).toLowerCase();
    // Pull the relationship_type_id before flipping inactive so we can
    // archive the tasks that the generator created for it.
    const { data: relRow } = await supabase.from('tax_customer_relationships')
      .select('relationship_type_id, customer_id')
      .eq('id', relId).eq('customer_id', customerId).maybeSingle();

    // Soft delete: mark inactive so we keep the audit trail.
    const { error } = await supabase.from('tax_customer_relationships')
      .update({ active: false })
      .eq('id', relId).eq('customer_id', customerId);
    if (error) return sendSupabaseError(res, error);

    // Archive any open scheduled tasks tied to this relationship. Completed
    // tasks are preserved so the work-done history survives. skipAudit
    // so the endpoint writes one richer audit row below instead of the
    // generic tasks_deleted from the helper.
    let tasksDeleted = 0;
    if (relRow?.relationship_type_id) {
      try {
        const r = await removeTasksForRelationship({
          customerId, relationshipTypeId: relRow.relationship_type_id,
          actorEmail, skipAudit: true,
        });
        tasksDeleted = r.deleted || 0;
      } catch (e) { warn('[tax-rel-del] task delete failed', e?.message || e); }
    }
    try {
      await auditLog({
        entity: 'tax.customer', entityId: customerId, action: 'relationship_remove',
        actorEmail,
        after: {
          customerRelationshipId: relId,
          relationshipTypeId: relRow?.relationship_type_id || null,
          tasksDeleted,
        },
      });
    } catch (_e) {}
    res.json({ ok: true, tasksDeleted });
  });

  // ── GET /admin/communities/:slug/faqs ── (global admin)
  // Returns the full effective FAQ set for the community across ALL relationship
  // types — what the customer would see if they had every relationship.
  // Owner-facing tooling will let them edit/override per-type.
  router.get('/admin/communities/:slug/faqs', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communityId = trim(req.params.slug, 200);
    const data = await loadEffectiveFaqs({ communityId, filterTypeIds: null });
    res.json(data);
  });

  // ── PUT /admin/communities/:slug/faqs/override/:defaultFaqId ── (global admin)
  // Owner overrides a default FAQ for this community. Body:
  //   { questionI18n, answerI18n, visible }
  // If `visible:false`, the default is hidden for this community.
  router.put('/admin/communities/:slug/faqs/override/:defaultFaqId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communityId = trim(req.params.slug, 200);
    const defaultFaqId = trim(req.params.defaultFaqId, 200);
    const body = req.body || {};
    const { data: def } = await supabase.from('tax_relationship_default_faqs')
      .select('id, relationship_type_id, display_order').eq('id', defaultFaqId).maybeSingle();
    if (!def) return res.status(404).json({ error: 'Default FAQ not found.' });
    const overrideId = 'tfaq_' + uuidv4().slice(0, 12);
    const { error } = await supabase.from('tax_relationship_faqs').upsert({
      id: overrideId,
      community_id: communityId,
      relationship_type_id: def.relationship_type_id,
      default_faq_id: defaultFaqId,
      display_order: def.display_order,
      question_i18n: safeI18n(body.questionI18n),
      answer_i18n: safeI18n(body.answerI18n),
      visible: body.visible === false ? false : true,
      video_url: String(body.videoUrl || '').trim().slice(0, 500),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'community_id,relationship_type_id,default_faq_id' });
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── POST /admin/communities/:slug/faqs/custom ── (global admin)
  // Owner adds a community-specific FAQ for a relationship type. Body:
  //   { relationshipTypeId, displayOrder, questionI18n, answerI18n }
  router.post('/admin/communities/:slug/faqs/custom', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communityId = trim(req.params.slug, 200);
    const typeId = trim(req.body?.relationshipTypeId, 200);
    if (!typeId) return res.status(400).json({ error: 'relationshipTypeId required.' });
    const customId = 'tfaq_' + uuidv4().slice(0, 12);
    const { error } = await supabase.from('tax_relationship_faqs').insert({
      id: customId,
      community_id: communityId,
      relationship_type_id: typeId,
      default_faq_id: null,
      display_order: Number(req.body?.displayOrder) || 1000,
      question_i18n: safeI18n(req.body?.questionI18n),
      answer_i18n: safeI18n(req.body?.answerI18n),
      visible: true,
      video_url: String(req.body?.videoUrl || '').trim().slice(0, 500),
    });
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true, id: customId });
  });

  // ── DELETE /admin/communities/:slug/faqs/:overrideId ── (global admin)
  // Hard-delete a community FAQ row — either an override (reverts to default)
  // or a custom FAQ (removes it).
  router.delete('/admin/communities/:slug/faqs/:overrideId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communityId = trim(req.params.slug, 200);
    const overrideId = trim(req.params.overrideId, 200);
    const { error } = await supabase.from('tax_relationship_faqs')
      .delete().eq('id', overrideId).eq('community_id', communityId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── Phase 4e: owner-managed help articles ───────────────────────────────

  // GET /admin/help?communitySlug=&audience=  — returns the effective merged
  // article set for the admin editor. Audience filter optional (defaults to
  // both); customer relationships are NOT filtered (admin sees every
  // article regardless of who would normally see it).
  router.get('/admin/help', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communityId = trim(req.query.communitySlug, 200);
    if (!communityId) return res.status(400).json({ error: 'communitySlug required.' });
    const audience = trim(req.query.audience, 40);

    const audiences = audience ? [audience] : ['customer', 'employee'];
    const results = {};
    for (const aud of audiences) {
      // For the admin view, pass null for customerRelationshipTypeIds so
      // every default is included regardless of relationship.
      results[aud] = await loadEffectiveHelp({
        communityId, audience: aud,
        customerRelationshipTypeIds: null,
      });
      // …but loadEffectiveHelp with null filters out null-tagged defaults
      // for customer audience. Switch to "all" by using the dedicated path:
      if (aud === 'customer') {
        results[aud] = await loadEffectiveHelpForAdmin(communityId, 'customer');
      }
    }
    res.json({ articles: results });
  });

  // Helper used only by the admin GET: returns merged defaults + community
  // rows for ALL relationship types (no per-customer filtering). Avoids the
  // customer-side restriction that would hide relationship-tagged defaults
  // when the admin doesn't carry that tag themselves.
  async function loadEffectiveHelpForAdmin(communityId, audience) {
    const [{ data: defaults }, { data: community }] = await Promise.all([
      supabase.from('tax_help_articles')
        .select(`
          id, audience, relationship_type_id, category, display_order,
          title_i18n, body_i18n, source_note,
          type:tax_relationship_types ( id, category, slug, name_i18n )
        `)
        .eq('audience', audience).eq('active', true),
      supabase.from('tax_community_help_articles')
        .select(`
          id, default_help_article_id, audience, relationship_type_id, category,
          display_order, title_i18n, body_i18n, visible, source_note,
          type:tax_relationship_types ( id, category, slug, name_i18n )
        `)
        .eq('community_id', communityId).eq('audience', audience),
    ]);
    const overrideByDefault = new Map();
    const customs = [];
    for (const row of community || []) {
      if (row.default_help_article_id) overrideByDefault.set(row.default_help_article_id, row);
      else customs.push(row);
    }
    const merged = [];
    for (const d of defaults || []) {
      const ov = overrideByDefault.get(d.id);
      // In the admin view we keep hidden defaults too so the owner can
      // re-show them. Source 'hidden' is the distinguishing signal.
      if (ov && ov.visible === false) {
        merged.push({ ...d, source: 'hidden', overrideId: ov.id, defaultId: d.id });
      } else if (ov) {
        merged.push({
          id: ov.id, source: 'override', defaultId: d.id, overrideId: ov.id,
          audience: d.audience, relationship_type_id: d.relationship_type_id,
          type: d.type, category: d.category,
          display_order: ov.display_order ?? d.display_order,
          title_i18n: ov.title_i18n && Object.keys(ov.title_i18n).length ? ov.title_i18n : d.title_i18n,
          body_i18n:  ov.body_i18n  && Object.keys(ov.body_i18n).length  ? ov.body_i18n  : d.body_i18n,
          video_url: ov.video_url || d.video_url || '',
          source_note: d.source_note,
        });
      } else {
        merged.push({ ...d, source: 'default' });
      }
    }
    for (const c of customs) merged.push({ ...c, source: 'custom' });
    merged.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    return merged;
  }

  // PUT /admin/help/override/:defaultArticleId
  // Upserts a community row that overrides the platform default. Setting
  // `visible:false` hides the default entirely for this community.
  router.put('/admin/help/override/:defaultArticleId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const defaultArticleId = trim(req.params.defaultArticleId, 200);
    const body = req.body || {};
    const communityId = trim(body.communitySlug, 200);
    if (!communityId) return res.status(400).json({ error: 'communitySlug required.' });

    const { data: def } = await supabase.from('tax_help_articles')
      .select('id, audience, category, relationship_type_id, display_order')
      .eq('id', defaultArticleId).maybeSingle();
    if (!def) return res.status(404).json({ error: 'Default article not found.' });

    const overrideId = 'thlpov_' + uuidv4().slice(0, 12);
    const { error } = await supabase.from('tax_community_help_articles').upsert({
      id: overrideId,
      community_id: communityId,
      default_help_article_id: defaultArticleId,
      audience: def.audience,
      relationship_type_id: def.relationship_type_id || null,
      category: def.category,
      display_order: def.display_order,
      title_i18n: safeI18n(body.titleI18n),
      body_i18n: safeI18n(body.bodyI18n),
      visible: body.visible === false ? false : true,
      video_url: String(body.videoUrl || '').trim().slice(0, 500),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'community_id,default_help_article_id' });
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // POST /admin/help/custom  — owner authors a brand-new community article.
  router.post('/admin/help/custom', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const body = req.body || {};
    const communityId = trim(body.communitySlug, 200);
    const audience = trim(body.audience, 40);
    const category = trim(body.category, 40) || 'general';
    const relationshipTypeId = trim(body.relationshipTypeId, 200) || null;
    const titleI18n = safeI18n(body.titleI18n);
    const bodyI18n = safeI18n(body.bodyI18n);
    const displayOrder = Number(body.displayOrder) || 1000;

    if (!communityId || !audience) return res.status(400).json({ error: 'communitySlug and audience required.' });
    if (!['customer', 'employee'].includes(audience)) return res.status(400).json({ error: 'audience must be customer|employee.' });
    if (!titleI18n.en && !titleI18n.es) return res.status(400).json({ error: 'Provide a title in at least one language.' });
    if (!bodyI18n.en && !bodyI18n.es) return res.status(400).json({ error: 'Provide a body in at least one language.' });

    const id = 'thlpcu_' + uuidv4().slice(0, 12);
    const { error } = await supabase.from('tax_community_help_articles').insert({
      id, community_id: communityId, default_help_article_id: null,
      audience, relationship_type_id: relationshipTypeId,
      category, display_order: displayOrder,
      title_i18n: titleI18n, body_i18n: bodyI18n, visible: true,
      video_url: String(body.videoUrl || '').trim().slice(0, 500),
    });
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true, id });
  });

  // DELETE /admin/help/:rowId  — removes a community row (override or
  // custom). When deleting an override, the platform default re-appears
  // automatically. When deleting a custom, the article is simply gone.
  router.delete('/admin/help/:rowId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const rowId = trim(req.params.rowId, 200);
    const { error } = await supabase.from('tax_community_help_articles')
      .delete().eq('id', rowId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 2d: customer documents
  //
  // Files live in the private `tax-documents` Supabase Storage bucket. The
  // server holds the service role key and signs upload/download URLs that
  // the client uses directly — no file bytes pass through the Node tier.
  // ────────────────────────────────────────────────────────────────────────────
  const DOCS_BUCKET = 'tax-documents';
  const MAX_DOC_BYTES = 25 * 1024 * 1024;
  const DOC_MIME_ALLOWLIST = new Set([
    'application/pdf',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
  ]);
  const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

  function sanitizeFileName(name) {
    const s = String(name || '').trim().replace(/[\\/]/g, '_').replace(/\x00/g, '');
    return s.slice(0, 255) || 'file';
  }
  function pathFor(communityId, customerId, docId) {
    return `${encodeURIComponent(communityId)}/${encodeURIComponent(customerId)}/${docId}`;
  }
  function isAllowedMime(m) { return DOC_MIME_ALLOWLIST.has(String(m || '').toLowerCase()); }

  // ── POST /portal/documents/upload-url ── (auth-gated customer)
  // Creates a draft document row and returns a signed upload URL. Client then
  // PUTs the file directly to Supabase Storage and calls /finalize.
  router.post('/portal/documents/upload-url', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    // Per-community gate: when documents uploads are disabled, refuse with
    // a 403 so any stale client UI surfaces a clear error rather than
    // succeeding silently.
    const { data: comm } = await supabase.from('communities')
      .select('tax_customer_documents_enabled')
      .eq('id', customer.community_id).maybeSingle();
    if (!comm?.tax_customer_documents_enabled) {
      return res.status(403).json({ error: 'documents_disabled',
        message: 'Document uploads are disabled for this practice.' });
    }
    const body = req.body || {};
    const fileName = sanitizeFileName(body.fileName);
    const mimeType = trim(body.mimeType, 200).toLowerCase();
    const sizeBytes = Number(body.sizeBytes);
    const kind = trim(body.kind, 80) || 'general';
    if (!fileName || !mimeType) return res.status(400).json({ error: 'fileName and mimeType required.' });
    if (!isAllowedMime(mimeType)) return res.status(415).json({ error: 'File type not supported.' });
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_DOC_BYTES) {
      return res.status(413).json({ error: 'File exceeds the 25 MB size limit.' });
    }

    const docId = 'tdoc_' + uuidv4().slice(0, 16);
    const path = pathFor(customer.community_id, customer.id, docId);
    const { data: signed, error: sErr } = await supabase.storage
      .from(DOCS_BUCKET).createSignedUploadUrl(path);
    if (sErr) {
      warn('[tax-docs] createSignedUploadUrl failed', sErr.message);
      return res.status(500).json({ error: 'Could not prepare upload. Please retry.' });
    }

    const { error: iErr } = await supabase.from('tax_documents').insert({
      id: docId,
      community_id: customer.community_id,
      customer_id: customer.id,
      source: 'customer',
      kind,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      storage_path: path,
      status: 'draft',
      uploaded_by_role: 'customer',
      uploaded_by_email: customer.email,
    });
    if (iErr) return sendSupabaseError(res, iErr);

    res.json({ id: docId, signedUrl: signed.signedUrl, path, expiresInSeconds: 7200 });
  });

  // ── POST /portal/documents/:id/finalize ── (auth-gated customer)
  // Flips the doc status to 'uploaded' after the PUT succeeds. We trust the
  // client here; if the file did not actually upload, the download URL will
  // 404 when used. A future cleanup job can sweep abandoned drafts.
  router.post('/portal/documents/:id/finalize', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const docId = trim(req.params.id, 200);
    const { data: doc } = await supabase.from('tax_documents')
      .select('id, customer_id, source, status').eq('id', docId).maybeSingle();
    if (!doc || doc.customer_id !== customer.id) return res.status(404).json({ error: 'Document not found.' });
    if (doc.source !== 'customer') return res.status(403).json({ error: 'Not allowed.' });
    if (doc.status === 'uploaded') return res.json({ ok: true });
    const { error } = await supabase.from('tax_documents')
      .update({ status: 'uploaded', uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', docId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({ entity: 'tax.document', entityId: docId, action: 'upload_customer',
        actorEmail: customer.email, actorName: customer.name });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── GET /portal/documents ── (auth-gated customer)
  router.get('/portal/documents', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const { data, error } = await supabase.from('tax_documents')
      .select('id, source, kind, file_name, mime_type, size_bytes, status, uploaded_at, uploaded_by_role, created_at, period_id')
      .eq('customer_id', customer.id).is('deleted_at', null).eq('status', 'uploaded')
      .order('created_at', { ascending: false }).limit(500);
    if (error) return sendSupabaseError(res, error);
    res.json({ documents: data || [] });
  });

  // ── GET /portal/documents/:id/download-url ── (auth-gated customer)
  router.get('/portal/documents/:id/download-url', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const docId = trim(req.params.id, 200);
    const { data: doc } = await supabase.from('tax_documents')
      .select('id, customer_id, storage_path, file_name, status, deleted_at')
      .eq('id', docId).maybeSingle();
    if (!doc || doc.customer_id !== customer.id || doc.deleted_at) return res.status(404).json({ error: 'Document not found.' });
    if (doc.status !== 'uploaded') return res.status(409).json({ error: 'Document not ready.' });
    const { data: signed, error } = await supabase.storage
      .from(DOCS_BUCKET).createSignedUrl(doc.storage_path, DOWNLOAD_URL_TTL_SECONDS, { download: doc.file_name });
    if (error) { warn('[tax-docs] createSignedUrl failed', error.message); return res.status(500).json({ error: 'Could not prepare download.' }); }
    res.json({ signedUrl: signed.signedUrl, fileName: doc.file_name, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
  });

  // ── DELETE /portal/documents/:id ── (auth-gated customer, soft delete)
  router.delete('/portal/documents/:id', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const docId = trim(req.params.id, 200);
    const { data: doc } = await supabase.from('tax_documents')
      .select('id, customer_id, source').eq('id', docId).maybeSingle();
    if (!doc || doc.customer_id !== customer.id) return res.status(404).json({ error: 'Document not found.' });
    // Customers can only delete docs THEY uploaded. Practice-uploaded docs are
    // considered records of work performed and must be removed by the owner.
    if (doc.source !== 'customer') return res.status(403).json({ error: 'Contact your tax practice to remove this document.' });
    const { error } = await supabase.from('tax_documents')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', docId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({ entity: 'tax.document', entityId: docId, action: 'delete_customer',
        actorEmail: customer.email, actorName: customer.name });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── GET /admin/customers/:id/documents ── (global admin)
  router.get('/admin/customers/:id/documents', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const { data, error } = await supabase.from('tax_documents')
      .select('id, community_id, source, kind, file_name, mime_type, size_bytes, status, uploaded_at, uploaded_by_role, uploaded_by_email, period_id, created_at')
      .eq('customer_id', customerId).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(500);
    if (error) return sendSupabaseError(res, error);
    res.json({ documents: data || [] });
  });

  // ── POST /admin/customers/:id/documents/upload-url ── (global admin)
  // Owner uploads a document FOR the customer (completed return, etc.). On
  // finalize the customer gets an in-app + email notification.
  router.post('/admin/customers/:id/documents/upload-url', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const body = req.body || {};
    const fileName = sanitizeFileName(body.fileName);
    const mimeType = trim(body.mimeType, 200).toLowerCase();
    const sizeBytes = Number(body.sizeBytes);
    const kind = trim(body.kind, 80) || 'general';
    const periodId = trim(body.periodId, 200) || null;
    if (!fileName || !mimeType) return res.status(400).json({ error: 'fileName and mimeType required.' });
    if (!isAllowedMime(mimeType)) return res.status(415).json({ error: 'File type not supported.' });
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_DOC_BYTES) {
      return res.status(413).json({ error: 'File exceeds the 25 MB size limit.' });
    }
    const { data: cust } = await supabase.from('tax_customers')
      .select('id, community_id').eq('id', customerId).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    const docId = 'tdoc_' + uuidv4().slice(0, 16);
    const path = pathFor(cust.community_id, cust.id, docId);
    const { data: signed, error: sErr } = await supabase.storage
      .from(DOCS_BUCKET).createSignedUploadUrl(path);
    if (sErr) {
      warn('[tax-docs] createSignedUploadUrl failed', sErr.message);
      return res.status(500).json({ error: 'Could not prepare upload. Please retry.' });
    }
    const actor = trim(req.get('x-admin-email') || '', 200).toLowerCase();
    const { error: iErr } = await supabase.from('tax_documents').insert({
      id: docId,
      community_id: cust.community_id,
      customer_id: cust.id,
      period_id: periodId,
      source: 'practice',
      kind,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      storage_path: path,
      status: 'draft',
      uploaded_by_role: 'practice',
      uploaded_by_email: actor,
    });
    if (iErr) return sendSupabaseError(res, iErr);
    res.json({ id: docId, signedUrl: signed.signedUrl, path, expiresInSeconds: 7200 });
  });

  // ── POST /admin/documents/:id/finalize ── (global admin)
  // Flips to uploaded + notifies the customer.
  router.post('/admin/documents/:id/finalize', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const docId = trim(req.params.id, 200);
    const { data: doc } = await supabase.from('tax_documents')
      .select('id, community_id, customer_id, source, status, file_name, kind')
      .eq('id', docId).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.source !== 'practice') return res.status(403).json({ error: 'Only practice uploads finalize through admin.' });
    if (doc.status === 'uploaded') return res.json({ ok: true });

    const { error } = await supabase.from('tax_documents')
      .update({ status: 'uploaded', uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', docId);
    if (error) return sendSupabaseError(res, error);

    // Notify the customer (in-app + email when configured).
    try { await notifyCustomerOfDocument(doc); } catch (e) { warn('[tax-docs] notify failed', e?.message || e); }
    try {
      await auditLog({ entity: 'tax.document', entityId: docId, action: 'upload_practice',
        actorEmail: trim(req.get('x-admin-email') || '', 200).toLowerCase() || 'admin' });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── GET /admin/documents/:id/download-url ── (global admin)
  router.get('/admin/documents/:id/download-url', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const docId = trim(req.params.id, 200);
    const { data: doc } = await supabase.from('tax_documents')
      .select('id, storage_path, file_name, status, deleted_at').eq('id', docId).maybeSingle();
    if (!doc || doc.deleted_at) return res.status(404).json({ error: 'Document not found.' });
    if (doc.status !== 'uploaded') return res.status(409).json({ error: 'Document not ready.' });
    const { data: signed, error } = await supabase.storage
      .from(DOCS_BUCKET).createSignedUrl(doc.storage_path, DOWNLOAD_URL_TTL_SECONDS, { download: doc.file_name });
    if (error) return res.status(500).json({ error: 'Could not prepare download.' });
    res.json({ signedUrl: signed.signedUrl, fileName: doc.file_name, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
  });

  // ── DELETE /admin/documents/:id ── (global admin, hard delete)
  // Removes the storage object AND the metadata row. Use this for sensitive
  // data the practice doesn't want lingering. Use the soft-delete on the
  // customer endpoint when keeping the audit trail matters more.
  router.delete('/admin/documents/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const docId = trim(req.params.id, 200);
    const { data: doc } = await supabase.from('tax_documents')
      .select('id, storage_path').eq('id', docId).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    const { error: rErr } = await supabase.storage.from(DOCS_BUCKET).remove([doc.storage_path]);
    if (rErr) warn('[tax-docs] storage remove failed (continuing)', rErr.message);
    const { error } = await supabase.from('tax_documents').delete().eq('id', docId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // Helper: drop an in-app notification + email when a practice-uploaded
  // document becomes available to a customer.
  async function notifyCustomerOfDocument(doc) {
    const [{ data: cust }, { data: community }] = await Promise.all([
      supabase.from('tax_customers').select('id, email, name, locale, preferred_communication_email').eq('id', doc.customer_id).maybeSingle(),
      supabase.from('communities').select('id, name, contact_email').eq('id', doc.community_id).maybeSingle(),
    ]);
    if (!cust) return;
    const portalUrl = await customerLandingOrPortalUrl(doc.community_id);
    await supabase.from('tax_notifications').insert({
      id: 'tnotif_' + uuidv4().slice(0, 12),
      community_id: doc.community_id,
      customer_id: cust.id,
      type: 'document_uploaded',
      title_i18n: {
        es: `Nuevo documento disponible: ${doc.file_name}`,
        en: `New document available: ${doc.file_name}`,
      },
      body_i18n: {
        es: `Su oficina de impuestos cargó un documento nuevo en su portal. Inicie sesión para revisarlo y descargarlo.`,
        en: `Your tax practice uploaded a new document to your portal. Sign in to review and download it.`,
      },
      payload: { documentId: doc.id, fileName: doc.file_name, kind: doc.kind },
    });
    if (typeof sendTaxDocumentEmail === 'function'
        && await communityEmailFlag(doc.community_id, 'tax_email_document_enabled')) {
      try { await sendTaxDocumentEmail({ cust, community, doc, portalUrl }); }
      catch (e) { warn('[tax-docs] document email failed', e?.message || e); }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 2f: customer ↔ practice messaging
  //
  // Thread-per-conversation, denormalized last_message_* + unread flags on the
  // thread row so the list query is O(1). Customer endpoints are auth-gated;
  // owner endpoints sit behind requireOwnerAdmin. The owner UI lands with
  // Phase 4a — until then, the practice replies via these endpoints directly.
  // ────────────────────────────────────────────────────────────────────────────
  const MAX_MESSAGE_BODY = 4000;
  const MAX_SUBJECT_LEN  = 240;
  const PREVIEW_LEN      = 200;

  function previewOf(body) {
    const s = String(body || '').replace(/\s+/g, ' ').trim();
    return s.length > PREVIEW_LEN ? (s.slice(0, PREVIEW_LEN - 1) + '…') : s;
  }

  // ── GET /portal/threads ── (customer)
  router.get('/portal/threads', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const { data, error } = await supabase.from('tax_message_threads')
      .select('id, subject, status, last_message_at, last_message_preview, last_message_by_role, customer_unread, created_at')
      .eq('customer_id', customer.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) return sendSupabaseError(res, error);
    res.json({ threads: data || [] });
  });

  // ── POST /portal/threads ── (customer creates thread + sends first message)
  // Body: { subject, body, relatedPeriodId?, relatedDocumentId? }
  router.post('/portal/threads', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const body = req.body || {};
    const subject = trim(body.subject, MAX_SUBJECT_LEN);
    const messageBody = trim(body.body, MAX_MESSAGE_BODY);
    if (!messageBody) return res.status(400).json({ error: 'Message body required.' });

    const threadId = 'tthr_' + uuidv4().slice(0, 16);
    const now = new Date().toISOString();
    const { error: tErr } = await supabase.from('tax_message_threads').insert({
      id: threadId,
      community_id: customer.community_id,
      customer_id: customer.id,
      subject: subject || (lang => lang === 'en' ? 'Question for your tax practice' : 'Pregunta para su contador')(customer.locale),
      related_period_id: trim(body.relatedPeriodId, 200) || null,
      related_document_id: trim(body.relatedDocumentId, 200) || null,
      status: 'open',
      created_by_role: 'customer',
      created_by_email: customer.email,
      last_message_at: now,
      last_message_preview: previewOf(messageBody),
      last_message_by_role: 'customer',
      customer_unread: false,
      practice_unread: true,
    });
    if (tErr) return sendSupabaseError(res, tErr);

    const msgId = await insertMessage({
      threadId,
      communityId: customer.community_id,
      customerId: customer.id,
      role: 'customer',
      email: customer.email,
      name: customer.name,
      body: messageBody,
    });

    notifyPracticeOfCustomerMessage(threadId, customer.id).catch(e => warn('[tax-msg] practice notify failed', e?.message || e));
    try {
      await auditLog({ entity: 'tax.message_thread', entityId: threadId, action: 'create_customer',
        actorEmail: customer.email, actorName: customer.name });
    } catch (_e) {}
    res.json({ ok: true, threadId, messageId: msgId });
  });

  // ── GET /portal/threads/:id ── (customer; returns + flips customer_unread to false)
  router.get('/portal/threads/:id', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const id = trim(req.params.id, 200);
    const { data: thread } = await supabase.from('tax_message_threads')
      .select('id, customer_id, subject, status, related_period_id, related_document_id, last_message_at, customer_unread, created_at')
      .eq('id', id).maybeSingle();
    if (!thread || thread.customer_id !== customer.id) return res.status(404).json({ error: 'Thread not found.' });

    const { data: messages, error } = await supabase.from('tax_messages')
      .select('id, author_role, author_email, author_name, body, attachments, created_at')
      .eq('thread_id', id).order('created_at', { ascending: true });
    if (error) return sendSupabaseError(res, error);

    if (thread.customer_unread) {
      await supabase.from('tax_message_threads')
        .update({ customer_unread: false, updated_at: new Date().toISOString() })
        .eq('id', id);
    }
    res.json({ thread, messages: messages || [] });
  });

  // ── POST /portal/threads/:id/messages ── (customer reply)
  router.post('/portal/threads/:id/messages', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const id = trim(req.params.id, 200);
    const messageBody = trim(req.body?.body, MAX_MESSAGE_BODY);
    if (!messageBody) return res.status(400).json({ error: 'Message body required.' });

    const { data: thread } = await supabase.from('tax_message_threads')
      .select('id, customer_id, community_id, status').eq('id', id).maybeSingle();
    if (!thread || thread.customer_id !== customer.id) return res.status(404).json({ error: 'Thread not found.' });
    if (thread.status === 'closed') return res.status(409).json({ error: 'This thread is closed.' });

    const msgId = await insertMessage({
      threadId: id,
      communityId: thread.community_id,
      customerId: customer.id,
      role: 'customer',
      email: customer.email,
      name: customer.name,
      body: messageBody,
    });
    notifyPracticeOfCustomerMessage(id, customer.id).catch(e => warn('[tax-msg] practice notify failed', e?.message || e));
    res.json({ ok: true, messageId: msgId });
  });

  // ── POST /portal/threads/:id/read ── (customer mark-as-read)
  router.post('/portal/threads/:id/read', async (req, res) => {
    const customer = await requireTaxCustomer(req, res); if (!customer) return;
    const id = trim(req.params.id, 200);
    const { error } = await supabase.from('tax_message_threads')
      .update({ customer_unread: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('customer_id', customer.id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── ADMIN: GET /admin/threads ── (owner; optionally filtered)
  router.get('/admin/threads', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    let q = supabase.from('tax_message_threads')
      .select(`
        id, subject, status, last_message_at, last_message_preview, last_message_by_role,
        practice_unread, customer_unread, created_at, customer_id, related_period_id, related_document_id,
        customer:tax_customers ( id, email, name )
      `)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(500);
    if (communitySlug) q = q.eq('community_id', communitySlug);
    if (req.query.unreadOnly === 'true') q = q.eq('practice_unread', true);
    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ threads: data || [] });
  });

  // ── ADMIN: GET /admin/threads/:id ── (owner; returns + flips practice_unread to false)
  router.get('/admin/threads/:id', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const id = trim(req.params.id, 200);
    const { data: thread } = await supabase.from('tax_message_threads')
      .select(`
        id, customer_id, community_id, subject, status, related_period_id, related_document_id,
        last_message_at, practice_unread, customer_unread, created_at,
        customer:tax_customers ( id, email, name, locale, phone, whatsapp, preferred_communication_email )
      `).eq('id', id).maybeSingle();
    if (!thread) return res.status(404).json({ error: 'Thread not found.' });

    const { data: messages, error } = await supabase.from('tax_messages')
      .select('id, author_role, author_email, author_name, body, attachments, created_at')
      .eq('thread_id', id).order('created_at', { ascending: true });
    if (error) return sendSupabaseError(res, error);

    if (thread.practice_unread) {
      await supabase.from('tax_message_threads')
        .update({ practice_unread: false, updated_at: new Date().toISOString() }).eq('id', id);
    }
    res.json({ thread, messages: messages || [] });
  });

  // ── ADMIN: POST /admin/threads/:id/messages ── (owner reply)
  router.post('/admin/threads/:id/messages', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const id = trim(req.params.id, 200);
    const messageBody = trim(req.body?.body, MAX_MESSAGE_BODY);
    if (!messageBody) return res.status(400).json({ error: 'Message body required.' });

    const { data: thread } = await supabase.from('tax_message_threads')
      .select('id, customer_id, community_id, status').eq('id', id).maybeSingle();
    if (!thread) return res.status(404).json({ error: 'Thread not found.' });
    if (thread.status === 'closed') return res.status(409).json({ error: 'This thread is closed.' });

    const actor = trim(req.get('x-admin-email') || '', 200).toLowerCase();
    const msgId = await insertMessage({
      threadId: id,
      communityId: thread.community_id,
      customerId: thread.customer_id,
      role: 'practice',
      email: actor,
      name: '',
      body: messageBody,
    });
    notifyCustomerOfPracticeMessage(id, thread.customer_id, msgId).catch(e => warn('[tax-msg] customer notify failed', e?.message || e));
    res.json({ ok: true, messageId: msgId });
  });

  // ── ADMIN: POST /admin/threads/:id/read ──
  router.post('/admin/threads/:id/read', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const id = trim(req.params.id, 200);
    const { error } = await supabase.from('tax_message_threads')
      .update({ practice_unread: false, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── Messaging helpers ──────────────────────────────────────────────────
  // Inserts a row in tax_messages and updates the thread's denormalized
  // last_message_* + opposite-party unread flag. Returns the new message id.
  async function insertMessage({ threadId, communityId, customerId, role, email, name, body }) {
    const id = 'tmsg_' + uuidv4().slice(0, 16);
    const now = new Date().toISOString();
    await supabase.from('tax_messages').insert({
      id, thread_id: threadId, community_id: communityId, customer_id: customerId,
      author_role: role, author_email: email || '', author_name: name || '',
      body, attachments: [], created_at: now,
    });
    const threadPatch = {
      last_message_at: now,
      last_message_preview: previewOf(body),
      last_message_by_role: role,
      updated_at: now,
    };
    if (role === 'practice') threadPatch.customer_unread = true;
    else threadPatch.practice_unread = true;
    await supabase.from('tax_message_threads').update(threadPatch).eq('id', threadId);
    return id;
  }

  async function notifyCustomerOfPracticeMessage(threadId, customerId, messageId) {
    const [{ data: thread }, { data: cust }, { data: msg }] = await Promise.all([
      supabase.from('tax_message_threads')
        .select('id, subject, community_id').eq('id', threadId).maybeSingle(),
      supabase.from('tax_customers')
        .select('id, email, name, locale, preferred_communication_email').eq('id', customerId).maybeSingle(),
      supabase.from('tax_messages')
        .select('id, body, created_at').eq('id', messageId).maybeSingle(),
    ]);
    if (!thread || !cust || !msg) return;
    const { data: community } = await supabase.from('communities')
      .select('id, name, contact_email, default_locale').eq('id', thread.community_id).maybeSingle();

    await supabase.from('tax_notifications').insert({
      id: 'tnotif_' + uuidv4().slice(0, 12),
      community_id: thread.community_id,
      customer_id: cust.id,
      type: 'message',
      title_i18n: {
        es: `Nuevo mensaje${thread.subject ? `: ${thread.subject}` : ''}`,
        en: `New message${thread.subject ? `: ${thread.subject}` : ''}`,
      },
      body_i18n: {
        es: previewOf(msg.body),
        en: previewOf(msg.body),
      },
      payload: { threadId: thread.id, messageId: msg.id },
    });

    if (typeof sendTaxMessageEmail === 'function'
        && await communityEmailFlag(thread.community_id, 'tax_email_message_enabled')) {
      const portalUrl = await customerLandingOrPortalUrl(thread.community_id, `/messages/${encodeURIComponent(thread.id)}`);
      try { await sendTaxMessageEmail({ cust, community, thread, message: msg, portalUrl }); }
      catch (e) { warn('[tax-msg] customer email failed', e?.message || e); }
    }
  }

  async function notifyPracticeOfCustomerMessage(threadId, customerId) {
    const [{ data: thread }, { data: cust }] = await Promise.all([
      supabase.from('tax_message_threads')
        .select('id, subject, community_id, last_message_at, last_message_preview').eq('id', threadId).maybeSingle(),
      supabase.from('tax_customers')
        .select('id, email, name').eq('id', customerId).maybeSingle(),
    ]);
    if (!thread || !cust) return;
    const { data: community } = await supabase.from('communities')
      .select('id, name, contact_email, default_locale').eq('id', thread.community_id).maybeSingle();

    // Fan out (Phase 3b): admins always get notified for any customer in
    // their community; staff get notified ONLY for customers they're
    // assigned to. The two sets are merged + deduped before delivery.
    const [{ data: admins }, { data: assignedRows }] = await Promise.all([
      supabase.from('tax_employees')
        .select('id, email, name, locale, notification_channels, notification_prefs, permissions, preferred_communication_email, role, status')
        .eq('community_id', thread.community_id).eq('status', 'active').eq('role', 'admin'),
      supabase.from('tax_employee_customer_assignments')
        .select(`
          id,
          employee:tax_employees ( id, email, name, locale, notification_channels, notification_prefs, permissions, preferred_communication_email, role, status )
        `)
        .eq('customer_id', customerId).eq('active', true),
    ]);
    const recipientById = new Map();
    for (const emp of admins || []) recipientById.set(emp.id, emp);
    for (const row of assignedRows || []) {
      const emp = row.employee;
      if (emp && emp.status === 'active' && emp.role === 'staff') {
        recipientById.set(emp.id, emp);
      }
    }
    const empList = [...recipientById.values()];

    for (const emp of empList) {
      // Phase 4n.11: per-type channel resolution (replaces the global
      // notification_channels lookup). in_app + email are independent
      // toggles; in_app stays on as a safety net when both are off.
      const channels = getEmployeeChannels(emp, 'new_message');

      if (channels.includes('in_app')) {
        await supabase.from('tax_employee_notifications').insert({
          id: 'tenot_' + uuidv4().slice(0, 12),
          community_id: thread.community_id,
          employee_id: emp.id,
          type: 'message',
          title_i18n: {
            es: `Nuevo mensaje del cliente${cust.name ? ` (${cust.name})` : ''}`,
            en: `New customer message${cust.name ? ` (${cust.name})` : ''}`,
          },
          body_i18n: {
            es: thread.last_message_preview || '',
            en: thread.last_message_preview || '',
          },
          payload: { threadId: thread.id, customerId: cust.id },
        });
      }

      if (channels.includes('email')
          && typeof sendTaxMessageEmployeeEmail === 'function'
          && await communityStaffEmailFlag(community.id, 'tax_staff_email_message_enabled')) {
        try {
          await sendTaxMessageEmployeeEmail({
            community, customer: cust, employee: emp, thread,
            message: { body: thread.last_message_preview, created_at: thread.last_message_at },
          });
        } catch (e) { warn('[tax-msg] employee email failed', e?.message || e); }
      }
    }

    // Fallback: when no employees exist yet, alert the practice contact_email.
    // Once at least one employee is on-staff, individual employee emails take
    // over and this fallback goes silent.
    if (empList.length === 0 && typeof sendTaxMessagePracticeEmail === 'function'
        && await communityStaffEmailFlag(community.id, 'tax_staff_email_message_enabled')) {
      try {
        await sendTaxMessagePracticeEmail({
          community, customer: cust, thread,
          message: { body: thread.last_message_preview, created_at: thread.last_message_at },
        });
      } catch (e) { warn('[tax-msg] practice email failed', e?.message || e); }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Phase 3: employee portal
  //
  // Mirrors the Phase 2a customer auth pattern. Frontend sends
  //   x-firebase-uid, x-firebase-email, x-tax-community
  // on every employee-portal request. The middleware looks them up against
  // tax_employees. SECURITY NOTE: same caveat as Phase 2a — trust the
  // frontend-asserted headers in v1; harden with firebase-admin ID-token
  // verification before exposing beyond a trusted pilot.
  // ════════════════════════════════════════════════════════════════════════════

  async function requireTaxEmployee(req, res) {
    if (!requireSupabaseEnv(res)) return null;

    // Impersonation path mirrors requireTaxCustomer above. Used when an
    // admin previews an employee's view (different from previewing a
    // customer's view).
    const imp = await loadImpersonationFromRequest(req, res, 'employee');
    if (imp === false) return null;
    if (imp) {
      const { data: emp, error } = await supabase.from('tax_employees')
        .select('id, community_id, email, name, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, notification_channels, notification_prefs, permissions, role, status, firebase_uid, last_sign_in_at')
        .eq('id', imp.target_id).maybeSingle();
      if (error) { sendSupabaseError(res, error); return null; }
      if (!emp) { res.status(404).json({ error: 'Impersonation target not found.' }); return null; }
      req.impersonation = imp;
      return emp;
    }

    const uid = trim(req.get('x-firebase-uid') || '', 200);
    const email = trim(req.get('x-firebase-email') || '', 200).toLowerCase();
    const communitySlug = trim(req.get('x-tax-community') || '', 200);
    if (!uid || !email || !communitySlug) {
      res.status(401).json({ error: 'Authentication required.' });
      return null;
    }
    const { data: emp, error } = await supabase.from('tax_employees')
      .select('id, community_id, email, name, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, notification_channels, notification_prefs, permissions, role, status, firebase_uid, last_sign_in_at')
      .eq('email', email).eq('community_id', communitySlug).maybeSingle();
    if (error) { sendSupabaseError(res, error); return null; }
    if (!emp) {
      const redirect = await detectCrossPortalRedirect({ email, communitySlug, currentType: 'employee' });
      if (redirect) {
        res.status(403).json({
          error: 'wrong_portal',
          message: 'You have a customer account at this practice. Sign in at the customer portal instead.',
          redirectTo: redirect.redirectTo,
          accountType: redirect.type,
        });
      } else {
        res.status(403).json({ error: 'Account not provisioned. Contact your practice administrator.' });
      }
      return null;
    }
    if (emp.status !== 'active') {
      res.status(403).json({ error: 'Account is not active.' });
      return null;
    }
    if (emp.firebase_uid && emp.firebase_uid !== uid) {
      res.status(403).json({ error: 'Account collision. Contact your practice administrator.' });
      return null;
    }
    return emp;
  }

  function pickEmployee(e) {
    return {
      id: e.id, email: e.email, name: e.name, phone: e.phone,
      whatsapp: e.whatsapp || '',
      address: e.address || {},
      preferredCommunicationEmail: e.preferred_communication_email || '',
      locale: e.locale, role: e.role, status: e.status,
      notificationChannels: Array.isArray(e.notification_channels) ? e.notification_channels : ['in_app'],
      notificationPrefs: (e.notification_prefs && typeof e.notification_prefs === 'object') ? e.notification_prefs : {},
      // Effective permissions map. Only revoked keys are stored
      // (defaulting to false); everything absent is granted. Clients
      // use this to hide nav links and to gray out actions early —
      // server still re-checks on each protected endpoint.
      permissions: (e.permissions && typeof e.permissions === 'object') ? e.permissions : {},
      lastSignInAt: e.last_sign_in_at || null,
    };
  }

  // ── Phase 4n.11: per-type employee notification preferences ─────────────
  //
  // Each notification type can be toggled on/off per channel (in_app, email).
  // The `welcome` type is implicit: sent once at employee creation, always
  // email, not configurable. New types added in the future just register
  // here — the UI auto-picks them up via GET /employee/notification-types.
  const EMPLOYEE_NOTIFICATION_TYPES = [
    {
      key: 'new_message',
      label_i18n: { en: 'New customer message', es: 'Nuevo mensaje del cliente' },
      description_i18n: {
        en: 'When a customer assigned to you (or any customer in the community for admins) posts a message.',
        es: 'Cuando un cliente asignado a usted (o cualquier cliente para administradores) envía un mensaje.',
      },
      default_channels: ['in_app'],
    },
    {
      key: 'signature_signed',
      label_i18n: { en: 'Customer signed a request', es: 'Cliente firmó una solicitud' },
      description_i18n: {
        en: 'When a customer e-signs an engagement letter, 8879, or any signature request you sent.',
        es: 'Cuando un cliente firma electrónicamente una carta de compromiso, 8879 u otra solicitud que envió.',
      },
      default_channels: ['in_app'],
    },
  ];

  // Resolve the effective channel list for one notification type for one
  // employee. Precedence:
  //   1. notification_prefs[type] (per-type, set via the profile UI)
  //   2. notification_channels (legacy global toggle, pre-Phase 4n.11)
  //   3. type's default_channels (typically ['in_app'])
  // Safety: returns ['in_app'] if every channel ends up off — better to send
  // a portal nudge than nothing at all.
  function getEmployeeChannels(employee, type) {
    const prefs = (employee && employee.notification_prefs) || {};
    const perType = prefs[type];
    if (perType && typeof perType === 'object') {
      const channels = [];
      if (perType.in_app !== false) channels.push('in_app');
      if (perType.email === true)   channels.push('email');
      return channels.length ? channels : ['in_app'];
    }
    const legacy = Array.isArray(employee?.notification_channels) ? employee.notification_channels : null;
    if (legacy && legacy.length) return legacy;
    const tp = EMPLOYEE_NOTIFICATION_TYPES.find(t => t.key === type);
    return tp?.default_channels || ['in_app'];
  }

  router.get('/employee/notification-types', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    res.json({
      types: EMPLOYEE_NOTIFICATION_TYPES,
      prefs: (emp.notification_prefs && typeof emp.notification_prefs === 'object') ? emp.notification_prefs : {},
    });
  });

  // ── POST /employee/auth/link ──
  router.post('/employee/auth/link', async (req, res) => {
    if (!requireSupabaseEnv(res)) return;
    const body = req.body || {};
    const uid = trim(body.uid, 200);
    const email = trim(body.email, 200).toLowerCase();
    const communitySlug = trim(body.communitySlug, 200);
    if (!uid || !email || !communitySlug) {
      return res.status(400).json({ error: 'uid, email, and communitySlug required.' });
    }
    const { data: emp, error } = await supabase.from('tax_employees')
      .select('id, community_id, email, name, locale, status, firebase_uid, role')
      .eq('email', email).eq('community_id', communitySlug).maybeSingle();
    if (error) return sendSupabaseError(res, error);
    if (!emp) {
      const redirect = await detectCrossPortalRedirect({ email, communitySlug, currentType: 'employee' });
      if (redirect) {
        return res.status(403).json({
          error: 'wrong_portal',
          message: 'You have a customer account at this practice. Sign in at the customer portal instead.',
          redirectTo: redirect.redirectTo,
          accountType: redirect.type,
        });
      }
      return res.status(403).json({ error: 'Account not provisioned. Contact your practice administrator.' });
    }
    if (emp.status !== 'active') return res.status(403).json({ error: 'Account is not active.' });
    if (emp.firebase_uid && emp.firebase_uid !== uid) {
      return res.status(403).json({ error: 'Account collision. Contact your practice administrator.' });
    }
    if (!emp.firebase_uid) {
      const { error: uErr } = await supabase.from('tax_employees')
        .update({ firebase_uid: uid, updated_at: new Date().toISOString() }).eq('id', emp.id);
      if (uErr) return sendSupabaseError(res, uErr);
      try {
        await auditLog({
          entity: 'tax.employee', entityId: emp.id, action: 'link_firebase',
          actorEmail: email, actorName: emp.name, after: { firebaseUidLinked: true },
        });
      } catch (_e) {}
    }
    res.json({ ok: true, employee: { ...emp, firebase_uid: uid } });
  });

  // ── GET /employee/me ──
  router.get('/employee/me', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    stampLastSignIn('tax_employees', emp.id, emp.last_sign_in_at);
    const [{ data: community }, assignments, { data: companion }] = await Promise.all([
      supabase.from('communities')
        .select('id, name, logo_url, brand_primary_color, brand_secondary_color, default_locale, contact_email, phone')
        .eq('id', emp.community_id).maybeSingle(),
      // Only fetch assignments for staff; for admin the list would be ALL
      // customers which is a different display ("All customers in this
      // community" — handled in the frontend on role=admin).
      emp.role === 'staff'
        ? supabase.from('tax_employee_customer_assignments')
            .select(`
              id, is_primary, created_at,
              customer:tax_customers ( id, email, name, phone, whatsapp, locale )
            `).eq('employee_id', emp.id).eq('active', true)
        : Promise.resolve({ data: [] }),
      // Companion check: same email also seeded as a customer in this
      // community? Surfaces a "Switch to customer view" link in the
      // staff nav for dual-role accounts (e.g., the owner who self-
      // services through both portals).
      supabase.from('tax_customers')
        .select('id').eq('community_id', emp.community_id)
        .eq('email', emp.email).eq('status', 'active').maybeSingle(),
    ]);
    res.json({
      employee: pickEmployee(emp),
      community,
      // Always include the array (empty for admin) so the frontend
      // can always destructure it without branching.
      assignments: (assignments?.data || []),
      customerAccess: companion
        ? { hasCustomerRow: true }
        : { hasCustomerRow: false },
    });
  });

  // ── PUT /employee/profile ──
  // Editable: name, phone, WhatsApp (E.164), address, preferredCommunicationEmail,
  //           notificationChannels (subset of ['in_app','email'], at least one).
  router.put('/employee/profile', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const body = req.body || {};
    const update = { updated_at: new Date().toISOString() };

    const sentName =
      body.firstName !== undefined || body.middleName !== undefined ||
      body.lastName  !== undefined || body.name       !== undefined;
    if (sentName) {
      const np = resolveNamePayload(body);
      update.name = np.name;
      update.first_name = np.first;
      update.middle_name = np.middle;
      update.last_name = np.last;
    }
    if (body.phone !== undefined) update.phone = trim(body.phone, MAX_PHONE_LEN);

    if (body.whatsapp !== undefined) {
      const raw = String(body.whatsapp || '').trim();
      if (raw === '') update.whatsapp = '';
      else {
        const norm = normalizeWhatsapp(raw);
        if (!norm) {
          return res.status(400).json({ error: 'whatsapp_invalid',
            message: 'WhatsApp must be in international format starting with + and country code, e.g., +14155551234.' });
        }
        update.whatsapp = norm;
      }
    }
    if (body.address !== undefined) update.address = sanitizeAddress(body.address);

    if (body.preferredCommunicationEmail !== undefined) {
      const raw = String(body.preferredCommunicationEmail || '').trim().toLowerCase();
      if (raw === '') update.preferred_communication_email = '';
      else if (!isValidEmail(raw)) {
        return res.status(400).json({ error: 'preferred_email_invalid',
          message: 'Preferred communication email is not valid.' });
      } else update.preferred_communication_email = raw.slice(0, MAX_NAME_LEN);
    }

    if (body.notificationChannels !== undefined) {
      const channels = (Array.isArray(body.notificationChannels) ? body.notificationChannels : [])
        .map(c => String(c).toLowerCase()).filter(c => c === 'email' || c === 'in_app');
      if (!channels.length) {
        return res.status(400).json({ error: 'channels_empty',
          message: 'Select at least one notification channel.' });
      }
      // Dedupe while preserving stable order in_app, email.
      update.notification_channels = ['in_app', 'email'].filter(c => channels.includes(c));
    }

    // Phase 4n.11: per-type prefs. Body shape:
    //   { notificationPrefs: { "<typeKey>": { in_app: bool, email: bool } } }
    // Unknown type keys are dropped. Empty object clears all prefs (falls
    // back to legacy notification_channels or defaults).
    if (body.notificationPrefs !== undefined) {
      const raw = (body.notificationPrefs && typeof body.notificationPrefs === 'object' && !Array.isArray(body.notificationPrefs))
        ? body.notificationPrefs : {};
      const allowedKeys = new Set(EMPLOYEE_NOTIFICATION_TYPES.map(t => t.key));
      const cleaned = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!allowedKeys.has(k) || !v || typeof v !== 'object') continue;
        cleaned[k] = {
          in_app: v.in_app !== false,
          email:  v.email === true,
        };
      }
      update.notification_prefs = cleaned;
    }

    if (body.locale !== undefined) {
      const v = String(body.locale || '').trim().toLowerCase();
      if (v !== 'en' && v !== 'es') {
        return res.status(400).json({ error: 'locale_invalid',
          message: "locale must be 'en' or 'es'." });
      }
      update.locale = v;
    }

    const { error } = await supabase.from('tax_employees').update(update).eq('id', emp.id);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.employee', entityId: emp.id, action: 'update_profile',
        actorEmail: emp.email, actorName: emp.name,
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}

    const { data: refreshed } = await supabase.from('tax_employees')
      .select('id, community_id, email, name, first_name, middle_name, last_name, phone, whatsapp, address, preferred_communication_email, locale, notification_channels, notification_prefs, permissions, role, status, firebase_uid, last_sign_in_at')
      .eq('id', emp.id).maybeSingle();
    res.json({ ok: true, employee: pickEmployee(refreshed) });
  });

  // ── Phase 3b visibility helper ──────────────────────────────────────────
  // Returns:
  //   null              → employee sees ALL customers in the community
  //                       (role === 'admin')
  //   string[]          → exact set of customer IDs the employee may see
  //                       (role === 'staff' with assignments — possibly empty)
  // Callers should treat [] as "nothing visible" and short-circuit lists.
  async function getVisibleCustomerIdsForEmployee(emp) {
    if (emp.role === 'admin') return null;
    const { data } = await supabase.from('tax_employee_customer_assignments')
      .select('customer_id').eq('employee_id', emp.id).eq('active', true);
    return (data || []).map(r => r.customer_id);
  }

  // Sugar: returns true when emp can see this customer (admin always can).
  async function canEmployeeSeeCustomer(emp, customerId) {
    if (emp.role === 'admin') return true;
    const { data } = await supabase.from('tax_employee_customer_assignments')
      .select('id').eq('employee_id', emp.id).eq('customer_id', customerId)
      .eq('active', true).maybeSingle();
    return Boolean(data);
  }

  // ── GET /employee/customers ── (scoped customer search for staff/admin)
  // Same search/filter params as /admin/customers but scoped:
  //   role='admin'  → entire community (visible = null)
  //   role='staff'  → only customers in their tax_employee_customer_assignments
  // The customer detail page itself stays admin-gated; this endpoint just
  // powers a browse + search experience for staff.
  router.get('/employee/customers', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const visible = await getVisibleCustomerIdsForEmployee(emp);
    try {
      const customers = await searchCustomers({
        communitySlug: emp.community_id,
        q: req.query.q,
        relationshipTypeIds: parseCsvList(req.query.relationshipTypeIds),
        customerType: req.query.customerType,
        includeArchived: String(req.query.includeArchived || '').toLowerCase() === 'true',
        scopedCustomerIds: visible,         // null for admin, array for staff
      });
      res.json({ customers });
    } catch (e) {
      return sendSupabaseError(res, e);
    }
  });

  // ── GET /employee/threads ── (scoped by assignments for staff role)
  router.get('/employee/threads', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const visible = await getVisibleCustomerIdsForEmployee(emp);
    if (Array.isArray(visible) && visible.length === 0) return res.json({ threads: [] });

    let q = supabase.from('tax_message_threads')
      .select(`
        id, subject, status, last_message_at, last_message_preview, last_message_by_role,
        practice_unread, created_at, customer_id,
        customer:tax_customers ( id, email, name )
      `)
      .eq('community_id', emp.community_id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(500);
    if (Array.isArray(visible)) q = q.in('customer_id', visible);
    if (req.query.unreadOnly === 'true') q = q.eq('practice_unread', true);
    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);
    res.json({ threads: data || [] });
  });

  // ── GET /employee/threads/:id ── (404 when staff isn't assigned)
  router.get('/employee/threads/:id', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const id = trim(req.params.id, 200);
    const { data: thread } = await supabase.from('tax_message_threads')
      .select(`
        id, customer_id, community_id, subject, status, related_period_id, related_document_id,
        last_message_at, practice_unread, customer_unread, created_at,
        customer:tax_customers ( id, email, name, locale, phone, whatsapp, preferred_communication_email )
      `).eq('id', id).maybeSingle();
    if (!thread || thread.community_id !== emp.community_id) {
      return res.status(404).json({ error: 'Thread not found.' });
    }
    if (!(await canEmployeeSeeCustomer(emp, thread.customer_id))) {
      return res.status(404).json({ error: 'Thread not found.' });
    }

    const { data: messages, error } = await supabase.from('tax_messages')
      .select('id, author_role, author_email, author_name, body, attachments, created_at')
      .eq('thread_id', id).order('created_at', { ascending: true });
    if (error) return sendSupabaseError(res, error);
    if (thread.practice_unread) {
      await supabase.from('tax_message_threads')
        .update({ practice_unread: false, updated_at: new Date().toISOString() }).eq('id', id);
    }
    res.json({ thread, messages: messages || [] });
  });

  // ── POST /employee/threads/:id/messages ──
  router.post('/employee/threads/:id/messages', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const id = trim(req.params.id, 200);
    const messageBody = trim(req.body?.body, MAX_MESSAGE_BODY);
    if (!messageBody) return res.status(400).json({ error: 'Message body required.' });

    const { data: thread } = await supabase.from('tax_message_threads')
      .select('id, customer_id, community_id, status').eq('id', id).maybeSingle();
    if (!thread || thread.community_id !== emp.community_id) {
      return res.status(404).json({ error: 'Thread not found.' });
    }
    if (!(await canEmployeeSeeCustomer(emp, thread.customer_id))) {
      return res.status(403).json({ error: 'You are not assigned to this customer.' });
    }
    if (thread.status === 'closed') return res.status(409).json({ error: 'This thread is closed.' });

    const msgId = await insertMessage({
      threadId: id,
      communityId: thread.community_id,
      customerId: thread.customer_id,
      role: 'practice',
      email: emp.email,
      name: emp.name,
      body: messageBody,
    });
    notifyCustomerOfPracticeMessage(id, thread.customer_id, msgId)
      .catch(e => warn('[tax-msg] customer notify failed', e?.message || e));
    res.json({ ok: true, messageId: msgId });
  });

  // ── POST /employee/threads/:id/read ──
  router.post('/employee/threads/:id/read', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const id = trim(req.params.id, 200);
    const { data: thread } = await supabase.from('tax_message_threads')
      .select('id, community_id, customer_id').eq('id', id).maybeSingle();
    if (!thread || thread.community_id !== emp.community_id) return res.status(404).json({ error: 'Thread not found.' });
    if (!(await canEmployeeSeeCustomer(emp, thread.customer_id))) {
      return res.status(404).json({ error: 'Thread not found.' });
    }
    const { error } = await supabase.from('tax_message_threads')
      .update({ practice_unread: false, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── GET /employee/notifications ──
  // ── Phase 4n.23: practice triage / "today" dashboard ────────────────────
  //
  // Bundles the four signals staff actually look at every morning into one
  // round trip, scoped to what the caller is allowed to see (admins → the
  // whole community; staff → only their assigned customers).
  //
  //   overdue       — filings past due_date with status still pending /
  //                   info_requested. Sorted oldest-first so the worst-
  //                   neglected sit at the top.
  //   dueSoon       — same status filter, due_date within the next N days
  //                   (default 7).
  //   recent        — filings whose status flipped to info_received in the
  //                   last N days (default 7) — confirms what just came
  //                   in without scrolling Customers.
  //   unreadCount   — threads with practice_unread=true visible to caller.
  //   newLeads      — tax_leads with status='new' (admins only); empty
  //                   for staff since leads are a community-level queue.
  router.get('/employee/triage', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const windowDays = Math.max(1, Math.min(60, parseInt(req.query.windowDays, 10) || 7));
    const today = (new Date()).toISOString().slice(0, 10);
    const windowEnd = (() => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + windowDays);
      return d.toISOString().slice(0, 10);
    })();
    const recentSince = (() => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - windowDays);
      return d.toISOString();
    })();

    // Scope filter: admins see everything, staff intersect with their
    // assigned customer ids. An empty array → staff with no assignments →
    // short-circuit every period query.
    const visible = await getVisibleCustomerIdsForEmployee(emp);

    // BUG fix: this must be synchronous so callers can chain more filters
    // before executing. Supabase query builders are thenable, so an `await`
    // on the builder would execute the query prematurely. Returns the
    // chainable builder, or `null` to signal "skip" (staff with no
    // assignments) — caller checks for null and skips the chain.
    function periodSelect(builder) {
      let q = builder.select(`
        id, customer_id, due_date, status, period_label,
        customer:tax_customers ( id, email, name, locale ),
        workflow:tax_relationship_workflow_rules ( id, filing_schedule_slug, name_i18n ),
        schedule:tax_filing_schedules ( id, slug, name_i18n )
      `).eq('community_id', emp.community_id);
      if (Array.isArray(visible)) {
        if (!visible.length) return null;
        q = q.in('customer_id', visible);
      }
      return q;
    }

    const overdueQ = periodSelect(supabase.from('tax_filing_periods'));
    const overdueRows = !overdueQ ? []
      : (await overdueQ.in('status', ['pending', 'info_requested'])
                .lt('due_date', today)
                .order('due_date', { ascending: true })
                .limit(50)).data || [];

    const dueSoonQ = periodSelect(supabase.from('tax_filing_periods'));
    const dueSoonRows = !dueSoonQ ? []
      : (await dueSoonQ.in('status', ['pending', 'info_requested'])
                .gte('due_date', today).lte('due_date', windowEnd)
                .order('due_date', { ascending: true })
                .limit(50)).data || [];

    const recentQ = periodSelect(supabase.from('tax_filing_periods'));
    const recentRows = !recentQ ? []
      : (await recentQ.eq('status', 'info_received')
                .gte('info_received_at', recentSince)
                .order('info_received_at', { ascending: false })
                .limit(20)).data || [];

    // Unread thread count: staff only sees threads for assigned customers.
    let unreadCount = 0;
    {
      let q = supabase.from('tax_message_threads')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', emp.community_id)
        .eq('practice_unread', true);
      if (Array.isArray(visible)) {
        if (!visible.length) unreadCount = 0;
        else {
          const { count } = await q.in('customer_id', visible);
          unreadCount = count || 0;
        }
      } else {
        const { count } = await q;
        unreadCount = count || 0;
      }
    }

    // Leads are a community-level queue; only admins see them in triage.
    let newLeads = [];
    if (emp.role === 'admin') {
      const { data } = await supabase.from('tax_leads')
        .select('id, name, email, product_slug, product_slugs, created_at')
        .eq('community_id', emp.community_id).eq('status', 'new')
        .order('created_at', { ascending: false }).limit(10);
      newLeads = data || [];
    }

    // Phase 4n.25: pending signatures — same scope rules as periods.
    let pendingSignatures = [];
    {
      let q = supabase.from('tax_signature_requests')
        .select('id, title, customer_id, created_at, requested_by_name, customer:tax_customers ( id, email, name )')
        .eq('community_id', emp.community_id).eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(50);
      if (Array.isArray(visible)) {
        if (!visible.length) pendingSignatures = [];
        else {
          const { data } = await q.in('customer_id', visible);
          pendingSignatures = data || [];
        }
      } else {
        const { data } = await q;
        pendingSignatures = data || [];
      }
    }

    res.json({
      asOf: today,
      windowDays,
      overdue: overdueRows,
      dueSoon: dueSoonRows,
      recent: recentRows,
      unreadCount,
      newLeads,
      pendingSignatures,
    });
  });

  router.get('/employee/notifications', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const { data, error } = await supabase.from('tax_employee_notifications')
      .select('id, type, title_i18n, body_i18n, payload, read_at, created_at')
      .eq('employee_id', emp.id)
      .order('created_at', { ascending: false }).limit(50);
    if (error) return sendSupabaseError(res, error);
    res.json({ notifications: data || [] });
  });

  // ── GET /employee/help ── (Phase 4c)
  // Employee-audience help articles. No per-relationship filtering for v1 —
  // employees see all employee articles regardless of role. (Admin tools
  // article is shown to staff too; the article text itself explains the
  // role gating.)
  router.get('/employee/help', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    let articles = await loadEffectiveHelp({
      communityId: emp.community_id,
      audience: 'employee',
    });
    // Staff don't see admin-category articles — those cover features only
    // admins can access (Customers/Staff/Settings/Articles/FAQs/Audit/
    // Leads tabs). Filtering them out keeps the staff help center focused
    // and means admins impersonating a staff user can verify the staff
    // experience matches what real staff see.
    if (emp.role !== 'admin') {
      articles = articles.filter(a => a.category !== 'admin');
    }
    res.json({ articles });
  });

  // ── POST /employee/notifications/:id/read ──
  router.post('/employee/notifications/:id/read', async (req, res) => {
    const emp = await requireTaxEmployee(req, res); if (!emp) return;
    const id = trim(req.params.id, 200);
    const { error } = await supabase.from('tax_employee_notifications')
      .update({ read_at: new Date().toISOString() }).eq('id', id).eq('employee_id', emp.id);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // ── ADMIN: list / add employees (owner-side seeding until Phase 4a UI) ────
  // ── Email template overrides (Phase 4i) ─────────────────────────────────
  // Owner can override subject + body of each tax email per language.
  // Keys: welcome_customer, welcome_staff, reminder, document,
  //       message_to_customer, message_to_practice, message_to_employee, lead.
  const TAX_EMAIL_TEMPLATE_KEYS = [
    'welcome_customer', 'welcome_staff', 'reminder', 'document',
    'message_to_customer', 'message_to_practice', 'message_to_employee', 'lead',
    'signature_request', 'signature_signed',
  ];
  const TAX_EMAIL_TEMPLATE_LANGS = ['en', 'es'];

  router.get('/admin/email-templates', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const { data, error } = await supabase.from('tax_email_templates')
      .select('id, template_key, lang, subject, body_text, body_html, enabled, updated_at')
      .eq('community_id', communitySlug);
    if (error) return sendSupabaseError(res, error);
    res.json({ templates: data || [], keys: TAX_EMAIL_TEMPLATE_KEYS, langs: TAX_EMAIL_TEMPLATE_LANGS });
  });

  router.put('/admin/email-templates/:key/:lang', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_email_templates'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const key = trim(req.params.key, 60);
    const lang = trim(req.params.lang, 10);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    if (!TAX_EMAIL_TEMPLATE_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown template_key.' });
    if (!TAX_EMAIL_TEMPLATE_LANGS.includes(lang)) return res.status(400).json({ error: 'Unknown lang.' });

    const id = `tet_${communitySlug}_${key}_${lang}`.slice(0, 200);
    const row = {
      id, community_id: communitySlug, template_key: key, lang,
      subject: trim(body.subject, 4000),
      body_text: typeof body.body_text === 'string' ? body.body_text.slice(0, 32000) : '',
      body_html: typeof body.body_html === 'string' ? body.body_html.slice(0, 64000) : '',
      enabled: body.enabled === false ? false : true,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('tax_email_templates').upsert(row, { onConflict: 'id' });
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.email_template', entityId: id,
        action: 'upsert', actorEmail: '',
        after: { community: communitySlug, key, lang, enabled: row.enabled },
      });
    } catch (_e) {}
    res.json({ ok: true, template: row });
  });

  // DELETE → revert to hardcoded default
  router.delete('/admin/email-templates/:key/:lang', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_email_templates'))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    const key = trim(req.params.key, 60);
    const lang = trim(req.params.lang, 10);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    const id = `tet_${communitySlug}_${key}_${lang}`.slice(0, 200);
    const { error } = await supabase.from('tax_email_templates').delete().eq('id', id);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.email_template', entityId: id,
        action: 'reset_to_default', actorEmail: '',
        after: { community: communitySlug, key, lang },
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // Phase 4n.2: editable defaults — returns the {{placeholder}} template the
  // owner sees in the Email Templates form when no override exists. The form
  // pre-fills with this so the owner can tweak wording instead of starting
  // from a blank textarea.
  router.get('/admin/email-templates/defaults', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const key = trim(req.query.key, 60);
    const lang = trim(req.query.lang, 10) === 'en' ? 'en' : 'es';
    if (!TAX_EMAIL_TEMPLATE_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown template_key.' });
    if (typeof getTemplateDefaults !== 'function') return res.json({ subject: '', text: '', html: '' });
    const defaults = getTemplateDefaults({ key, lang });
    res.json({
      subject: defaults.subject || '',
      body_text: defaults.text || '',
      body_html: defaults.html || '',
      hasFactoredDefault: !!(defaults.subject || defaults.text || defaults.html),
    });
  });

  // ── Phase 4n: rendered preview ───────────────────────────────────────────
  // Renders a template with stub variables so the owner can see exactly what
  // the customer will receive before saving. Accepts an unsaved override in
  // the body — if omitted, falls back to whatever's persisted. Today only
  // `reminder` has fully factored defaults; other keys render the override
  // through the placeholder interpolator (partial=true).
  router.post('/admin/email-templates/preview', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    if (typeof previewTaxEmail !== 'function') {
      return res.status(500).json({ error: 'preview unavailable' });
    }
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const key = trim(body.key, 60);
    const lang = trim(body.lang, 10) === 'en' ? 'en' : 'es';
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });
    if (!TAX_EMAIL_TEMPLATE_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown template_key.' });

    // The body can pass `useUnsaved: true` with `subject`, `body_text`,
    // `body_html` to preview an in-flight edit. Otherwise the route loads
    // the persisted row via applyOverride() inside previewTaxEmail.
    const override = body.useUnsaved
      ? {
          subject: typeof body.subject === 'string' ? body.subject : '',
          body_text: typeof body.body_text === 'string' ? body.body_text : '',
          body_html: typeof body.body_html === 'string' ? body.body_html : '',
        }
      : null;

    // Stub data used for the reminder builder. Real values are pulled when
    // the cron actually fires; this mirrors the typical shape with realistic
    // placeholders so the owner can see the formatting.
    const stub = {
      communityId: communitySlug,
      row: {
        due_date: body.dueDate || '2026-06-15',
        period_label: body.periodLabel || (lang === 'en' ? 'Q2 2026' : 'T2 2026'),
      },
      cust: {
        name: body.customerName || (lang === 'en' ? 'Maria García' : 'María García'),
        email: 'preview@example.com',
        locale: lang,
        community_id: communitySlug,
      },
      sch: {
        name_i18n: { en: 'Federal Estimated Income Tax (1040-ES)', es: 'Impuesto Federal Estimado (1040-ES)' },
        description_i18n: { en: 'Quarterly estimated payment for the IRS.', es: 'Pago estimado trimestral para el IRS.' },
        info_checklist: Array.isArray(body.scheduleChecklist) ? body.scheduleChecklist : [
          { key: 'income_estimate', label_i18n: { en: 'Estimated income for the quarter', es: 'Ingresos estimados del trimestre' }, type: 'amount', required: true },
          { key: 'deductions', label_i18n: { en: 'Estimated deductions', es: 'Deducciones estimadas' }, type: 'amount', required: false },
        ],
      },
      sub: { custom_info_checklist: null, reminder_offsets_days: [] },
      magicUrl: 'https://example.com/tax/r/preview-magic-link',
      offsetDays: Number.isFinite(Number(body.offsetDays)) ? Math.abs(Number(body.offsetDays)) : 14,
      tips: [],
      extraDocs: Array.isArray(body.extraDocs) ? body.extraDocs : null,
    };

    try {
      const rendered = await previewTaxEmail({ key, lang, override, stub });
      return res.json({
        subject: rendered.subject || '',
        text: rendered.text || '',
        html: rendered.html || '',
        partial: !!rendered.partial,
        lang: rendered.lang || lang,
      });
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'preview failed' });
    }
  });

  // ── Owner setup status (Phase 4m) ─────────────────────────────────────────
  // Computes a 6-step onboarding checklist from existing data — no schema
  // changes. Drives the /employee/setup page and the "X of 6" banner on
  // the inbox. Each step:
  //   { key, done, optional?, summary } where summary is a short human-
  //   readable line shown inside the step card.
  router.get('/admin/setup-status', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    if (!communitySlug) return res.status(400).json({ error: 'communitySlug required.' });

    const [
      { data: community },
      svcCount,
      ruleCount,
      tmplCount,
      staffCount,
      custCount,
    ] = await Promise.all([
      supabase.from('communities')
        .select('id, name, contact_email, phone, logo_url, brand_primary_color, default_locale, tagline, tagline_en')
        .eq('id', communitySlug).maybeSingle(),
      supabase.from('tax_relationship_types')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', communitySlug),
      supabase.from('tax_relationship_workflow_rules')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', communitySlug),
      supabase.from('tax_email_templates')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', communitySlug),
      supabase.from('tax_employees')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', communitySlug).eq('status', 'active'),
      supabase.from('tax_customers')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', communitySlug).eq('status', 'active'),
    ]);

    const services    = svcCount?.count   || 0;
    const workflows   = ruleCount?.count  || 0;
    const templates   = tmplCount?.count  || 0;
    const staff       = staffCount?.count || 0;
    const customers   = custCount?.count  || 0;

    // Brand step: contact_email + phone both set (otherwise reminder
    // emails won't have a sensible "from" / footer).
    const brandDone = !!(community?.contact_email && community?.phone);

    res.json({
      community: community || null,
      counts: { services, workflows, templates, staff, customers },
      steps: [
        {
          key: 'brand',
          done: brandDone,
          summary: community
            ? `${community.name}${community.contact_email ? ` · ${community.contact_email}` : ''}`
            : '',
        },
        { key: 'services',  done: services  > 0, optional: true,  summary: `${services} custom service${services === 1 ? '' : 's'}` },
        { key: 'workflows', done: workflows > 0,                  summary: `${workflows} workflow rule${workflows === 1 ? '' : 's'}` },
        { key: 'emails',    done: templates > 0, optional: true,  summary: `${templates} custom template${templates === 1 ? '' : 's'}` },
        { key: 'staff',     done: staff     > 1, optional: true,  summary: `${staff} active staff member${staff === 1 ? '' : 's'}` },
        { key: 'customers', done: customers > 0,                  summary: `${customers} active customer${customers === 1 ? '' : 's'}` },
      ],
    });
  });

  router.get('/admin/employees', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const communitySlug = trim(req.query.communitySlug, 200);
    let q = supabase.from('tax_employees')
      .select('id, community_id, email, name, first_name, middle_name, last_name, role, status, notification_channels, permissions, show_on_homepage, photo_url, title_i18n, bio_i18n, role_i18n, highlights_i18n, education_i18n, experience_i18n, homepage_display_order, created_at, firebase_uid, last_sign_in_at')
      .order('created_at', { ascending: false }).limit(200);
    if (communitySlug) q = q.eq('community_id', communitySlug);
    const { data, error } = await q;
    if (error) return sendSupabaseError(res, error);

    // Attach an assigned-customer count per row so the Staff list can
    // surface "sees all customers" (admin) vs. "sees N assigned"
    // (staff) without an extra round-trip per row.
    const ids = (data || []).map(e => e.id);
    const counts = new Map();
    if (ids.length) {
      const { data: assignments } = await supabase
        .from('tax_employee_customer_assignments')
        .select('employee_id')
        .in('employee_id', ids).eq('active', true);
      for (const a of assignments || []) {
        counts.set(a.employee_id, (counts.get(a.employee_id) || 0) + 1);
      }
    }
    const enriched = (data || []).map(e => ({
      ...e, assigned_customer_count: counts.get(e.id) || 0,
    }));
    res.json({ employees: enriched });
  });

  router.post('/admin/employees', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_employees'))) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const email = trim(body.email, 200).toLowerCase();
    const np = resolveNamePayload(body);
    const role = (body.role === 'admin') ? 'admin' : 'staff';
    const locale = (body.locale === 'es') ? 'es' : 'en';
    // Default ON — mirrors the customer add flow. Owner can uncheck to add
    // a staff row without notifying them (e.g., seeding before go-live).
    const sendWelcome = body.sendWelcomeEmail === false ? false : true;
    if (!communitySlug || !email) return res.status(400).json({ error: 'communitySlug and email required.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Email is not valid.' });

    // Phase 4n.16: detect-before-insert so the response can tell the client
    // whether to render the "existing user" or "new user" success message.
    // The welcome sender repeats this lookup (so it stays correct on a
    // manual resend); the client gets it via the create response.
    const isExistingUser = await hasExistingAccountForEmail(email, communitySlug);

    const id = 'emp_' + uuidv4().slice(0, 12);
    const { error } = await supabase.from('tax_employees').insert({
      id, community_id: communitySlug, email,
      name: np.name, first_name: np.first, middle_name: np.middle, last_name: np.last,
      role, locale,
    });
    if (error) return sendSupabaseError(res, error);

    let welcomeResult = { sent: false, skipped: true };
    if (sendWelcome) {
      if (await communityStaffEmailFlag(communitySlug, 'tax_staff_email_welcome_enabled')) {
        welcomeResult = await sendWelcomeForEmployee(id);
      } else {
        welcomeResult = { sent: false, skipped: true, reason: 'staff_welcome_emails_disabled' };
      }
    }

    res.json({ ok: true, id, isExistingUser, welcomeEmail: welcomeResult });
  });

  // Phase 4n.16: archive (or restore) an employee. Soft-delete via status —
  // mirrors the customer flow. Archived employees:
  //   • can no longer sign in (requireTaxEmployee rejects non-active)
  //   • drop out of the message fan-out (admin + assigned queries filter
  //     status='active')
  //   • are preserved so audit history + past assignments stay intact
  // Restoring flips status back without re-creating any links.
  // GET /admin/permissions — registry. Surfaces the permission keys
  // available for delegation so the Team UI can render the right
  // toggles without hard-coding the list client-side.
  router.get('/admin/permissions', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    res.json({ permissions: TAX_PERMISSIONS });
  });

  // PUT /admin/employees/:id/permissions — replace the permission
  // overrides for one employee. Body: { permissions: { manage_settings: false, ... } }.
  // Only `false` entries are persisted (granted keys default-on); the
  // sanitizer drops unknown keys.
  router.put('/admin/employees/:id/permissions', async (req, res) => {
    const actor = await requireOwnerAdmin(req, res, 'manage_employees');
    if (!actor) return;
    const empId = trim(req.params.id, 200);
    const sanitized = sanitizePermissions(req.body?.permissions);

    const { data: existing } = await supabase.from('tax_employees')
      .select('id, email, community_id, role, permissions').eq('id', empId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Employee not found.' });

    // Block an owner-admin from accidentally locking themselves out of
    // employee management (only path back is direct DB access).
    if (actor.source === 'employee' && actor.employee?.id === empId
        && sanitized.manage_employees === false) {
      return res.status(409).json({
        error: 'cannot_revoke_self',
        message: 'You can\'t revoke your own manage_employees permission.',
      });
    }

    const { error } = await supabase.from('tax_employees')
      .update({ permissions: sanitized, updated_at: new Date().toISOString() })
      .eq('id', empId);
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.employee', entityId: empId, action: 'set_permissions',
        actorEmail: actor.email || '',
        before: { permissions: existing.permissions || {} },
        after:  { permissions: sanitized },
      });
    } catch (_e) {}
    res.json({ ok: true, permissions: sanitized });
  });

  // PUT /admin/employees/:id/public-profile — owner sets the homepage
  // profile fields (visibility, photo URL, title, bio, display order).
  // Gated on manage_employees so a delegated co-admin can curate the
  // team page without other admin powers.
  router.put('/admin/employees/:id/public-profile', async (req, res) => {
    const actor = await requireOwnerAdmin(req, res, 'manage_employees');
    if (!actor) return;
    const empId = trim(req.params.id, 200);
    const body = req.body || {};

    const { data: existing } = await supabase.from('tax_employees')
      .select('id, community_id').eq('id', empId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Employee not found.' });

    const update = { updated_at: new Date().toISOString() };
    if (body.showOnHomepage !== undefined) update.show_on_homepage = !!body.showOnHomepage;
    if (body.photoUrl !== undefined) {
      update.photo_url = String(body.photoUrl || '').trim().slice(0, 1000);
    }
    if (body.titleI18n && typeof body.titleI18n === 'object') {
      update.title_i18n = {
        en: String(body.titleI18n.en || '').slice(0, 200),
        es: String(body.titleI18n.es || '').slice(0, 200),
      };
    }
    if (body.bioI18n && typeof body.bioI18n === 'object') {
      update.bio_i18n = {
        en: String(body.bioI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.bioI18n.es || '').slice(0, MAX_TEXT_LEN),
      };
    }
    if (body.roleI18n && typeof body.roleI18n === 'object') {
      update.role_i18n = {
        en: String(body.roleI18n.en || '').slice(0, 200),
        es: String(body.roleI18n.es || '').slice(0, 200),
      };
    }
    if (body.highlightsI18n && typeof body.highlightsI18n === 'object') {
      update.highlights_i18n = {
        en: String(body.highlightsI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.highlightsI18n.es || '').slice(0, MAX_TEXT_LEN),
      };
    }
    if (body.educationI18n && typeof body.educationI18n === 'object') {
      update.education_i18n = {
        en: String(body.educationI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.educationI18n.es || '').slice(0, MAX_TEXT_LEN),
      };
    }
    if (body.experienceI18n && typeof body.experienceI18n === 'object') {
      update.experience_i18n = {
        en: String(body.experienceI18n.en || '').slice(0, MAX_TEXT_LEN),
        es: String(body.experienceI18n.es || '').slice(0, MAX_TEXT_LEN),
      };
    }
    if (Number.isFinite(Number(body.displayOrder))) {
      update.homepage_display_order = Math.max(0, Math.min(10000, Math.round(Number(body.displayOrder))));
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error } = await supabase.from('tax_employees').update(update).eq('id', empId);
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.employee', entityId: empId, action: 'public_profile_update',
        actorEmail: actor.email || '',
        after: Object.keys(update).filter(k => k !== 'updated_at'),
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // POST /admin/employees/:id/photo/upload-url — returns a one-shot signed
  // upload URL plus the resulting public URL. Mirrors the document-upload
  // pattern (no bytes pass through Node) but writes into a public bucket so
  // the resulting URL is stable and embeddable on the landing page without
  // re-signing on every render. After the PUT succeeds the client calls the
  // public-profile PUT with photoUrl=publicUrl to persist it on the row.
  const STAFF_PHOTO_BUCKET = 'tax-staff-photos';
  const STAFF_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
  const STAFF_PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  router.post('/admin/employees/:id/photo/upload-url', async (req, res) => {
    const actor = await requireOwnerAdmin(req, res, 'manage_employees');
    if (!actor) return;
    const empId = trim(req.params.id, 200);
    const body = req.body || {};
    const fileName = sanitizeFileName(body.fileName || 'photo.jpg');
    const mimeType = trim(body.mimeType, 200).toLowerCase();
    const sizeBytes = Number(body.sizeBytes);
    if (!STAFF_PHOTO_MIMES.has(mimeType)) {
      return res.status(415).json({ error: 'Photo must be JPG, PNG, WEBP, or GIF.' });
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > STAFF_PHOTO_MAX_BYTES) {
      return res.status(413).json({ error: 'Photo exceeds the 5 MB size limit.' });
    }
    const { data: emp } = await supabase.from('tax_employees')
      .select('id, community_id').eq('id', empId).maybeSingle();
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || 'jpg').toLowerCase();
    const objectKey = `${encodeURIComponent(emp.community_id)}/${encodeURIComponent(empId)}/${uuidv4().slice(0, 12)}.${ext}`;
    const { data: signed, error: sErr } = await supabase.storage
      .from(STAFF_PHOTO_BUCKET).createSignedUploadUrl(objectKey);
    if (sErr) {
      warn('[tax-staff-photo] createSignedUploadUrl failed', sErr.message);
      return res.status(500).json({ error: 'Could not prepare upload. Please retry.' });
    }
    const { data: pub } = supabase.storage.from(STAFF_PHOTO_BUCKET).getPublicUrl(objectKey);
    res.json({
      signedUrl: signed.signedUrl,
      path: objectKey,
      publicUrl: pub?.publicUrl || '',
    });
  });

  router.put('/admin/employees/:id/status', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res, 'manage_employees'))) return;
    const empId = trim(req.params.id, 200);
    const body = req.body || {};
    const status = String(body.status || '').toLowerCase();
    if (!['active', 'paused', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|paused|archived.' });
    }
    const { data: existing } = await supabase.from('tax_employees')
      .select('id, status, email, community_id').eq('id', empId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Employee not found.' });

    const { error } = await supabase.from('tax_employees')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', empId);
    if (error) return sendSupabaseError(res, error);

    // When archiving a staff member, deactivate their customer assignments
    // so the message fan-out and engagement queries don't keep returning
    // them. The assignment rows are retained for audit history.
    if (status === 'archived') {
      await supabase.from('tax_employee_customer_assignments')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('employee_id', empId).eq('active', true);
    }

    try {
      await auditLog({
        entity: 'tax.employee', entityId: empId, action: 'set_status',
        actorEmail: '',
        before: { status: existing.status },
        after: { status },
      });
    } catch (_e) {}
    res.json({ ok: true, status });
  });

  // POST /admin/employees/:id/send-welcome
  // Manual resend of the staff welcome email — useful if the original send
  // failed, the employee misplaced it, or they were seeded with the email
  // suppressed and need it later.
  router.post('/admin/employees/:id/send-welcome', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const empId = trim(req.params.id, 200);
    const result = await sendWelcomeForEmployee(empId);
    if (result.skipped) return res.json(result);
    if (result.sent === false) return res.status(500).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  });

  // Shared staff welcome-email plumbing — loads the employee + community,
  // builds the /employee URL, hands off to the sender. Audit-logged.
  async function sendWelcomeForEmployee(empId) {
    const { data: emp } = await supabase.from('tax_employees')
      .select('id, community_id, email, name, first_name, middle_name, last_name, role, locale, status')
      .eq('id', empId).maybeSingle();
    if (!emp) return { sent: false, error: 'Employee not found.' };
    if (emp.status !== 'active') return { sent: false, error: 'Employee is not active.' };

    const { data: community } = await supabase.from('communities')
      .select('id, name, contact_email').eq('id', emp.community_id).maybeSingle();

    // Phase 4n.16: detect existing account so the welcome email's sign-in
    // instructions are accurate. Existing customers in the same community,
    // or a Firebase identity that's already linked elsewhere on the
    // platform (app_users), both count as "existing".
    const existingAccount = await hasExistingAccountForEmail(emp.email, emp.community_id);
    // Pre-populate the staff portal sign-in form by passing the email
    // (and, for brand-new accounts, mode=create) as query params on
    // the welcome-email link. PortalLogin reads both. Existing users
    // land on the sign-in tab with their email already filled.
    const portalBase = `${(typeof publicAppUrl === 'function' ? publicAppUrl() : '')}/tax/${emp.community_id}/employee`;
    const linkParams = new URLSearchParams();
    if (emp.email) linkParams.set('email', emp.email);
    if (!existingAccount) linkParams.set('mode', 'create');
    const qs = linkParams.toString();
    const employeeUrl = qs ? `${portalBase}?${qs}` : portalBase;

    let result = { sent: false, skipped: true, reason: 'no_sender' };
    if (typeof sendTaxStaffWelcomeEmail === 'function') {
      try {
        result = await sendTaxStaffWelcomeEmail({ emp, community, employeeUrl, existingAccount });
      } catch (e) {
        warn('[tax] staff welcome email failed', e?.message || e);
        result = { sent: false, error: e?.message || 'Send failed.' };
      }
    }
    result.existingAccount = existingAccount;
    try {
      await auditLog({
        entity: 'tax.employee', entityId: empId,
        action: 'send_welcome_email',
        actorEmail: '',
        after: { to: emp.email, locale: emp.locale, role: emp.role, sent: !!result.sent },
      });
    } catch (_e) {}
    return result;
  }

  // Phase 4n.16: cheap existence check. Looks across the obvious places
  // someone might already have a Firebase identity tied to this email:
  //   1. tax_customers in the same community  (almost always the case
  //      when an owner is "promoting" a customer to staff)
  //   2. tax_customers in OTHER communities    (dual-tenant practitioners)
  //   3. app_users                              (anyone who's signed into
  //      the Kai parent app — covers dual-role)
  // Returning `true` from any of these is enough for the welcome email's
  // copy to switch to "use your existing sign-in".
  async function hasExistingAccountForEmail(emailIn, communityId) {
    const email = String(emailIn || '').trim().toLowerCase();
    if (!email) return false;
    try {
      const [{ data: cust }, { data: user }] = await Promise.all([
        supabase.from('tax_customers')
          .select('id, firebase_uid').eq('email', email).limit(1),
        supabase.from('app_users')
          .select('uid').eq('email', email).limit(1),
      ]);
      if (Array.isArray(cust) && cust.some(c => c.id || c.firebase_uid)) return true;
      if (Array.isArray(user) && user.length) return true;
    } catch (_e) { /* be permissive — falling back to "new user" is safe */ }
    return false;
  }

  // Phase 4n.17: throttled last-sign-in stamp. Fire-and-forget — never
  // blocks the /me response. Skip the write when the existing stamp is
  // newer than STAMP_THROTTLE_MS so we don't churn the row on polling
  // loads (the customer portal calls /me on every page navigation).
  const STAMP_THROTTLE_MS = 5 * 60 * 1000;
  function stampLastSignIn(tableName, rowId, currentValue) {
    if (!supabase || !rowId) return;
    try {
      if (currentValue) {
        const last = new Date(currentValue).getTime();
        if (Number.isFinite(last) && (Date.now() - last) < STAMP_THROTTLE_MS) return;
      }
    } catch (_e) { /* fall through and stamp */ }
    const nowIso = new Date().toISOString();
    supabase.from(tableName).update({ last_sign_in_at: nowIso }).eq('id', rowId)
      .then(({ error }) => { if (error) warn(`[tax] ${tableName} last_sign_in_at update failed`, error.message); })
      // .then on a Postgrest builder is thenable but doesn't reject normally
      // — wrap any sync throw above just in case.
      .catch(() => {});
  }

  // ── ADMIN: impersonation (admin-only "view as") ─────────────────────────

  const IMPERSONATION_TTL_MS = 60 * 60 * 1000; // 1 hour
  const IMP_TOKEN_HEADER = 'x-impersonation-token';

  // Reads the impersonation token from the request and returns the active
  // session row if valid AND the target type matches; null when no token
  // is present (so callers can fall through to Firebase auth); false when a
  // token IS present but invalid (caller should bail — 401 already sent).
  async function loadImpersonationFromRequest(req, res, expectedTargetType) {
    const token = trim(req.get(IMP_TOKEN_HEADER) || '', 200);
    if (!token) return null;
    const { data: session, error } = await supabase.from('tax_impersonation_sessions')
      .select('id, community_id, admin_employee_id, admin_email, target_type, target_id, target_email, target_name, expires_at, ended_at')
      .eq('id', token).maybeSingle();
    if (error) { sendSupabaseError(res, error); return false; }
    if (!session) {
      res.status(401).json({ error: 'Impersonation session invalid.' });
      return false;
    }
    if (session.ended_at) {
      res.status(401).json({ error: 'Impersonation session ended.' });
      return false;
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      res.status(401).json({ error: 'Impersonation session expired.' });
      return false;
    }
    if (session.target_type !== expectedTargetType) {
      res.status(403).json({ error: 'Impersonation target type mismatch.' });
      return false;
    }
    return session;
  }

  // POST /admin/impersonation/start
  // Body { communitySlug, targetType: 'customer'|'employee', targetId }
  // Returns { token, target, expiresAt }.
  router.post('/admin/impersonation/start', async (req, res) => {
    const auth = await requireOwnerAdmin(req, res); if (!auth) return;
    const body = req.body || {};
    const communitySlug = trim(body.communitySlug, 200);
    const targetType = trim(body.targetType, 40);
    const targetId = trim(body.targetId, 200);
    if (!communitySlug || !targetId || !['customer', 'employee'].includes(targetType)) {
      return res.status(400).json({ error: 'communitySlug, targetType (customer|employee), and targetId required.' });
    }

    // The admin must be a role='admin' employee in this community. Global
    // admin (env header) callers can impersonate too — they look up the
    // first admin employee row for the community as the "admin_employee_id"
    // for the audit row. If none exists, the impersonation is rejected to
    // avoid orphaned audit trails.
    let adminEmployeeId = auth.employee?.id;
    let adminEmail = auth.email;
    if (!adminEmployeeId) {
      const { data: anyAdmin } = await supabase.from('tax_employees')
        .select('id, email').eq('community_id', communitySlug)
        .eq('role', 'admin').eq('status', 'active').limit(1).maybeSingle();
      if (!anyAdmin) {
        return res.status(409).json({ error: 'No admin employee exists in this community; create one before impersonating.' });
      }
      adminEmployeeId = anyAdmin.id;
    }

    let targetEmail = '';
    let targetName = '';
    if (targetType === 'customer') {
      const { data: cust } = await supabase.from('tax_customers')
        .select('id, community_id, email, name, status').eq('id', targetId).maybeSingle();
      if (!cust || cust.community_id !== communitySlug) return res.status(404).json({ error: 'Customer not found in this community.' });
      if (cust.status !== 'active') return res.status(409).json({ error: 'Customer is not active.' });
      targetEmail = cust.email; targetName = cust.name || '';
    } else {
      const { data: emp } = await supabase.from('tax_employees')
        .select('id, community_id, email, name, status').eq('id', targetId).maybeSingle();
      if (!emp || emp.community_id !== communitySlug) return res.status(404).json({ error: 'Employee not found in this community.' });
      if (emp.status !== 'active') return res.status(409).json({ error: 'Employee is not active.' });
      targetEmail = emp.email; targetName = emp.name || '';
    }

    const token = 'imp_' + crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS).toISOString();
    const { error } = await supabase.from('tax_impersonation_sessions').insert({
      id: token,
      community_id: communitySlug,
      admin_employee_id: adminEmployeeId,
      admin_email: adminEmail,
      target_type: targetType,
      target_id: targetId,
      target_email: targetEmail,
      target_name: targetName,
      expires_at: expiresAt,
    });
    if (error) return sendSupabaseError(res, error);

    try {
      await auditLog({
        entity: 'tax.impersonation', entityId: token,
        action: 'start', actorEmail: adminEmail,
        after: { targetType, targetId, targetEmail, expiresAt },
      });
    } catch (_e) {}

    res.json({
      token,
      target: { type: targetType, id: targetId, email: targetEmail, name: targetName, communitySlug },
      expiresAt,
    });
  });

  // POST /admin/impersonation/:token/end
  router.post('/admin/impersonation/:token/end', async (req, res) => {
    // We allow ANY authenticated admin in the community to end any session
    // — practical for revoking sessions of departing admins. The session's
    // own community_id gates the action.
    const auth = await requireOwnerAdmin(req, res); if (!auth) return;
    const token = trim(req.params.token, 200);
    const { data: session } = await supabase.from('tax_impersonation_sessions')
      .select('id, community_id, target_id, target_type, admin_email').eq('id', token).maybeSingle();
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    await supabase.from('tax_impersonation_sessions')
      .update({ ended_at: new Date().toISOString() }).eq('id', token);
    try {
      await auditLog({
        entity: 'tax.impersonation', entityId: token,
        action: 'end', actorEmail: auth.email,
        after: { endedBy: auth.email, originalAdmin: session.admin_email },
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // ── ADMIN: employee↔customer assignment management (Phase 3b) ────────────

  // GET /admin/employees/:id/assignments — list a staff member's roster
  router.get('/admin/employees/:id/assignments', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const empId = trim(req.params.id, 200);
    const { data, error } = await supabase.from('tax_employee_customer_assignments')
      .select(`
        id, employee_id, customer_id, is_primary, active, created_at, assigned_by_email,
        customer:tax_customers ( id, email, name, phone, status )
      `)
      .eq('employee_id', empId).eq('active', true).order('created_at', { ascending: false });
    if (error) return sendSupabaseError(res, error);
    res.json({ assignments: data || [] });
  });

  // POST /admin/employees/:id/assignments — assign a customer to an employee
  // Body: { customerId, isPrimary? }
  router.post('/admin/employees/:id/assignments', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const empId = trim(req.params.id, 200);
    const customerId = trim(req.body?.customerId, 200);
    const isPrimary = Boolean(req.body?.isPrimary);
    if (!customerId) return res.status(400).json({ error: 'customerId required.' });

    const [{ data: emp }, { data: cust }] = await Promise.all([
      supabase.from('tax_employees').select('id, community_id').eq('id', empId).maybeSingle(),
      supabase.from('tax_customers').select('id, community_id').eq('id', customerId).maybeSingle(),
    ]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });
    if (emp.community_id !== cust.community_id) {
      return res.status(400).json({ error: 'Employee and customer belong to different communities.' });
    }

    const id = 'asn_' + uuidv4().slice(0, 12);
    const actor = trim(req.get('x-admin-email') || '', 200).toLowerCase();
    // Upsert reactivates a previously soft-deleted row in place.
    const { error } = await supabase.from('tax_employee_customer_assignments').upsert({
      id,
      community_id: emp.community_id,
      employee_id: empId,
      customer_id: customerId,
      is_primary: isPrimary,
      assigned_by_email: actor || null,
      active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'employee_id,customer_id' });
    if (error) return sendSupabaseError(res, error);
    try {
      await auditLog({
        entity: 'tax.employee_assignment', entityId: `${empId}:${customerId}`,
        action: 'assign', actorEmail: actor || 'admin',
        after: { employeeId: empId, customerId, isPrimary },
      });
    } catch (_e) {}
    res.json({ ok: true });
  });

  // DELETE /admin/employees/:id/assignments/:customerId — soft delete
  router.delete('/admin/employees/:id/assignments/:customerId', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const empId = trim(req.params.id, 200);
    const customerId = trim(req.params.customerId, 200);
    const { error } = await supabase.from('tax_employee_customer_assignments')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('employee_id', empId).eq('customer_id', customerId);
    if (error) return sendSupabaseError(res, error);
    res.json({ ok: true });
  });

  // GET /admin/customers/:id/assignments — list employees on a customer
  router.get('/admin/customers/:id/assignments', async (req, res) => {
    if (!(await requireOwnerAdmin(req, res))) return;
    const customerId = trim(req.params.id, 200);
    const { data, error } = await supabase.from('tax_employee_customer_assignments')
      .select(`
        id, employee_id, customer_id, is_primary, active, created_at, assigned_by_email,
        employee:tax_employees ( id, email, name, role, status )
      `)
      .eq('customer_id', customerId).eq('active', true).order('is_primary', { ascending: false });
    if (error) return sendSupabaseError(res, error);
    res.json({ assignments: data || [] });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function activeTypeIdsForCustomer(customerId) {
    const { data } = await supabase.from('tax_customer_relationships')
      .select('relationship_type_id').eq('customer_id', customerId).eq('active', true);
    return (data || []).map(r => r.relationship_type_id);
  }

  // Phase 4e: merges platform-default help articles with per-community
  // overrides/customs, mirroring the FAQ merge pattern.
  //
  // For audience='customer', customerRelationshipTypeIds filters defaults to
  //   (relationship_type_id IS NULL) OR (in customer's tagged set)
  // Community-custom articles are also filtered by the same rule (a custom
  // article tagged with a relationship type only shows to customers who
  // have it; null-tagged customs show to everyone).
  //
  // Each returned article carries source: 'default'|'override'|'custom' so
  // the admin UI can show overlay badges, and id retains the row the UI
  // would edit (community-row id for override/custom, default id for plain
  // defaults).
  async function loadEffectiveHelp({ communityId, audience, customerRelationshipTypeIds = null }) {
    // Defaults
    let defaultsQ = supabase.from('tax_help_articles')
      .select(`
        id, audience, relationship_type_id, category, display_order,
        title_i18n, body_i18n, source_note, video_url,
        type:tax_relationship_types ( id, category, slug, name_i18n )
      `)
      .eq('audience', audience).eq('active', true);
    if (audience === 'customer') {
      if (customerRelationshipTypeIds && customerRelationshipTypeIds.length) {
        const inList = customerRelationshipTypeIds.map(id => `"${id}"`).join(',');
        defaultsQ = defaultsQ.or(`relationship_type_id.is.null,relationship_type_id.in.(${inList})`);
      } else {
        defaultsQ = defaultsQ.is('relationship_type_id', null);
      }
    }
    const { data: defaults, error: dErr } = await defaultsQ;
    if (dErr) throw new Error(dErr.message);

    // Community overrides + customs
    const { data: community, error: cErr } = await supabase.from('tax_community_help_articles')
      .select(`
        id, default_help_article_id, audience, relationship_type_id, category,
        display_order, title_i18n, body_i18n, visible, source_note, video_url,
        type:tax_relationship_types ( id, category, slug, name_i18n )
      `)
      .eq('community_id', communityId).eq('audience', audience);
    if (cErr) throw new Error(cErr.message);

    const overrideByDefault = new Map();
    const customs = [];
    for (const row of community || []) {
      if (row.default_help_article_id) overrideByDefault.set(row.default_help_article_id, row);
      else customs.push(row);
    }

    // Build defaults-derived list, applying override/hide.
    const merged = [];
    for (const d of defaults || []) {
      const ov = overrideByDefault.get(d.id);
      if (ov && ov.visible === false) continue;
      if (ov) {
        merged.push({
          id: ov.id,
          source: 'override',
          defaultId: d.id,
          audience: d.audience,
          relationship_type_id: d.relationship_type_id,
          type: d.type,
          category: d.category,
          display_order: ov.display_order ?? d.display_order,
          title_i18n: ov.title_i18n && Object.keys(ov.title_i18n).length ? ov.title_i18n : d.title_i18n,
          body_i18n:  ov.body_i18n  && Object.keys(ov.body_i18n).length  ? ov.body_i18n  : d.body_i18n,
          video_url: ov.video_url || d.video_url || '',
          source_note: d.source_note,
        });
      } else {
        merged.push({ ...d, source: 'default' });
      }
    }

    // Append customs (filtered by relationship for customer audience).
    for (const c of customs) {
      if (audience === 'customer') {
        if (c.relationship_type_id) {
          if (!customerRelationshipTypeIds || !customerRelationshipTypeIds.includes(c.relationship_type_id)) continue;
        }
      }
      merged.push({ ...c, source: 'custom' });
    }

    merged.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    return merged;
  }

  // Loads default FAQs + community overrides/customs, merges them into the
  // "effective" set, and groups by relationship type.
  //   filterTypeIds: null → all active types; array → only these types
  async function loadEffectiveFaqs({ communityId, filterTypeIds }) {
    const typeQ = supabase.from('tax_relationship_types')
      .select('id, category, slug, name_i18n, description_i18n, display_order')
      .eq('active', true);
    const types = await typeQ;
    if (types.error) throw new Error(types.error.message);
    let typeRows = types.data || [];
    if (Array.isArray(filterTypeIds)) {
      const allow = new Set(filterTypeIds);
      typeRows = typeRows.filter(t => allow.has(t.id));
    }
    typeRows.sort((a, b) => a.display_order - b.display_order);
    if (!typeRows.length) return { groups: [] };

    const typeIds = typeRows.map(t => t.id);
    const [defaults, overrides] = await Promise.all([
      supabase.from('tax_relationship_default_faqs')
        .select('id, relationship_type_id, display_order, question_i18n, answer_i18n, source_note, video_url')
        .in('relationship_type_id', typeIds),
      supabase.from('tax_relationship_faqs')
        .select('id, relationship_type_id, default_faq_id, display_order, question_i18n, answer_i18n, visible, video_url')
        .eq('community_id', communityId)
        .in('relationship_type_id', typeIds),
    ]);
    if (defaults.error) throw new Error(defaults.error.message);
    if (overrides.error) throw new Error(overrides.error.message);

    const overrideByDefault = new Map();
    const customsByType = new Map();
    for (const o of overrides.data || []) {
      if (o.default_faq_id) overrideByDefault.set(o.default_faq_id, o);
      else {
        const arr = customsByType.get(o.relationship_type_id) || [];
        arr.push(o); customsByType.set(o.relationship_type_id, arr);
      }
    }

    const groups = typeRows.map(t => {
      const items = [];
      for (const d of (defaults.data || []).filter(d => d.relationship_type_id === t.id)) {
        const ov = overrideByDefault.get(d.id);
        if (ov && ov.visible === false) continue;
        if (ov) {
          items.push({
            id: ov.id, source: 'override', defaultFaqId: d.id,
            display_order: ov.display_order ?? d.display_order,
            question_i18n: ov.question_i18n || d.question_i18n,
            answer_i18n: ov.answer_i18n || d.answer_i18n,
            video_url: ov.video_url || d.video_url || '',
            source_note: d.source_note,
          });
        } else {
          items.push({
            id: d.id, source: 'default',
            display_order: d.display_order,
            question_i18n: d.question_i18n,
            answer_i18n: d.answer_i18n,
            video_url: d.video_url || '',
            source_note: d.source_note,
          });
        }
      }
      for (const c of customsByType.get(t.id) || []) {
        items.push({
          id: c.id, source: 'custom',
          display_order: c.display_order,
          question_i18n: c.question_i18n,
          answer_i18n: c.answer_i18n,
          video_url: c.video_url || '',
        });
      }
      items.sort((a, b) => a.display_order - b.display_order);
      return { type: t, faqs: items };
    });
    return { groups };
  }

  function safeI18n(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const k of ['en', 'es']) {
      if (typeof v[k] === 'string') out[k] = trim(v[k], MAX_TEXT_LEN);
    }
    return out;
  }

  function uniqueChannels(subs) {
    const set = new Set();
    for (const s of subs || []) {
      for (const c of s.reminder_channels || []) set.add(c);
    }
    if (!set.size) { set.add('email'); set.add('in_app'); }
    return [...set];
  }
  function pickCustomer(c) {
    return {
      id: c.id, email: c.email, name: c.name,
      phone: c.phone, whatsapp: c.whatsapp || '',
      address: c.address || {},
      preferredCommunicationEmail: c.preferred_communication_email || '',
      locale: c.locale, status: c.status,
      lastSignInAt: c.last_sign_in_at || null,
    };
  }

  // ── Phase 2e helpers ───────────────────────────────────────────────────────
  // Strip every character except digits and a leading +, then verify the
  // result is valid E.164: starts with +, first digit 1-9, total 7-15 digits.
  // Returns the normalized string (e.g. "+14155551234") or null on failure.
  function normalizeWhatsapp(raw) {
    const trimmed = String(raw || '').trim();
    // Keep only digits and a single leading +.
    const cleaned = '+' + trimmed.replace(/^\+/, '').replace(/\D+/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) return null;
    return cleaned;
  }

  // Sanitize an address payload into the canonical { line1, line2, city,
  // state, postal_code, country } shape. Drops unknown keys, trims strings,
  // and caps each to MAX_NAME_LEN. country defaults to 'US' when an address
  // line is present.
  function sanitizeAddress(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const fields = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'];
    const out = {};
    for (const k of fields) {
      const v = input[k];
      if (typeof v === 'string') {
        const t = v.trim().slice(0, MAX_NAME_LEN);
        if (t) out[k] = t;
      }
    }
    if (out.line1 && !out.country) out.country = 'US';
    return out;
  }

  return router;
};
