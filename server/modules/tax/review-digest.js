// review-digest.js — Daily "Tasks awaiting your review" email for every
// Reviewer in a tax community.
//
// A task sitting in Pending review only gets ONE notification today —
// the moment it first lands there (notifyOwnersTaskPendingReview in
// routes.js). If the Reviewer doesn't act same-day, nothing reminds them
// again until they happen to open Tasks. This closes that gap: once a
// day, every active Reviewer (is_task_reviewer or is_seed_owner) gets an
// email listing every task still waiting on them, each with a one-click
// link straight to that task's /tax/review/{token} page — approve it, or
// send it back to In progress with a note to the task's owner, no
// sign-in required (see applyTaskReviewDecision + POST /review/:token in
// routes.js).
//
// sendDailyReviewDigest(communityId, deps) is called once per cycle from
// reminders.js for every active tax community, same shape as
// sendDailyTaskStatusDigest in task-digest.js. The cron runs every 12h;
// the in-memory `lastSentDateByCommunity` guard keeps this to one send
// per calendar day (UTC) per community, same convention.
//
// Unlike task-digest.js (one identical email batched by locale), this
// mints a Reviewer-specific magic-link token per task per Reviewer, so
// each Reviewer's email has to be built and sent individually rather than
// batched.

'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { warn } = require('../../../logger');
const { displayNameOf } = require('./names');

const lastSentDateByCommunity = new Map();
const TOKEN_VALID_DAYS = 14; // generous outer bound; the real gate is the task's live state

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function customerLabel(c) {
  if (!c) return '';
  return c.business_name || displayNameOf(c) || c.email || '';
}

async function mintReviewToken(supabase, taskId, employeeId) {
  const raw = crypto.randomBytes(24).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() + TOKEN_VALID_DAYS);
  await supabase.from('tax_review_tokens').insert({
    id: 'trvtok_' + uuidv4().slice(0, 12),
    task_id: taskId,
    employee_id: employeeId,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
  });
  return raw;
}

function taskRowHtml(task, lang, reviewUrl) {
  const unassignedLabel = lang === 'en' ? 'Unassigned' : 'Sin asignar';
  const dueLabel = lang === 'en' ? 'due' : 'vence';
  const waitingLabel = lang === 'en' ? 'waiting since' : 'esperando desde';
  const reviewLabel = lang === 'en' ? 'Review &rarr;' : 'Revisar &rarr;';
  const preparer = esc(task.tax_employees ? displayNameOf(task.tax_employees) || task.tax_employees.email : unassignedLabel);
  const cust = customerLabel(task.tax_customers);
  const custHtml = cust ? ` <span style="color:#6b7280;font-size:12px">&mdash; ${esc(cust)}</span>` : '';
  const dueText = task.due_date ? `${dueLabel} ${esc(task.due_date)}` : '';
  const waitingSince = task.pending_review_at ? String(task.pending_review_at).slice(0, 10) : '';
  const metaBits = [preparer, dueText, waitingSince ? `${waitingLabel} ${esc(waitingSince)}` : '']
    .filter(Boolean).join(' &middot; ');
  return `<tr>
    <td style="padding:8px 8px 8px 0;vertical-align:top;border-bottom:1px solid #f3f4f6">
      <span style="font-weight:500">${esc(task.title)}</span>${custHtml}<br>
      <span style="color:#9ca3af;font-size:12px">${metaBits}</span>
    </td>
    <td style="padding:8px 0 8px 8px;vertical-align:middle;border-bottom:1px solid #f3f4f6;white-space:nowrap;text-align:right">
      <a href="${reviewUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none">${reviewLabel}</a>
    </td>
  </tr>`;
}

/**
 * @param {string} communityId
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {function} deps.sendSpanishEmail
 * @param {string} [deps.publicAppUrl]
 */
async function sendDailyReviewDigest(communityId, deps) {
  const { supabase, sendSpanishEmail, publicAppUrl } = deps;
  const today = todayUtc();
  if (lastSentDateByCommunity.get(communityId) === today) return;

  const { data: community, error: cErr } = await supabase
    .from('communities')
    .select('id, name, name_en, slug, default_locale')
    .eq('id', communityId).maybeSingle();
  if (cErr || !community) { warn('[review-digest] community fetch error', cErr?.message); return; }

  const { data: tasks, error: tErr } = await supabase
    .from('tax_tasks')
    .select('id, title, due_date, priority, pending_review_at, assigned_employee_id, tax_employees(first_name, middle_name, last_name, name, email), tax_customers(business_name, first_name, middle_name, last_name, name, email)')
    .eq('community_id', communityId)
    .not('pending_review_at', 'is', null)
    .is('reviewed_at', null)
    .is('archived_at', null)
    .order('pending_review_at', { ascending: true });
  if (tErr) { warn('[review-digest] tasks fetch error', tErr.message); return; }
  if (!tasks || !tasks.length) { lastSentDateByCommunity.set(communityId, today); return; } // nothing to report

  const { data: reviewers, error: rErr } = await supabase
    .from('tax_employees')
    .select('id, email, locale')
    .eq('community_id', communityId).eq('status', 'active')
    .or('is_task_reviewer.eq.true,is_seed_owner.eq.true')
    .not('email', 'is', null);
  if (rErr) { warn('[review-digest] reviewers fetch error', rErr.message); return; }
  const recipients = (reviewers || []).filter(r => r.email && r.email.trim());
  if (!recipients.length) { lastSentDateByCommunity.set(communityId, today); return; }

  const appUrl = (publicAppUrl || '').replace(/\/$/, '');
  if (!appUrl) { warn('[review-digest] publicAppUrl not configured; skipping (review links need an absolute URL)'); return; }
  const tasksHref = `${appUrl}/tax/${community.slug}/owner/tasks`;
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  for (const reviewer of recipients) {
    const lang = reviewer.locale === 'en' ? 'en' : (reviewer.locale === 'es' ? 'es' : (community.default_locale === 'en' ? 'en' : 'es'));
    const isEn = lang === 'en';

    const rowsHtml = [];
    for (const task of tasks) {
      const raw = await mintReviewToken(supabase, task.id, reviewer.id);
      const reviewUrl = `${appUrl}/tax/review/${encodeURIComponent(raw)}`;
      rowsHtml.push(taskRowHtml(task, lang, reviewUrl));
    }

    const count = tasks.length;
    const communityName = (isEn && community.name_en) ? community.name_en : (community.name || 'Tax America Services');
    const subject = isEn
      ? `[${communityName}] ${count} task${count === 1 ? '' : 's'} awaiting your review -- ${dateStr}`
      : `[${communityName}] ${count} tarea${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'} de tu revisión -- ${dateStr}`;
    const linkText = isEn ? 'Open Tasks board &rarr;' : 'Abrir tablero de tareas &rarr;';
    const linkHtml = `<p style="margin:0 0 10px;font-size:12px"><a href="${tasksHref}" style="color:#1d4ed8">${linkText}</a></p>`;

    const introHtml = isEn
      ? `${count} task${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} sitting in Pending review and need${count === 1 ? 's' : ''} your sign-off before ${count === 1 ? 'it counts' : 'they count'} as done.`
      : `${count} tarea${count === 1 ? '' : 's'} está${count === 1 ? '' : 'n'} en Pendiente de revisión y necesita${count === 1 ? '' : 'n'} tu aprobación antes de contar como terminada${count === 1 ? '' : 's'}.`;

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <h2 style="margin-bottom:4px">${esc(communityName)} &mdash; ${isEn ? 'Awaiting Your Review' : 'Pendientes de tu Revisión'}</h2>
  <p style="color:#666;font-size:13px;margin-top:0">${dateStr}</p>
  ${linkHtml}
  <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${introHtml}</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;margin-bottom:8px">${rowsHtml.join('')}</table>
  <p style="margin-top:24px;font-size:12px;color:#888">
    ${isEn
      ? 'This reminder is sent once daily to every Reviewer while tasks are waiting. Each "Review" link lets you approve the task, or send it back to In progress with a note for whoever is working it, without signing in.'
      : 'Este recordatorio se envía una vez al día a cada Revisor mientras haya tareas pendientes. Cada enlace "Revisar" te permite aprobar la tarea, o devolverla a En progreso con una nota para quien la está trabajando, sin iniciar sesión.'}
  </p>
</div>`;

    try {
      await sendSpanishEmail({ to: [reviewer.email], subject, html, lang: isEn ? 'en' : 'es-CO' });
    } catch (e) {
      warn('[review-digest] send email error', e?.message || e);
    }
  }

  lastSentDateByCommunity.set(communityId, today);
}

module.exports = { sendDailyReviewDigest };
