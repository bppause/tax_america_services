import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';
import Header from '../components/Header';
import Footer from '../components/Footer';
import ArticlesSection from '../components/ArticlesSection';
import { usePageviewPing } from '../lib/pageviewTracking';

// Dedicated public page that renders every article for the community.
// Reuses ArticlesSection in `mode="full"` so the markup matches the
// landing-page preview.
export default function PublicArticles({ communitySlug }) {
  usePageviewPing(communitySlug, 'articles');
  const { t } = useT();
  const [community, setCommunity] = useState(null);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunity(communitySlug)
      .then(d => { if (!cancelled) setCommunity(d.community || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [communitySlug]);

  const brandStyle = community ? {
    '--tax-brand-primary': community.brand_primary_color || undefined,
    '--tax-brand-secondary': community.brand_secondary_color || undefined,
  } : {};

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
        <ArticlesSection communitySlug={communitySlug} mode="full" />
      </main>
      {community && <Footer community={community} />}
    </div>
  );
}
