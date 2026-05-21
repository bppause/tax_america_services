const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { log, warn, error } = require('../logger');

const { publicAppUrl } = require('./core/utils');
const { sendSupabaseError } = require('./core/http');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── SUPABASE STORAGE ONLY ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. App data storage requires Supabase.');
}

const supabase = createClient(
  SUPABASE_URL || 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key',
  { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } }
);

const requireSupabaseEnv = (res) => {
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) return true;
  res.status(500).json({ error: 'Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  return false;
};

// ─── EMAIL (Resend HTTPS API) ────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.FROM_EMAIL || 'Tax America Services <onboarding@resend.dev>';
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();

const resend = (EMAIL_PROVIDER === 'resend' && RESEND_API_KEY) ? new Resend(RESEND_API_KEY) : null;
const emailConfigured = Boolean(resend && EMAIL_FROM);

// ─── CONFIG / AUDIT / EMAIL / ROLE HELPERS ───────────────────────────────────
const { getAppConfig, getEscalationCcEmails } = require('./core/config')(supabase, { EMAIL_FROM });
const { auditLog } = require('./core/audit')(supabase, { getAppConfig });
const { sendSpanishEmail } = require('./core/email')({ resend, emailConfigured, EMAIL_FROM, getAppConfig });
const { isGlobalAdmin, isEnvGlobalAdminEmail } =
  require('./core/roles')({ supabase, getAppConfig, getEscalationCcEmails });

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors());

// Resend webhook + inbound receivers — must run BEFORE express.json() so the
// raw body is available for HMAC signature verification. The handlers parse
// JSON themselves after verifying.
const taxResendWebhook = require('./modules/tax/resend-webhook')({
  supabase,
  isSupabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  signingSecret: process.env.RESEND_WEBHOOK_SECRET || '',
});
app.post('/api/m/tax/resend/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  taxResendWebhook.handle);

const taxResendInbound = require('./modules/tax/resend-inbound')({
  supabase,
  isSupabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  signingSecret: process.env.RESEND_INBOUND_SECRET || '',
});
app.post('/api/m/tax/email/inbound',
  express.raw({ type: '*/*', limit: '5mb' }),
  taxResendInbound.handle);

app.use(express.json({ limit: '15mb' }));

// Serve built React app
const DIST = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(DIST));

// ─── API: META (/api/health, /api/client-log, /api/version) ─────────────────
const metaModule = require('./platform/meta');
app.use('/api', metaModule.createRouter({
  supabase,
  isSupabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  emailConfigured, emailProvider: EMAIL_PROVIDER, emailFrom: EMAIL_FROM,
  distPath: DIST,
}));

// ─── API: TAX (mounted from server/modules/tax) ──────────────────────────────
// Canonical: /api/m/tax/*
// Reuses platform `communities` (business_type='tax') as the multi-tenant boundary.
const taxModule = require('./modules/tax');

// Owner-editable subject + body override loader. Senders call this with
// (communityId, template_key, lang); a non-null result with enabled=true
// replaces the hardcoded defaults for non-empty fields.
async function loadTaxEmailTemplate(communityId, key, lang) {
  if (!supabase || !communityId || !key || !lang) return null;
  const { data, error } = await supabase
    .from('tax_email_templates')
    .select('subject, body_text, body_html, enabled')
    .eq('community_id', communityId)
    .eq('template_key', key)
    .eq('lang', lang)
    .maybeSingle();
  if (error || !data || !data.enabled) return null;
  return data;
}

// Tax-specific delivery log. Keys the row by Resend's message id so the
// /resend/webhook receiver can stamp open/click events. Different from the
// generic logEmailDelivery: we need the message id as the lookup key, plus
// customer_id for the badge on the customer detail page.
async function logTaxEmailDelivery({ resendId, communityId, customerId, workflowRuleId, eventType, recipients, subject, relatedEntity, relatedId, outboundMessageId, threadId }) {
  if (!supabase) return;
  try {
    await supabase.from('email_delivery_logs').insert({
      id: 'eml_' + uuidv4().slice(0, 12),
      community_id: communityId || 'tax-america-services',
      event_type: String(eventType || ''),
      recipients: Array.isArray(recipients) ? recipients : [],
      subject: String(subject || '').slice(0, 4000),
      status: 'sent',
      error_message: '',
      related_entity: String(relatedEntity || ''),
      related_id: String(relatedId || ''),
      resend_id: resendId || null,
      customer_id: customerId || null,
      workflow_rule_id: workflowRuleId || null,
      outbound_message_id: outboundMessageId || null,
      thread_id: threadId || null,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[tax] logTaxEmailDelivery failed:', e?.message || e);
  }
}

const {
  sendTaxLeadEmail, sendTaxTaskAssignedEmail, sendTaxDailyDigestEmail,
  sendTaxReminderEmail, sendTaxDocumentEmail,
  sendTaxMessageEmail, sendTaxMessagePracticeEmail, sendTaxMessageEmployeeEmail,
  sendTaxWelcomeEmail, sendTaxStaffWelcomeEmail,
  sendTaxSignatureRequestEmail, sendTaxSignatureSignedEmail,
  previewTaxEmail, getTemplateDefaults,
} = require('./modules/tax/email-senders')({
  sendSpanishEmail, emailConfigured, loadTaxEmailTemplate, logTaxEmailDelivery,
  publicAppUrl: () => publicAppUrl(),
});

const taxRemindersCron = require('./modules/tax/reminders')({
  supabase,
  isSupabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  publicAppUrl: () => publicAppUrl(),
  emailConfigured,
  sendTaxReminderEmail,
  auditLog,
});

const taxDigestCron = require('./modules/tax/digest')({
  supabase,
  isSupabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  publicAppUrl: () => publicAppUrl(),
  emailConfigured,
  sendTaxDailyDigestEmail,
  auditLog,
});

const taxRouter = taxModule.createRouter({
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
  publicAppUrl: () => publicAppUrl(),
  isGlobalAdmin,
  isEnvGlobalAdminEmail,
  runReminderCron: taxRemindersCron.run,
  fireReminderForPeriod: taxRemindersCron.fireForPeriod,
});
app.use('/api/m/tax', taxRouter);

// Tax reminder cron — walks subscriptions, generates filing periods, fires
// reminders at the configured offsets. Daily cadence (12h interval) keeps it
// well within Render's free-tier restart window.
taxRemindersCron.start({ intervalMs: 12 * 60 * 60 * 1000, initialDelayMs: 60 * 1000 });

// Daily-digest cron — sends once per configured day per community
// (default 8 AM America/New_York, Mon–Fri). 5-min interval keeps the
// landing window tight to the owner's chosen hour; per-community
// dedupe via tax_digest_log makes sure only the first tick that
// crosses the threshold sends.
taxDigestCron.start({ intervalMs: 5 * 60 * 1000, initialDelayMs: 90 * 1000 });

// Public SEO endpoint — lists active tax community landings. Lives at root
// (search-engine convention). robots.txt is static under client/public/.
app.get('/sitemap.xml', async (req, res) => {
  try {
    const base = (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    let urls = [];
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const { data } = await supabase
        .from('communities')
        .select('id, business_type, is_active, updated_at')
        .eq('is_active', true)
        .eq('business_type', 'tax');
      urls = (data || []).map(c => ({
        loc: `${base}/tax/${encodeURIComponent(c.id)}`,
        lastmod: c.updated_at ? new Date(c.updated_at).toISOString().slice(0, 10) : null,
      }));
    }
    const entries = urls.map(u =>
      `  <url>\n    <loc>${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}\n  </url>`
    ).join('\n');
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
    );
  } catch (e) {
    warn('[sitemap] failed', e?.message || e);
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset/>');
  }
});

// ─── CATCH-ALL → React ───────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const idx = path.join(DIST, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.send(`<html><body style="font:16px sans-serif;padding:32px;background:#07141e;color:#dff0f5">
    <h2>⚠️ React build not found</h2>
    <p>Build command may have failed. Check Render build logs.</p>
    <p>Looking for: <code>${idx}</code></p>
    <p>Dist exists: <strong>${fs.existsSync(DIST)}</strong></p>
    <p>__dirname: <code>${__dirname}</code></p>
    <p>ls client/: <code>${fs.existsSync(path.join(__dirname,'..','client')) ? fs.readdirSync(path.join(__dirname,'..','client')).join(', ') : 'folder missing'}</code></p>
  </body></html>`);
});
app.listen(PORT, () => {
  log(`\nTax America Services running on port ${PORT}`);
  if (process.env.DEBUG === 'true') log(`Static: ${DIST} | exists: ${fs.existsSync(DIST)}`);
  log('Storage: Supabase tables only');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) warn('Supabase environment variables are missing. API calls will fail until configured.');
});
