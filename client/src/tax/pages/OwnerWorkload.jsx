import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Workload heatmap — rows = active staff, columns = N days starting at
// `start`. Each cell shows the weighted open-task count for that
// (staff, day). Click jumps to /tasks with assigned-to + due filter
// applied so the operator can drill into the specific load.
//
// Defaults to a 14-day window starting today. ‹ / › buttons step a week
// at a time. "This week" returns to the current Monday.

const HEAT_TONES = [
  { ceil: 0,     bg: '#fafafa',                                  fg: '#9ca3af', label: '—' },
  { ceil: 2,     bg: '#dcfce7',                                  fg: '#166534' },
  { ceil: 5,     bg: '#fef3c7',                                  fg: '#92400e' },
  { ceil: 10,    bg: '#fed7aa',                                  fg: '#7c2d12' },
  { ceil: Infinity, bg: '#fee2e2',                               fg: '#991b1b' },
];

function pickTone(weight) {
  for (const t of HEAT_TONES) if (weight <= t.ceil) return t;
  return HEAT_TONES[HEAT_TONES.length - 1];
}

function startOfMondayWeekUtc(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay(); // 0=Sun .. 6=Sat
  const back = dow === 0 ? 6 : (dow - 1);
  x.setUTCDate(x.getUTCDate() - back);
  return x.toISOString().slice(0, 10);
}

export default function OwnerWorkload() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [start, setStart] = useState(() => startOfMondayWeekUtc());
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!employee || !community) return;
    setErr(''); setData(null);
    taxApi.adminGetWorkload(auth, { start, days })
      .then(d => setData(d))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee, community, start, days]);

  // Per-row totals so we can rank staff at a glance.
  const rowTotals = useMemo(() => {
    if (!data?.rows) return {};
    const out = {};
    for (const r of data.rows) {
      out[r.employeeId] = r.cells.reduce((acc, c) => acc + (c.weight || 0), 0);
    }
    return out;
  }, [data]);

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  const shiftDays = (n) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    setStart(d.toISOString().slice(0, 10));
  };

  const dateHeaderLabel = (iso, idx) => {
    const d = new Date(`${iso}T00:00:00Z`);
    const wd = d.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES',
      { weekday: 'short', timeZone: 'UTC' });
    const dm = d.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES',
      { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    const todayIso = new Date().toISOString().slice(0, 10);
    const isToday = iso === todayIso;
    return { wd, dm, isWeekend, isToday, idx };
  };

  const cellHref = (employeeId, dateIso) => {
    const base = `/tax/${community?.id}/employee/tasks`;
    const params = new URLSearchParams();
    if (employeeId !== '__unassigned__') params.set('assignedTo', employeeId);
    params.set('dueDate', dateIso); // tasks page can interpret this as an exact-day filter
    return `${base}?${params.toString()}`;
  };

  return (
    <EmployeeShell community={community} active="workload">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>{t('owner.workload.title')}</h2>
          <p className="tax-section__lede" style={{ margin: '4px 0 0' }}>
            {t('owner.workload.subtitle')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={() => shiftDays(-7)}>
            ‹ {t('owner.workload.prevWeek')}
          </button>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={() => setStart(startOfMondayWeekUtc())}>
            {t('owner.workload.thisWeek')}
          </button>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={() => shiftDays(7)}>
            {t('owner.workload.nextWeek')} ›
          </button>
          <select value={days} onChange={e => setDays(Number(e.target.value))}
                  style={{ padding: '6px 8px', fontSize: 13, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value={7}>{t('owner.workload.range7')}</option>
            <option value={14}>{t('owner.workload.range14')}</option>
            <option value={28}>{t('owner.workload.range28')}</option>
          </select>
        </div>
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      {!data && !err && <p>{t('loading')}</p>}

      {data && (
        <>
          <div style={{ overflowX: 'auto', border: '1px solid var(--tax-border)', borderRadius: 8 }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 720 }}>
              <thead>
                <tr style={{ background: 'var(--tax-bg-alt)' }}>
                  <th style={{ position: 'sticky', left: 0, background: 'var(--tax-bg-alt)', padding: 8, textAlign: 'left', fontSize: 12, borderBottom: '1px solid var(--tax-border)', minWidth: 160 }}>
                    {t('owner.workload.col.staff')}
                  </th>
                  {data.dates.map((iso, i) => {
                    const h = dateHeaderLabel(iso, i);
                    return (
                      <th key={iso} style={{
                        padding: '6px 4px', textAlign: 'center', fontSize: 11,
                        borderBottom: '1px solid var(--tax-border)',
                        background: h.isToday ? '#fef3c7' : (h.isWeekend ? '#f3f4f6' : 'var(--tax-bg-alt)'),
                        fontWeight: h.isToday ? 700 : 500,
                        minWidth: 56,
                      }}>
                        <div style={{ textTransform: 'uppercase', color: 'var(--tax-muted)', fontSize: 10 }}>{h.wd}</div>
                        <div>{h.dm}</div>
                      </th>
                    );
                  })}
                  <th style={{ padding: 8, fontSize: 12, borderBottom: '1px solid var(--tax-border)', minWidth: 64, textAlign: 'right' }}>
                    {t('owner.workload.col.total')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.employeeId}>
                    <td style={{ position: 'sticky', left: 0, background: '#fff', padding: 8, fontSize: 13, borderBottom: '1px solid var(--tax-border)' }}>
                      <div style={{ fontWeight: 600 }}>{r.name}</div>
                      {r.email && <div style={{ fontSize: 11, color: 'var(--tax-muted)' }}>{r.email}</div>}
                    </td>
                    {r.cells.map((cell, i) => {
                      const tone = pickTone(cell.weight || 0);
                      const dateIso = data.dates[i];
                      const inner = (
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 13, fontWeight: 600,
                          width: '100%', height: 40,
                          color: tone.fg, background: tone.bg,
                          cursor: cell.count > 0 ? 'pointer' : 'default',
                        }} title={`${cell.count} ${t('owner.workload.tasksWord')} · ${t('owner.workload.weightWord')} ${Math.round((cell.weight || 0) * 10) / 10}`}>
                          {cell.count || ''}
                        </div>
                      );
                      return (
                        <td key={dateIso} style={{ padding: 0, borderBottom: '1px solid var(--tax-border)' }}>
                          {cell.count > 0
                            ? <a href={cellHref(r.employeeId, dateIso)} style={{ textDecoration: 'none' }}>{inner}</a>
                            : inner}
                        </td>
                      );
                    })}
                    <td style={{ padding: 8, fontSize: 13, fontWeight: 700, textAlign: 'right', borderBottom: '1px solid var(--tax-border)' }}>
                      {Math.round((rowTotals[r.employeeId] || 0) * 10) / 10}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Legend so the heat scale doesn't look arbitrary. */}
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <span style={{ color: 'var(--tax-muted)' }}>{t('owner.workload.legend')}:</span>
            {HEAT_TONES.map((tone, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 999,
                background: tone.bg, color: tone.fg, fontWeight: 600,
              }}>
                {i === 0 ? '0'
                  : i === HEAT_TONES.length - 1 ? `${HEAT_TONES[i - 1].ceil}+`
                  : `${HEAT_TONES[i - 1].ceil + 0.5}–${tone.ceil}`}
              </span>
            ))}
            <span style={{ color: 'var(--tax-muted)', marginLeft: 12 }}>
              {t('owner.workload.legendHint')}
            </span>
          </div>
        </>
      )}
    </EmployeeShell>
  );
}
