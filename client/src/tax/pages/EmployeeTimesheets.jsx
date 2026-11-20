import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Monday of the ISO week containing dateStr ('YYYY-MM-DD' in and out) —
// mirrors mondayOf in server/modules/tax/routes.js so navigation here
// always lands on a date the server accepts.
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The 7 calendar dates (Monday..Sunday) making up the week starting on
// weekStart — mirrors weekDates in routes.js.
function weekDates(weekStart) {
  const out = [];
  for (let i = 0; i < 7; i++) out.push(addDays(weekStart, i));
  return out;
}

function formatWeekRange(weekStart, locale) {
  const loc = locale === 'es' ? 'es-ES' : 'en-US';
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${addDays(weekStart, 6)}T00:00:00Z`);
  const startLabel = start.toLocaleDateString(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const endLabel = end.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${startLabel} – ${endLabel}`;
}

// "Mon 11/02/2026" — full calendar date per day, as asked, not just a
// bare weekday name.
function formatDayLabel(dateStr, locale) {
  const loc = locale === 'es' ? 'es-ES' : 'en-US';
  const d = new Date(`${dateStr}T00:00:00Z`);
  const weekday = d.toLocaleDateString(loc, { weekday: 'short', timeZone: 'UTC' });
  const numeric = d.toLocaleDateString(loc, { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
  return `${weekday} ${numeric}`;
}

function formatRangeLabel(rangeStart, rangeEnd, period, locale) {
  const loc = locale === 'es' ? 'es-ES' : 'en-US';
  const start = new Date(`${rangeStart}T00:00:00Z`);
  if (period === 'week') return formatWeekRange(rangeStart, locale);
  if (period === 'month') return start.toLocaleDateString(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (period === 'quarter') return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`;
  return `${start.getUTCFullYear()}`; // year
}

const SUMMARY_PERIODS = ['week', 'month', 'quarter', 'year'];

// "My Hours Summary" — a quick period total (week/month/quarter/year)
// with Prev/Next navigation, so staff can see how many hours they've
// logged without doing the arithmetic themselves. Scoped to the caller
// only (GET /employee/timesheets/summary), unlike the cross-staff
// version on the Timesheet Approver dashboard.
function HoursSummary({ auth, t, locale }) {
  const [period, setPeriod] = useState('month');
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setSummary(null); setErr('');
    taxApi.employeeTimesheetsSummary(auth, period, anchor)
      .then(setSummary)
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, anchor]);

  // The period containing today is as far forward as this can go — once
  // it's on screen, "Next" would only show weeks that haven't happened.
  const todayStr = new Date().toISOString().slice(0, 10);
  const atOrPastCurrentPeriod = summary ? summary.rangeEnd >= todayStr : false;

  const shiftAnchor = (dir) => {
    if (dir > 0 && atOrPastCurrentPeriod) return;
    const d = new Date(`${anchor}T00:00:00Z`);
    if (period === 'week') { setAnchor(addDays(anchor, dir * 7)); return; }
    if (period === 'month') { d.setUTCMonth(d.getUTCMonth() + dir, 1); setAnchor(d.toISOString().slice(0, 10)); return; }
    if (period === 'quarter') { d.setUTCMonth(d.getUTCMonth() + dir * 3, 1); setAnchor(d.toISOString().slice(0, 10)); return; }
    d.setUTCFullYear(d.getUTCFullYear() + dir, 0, 1); setAnchor(d.toISOString().slice(0, 10));
  };

  return (
    <section style={{ marginBottom: 28 }}>
      <h3>{t('employee.timesheets.mySummary')}</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {SUMMARY_PERIODS.map(p => (
            <button key={p} type="button"
                    className={`tax-btn tax-btn--sm ${period === p ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                    onClick={() => setPeriod(p)}>{t(`employee.timesheets.period.${p}`)}</button>
          ))}
        </div>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={() => shiftAnchor(-1)}>&larr;</button>
        <strong>{summary ? formatRangeLabel(summary.rangeStart, summary.rangeEnd, period, locale) : '…'}</strong>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={() => shiftAnchor(1)}
                disabled={atOrPastCurrentPeriod}
                title={atOrPastCurrentPeriod ? t('employee.timesheets.noFuturePeriods') : ''}>&rarr;</button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={() => setAnchor(new Date().toISOString().slice(0, 10))}>
          {t('employee.timesheets.today')}
        </button>
      </div>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      {summary && (
        <div style={{ fontWeight: 700, fontSize: 15 }}>
          {t('employee.timesheets.periodTotal')}: {summary.totalHours.toFixed(2)} {t('employee.timesheets.hoursAbbrev')}
          <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--tax-muted)', marginLeft: 8 }}>
            ({summary.weeks.length} {t('employee.timesheets.weeksWord')})
          </span>
        </div>
      )}
    </section>
  );
}

const STATUS_STYLE = {
  draft:     { bg: 'var(--tax-bg-alt)', fg: 'var(--tax-muted)' },
  submitted: { bg: '#fef3c7', fg: '#92400e' },
  approved:  { bg: '#dcfce7', fg: '#166534' },
  rejected:  { bg: '#fee2e2', fg: '#991b1b' },
  skipped:   { bg: '#e0f2fe', fg: '#075985' },
};

function StatusBadge({ status, t }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.draft;
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase', background: s.bg, color: s.fg,
    }}>{t(`employee.timesheets.status.${status}`)}</span>
  );
}

const NOTICE_TONE_STYLE = {
  error:   { bg: '#fee2e2', fg: '#991b1b' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  success: { bg: '#dcfce7', fg: '#166534' },
  info:    { bg: 'var(--tax-bg-alt)', fg: 'var(--tax-muted)' },
};

function NoticeBanner({ tone, children }) {
  const s = NOTICE_TONE_STYLE[tone] || NOTICE_TONE_STYLE.info;
  return (
    <div style={{ padding: '6px 10px', borderRadius: 6, fontSize: 13, fontWeight: 600, background: s.bg, color: s.fg }}>
      {children}
    </div>
  );
}

// What a staff member needs to know about a given week at a glance — the
// whole point being that a past week sitting in draft (never submitted)
// or rejected (needs correction) shouldn't be easy to miss just because
// it's scrolled out of view.
function noticeFor(ts, weekStart, currentWeek, t) {
  const status = ts?.status || 'draft';
  if (status === 'skipped') return { tone: 'info', text: t('employee.timesheets.notice.skipped') };
  if (status === 'rejected') return { tone: 'error', text: t('employee.timesheets.notice.rejected') };
  if (status === 'submitted') return { tone: 'warning', text: t('employee.timesheets.notice.submitted') };
  if (status === 'approved') return { tone: 'success', text: t('employee.timesheets.notice.approved') };
  // draft — not yet submitted. Warning tone even for the current week
  // (not just overdue past weeks) so "you still need to submit this"
  // never blends in as a neutral, easy-to-skip note.
  if (weekStart < currentWeek) return { tone: 'error', text: t('employee.timesheets.notice.overdue') };
  return { tone: 'warning', text: t('employee.timesheets.notice.currentDraft') };
}

// 'HH:MM' (24h, as <input type="time"> gives it) -> minutes since
// midnight, or null when blank or malformed.
function timeToMinutes(v) {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// One day's time ranges checked the same way the server checks them
// (PUT /employee/timesheets/:weekStart): both ends filled in, end after
// start, no two ranges overlapping. A row with neither end filled in is
// ignored — it's dropped on save. Returns { minutes } or { error }.
function checkDayRanges(list) {
  const spans = [];
  for (const r of list || []) {
    if (!r.start && !r.end) continue;
    const s = timeToMinutes(r.start);
    const e = timeToMinutes(r.end);
    if (s == null || e == null) return { error: 'employee.timesheets.rangeIncomplete' };
    if (e <= s) return { error: 'employee.timesheets.rangeEndBeforeStart' };
    spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] < spans[i - 1][1]) return { error: 'employee.timesheets.rangeOverlap' };
  }
  return { minutes: spans.reduce((sum, [s, e]) => sum + (e - s), 0) };
}

function formatClock(hhmm, locale) {
  const mins = timeToMinutes(hhmm);
  if (mins == null) return hhmm || '';
  return new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60)
    .toLocaleTimeString(locale === 'es' ? 'es-ES' : 'en-US', { hour: 'numeric', minute: '2-digit' });
}

function filledRanges(list) {
  return (list || []).filter(r => r.start || r.end).map(r => ({ start: r.start || '', end: r.end || '' }));
}

// The week editor — one focused week at a time, Prev/Next navigation.
// Each day takes the times worked as start/end ranges ("11:00–2:00,
// 3:00–5:00") in the employee's own local time, and the day and week
// totals are added up from them — the server derives the stored hours
// the same way and never takes a typed total. A day on a week entered
// before ranges existed only has a total; it is carried over as-is until
// the employee replaces it with times or clears it. Locked once
// submitted, approved or skipped; editing a rejected week resets it to
// draft on save, same as the server-side rule.
function WeekEditor({ weekStart, ts, auth, t, locale, currentWeek, isApprover, onPrev, onNext, onChanged }) {
  const days = weekDates(weekStart);
  const sourceRanges = () => Object.fromEntries(days.map(d => [d, filledRanges(ts?.daily_ranges?.[d])]));
  const legacyHoursFor = (d) => (ts?.daily_ranges?.[d]?.length ? 0 : (Number(ts?.daily_hours?.[d]) || 0));
  const sourceKept = () => days.filter(d => legacyHoursFor(d) > 0);
  const [ranges, setRanges] = useState(sourceRanges);
  const [keptLegacy, setKeptLegacy] = useState(sourceKept);
  const [notes, setNotes] = useState(ts?.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setRanges(sourceRanges());
    setKeptLegacy(sourceKept());
    setNotes(ts?.notes || '');
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, ts?.updated_at]);

  const locked = ts?.status === 'submitted' || ts?.status === 'approved' || ts?.status === 'skipped';
  const loading = weekStart && !ts;

  const dayInfo = days.map(d => {
    const list = ranges[d] || [];
    const hasRanges = list.some(r => r.start || r.end);
    const check = checkDayRanges(list);
    const legacy = !hasRanges && keptLegacy.includes(d) ? legacyHoursFor(d) : 0;
    const hours = check.error ? 0 : (hasRanges ? Math.round((check.minutes / 60) * 100) / 100 : legacy);
    return { d, list, hasRanges, error: check.error || '', legacy, hours };
  });
  const total = Math.round(dayInfo.reduce((sum, x) => sum + x.hours, 0) * 100) / 100;
  const hasErrors = dayInfo.some(x => x.error);

  const cleaned = () => Object.fromEntries(days.map(d => [d, filledRanges(ranges[d])]));
  const dirty = JSON.stringify(cleaned()) !== JSON.stringify(sourceRanges())
    || JSON.stringify(keptLegacy) !== JSON.stringify(sourceKept())
    || notes !== (ts?.notes || '');
  // Only a Timesheet Approver gets a notes box — regular staff were
  // typing their hours into it instead of the days. Without a note
  // there is nothing to explain a zero-hour week, so staff need hours
  // to submit; a week genuinely not worked is skipped by an approver
  // instead (same rules as the server's PUT and submit).
  const canSubmit = !hasErrors && (total > 0 || (isApprover && !!notes.trim()));
  const cannotSubmitMsg = hasErrors
    ? t('employee.timesheets.fixTimesFirst')
    : t(isApprover ? 'employee.timesheets.hoursOrNoteRequired' : 'employee.timesheets.hoursRequired');

  const setRange = (d, idx, field, value) => setRanges(prev => ({
    ...prev, [d]: (prev[d] || []).map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
  }));
  const addRange = (d) => setRanges(prev => ({ ...prev, [d]: [...(prev[d] || []), { start: '', end: '' }] }));
  const removeRange = (d, idx) => setRanges(prev => ({ ...prev, [d]: (prev[d] || []).filter((_, i) => i !== idx) }));
  const dropLegacy = (d) => setKeptLegacy(prev => prev.filter(x => x !== d));

  const payload = () => {
    let timeZone = '';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_e) { /* ignore */ }
    const body = { dailyRanges: cleaned(), keepLegacy: keptLegacy, timeZone };
    if (isApprover) body.notes = notes;
    return body;
  };

  const save = async () => {
    if (hasErrors) { setErr(t('employee.timesheets.fixTimesFirst')); return; }
    setBusy(true); setErr('');
    try {
      await taxApi.employeeSaveTimesheet(auth, weekStart, payload());
      onChanged(weekStart);
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
    finally { setBusy(false); }
  };

  // Submit saves whatever's currently entered first, then submits — so
  // a stray unsaved edit (or never having clicked Save at all) can't
  // leave the button stuck disabled. "Save" stays around separately for
  // parking a part-finished week without submitting it yet.
  const submit = async () => {
    if (!canSubmit) { setErr(cannotSubmitMsg); return; }
    // Submitting locks the week until an approver acts — a week can only
    // be submitted once (the server itself refuses a second submit; see
    // POST /employee/timesheets/:weekStart/submit), so this is the one
    // moment to make that plain before it's irreversible for the sitting.
    if (!window.confirm(t('employee.timesheets.submitConfirm'))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.employeeSaveTimesheet(auth, weekStart, payload());
      await taxApi.employeeSubmitTimesheet(auth, weekStart);
      onChanged(weekStart);
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
    finally { setBusy(false); }
  };

  const notice = !loading ? noticeFor(ts, weekStart, currentWeek, t) : null;
  const hrs = t('employee.timesheets.hoursAbbrev');

  return (
    <div className="tax-contact-item" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onPrev}
                aria-label={t('employee.timesheets.previousWeek')}>&larr;</button>
        <strong style={{ fontSize: 16 }}>{formatWeekRange(weekStart, locale)}</strong>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onNext}
                disabled={weekStart >= currentWeek}
                title={weekStart >= currentWeek ? t('employee.timesheets.noFutureWeeks') : ''}
                aria-label={t('employee.timesheets.nextWeek')}>&rarr;</button>
        {!loading && <StatusBadge status={ts?.status || 'draft'} t={t} />}
      </div>

      {loading ? <p>{t('loading')}</p> : (
        <>
          {notice && <NoticeBanner tone={notice.tone}>{notice.text}</NoticeBanner>}
          {ts?.status === 'rejected' && ts?.rejection_note && (
            <div className="tax-msg tax-msg--error" style={{ margin: 0 }}>
              {t('employee.timesheets.rejectionNote')}: {ts.rejection_note}
            </div>
          )}
          {ts?.status === 'skipped' && ts?.skip_note && (
            <div style={{ fontSize: 13, color: STATUS_STYLE.skipped.fg }}>
              {t('employee.timesheets.skipNote')}: {ts.skip_note}
            </div>
          )}

          {/* Spelled out in a box of its own, not a muted footnote: each
              day is entered as work blocks (a start and an end time), and
              the totals are worked out from them — there is nowhere to
              type a total, which is easy to miss coming from the old
              one-number-per-day form. */}
          {!locked && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.45,
              background: '#eff6ff', color: '#1e3a8a', border: '1px solid #bfdbfe',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>{t('employee.timesheets.howToTitle')}</div>
              <div>{t('employee.timesheets.dailyHoursHint')}</div>
              <div style={{ marginTop: 4 }}>{t('employee.timesheets.howToAuto')}</div>
            </div>
          )}

          <div style={{ display: 'grid', gap: 6 }}>
            {dayInfo.map(({ d, list, hasRanges, error, legacy, hours }) => (
              <div key={d} style={{
                display: 'grid', gap: 6, padding: '8px 10px', borderRadius: 8, background: 'var(--tax-bg-alt)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 13, minWidth: 130 }}>{formatDayLabel(d, locale)}</span>
                  {locked && (
                    <span style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
                      {hasRanges
                        ? list.map(r => `${formatClock(r.start, locale)} – ${formatClock(r.end, locale)}`).join(', ')
                        : (hours > 0 ? '' : t('employee.timesheets.noTime'))}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 13 }}
                        title={t('employee.timesheets.howToAuto')}>
                    {!locked && <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--tax-muted)', marginRight: 6 }}>{t('employee.timesheets.dayTotalAuto')}</span>}
                    {hours.toFixed(2)} {hrs}
                  </span>
                </div>

                {!locked && legacy > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--tax-muted)' }}>
                    <span>{t('employee.timesheets.legacyTotal', { hours: legacy.toFixed(2) })}</span>
                    <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy}
                            onClick={() => { dropLegacy(d); addRange(d); }}>{t('employee.timesheets.legacyReplace')}</button>
                    <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy}
                            onClick={() => dropLegacy(d)}>{t('employee.timesheets.legacyClear')}</button>
                  </div>
                )}

                {!locked && list.map((r, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
                    <label style={{ display: 'grid', gap: 2, fontSize: 11, color: 'var(--tax-muted)' }}>
                      {t('employee.timesheets.rangeStart')}
                      <input type="time" value={r.start} disabled={busy}
                             onChange={e => setRange(d, idx, 'start', e.target.value)} />
                    </label>
                    <label style={{ display: 'grid', gap: 2, fontSize: 11, color: 'var(--tax-muted)' }}>
                      {t('employee.timesheets.rangeEnd')}
                      <input type="time" value={r.end} disabled={busy}
                             onChange={e => setRange(d, idx, 'end', e.target.value)} />
                    </label>
                    <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy}
                            aria-label={t('employee.timesheets.removeRange')} title={t('employee.timesheets.removeRange')}
                            onClick={() => removeRange(d, idx)}>&times;</button>
                  </div>
                ))}
                {!locked && error && (
                  <div style={{ fontSize: 12, color: 'var(--tax-error)' }}>{t(error)}</div>
                )}
                {!locked && legacy <= 0 && (
                  <div>
                    <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy}
                            onClick={() => addRange(d)}>{t('employee.timesheets.addRange')}</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {t('employee.timesheets.weekTotal')}: {total.toFixed(2)} {hrs}
            {!locked && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--tax-muted)', marginLeft: 8 }}>{t('employee.timesheets.weekTotalAuto')}</span>}
          </div>

          {isApprover ? (
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('employee.timesheets.notes')}
              <textarea rows={2} value={notes} disabled={locked || busy} maxLength={4000}
                        placeholder={t('employee.timesheets.notesPlaceholder')}
                        onChange={e => setNotes(e.target.value)} />
            </label>
          ) : ts?.notes ? (
            // A note saved before the box was removed stays visible
            // (read-only) so hours typed into it can be moved to the days.
            <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('employee.timesheets.legacyNote')}
              <div style={{ whiteSpace: 'pre-wrap', color: 'inherit', marginTop: 2 }}>{ts.notes}</div>
            </div>
          ) : null}

          {err && <div className="tax-msg tax-msg--error" style={{ margin: 0 }}>{err}</div>}
          {!locked && (
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy || !dirty || hasErrors}
                        title={hasErrors ? t('employee.timesheets.fixTimesFirst') : ''}
                        onClick={save}>{t('employee.timesheets.save')}</button>
                <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                        disabled={busy || !canSubmit}
                        title={canSubmit ? t('employee.timesheets.submitHint') : cannotSubmitMsg}
                        onClick={submit}>{t('employee.timesheets.submit')}</button>
              </div>
              <p style={{ fontSize: 11, color: 'var(--tax-muted)', margin: 0 }}>
                {t('employee.timesheets.submitHint')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Compact read-only row for a week other than the one currently focused
// in the editor above — lets staff see at a glance which past weeks
// still need submitting or correcting, and jump straight to one.
function HistoryRow({ ts, locale, currentWeek, t, onView }) {
  const notice = noticeFor(ts, ts.week_start, currentWeek, t);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '8px 12px', borderRadius: 8, background: 'var(--tax-bg-alt)',
    }}>
      <span style={{ fontWeight: 600, minWidth: 140 }}>{formatWeekRange(ts.week_start, locale)}</span>
      <StatusBadge status={ts.status} t={t} />
      <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{ts.hours} {t('employee.timesheets.hoursAbbrev')}</span>
      <span style={{ fontSize: 12, color: NOTICE_TONE_STYLE[notice.tone].fg, fontWeight: 600 }}>{notice.text}</span>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" style={{ marginLeft: 'auto' }}
              onClick={() => onView(ts.week_start)}>{t('employee.timesheets.view')}</button>
    </div>
  );
}

export default function EmployeeTimesheets() {
  const { t, locale } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const isApprover = !!employee?.is_timesheet_approver || !!employee?.is_seed_owner;

  const [mine, setMine] = useState(null);
  const [currentWeek, setCurrentWeek] = useState('');
  const [focusedWeek, setFocusedWeek] = useState('');
  const [err, setErr] = useState('');

  const load = () => {
    taxApi.employeeListTimesheets(auth)
      .then(d => {
        setMine(d.timesheets || []);
        setCurrentWeek(d.currentWeek || '');
        setFocusedWeek(prev => prev || d.currentWeek || '');
      })
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(() => {
    if (!fbUser || !community) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  // Fetches one week (synthesizing a blank draft if it's never been
  // touched) and merges it into `mine` — used both to load a week the
  // Prev/Next/jump controls navigate to, and to refresh just the
  // focused week after a save/submit (a full reload would drop it from
  // the recent-26 list if it's an old week).
  const syncWeek = async (weekStart) => {
    try {
      const d = await taxApi.employeeGetTimesheetWeek(auth, weekStart);
      setMine(prev => {
        const rest = (prev || []).filter(x => x.week_start !== weekStart);
        return [...rest, d.timesheet].sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
      });
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
  };

  useEffect(() => {
    if (!focusedWeek) return;
    if ((mine || []).some(x => x.week_start === focusedWeek)) return;
    syncWeek(focusedWeek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedWeek, mine]);

  const goToWeek = (weekStart) => {
    if (!weekStart || !currentWeek || weekStart > currentWeek) return;
    setFocusedWeek(weekStart);
  };

  const [jumpDate, setJumpDate] = useState('');
  const onJumpToWeek = () => {
    if (!jumpDate) return;
    goToWeek(mondayOf(jumpDate));
    setJumpDate('');
  };

  const focusedTs = (mine || []).find(x => x.week_start === focusedWeek) || null;
  const history = (mine || []).filter(x => x.week_start !== focusedWeek);

  return (
    <EmployeeShell community={community} active="timesheets">
      <h2 style={{ marginTop: 0 }}>{t('employee.timesheets.title')}</h2>
      <p className="tax-section__lede">{t('employee.timesheets.subtitle')}</p>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {isApprover && (
        <p style={{ margin: '0 0 20px' }}>
          <a href={`${community ? `/tax/${community.id}/employee/timesheets-dashboard` : '#'}`}
             className="tax-btn tax-btn--ghost tax-btn--sm">
            {t('employee.timesheets.goToDashboard')}
          </a>
        </p>
      )}

      <HoursSummary auth={auth} t={t} locale={locale} />

      <section>
        <h3>{t('employee.timesheets.myTimesheets')}</h3>

        {!focusedWeek ? <p>{t('loading')}</p> : (
          <WeekEditor weekStart={focusedWeek} ts={focusedTs} auth={auth} t={t} locale={locale}
                      currentWeek={currentWeek} isApprover={isApprover}
                      onPrev={() => goToWeek(addDays(focusedWeek, -7))}
                      onNext={() => goToWeek(addDays(focusedWeek, 7))}
                      onChanged={syncWeek} />
        )}

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, margin: '14px 0', flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('employee.timesheets.jumpToWeek')}
            <input type="date" value={jumpDate} max={currentWeek || undefined}
                   onChange={e => setJumpDate(e.target.value)} />
          </label>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={!jumpDate}
                  onClick={onJumpToWeek}>{t('employee.timesheets.go')}</button>
        </div>

        {mine !== null && history.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <h4 style={{ marginBottom: 8 }}>{t('employee.timesheets.history')}</h4>
            <div style={{ display: 'grid', gap: 6 }}>
              {history.map(ts => (
                <HistoryRow key={ts.week_start} ts={ts} locale={locale} currentWeek={currentWeek} t={t}
                            onView={goToWeek} />
              ))}
            </div>
          </div>
        )}
      </section>
    </EmployeeShell>
  );
}
