import { useEffect, useState } from 'react';
import LocaleSwitcher from './LocaleSwitcher';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import { firstNameOf, displayPersonName } from '../lib/personName';
import ImpersonationBanner from './ImpersonationBanner';

// Phase 4l: sidebar shell. Replaces the 13-item horizontal nav with a
// left-rail sidebar split into two groups (Work / Configure) plus a
// footer (Profile, Help, Locale, dual-role switch, sign-out). On
// narrow viewports the sidebar collapses behind a hamburger button.
//
// Active state still keys off the `active` prop passed by each page.
// Admin gating: the "Configure" group only renders for role=admin
// employees; staff see only the "Work" items relevant to them.
export default function EmployeeShell({ community, active, children }) {
  const { t } = useT();
  const { fbUser, employee, signOut, impersonation, exitImpersonation, customerAccess } = useEmployeeAuth();
  const base = community ? `/tax/${community.id}/employee` : '#';
  const isAdmin = employee?.role === 'admin';
  // Permission gate for nav links — owner-revoked keys hide their
  // corresponding sidebar items. Server re-checks each request, so this
  // is UX hygiene, not a security boundary.
  const perm = (key) => (employee?.permissions?.[key] !== false);

  // Mobile menu open/closed.
  const [mobileOpen, setMobileOpen] = useState(false);

  // Unread inbox badge (same query as before).
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!fbUser || !community) return;
    let cancelled = false;
    taxApi.getEmployeeThreads({ uid: fbUser.uid, email: fbUser.email, communitySlug: community.id })
      .then(d => { if (!cancelled) setUnread((d.threads || []).filter(th => th.practice_unread).length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fbUser, community]);

  const initials = (community?.name || 'TAX')
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase();

  const closeMobile = () => setMobileOpen(false);
  const navLink = (key, href, label, badge) => (
    <a key={key} href={href} className={active === key ? 'active' : ''} onClick={closeMobile}>
      <span>{label}</span>
      {badge != null && badge > 0 && <span className="tax-shell__badge">{badge}</span>}
    </a>
  );

  return (
    <>
      <ImpersonationBanner impersonation={impersonation} onExit={exitImpersonation} />
      <div className="tax-shell">
        {mobileOpen && <div className="tax-shell__backdrop tax-shell__backdrop--open" onClick={closeMobile} />}

        <aside className={`tax-shell__sidebar${mobileOpen ? ' tax-shell__sidebar--open' : ''}`}
               aria-label={t('employee.nav.sidebarAria')}>
          <a href={base} className="tax-shell__brand" onClick={closeMobile}
             aria-label={community?.name || 'Tax Services'}>
            {community?.logo_url
              ? <img src={community.logo_url} alt={community?.name || ''} className="tax-brand__logo" style={{ height: 32, maxWidth: 150 }} />
              : <span className="tax-brand__mark">{initials}</span>}
            <span className="tax-shell__brand-name">
              <span className="tax-shell__brand-title">{community?.name || ''}</span>
              <span className="tax-shell__staff-badge">{t('employee.staffBadge')}</span>
            </span>
          </a>

          <nav className="tax-shell__nav">
            {/* Phase 4n.44: sidebar restructured around the two jobs
                the app actually does — acquisition (Public homepage)
                and operations (everything else the team works in).
                Three top-level groups for now; a Today dashboard
                will land above Operations in Round 2. */}

            {/* Today — the new operations dashboard. Single entry at
                the top so it's the first thing the eye hits. The
                /employee route now defaults here. */}
            <div className="tax-shell__group">
              {employee && navLink('dashboard', `${base}/dashboard`, t('employee.nav.dashboard'))}
            </div>

            {/* Operations — the day-to-day work surfaces. Leads sits
                here because converting them IS operational work. */}
            <div className="tax-shell__group">
              <div className="tax-shell__group-label">{t('employee.nav.groupOperations')}</div>
              {employee && navLink('tasks',     `${base}/tasks`,     t('employee.nav.tasks'))}
              {employee && navLink('progress',  `${base}/progress`,  t('employee.nav.progress'))}
              {isAdmin && navLink('workload',   `${base}/workload`,  t('employee.nav.workload'))}
              {employee && navLink('customers', `${base}/customers`, t('employee.nav.customers'))}
              {isAdmin && perm('manage_leads') &&
                navLink('leads', `${base}/leads`, t('employee.nav.leads'))}
            </div>

            {/* Public homepage — anything you edit here changes the
                public landing page (Services / Articles / FAQs). The
                "Meet the team" section is curated per-employee from
                Practice setup → Staff → Public profile card. */}
            {isAdmin && (
              <div className="tax-shell__group">
                <div className="tax-shell__group-label">{t('employee.nav.groupPublicHomepage')}</div>
                {perm('manage_services') && navLink('service-catalog', `${base}/service-catalog`, t('employee.nav.services'))}
                {perm('manage_services') && navLink('whatsapp',       `${base}/whatsapp`,       t('employee.nav.whatsapp'))}
                {                          navLink('news',             `${base}/news`,            t('employee.nav.news'))}
                {                          navLink('articles',         `${base}/articles`,        t('employee.nav.articles'))}
                {                          navLink('faqs',             `${base}/faqs`,            t('employee.nav.faqsAdmin'))}
              </div>
            )}

            {/* Practice setup — rarely touched. Templates, staff,
                community-wide toggles, audit trail. */}
            {isAdmin && (
              <div className="tax-shell__group">
                <div className="tax-shell__group-label">{t('employee.nav.groupPracticeSetup')}</div>
                {perm('manage_employees')       && navLink('staff',          `${base}/staff`,           t('employee.nav.staff'))}
                {perm('manage_email_templates') && navLink('email-templates', `${base}/email-templates`, t('employee.nav.emailTemplates'))}
                {perm('manage_settings')        && navLink('settings',       `${base}/settings`,         t('employee.nav.settings'))}
                {perm('view_audit_logs')        && navLink('audit',          `${base}/audit`,            t('employee.nav.audit'))}
              </div>
            )}

            {/* You group — personal / non-admin tools. */}
            <div className="tax-shell__group">
              <div className="tax-shell__group-label">{t('employee.nav.groupYou')}</div>
              {navLink('profile', `${base}/profile`, t('employee.nav.profile'))}
              {navLink('help',    `${base}/help`,    t('employee.nav.help'))}
            </div>
          </nav>

          <div className="tax-shell__footer">
            {/* Dual-role switch — surfaced when this email is ALSO a
                tax_customers row in the same community. Hidden during
                impersonation (the impersonator's identity drives this). */}
            {!impersonation && customerAccess?.hasCustomerRow && community && community.tax_customer_portal_enabled && (
              <a href={`/tax/${community.id}/portal`}
                 className="tax-btn tax-btn--ghost tax-btn--sm"
                 style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
                {t('employee.switchToCustomer')}
              </a>
            )}
            <div className="tax-shell__footer-row">
              <LocaleSwitcher />
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={signOut}>
                {t('portal.signout')}
              </button>
            </div>
          </div>
        </aside>

        <div className="tax-shell__main">
          <div className="tax-shell__topbar">
            <button type="button" className="tax-shell__menu-btn"
                    aria-label={t('employee.nav.openMenu')}
                    onClick={() => setMobileOpen(o => !o)}>☰</button>
            <span style={{ fontWeight: 700 }}>{community?.name || ''}</span>
          </div>
          <main className="tax-shell__content">
            {employee && (
              <div style={{ color: 'var(--tax-muted)', fontSize: 14, marginBottom: 16 }}>
                {t('employee.greeting', { name: firstNameOf(employee) || displayPersonName(employee) || employee.email })}
              </div>
            )}
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
