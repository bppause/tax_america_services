import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';
import VideoEmbed from './VideoEmbed';
import { useLandingCopy } from '../lib/landingCopy';

// Public articles section on the landing page. Defaults to a preview
// (top 3) with a "Read all articles" link to a dedicated index page.
// Pass `mode="full"` to render every article — that's what
// /tax/:slug/articles uses.
export default function ArticlesSection({ communitySlug, mode = 'preview', max = 3 }) {
  const { locale, t } = useT();
  const { pick } = useLandingCopy();
  const [articles, setArticles] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityArticles(communitySlug)
      .then(d => { if (!cancelled) setArticles(d.articles || []); })
      .catch(() => { if (!cancelled) setArticles([]); });
    return () => { cancelled = true; };
  }, [communitySlug]);

  if (articles === null) return null;
  if (!articles.length) return null;

  const visible = mode === 'preview' ? articles.slice(0, max) : articles;
  const truncated = mode === 'preview' && articles.length > max;

  return (
    <section className="tax-section" id="articles">
      <div className="tax-container">
        <h2>{pick('landing.articles.heading')}</h2>
        <p className="tax-section__lede">{pick('landing.articles.subheading')}</p>

        <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
          {visible.map(a => {
            const title = pickI18n(a.title_i18n, locale).value;
            const body = pickI18n(a.body_i18n, locale).value;
            const open = openId === a.id;
            const preview = body ? (body.length > 240 ? `${body.slice(0, 240)}…` : body) : '';
            return (
              <article key={a.id} style={{
                border: '1px solid var(--tax-border)', borderRadius: 10,
                background: 'var(--tax-bg)', padding: 18,
              }}>
                <h3 style={{ margin: 0, fontSize: 18 }}>
                  {title}
                  {a.video_url && (
                    <span style={{
                      marginLeft: 8, padding: '1px 6px', borderRadius: 4,
                      background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                      color: 'var(--tax-brand-primary)',
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
                      verticalAlign: 'middle',
                    }}>▶ {t('landing.articles.videoBadge')}</span>
                  )}
                </h3>
                {a.category && (
                  <div style={{
                    marginTop: 4, fontSize: 11, fontWeight: 700,
                    color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.05em',
                  }}>
                    {t(`landing.articles.cat.${a.category}`, { _: a.category })}
                  </div>
                )}
                {open && a.video_url && <div style={{ marginTop: 10 }}><VideoEmbed url={a.video_url} title={title} /></div>}
                <div style={{ marginTop: 10, fontSize: 15, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {open ? body.split(/\n{2,}/).map((para, i) => (
                    <p key={i} style={{ margin: i === 0 ? 0 : '10px 0 0' }}>{para}</p>
                  )) : preview}
                </div>
                {(body && body.length > 240) && (
                  <button type="button"
                          onClick={() => setOpenId(open ? null : a.id)}
                          aria-expanded={open}
                          style={{
                            marginTop: 8, padding: '4px 0',
                            border: 0, background: 'transparent',
                            color: 'var(--tax-brand-primary)', fontWeight: 600, fontSize: 13,
                            cursor: 'pointer',
                          }}>
                    {open ? t('landing.articles.collapse') : t('landing.articles.expand')}
                  </button>
                )}
              </article>
            );
          })}
        </div>

        {truncated && (
          <div style={{ marginTop: 16 }}>
            <a href={`/tax/${communitySlug}/articles`}
               className="tax-btn tax-btn--ghost"
               style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
              {t('landing.articles.viewAll')} →
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
