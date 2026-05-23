import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import LocaleSwitcher from './LocaleSwitcher';
import { useCalendlyPopup } from './CalendlySection';

// Hamburger threshold + cleanup. On wider viewports the nav is a horizontal
// row; below 760px we collapse to an icon button that toggles an overlay
// panel. Locked-body-scroll while the panel is open so background
// scrolling doesn't compete with the menu.
const MOBILE_BREAKPOINT = 760;

export default function Header({ community, sections }) {
  const { locale, t } = useT();
  const [logoFailed, setLogoFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const initials = (community?.name || 'TAX')
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase();
  const showLogo = Boolean(community?.logo_url) && !logoFailed;

  // Schedule nav entry opens the Calendly popup directly — the
  // standalone Schedule section was folded into Contact, so a plain
  // href="#schedule" would scroll to nothing. Hidden when no URL is
  // configured.
  const { open: openCalendly, available: calendlyAvailable } =
    useCalendlyPopup(community?.calendly_url, locale);

  // Close + restore scroll on Escape / route changes.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  const navLinks = buildNavLinks(sections, t, {
    calendarHref: community?.id ? `/tax/${community.id}/calendar` : '',
    schedule: calendlyAvailable
      ? { label: t('nav.schedule'), onClick: openCalendly }
      : null,
  });

  const renderLink = (l, opts = {}) => {
    if (l.onClick) {
      return (
        <button key={l.label} type="button"
                onClick={(e) => { l.onClick(e); opts.afterClick?.(); }}
                className="tax-nav__link tax-nav__link--button">
          {l.label}
        </button>
      );
    }
    return (
      <a key={l.href} href={l.href} onClick={opts.afterClick}>
        {l.label}
      </a>
    );
  };

  return (
    <header className="tax-header">
      <div className="tax-container tax-header__row">
        <a href="#top" className="tax-brand" aria-label={community?.name || 'Tax Services'}>
          {showLogo ? (
            <img
              src={community.logo_url}
              alt={community?.name || 'Tax Services'}
              className="tax-brand__logo"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <>
              <span className="tax-brand__mark">{initials}</span>
              <span className="tax-brand__name">{community?.name || 'Tax Services'}</span>
            </>
          )}
        </a>

        {/* Desktop nav (hidden under MOBILE_BREAKPOINT via CSS) */}
        <nav className="tax-nav tax-nav--desktop" aria-label="Main">
          {navLinks.map(l => renderLink(l))}
          <LocaleSwitcher />
        </nav>

        {/* Hamburger toggle (shown only under MOBILE_BREAKPOINT via CSS) */}
        <button type="button"
                className="tax-nav__hamburger"
                aria-label={menuOpen ? t('nav.closeMenu') : t('nav.openMenu')}
                aria-expanded={menuOpen}
                aria-controls="tax-mobile-nav"
                onClick={() => setMenuOpen(o => !o)}>
          <span className="tax-nav__hamburger-bar" />
          <span className="tax-nav__hamburger-bar" />
          <span className="tax-nav__hamburger-bar" />
        </button>
      </div>

      {menuOpen && (
        <div className="tax-nav__overlay" onClick={() => setMenuOpen(false)}>
          <nav id="tax-mobile-nav" className="tax-nav tax-nav--mobile"
               aria-label="Main"
               onClick={(e) => e.stopPropagation()}>
            {navLinks.map(l => renderLink(l, { afterClick: () => setMenuOpen(false) }))}
            <div style={{ marginTop: 14 }}>
              <LocaleSwitcher />
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

// Resolve the visible nav links. Always includes Services / About / Contact;
// Team and FAQs surface only when the parent reports the matching section
// is rendering. Schedule is special — it's a popup trigger (not an anchor)
// supplied by the caller when Calendly is configured. Calendar is an
// absolute link to the standalone deadline page (not an in-page anchor)
// and only renders when the caller knows the community slug.
function buildNavLinks(sections, t, overrides = {}) {
  const has = (k) => !sections || sections[k] !== false;
  const out = [
    { href: '#services', label: t('nav.services') },
  ];
  if (has('team')) out.push({ href: '#team', label: t('nav.team') });
  if (overrides.schedule) out.push(overrides.schedule);
  if (has('faqs')) out.push({ href: '#faqs', label: t('nav.faqs') });
  if (overrides.calendarHref) out.push({ href: overrides.calendarHref, label: t('nav.calendar') });
  out.push({ href: '#about', label: t('nav.about') });
  out.push({ href: '#contact', label: t('nav.contact') });
  return out;
}
