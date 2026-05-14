import { useEffect } from 'react';
import { useT } from '../i18n';

// Inline Calendly embed. Renders only when the community has a
// calendly_url set; the loader script is injected lazily on mount
// and de-duped via a data attribute so HMR / locale-swap re-renders
// don't keep appending <script> tags.
const CALENDLY_SCRIPT_URL = 'https://assets.calendly.com/assets/external/widget.js';

export default function CalendlySection({ url }) {
  const { locale, t } = useT();

  useEffect(() => {
    if (!url || typeof document === 'undefined') return;
    if (document.querySelector('script[data-tax-calendly]')) return;
    const s = document.createElement('script');
    s.src = CALENDLY_SCRIPT_URL;
    s.async = true;
    s.setAttribute('data-tax-calendly', 'true');
    document.body.appendChild(s);
  }, [url]);

  if (!url) return null;

  // Pass the visitor's locale through so Spanish-speaking prospects
  // see the booking form in Spanish where Calendly supports it. The
  // hide_gdpr_banner toggle keeps the embed tidy on EU prospects.
  const dataUrl = (() => {
    try {
      const u = new URL(url);
      u.searchParams.set('hide_gdpr_banner', '1');
      if (locale === 'es' && !u.searchParams.has('locale')) {
        u.searchParams.set('locale', 'es');
      }
      return u.toString();
    } catch { return url; }
  })();

  return (
    <section className="tax-section" id="schedule">
      <div className="tax-container">
        <h2>{t('landing.calendly.heading')}</h2>
        <p className="tax-section__lede">{t('landing.calendly.subheading')}</p>
        <div className="calendly-inline-widget"
             data-url={dataUrl}
             style={{ minWidth: 320, height: 700, marginTop: 16 }} />
      </div>
    </section>
  );
}
