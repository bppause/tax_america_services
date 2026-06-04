// ai-digest.js — Daily AI Insights Digest for practice owners.
//
// sendOwnerAiDigest(communityId, deps) fetches the last 24h of tax_chat_logs
// for a community, asks Claude to summarise the themes, and emails the owner.
//
// Called from reminders.js after the filing-reminder dispatch once per day.

'use strict';

const { warn } = require('../../../logger');

/**
 * @param {string} communityId
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {string} deps.anthropicApiKey
 * @param {function} deps.sendSpanishEmail
 * @param {string} [deps.publicAppUrl]
 */
async function sendOwnerAiDigest(communityId, deps) {
  const { supabase, anthropicApiKey, sendSpanishEmail } = deps;

  // 1. Fetch last 24h chat logs for this community
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: logs, error: logErr } = await supabase
    .from('tax_chat_logs')
    .select('kind, query, ai_response, locale, created_at')
    .eq('community_id', communityId)
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (logErr) { warn('[ai-digest] fetch logs error', logErr.message); return; }
  if (!logs || logs.length === 0) return; // nothing to report

  // 2. Fetch community info for the email
  const { data: community, error: cErr } = await supabase
    .from('communities')
    .select('id, name, slug, contact_email')
    .eq('id', communityId)
    .maybeSingle();
  if (cErr || !community) { warn('[ai-digest] community fetch error', cErr?.message); return; }
  if (!community.contact_email) return; // nowhere to send

  // 2b. Fetch open tasks with customer info and assignee name
  const { data: openTasks } = await supabase
    .from('tax_tasks')
    .select(`
      id, title, status_key, priority, due_date,
      assigned_employee_id,
      tax_employees(display_name),
      tax_customers(name, business_name)
    `)
    .eq('community_id', communityId)
    .not('status_key', 'in', '("completed","cancelled","closed")')
    .is('archived_at', null)
    .order('due_date', { ascending: true, nullsFirst: false });

  // 3. Group by kind
  const aiChats = logs.filter(r => r.kind === 'ai_chat');
  const faqSearches = logs.filter(r => r.kind === 'faq_search');

  // 4. Build the query list for the AI prompt
  const allQueries = logs.map(r =>
    `[${r.kind === 'ai_chat' ? 'AI chat' : 'FAQ search'}] ${r.query}`
  ).join('\n');

  // 5. Call Anthropic for insights
  let aiInsights = '';
  if (anthropicApiKey) {
    try {
      let Anthropic;
      try { Anthropic = require('@anthropic-ai/sdk'); }
      catch { Anthropic = null; }

      if (Anthropic) {
        const client = new Anthropic.default({ apiKey: anthropicApiKey });
        const resp = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          system: 'You are a business intelligence assistant. Given a list of questions and search terms that visitors submitted to a tax services firm\'s website today, produce: (1) a short summary of the top themes/topics visitors asked about, (2) 2-3 specific suggestions for the firm owner on which services to highlight or potentially add based on what visitors were looking for, (3) any FAQ gaps (questions asked but likely not covered in the FAQ). Be concise -- the output is an email body section.',
          messages: [{ role: 'user', content: `Here are today\'s visitor queries:\n\n${allQueries}` }],
        });
        aiInsights = (resp.content[0]?.text || '').trim();
      }
    } catch (e) {
      warn('[ai-digest] Anthropic error', e?.message || e);
    }
  }

  // 6. Build HTML email
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  const queryListHtml = logs.map(r => {
    const badge = r.kind === 'ai_chat'
      ? '<span style="background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">AI chat</span>'
      : '<span style="background:#f3e8ff;color:#6b21a8;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">FAQ search</span>';
    return `<li style="margin-bottom:4px">${badge} ${esc(r.query)}</li>`;
  }).join('');

  // Build open tasks section
  const appUrl = (deps.publicAppUrl || '').replace(/\/$/, '');
  const communitySlug = community.slug;

  let tasksHtml = '';
  if (openTasks && openTasks.length > 0) {
    const PRIORITY_BADGE = {
      urgent: '<span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">URGENT</span>',
      high:   '<span style="background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">High</span>',
      normal: '',
      low:    '<span style="background:#f1f5f9;color:#64748b;padding:1px 6px;border-radius:4px;font-size:11px">Low</span>',
    };
    const STATUS_COLOR = {
      not_started: '#6b7280',
      in_progress: '#1d4ed8',
      blocked:     '#b91c1c',
    };
    const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked' };

    // Base URL for the tasks page
    const tasksBase = appUrl && communitySlug
      ? `${appUrl}/tax/${communitySlug}/owner/tasks`
      : null;

    // Group by assignee, preserving order (unassigned last)
    const byAssignee = new Map();
    for (const task of openTasks) {
      const key = task.assigned_employee_id || '__unassigned__';
      if (!byAssignee.has(key)) {
        byAssignee.set(key, {
          id: task.assigned_employee_id || null,
          name: task.tax_employees?.display_name || 'Unassigned',
          tasks: [],
        });
      }
      byAssignee.get(key).tasks.push(task);
    }

    // Sort: named assignees first, unassigned last
    const groups = [...byAssignee.values()].sort((a, b) => {
      if (!a.id && b.id) return 1;
      if (a.id && !b.id) return -1;
      return a.name.localeCompare(b.name);
    });

    const groupHtml = groups.map(({ id: empId, name, tasks }) => {
      // Summary link filtered to this assignee
      const summaryHref = tasksBase && empId
        ? `${tasksBase}?assignee=${encodeURIComponent(empId)}`
        : tasksBase;

      const summaryLink = summaryHref
        ? ` &nbsp;<a href="${summaryHref}" style="font-size:12px;color:#1d4ed8;text-decoration:none">View all &rarr;</a>`
        : '';

      const rows = tasks.map(task => {
        const taskHref = tasksBase ? `${tasksBase}?task=${encodeURIComponent(task.id)}` : null;
        const titleText = esc(task.title);
        const titleEl = taskHref
          ? `<a href="${taskHref}" style="color:#111827;text-decoration:none;font-weight:500">${titleText}</a>`
          : `<span style="font-weight:500">${titleText}</span>`;

        // Customer info
        const contactName = esc(task.tax_customers?.name || '');
        const bizName = esc(task.tax_customers?.business_name || '');
        const customerParts = [];
        if (bizName) customerParts.push(`<span style="color:#374151">${bizName}</span>`);
        if (contactName) customerParts.push(`<span style="color:#6b7280">${contactName}</span>`);
        const customerStr = customerParts.length
          ? ` <span style="font-size:12px">&mdash; ${customerParts.join(' / ')}</span>`
          : '';

        const dueStr = task.due_date
          ? ` <span style="color:#64748b;font-size:12px">due ${task.due_date}</span>`
          : '';
        const statusLabel = STATUS_LABEL[task.status_key] || task.status_key;
        const statusColor = STATUS_COLOR[task.status_key] || '#6b7280';
        const statusEl = `<span style="color:${statusColor};font-size:12px;font-weight:600">${statusLabel}</span>`;
        const priorityBadge = PRIORITY_BADGE[task.priority] || '';

        return `<tr>
          <td style="padding:6px 8px 6px 0;vertical-align:top;border-bottom:1px solid #f3f4f6">
            ${priorityBadge} ${titleEl}${customerStr}
          </td>
          <td style="padding:6px 0 6px 8px;vertical-align:top;border-bottom:1px solid #f3f4f6;white-space:nowrap;text-align:right">
            ${statusEl}${dueStr ? '<br>' + dueStr : ''}
          </td>
        </tr>`;
      }).join('');

      return `<div style="margin-bottom:18px">
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">
          <strong style="font-size:14px;color:#111827">${esc(name)}</strong>
          <span style="font-size:12px;color:#9ca3af">(${tasks.length} open)</span>
          ${summaryLink}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5">${rows}</table>
      </div>`;
    }).join('');

    tasksHtml = `
      <h3 style="margin:24px 0 8px;font-size:16px">Open Tasks (${openTasks.length})</h3>
      ${tasksBase ? `<p style="margin:0 0 10px;font-size:12px"><a href="${tasksBase}" style="color:#1d4ed8">View all tasks &rarr;</a></p>` : ''}
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;background:#fff">${groupHtml}</div>`;
  }

  const insightsHtml = aiInsights
    ? `<h3 style="margin:24px 0 8px;font-size:16px">AI-Generated Insights</h3>
       <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(aiInsights)}</div>`
    : '';

  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <h2 style="margin-bottom:4px">${community.name} &mdash; AI Insights Digest</h2>
  <p style="color:#666;font-size:13px;margin-top:0">${dateStr}</p>
  <div style="display:flex;gap:20px;margin:16px 0">
    <div style="background:#eff6ff;border-radius:8px;padding:12px 20px;text-align:center">
      <div style="font-size:28px;font-weight:700;color:#1d4ed8">${aiChats.length}</div>
      <div style="font-size:12px;color:#555">AI chat${aiChats.length !== 1 ? 's' : ''}</div>
    </div>
    <div style="background:#faf5ff;border-radius:8px;padding:12px 20px;text-align:center">
      <div style="font-size:28px;font-weight:700;color:#6b21a8">${faqSearches.length}</div>
      <div style="font-size:12px;color:#555">FAQ search${faqSearches.length !== 1 ? 'es' : ''}</div>
    </div>
  </div>
  <h3 style="margin:20px 0 8px;font-size:16px">All Visitor Queries (last 24h)</h3>
  <ul style="padding-left:18px;font-size:14px;line-height:1.7">${queryListHtml}</ul>
  ${tasksHtml}
  ${insightsHtml}
  <p style="margin-top:24px;font-size:12px;color:#888">This digest is sent once daily. To stop receiving it, contact your platform admin.</p>
</div>`;

  // 7. Send email
  try {
    await sendSpanishEmail({
      to: community.contact_email,
      subject: `[${community.name}] AI Insights Digest -- ${dateStr}`,
      html,
      lang: 'en',
    });
  } catch (e) {
    warn('[ai-digest] send email error', e?.message || e);
  }
}

module.exports = { sendOwnerAiDigest };
