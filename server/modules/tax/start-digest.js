// start-digest.js — Daily "Tasks waiting to start" email for every
// employee who owns at least one Not-started task.
//
// A task's owner otherwise has no reminder at all that work is sitting
// unstarted until they happen to open the board — once a day, every
// active employee with at least one Not-started task assigned to them
// gets an email listing all of them, each with a one-click link
// straight to that task's /tax/start/{token} page — move it to In
// progress right from the email, no sign-in required (see
// applyTaskStart + POST /start/:token in routes.js). A task still
// missing a priority or due date links into the full task editor
// instead, since it isn't actually ready to start yet.
//
// sendDailyStartDigest(communityId, deps) is called once per cycle from
// reminders.js for every active tax community, same shape as
// sendDailyReviewDigest in review-digest.js. The cron runs every 12h;
// the in-memory `lastSentDateByCommunity` guard keeps this to one send
// per calendar day (UTC) per community, same convention.
//
// Mints an owner-specific magic-link token per task per owner, so each
// owner's email has to be built and sent individually rather than
// batched — same reasoning as review-digest.js.

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

async function mintStartToken(supabase, taskId, employeeId) {
  const raw = crypto.randomBytes(24).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() + TOKEN_VALID_DAYS);
  await supabase.from('tax_start_tokens').insert({
    id: 'tsttok_' + uuidv4().slice(0, 12),
    task_id: taskId,
    employee_id: employeeId,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
  });
  return raw;
}

function taskRowHtml(task, lang, startUrl, ready) {
  const dueLabel = lang === 'en' ? 'due' : 'vence';
  const needsInfoBadge = lang === 'en'
    ? '<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">NEEDS INFO</span> '
    : '<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">FALTA INFO</span> ';
  const cust = customerLabel(task.tax_customers);
  const custHtml = cust ? ` <span style="color:#6b7280;font-size:12px">&mdash; ${esc(cust)}</span>` : '';
  const dueHtml = task.due_date ? `<br><span style="color:#9ca3af;font-size:12px">${dueLabel} ${esc(task.due_date)}</span>` : '';
  const actionLabel = ready
    ? (lang === 'en' ? 'Start &rarr;' : 'Iniciar &rarr;')
    : (lang === 'en' ? 'Open &rarr;' : 'Abrir &rarr;');
  return `<tr>
    <td style="padding:8px 8px 8px 0;vertical-align:top;border-bottom:1px solid #f3f4f6">
      ${ready ? '' : needsInfoBadge}<span style="font-weight:500">${esc(task.title)}</span>${custHtml}${dueHtml}
    </td>
    <td style="padding:8px 0 8px 8px;vertical-align:middle;border-bottom:1px solid #f3f4f6;white-space:nowrap;text-align:right">
      <a href="${startUrl}" style="display:inline-block;background:${ready ? '#166534' : '#6b7280'};color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none">${actionLabel}</a>
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
async function sendDailyStartDigest(communityId, deps) {
  const { supabase, sendSpanishEmail, publicAppUrl } = deps;
  const today = todayUtc();
  if (lastSentDateByCommunity.get(communityId) === today) return;

  const { data: community, error: cErr } = await supabase
    .from('communities')
    .select('id, name, name_en, default_locale')
    .eq('id', communityId).maybeSingle();
  if (cErr || !community) { warn('[start-digest] community fetch error', cErr?.message); return; }

  const { data: tasks, error: tErr } = await supabase
    .from('tax_tasks')
    .select('id, title, due_date, priority, assigned_employee_id, tax_customers(business_name, first_name, middle_name, last_name, name, email)')
    .eq('community_id', communityId)
    .eq('status_key', 'not_started')
    .not('assigned_employee_id', 'is', null)
    .is('archived_at', null)
    .order('due_date', { ascending: true, nullsFirst: false });
  if (tErr) { warn('[start-digest] tasks fetch error', tErr.message); return; }
  if (!tasks || !tasks.length) { lastSentDateByCommunity.set(communityId, today); return; } // nothing to report

  const assigneeIds = [...new Set(tasks.map(t => t.assigned_employee_id))];
  const { data: owners, error: oErr } = await supabase
    .from('tax_employees')
    .select('id, email, locale')
    .in('id', assigneeIds).eq('status', 'active')
    .not('email', 'is', null);
  if (oErr) { warn('[start-digest] owners fetch error', oErr.message); return; }
  const ownerById = new Map((owners || []).map(o => [o.id, o]));

  const appUrl = (publicAppUrl || '').replace(/\/$/, '');
  if (!appUrl) { warn('[start-digest] publicAppUrl not configured; skipping (start links need an absolute URL)'); return; }
  const tasksHref = `${appUrl}/tax/${community.id}/employee/tasks`;
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const byOwner = new Map();
  for (const task of tasks) {
    const owner = ownerById.get(task.assigned_employee_id);
    if (!owner || !owner.email) continue;
    if (!byOwner.has(owner.id)) byOwner.set(owner.id, { owner, tasks: [] });
    byOwner.get(owner.id).tasks.push(task);
  }
  if (!byOwner.size) { lastSentDateByCommunity.set(communityId, today); return; }

  for (const { owner, tasks: ownerTasks } of byOwner.values()) {
    const lang = owner.locale === 'en' ? 'en' : (owner.locale === 'es' ? 'es' : (community.default_locale === 'en' ? 'en' : 'es'));
    const isEn = lang === 'en';

    const rowsHtml = [];
    for (const task of ownerTasks) {
      const ready = !!task.priority && !!task.due_date;
      // A task still missing priority/due isn't actually startable yet
      // (same gate POST /start/:token enforces) — send that link
      // straight into the editor instead of the start page (no token
      // minted for it, since it'd never get used), since the start
      // page would just bounce them there anyway.
      const startUrl = ready
        ? `${appUrl}/tax/start/${encodeURIComponent(await mintStartToken(supabase, task.id, owner.id))}`
        : `${appUrl}/tax/${community.id}/employee/tasks?edit=${encodeURIComponent(task.id)}`;
      rowsHtml.push(taskRowHtml(task, lang, startUrl, ready));
    }

    const count = ownerTasks.length;
    const communityName = (isEn && community.name_en) ? community.name_en : (community.name || 'Tax America Services');
    const subject = isEn
      ? `[${communityName}] ${count} task${count === 1 ? '' : 's'} waiting to start -- ${dateStr}`
      : `[${communityName}] ${count} tarea${count === 1 ? '' : 's'} esperando iniciar -- ${dateStr}`;
    const linkText = isEn ? 'Open Tasks board &rarr;' : 'Abrir tablero de tareas &rarr;';
    const linkHtml = `<p style="margin:0 0 10px;font-size:12px"><a href="${tasksHref}" style="color:#1d4ed8">${linkText}</a></p>`;

    const introHtml = isEn
      ? `${count} task${count === 1 ? '' : 's'} assigned to you ${count === 1 ? 'is' : 'are'} still sitting in Not started. Starting a task the moment you begin working on it keeps the board accurate for the whole team.`
      : `${count} tarea${count === 1 ? '' : 's'} asignada${count === 1 ? '' : 's'} a ti todavía está${count === 1 ? '' : 'n'} en Sin iniciar. Iniciar una tarea en el momento en que empiezas a trabajarla mantiene el tablero al día para todo el equipo.`;

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <h2 style="margin-bottom:4px">${esc(communityName)} &mdash; ${isEn ? 'Tasks Waiting to Start' : 'Tareas por Iniciar'}</h2>
  <p style="color:#666;font-size:13px;margin-top:0">${dateStr}</p>
  ${linkHtml}
  <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${introHtml}</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;margin-bottom:8px">${rowsHtml.join('')}</table>
  <p style="margin-top:24px;font-size:12px;color:#888">
    ${isEn
      ? 'This reminder is sent once daily while you have tasks waiting to start. Each "Start" link moves that task to In progress right away, no sign-in required — a task marked "Needs info" opens it in the app instead so you can add what\'s missing first.'
      : 'Este recordatorio se envía una vez al día mientras tengas tareas por iniciar. Cada enlace "Iniciar" pasa esa tarea a En progreso de inmediato, sin iniciar sesión — una tarea marcada "Falta info" la abre en la app para que agregues primero lo que falta.'}
  </p>
</div>`;

    try {
      await sendSpanishEmail({ to: [owner.email], subject, html, lang: isEn ? 'en' : 'es-CO' });
    } catch (e) {
      warn('[start-digest] send email error', e?.message || e);
    }
  }

  lastSentDateByCommunity.set(communityId, today);
}

module.exports = { sendDailyStartDigest };
