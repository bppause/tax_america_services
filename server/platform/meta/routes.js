// Platform meta routes — bootstrap-time concerns that don't belong to any
// feature module:
//   POST /api/client-log   (browser-side error reports)
//   GET  /api/health       (DB + email reachability)
//   GET  /api/version      (build timestamp from client/dist/build-meta.json)

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { warn } = require('../../../logger');

module.exports = function createMetaRouter(deps) {
  const {
    supabase, isSupabaseConfigured,
    emailConfigured, emailProvider, emailFrom,
    distPath,
  } = deps;

  const router = express.Router();

  // POST /client-log — browser diagnostics → Render logs
  router.post('/client-log', (req, res) => {
    try {
      const body = req.body || {};
      warn('[CLIENT_LOG] ' + JSON.stringify({ section:body.section, message:body.message, status:body.status, url:body.url, ts:body.ts || new Date().toISOString() }).slice(0, 2000));
      if (body.stack) warn('[CLIENT_LOG_STACK] ' + String(body.stack).slice(0, 3000));
    } catch(e) { warn('[CLIENT_LOG_ERROR] ' + (e?.message || e)); }
    res.json({ ok:true });
  });

  // GET /health — Supabase + email reachability. Pings audit_logs as the
  // canary table (always present; small; no PII surfaced via head/count).
  router.get('/health', async (req, res) => {
    const result = { ok: false, configured: isSupabaseConfigured, storage: 'supabase', time: new Date().toISOString() };

    if (!isSupabaseConfigured) {
      result.error = 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Render Environment.';
      return res.status(500).json(result);
    }

    const dbCheck = await supabase.from('audit_logs').select('id', { count: 'exact', head: true });

    if (dbCheck.error) {
      result.error = dbCheck.error.message;
      result.db = 'error';
      return res.status(500).json(result);
    }

    result.ok = true;
    result.db = 'ok';
    result.emailProvider = emailProvider;
    result.emailConfigured = emailConfigured;
    result.emailFrom = emailFrom;
    res.json(result);
  });

  // GET /version — build timestamp from client/dist/build-meta.json, plus
  // the deployed commit when available. Render auto-injects
  // RENDER_GIT_COMMIT (full SHA) into the running service's environment
  // on every deploy — no render.yaml change needed; it's just unset in
  // local dev. Surfaced in the employee portal, customer portal, and
  // public site footers so support can tell which deploy someone is on.
  router.get('/version', (req, res) => {
    const commit = String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(distPath, 'build-meta.json'), 'utf8'));
      res.json({ buildTime: meta.buildTime || '', commit });
    } catch(e) {
      res.json({ buildTime: '', commit });
    }
  });

  return router;
};
