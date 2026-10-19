import { useEffect, useState } from 'react';
import LocaleSwitcher from './LocaleSwitcher';
import { useT } from '../i18n';
import { useTaxAuth } from '../auth/AuthProvider';
import { taxApi } from '../api';
import { firstNameOf, displayPersonName } from '../lib/personName';
import ImpersonationBanner from './ImpersonationBanner';
import VersionTag from './VersionTag';

// Chrome shared by every portal page. Below 720px the horizontal nav
// collapses behind a hamburger button (Phase 4o mobile pass) — customers
// will overwhelmingly arrive on a phone from a reminder email, so the
// nav can't overflow the viewport.
export default function PortalShell({ community, active, children }) {
  const { t } = useT();
  const { fbUser, customer, signOut, impersonation, exitImpersonation, staffAccess } = useTaxAuth();
  const initials = (community?.name || 'TAX')
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase();
  const base = community ? `/tax/${community.id}/portal` : '#';

  // Mobile drawer state.
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  // Unread-message badge for the Messages nav link.
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!fbUser || !community) return;
    let cancelled = false;
    taxApi.getThreads({ uid: fbUser.uid, email: fbUser.email, communitySlug: community.id })
      .then(d => { if (!cancelled) setUnread((d.threads || []).filter(th => th.customer_unread).length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fbUser, community]);

  return (
    <>
      <ImpersonationBanner impersonation={impersonation} onExit={exitImpersonation} />
      <header className="tax-header" style={{ position: 'sticky', top: 0 }}>
        <div className="tax-container tax-header__row">
          <a href={base} className="tax-brand" onClick={closeMenu}
             aria-label={community?.name || 'Tax Services'}>
            {community?.logo_url
              ? <img src={community.logo_url} alt={community?.name || ''} className="tax-brand__logo" />
              : <span className="tax-brand__mark">{initials}</span>}
          </a>

          {/* Mobile-only hamburger. Hidden on desktop via CSS. */}
          <button type="button"
                  className="tax-portal-menu-btn"
                  aria-label={t('portal.nav.openMenu')}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(o => !o)}>☰</button>

          {/* Backdrop is mobile-only and only visible when the drawer is
              open; tapping it closes the menu. */}
          {menuOpen && (
            <div className="tax-portal-nav-backdrop tax-portal-nav-backdrop--open"
                 onClick={closeMenu} aria-hidden="true" />
          )}

          <nav className={`tax-nav tax-portal-nav${menuOpen ? ' tax-portal-nav--open' : ''}`}
               aria-label="Portal">
            <a href={base} className={active === 'dashboard' ? 'active' : ''} onClick={closeMenu}>
              {t('portal.nav.dashboard')}
            </a>
            <a href={`${base}/messages`} className={active === 'messages' ? 'active' : ''} onClick={closeMenu}>
              {t('portal.nav.messages')}
              {unread > 0 && (
                <span style={{
                  marginLeft: 6, padding: '2px 7px', borderRadius: 999,
                  background: 'var(--tax-brand-secondary)', color: '#fff',
                  fontSize: 11, fontWeight: 700, lineHeight: 1.4,
                }}>{unread}</span>
              )}
            </a>
            {community?.tax_customer_documents_enabled && (
              <a href={`${base}/documents`} className={active === 'documents' ? 'active' : ''} onClick={closeMenu}>{t('portal.nav.documents')}</a>
            )}
            <a href={`${base}/faqs`} className={active === 'faqs' ? 'active' : ''} onClick={closeMenu}>{t('portal.nav.faqs')}</a>
            <a href={`${base}/help`} className={active === 'help' ? 'active' : ''} onClick={closeMenu}>{t('portal.nav.help')}</a>
            <a href={`${base}/profile`} className={active === 'profile' ? 'active' : ''} onClick={closeMenu}>{t('portal.nav.profile')}</a>
            <LocaleSwitcher />
            {/* Dual-role switch: see Phase 3 notes. Hidden during impersonation. */}
            {!impersonation && staffAccess?.hasEmployeeRow && community && (
              <a href={`/tax/${community.id}/employee`} className="tax-btn tax-btn--ghost tax-btn--sm"
                 onClick={closeMenu}
                 style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
                {staffAccess.role === 'admin'
                  ? t('portal.switchToOwner')
                  : t('portal.switchToStaff')}
              </a>
            )}
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={signOut}>
              {t('portal.signout')}
            </button>
          </nav>
        </div>
      </header>
      <div className="tax-container" style={{ paddingTop: 24 }}>
        {customer && (
          <div style={{ color: 'var(--tax-muted)', fontSize: 14, marginBottom: 16 }}>
            {t('portal.greeting', { name: firstNameOf(customer) || displayPersonName(customer) || customer.email })}
          </div>
        )}
        {children}
        <div style={{ textAlign: 'center', padding: '24px 0 8px' }}>
          <VersionTag />
        </div>
      </div>
    </>
  );
}
