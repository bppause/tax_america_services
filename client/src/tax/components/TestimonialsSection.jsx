import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';

// Public landing-page testimonials grid. Shows the active set ordered
// by the owner's display_order. Locale-aware: when the visitor is on
// es, we surface es-tagged reviews first but fall back to en when
// nothing else is available so a fresh community still has content.
//
// The section render-skips itself when there are zero rows so a brand-
// new tenant doesn't show an awkward "no reviews yet" placeholder.
//
// `rows` can be passed in by the parent — Landing fetches once and
// drives both this section and the Reviews nav link off the same data.
// When omitted we fall back to self-fetching for backward compat.
// `displayLimit` is the owner-configured cap (default 9, range 1–30);
// when self-fetching we read it from the same API response.
export default function TestimonialsSection({ communitySlug, rows: rowsProp, displayLimit: limitProp }) {
  const { locale, t } = useT();
  const [rowsState, setRowsState] = useState(null);
  const [limitState, setLimitState] = useState(null);
  useEffect(() => {
    if (rowsProp !== undefined) return;
    let cancelled = false;
    taxApi.getCommunityTestimonials(communitySlug)
      .then(d => {
        if (cancelled) return;
        setRowsState(d.testimonials || []);
        setLimitState(d.displayLimit || null);
      })
      .catch(() => !cancelled && setRowsState([]));
    return () => { cancelled = true; };
  }, [communitySlug, rowsProp]);
  const rows = rowsProp !== undefined ? rowsProp : rowsState;
  const limit = Math.max(1, Math.min(30,
    Number(limitProp != null ? limitProp : limitState) || 9));

  if (!rows || rows.length === 0) return null;

  // Prefer locale-matched reviews; if zero match, fall through to any.
  const matched = rows.filter(r => r.locale === locale);
  const display = (matched.length > 0 ? matched : rows).slice(0, limit);

  return (
    <section className=”tax-section” id=”testimonials”>
      <div className=”tax-container”>
        <h2 style={{ marginBottom: 6 }}>{t('testimonials.heading')}</h2>
        <p className=”tax-section__lede” style={{ marginTop: 0 }}>{t('testimonials.subheading')}</p>
        <div style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          marginTop: 24,
        }}>
          {display.map(r => (
            <Card key={r.id} row={r} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Stars({ rating }) {
  return (
    <div style={{ display: 'flex', gap: 2 }} aria-label={`${rating} out of 5 stars`}>
      {[1,2,3,4,5].map(i => (
        <svg key={i} width=”16” height=”16” viewBox=”0 0 20 20” fill={i <= rating ? '#f59e0b' : '#e2e8f0'}>
          <path d=”M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z”/>
        </svg>
      ))}
    </div>
  );
}

function Card({ row }) {
  return (
    <article style={{
      padding: '20px 22px', background: '#fff',
      border: '1px solid #e2e8f0', borderRadius: 14,
      boxShadow: '0 1px 4px rgba(15,23,42,.05)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <Stars rating={row.rating || 5} />
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#374151', flexGrow: 1 }}>
        <span style={{ color: '#d97706', fontSize: 20, lineHeight: 0, verticalAlign: '-4px', marginRight: 3 }}>{'“'}</span>{row.body}<span style={{ color: '#d97706', fontSize: 20, lineHeight: 0, verticalAlign: '-4px', marginLeft: 3 }}>{'”'}</span>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 'auto' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{row.author_name}</div>
          {row.author_role && (
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 1 }}>{row.author_role}</div>
          )}
        </div>
        {row.source === 'google' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <svg width=”14” height=”14” viewBox=”0 0 24 24” fill=”none” xmlns=”http://www.w3.org/2000/svg”>
              <path d=”M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z” fill=”#4285F4”/>
              <path d=”M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z” fill=”#34A853”/>
              <path d=”M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z” fill=”#FBBC05”/>
              <path d=”M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z” fill=”#EA4335”/>
            </svg>
            <span style={{ fontSize: 11, color: '#5f6368', fontWeight: 600 }}>Google</span>
          </div>
        )}
      </div>
    </article>
  );
}
