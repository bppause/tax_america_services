import { useEffect } from 'react';

// Calendly popup widget plumbing. Loads the script + CSS once per page,
// de-dupes via data attributes, and exposes a hook that returns an
// `open` handler. The script is async so we always have a safe fallback
// to opening the URL in a new tab when Calendly hasn't finished loading
// by the time the visitor clicks.
const CALENDLY_SCRIPT_URL = 'https://assets.calendly.com/assets/external/widget.js';
const CALENDLY_STYLE_URL  = 'https://assets.calendly.com/assets/external/widget.css';

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
function buildPopupUrl(url, locale) {
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

// Hook callers use to open the Calendly popup widget. Returns an
// `open(e)` handler and an `available` flag so the calling component
// can conditionally render its trigger.
export function useCalendlyPopup(url, locale) {
  useEffect(() => {
    if (url) ensureCalendlyAssetsLoaded();
  }, [url]);
  const popupUrl = buildPopupUrl(url, locale);
  const open = (e) => {
    e?.preventDefault?.();
    if (!popupUrl) return;
    if (typeof window === 'undefined' || !window.Calendly) {
      window.open(popupUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    window.Calendly.initPopupWidget({ url: popupUrl });
  };
  return { open, available: !!popupUrl };
}
