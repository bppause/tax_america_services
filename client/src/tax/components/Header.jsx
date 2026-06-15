import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import LocaleSwitcher from './LocaleSwitcher';
import { useCalendlyPopup } from './CalendlySection';

// Hamburger threshold + cleanup. On wider viewports the nav is a horizontal
// row; below 760px we collapse to an icon button that toggles an overlay
// panel. Locked-body-scroll while the panel is open so background
// scrolling doesn't compete with the menu.
const MOBILE_BREAKPOINT = 760;

export default function Header({ community, sections, communitySlug, homeBase, hideCalendar }) {
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
    schedule: calendlyAvailable
      ? { label: t('nav.schedule'), onClick: openCalendly }
      : null,
    communitySlug,
    homeBase,
    hideCalendar,
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
        <a href={homeBase || '#top'} className="tax-brand" aria-label={community?.name || 'Tax Services'}>
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

      {menuOpen && createPortal(
        <div className="tax-nav__overlay" onClick={() => setMenuOpen(false)}>
          <nav id="tax-mobile-nav" className="tax-nav tax-nav--mobile"
               aria-label="Main"
               onClick={(e) => e.stopPropagation()}>
            {navLinks.map(l => renderLink(l, { afterClick: () => setMenuOpen(false) }))}
            <div style={{ marginTop: 14 }}>
              <LocaleSwitcher />
            </div>
          </nav>
        </div>,
        document.body
      )}
    </header>
  );
}

// Resolve the visible nav links. Always includes Services / About / Contact;
// Team, FAQs, News, Articles, and Calendar surface only when the parent
// reports the matching section/data is available.
function buildNavLinks(sections, t, overrides = {}) {
  const has = (k) => sections && sections[k] === true;
  const slug = overrides.communitySlug;
  const home = overrides.homeBase || ''; // e.g. '/tax/tax-america-services' on sub-pages
  const anchor = (hash) => home ? `${home}${hash}` : hash;
  const out = [
    { href: anchor('#services'), label: t('nav.services') },
  ];
  if (!sections || sections.team !== false) out.push({ href: anchor('#team'), label: t('nav.team') });
  if (overrides.schedule) out.push(overrides.schedule);
  if (has('reviews')) out.push({ href: anchor('#testimonials'), label: t('nav.reviews') });
  if (has('news')) out.push({ href: anchor('#news'), label: t('nav.news') });
  if (has('articles')) out.push({ href: anchor('#articles'), label: t('nav.articles') });
  if (has('calendar') && slug && !overrides.hideCalendar) out.push({ href: `/tax/${slug}/calendar`, label: t('nav.calendar') });
  if (!sections || sections.faqs !== false) out.push({ href: anchor('#faqs'), label: t('nav.faqs') });
  out.push({ href: anchor('#about'), label: t('nav.about') });
  out.push({ href: anchor('#contact'), label: t('nav.contact') });
  return out;
}
