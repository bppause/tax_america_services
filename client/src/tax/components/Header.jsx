import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import LocaleSwitcher from './LocaleSwitcher';

// Hamburger threshold + cleanup. On wider viewports the nav is a horizontal
// row; below 760px we collapse to an icon button that toggles an overlay
// panel. Locked-body-scroll while the panel is open so background
// scrolling doesn't compete with the menu.
const MOBILE_BREAKPOINT = 760;

export default function Header({ community, sections }) {
  const { t } = useT();
  const [logoFailed, setLogoFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const initials = (community?.name || 'TAX')
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase();
  const showLogo = Boolean(community?.logo_url) && !logoFailed;

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

  const navLinks = buildNavLinks(sections, t);

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
          {navLinks.map(l => (
            <a key={l.href} href={l.href}>{l.label}</a>
          ))}
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
            {navLinks.map(l => (
              <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)}>{l.label}</a>
            ))}
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
// Team, Schedule, and FAQs surface only when the parent reports the
// matching section is rendering, so anchors never jump to nothing.
function buildNavLinks(sections, t) {
  const has = (k) => !sections || sections[k] !== false;
  const out = [
    { href: '#services', label: t('nav.services') },
  ];
  if (has('team')) out.push({ href: '#team', label: t('nav.team') });
  if (has('schedule')) out.push({ href: '#schedule', label: t('nav.schedule') });
  if (has('faqs')) out.push({ href: '#faqs', label: t('nav.faqs') });
  out.push({ href: '#about', label: t('nav.about') });
  out.push({ href: '#contact', label: t('nav.contact') });
  return out;
}
