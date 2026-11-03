import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatWeekRange(weekStart, locale) {
  const loc = locale === 'es' ? 'es-ES' : 'en-US';
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${addDays(weekStart, 6)}T00:00:00Z`);
  const startLabel = start.toLocaleDateString(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const endLabel = end.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${startLabel} – ${endLabel}`;
}

function formatDayLabel(dateStr, locale) {
  const loc = locale === 'es' ? 'es-ES' : 'en-US';
  const d = new Date(`${dateStr}T00:00:00Z`);
  const weekday = d.toLocaleDateString(loc, { weekday: 'short', timeZone: 'UTC' });
  const numeric = d.toLocaleDateString(loc, { month: '2-digit', day: '2-digit', timeZone: 'UTC' });
  return `${weekday} ${numeric}`;
}

function formatRangeLabel(rangeStart, rangeEnd, period, locale) {
  const loc = locale === 'es' ? 'es-ES' : 'en-US';
  const start = new Date(`${rangeStart}T00:00:00Z`);
  const end = new Date(`${rangeEnd}T00:00:00Z`);
  if (period === 'week') return formatWeekRange(rangeStart, locale);
  if (period === 'month') return start.toLocaleDateString(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (period === 'quarter') {
    const q = Math.floor(start.getUTCMonth() / 3) + 1;
    return `Q${q} ${start.getUTCFullYear()}`;
  }
  return `${start.getUTCFullYear()}`; // year
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

// One row in the approval queue — approve/reject with a required note on
// reject, mirroring the task review queue's UX. Never shown for the
// approver's own timesheet — the server blocks self-approval too.
function ApprovalRow({ ts, auth, t, onChanged }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const who = ts.employee?.name
    || [ts.employee?.first_name, ts.employee?.last_name].filter(Boolean).join(' ')
    || ts.employee?.email || '';

  const decide = async (decision) => {
    if (decision === 'reject' && !note.trim()) {
      setErr(t('employee.timesheets.rejectNoteRequired'));
      return;
    }
    setBusy(true); setErr('');
    try {
      await taxApi.adminReviewTimesheet(auth, ts.id, { decision, note: note.trim() });
      onChanged();
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="tax-contact-item" style={{ padding: 14, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <strong>{who}</strong>
        <span style={{ color: 'var(--tax-muted)', fontSize: 13 }}>
          {t('employee.timesheets.weekOf')} {ts.week_start} &mdash; {ts.hours} {t('employee.timesheets.hoursAbbrev')}
        </span>
      </div>
      {ts.notes && <div style={{ fontSize: 13, color: 'var(--tax-muted)' }}>{ts.notes}</div>}
      <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={4000}
                placeholder={t('employee.timesheets.rejectNotePlaceholder')} />
      {err && <div className="tax-msg tax-msg--error" style={{ margin: 0 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}
                onClick={() => decide('approve')}>{t('employee.timesheets.approve')}</button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy}
                style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}
                onClick={() => decide('reject')}>{t('employee.timesheets.reject')}</button>
      </div>
    </div>
  );
}

// One employee's row in the period summary — click to expand the
// individual weeks that make up the total; click a week to expand its
// own daily breakdown. Two-level drill-down: period total -> weeks ->
// days.
function SummaryRow({ row, locale, t }) {
  const [openWeeks, setOpenWeeks] = useState(false);
  const [openWeekStart, setOpenWeekStart] = useState('');

  return (
    <div style={{ border: '1px solid var(--tax-border)', borderRadius: 8, overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpenWeeks(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '10px 12px', border: 0, background: '#fff', cursor: 'pointer', textAlign: 'left',
              }}>
        <span aria-hidden="true" style={{ transition: 'transform .15s ease', transform: openWeeks ? 'none' : 'rotate(-90deg)' }}>&#9662;</span>
        <span style={{ fontWeight: 600, flex: 1 }}>{row.name}</span>
        <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{row.weeks.length} {t('employee.timesheets.weeksWord')}</span>
        <span style={{ fontWeight: 700 }}>{row.totalHours.toFixed(2)} {t('employee.timesheets.hoursAbbrev')}</span>
      </button>
      {openWeeks && (
        <div style={{ padding: '4px 12px 10px', display: 'grid', gap: 6 }}>
          {row.weeks.slice().sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1)).map(w => (
            <div key={w.weekStart}>
              <button type="button" onClick={() => setOpenWeekStart(s => s === w.weekStart ? '' : w.weekStart)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '6px 8px', border: 0, background: 'var(--tax-bg-alt)', borderRadius: 6,
                        cursor: 'pointer', textAlign: 'left', fontSize: 13,
                      }}>
                <span>{formatWeekRange(w.weekStart, locale)}</span>
                <StatusBadge status={w.status} t={t} />
                <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{w.hours.toFixed(2)} {t('employee.timesheets.hoursAbbrev')}</span>
              </button>
              {openWeekStart === w.weekStart && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 6, padding: '6px 8px' }}>
                  {Object.keys(w.dailyHours || {}).length === 0
                    ? <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{t('employee.timesheets.noDailyBreakdown')}</span>
                    : Array.from({ length: 7 }, (_, i) => addDays(w.weekStart, i)).map(d => (
                        <div key={d} style={{ fontSize: 12 }}>
                          <div style={{ color: 'var(--tax-muted)' }}>{formatDayLabel(d, locale)}</div>
                          <div style={{ fontWeight: 600 }}>{(w.dailyHours?.[d] || 0)} {t('employee.timesheets.hoursAbbrev')}</div>
                        </div>
                      ))}
                  {w.rejectionNote && (
                    <div style={{ gridColumn: '1 / -1', fontSize: 12, color: STATUS_STYLE.rejected.fg }}>
                      {t('employee.timesheets.rejectionNote')}: {w.rejectionNote}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PERIODS = ['week', 'month', 'quarter', 'year'];

export default function OwnerTimesheetsDashboard() {
  const { t, locale } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const isApprover = !!employee?.is_timesheet_approver || !!employee?.is_seed_owner;

  // ── Approval queue ──────────────────────────────────────────────────
  const [pending, setPending] = useState(null);
  const loadPending = () => {
    if (!isApprover) return;
    taxApi.adminListTimesheets(auth, 'submitted')
      .then(d => setPending(d.timesheets || []))
      .catch(() => setPending([]));
  };
  useEffect(() => {
    if (!fbUser || !community || !isApprover) return;
    loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, isApprover]);

  // ── Period summary ──────────────────────────────────────────────────
  const [period, setPeriod] = useState('month');
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState(null);
  const [summaryErr, setSummaryErr] = useState('');
  useEffect(() => {
    if (!fbUser || !community || !isApprover) return;
    setSummary(null); setSummaryErr('');
    taxApi.adminTimesheetsSummary(auth, period, anchor)
      .then(setSummary)
      .catch(e => setSummaryErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, isApprover, period, anchor]);

  const shiftAnchor = (dir) => {
    const d = new Date(`${anchor}T00:00:00Z`);
    if (period === 'week') { setAnchor(addDays(anchor, dir * 7)); return; }
    if (period === 'month') { d.setUTCMonth(d.getUTCMonth() + dir, 1); setAnchor(d.toISOString().slice(0, 10)); return; }
    if (period === 'quarter') { d.setUTCMonth(d.getUTCMonth() + dir * 3, 1); setAnchor(d.toISOString().slice(0, 10)); return; }
    d.setUTCFullYear(d.getUTCFullYear() + dir, 0, 1); setAnchor(d.toISOString().slice(0, 10));
  };

  // ── History ─────────────────────────────────────────────────────────
  const [historyStatus, setHistoryStatus] = useState('all');
  const [history, setHistory] = useState(null);
  const loadHistory = () => {
    if (!isApprover) return;
    taxApi.adminListTimesheets(auth, historyStatus, { limit: 200 })
      .then(d => setHistory((d.timesheets || []).filter(ts => ts.status !== 'draft')))
      .catch(() => setHistory([]));
  };
  useEffect(() => {
    if (!fbUser || !community || !isApprover) return;
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, isApprover, historyStatus]);

  const refreshAll = () => { loadPending(); loadHistory(); };

  if (employee && !isApprover) {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  return (
    <EmployeeShell community={community} active="timesheets-dashboard">
      <h2 style={{ marginTop: 0 }}>{t('employee.timesheets.dashboardTitle')}</h2>
      <p className="tax-section__lede">{t('employee.timesheets.dashboardSubtitle')}</p>

      <section style={{ marginBottom: 28 }}>
        <h3>{t('employee.timesheets.pendingApproval')}</h3>
        {pending === null ? <p>{t('loading')}</p>
          : pending.length === 0 ? <p style={{ color: 'var(--tax-muted)' }}>{t('employee.timesheets.noneAwaiting')}</p>
          : <div style={{ display: 'grid', gap: 10 }}>
              {pending.map(ts => (
                <ApprovalRow key={ts.id} ts={ts} auth={auth} t={t} onChanged={refreshAll} />
              ))}
            </div>}
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3>{t('employee.timesheets.summary')}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {PERIODS.map(p => (
              <button key={p} type="button"
                      className={`tax-btn tax-btn--sm ${period === p ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                      onClick={() => setPeriod(p)}>{t(`employee.timesheets.period.${p}`)}</button>
            ))}
          </div>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={() => shiftAnchor(-1)}>&larr;</button>
          <strong>{summary ? formatRangeLabel(summary.rangeStart, summary.rangeEnd, period, locale) : '…'}</strong>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={() => shiftAnchor(1)}>&rarr;</button>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={() => setAnchor(new Date().toISOString().slice(0, 10))}>
            {t('employee.timesheets.today')}
          </button>
        </div>

        {summaryErr && <div className="tax-msg tax-msg--error">{summaryErr}</div>}
        {!summary ? <p>{t('loading')}</p>
          : summary.rows.length === 0 ? <p style={{ color: 'var(--tax-muted)' }}>{t('employee.timesheets.summaryEmpty')}</p>
          : <>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>
                {t('employee.timesheets.periodTotal')}: {summary.totalHours.toFixed(2)} {t('employee.timesheets.hoursAbbrev')}
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {summary.rows.map(row => (
                  <SummaryRow key={row.employeeId} row={row} locale={locale} t={t} />
                ))}
              </div>
            </>}
      </section>

      <section>
        <h3>{t('employee.timesheets.history')}</h3>
        <div style={{ marginBottom: 10 }}>
          <select value={historyStatus} onChange={e => setHistoryStatus(e.target.value)}
                  style={{ padding: '6px 8px', fontSize: 13, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="all">{t('employee.timesheets.historyFilter.all')}</option>
            <option value="submitted">{t('employee.timesheets.status.submitted')}</option>
            <option value="approved">{t('employee.timesheets.status.approved')}</option>
            <option value="rejected">{t('employee.timesheets.status.rejected')}</option>
          </select>
        </div>
        {history === null ? <p>{t('loading')}</p>
          : history.length === 0 ? <p style={{ color: 'var(--tax-muted)' }}>{t('employee.timesheets.historyEmpty')}</p>
          : <div style={{ display: 'grid', gap: 6 }}>
              {history.map(ts => {
                const who = ts.employee?.name
                  || [ts.employee?.first_name, ts.employee?.last_name].filter(Boolean).join(' ')
                  || ts.employee?.email || '';
                return (
                  <div key={ts.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    padding: '8px 12px', borderRadius: 8, background: 'var(--tax-bg-alt)', fontSize: 13,
                  }}>
                    <span style={{ fontWeight: 600, minWidth: 140 }}>{who}</span>
                    <span>{formatWeekRange(ts.week_start, locale)}</span>
                    <StatusBadge status={ts.status} t={t} />
                    <span style={{ color: 'var(--tax-muted)' }}>{ts.hours} {t('employee.timesheets.hoursAbbrev')}</span>
                    {ts.status === 'rejected' && ts.rejection_note && (
                      <span style={{ color: STATUS_STYLE.rejected.fg }}>{ts.rejection_note}</span>
                    )}
                  </div>
                );
              })}
            </div>}
      </section>
    </EmployeeShell>
  );
}
