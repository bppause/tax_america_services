import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Monday of the ISO week containing dateStr ('YYYY-MM-DD' in and out) —
// mirrors mondayOf in server/modules/tax/routes.js so the week-jump
// control below always lands on a date the server accepts.
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
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

// One editable row in "My Timesheets" — current week's row is always
// present (synthesized by the server if nothing's been saved yet).
// Locked once submitted or approved; editing a rejected week resets it
// to draft on save, same as the server-side rule.
function MyTimesheetRow({ ts, auth, t, onChanged }) {
  const [hours, setHours] = useState(String(ts.hours ?? ''));
  const [notes, setNotes] = useState(ts.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const locked = ts.status === 'submitted' || ts.status === 'approved';
  const dirty = hours !== String(ts.hours ?? '') || notes !== (ts.notes || '');

  const save = async () => {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 0 || h > 168) {
      setErr(t('employee.timesheets.hoursInvalid'));
      return;
    }
    setBusy(true); setErr('');
    try {
      await taxApi.employeeSaveTimesheet(auth, ts.week_start, { hours: h, notes });
      onChanged();
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await taxApi.employeeSubmitTimesheet(auth, ts.week_start);
      onChanged();
    } catch (e) { setErr(e?.message || t('error.loadFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="tax-contact-item" style={{ padding: 14, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>{t('employee.timesheets.weekOf')} {ts.week_start}</strong>
        <StatusBadge status={ts.status} t={t} />
      </div>
      {ts.status === 'rejected' && ts.rejection_note && (
        <div className="tax-msg tax-msg--error" style={{ margin: 0 }}>
          {t('employee.timesheets.rejectionNote')}: {ts.rejection_note}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('employee.timesheets.hours')}
          <input type="number" min="0" max="168" step="0.25" value={hours} disabled={locked || busy}
                 onChange={e => setHours(e.target.value)} style={{ width: 100 }} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--tax-muted)', flex: 1, minWidth: 200 }}>
          {t('employee.timesheets.notes')}
          <textarea rows={2} value={notes} disabled={locked || busy} maxLength={4000}
                    placeholder={t('employee.timesheets.notesPlaceholder')}
                    onChange={e => setNotes(e.target.value)} />
        </label>
      </div>
      {err && <div className="tax-msg tax-msg--error" style={{ margin: 0 }}>{err}</div>}
      {!locked && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy || !dirty}
                  onClick={save}>{t('employee.timesheets.save')}</button>
          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy || dirty || !ts.id || Number(hours) <= 0}
                  title={dirty ? t('employee.timesheets.saveBeforeSubmit') : ''}
                  onClick={submit}>{t('employee.timesheets.submit')}</button>
        </div>
      )}
    </div>
  );
}

// One row in "Pending Approval" — shown only to a Timesheet Approver
// (is_timesheet_approver || is_seed_owner), mirroring the task review
// queue's approve/reject UX. Never shown for the approver's own
// timesheet — the server blocks self-approval too.
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

export default function EmployeeTimesheets() {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const isApprover = !!employee?.is_timesheet_approver || !!employee?.is_seed_owner;

  const [mine, setMine] = useState(null);
  const [currentWeek, setCurrentWeek] = useState('');
  const [pending, setPending] = useState(null);
  const [err, setErr] = useState('');

  const load = () => {
    taxApi.employeeListTimesheets(auth)
      .then(d => { setMine(d.timesheets || []); setCurrentWeek(d.currentWeek || ''); })
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    if (isApprover) {
      taxApi.adminListTimesheets(auth, 'submitted')
        .then(d => setPending(d.timesheets || []))
        .catch(() => setPending([]));
    }
  };
  useEffect(() => {
    if (!fbUser || !community) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, isApprover]);

  // "Go to a different week" — the recent-weeks list above only shows
  // weeks that already have a saved row, so a week from further back
  // that was never logged has no entry to click into. This fetches (and
  // synthesizes, if blank) one arbitrary past week and merges it into the
  // list so staff can go back and catch up on anything missed. The
  // server (GET /employee/timesheets/:weekStart) refuses a future week;
  // the date input is capped at today as a first line of defense.
  const [jumpDate, setJumpDate] = useState('');
  const [jumpErr, setJumpErr] = useState('');
  const [jumpBusy, setJumpBusy] = useState(false);
  const onJumpToWeek = async () => {
    if (!jumpDate) return;
    setJumpBusy(true); setJumpErr('');
    try {
      const weekStart = mondayOf(jumpDate);
      const d = await taxApi.employeeGetTimesheetWeek(auth, weekStart);
      setMine(prev => {
        const rest = (prev || []).filter(x => x.week_start !== weekStart);
        return [...rest, d.timesheet].sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
      });
      setJumpDate('');
    } catch (e) {
      setJumpErr(e?.message || t('error.loadFailed'));
    } finally { setJumpBusy(false); }
  };

  return (
    <EmployeeShell community={community} active="timesheets">
      <h2 style={{ marginTop: 0 }}>{t('employee.timesheets.title')}</h2>
      <p className="tax-section__lede">{t('employee.timesheets.subtitle')}</p>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {isApprover && (
        <section style={{ marginBottom: 28 }}>
          <h3>{t('employee.timesheets.pendingApproval')}</h3>
          {pending === null ? <p>{t('loading')}</p>
            : pending.length === 0 ? <p style={{ color: 'var(--tax-muted)' }}>{t('employee.timesheets.noneAwaiting')}</p>
            : <div style={{ display: 'grid', gap: 10 }}>
                {pending.map(ts => (
                  <ApprovalRow key={ts.id} ts={ts} auth={auth} t={t} onChanged={load} />
                ))}
              </div>}
        </section>
      )}

      <section>
        <h3>{t('employee.timesheets.myTimesheets')}</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('employee.timesheets.jumpToWeek')}
            <input type="date" value={jumpDate} max={currentWeek || undefined}
                   onChange={e => setJumpDate(e.target.value)} />
          </label>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={jumpBusy || !jumpDate}
                  onClick={onJumpToWeek}>{t('employee.timesheets.go')}</button>
          {jumpErr && <span className="tax-msg tax-msg--error" style={{ margin: 0 }}>{jumpErr}</span>}
        </div>
        {mine === null ? <p>{t('loading')}</p>
          : <div style={{ display: 'grid', gap: 10 }}>
              {mine.map(ts => (
                <MyTimesheetRow key={ts.week_start} ts={ts} auth={auth} t={t} onChanged={load} />
              ))}
            </div>}
      </section>
    </EmployeeShell>
  );
}
