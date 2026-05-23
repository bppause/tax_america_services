import { useEffect, useMemo, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';
import Header from '../components/Header';
import Footer from '../components/Footer';

// Public tax calendar — lists every upcoming deadline for the
// community with filter chips by entity type and jurisdiction.
// Each row shows the next-occurrence date (computed from month+day
// for annual recurrences, today's year if the date hasn't passed
// yet, otherwise next year) so a single seed row works year over
// year.
export default function PublicCalendar({ communitySlug }) {
  const { locale, t } = useT();
  const [community, setCommunity] = useState(null);
  const [deadlines, setDeadlines] = useState([]);
  const [err, setErr] = useState('');
  const [entityFilter, setEntityFilter] = useState('all'); // 'all'|'individual'|'business'
  const [jurisdiction, setJurisdiction] = useState('all');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      taxApi.getCommunity(communitySlug),
      taxApi.getCommunityDeadlines(communitySlug),
    ]).then(([c, d]) => {
      if (cancelled) return;
      setCommunity(c.community || null);
      setDeadlines(d.deadlines || []);
    }).catch(e => !cancelled && setErr(e?.message || ''));
    return () => { cancelled = true; };
  }, [communitySlug]);

  // Compute "next occurrence" for each deadline. Annual: this year's
  // (month, day) if still in the future, else next year. One-time:
  // its date verbatim (skip if past).
  const today = useMemo(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }, []);
  const rows = useMemo(() => {
    const computed = (deadlines || []).map(d => {
      let next = null;
      if (d.recurrence === 'annual' && d.month && d.day) {
        const tryYear = (year) => new Date(Date.UTC(year, d.month - 1, d.day));
        let cand = tryYear(today.getUTCFullYear());
        if (cand < today) cand = tryYear(today.getUTCFullYear() + 1);
        next = cand;
      } else if (d.recurrence === 'one_time' && d.date) {
        const cand = new Date(`${d.date}T00:00:00Z`);
        next = cand >= today ? cand : null;
      }
      return next ? { ...d, _nextIso: next.toISOString().slice(0, 10), _next: next } : null;
    }).filter(Boolean);

    computed.sort((a, b) => a._nextIso.localeCompare(b._nextIso));
    return computed;
  }, [deadlines, today]);

  // Distinct jurisdiction set in the data (always include 'federal'
  // so the chip exists even on a fresh community).
  const jurisdictions = useMemo(() => {
    const set = new Set(['federal']);
    for (const d of deadlines) if (d.jurisdiction) set.add(d.jurisdiction);
    return Array.from(set).sort();
  }, [deadlines]);

  const filtered = rows.filter(r => {
    if (entityFilter !== 'all') {
      const types = Array.isArray(r.entity_types) ? r.entity_types : [];
      if (!types.includes(entityFilter)) return false;
    }
    if (jurisdiction !== 'all' && r.jurisdiction !== jurisdiction) return false;
    return true;
  });

  const brandStyle = community ? {
    '--tax-brand-primary': community.brand_primary_color || undefined,
    '--tax-brand-secondary': community.brand_secondary_color || undefined,
  } : {};

  // Group by month for the rendered list — a long flat list reads
  // worse than a tidy "October" / "November" stack.
  const grouped = useMemo(() => {
    const out = [];
    let cur = null;
    for (const r of filtered) {
      const ym = r._nextIso.slice(0, 7); // YYYY-MM
      if (!cur || cur.ym !== ym) {
        cur = { ym, label: monthLabel(r._next, locale), rows: [] };
        out.push(cur);
      }
      cur.rows.push(r);
    }
    return out;
  }, [filtered, locale]);

  return (
    <div className="tax-app" style={brandStyle}>
      {community && <Header community={community} />}
      <main>
        <div className="tax-container" style={{ paddingTop: 24, paddingBottom: 8 }}>
          <a href={`/tax/${communitySlug}`}
             style={{ fontSize: 14, color: 'var(--tax-muted)' }}>
            ← {t('landing.back')}
          </a>
        </div>
        <section className="tax-section">
          <div className="tax-container">
            <h1 style={{ margin: '0 0 4px' }}>{t('calendar.title')}</h1>
            <p className="tax-section__lede">{t('calendar.subtitle')}</p>

            {err && <div className="tax-msg tax-msg--error">{err}</div>}

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['all','individual','business'].map(k => (
                  <button key={k} type="button" onClick={() => setEntityFilter(k)}
                          style={chipStyle(entityFilter === k)}>
                    {t(`calendar.filter.entity.${k}`)}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--tax-muted)', marginRight: 4 }}>
                  {t('calendar.filter.jurisdictionLabel')}:
                </span>
                <button type="button" onClick={() => setJurisdiction('all')}
                        style={chipStyle(jurisdiction === 'all')}>
                  {t('calendar.filter.allJurisdictions')}
                </button>
                {jurisdictions.map(j => (
                  <button key={j} type="button" onClick={() => setJurisdiction(j)}
                          style={chipStyle(jurisdiction === j)}>
                    {j === 'federal' ? t('calendar.jurisdiction.federal') : j}
                  </button>
                ))}
              </div>
            </div>

            {filtered.length === 0 && (
              <p style={{ color: 'var(--tax-muted)' }}>{t('calendar.empty')}</p>
            )}

            {grouped.map(g => (
              <section key={g.ym} style={{ marginBottom: 24 }}>
                <h3 style={{
                  margin: '0 0 8px', fontSize: 14, textTransform: 'uppercase',
                  letterSpacing: '.06em', color: 'var(--tax-muted)',
                }}>{g.label}</h3>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {g.rows.map(r => (
                    <DeadlineCard key={r.id} row={r} locale={locale} t={t}
                                  communitySlug={communitySlug} />
                  ))}
                </ul>
              </section>
            ))}

            <p style={{ marginTop: 24, fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('calendar.disclaimer')}
            </p>
          </div>
        </section>
      </main>
      {community && <Footer community={community} />}
    </div>
  );
}

function DeadlineCard({ row, locale, t, communitySlug }) {
  const title = pickI18n(row.title_i18n, locale).value || row.slug;
  const desc  = pickI18n(row.description_i18n, locale).value;
  const dayIso = row._nextIso;
  const dayD = row._next;
  const dayLabel = dayD.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES',
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const today = new Date();
  const diff = Math.round((dayD.getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
  const urgency = diff <= 14 ? 'urgent' : diff <= 45 ? 'soon' : 'upcoming';
  const tone = urgency === 'urgent' ? { bg: '#fee2e2', fg: '#991b1b' }
            : urgency === 'soon'   ? { bg: '#fef3c7', fg: '#92400e' }
            :                        { bg: '#dbeafe', fg: '#1e40af' };
  const types = Array.isArray(row.entity_types) ? row.entity_types : [];
  return (
    <li style={{
      display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 12,
      padding: '12px 14px', borderRadius: 8,
      background: '#fff', border: '1px solid var(--tax-border)',
      alignItems: 'center',
    }}>
      <div style={{
        textAlign: 'center', padding: 8, borderRadius: 6,
        background: tone.bg, color: tone.fg, fontWeight: 700,
      }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {dayD.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', { month: 'short', timeZone: 'UTC' })}
        </div>
        <div style={{ fontSize: 22 }}>{dayD.getUTCDate()}</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {desc && (
          <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>
            {desc}
          </div>
        )}
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {types.map(et => (
            <span key={et} style={tagStyle()}>{t(`calendar.entity.${et}`)}</span>
          ))}
          <span style={tagStyle('#e0e7ff', '#3730a3')}>
            {row.jurisdiction === 'federal' ? t('calendar.jurisdiction.federal') : row.jurisdiction}
          </span>
          {row.product_slug && (
            <a href={`/tax/${communitySlug}#service-${row.product_slug}`}
               style={{ ...tagStyle('#dcfce7', '#166534'), textDecoration: 'none' }}>
              ↗ {t('calendar.viewService')}
            </a>
          )}
        </div>
      </div>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--tax-muted)',
        textAlign: 'right', whiteSpace: 'nowrap',
      }}>
        {diff <= 0
          ? t('calendar.today')
          : t('calendar.daysAway', { n: diff })}
        <br />
        <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>{dayLabel}</span>
      </div>
    </li>
  );
}

function chipStyle(active) {
  return {
    padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
    border: `1px solid ${active ? 'var(--tax-brand-primary)' : 'var(--tax-border)'}`,
    background: active ? 'var(--tax-brand-primary)' : '#fff',
    color: active ? '#fff' : 'var(--tax-text)', cursor: 'pointer',
  };
}
function tagStyle(bg = 'var(--tax-bg-alt)', fg = 'var(--tax-muted)') {
  return {
    padding: '1px 8px', borderRadius: 999, background: bg, color: fg,
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
  };
}
function monthLabel(d, locale) {
  return d.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES',
    { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
