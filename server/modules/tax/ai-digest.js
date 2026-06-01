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
