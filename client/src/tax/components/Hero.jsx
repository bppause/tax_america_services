import { useT } from '../i18n';
import { useCalendlyPopup } from './CalendlySection';
import { useLandingCopy } from '../lib/landingCopy';

export default function Hero({ community }) {
  const { locale, t } = useT();
  const { pick } = useLandingCopy();
  const tagline = (locale === 'es'
    ? (community?.tagline || community?.tagline_en)
    : (community?.tagline_en || community?.tagline)
  ) || t('hero.tagline_fallback');

  // When the practice has a Calendly URL set, the primary hero CTA
  // opens the popup widget directly — fastest path to a booked
  // consultation. Without a URL, fall back to the lead-form anchor
  // so the button still has somewhere to land.
  const { open: openCalendly, available: calendlyAvailable } =
    useCalendlyPopup(community?.calendly_url, locale);

  const primaryLabel = calendlyAvailable
    ? pick('hero.cta_book')
    : pick('hero.cta_primary');

  return (
    <section className="tax-hero" id="top">
      <div className="tax-container">
        <h1>{tagline}</h1>
        <p>{pick('hero.subtitle')}</p>
        <div className="tax-hero__ctas">
          {calendlyAvailable ? (
            <button type="button" className="tax-btn tax-btn--primary"
                    onClick={openCalendly}>
              {primaryLabel}
            </button>
          ) : (
            <a className="tax-btn tax-btn--primary" href="#contact">{primaryLabel}</a>
          )}
          <a className="tax-btn tax-btn--ghost" href="#services">{pick('hero.cta_secondary')}</a>
        </div>
      </div>
    </section>
  );
}
