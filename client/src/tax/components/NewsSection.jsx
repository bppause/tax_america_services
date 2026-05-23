import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';
import VideoEmbed from './VideoEmbed';

// Public landing-page News section. Replaces the legacy ArticlesSection.
//
// Hits /community/:slug/news and renders up to displayLimit cards
// (owner-configurable 1-20, default 5). Each card shows headline,
// topic tag, source link, dateline, and an expand-for-body toggle.
// Optional video (URL embed or uploaded MP4) is shown inline when
// the card is open.
//
// The section render-skips when there are zero rows so a fresh tenant
// or a misconfigured API key doesn't show an empty section.
//
// Parent can pass `articles` + `displayLimit` to avoid a duplicate fetch
// (Landing does this so the Reviews-style nav-visibility pattern works).
export default function NewsSection({
  communitySlug,
  articles: articlesProp,
  displayLimit: limitProp,
}) {
  const { locale, t } = useT();
  const [state, setState] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (articlesProp !== undefined) return;
    let cancelled = false;
    taxApi.getCommunityNews(communitySlug)
      .then(d => !cancelled && setState({ articles: d.articles || [], limit: d.displayLimit || 5 }))
      .catch(() => !cancelled && setState({ articles: [], limit: 5 }));
    return () => { cancelled = true; };
  }, [communitySlug, articlesProp]);

  const articles = articlesProp !== undefined ? articlesProp : (state?.articles || null);
  const limit = Math.max(1, Math.min(20,
    Number(limitProp != null ? limitProp : state?.limit) || 5));

  if (articles === null) return null;
  if (!articles.length) return null;

  const visible = articles.slice(0, limit);

  return (
    <section className="tax-section" id="news">
      <div className="tax-container">
        <h2>{t('landing.news.heading')}</h2>
        <p className="tax-section__lede">{t('landing.news.subheading')}</p>

        <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
          {visible.map(a => {
            const title = pickI18n(a.title_i18n, locale).value;
            const summary = pickI18n(a.summary_i18n, locale).value;
            const body = pickI18n(a.body_i18n, locale).value;
            const open = openId === a.id;
            const hasMore = !!(body && body.trim().length > 0);
            const published = a.published_at ? fmtDate(a.published_at, locale) : '';
            return (
              <article key={a.id} style={{
                border: '1px solid var(--tax-border)', borderRadius: 10,
                background: 'var(--tax-bg)', padding: 18,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                  {a.topic && (
                    <span style={{
                      padding: '1px 8px', borderRadius: 999,
                      background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                      color: 'var(--tax-brand-primary)',
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
                    }}>{a.topic}</span>
                  )}
                  {published && (
                    <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>{published}</span>
                  )}
                  {(a.video_url || a.video_storage_path) && (
                    <span style={{
                      padding: '1px 6px', borderRadius: 4,
                      background: '#fee2e2', color: '#991b1b',
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
                    }}>▶ {t('landing.news.videoBadge')}</span>
                  )}
                </div>
                <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
                {summary && (
                  <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: 'var(--tax-text)' }}>
                    {summary}
                  </p>
                )}
                {open && (a.video_url || a.video_storage_path) && (
                  <div style={{ marginTop: 10 }}>
                    <VideoEmbed url={a.video_url || a.video_storage_path} title={title} />
                  </div>
                )}
                {open && body && (
                  <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                    {body.split(/\n{2,}/).map((para, i) => (
                      <p key={i} style={{ margin: i === 0 ? 0 : '10px 0 0' }}>{para}</p>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  {hasMore && (
                    <button type="button"
                            onClick={() => setOpenId(open ? null : a.id)}
                            aria-expanded={open}
                            style={{
                              padding: '4px 0', border: 0, background: 'transparent',
                              color: 'var(--tax-brand-primary)', fontWeight: 600, fontSize: 13,
                              cursor: 'pointer',
                            }}>
                      {open ? t('landing.news.collapse') : t('landing.news.expand')}
                    </button>
                  )}
                  {a.source_url && (
                    <a href={a.source_url} target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                      {t('landing.news.sourceLabel')}: {a.source_name || hostnameOf(a.source_url)} ↗
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function fmtDate(iso, locale) {
  try { return new Date(iso).toLocaleDateString(locale === 'es' ? 'es' : 'en', {
    year: 'numeric', month: 'short', day: 'numeric',
  }); } catch { return iso; }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
