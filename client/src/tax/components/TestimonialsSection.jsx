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
    <section className="tax-section" id="testimonials">
      <div className="tax-container">
        <h2>{t('testimonials.heading')}</h2>
        <p className="tax-section__lede">{t('testimonials.subheading')}</p>
        <div style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          marginTop: 16,
        }}>
          {display.map(r => (
            <Card key={r.id} row={r} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Card({ row }) {
  const stars = '★'.repeat(row.rating) + '☆'.repeat(5 - row.rating);
  return (
    <article style={{
      padding: 18, background: '#fff',
      border: '1px solid var(--tax-border)', borderRadius: 12,
      display: 'grid', gap: 10,
    }}>
      <div style={{ color: '#d97706', fontSize: 16, letterSpacing: 1 }} aria-label={`Rating ${row.rating} of 5`}>
        {stars}
      </div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.45, color: 'var(--tax-text)' }}>
        “{row.body}”
      </p>
      <div style={{ marginTop: 'auto' }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{row.author_name}</div>
        {row.author_role && (
          <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{row.author_role}</div>
        )}
        {row.source === 'google' && (
          <div style={{
            display: 'inline-block', marginTop: 6,
            padding: '1px 6px', borderRadius: 999,
            background: '#e0e7ff', color: '#3730a3',
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.04em',
          }}>Google</div>
        )}
      </div>
    </article>
  );
}
