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

function formatRangeLabel(rangeStart, rangeEnd, period, locale) {
  const loc = locale === 'es' ? 'es-ES' : 'en-US';
  const start = new Date(`${rangeStart}T00:00:00Z`);
  if (period === 'week') {
    const end = new Date(`${rangeEnd}T00:00:00Z`);
    const startLabel = start.toLocaleDateString(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const endLabel = end.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return `${startLabel} – ${endLabel}`;
  }
  if (period === 'month') return start.toLocaleDateString(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (period === 'quarter') return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`;
  return `${start.getUTCFullYear()}`; // year
}

// Minutes are a count of 60s heartbeats (see GET /admin/activity/summary)
// — an approximation of time spent, not a precise duration.
function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return `${h}h ${m}m`;
}

// Maps a feature key (the same `active` value every page already passes
// to EmployeeShell for nav highlighting — see EmployeeShell.jsx's
// activity-ping effect) to its existing nav label where one exists. Not
// every tracked feature has a top-level nav entry (a customer's
// Documents/Messages tab, for instance, reuses the parent page's "active"
// scheme) — those fall back to a humanized version of the raw key rather
// than showing nothing.
const FEATURE_LABEL_KEY = {
  dashboard: 'employee.nav.dashboard', inbox: 'employee.nav.inbox', tasks: 'employee.nav.tasks',
  progress: 'employee.nav.progress', customers: 'employee.nav.customers', leads: 'employee.nav.leads',
  'service-catalog': 'employee.nav.serviceCatalog', services: 'employee.nav.services',
  articles: 'employee.nav.articles', faqs: 'employee.nav.faqsAdmin', staff: 'employee.nav.staff',
  'email-templates': 'employee.nav.emailTemplates', settings: 'employee.nav.settings',
  workflows: 'employee.nav.workflows', audit: 'employee.nav.audit', activity: 'employee.nav.activity',
  news: 'employee.nav.news', testimonials: 'employee.nav.testimonials', whatsapp: 'employee.nav.whatsapp',
  profile: 'employee.nav.profile', help: 'employee.nav.help', timesheets: 'employee.nav.timesheets',
  'timesheets-dashboard': 'employee.nav.timesheetsDashboard', setup: 'employee.nav.setup',
  reminders: 'employee.nav.reminders',
};
function featureLabel(key, t) {
  const labelKey = FEATURE_LABEL_KEY[key];
  if (labelKey) return t(labelKey);
  return String(key).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// One employee's row — click to expand into a ranked list of features by
// estimated minutes, each with a simple proportional bar (no charting
// library, same hand-rolled style as the Timesheets dashboard's drill-down).
function ActivityEmployeeRow({ row, t }) {
  const [open, setOpen] = useState(false);
  const maxMinutes = Math.max(1, ...row.features.map(f => f.minutes));

  return (
    <div style={{ border: '1px solid var(--tax-border)', borderRadius: 8, overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '10px 12px', border: 0, background: '#fff', cursor: 'pointer', textAlign: 'left',
              }}>
        <span aria-hidden="true" style={{ transition: 'transform .15s ease', transform: open ? 'none' : 'rotate(-90deg)' }}>&#9662;</span>
        <span style={{ fontWeight: 600, flex: 1 }}>{row.name}</span>
        <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
          {row.totalViews} {t('employee.activity.viewsWord')}
        </span>
        <span style={{ fontWeight: 700 }}>{formatMinutes(row.totalMinutes)}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 12px 12px', display: 'grid', gap: 6 }}>
          {row.features.length === 0
            ? <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{t('employee.activity.noFeatures')}</span>
            : row.features.map(f => (
                <div key={f.feature} style={{ display: 'grid', gap: 2 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span>{featureLabel(f.feature, t)}</span>
                    <span style={{ color: 'var(--tax-muted)' }}>
                      {formatMinutes(f.minutes)} &middot; {f.views} {t('employee.activity.viewsWord')}
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: 'var(--tax-bg-alt)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${Math.max(4, (f.minutes / maxMinutes) * 100)}%`,
                      background: '#1d4ed8', borderRadius: 999,
                    }} />
                  </div>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}

const PERIODS = ['week', 'month', 'quarter', 'year'];

export default function OwnerActivityDashboard() {
  const { t, locale } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [period, setPeriod] = useState('week');
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!fbUser || !community || !employee || employee.role !== 'admin') return;
    setSummary(null); setErr('');
    taxApi.adminActivitySummary(auth, community.id, period, anchor)
      .then(setSummary)
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, employee, period, anchor]);

  // The period containing today is as far forward as this can go.
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

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  return (
    <EmployeeShell community={community} active="activity">
      <h2 style={{ marginTop: 0 }}>{t('employee.activity.title')}</h2>
      <p className="tax-section__lede">{t('employee.activity.subtitle')}</p>

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
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={() => shiftAnchor(1)}
                disabled={atOrPastCurrentPeriod}
                title={atOrPastCurrentPeriod ? t('employee.timesheets.noFuturePeriods') : ''}>&rarr;</button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={() => setAnchor(new Date().toISOString().slice(0, 10))}>
          {t('employee.timesheets.today')}
        </button>
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      {!summary ? <p>{t('loading')}</p>
        : summary.rows.length === 0 ? <p style={{ color: 'var(--tax-muted)' }}>{t('employee.activity.empty')}</p>
        : <>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>
              {t('employee.activity.teamTotal')}: {formatMinutes(summary.totalMinutes)}
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {summary.rows.map(row => (
                <ActivityEmployeeRow key={row.employeeId} row={row} t={t} />
              ))}
            </div>
          </>}
    </EmployeeShell>
  );
}
