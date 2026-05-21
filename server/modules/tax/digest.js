// Daily-digest cron for the tax module.
//
// Fires once per configured day per community — by default 8 AM
// America/New_York Monday–Friday. Each community can override the
// hour, timezone, and weekday set from Owner Settings → Team email
// notifications. The cron runs hourly; for each community on each
// tick it checks "is today a send day, is the local hour at or past
// the send hour, has today's digest already gone out?" before
// composing.
//
// Unlike v1 the digest always sends — even when the employee has no
// overdue / due-today / upcoming items — so the email functions as
// the team's daily "log into the app" nudge. The body branches on
// item counts so the empty-day case reads as a soft reminder
// instead of a wall of zero-counts.
//
// Dedupe: tax_digest_log (community_id, employee_id, sent_date) is
// the per-employee guard. A separate community-level lookup against
// the same table prevents two ticks within the configured window
// from each picking up the work — only the first tick that crosses
// the threshold sends.

'use strict';

const { warn } = require('../../../logger');

// 5min interval keeps the cron lightweight while still landing
// inside the same hour the owner configured. Initial delay (90s)
// gives the rest of the app time to wire up before the first tick.
const DEFAULT_INTERVAL_MS      = 5 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 90 * 1000;

const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

module.exports = function createTaxDigestCron(deps) {
  const {
    supabase,
    isSupabaseConfigured,
    publicAppUrl,
    emailConfigured,
    sendTaxDailyDigestEmail,
    auditLog,
  } = deps;

  const isoDaysAgo = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  };
  const isoDaysAhead = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // Resolve a community's local "now" given an IANA timezone. Returns
  // { year, month, day, hour, weekdayCode } so callers can compare to
  // the configured send-day + send-hour. Falls back to UTC when the
  // tz string is invalid so a typo never silently freezes the cron.
  function localNowFor(timezone) {
    const tz = String(timezone || 'America/New_York');
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        weekday: 'short', hour12: false,
      });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
      const weekdayMap = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
      return {
        year: parts.year, month: parts.month, day: parts.day,
        hour: Number(parts.hour) || 0,
        minute: Number(parts.minute) || 0,
        weekdayCode: weekdayMap[parts.weekday] || 'mon',
        sendDate: `${parts.year}-${parts.month}-${parts.day}`,
      };
    } catch {
      const d = new Date();
      const utcDate = d.toISOString().slice(0, 10);
      return {
        year: utcDate.slice(0, 4), month: utcDate.slice(5, 7), day: utcDate.slice(8, 10),
        hour: d.getUTCHours(), minute: d.getUTCMinutes(),
        weekdayCode: DAY_CODES[d.getUTCDay()],
        sendDate: utcDate,
      };
    }
  }

  function parseSendDays(raw) {
    return new Set(String(raw || '')
      .toLowerCase().split(/[,\s]+/).filter(Boolean)
      .filter(d => DAY_CODES.includes(d)));
  }

  // Per-employee digest payload. Counts may all be zero — the cron
  // still sends in that case (the "log into the app" nudge).
  async function digestForEmployee({ employee, community, terminalKeys, today }) {
    if (!employee || employee.status !== 'active' || !employee.email) return null;
    const todayIso = today;
    const upcomingCutoff = isoDaysAhead(7);
    const sinceIso = isoDaysAgo(1);

    const { data: tasks } = await supabase.from('tax_tasks')
      .select(`
        id, title, status_key, priority, due_date,
        customer:tax_customers ( id, name, business_name, email )
      `)
      .eq('community_id', community.id)
      .eq('assigned_employee_id', employee.id)
      .is('archived_at', null)
      .is('completed_at', null)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(100);

    const open = (tasks || []).filter(t => !terminalKeys.has(t.status_key));
    const overdue  = open.filter(t => t.due_date && t.due_date <  todayIso);
    const dueToday = open.filter(t => t.due_date === todayIso);
    const upcoming = open.filter(t => t.due_date && t.due_date > todayIso && t.due_date <= upcomingCutoff);

    let newLeads = [];
    if (employee.role === 'admin') {
      const { data: leads } = await supabase.from('tax_leads')
        .select('id, name, email, customer_type, created_at')
        .eq('community_id', community.id)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(20);
      newLeads = leads || [];
    }

    let newMessageCount = 0;
    try {
      const { count } = await supabase.from('tax_thread_messages')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', community.id)
        .eq('direction', 'customer_to_practice')
        .gte('created_at', sinceIso);
      newMessageCount = count || 0;
    } catch (_e) { /* best-effort */ }

    return {
      overdue, dueToday, upcoming, newLeads, newMessageCount,
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      upcomingCount: upcoming.length,
    };
  }

  async function digestForCommunity({ community }) {
    if (community.tax_staff_emails_master_enabled !== true) return { skipped: 'master_off' };
    if (community.tax_staff_email_digest_enabled !== true) return { skipped: 'type_off' };

    const now = localNowFor(community.tax_digest_send_timezone);
    const sendDays = parseSendDays(community.tax_digest_send_days || 'mon,tue,wed,thu,fri');
    if (!sendDays.has(now.weekdayCode)) return { skipped: 'wrong_day', day: now.weekdayCode };

    const sendHour = Number.isFinite(Number(community.tax_digest_send_hour))
      ? Number(community.tax_digest_send_hour) : 8;
    if (now.hour < sendHour) return { skipped: 'too_early', hour: now.hour, sendHour };

    // Community-level dedupe — any digest already sent today for this
    // community (any employee) means we already crossed the threshold
    // this morning. Prevents two ticks at e.g. 8:00 + 8:05 from
    // racing to send.
    const { data: existing } = await supabase.from('tax_digest_log')
      .select('employee_id')
      .eq('community_id', community.id).eq('sent_date', now.sendDate)
      .limit(1);
    if (existing && existing.length) return { skipped: 'already_sent_today', day: now.sendDate };

    const { data: statusOpts } = await supabase.from('tax_task_status_options')
      .select('key, is_terminal').eq('community_id', community.id);
    const terminalKeys = new Set((statusOpts || []).filter(s => s.is_terminal).map(s => s.key));

    const { data: employees } = await supabase.from('tax_employees')
      .select('id, community_id, email, name, first_name, last_name, locale, role, status')
      .eq('community_id', community.id)
      .eq('status', 'active');

    const base = (typeof publicAppUrl === 'function' ? publicAppUrl() : '') || '';
    const dashboardUrl = `${base}/tax/${encodeURIComponent(community.id)}/employee`;
    const tasksUrl     = `${base}/tax/${encodeURIComponent(community.id)}/employee/tasks`;
    const leadsUrl     = `${base}/tax/${encodeURIComponent(community.id)}/employee/leads`;

    let sentCount = 0;
    let alreadySent = 0;
    for (const emp of (employees || [])) {
      const { data: row } = await supabase.from('tax_digest_log')
        .select('employee_id')
        .eq('community_id', community.id).eq('employee_id', emp.id).eq('sent_date', now.sendDate)
        .maybeSingle();
      if (row) { alreadySent++; continue; }

      const digest = await digestForEmployee({ employee: emp, community, terminalKeys, today: now.sendDate });
      if (!digest) continue; // missing email / archived — defensive

      try {
        const r = await sendTaxDailyDigestEmail({
          community, employee: emp, digest,
          dashboardUrl, tasksUrl, leadsUrl,
        });
        if (r && r.sent !== false) {
          sentCount++;
          await supabase.from('tax_digest_log').insert({
            community_id: community.id, employee_id: emp.id, sent_date: now.sendDate,
            item_counts: {
              overdue: digest.overdueCount,
              dueToday: digest.dueTodayCount,
              upcoming: digest.upcomingCount,
              newLeads: digest.newLeads.length,
              newMessages: digest.newMessageCount,
            },
          });
        }
      } catch (e) {
        warn('[tax-digest] send failed', e?.message || e);
      }
    }
    return { sentCount, alreadySent, sendDate: now.sendDate, hour: now.hour, weekday: now.weekdayCode };
  }

  async function run() {
    if (!isSupabaseConfigured) return { skipped: true, reason: 'supabase_not_configured' };
    if (!emailConfigured) return { skipped: true, reason: 'email_not_configured' };
    try {
      const { data: communities } = await supabase.from('communities')
        .select(`
          id, name,
          tax_staff_emails_master_enabled, tax_staff_email_digest_enabled,
          tax_digest_send_hour, tax_digest_send_timezone, tax_digest_send_days
        `)
        .eq('business_type', 'tax');
      const out = [];
      for (const community of (communities || [])) {
        try {
          const r = await digestForCommunity({ community });
          out.push({ communityId: community.id, ...r });
        } catch (e) {
          warn('[tax-digest] community failed', community?.id, e?.message || e);
        }
      }
      try {
        if (typeof auditLog === 'function') {
          await auditLog({ entity: 'tax.cron', entityId: 'daily_digest',
            action: 'run', actorEmail: '', after: { results: out } });
        }
      } catch (_e) {}
      return { results: out };
    } catch (e) {
      warn('[tax-digest] run failed', e?.message || e);
      return { error: e?.message || 'unknown' };
    }
  }

  function start({ intervalMs = DEFAULT_INTERVAL_MS, initialDelayMs = DEFAULT_INITIAL_DELAY_MS } = {}) {
    setTimeout(() => {
      run().catch(e => warn('[tax-digest] initial run threw', e?.message || e));
      setInterval(() => {
        run().catch(e => warn('[tax-digest] interval run threw', e?.message || e));
      }, intervalMs);
    }, initialDelayMs);
  }

  return { run, start };
};
