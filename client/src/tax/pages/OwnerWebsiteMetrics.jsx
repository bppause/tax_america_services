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
  if (period === 'day') {
    return start.toLocaleDateString(loc, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
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

const PAGE_LABEL_KEY = {
  landing: 'employee.website.page.landing',
  faqs: 'employee.website.page.faqs',
  articles: 'employee.website.page.articles',
  calendar: 'employee.website.page.calendar',
};

function StatTile({ label, value }) {
  return (
    <div style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: '10px 14px', minWidth: 120 }}>
      <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// Ranked list with a simple proportional bar per row — no charting
// library, same hand-rolled style as the Activity dashboard's
// per-feature breakdown.
function RankedBars({ rows, labelFor, maxValue }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map(r => (
        <div key={r.key} style={{ display: 'grid', gap: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>{labelFor(r)}</span>
            <span style={{ color: 'var(--tax-muted)', fontWeight: 600 }}>{r.views}</span>
          </div>
          <div style={{ height: 6, borderRadius: 999, background: 'var(--tax-bg-alt)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${Math.max(4, (r.views / maxValue) * 100)}%`,
              background: '#1d4ed8', borderRadius: 999,
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const PERIODS = ['day', 'week', 'month', 'quarter', 'year'];

export default function OwnerWebsiteMetrics() {
  const { t, locale } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [period, setPeriod] = useState('day');
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!fbUser || !community || !employee || employee.role !== 'admin') return;
    setSummary(null); setErr('');
    taxApi.adminWebsiteMetricsSummary(auth, community.id, period, anchor)
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
    if (period === 'day') { setAnchor(addDays(anchor, dir)); return; }
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

  const maxPageViews = summary ? Math.max(1, ...summary.pages.map(p => p.views)) : 1;
  const maxReferrerViews = summary ? Math.max(1, ...summary.referrers.map(r => r.views)) : 1;

  return (
    <EmployeeShell community={community} active="website-metrics">
      <h2 style={{ marginTop: 0 }}>{t('employee.website.title')}</h2>
      <p className="tax-section__lede">{t('employee.website.subtitle')}</p>

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
        : summary.totalViews === 0 ? <p style={{ color: 'var(--tax-muted)' }}>{t('employee.website.empty')}</p>
        : <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
              <StatTile label={t('employee.website.totalViews')} value={summary.totalViews} />
              <StatTile label={t('employee.website.uniqueVisitors')} value={summary.uniqueVisitors} />
              <StatTile label={t('employee.website.sessions')} value={summary.sessions} />
            </div>

            <h3 style={{ marginBottom: 8 }}>{t('employee.website.byPage')}</h3>
            <RankedBars
              rows={summary.pages.map(p => ({ key: p.page, views: p.views, page: p.page }))}
              labelFor={r => t(PAGE_LABEL_KEY[r.page] || 'employee.website.page.unknown')}
              maxValue={maxPageViews}
            />

            {summary.referrers.length > 0 && (
              <>
                <h3 style={{ marginTop: 20, marginBottom: 8 }}>{t('employee.website.topReferrers')}</h3>
                <RankedBars
                  rows={summary.referrers.map(r => ({ key: r.host, views: r.views, host: r.host }))}
                  labelFor={r => r.host}
                  maxValue={maxReferrerViews}
                />
              </>
            )}
          </>}
    </EmployeeShell>
  );
}
