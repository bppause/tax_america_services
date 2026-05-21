import { useEffect, useMemo, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

const CATEGORY_KEY = {
  getting_started: 'portal.help.cat.gettingStarted',
  documents:       'portal.help.cat.documents',
  messages:        'portal.help.cat.messages',
  filings:         'portal.help.cat.filings',
  profile:         'portal.help.cat.profile',
  notifications:   'portal.help.cat.notifications',
  service:         'portal.help.cat.service',
  admin:           'portal.help.cat.admin',
};

// Practice-side help center. Same two-pane layout as the customer help
// page but no relationship-tailored bucket (employees see all articles
// for their audience).
export default function EmployeeHelp() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [articles, setArticles] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!employee || !community) return;
    taxApi.getEmployeeHelp(auth)
      .then(d => {
        const list = d.articles || [];
        setArticles(list);
        if (list.length && !selectedId) setSelectedId(list[0].id);
      })
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  const grouped = useMemo(() => {
    if (!articles) return null;
    const groups = new Map();
    for (const a of articles) {
      const key = a.category || 'general';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const order = ['getting_started', 'messages', 'notifications', 'profile', 'admin'];
    return order
      .map(cat => ({ category: cat, items: groups.get(cat) || [] }))
      .filter(g => g.items.length > 0);
  }, [articles]);

  const selected = (articles || []).find(a => a.id === selectedId) || null;

  return (
    <EmployeeShell community={community} active="help">
      <h2 style={{ marginTop: 0 }}>{t('employee.help.title')}</h2>
      <p className="tax-section__lede">{t('employee.help.subtitle')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {articles === null ? <p>{t('loading')}</p>
        : articles.length === 0 ? <p style={{ color: 'var(--tax-muted)' }}>{t('portal.help.empty')}</p>
        : <div style={{
            display: 'grid', gap: 24,
            gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)',
            alignItems: 'start',
          }}>
            <aside>
              {grouped.map(g => (
                <div key={g.category} style={{ marginBottom: 16 }}>
                  <div style={{
                    fontSize: 11, textTransform: 'uppercase', letterSpacing: '.7px',
                    color: 'var(--tax-muted)', fontWeight: 700, marginBottom: 6,
                  }}>{t(CATEGORY_KEY[g.category] || 'portal.help.cat.service')}</div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
                    {g.items.map(a => {
                      const active = a.id === selectedId;
                      return (
                        <li key={a.id}>
                          <button type="button" onClick={() => setSelectedId(a.id)}
                                  style={{
                                    width: '100%', textAlign: 'left',
                                    background: active ? 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)' : 'transparent',
                                    border: '1px solid', borderColor: active ? 'color-mix(in srgb, var(--tax-brand-primary) 30%, #fff)' : 'var(--tax-border)',
                                    color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                                    padding: '8px 10px', borderRadius: 6,
                                    fontSize: 13, lineHeight: 1.35, fontWeight: active ? 600 : 500,
                                    cursor: 'pointer',
                                  }}>
                            {pickI18n(a.title_i18n, locale).value}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </aside>

            <article>
              {selected ? (
                <div className="tax-contact-item" style={{ padding: 24 }}>
                  <h3 style={{ marginTop: 0, marginBottom: 12 }}>
                    {pickI18n(selected.title_i18n, locale).value}
                  </h3>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.65 }}>
                    {pickI18n(selected.body_i18n, locale).value}
                  </div>
                </div>
              ) : (
                <p style={{ color: 'var(--tax-muted)' }}>{t('portal.help.pickArticle')}</p>
              )}
            </article>
          </div>}
    </EmployeeShell>
  );
}
