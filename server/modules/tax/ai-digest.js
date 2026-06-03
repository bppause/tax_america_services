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
    .select('id, name, contact_email')
    .eq('id', communityId)
    .maybeSingle();
  if (cErr || !community) { warn('[ai-digest] community fetch error', cErr?.message); return; }
  if (!community.contact_email) return; // nowhere to send

  // 2b. Fetch open tasks for this community (any status except 'completed'/'cancelled')
  const { data: openTasks } = await supabase
    .from('tax_tasks')
    .select('id, title, status_key, priority, due_date, assigned_employee_id, tax_employees(display_name)')
    .eq('community_id', communityId)
    .not('status_key', 'in', '("completed","cancelled","closed")')
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
  const queryListHtml = logs.map(r => {
    const badge = r.kind === 'ai_chat'
      ? '<span style="background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">AI chat</span>'
      : '<span style="background:#f3e8ff;color:#6b21a8;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">FAQ search</span>';
    const escaped = String(r.query).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<li style="margin-bottom:4px">${badge} ${escaped}</li>`;
  }).join('');

  // Build open tasks section
  let tasksHtml = '';
  if (openTasks && openTasks.length > 0) {
    const PRIORITY_BADGE = {
      urgent: '<span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">URGENT</span>',
      high:   '<span style="background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">High</span>',
      normal: '',
      low:    '<span style="background:#f1f5f9;color:#64748b;padding:1px 6px;border-radius:4px;font-size:11px">Low</span>',
    };
    const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked' };

    // Group by assignee
    const byAssignee = {};
    for (const task of openTasks) {
      const key = task.assigned_employee_id || '__unassigned__';
      const name = task.tax_employees?.display_name || 'Unassigned';
      if (!byAssignee[key]) byAssignee[key] = { name, tasks: [] };
      byAssignee[key].tasks.push(task);
    }

    const groupHtml = Object.values(byAssignee).map(({ name, tasks }) => {
      const rows = tasks.map(task => {
        const title = String(task.title).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const dueStr = task.due_date ? `<span style="color:#64748b;font-size:12px"> &mdash; due ${task.due_date}</span>` : '';
        const statusStr = STATUS_LABEL[task.status_key] || task.status_key;
        const badge = PRIORITY_BADGE[task.priority] || '';
        return `<li style="margin-bottom:5px">${badge} ${title}${dueStr} <span style="color:#94a3b8;font-size:12px">[${statusStr}]</span></li>`;
      }).join('');
      return `<div style="margin-bottom:14px"><strong style="font-size:13px;color:#374151">${name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</strong><ul style="margin:4px 0;padding-left:18px;font-size:14px;line-height:1.7">${rows}</ul></div>`;
    }).join('');

    tasksHtml = `<h3 style="margin:24px 0 8px;font-size:16px">Open Tasks (${openTasks.length})</h3>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;background:#fff">${groupHtml}</div>`;
  }

  const insightsHtml = aiInsights
    ? `<h3 style="margin:24px 0 8px;font-size:16px">AI-Generated Insights</h3>
       <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;white-space:pre-wrap">${aiInsights.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`
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
