// timesheet-approval-digest.js — Daily "timesheets awaiting your approval"
// email for the seed owner and anyone delegated the Timesheet Approver
// role (is_timesheet_approver — see isTimesheetApprover in routes.js).
//
// Submitted timesheets otherwise just sit in the approval queue until an
// approver happens to open it. Once a day, every active approver with at
// least one submitted-and-unapproved timesheet in their community gets an
// email listing all of them, escalating the ones pending for 3+ days to
// an OVERDUE style so a backlog doesn't go unnoticed.
//
// Same deep-link convention as timesheet-digest.js — no magic-link token,
// since approving requires picking approve/reject (and a note on reject),
// not a single unambiguous click.
//
// sendDailyTimesheetApprovalDigest(communityId, deps) is called once per
// cycle from reminders.js for every active tax community, same shape as
// the other digests in this directory. The in-memory
// `lastSentDateByCommunity` guard keeps this to one send per calendar day
// (UTC) per community.

'use strict';

const { warn } = require('../../../logger');
const { displayNameOf } = require('./names');

const lastSentDateByCommunity = new Map();
const OVERDUE_AFTER_DAYS = 3;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function daysPending(submittedAt) {
  if (!submittedAt) return 0;
  return Math.floor((Date.now() - new Date(submittedAt).getTime()) / 86400000);
}

function sheetRowHtml(sheet, lang) {
  const isEn = lang === 'en';
  const pending = daysPending(sheet.submitted_at);
  const overdue = pending >= OVERDUE_AFTER_DAYS;
  const overdueBadge = overdue
    ? `<span style="background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">${isEn ? 'OVERDUE' : 'VENCIDA'}</span> `
    : '';
  const who = esc(displayNameOf(sheet.tax_employees) || sheet.tax_employees?.email || '');
  const hoursLabel = isEn ? 'hrs' : 'hrs';
  const pendingLabel = isEn
    ? `pending ${pending} day${pending === 1 ? '' : 's'}`
    : `pendiente ${pending} día${pending === 1 ? '' : 's'}`;
  return `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #f3f4f6">
      ${overdueBadge}<span style="font-weight:500">${who}</span>
      <span style="color:#6b7280;font-size:12px"> &mdash; ${isEn ? 'week of' : 'semana del'} ${esc(sheet.week_start)}, ${esc(String(sheet.hours))} ${hoursLabel}</span>
      <br><span style="color:#9ca3af;font-size:12px">${pendingLabel}</span>
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
async function sendDailyTimesheetApprovalDigest(communityId, deps) {
  const { supabase, sendSpanishEmail, publicAppUrl } = deps;
  const today = todayUtc();
  if (lastSentDateByCommunity.get(communityId) === today) return;

  const { data: community, error: cErr } = await supabase
    .from('communities')
    .select('id, name, name_en, default_locale')
    .eq('id', communityId).maybeSingle();
  if (cErr || !community) { warn('[timesheet-approval-digest] community fetch error', cErr?.message); return; }

  const { data: sheets, error: sErr } = await supabase
    .from('tax_timesheets')
    .select('id, week_start, hours, submitted_at, employee_id, tax_employees!tax_timesheets_employee_id_fkey(name, first_name, middle_name, last_name, email)')
    .eq('community_id', communityId)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: true });
  if (sErr) { warn('[timesheet-approval-digest] timesheets fetch error', sErr.message); return; }
  if (!sheets || !sheets.length) { lastSentDateByCommunity.set(communityId, today); return; } // nothing to report

  const { data: approvers, error: aErr } = await supabase
    .from('tax_employees')
    .select('id, email, locale')
    .eq('community_id', communityId).eq('status', 'active')
    .not('email', 'is', null)
    .or('is_timesheet_approver.eq.true,is_seed_owner.eq.true');
  if (aErr) { warn('[timesheet-approval-digest] approvers fetch error', aErr.message); return; }
  if (!approvers || !approvers.length) { lastSentDateByCommunity.set(communityId, today); return; }

  const appUrl = (publicAppUrl || '').replace(/\/$/, '');
  if (!appUrl) { warn('[timesheet-approval-digest] publicAppUrl not configured; skipping'); return; }
  const timesheetsHref = `${appUrl}/tax/${community.id}/employee/timesheets`;
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const anyOverdue = sheets.some(s => daysPending(s.submitted_at) >= OVERDUE_AFTER_DAYS);

  for (const approver of approvers) {
    const lang = approver.locale === 'en' ? 'en' : (approver.locale === 'es' ? 'es' : (community.default_locale === 'en' ? 'en' : 'es'));
    const isEn = lang === 'en';
    const communityName = (isEn && community.name_en) ? community.name_en : (community.name || 'Tax America Services');
    const count = sheets.length;

    const rowsHtml = sheets.map(s => sheetRowHtml(s, lang)).join('');
    const subject = anyOverdue
      ? (isEn
        ? `[${communityName}] ${count} timesheet${count === 1 ? '' : 's'} awaiting approval (overdue) -- ${dateStr}`
        : `[${communityName}] ${count} hoja${count === 1 ? '' : 's'} de horas por aprobar (vencida) -- ${dateStr}`)
      : (isEn
        ? `[${communityName}] ${count} timesheet${count === 1 ? '' : 's'} awaiting approval -- ${dateStr}`
        : `[${communityName}] ${count} hoja${count === 1 ? '' : 's'} de horas por aprobar -- ${dateStr}`);

    const introHtml = isEn
      ? `${count} submitted timesheet${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} waiting on your approval.`
      : `${count} hoja${count === 1 ? '' : 's'} de horas enviada${count === 1 ? '' : 's'} ${count === 1 ? 'está' : 'están'} esperando tu aprobación.`;

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <h2 style="margin-bottom:4px">${esc(communityName)} &mdash; ${isEn ? 'Timesheets Awaiting Approval' : 'Hojas de Horas por Aprobar'}</h2>
  <p style="color:#666;font-size:13px;margin-top:0">${dateStr}</p>
  <p style="margin:0 0 10px;font-size:12px"><a href="${timesheetsHref}" style="color:#1d4ed8">${isEn ? 'Open approval queue &rarr;' : 'Abrir cola de aprobación &rarr;'}</a></p>
  <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${introHtml}</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;margin-bottom:8px">${rowsHtml}</table>
  <p style="margin-top:24px;font-size:12px;color:#888">
    ${isEn
      ? `This reminder is sent once daily while timesheets are waiting on approval, escalating after ${OVERDUE_AFTER_DAYS} days.`
      : `Este recordatorio se envía una vez al día mientras haya hojas de horas pendientes de aprobación, con aviso urgente después de ${OVERDUE_AFTER_DAYS} días.`}
  </p>
</div>`;

    try {
      await sendSpanishEmail({ to: [approver.email], subject, html, lang: isEn ? 'en' : 'es-CO' });
    } catch (e) {
      warn('[timesheet-approval-digest] send email error', e?.message || e);
    }
  }

  lastSentDateByCommunity.set(communityId, today);
}

module.exports = { sendDailyTimesheetApprovalDigest };
