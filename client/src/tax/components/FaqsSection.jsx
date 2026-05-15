import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';
import VideoEmbed from './VideoEmbed';
import { useLandingCopy } from '../lib/landingCopy';

// Public FAQ section on the landing page. Defaults to a preview (top 3
// across all relationship types) with a "See all FAQs" link to a
// dedicated index page. Pass `mode="full"` to render every entry
// grouped by relationship type — that's what /tax/:slug/faqs uses.
export default function FaqsSection({ communitySlug, mode = 'preview', max = 3 }) {
  const { locale, t } = useT();
  const { pick } = useLandingCopy();
  const [groups, setGroups] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityFaqs(communitySlug)
      .then(d => { if (!cancelled) setGroups(d.groups || []); })
      .catch(() => { if (!cancelled) setGroups([]); });
    return () => { cancelled = true; };
  }, [communitySlug]);

  if (groups === null) return null;
  const populated = groups.filter(g => g.faqs && g.faqs.length > 0);
  if (populated.length === 0) return null;

  // Preview mode: flatten across types and cap at `max`. Full mode:
  // render every group with every entry.
  let visibleGroups = populated;
  let truncated = false;
  if (mode === 'preview') {
    let remaining = max;
    visibleGroups = [];
    for (const g of populated) {
      if (remaining <= 0) { truncated = true; break; }
      const slice = g.faqs.slice(0, remaining);
      remaining -= slice.length;
      visibleGroups.push({ ...g, faqs: slice });
    }
    const totalFaqs = populated.reduce((acc, g) => acc + g.faqs.length, 0);
    truncated = truncated || totalFaqs > max;
  }

  return (
    <section className="tax-section" id="faqs" style={{ background: 'var(--tax-bg-alt)' }}>
      <div className="tax-container">
        <h2>{pick('landing.faqs.heading')}</h2>
        <p className="tax-section__lede">{pick('landing.faqs.subheading')}</p>

        <div style={{ display: 'grid', gap: 22, marginTop: 18 }}>
          {visibleGroups.map(group => (
            <div key={group.type.id}>
              {mode === 'full' && (
                <h3 style={{ margin: '0 0 10px', fontSize: 18 }}>
                  {pickI18n(group.type.name_i18n, locale).value || group.type.slug}
                </h3>
              )}
              <div style={{ display: 'grid', gap: 8 }}>
                {group.faqs.map(faq => {
                  const id = `${group.type.id}:${faq.id}`;
                  const open = openId === id;
                  const q = pickI18n(faq.question_i18n, locale).value;
                  const a = pickI18n(faq.answer_i18n, locale).value;
                  return (
                    <div key={id} style={{
                      border: '1px solid var(--tax-border)', borderRadius: 8,
                      background: '#fff', overflow: 'hidden',
                    }}>
                      <button type="button"
                              onClick={() => setOpenId(open ? null : id)}
                              aria-expanded={open}
                              style={{
                                width: '100%', textAlign: 'left',
                                padding: '12px 16px', border: 0, background: 'transparent',
                                cursor: 'pointer', fontSize: 15, fontWeight: 600,
                                display: 'flex', justifyContent: 'space-between', gap: 12,
                              }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          {q}
                          {faq.video_url && (
                            <span style={{
                              marginLeft: 8, padding: '1px 6px', borderRadius: 4,
                              background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                              color: 'var(--tax-brand-primary)',
                              fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
                              verticalAlign: 'middle',
                            }}>▶ {t('landing.faqs.videoBadge')}</span>
                          )}
                        </span>
                        <span aria-hidden="true" style={{
                          fontSize: 14, color: 'var(--tax-muted)',
                          transform: open ? 'rotate(180deg)' : 'rotate(0)',
                          transition: 'transform .12s ease',
                        }}>▾</span>
                      </button>
                      {open && (
                        <div style={{ padding: '0 16px 14px', fontSize: 14, lineHeight: 1.5 }}>
                          {faq.video_url && <VideoEmbed url={faq.video_url} title={q} />}
                          {a && <div style={{ whiteSpace: 'pre-wrap' }}>{a}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {mode === 'preview' && truncated && (
          <div style={{ marginTop: 16 }}>
            <a href={`/tax/${communitySlug}/faqs`}
               className="tax-btn tax-btn--ghost"
               style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
              {t('landing.faqs.viewAll')} →
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
