// Reminder cron + dispatcher for the tax compliance reminders feature.
//
// Per run, this:
//   1. For each active subscription, generates `tax_filing_periods` rows for
//      the next 12 months on each active schedule (idempotent via unique key).
//   2. For each pending/info_requested period, computes the reminder fire
//      dates (due_date + reminder_offsets_days) and fires today's reminders
//      across the subscription's configured channels (email, in_app, or both).
//   3. Logs each dispatch into `tax_reminder_log`. The unique-when-sent index
//      on (period_id, channel, offset_days) prevents double-firing across
//      restarts.
//
// Public exports:
//   run()                              — execute one cycle (testable)
//   start({ intervalMs, initialDelayMs }) — kick off the recurring schedule

'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { warn } = require('../../../logger');
const { generatePeriods, reminderFireDates, toYmd } = require('./schedule');

const PERIOD_LOOKAHEAD = 6;   // how many upcoming periods per schedule to keep populated
const DEFAULT_TOKEN_VALID_DAYS_AFTER_DUE = 14;

const { sendOwnerAiDigest } = require('./ai-digest');

module.exports = function createTaxRemindersCron(deps) {
  const {
    supabase,
    isSupabaseConfigured,
    publicAppUrl,
    emailConfigured,
    sendTaxReminderEmail,
    sendSpanishEmail,
    anthropicApiKey,
    auditLog,
  } = deps;

  const todayUtc = () => toYmd(new Date());

  // Phase 4n.6: relationship-driven period generation.
  //
  // For every active (customer × relationship) pair, walk the relationship's
  // workflow rules and generate the next N periods from `rule.anchor_rule`.
  // Rows are keyed by customer_id|rule.id|due_date so duplicates are silently
  // dropped — same idempotency story as v1, different index.
  //
  // Schedule lookups happen once per (community, slug) and only to populate
  // the now-optional `schedule_id` column for portal/sender backwards-compat.
  // Customers without an active subscription still get periods through their
  // relationship. Customers with a subscription whose product slug DOES match
  // are not double-counted because rules are the source of truth.
  async function ensureUpcomingPeriods() {
    // Pull every active (customer, relationship_type_id) tuple. Inner-join
    // the customer to get community_id without an extra round trip per row.
    const { data: rels, error: relErr } = await supabase
      .from('tax_customer_relationships')
      .select(`
        relationship_type_id, customer_id, active,
        tax_customers!inner ( id, community_id )
      `)
      .eq('active', true);
    if (relErr) { warn('[tax-cron] fetch relationships failed', relErr.message); return 0; }

    // Group customers by (community_id, relationship_type_id) so we can fetch
    // matching rules once per group.
    const groups = new Map(); // key = `${community}|${rtid}` → { community, rtid, customers: [{id}] }
    for (const r of rels || []) {
      const cust = r.tax_customers;
      if (!cust || !cust.community_id) continue;
      const key = `${cust.community_id}|${r.relationship_type_id}`;
      let g = groups.get(key);
      if (!g) { g = { community: cust.community_id, rtid: r.relationship_type_id, customers: [] }; groups.set(key, g); }
      g.customers.push({ id: cust.id });
    }
    if (!groups.size) return 0;

    // Cache schedule lookups across the run — many rules share a slug.
    const scheduleCache = new Map();   // key = `${community}|${slug}` → schedule id or null
    async function findScheduleId(community, slug) {
      const key = `${community}|${slug}`;
      if (scheduleCache.has(key)) return scheduleCache.get(key);
      const { data } = await supabase.from('tax_filing_schedules')
        .select('id').eq('community_id', community).eq('slug', slug).maybeSingle();
      const id = data?.id || null;
      scheduleCache.set(key, id);
      return id;
    }

    const today = todayUtc();
    let created = 0;

    for (const g of groups.values()) {
      const { data: rules, error: rulesErr } = await supabase
        .from('tax_relationship_workflow_rules')
        .select('id, filing_schedule_slug, cadence, anchor_rule, name_i18n')
        .eq('community_id', g.community)
        .eq('relationship_type_id', g.rtid)
        .eq('active', true);
      if (rulesErr) { warn('[tax-cron] fetch rules failed', rulesErr.message); continue; }
      if (!rules || !rules.length) continue;

      for (const rule of rules) {
        // Rules backfilled in Phase 1 may still have null anchor_rule if the
        // joined schedule was missing one — skip them instead of crashing.
        if (!rule.anchor_rule || typeof rule.anchor_rule !== 'object') continue;
        const periods = generatePeriods(rule.anchor_rule, today, PERIOD_LOOKAHEAD, { lang: 'es' });
        if (!periods.length) continue;
        const scheduleId = await findScheduleId(g.community, rule.filing_schedule_slug);

        for (const cust of g.customers) {
          for (const p of periods) {
            const id = 'tp_' + crypto.createHash('sha1')
              .update(`${cust.id}|${rule.id}|${p.dueDate}`).digest('hex').slice(0, 16);
            const row = {
              id,
              community_id: g.community,
              customer_id: cust.id,
              workflow_rule_id: rule.id,
              relationship_type_id: g.rtid,
              schedule_id: scheduleId,           // optional, for legacy joins
              subscription_id: null,             // no longer required
              period_label: p.periodLabel,
              period_start: p.periodStart,
              period_end: p.periodEnd,
              due_date: p.dueDate,
              status: 'pending',
            };
            const { error: insErr } = await supabase.from('tax_filing_periods').insert(row);
            if (!insErr) created++;
            // Duplicate-key insert is expected on subsequent runs — ignored.
          }
        }
      }
    }
    return created;
  }

  // ── Step 2: fire today's reminders ──────────────────────────────────────────
  //
  // Phase 4n.6: period rows now reference a workflow rule (or, for legacy
  // rows, a schedule + subscription). We resolve the offsets / checklist /
  // display name from the rule when available, falling back to the legacy
  // schedule/subscription path. Both join shapes are LEFT joins so a period
  // with one but not the other still surfaces.
  async function fireReminders() {
    const today = todayUtc();

    // Phase 4n.36: customer-facing reminders are gated per community.
    // Default is OFF (the practice now manages recurring work through
    // tasks instead of emails). Build the allow-set first so we can
    // skip filing periods for communities that haven't opted in.
    const { data: optedIn } = await supabase.from('communities')
      .select('id').eq('tax_customer_reminders_enabled', true);
    const allowedCommunities = new Set((optedIn || []).map(c => c.id));
    if (!allowedCommunities.size) return 0;

    const { data: rows, error } = await supabase
      .from('tax_filing_periods')
      .select(`
        id, community_id, subscription_id, customer_id, schedule_id, status,
        workflow_rule_id, relationship_type_id,
        period_label, period_start, period_end, due_date,
        tax_subscriptions ( reminder_channels, reminder_offsets_days, custom_info_checklist ),
        tax_customers!inner ( id, email, name, locale, preferred_communication_email, community_id ),
        tax_filing_schedules ( id, slug, name_i18n, description_i18n, info_checklist ),
        tax_relationship_workflow_rules ( id, filing_schedule_slug, reminder_offsets_days, required_documents, name_i18n, description_i18n, info_checklist )
      `)
      .in('status', ['pending', 'info_requested'])
      .gte('due_date', today)
      .lte('due_date', shiftDays(today, 30));
    if (error) { warn('[tax-cron] fetch periods failed', error.message); return 0; }

    // Phase 4n.8: pre-fetch per-customer overrides for the customers in this
    // batch so we don't N+1 the resolution loop.
    const customerIds = Array.from(new Set((rows || []).map(r => r.customer_id).filter(Boolean)));
    const overridesByKey = new Map();
    if (customerIds.length) {
      const { data: ov } = await supabase
        .from('tax_customer_workflow_overrides')
        .select('customer_id, workflow_rule_id, custom_info_checklist, reminder_offsets_days')
        .in('customer_id', customerIds).eq('active', true);
      for (const o of ov || []) {
        overridesByKey.set(`${o.customer_id}|${o.workflow_rule_id}`, o);
      }
    }

    let fired = 0;
    for (const row of rows || []) {
      if (!allowedCommunities.has(row.community_id)) continue;
      const sub = row.tax_subscriptions || null;
      const cust = row.tax_customers;
      const ruleRow = row.tax_relationship_workflow_rules || null;
      const schedRow = row.tax_filing_schedules || null;
      const customerOverride = row.workflow_rule_id
        ? overridesByKey.get(`${cust.id}|${row.workflow_rule_id}`) : null;

      // Build a synthetic "schedule-ish" object for the sender. Rule fields
      // win when present; schedule fills the gaps so the email/in-app
      // renderer doesn't need to branch.
      const sch = {
        id: schedRow?.id || ruleRow?.id || row.workflow_rule_id || '',
        slug: schedRow?.slug || ruleRow?.filing_schedule_slug || '',
        name_i18n:        firstNonEmptyI18n(ruleRow?.name_i18n, schedRow?.name_i18n),
        description_i18n: firstNonEmptyI18n(ruleRow?.description_i18n, schedRow?.description_i18n),
        info_checklist:   firstNonEmptyArray(
          customerOverride?.custom_info_checklist,
          ruleRow?.info_checklist,
          schedRow?.info_checklist
        ),
      };

      // Offsets precedence:
      //   1. per-customer workflow override (Phase 4n.8)
      //   2. legacy subscription override
      //   3. workflow rule
      //   4. system default
      let offsets;
      if (Array.isArray(customerOverride?.reminder_offsets_days) && customerOverride.reminder_offsets_days.length) {
        offsets = customerOverride.reminder_offsets_days.map(d => -Math.abs(Number(d) || 0)).filter(Boolean);
        if (!offsets.length) offsets = [-14, -7, -3];
      } else if (Array.isArray(sub?.reminder_offsets_days) && sub.reminder_offsets_days.length) {
        offsets = sub.reminder_offsets_days;
      } else if (Array.isArray(ruleRow?.reminder_offsets_days) && ruleRow.reminder_offsets_days.length) {
        offsets = ruleRow.reminder_offsets_days.map(d => -Math.abs(Number(d) || 0)).filter(Boolean);
        if (!offsets.length) offsets = [-14, -7, -3];
      } else {
        offsets = [-14, -7, -3];
      }
      const channels = Array.isArray(sub?.reminder_channels) && sub.reminder_channels.length
        ? sub.reminder_channels : ['email', 'in_app'];

      // Phase 4j compat: legacy periods (no workflow_rule_id) still cross-ref
      // any matching rule via the customer's relationships so extra_docs and
      // offsets resolve the same way they did before. Rule-keyed periods
      // already carry the rule via the join.
      let extraDocs = Array.isArray(ruleRow?.required_documents) ? ruleRow.required_documents : null;
      if (!row.workflow_rule_id && schedRow?.slug) {
        const merged = await resolveWorkflowRule(cust.id, row.community_id, schedRow.slug);
        if (Array.isArray(merged?.required_documents)) extraDocs = merged.required_documents;
      }

      const dates = reminderFireDates(row.due_date, offsets);
      for (let i = 0; i < offsets.length; i++) {
        if (dates[i] !== today) continue;
        for (const channel of channels) {
          const sent = await dispatchOne({ row, sub: sub || {}, cust, sch, channel, offsetDays: offsets[i], extraDocs });
          if (sent) fired++;
        }
      }
    }
    return fired;
  }

  function firstNonEmptyI18n(...candidates) {
    for (const c of candidates) {
      if (c && typeof c === 'object' && Object.values(c).some(v => typeof v === 'string' && v.trim())) {
        return c;
      }
    }
    return {};
  }
  function firstNonEmptyArray(...candidates) {
    for (const c of candidates) if (Array.isArray(c) && c.length) return c;
    return [];
  }

  // Phase 4j: find the most specific workflow rule (community, customer's
  // active relationships, schedule slug). If multiple relationships match,
  // we merge: take the FIRST rule's offsets that's non-empty, and union
  // ALL the required_documents lists (deduped by key in the sender).
  async function resolveWorkflowRule(customerId, communityId, scheduleSlug) {
    if (!customerId || !communityId || !scheduleSlug) return null;
    const { data: rels } = await supabase
      .from('tax_customer_relationships')
      .select('relationship_type_id')
      .eq('customer_id', customerId).eq('active', true);
    const typeIds = (rels || []).map(r => r.relationship_type_id);
    if (!typeIds.length) return null;
    const { data: rules } = await supabase
      .from('tax_relationship_workflow_rules')
      .select('relationship_type_id, reminder_offsets_days, required_documents')
      .eq('community_id', communityId)
      .eq('filing_schedule_slug', scheduleSlug)
      .eq('active', true)
      .in('relationship_type_id', typeIds);
    if (!rules || !rules.length) return null;
    let offsets = null;
    const docs = [];
    for (const r of rules) {
      if (!offsets && Array.isArray(r.reminder_offsets_days) && r.reminder_offsets_days.length) {
        offsets = r.reminder_offsets_days;
      }
      if (Array.isArray(r.required_documents)) {
        for (const d of r.required_documents) if (d) docs.push(d);
      }
    }
    return {
      reminder_offsets_days: offsets,
      required_documents: docs.length ? docs : null,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function dispatchOne({ row, sub, cust, sch, channel, offsetDays, extraDocs, forced = false }) {
    // Pre-flight de-dup: skip if a sent log row already exists for this combo.
    // Manual "send reminder now" sets `forced` to bypass the check so the
    // owner can re-send when needed.
    if (!forced) {
      const { data: existing } = await supabase
        .from('tax_reminder_log')
        .select('id')
        .eq('period_id', row.id).eq('channel', channel).eq('offset_days', offsetDays).eq('status', 'sent')
        .maybeSingle();
      if (existing?.id) return false;
    }

    const token = await ensureResponseToken(row);
    const magicUrl = `${publicAppUrl()}/tax/respond/${token.raw}`;

    // Phase 2c: pull `filing_reminder` tips for the customer's active
    // relationship types. Cap at 3 to keep emails readable. Tips for the
    // schedule's primary relationship (when we can infer one) go first.
    const tips = await tipsForReminder(cust.id, sch);

    let result = { sent: false, reason: 'noop' };
    if (channel === 'email') {
      if (!emailConfigured) {
        result = { sent: false, reason: 'email_not_configured' };
      } else {
        try {
          await sendTaxReminderEmail({ row, cust, sch, sub, magicUrl, offsetDays, tips, extraDocs, workflowRuleId: row.workflow_rule_id || null });
          result = { sent: true };
        } catch (e) {
          result = { sent: false, reason: e?.message || 'send_failed' };
        }
      }
    } else if (channel === 'in_app') {
      const tipLinesEs = tips.map(t => `• ${pickI18n(t.tip_i18n, 'es')}`).join('\n');
      const tipLinesEn = tips.map(t => `• ${pickI18n(t.tip_i18n, 'en')}`).join('\n');
      const tipBodyEs = tipLinesEs ? `\n\nRecordatorios útiles:\n${tipLinesEs}` : '';
      const tipBodyEn = tipLinesEn ? `\n\nHelpful reminders:\n${tipLinesEn}` : '';
      const notif = {
        id: 'tnotif_' + uuidv4().slice(0, 12),
        community_id: row.community_id,
        customer_id: cust.id,
        type: 'reminder',
        title_i18n: {
          es: `Recordatorio: ${pickI18n(sch.name_i18n, 'es')} vence el ${row.due_date}`,
          en: `Reminder: ${pickI18n(sch.name_i18n, 'en')} due ${row.due_date}`,
        },
        body_i18n: {
          es: `Por favor proporcione la información requerida para ${row.period_label}.${tipBodyEs}`,
          en: `Please provide the information needed for ${row.period_label}.${tipBodyEn}`,
        },
        payload: { periodId: row.id, scheduleSlug: sch.slug, magicUrl, offsetDays, tipIds: tips.map(t => t.id) },
      };
      const { error: nErr } = await supabase.from('tax_notifications').insert(notif);
      result = nErr ? { sent: false, reason: nErr.message } : { sent: true };
    }

    await supabase.from('tax_reminder_log').insert({
      id: 'trlog_' + uuidv4().slice(0, 12),
      period_id: row.id,
      channel,
      offset_days: offsetDays,
      status: result.sent ? 'sent' : 'failed',
      reason: result.sent ? '' : String(result.reason || '').slice(0, 500),
    });

    // First time we fire any reminder for this period, advance status.
    if (result.sent && row.status === 'pending') {
      await supabase.from('tax_filing_periods')
        .update({ status: 'info_requested', updated_at: new Date().toISOString() })
        .eq('id', row.id);
    }
    if (result.sent && typeof auditLog === 'function') {
      try {
        await auditLog({
          entity: 'tax.reminder', entityId: row.id, action: 'send',
          actorEmail: '', actorName: 'tax-cron',
          after: { channel, offsetDays, scheduleSlug: sch.slug, dueDate: row.due_date },
        });
      } catch (_e) {}
    }
    return result.sent;
  }

  async function ensureResponseToken(period) {
    // Reuse a still-valid token if one exists, otherwise mint a new one.
    const { data: existing } = await supabase
      .from('tax_response_tokens')
      .select('id, token_hash, expires_at, used_at')
      .eq('period_id', period.id)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (existing?.id) {
      // We never store the raw token, so when reusing we need to mint a new
      // raw value and rotate the hash. Simpler: always mint fresh on reuse.
    }
    const raw = crypto.randomBytes(24).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() +
      DEFAULT_TOKEN_VALID_DAYS_AFTER_DUE +
      Math.max(0, Math.ceil((new Date(period.due_date) - new Date()) / 86400000)));
    await supabase.from('tax_response_tokens').insert({
      id: 'trtok_' + uuidv4().slice(0, 12),
      period_id: period.id,
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
    });
    return { raw, hash: tokenHash };
  }

  // Maps tax_filing_schedule slugs → relationship_type_ids, so we can sort
  // the customer's filing-reminder tips with the most-relevant relationship
  // first. Schedules we haven't mapped fall through and produce no priority
  // boost — every tip for any of the customer's relationships is still
  // eligible to appear (subject to the cap below).
  const SCHEDULE_TO_REL = {
    'ct-sut-monthly':      'business.sales_tax_filing',
    'ct-sut-quarterly':    'business.sales_tax_filing',
    'ct-sut-annual':       'business.sales_tax_filing',
    'us-941-quarterly':    'business.payroll',
    'us-940-annual':       'business.payroll',
    'us-1065-annual':      'business.partnership_1065',
    'us-1120s-annual':     'business.s_corp',
    'us-1040-annual':      'individual.taxes',
    'ct-est-quarterly':    'individual.taxes',
  };
  const MAX_TIPS_PER_REMINDER = 3;

  async function tipsForReminder(customerId, sch) {
    const { data: rels } = await supabase
      .from('tax_customer_relationships')
      .select('relationship_type_id')
      .eq('customer_id', customerId).eq('active', true);
    const typeIds = (rels || []).map(r => r.relationship_type_id);
    if (!typeIds.length) return [];

    const { data: tips } = await supabase
      .from('tax_relationship_default_tips')
      .select('id, relationship_type_id, context, display_order, tip_i18n, source_note')
      .in('relationship_type_id', typeIds)
      .eq('context', 'filing_reminder');
    if (!tips || !tips.length) return [];

    const primaryRel = SCHEDULE_TO_REL[sch?.slug] || null;
    const score = (t) => (t.relationship_type_id === primaryRel ? 0 : 1);
    tips.sort((a, b) =>
      score(a) - score(b) || a.display_order - b.display_order);
    return tips.slice(0, MAX_TIPS_PER_REMINDER);
  }

  function shiftDays(iso, days) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return toYmd(d);
  }

  function pickI18n(obj, locale) {
    if (obj && typeof obj === 'object') {
      const v = obj[locale];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof obj.en === 'string') return obj.en;
    }
    return '';
  }

  // ── Manual fire of one period (owner-triggered "Send reminder now") ───────
  // Skips the offset-day window check but still respects the per-channel
  // tax_reminder_log de-dup so we don't double-send if the cron has already
  // fired today. Returns { sent: bool, channels: ['email', ...], skipped: [...] }.
  async function fireForPeriod(periodId, { channels: requestedChannels, force = false } = {}) {
    if (!isSupabaseConfigured) return { error: 'supabase_not_configured' };
    const { data: row, error } = await supabase
      .from('tax_filing_periods')
      .select(`
        id, community_id, subscription_id, customer_id, schedule_id, status,
        workflow_rule_id, relationship_type_id,
        period_label, period_start, period_end, due_date,
        tax_subscriptions ( reminder_channels, reminder_offsets_days ),
        tax_customers!inner ( id, email, name, locale, preferred_communication_email, community_id ),
        tax_filing_schedules ( id, slug, name_i18n, description_i18n, info_checklist ),
        tax_relationship_workflow_rules ( id, filing_schedule_slug, reminder_offsets_days, required_documents, name_i18n, description_i18n, info_checklist )
      `)
      .eq('id', periodId).maybeSingle();
    if (error) return { error: error.message };
    if (!row) return { error: 'period_not_found' };

    const sub = row.tax_subscriptions || null;
    const cust = row.tax_customers;
    const ruleRow = row.tax_relationship_workflow_rules || null;
    const schedRow = row.tax_filing_schedules || null;

    const sch = {
      id: schedRow?.id || ruleRow?.id || row.workflow_rule_id || '',
      slug: schedRow?.slug || ruleRow?.filing_schedule_slug || '',
      name_i18n:        firstNonEmptyI18n(ruleRow?.name_i18n, schedRow?.name_i18n),
      description_i18n: firstNonEmptyI18n(ruleRow?.description_i18n, schedRow?.description_i18n),
      info_checklist:   firstNonEmptyArray(ruleRow?.info_checklist, schedRow?.info_checklist),
    };

    let extraDocs = Array.isArray(ruleRow?.required_documents) ? ruleRow.required_documents : null;
    if (!row.workflow_rule_id && schedRow?.slug) {
      const merged = await resolveWorkflowRule(cust.id, row.community_id, schedRow.slug);
      if (Array.isArray(merged?.required_documents)) extraDocs = merged.required_documents;
    }

    // Use days-until-due as the "offset" stamp so the per-channel log row
    // is uniquely keyed even when the cron has already sent the normal
    // offset's reminder.
    const daysUntilDue = Math.ceil(
      (new Date(row.due_date) - new Date(todayUtc())) / 86400000
    );
    const offsetDays = -Math.max(0, daysUntilDue) || -1; // negative = days before due

    const channels = Array.isArray(requestedChannels) && requestedChannels.length
      ? requestedChannels
      : ['email'];

    const results = [];
    for (const channel of channels) {
      const sent = await dispatchOne({
        row, sub: sub || {}, cust, sch, channel, offsetDays, extraDocs,
        forced: !!force,
      });
      results.push({ channel, sent });
    }
    return {
      sent: results.some(r => r.sent),
      channels: results.filter(r => r.sent).map(r => r.channel),
      skipped: results.filter(r => !r.sent).map(r => r.channel),
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async function run() {
    if (!isSupabaseConfigured) return { skipped: true, reason: 'supabase_not_configured' };
    try {
      const created = await ensureUpcomingPeriods();
      const fired = await fireReminders();

      // Daily AI digest: fire-and-forget for each active tax community
      if (emailConfigured && sendSpanishEmail) {
        const { data: communities } = await supabase
          .from('communities')
          .select('id')
          .eq('business_type', 'tax');
        if (communities && communities.length > 0) {
          for (const c of communities) {
            sendOwnerAiDigest(c.id, { supabase, anthropicApiKey, sendSpanishEmail })
              .catch(e => warn('[ai-digest] community', c.id, e?.message || e));
          }
        }
      }

      return { created, fired };
    } catch (e) {
      warn('[tax-cron] run failed', e?.message || e);
      return { error: e?.message || 'unknown' };
    }
  }

  function start({ intervalMs = 12 * 60 * 60 * 1000, initialDelayMs = 60 * 1000 } = {}) {
    setTimeout(() => {
      run().catch(e => warn('[tax-cron] initial run threw', e?.message || e));
      setInterval(() => {
        run().catch(e => warn('[tax-cron] interval run threw', e?.message || e));
      }, intervalMs);
    }, initialDelayMs);
  }

  return { run, start, fireForPeriod };
};
