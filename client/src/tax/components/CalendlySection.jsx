import { useEffect } from 'react';

// Booking-link widget plumbing. When the configured URL is a Calendly
// link we load Calendly's popup script/CSS once per page (de-duped via
// data attributes) so the click opens an inline overlay instead of
// leaving the site. Any other provider (e.g. Titan's scheduler) has no
// popup API of its own, so we just open it in a new tab.
const CALENDLY_SCRIPT_URL = 'https://assets.calendly.com/assets/external/widget.js';
const CALENDLY_STYLE_URL  = 'https://assets.calendly.com/assets/external/widget.css';

function isCalendlyUrl(url) {
  try { return /^calendly\.com$|\.calendly\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
}

function ensureCalendlyAssetsLoaded() {
  if (typeof document === 'undefined') return;
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
}

// Forwards the visitor's locale + tidies the embed (hide_gdpr_banner).
// Returns '' when the input URL is blank so callers can short-circuit.
function buildCalendlyPopupUrl(url, locale) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.searchParams.set('hide_gdpr_banner', '1');
    if (locale === 'es' && !u.searchParams.has('locale')) {
      u.searchParams.set('locale', 'es');
    }
    return u.toString();
  } catch { return url; }
}

// Hook callers use to trigger the "Schedule a consultation" CTA. Returns
// an `open(e)` handler and an `available` flag so the calling component
// can conditionally render its trigger. Calendly links open the popup
// widget; every other provider opens in a new tab.
export function useBookingLink(url, locale) {
  const calendly = isCalendlyUrl(url);
  useEffect(() => {
    if (url && calendly) ensureCalendlyAssetsLoaded();
  }, [url, calendly]);
  const open = (e) => {
    e?.preventDefault?.();
    if (!url) return;
    if (calendly) {
      const popupUrl = buildCalendlyPopupUrl(url, locale);
      if (typeof window !== 'undefined' && window.Calendly) {
        window.Calendly.initPopupWidget({ url: popupUrl });
        return;
      }
      window.open(popupUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  return { open, available: !!url };
}
