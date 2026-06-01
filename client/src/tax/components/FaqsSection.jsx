import { useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';
import VideoEmbed from './VideoEmbed';
import { useLandingCopy } from '../lib/landingCopy';

// Public FAQ section on the landing page. Defaults to a preview (top 3
// across all relationship types) with a "See all FAQs" link to a
// dedicated index page. Pass `mode="full"` to render every entry
// grouped by relationship type — that's what /tax/:slug/faqs uses.
//
// New props:
//   onOpenChat  — callback to open the AI chat widget (optional)
//   community   — full community object, used for branding (optional)
export default function FaqsSection({ communitySlug, mode = 'preview', max = 3, onOpenChat, community }) {
  const { locale, t } = useT();
  const { pick } = useLandingCopy();
  const [groups, setGroups] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  // Debounced search term used for logging (800ms after user stops typing)
  const searchDebounceRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityFaqs(communitySlug)
      .then(d => { if (!cancelled) setGroups(d.groups || []); })
      .catch(() => { if (!cancelled) setGroups([]); });
    return () => { cancelled = true; };
  }, [communitySlug]);

  // Debounced logging of FAQ searches
  const handleSearchChange = (value) => {
    setSearchTerm(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (value.trim()) {
      searchDebounceRef.current = setTimeout(() => {
        taxApi.logChatInteraction(communitySlug, {
          kind: 'faq_search',
          query: value.trim(),
          locale,
        }).catch(() => {});
      }, 800);
    }
  };

  if (groups === null) return null;
  const populated = groups.filter(g => g.faqs && g.faqs.length > 0);
  if (populated.length === 0) return null;

  // Apply search filter across all groups
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const isSearching = normalizedSearch.length > 0;

  let displayGroups;
  let truncated = false;

  if (isSearching) {
    // Search mode: show all matching FAQs across all groups, no cap
    displayGroups = populated.map(g => ({
      ...g,
      faqs: g.faqs.filter(faq => {
        const q = (pickI18n(faq.question_i18n, locale).value || '').toLowerCase();
        const a = (pickI18n(faq.answer_i18n, locale).value || '').toLowerCase();
        return q.includes(normalizedSearch) || a.includes(normalizedSearch);
      }),
    })).filter(g => g.faqs.length > 0);
  } else if (mode === 'preview') {
    let remaining = max;
    displayGroups = [];
    for (const g of populated) {
      if (remaining <= 0) { truncated = true; break; }
      const slice = g.faqs.slice(0, remaining);
      remaining -= slice.length;
      displayGroups.push({ ...g, faqs: slice });
    }
    const totalFaqs = populated.reduce((acc, g) => acc + g.faqs.length, 0);
    truncated = truncated || totalFaqs > max;
  } else {
    displayGroups = populated;
  }

  const noSearchResults = isSearching && displayGroups.length === 0;

  return (
    <section className="tax-section" id="faqs" style={{ background: 'var(--tax-bg-alt)' }}>
      <div className="tax-container">
        <h2>{pick('landing.faqs.heading')}</h2>
        <p className="tax-section__lede">{pick('landing.faqs.subheading')}</p>

        {/* Topic chips row (preview mode only, when not searching) */}
        {mode === 'preview' && !isSearching && populated.length > 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, marginBottom: 4 }}>
            {populated.map(g => {
              const name = pickI18n(g.type.name_i18n, locale).value || g.type.slug;
              const typeSlug = g.type.slug || g.type.id;
              return (
                <a
                  key={g.type.id}
                  href={`/tax/${communitySlug}/faqs#type-${typeSlug}`}
                  style={{
                    padding: '5px 14px', borderRadius: 20, fontSize: 13,
                    background: 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)',
                    color: 'var(--tax-brand-primary)',
                    border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 25%, #fff)',
                    textDecoration: 'none', fontWeight: 600,
                    transition: 'background .12s',
                  }}
                >
                  {name}
                </a>
              );
            })}
          </div>
        )}

        {/* Search bar */}
        <div style={{ position: 'relative', marginTop: 14, marginBottom: 4 }}>
          <input
            type="search"
            value={searchTerm}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder={t('faqs.search.placeholder')}
            aria-label={t('faqs.search.placeholder')}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '10px 40px 10px 14px',
              border: '1px solid var(--tax-border)', borderRadius: 8,
              font: 'inherit', fontSize: 15, background: '#fff',
            }}
          />
          <span aria-hidden="true" style={{
            position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
            fontSize: 17, color: 'var(--tax-muted)', pointerEvents: 'none',
          }}>
            &#x1F50D;
          </span>
        </div>

        {/* AI nudge banner (shown when not searching) */}
        {!isSearching && onOpenChat && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, padding: '10px 14px', marginTop: 10, marginBottom: 4,
            background: 'color-mix(in srgb, var(--tax-brand-primary) 7%, #fff)',
            border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 18%, #fff)',
            borderRadius: 8,
          }}>
            <span style={{ fontSize: 14, color: 'var(--tax-text)' }}>
              {t('faqs.aiNudge.text')}
            </span>
            <button type="button" onClick={onOpenChat} style={{
              background: 'var(--tax-brand-primary)', color: '#fff',
              border: 'none', borderRadius: 6, padding: '6px 14px',
              fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              {t('faqs.aiNudge.cta')}
            </button>
          </div>
        )}

        {/* No results fallback */}
        {noSearchResults && (
          <div style={{
            textAlign: 'center', padding: '28px 16px',
            color: 'var(--tax-muted)', fontSize: 15,
          }}>
            <div style={{ marginBottom: 12 }}>{t('faqs.search.noResults')}</div>
            {onOpenChat && (
              <button type="button" onClick={onOpenChat} style={{
                background: 'var(--tax-brand-primary)', color: '#fff',
                border: 'none', borderRadius: 6, padding: '8px 18px',
                fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>
                {t('faqs.search.askAi')}
              </button>
            )}
          </div>
        )}

        {!noSearchResults && (
          <div style={{ display: 'grid', gap: 22, marginTop: 18 }}>
            {displayGroups.map(group => (
              <div key={group.type.id} id={`type-${group.type.slug || group.type.id}`}>
                {(mode === 'full' || isSearching) && (
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
                              }}>&#x25B6; {t('landing.faqs.videoBadge')}</span>
                            )}
                          </span>
                          <span aria-hidden="true" style={{
                            fontSize: 14, color: 'var(--tax-muted)',
                            transform: open ? 'rotate(180deg)' : 'rotate(0)',
                            transition: 'transform .12s ease',
                          }}>&#x25BE;</span>
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
        )}

        {mode === 'preview' && truncated && !isSearching && (
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
