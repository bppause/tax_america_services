import { useT } from '../i18n';
import { useCalendlyPopup } from './CalendlySection';

export default function Hero({ community }) {
  const { locale, t } = useT();
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
    ? t('hero.cta_book')
    : t('hero.cta_primary');

  return (
    <section className="tax-hero" id="top">
      <div className="tax-container">
        <h1>{tagline}</h1>
        <p>{t('hero.subtitle')}</p>
        <div className="tax-hero__ctas">
          {calendlyAvailable ? (
            <button type="button" className="tax-btn tax-btn--primary"
                    onClick={openCalendly}>
              {primaryLabel}
            </button>
          ) : (
            <a className="tax-btn tax-btn--primary" href="#contact">{primaryLabel}</a>
          )}
          <a className="tax-btn tax-btn--ghost" href="#services">{t('hero.cta_secondary')}</a>
        </div>
      </div>
    </section>
  );
}
