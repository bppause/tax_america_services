import { useEffect, useState } from 'react';
import LocaleSwitcher from './LocaleSwitcher';
import { useT, pickI18n } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import { firstNameOf, displayPersonName } from '../lib/personName';
import ImpersonationBanner from './ImpersonationBanner';
import VersionTag from './VersionTag';

// One icon per nav key, shared by every group a link can appear in
// (several keys — tasks, customers, staff, settings, service-catalog,
// faqs — are reused across Simple/Detailed mode and the two "setup"
// groups, so this stays a flat lookup rather than per-group literals).
const NAV_ICON = {
  dashboard: '🏠', tasks: '✅', progress: '📈', customers: '👥', leads: '📥',
  'service-catalog': '🏷️', articles: '📰', faqs: '❓', staff: '🧑‍💼',
  'email-templates': '✉️', settings: '⚙️', audit: '🗂️', news: '📣',
  testimonials: '⭐', whatsapp: '💬', profile: '👤', help: '❔',
};

// Collapsible sidebar section — remembers whether the user last left it
// open or closed, per browser (localStorage), so returning to the app
// keeps the menu exactly as they arranged it. `defaultCollapsed` only
// applies the first time (no stored preference yet) — once the user
// toggles it, their choice wins from then on.
function NavGroup({ groupKey, label, children, defaultCollapsed = false }) {
  const storageKey = `tax.employeeNav.${groupKey}.collapsed`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored != null) return stored === '1';
    } catch { /* ignore */ }
    return defaultCollapsed;
  });
  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  return (
    <div className="tax-shell__group">
      <button type="button" className="tax-shell__group-label tax-shell__group-toggle"
              onClick={toggle} aria-expanded={!collapsed}>
        <span>{label}</span>
        <span className="tax-shell__group-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

// Phase 4l: sidebar shell. Replaces the 13-item horizontal nav with a
// left-rail sidebar split into two groups (Work / Configure) plus a
// footer (Profile, Help, Locale, dual-role switch, sign-out). On
// narrow viewports the sidebar collapses behind a hamburger button.
//
// Active state still keys off the `active` prop passed by each page.
// Admin gating: the "Configure" group only renders for role=admin
// employees; staff see only the "Work" items relevant to them.
export default function EmployeeShell({ community, active, children }) {
  const { t, locale } = useT();
  const { fbUser, employee, signOut, switchAccount, impersonation, exitImpersonation, customerAccess } = useEmployeeAuth();
  const base = community ? `/tax/${community.id}/employee` : '#';
  const isAdmin = employee?.role === 'admin';
  // Owner-wide setting (Settings → Admin/staff view) — trims the sidebar
  // to the essentials. Individual pages (e.g. Tasks) read this too, to
  // drop their own advanced controls in sync with the simpler menu.
  const isSimple = community?.tax_ui_mode === 'simple';
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

  // Owner-only badge on the Tasks link — tasks sitting in the review
  // queue aren't visible anywhere outside Tasks/Dashboard otherwise,
  // so this makes "something needs you" visible from any page in the
  // portal, not just after navigating to one of those two.
  const [awaitingReview, setAwaitingReview] = useState(0);
  useEffect(() => {
    if (!fbUser || !community || !employee?.is_owner) { setAwaitingReview(0); return; }
    let cancelled = false;
    const auth = { uid: fbUser.uid, email: fbUser.email, communitySlug: community.id };
    const load = () => taxApi.adminTasksAwaitingReview(auth)
      .then(d => { if (!cancelled) setAwaitingReview((d.tasks || []).length); })
      .catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [fbUser, community, employee?.is_owner]);

  // Notification bell — surfaces tax_employee_notifications rows (new
  // messages, signed requests, task status changes, …). The endpoints
  // already existed server-side with no UI consuming them; this is that
  // UI. Polled on a slow interval rather than real-time push.
  const notifAuth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const [notifications, setNotifications] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const loadNotifications = () => {
    if (!fbUser || !community) return;
    taxApi.getEmployeeNotifications(notifAuth)
      .then(d => setNotifications(d.notifications || []))
      .catch(() => {});
  };
  useEffect(() => {
    loadNotifications();
    const id = setInterval(loadNotifications, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);
  const unreadNotifCount = notifications.filter(n => !n.read_at).length;
  const onOpenNotification = async (n) => {
    if (!n.read_at) {
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
      taxApi.markEmployeeNotificationRead(notifAuth, n.id).catch(() => {});
    }
    if (n.payload?.taskId && community) {
      window.location.href = `/tax/${community.id}/employee/tasks?edit=${encodeURIComponent(n.payload.taskId)}`;
    } else if (n.payload?.leadId && community) {
      window.location.href = `/tax/${community.id}/employee/leads?lead=${encodeURIComponent(n.payload.leadId)}`;
    } else if (n.payload?.threadId && community) {
      // Inbox has no per-thread deep link yet — land on the inbox and
      // let the operator pick the thread from the list.
      window.location.href = `/tax/${community.id}/employee/inbox`;
    } else if (n.payload?.customerId && community) {
      window.location.href = `/tax/${community.id}/employee/customers/${encodeURIComponent(n.payload.customerId)}`;
    } else {
      setNotifOpen(false);
    }
  };

  const initials = (community?.name || 'TAX')
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase();

  const closeMobile = () => setMobileOpen(false);
  // One glance ("what is this link for") + one hover ("what does it do")
  // — icons make the sidebar scannable, the title attribute (native
  // browser tooltip) spells out the action for anyone unsure.
  const navLink = (key, href, label, badge) => (
    <a key={key} href={href} className={active === key ? 'active' : ''} onClick={closeMobile}
       title={t(`employee.nav.hint.${key}`)}>
      <span className="tax-shell__nav-label">
        <span aria-hidden="true" className="tax-shell__nav-icon">{NAV_ICON[key] || ''}</span>
        <span>{label}</span>
      </span>
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

            {isSimple ? (
              <>
                {/* Simple mode (Settings → Admin/staff view): two groups
                    covering exactly the essentials — running the business
                    and keeping the website/app current. Everything more
                    niche (Progress analytics, News, Testimonials, WhatsApp
                    template, Email templates, Audit) is reachable again
                    by switching back to Detailed. */}
                {employee && perm('view_customers') && (
                  <NavGroup groupKey="business" label={t('employee.nav.groupBusiness')}>
                    {navLink('tasks',     `${base}/tasks`,     t('employee.nav.tasks'), awaitingReview)}
                    {navLink('customers', `${base}/customers`, t('employee.nav.customers'))}
                    {isAdmin && perm('manage_leads') &&
                      navLink('leads', `${base}/leads`, t('employee.nav.leads'))}
                  </NavGroup>
                )}
                {isAdmin && (
                  <NavGroup groupKey="website" label={t('employee.nav.groupWebsite')}>
                    {perm('manage_services') && navLink('service-catalog', `${base}/service-catalog`, t('employee.nav.services'))}
                    {                          navLink('articles',         `${base}/articles`,        t('employee.nav.articles'))}
                    {                          navLink('faqs',             `${base}/faqs`,            t('employee.nav.faqsAdmin'))}
                    {/* Staff/Settings are practice-operations powers — kept out
                        of a site admin's scope even in Simple mode. */}
                    {perm('view_customers') && perm('manage_employees') &&
                      navLink('staff',    `${base}/staff`,    t('employee.nav.staff'))}
                    {perm('view_customers') && perm('manage_settings') &&
                      navLink('settings', `${base}/settings`, t('employee.nav.settings'))}
                  </NavGroup>
                )}
              </>
            ) : (
              <>
                {/* Operations — the day-to-day work surfaces. Leads sits
                    here because converting them IS operational work. Hidden
                    entirely for an admin with view_customers revoked — a
                    "site admin" account that never touches customer data. */}
                {employee && perm('view_customers') && (
                  <NavGroup groupKey="operations" label={t('employee.nav.groupOperations')}>
                    {navLink('tasks',     `${base}/tasks`,     t('employee.nav.tasks'), awaitingReview)}
                    {navLink('progress',  `${base}/progress`,  t('employee.nav.progress'))}
                    {navLink('customers', `${base}/customers`, t('employee.nav.customers'))}
                    {isAdmin && perm('manage_leads') &&
                      navLink('leads', `${base}/leads`, t('employee.nav.leads'))}
                  </NavGroup>
                )}

                {/* Practice setup — rarely touched. Templates, staff,
                    community-wide toggles, audit trail. Hidden entirely
                    (not just emptied out) for a site admin — these are
                    practice-operations powers, outside the "public
                    homepage only" scope a view_customers-revoked admin
                    account is meant to have. */}
                {isAdmin && perm('view_customers') && (
                  <NavGroup groupKey="practice-setup" label={t('employee.nav.groupPracticeSetup')} defaultCollapsed>
                    {perm('manage_employees')       && navLink('staff',          `${base}/staff`,           t('employee.nav.staff'))}
                    {perm('manage_email_templates') && navLink('email-templates', `${base}/email-templates`, t('employee.nav.emailTemplates'))}
                    {perm('manage_settings')        && navLink('settings',       `${base}/settings`,         t('employee.nav.settings'))}
                    {perm('view_audit_logs')        && navLink('audit',          `${base}/audit`,            t('employee.nav.audit'))}
                  </NavGroup>
                )}

                {/* Public homepage — anything you edit here changes the
                    public landing page (Services / Articles / FAQs). The
                    "Meet the team" section is curated per-employee from
                    Practice setup → Staff → Public profile card. */}
                {isAdmin && (
                  <NavGroup groupKey="public-homepage" label={t('employee.nav.groupPublicHomepage')} defaultCollapsed>
                    {perm('manage_services') && navLink('service-catalog', `${base}/service-catalog`, t('employee.nav.services'))}
                    {                          navLink('articles',         `${base}/articles`,        t('employee.nav.articles'))}
                    {                          navLink('news',             `${base}/news`,            t('employee.nav.news'))}
                    {                          navLink('testimonials',     `${base}/testimonials`,    t('employee.nav.testimonials'))}
                    {                          navLink('faqs',             `${base}/faqs`,            t('employee.nav.faqsAdmin'))}
                    {perm('manage_services') && navLink('whatsapp',        `${base}/whatsapp`,        t('employee.nav.whatsapp'))}
                  </NavGroup>
                )}
              </>
            )}

            {/* You group — personal / non-admin tools. */}
            <NavGroup groupKey="you" label={t('employee.nav.groupYou')}>
              {navLink('profile', `${base}/profile`, t('employee.nav.profile'))}
              {navLink('help',    `${base}/help`,    t('employee.nav.help'))}
            </NavGroup>
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
              <div style={{ position: 'relative' }}>
                <button type="button"
                        aria-label={t('employee.notifications.title')}
                        onClick={() => setNotifOpen(o => !o)}
                        style={{
                          position: 'relative', background: 'none', border: 0, cursor: 'pointer',
                          fontSize: 18, lineHeight: 1, padding: 6,
                        }}>
                  🔔
                  {unreadNotifCount > 0 && (
                    <span style={{
                      position: 'absolute', top: 0, right: 0,
                      padding: '1px 6px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                      background: 'var(--tax-brand-secondary)', color: '#fff',
                    }}>
                      {unreadNotifCount}
                    </span>
                  )}
                </button>
                {notifOpen && (
                  <div style={{
                    position: 'absolute', left: 0, bottom: '100%', zIndex: 20,
                    width: 320, maxHeight: 400, overflowY: 'auto',
                    background: '#fff', border: '1px solid var(--tax-border)', borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,.12)',
                  }}>
                    <div style={{ padding: '10px 14px', fontWeight: 700, fontSize: 13, borderBottom: '1px solid var(--tax-border)' }}>
                      {t('employee.notifications.title')}
                    </div>
                    {notifications.length === 0 ? (
                      <div style={{ padding: 14, fontSize: 13, color: 'var(--tax-muted)' }}>
                        {t('employee.notifications.empty')}
                      </div>
                    ) : notifications.map(n => (
                      <button key={n.id} type="button" onClick={() => onOpenNotification(n)}
                              style={{
                                display: 'block', width: '100%', textAlign: 'left',
                                padding: '10px 14px', border: 0, borderBottom: '1px solid var(--tax-border)',
                                background: n.read_at ? '#fff' : 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)',
                                cursor: 'pointer', fontSize: 13,
                              }}>
                        <div style={{ fontWeight: n.read_at ? 500 : 700 }}>
                          {pickI18n(n.title_i18n, locale).value || n.type}
                        </div>
                        {pickI18n(n.body_i18n, locale).value && (
                          <div style={{ color: 'var(--tax-muted)', marginTop: 2 }}>
                            {pickI18n(n.body_i18n, locale).value}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <LocaleSwitcher />
              {!impersonation && (
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={switchAccount}
                        title={t('employee.switchAccount.hint')}>
                  {t('employee.switchAccount')}
                </button>
              )}
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={signOut}>
                {t('portal.signout')}
              </button>
            </div>
            <div style={{ textAlign: 'center', marginTop: 8 }}>
              <VersionTag />
            </div>
          </div>
        </aside>

        <div className="tax-shell__main">
          <div className="tax-shell__topbar">
            <button type="button" className="tax-shell__menu-btn"
                    aria-label={t('employee.nav.openMenu')}
                    onClick={() => setMobileOpen(o => !o)}>☰</button>
            <span style={{ fontWeight: 700, flex: 1 }}>{community?.name || ''}</span>
            {/* Mirrors the sidebar footer's switcher — the sidebar sits
                off-screen behind the hamburger below 900px, so without
                this the language toggle is invisible on a phone until
                you open the drawer. */}
            <LocaleSwitcher />
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
