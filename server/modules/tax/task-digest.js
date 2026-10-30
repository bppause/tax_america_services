// task-digest.js — Daily "Task status" email for all admins of a tax
// community.
//
// Covers two things admins asked to see every day:
//   1. Tasks still sitting in Not started — a nudge to move them into
//      In progress (so they're claimed and visible as active work).
//   2. Tasks already In progress — title + who owns it, so the team can
//      align on today's priorities without opening the app.
//
// sendDailyTaskStatusDigest(communityId, deps) is called once per cycle
// from reminders.js for every active tax community, same shape as
// sendOwnerAiDigest in ai-digest.js. The cron runs every 12h; the
// in-memory `lastSentDateByCommunity` guard below keeps this to one send
// per calendar day (UTC) per community regardless of how many cycles run,
// without needing a schema change to persist that marker.

'use strict';

const { warn } = require('../../../logger');
const { displayNameOf } = require('./names');

const lastSentDateByCommunity = new Map();

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

const PRIORITY_BADGE_EN = {
  urgent: '<span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">URGENT</span>',
  high:   '<span style="background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">HIGH</span>',
};
const PRIORITY_BADGE_ES = {
  urgent: '<span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">URGENTE</span>',
  high:   '<span style="background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">ALTA</span>',
};

function taskRowsHtml(tasks, lang) {
  const badges = lang === 'en' ? PRIORITY_BADGE_EN : PRIORITY_BADGE_ES;
  const unassignedLabel = lang === 'en' ? 'Unassigned' : 'Sin asignar';
  const dueLabel = lang === 'en' ? 'due' : 'vence';
  return tasks.map(task => {
    const owner = esc(task.tax_employees ? displayNameOf(task.tax_employees) || task.tax_employees.email : unassignedLabel);
    const cust = customerLabel(task.tax_customers);
    const custHtml = cust ? ` <span style="color:#6b7280;font-size:12px">&mdash; ${esc(cust)}</span>` : '';
    const dueHtml = task.due_date
      ? ` <span style="color:#9ca3af;font-size:12px">${dueLabel} ${esc(task.due_date)}</span>`
      : '';
    const badge = badges[task.priority] || '';
    return `<tr>
      <td style="padding:6px 8px 6px 0;vertical-align:top;border-bottom:1px solid #f3f4f6">
        ${badge} <span style="font-weight:500">${esc(task.title)}</span>${custHtml}
      </td>
      <td style="padding:6px 0 6px 8px;vertical-align:top;border-bottom:1px solid #f3f4f6;white-space:nowrap;text-align:right;font-size:12px;color:#374151">
        ${owner}${dueHtml ? '<br>' + dueHtml : ''}
      </td>
    </tr>`;
  }).join('');
}

/**
 * @param {string} communityId
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {function} deps.sendSpanishEmail
 * @param {string} [deps.publicAppUrl]
 */
async function sendDailyTaskStatusDigest(communityId, deps) {
  const { supabase, sendSpanishEmail, publicAppUrl } = deps;
  const today = todayUtc();
  if (lastSentDateByCommunity.get(communityId) === today) return;

  const { data: community, error: cErr } = await supabase
    .from('communities')
    .select('id, name, name_en, default_locale')
    .eq('id', communityId).maybeSingle();
  if (cErr || !community) { warn('[task-digest] community fetch error', cErr?.message); return; }

  const { data: admins, error: aErr } = await supabase
    .from('tax_employees')
    .select('email, locale')
    .eq('community_id', communityId).eq('role', 'admin').eq('status', 'active')
    .not('email', 'is', null);
  if (aErr) { warn('[task-digest] admins fetch error', aErr.message); return; }
  const recipients = (admins || []).filter(a => a.email && a.email.trim());
  if (!recipients.length) return;

  const { data: tasks, error: tErr } = await supabase
    .from('tax_tasks')
    .select('id, title, status_key, priority, due_date, assigned_employee_id, tax_employees(first_name, middle_name, last_name, name, email), tax_customers(business_name, first_name, middle_name, last_name, name, email)')
    .eq('community_id', communityId)
    .in('status_key', ['not_started', 'in_progress'])
    .is('archived_at', null)
    .order('due_date', { ascending: true, nullsFirst: false });
  if (tErr) { warn('[task-digest] tasks fetch error', tErr.message); return; }

  const notStarted = (tasks || []).filter(t => t.status_key === 'not_started');
  const inProgress = (tasks || []).filter(t => t.status_key === 'in_progress');
  if (!notStarted.length && !inProgress.length) return; // nothing to report

  const appUrl = (publicAppUrl || '').replace(/\/$/, '');
  const tasksHref = appUrl ? `${appUrl}/tax/${community.id}/employee/tasks` : null;
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // One send per locale group — recipients without a stored locale fall
  // back to the community's own default.
  const byLocale = new Map();
  for (const a of recipients) {
    const lang = a.locale === 'en' ? 'en' : (a.locale === 'es' ? 'es' : (community.default_locale === 'en' ? 'en' : 'es'));
    if (!byLocale.has(lang)) byLocale.set(lang, []);
    byLocale.get(lang).push(a.email);
  }

  for (const [lang, emails] of byLocale) {
    const isEn = lang === 'en';
    const communityName = (isEn && community.name_en) ? community.name_en : (community.name || 'Tax America Services');
    const subject = isEn
      ? `[${communityName}] Daily task status -- ${dateStr}`
      : `[${communityName}] Estado diario de tareas -- ${dateStr}`;
    const linkText = isEn ? 'Open Tasks board &rarr;' : 'Abrir tablero de tareas &rarr;';
    const linkHtml = tasksHref ? `<p style="margin:0 0 10px;font-size:12px"><a href="${tasksHref}" style="color:#1d4ed8">${linkText}</a></p>` : '';

    const notStartedHtml = notStarted.length ? `
      <h3 style="margin:20px 0 8px;font-size:16px;color:#92400e">
        ${isEn ? `Not started (${notStarted.length}) — move these into In progress` : `Sin iniciar (${notStarted.length}) — pasar a En progreso`}
      </h3>
      <p style="margin:0 0 8px;font-size:13px;color:#6b7280">
        ${isEn
          ? 'These haven’t been picked up yet. Moving a task to In progress tells the rest of the team it’s actively being worked on and by whom.'
          : 'Estas tareas todavía no se han tomado. Pasar una tarea a En progreso le indica al resto del equipo que se está trabajando activamente en ella y quién la tiene a cargo.'}
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;margin-bottom:8px">${taskRowsHtml(notStarted, lang)}</table>
    ` : '';

    const inProgressHtml = inProgress.length ? `
      <h3 style="margin:20px 0 8px;font-size:16px;color:#1d4ed8">
        ${isEn ? `In progress (${inProgress.length}) — today's active work` : `En progreso (${inProgress.length}) — trabajo activo de hoy`}
      </h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;margin-bottom:8px">${taskRowsHtml(inProgress, lang)}</table>
    ` : '';

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <h2 style="margin-bottom:4px">${esc(communityName)} &mdash; ${isEn ? 'Daily Task Status' : 'Estado Diario de Tareas'}</h2>
  <p style="color:#666;font-size:13px;margin-top:0">${dateStr}</p>
  ${linkHtml}
  ${notStartedHtml}
  ${inProgressHtml}
  <p style="margin-top:24px;font-size:12px;color:#888">
    ${isEn
      ? 'This digest is sent once daily to every admin on the practice. To stop receiving it, contact your seeded owner account.'
      : 'Este resumen se envía una vez al día a cada administrador de la práctica. Para dejar de recibirlo, contacte a la cuenta de propietario original.'}
  </p>
</div>`;

    try {
      await sendSpanishEmail({ to: emails, subject, html, lang: isEn ? 'en' : 'es-CO' });
    } catch (e) {
      warn('[task-digest] send email error', e?.message || e);
    }
  }

  lastSentDateByCommunity.set(communityId, today);
}

module.exports = { sendDailyTaskStatusDigest };
