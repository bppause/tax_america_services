// timesheet-digest.js — Daily "enter your timesheet" email for every active
// employee, escalating once the previous week has gone unsubmitted.
//
// Staff otherwise have no nudge to log a Monday-Sunday week until an admin
// notices it missing. Once a day, every active employee with an
// outstanding week gets an email:
//   - current week still in draft (or never started) -> a plain reminder,
//     since the week isn't over yet.
//   - previous week still draft, never started, or sent back for
//     correction (rejected) and not yet resubmitted -> an OVERDUE
//     reminder, since that week has already ended.
// An employee with nothing outstanding gets no email at all.
//
// No magic-link token here (unlike review-digest.js / start-digest.js) —
// entering an hours total isn't a single unambiguous click, so the email
// just deep-links into the in-app "My Timesheets" page
// (client/src/tax/pages/EmployeeTimesheets.jsx).
//
// sendDailyTimesheetDigest(communityId, deps) is called once per cycle
// from reminders.js for every active tax community. The cron runs every
// 12h; the in-memory `lastSentDateByCommunity` guard keeps this to one
// send per calendar day (UTC) per community, same convention as the other
// digests in this directory.

'use strict';

const { warn } = require('../../../logger');

const lastSentDateByCommunity = new Map();

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} communityId
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {function} deps.sendSpanishEmail
 * @param {string} [deps.publicAppUrl]
 */
async function sendDailyTimesheetDigest(communityId, deps) {
  const { supabase, sendSpanishEmail, publicAppUrl } = deps;
  const today = todayUtc();
  if (lastSentDateByCommunity.get(communityId) === today) return;

  const { data: community, error: cErr } = await supabase
    .from('communities')
    .select('id, name, name_en, default_locale')
    .eq('id', communityId).maybeSingle();
  if (cErr || !community) { warn('[timesheet-digest] community fetch error', cErr?.message); return; }

  const currentWeek = mondayOf(today);
  const prevWeekDate = new Date(`${currentWeek}T00:00:00Z`);
  prevWeekDate.setUTCDate(prevWeekDate.getUTCDate() - 7);
  const prevWeek = prevWeekDate.toISOString().slice(0, 10);

  const { data: allEmployees, error: eErr } = await supabase
    .from('tax_employees')
    .select('id, email, locale, permissions')
    .eq('community_id', communityId).eq('status', 'active')
    .not('email', 'is', null);
  if (eErr) { warn('[timesheet-digest] employees fetch error', eErr.message); return; }
  // Timesheets are required only for staff who manage customers — a
  // website-only "Site Admin" (view_customers revoked) never clocks
  // billable work, so they're skipped here same as the in-app nav link
  // and badge (see managesCustomers in EmployeeShell.jsx).
  const employees = (allEmployees || []).filter(e => e.permissions?.view_customers !== false);
  if (!employees.length) { lastSentDateByCommunity.set(communityId, today); return; }

  const { data: sheets, error: sErr } = await supabase
    .from('tax_timesheets')
    .select('employee_id, week_start, status')
    .eq('community_id', communityId)
    .in('week_start', [currentWeek, prevWeek]);
  if (sErr) { warn('[timesheet-digest] timesheets fetch error', sErr.message); return; }
  const byEmpWeek = new Map((sheets || []).map(s => [`${s.employee_id}|${s.week_start}`, s]));

  const appUrl = (publicAppUrl || '').replace(/\/$/, '');
  if (!appUrl) { warn('[timesheet-digest] publicAppUrl not configured; skipping'); return; }
  const timesheetsHref = `${appUrl}/tax/${community.id}/employee/timesheets`;
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  let sentAny = false;
  for (const emp of employees) {
    const curRow = byEmpWeek.get(`${emp.id}|${currentWeek}`);
    const prevRow = byEmpWeek.get(`${emp.id}|${prevWeek}`);
    const needsCurrent = !curRow || curRow.status === 'draft';
    const overduePrev = !prevRow || ['draft', 'rejected'].includes(prevRow.status);
    if (!needsCurrent && !overduePrev) continue; // nothing outstanding — no email

    const lang = emp.locale === 'en' ? 'en' : (emp.locale === 'es' ? 'es' : (community.default_locale === 'en' ? 'en' : 'es'));
    const isEn = lang === 'en';
    const communityName = (isEn && community.name_en) ? community.name_en : (community.name || 'Tax America Services');

    const rowsHtml = [];
    if (overduePrev) {
      const label = prevRow?.status === 'rejected'
        ? (isEn ? 'sent back for correction' : 'devuelta para corrección')
        : (isEn ? 'not submitted' : 'no enviada');
      rowsHtml.push(`<tr>
        <td style="padding:8px 0;border-bottom:1px solid #f3f4f6">
          <span style="background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">${isEn ? 'OVERDUE' : 'VENCIDA'}</span>
          <span style="font-weight:500;margin-left:6px">${isEn ? 'Week of' : 'Semana del'} ${esc(prevWeek)}</span>
          <br><span style="color:#9ca3af;font-size:12px">${esc(label)}</span>
        </td>
      </tr>`);
    }
    if (needsCurrent) {
      rowsHtml.push(`<tr>
        <td style="padding:8px 0;border-bottom:1px solid #f3f4f6">
          <span style="font-weight:500">${isEn ? 'Week of' : 'Semana del'} ${esc(currentWeek)}</span>
          <br><span style="color:#9ca3af;font-size:12px">${isEn ? 'not yet entered' : 'aún no registrada'}</span>
        </td>
      </tr>`);
    }

    const subject = overduePrev
      ? (isEn
        ? `[${communityName}] Timesheet overdue -- ${dateStr}`
        : `[${communityName}] Hoja de horas vencida -- ${dateStr}`)
      : (isEn
        ? `[${communityName}] Enter this week's timesheet -- ${dateStr}`
        : `[${communityName}] Registra tu hoja de horas de esta semana -- ${dateStr}`);

    const introHtml = isEn
      ? 'Timesheets run Monday through Sunday and need to be submitted for approval once the week is done.'
      : 'Las hojas de horas van de lunes a domingo y deben enviarse para aprobación una vez termine la semana.';

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <h2 style="margin-bottom:4px">${esc(communityName)} &mdash; ${isEn ? 'Timesheet Reminder' : 'Recordatorio de Horas'}</h2>
  <p style="color:#666;font-size:13px;margin-top:0">${dateStr}</p>
  <p style="margin:0 0 10px;font-size:12px"><a href="${timesheetsHref}" style="color:#1d4ed8">${isEn ? 'Open My Timesheets &rarr;' : 'Abrir Mis Horas &rarr;'}</a></p>
  <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${introHtml}</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;margin-bottom:8px">${rowsHtml.join('')}</table>
  <p style="margin-top:24px;font-size:12px;color:#888">
    ${isEn
      ? 'This reminder is sent once daily while a timesheet is missing or overdue.'
      : 'Este recordatorio se envía una vez al día mientras falte o esté vencida una hoja de horas.'}
  </p>
</div>`;

    try {
      await sendSpanishEmail({ to: [emp.email], subject, html, lang: isEn ? 'en' : 'es-CO' });
      sentAny = true;
    } catch (e) {
      warn('[timesheet-digest] send email error', e?.message || e);
    }
  }
  if (!sentAny) { /* nothing to report today */ }

  lastSentDateByCommunity.set(communityId, today);
}

module.exports = { sendDailyTimesheetDigest };
