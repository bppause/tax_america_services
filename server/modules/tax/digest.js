// Daily-digest cron for the tax module.
//
// Runs every 6 hours; for each active community whose team-emails master
// + per-type digest flags are both on, walks the active staff list and
// builds a per-employee summary of priority work for the day:
//
//   - Overdue tasks they own
//   - Tasks due today
//   - Upcoming tasks (next 7 days)
//   - New leads in the last 24h (admins only)
//   - New customer messages in the last 24h
//
// Skips employees whose digest has no items, and dedupes via
// tax_digest_log (community_id, employee_id, sent_date) so multiple
// cron ticks in the same UTC day never double-send.

'use strict';

const { warn } = require('../../../logger');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 2 * 60 * 1000;

module.exports = function createTaxDigestCron(deps) {
  const {
    supabase,
    isSupabaseConfigured,
    publicAppUrl,
    emailConfigured,
    sendTaxDailyDigestEmail,
    auditLog,
  } = deps;

  const todayUtcIso = () => new Date().toISOString().slice(0, 10);
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

  // Build the per-employee digest payload. Returns null when the
  // employee has nothing to surface today (no overdue, no due-today,
  // no upcoming, no new leads, no new messages) so we never send a
  // "you have 0 items today" email.
  async function digestForEmployee({ employee, community, terminalKeys, today }) {
    if (!employee || employee.status !== 'active' || !employee.email) return null;
    const todayIso = today;
    const upcomingCutoff = isoDaysAhead(7);
    const sinceIso = isoDaysAgo(1);

    // Tasks the employee owns. Admins still get only their own
    // assignments here — the cross-community admin view is a separate
    // surface; the digest is intentionally a personal worklist.
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

    if (overdue.length === 0 && dueToday.length === 0 && upcoming.length === 0
        && newLeads.length === 0 && newMessageCount === 0) {
      return null;
    }
    return {
      overdue, dueToday, upcoming, newLeads, newMessageCount,
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      upcomingCount: upcoming.length,
    };
  }

  async function digestForCommunity({ community, today }) {
    // Gate by the team-master + per-type flag. Master defaults on, the
    // per-type digest flag defaults on too — so an opted-in community
    // sees this fire automatically.
    if (community.tax_staff_emails_master_enabled !== true) return { skipped: 'master_off' };
    if (community.tax_staff_email_digest_enabled !== true) return { skipped: 'type_off' };

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
    let skippedNoItems = 0;
    let alreadySent = 0;
    for (const emp of (employees || [])) {
      // Dedupe per UTC day so a 6h cron interval never double-sends.
      const { data: existing } = await supabase.from('tax_digest_log')
        .select('employee_id')
        .eq('community_id', community.id).eq('employee_id', emp.id).eq('sent_date', today)
        .maybeSingle();
      if (existing) { alreadySent++; continue; }

      const digest = await digestForEmployee({ employee: emp, community, terminalKeys, today });
      if (!digest) { skippedNoItems++; continue; }

      try {
        const r = await sendTaxDailyDigestEmail({
          community, employee: emp, digest,
          dashboardUrl, tasksUrl, leadsUrl,
        });
        if (r && r.sent !== false) {
          sentCount++;
          await supabase.from('tax_digest_log').insert({
            community_id: community.id, employee_id: emp.id, sent_date: today,
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
    return { sentCount, skippedNoItems, alreadySent };
  }

  async function run() {
    if (!isSupabaseConfigured) return { skipped: true, reason: 'supabase_not_configured' };
    if (!emailConfigured) return { skipped: true, reason: 'email_not_configured' };
    try {
      const today = todayUtcIso();
      const { data: communities } = await supabase.from('communities')
        .select('id, name, tax_staff_emails_master_enabled, tax_staff_email_digest_enabled')
        .eq('business_type', 'tax');
      const out = [];
      for (const community of (communities || [])) {
        try {
          const r = await digestForCommunity({ community, today });
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
