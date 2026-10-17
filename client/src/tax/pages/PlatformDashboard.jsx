import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useTaxPlatformAuth } from '../auth/PlatformAuthProvider';
import { taxApi } from '../api';
import LocaleSwitcher from '../components/LocaleSwitcher';

// Platform admin dashboard — top-level view across every tax community
// on this deployment. "Open" on a community card drops the platform admin
// into that community's regular /employee view (where they appear as the
// admin email; for cross-community impersonation, use the Impersonation
// flow from within that community's UI).
export default function PlatformDashboard() {
  const { t } = useT();
  const { email, signOut, switchAccount } = useTaxPlatformAuth();
  const auth = { uid: '', email };

  const [communities, setCommunities] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!email) return;
    taxApi.platformListCommunities(auth)
      .then(d => setCommunities(d.communities || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  return (
    <div className="tax-app">
      <header className="tax-header" style={{ borderBottom: '2px solid var(--tax-brand-primary)' }}>
        <div className="tax-container tax-header__row">
          <div className="tax-brand">
            <span className="tax-brand__mark" style={{ background: '#1d3a6d' }}>TX</span>
            <span style={{
              marginLeft: 10, padding: '2px 8px', borderRadius: 4,
              background: '#1d3a6d', color: '#fff',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
            }}>{t('platform.badge')}</span>
          </div>
          <nav className="tax-nav">
            <LocaleSwitcher />
            <span style={{ color: 'var(--tax-muted)', fontSize: 13 }}>{email}</span>
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={switchAccount}
                    title={t('employee.switchAccount.hint')}>
              {t('employee.switchAccount')}
            </button>
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={signOut}>
              {t('portal.signout')}
            </button>
          </nav>
        </div>
      </header>

      <div className="tax-container" style={{ paddingTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('platform.dashboard.title')}</h2>
          <a href="/tax/_platform/communities/new" className="tax-btn tax-btn--primary tax-btn--sm">
            {t('platform.dashboard.newCommunity')}
          </a>
        </div>
        <p className="tax-section__lede">{t('platform.dashboard.subtitle')}</p>

        {err && <div className="tax-msg tax-msg--error">{err}</div>}

        {communities === null ? <p>{t('loading')}</p>
          : communities.length === 0
            ? <p style={{ color: 'var(--tax-muted)' }}>{t('platform.dashboard.empty')}</p>
            : <div style={{ display: 'grid', gap: 12 }}>
                {communities.map(c => <CommunityCard key={c.id} community={c} t={t} />)}
              </div>}
      </div>
    </div>
  );
}

function CommunityCard({ community: c, t }) {
  const s = c.stats || {};
  return (
    <div className="tax-contact-item" style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>{c.name}</div>
          <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2, fontFamily: 'monospace' }}>
            {c.id}
          </div>
          <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 4 }}>
            {c.contact_email}{c.phone ? ` • ${c.phone}` : ''}
            {' • '}{c.default_locale === 'en' ? 'EN' : 'ES'}
            {c.created_at && ` • ${t('platform.dashboard.createdAt')} ${new Date(c.created_at).toLocaleDateString()}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <a href={`/tax/${encodeURIComponent(c.id)}/employee`} target="_blank" rel="noopener noreferrer"
             className="tax-btn tax-btn--primary tax-btn--sm">
            {t('platform.dashboard.openEmployee')}
          </a>
          <a href={`/tax/${encodeURIComponent(c.id)}/portal`} target="_blank" rel="noopener noreferrer"
             className="tax-btn tax-btn--ghost tax-btn--sm" style={{ color: 'var(--tax-text)' }}>
            {t('platform.dashboard.openPortal')}
          </a>
        </div>
      </div>

      <div style={{
        display: 'grid', gap: 4, marginTop: 12, fontSize: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
      }}>
        <StatCell label={t('platform.dashboard.stat.customers')} value={s.customers} />
        <StatCell label={t('platform.dashboard.stat.employees')} value={s.employees} />
        <StatCell label={t('platform.dashboard.stat.openLeads')} value={s.openLeads} />
        <StatCell label={t('platform.dashboard.stat.documents')} value={s.documents} />
        <StatCell label={t('platform.dashboard.stat.openThreads')} value={s.openThreads} />
      </div>
    </div>
  );
}

function StatCell({ label, value }) {
  return (
    <div style={{
      background: 'var(--tax-bg-alt)', padding: '8px 10px', borderRadius: 6,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value ?? 0}</div>
      <div style={{ fontSize: 11, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
    </div>
  );
}
