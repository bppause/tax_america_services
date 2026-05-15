import { useEffect } from 'react';
import { useT } from '../i18n';

// Compact CTA that opens Calendly's popup widget instead of embedding
// the full scheduler inline. Saves ~500px of vertical space on the
// landing page while keeping the booking flow one click away. The
// widget assets (script + css) are loaded lazily on mount and
// de-duped via data attributes so HMR / locale-swap re-renders don't
// stack copies.
const CALENDLY_SCRIPT_URL = 'https://assets.calendly.com/assets/external/widget.js';
const CALENDLY_STYLE_URL  = 'https://assets.calendly.com/assets/external/widget.css';

export default function CalendlySection({ url }) {
  const { locale, t } = useT();

  useEffect(() => {
    if (!url || typeof document === 'undefined') return;
    if (!document.querySelector('link[data-tax-calendly]')) {
      const link = document.createElement('link');
      link.href = CALENDLY_STYLE_URL;
      link.rel = 'stylesheet';
      link.setAttribute('data-tax-calendly', 'true');
      document.head.appendChild(link);
    }
    if (document.querySelector('script[data-tax-calendly]')) return;
    const s = document.createElement('script');
    s.src = CALENDLY_SCRIPT_URL;
    s.async = true;
    s.setAttribute('data-tax-calendly', 'true');
    document.body.appendChild(s);
  }, [url]);

  if (!url) return null;

  // Forward locale + tidy the embed.
  const popupUrl = (() => {
    try {
      const u = new URL(url);
      u.searchParams.set('hide_gdpr_banner', '1');
      if (locale === 'es' && !u.searchParams.has('locale')) {
        u.searchParams.set('locale', 'es');
      }
      return u.toString();
    } catch { return url; }
  })();

  const open = (e) => {
    e?.preventDefault?.();
    if (typeof window === 'undefined' || !window.Calendly) {
      // Fallback if the script hasn't loaded yet — open in a new tab so
      // the visitor isn't left clicking a dead button.
      window.open(popupUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    window.Calendly.initPopupWidget({ url: popupUrl });
  };

  return (
    <section className="tax-section" id="schedule">
      <div className="tax-container">
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          justifyContent: 'space-between', gap: 16,
          padding: 24, borderRadius: 12,
          border: '1px solid var(--tax-border)', background: '#fff',
        }}>
          <div style={{ minWidth: 240, flex: '1 1 320px' }}>
            <h2 style={{ margin: 0, fontSize: 'clamp(20px, 2.5vw, 26px)' }}>
              {t('landing.calendly.heading')}
            </h2>
            <p style={{ margin: '6px 0 0', color: 'var(--tax-muted)', maxWidth: 520 }}>
              {t('landing.calendly.subheading')}
            </p>
          </div>
          <button type="button" onClick={open}
                  className="tax-btn tax-btn--primary">
            {t('landing.calendly.cta')}
          </button>
        </div>
      </div>
    </section>
  );
}
