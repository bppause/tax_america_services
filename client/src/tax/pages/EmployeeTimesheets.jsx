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
  if (status === 'rejected') return { tone: 'error', text: t('employee.timesheets.notice.rejected') };
  if (status === 'submitted') return { tone: 'warning', text: t('employee.timesheets.notice.submitted') };
  if (status === 'approved') return { tone: 'success', text: t('employee.timesheets.notice.approved') };
  // draft
  if (weekStart < currentWeek) return { tone: 'error', text: t('employee.timesheets.notice.overdue') };
  return { tone: 'info', text: t('employee.timesheets.notice.currentDraft') };
}

// The week editor — one focused week at a time, Prev/Next navigation,
// one hours input per calendar day (no task/project breakdown, just the
// day's total), and a running weekly total. Locked once submitted or
// approved; editing a rejected week resets it to draft on save, same as
// the server-side rule.
function WeekEditor({ weekStart, ts, auth, t, locale, currentWeek, onPrev, onNext, onChanged }) {
  const days = weekDates(weekStart);
  const sourceValues = () => days.map(d => String(ts?.daily_hours?.[d] ?? 0));
  const [values, setValues] = useState(sourceValues);
  const [notes, setNotes] = useState(ts?.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setValues(sourceValues());
    setNotes(ts?.notes || '');
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, ts?.updated_at]);

  const total = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
  const locked = ts?.status === 'submitted' || ts?.status === 'approved';
  const original = sourceValues();
  const dirty = values.some((v, i) => v !== original[i]) || notes !== (ts?.notes || '');
  const loading = weekStart && !ts;

  const save = async () => {
    for (const v of values) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 24) { setErr(t('employee.timesheets.dailyHoursInvalid')); return; }
    }
    if (total > 168) { setErr(t('employee.timesheets.weeklyHoursInvalid')); return; }
    setBusy(true); setErr('');
    try {
      const dailyHours = {};
      days.forEach((d, i) => { dailyHours[d] = Number(values[i]) || 0; });
      await taxApi.employeeSaveTimesheet(auth, weekStart, { dailyHours, notes });
      onChanged(weekStart);
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
    finally { setBusy(false); }
  };

  // Submit saves whatever's currently in the boxes first, then submits —
  // so a stray unsaved edit (or never having clicked Save at all) can't
  // leave the button stuck disabled. "Save" stays around separately for
  // parking a part-finished week without submitting it yet.
  const submit = async () => {
    for (const v of values) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 24) { setErr(t('employee.timesheets.dailyHoursInvalid')); return; }
    }
    if (total > 168) { setErr(t('employee.timesheets.weeklyHoursInvalid')); return; }
    if (total <= 0) { setErr(t('employee.timesheets.hoursRequiredToSubmit')); return; }
    setBusy(true); setErr('');
    try {
      const dailyHours = {};
      days.forEach((d, i) => { dailyHours[d] = Number(values[i]) || 0; });
      await taxApi.employeeSaveTimesheet(auth, weekStart, { dailyHours, notes });
      await taxApi.employeeSubmitTimesheet(auth, weekStart);
      onChanged(weekStart);
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
    finally { setBusy(false); }
  };

  const notice = !loading ? noticeFor(ts, weekStart, currentWeek, t) : null;

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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            {days.map((d, i) => (
              <label key={d} style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--tax-muted)' }}>
                {formatDayLabel(d, locale)}
                <input type="number" min="0" max="24" step="0.25" value={values[i]} disabled={locked || busy}
                       onChange={e => setValues(v => v.map((x, idx) => idx === i ? e.target.value : x))} />
              </label>
            ))}
          </div>

          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {t('employee.timesheets.weekTotal')}: {total.toFixed(2)} {t('employee.timesheets.hoursAbbrev')}
          </div>

          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('employee.timesheets.notes')}
            <textarea rows={2} value={notes} disabled={locked || busy} maxLength={4000}
                      placeholder={t('employee.timesheets.notesPlaceholder')}
                      onChange={e => setNotes(e.target.value)} />
          </label>

          {err && <div className="tax-msg tax-msg--error" style={{ margin: 0 }}>{err}</div>}
          {!locked && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy || !dirty}
                      onClick={save}>{t('employee.timesheets.save')}</button>
              <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                      disabled={busy || total <= 0}
                      title={total <= 0 ? t('employee.timesheets.hoursRequiredToSubmit') : ''}
                      onClick={submit}>{t('employee.timesheets.submit')}</button>
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
                      currentWeek={currentWeek}
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
