import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';
import Header from '../components/Header';
import Footer from '../components/Footer';
import FaqsSection from '../components/FaqsSection';
import { usePageviewPing } from '../lib/pageviewTracking';

// Dedicated public page that renders every FAQ for the community,
// grouped by relationship type. Reuses FaqsSection in `mode="full"`
// so the markup stays consistent with the landing-page preview.
export default function PublicFaqs({ communitySlug }) {
  usePageviewPing(communitySlug, 'faqs');
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
        <FaqsSection communitySlug={communitySlug} mode="full" />
      </main>
      {community && <Footer community={community} />}
    </div>
  );
}
