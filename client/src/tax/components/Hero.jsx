import { useT } from '../i18n';
import { useBookingLink } from './CalendlySection';
import { useLandingCopy } from '../lib/landingCopy';

export default function Hero({ community }) {
  const { locale, t } = useT();
  const { pick } = useLandingCopy();
  const tagline = (locale === 'es'
    ? (community?.tagline || community?.tagline_en)
    : (community?.tagline_en || community?.tagline)
  ) || t('hero.tagline_fallback');

  // When the practice has a booking link set, the primary hero CTA
  // opens it directly — fastest path to a booked consultation. Without
  // a URL, fall back to the lead-form anchor so the button still has
  // somewhere to land.
  const { open: openBooking, available: bookingAvailable } =
    useBookingLink(community?.calendly_url, locale);

  const primaryLabel = bookingAvailable
    ? pick('hero.cta_book')
    : pick('hero.cta_primary');

  return (
    <section className="tax-hero" id="top">
      <div className="tax-container">
        <h1>{tagline}</h1>
        <p>{pick('hero.subtitle')}</p>
        <div className="tax-hero__ctas">
          {bookingAvailable ? (
            <button type="button" className="tax-btn tax-btn--primary"
                    onClick={openBooking}>
              {primaryLabel}
            </button>
          ) : (
            <a className="tax-btn tax-btn--primary" href="#contact">{primaryLabel}</a>
          )}
          <a className="tax-btn tax-btn--ghost" href="#services">{pick('hero.cta_secondary')}</a>
        </div>
        {community?.tax_ai_features_enabled && (
          <p style={{ marginTop: 16, fontSize: 14, opacity: .8 }}>
            {locale === 'es'
              ? '🤖 ¿Tienes preguntas? Nuestro asistente de IA responde al instante — haz clic en cualquier servicio o usa el botón de chat.'
              : '🤖 Have questions? Our AI assistant answers instantly — click any service or use the chat button.'}
          </p>
        )}
      </div>
    </section>
  );
}
