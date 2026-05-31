// Root component for the /tax/* route tree.
//
// URL shapes:
//   /tax                                       → DEFAULT_COMMUNITY landing
//   /tax/{community-slug}                      → that community's landing
//   /tax/respond/{token}                       → magic-link customer response (Phase 1.5)
//   /tax/{community-slug}/portal               → portal dashboard (Phase 2a)
//   /tax/{community-slug}/portal/profile       → portal profile + preferences
//   /tax/{community-slug}/portal/filings/{id}  → portal filing detail + response

import { useEffect, useState } from 'react';
import { TaxLocaleProvider } from './i18n';
import Landing from './pages/Landing';
import PublicFaqs from './pages/PublicFaqs';
import PublicArticles from './pages/PublicArticles';
import PublicCalendar from './pages/PublicCalendar';
import Respond from './pages/Respond';
import PortalLogin from './pages/PortalLogin';
import PortalDashboard from './pages/PortalDashboard';
import PortalFiling from './pages/PortalFiling';
import PortalSignatureRequest from './pages/PortalSignatureRequest';
import PortalProfile from './pages/PortalProfile';
import PortalFaqs from './pages/PortalFaqs';
import PortalDocuments from './pages/PortalDocuments';
import PortalMessages from './pages/PortalMessages';
import EmployeeInbox from './pages/EmployeeInbox';
import OwnerDashboard from './pages/OwnerDashboard';
import EmployeeThread from './pages/EmployeeThread';
import EmployeeProfile from './pages/EmployeeProfile';
import OwnerCustomers from './pages/OwnerCustomers';
import OwnerCustomerDetail from './pages/OwnerCustomerDetail';
import OwnerStaff from './pages/OwnerStaff';
import OwnerStaffDetail from './pages/OwnerStaffDetail';
import OwnerLeads from './pages/OwnerLeads';
import OwnerSettings from './pages/OwnerSettings';
import OwnerHelpAdmin from './pages/OwnerHelpAdmin';
import OwnerAudit from './pages/OwnerAudit';
import OwnerFaqAdmin from './pages/OwnerFaqAdmin';
import OwnerServicesAdmin from './pages/OwnerServicesAdmin';
import OwnerTasks from './pages/OwnerTasks';
import OwnerReminders from './pages/OwnerReminders';
import OwnerProgress from './pages/OwnerProgress';
import OwnerEmailTemplates from './pages/OwnerEmailTemplates';
import OwnerRelationshipWorkflows from './pages/OwnerRelationshipWorkflows';
import OwnerRelationshipTypes from './pages/OwnerRelationshipTypes';
import OwnerSetup from './pages/OwnerSetup';
import OwnerWhatsApp from './pages/OwnerWhatsApp';
import TaxReport from './pages/TaxReport';
import PlatformDashboard from './pages/PlatformDashboard';
import PlatformCommunityCreate from './pages/PlatformCommunityCreate';
import { TaxPlatformAuthProvider, useTaxPlatformAuth } from './auth/PlatformAuthProvider';
import { signInWithGoogle, firebaseReady } from './auth/firebase';
import PortalHelp from './pages/PortalHelp';
import EmployeeHelp from './pages/EmployeeHelp';
import { TaxAuthProvider, useTaxAuth } from './auth/AuthProvider';
import { TaxEmployeeAuthProvider, useEmployeeAuth } from './auth/EmployeeAuthProvider';
import { taxApi } from './api';
import './styles/tax.css';

const DEFAULT_COMMUNITY_SLUG = 'tax-america-services';

function parseTaxPath() {
  const parts = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  // parts[0] is always 'tax' here (main.jsx only mounts TaxApp on /tax/*).
  if (parts[1] === 'respond' && parts[2]) {
    return { route: 'respond', token: decodeURIComponent(parts[2]) };
  }
  // Phase 5: platform admin lives at /tax/_platform/*. The underscore
  // prefix can't collide with a real community slug (slugs are
  // [a-z0-9-_] after normalization, but no real practice would use a
  // leading underscore).
  if (parts[1] === '_platform') {
    if (parts[2] === 'communities' && parts[3] === 'new') return { route: 'platform-create' };
    return { route: 'platform-dashboard' };
  }
  const slug = parts[1] || DEFAULT_COMMUNITY_SLUG;
  // Public sub-pages — accessible without auth. Sit alongside the
  // landing page at /tax/:slug/{faqs,articles}.
  if (parts[2] === 'faqs')     return { route: 'public-faqs', slug };
  if (parts[2] === 'articles') return { route: 'public-articles', slug };
  if (parts[2] === 'calendar') return { route: 'public-calendar', slug };
  if (parts[2] === 'employee') {
    if (parts[3] === 'profile') return { route: 'employee-profile', slug };
    if (parts[3] === 'threads' && parts[4]) return { route: 'employee-thread', slug, threadId: decodeURIComponent(parts[4]) };
    // Phase 4a owner pages (admin role gated on page-render side too)
    if (parts[3] === 'customers') {
      if (parts[4]) return { route: 'owner-customer-detail', slug, customerId: decodeURIComponent(parts[4]) };
      return { route: 'owner-customers', slug };
    }
    if (parts[3] === 'staff') {
      if (parts[4]) return { route: 'owner-staff-detail', slug, employeeId: decodeURIComponent(parts[4]) };
      return { route: 'owner-staff', slug };
    }
    if (parts[3] === 'leads')    return { route: 'owner-leads', slug };
    if (parts[3] === 'tasks')    return { route: 'owner-tasks', slug };
    if (parts[3] === 'reminders') return { route: 'owner-reminders', slug };
    if (parts[3] === 'progress')  return { route: 'owner-progress', slug };
    if (parts[3] === 'settings') return { route: 'owner-settings', slug };
    if (parts[3] === 'email-templates') return { route: 'owner-email-templates', slug };
    if (parts[3] === 'workflows') return { route: 'owner-workflows', slug };
    if (parts[3] === 'services') return { route: 'owner-services', slug };
    if (parts[3] === 'setup') return { route: 'owner-setup', slug };
    if (parts[3] === 'whatsapp') return { route: 'owner-whatsapp', slug };
    if (parts[3] === 'articles') return { route: 'owner-articles', slug };
    if (parts[3] === 'faqs')     return { route: 'owner-faqs', slug };
    if (parts[3] === 'service-catalog') return { route: 'owner-service-catalog', slug };
    if (parts[3] === 'audit')    return { route: 'owner-audit', slug };
    if (parts[3] === 'help')     return { route: 'employee-help', slug };
    if (parts[3] === 'dashboard' || !parts[3]) return { route: 'owner-dashboard', slug };
    if (parts[3] === 'inbox')    return { route: 'employee-inbox', slug };
    return { route: 'owner-dashboard', slug };
  }
  if (parts[2] === 'r' && parts[3]) {
    return { route: 'report-access', slug, token: parts[3] };
  }
  if (parts[2] === 'portal') {
    if (parts[3] === 'profile') return { route: 'portal-profile', slug };
    if (parts[3] === 'faqs') return { route: 'portal-faqs', slug };
    if (parts[3] === 'help') return { route: 'portal-help', slug };
    if (parts[3] === 'documents') return { route: 'portal-documents', slug };
    if (parts[3] === 'messages') {
      // /portal/messages, /portal/messages/new, /portal/messages/:threadId
      return { route: 'portal-messages', slug, threadId: parts[4] ? decodeURIComponent(parts[4]) : '' };
    }
    if (parts[3] === 'filings' && parts[4]) return { route: 'portal-filing', slug, filingId: decodeURIComponent(parts[4]) };
    if (parts[3] === 'sign' && parts[4]) return { route: 'portal-signature', slug, requestId: decodeURIComponent(parts[4]) };
    return { route: 'portal-dashboard', slug };
  }
  return { route: 'landing', slug };
}

export default function TaxApp() {
  const parsed = parseTaxPath();
  return (
    <TaxLocaleProvider>
      {parsed.route === 'respond'
        ? <Respond token={parsed.token} />
        : parsed.route === 'report-access'
          ? <TaxReport communitySlug={parsed.slug} token={parsed.token} />
          : parsed.route.startsWith('platform')
            ? <PlatformRoot parsed={parsed} />
            : (parsed.route.startsWith('employee') || parsed.route.startsWith('owner-'))
              ? <EmployeeRoot parsed={parsed} />
              : parsed.route.startsWith('portal')
                ? <PortalRoot parsed={parsed} />
                : parsed.route === 'public-faqs'
                  ? <PublicFaqs communitySlug={parsed.slug} />
                  : parsed.route === 'public-articles'
                    ? <PublicArticles communitySlug={parsed.slug} />
                    : parsed.route === 'public-calendar'
                      ? <PublicCalendar communitySlug={parsed.slug} />
                      : <Landing communitySlug={parsed.slug} />}
    </TaxLocaleProvider>
  );
}

// Portal subtree: needs the community record before AuthProvider can run
// (the provider's /auth/link call requires communitySlug). We fetch it
// once here and pass the resolved community to children — including the
// login page, which renders branding before sign-in.
function PortalRoot({ parsed }) {
  const [community, setCommunity] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    taxApi.getCommunity(parsed.slug)
      .then(d => setCommunity(d.community))
      .catch(e => setErr(e?.message || 'Could not load community'));
  }, [parsed.slug]);

  if (err) return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">{err}</div></div>;
  if (!community) return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">Loading…</div></div>;

  const brandStyle = {
    '--tax-brand-primary': community.brand_primary_color || undefined,
    '--tax-brand-secondary': community.brand_secondary_color || undefined,
  };

  return (
    <div className="tax-app" style={brandStyle}>
      <TaxAuthProvider communitySlug={community.id}>
        <PortalGate parsed={parsed} community={community} />
      </TaxAuthProvider>
    </div>
  );
}

function PortalGate({ parsed, community }) {
  const { status, error, redirectTo, signOut } = useTaxAuth();

  if (status === 'unauthenticated') {
    return <PortalLogin community={community} />;
  }
  if (status === 'loading' || status === 'linking') {
    return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">Loading…</div></div>;
  }
  if (status === 'error') {
    return <SignInProblem error={error} redirectTo={redirectTo} signOut={signOut} />;
  }
  // status === 'ready'
  if (parsed.route === 'portal-profile') return <PortalProfile />;
  if (parsed.route === 'portal-faqs') return <PortalFaqs />;
  if (parsed.route === 'portal-documents') return <PortalDocuments />;
  if (parsed.route === 'portal-help') return <PortalHelp />;
  if (parsed.route === 'portal-messages') return <PortalMessages threadId={parsed.threadId} />;
  if (parsed.route === 'portal-filing') return <PortalFiling filingId={parsed.filingId} />;
  if (parsed.route === 'portal-signature') return <PortalSignatureRequest requestId={parsed.requestId} />;
  return <PortalDashboard />;
}

// ── Employee subtree (Phase 3) ──────────────────────────────────────────
// Parallel to PortalRoot but pulls EmployeeAuthProvider, which talks to
// /employee/auth/link and /employee/me instead of the customer endpoints.
function EmployeeRoot({ parsed }) {
  const [community, setCommunity] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    taxApi.getCommunity(parsed.slug)
      .then(d => setCommunity(d.community))
      .catch(e => setErr(e?.message || 'Could not load community'));
  }, [parsed.slug]);

  if (err) return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">{err}</div></div>;
  if (!community) return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">Loading…</div></div>;

  const brandStyle = {
    '--tax-brand-primary': community.brand_primary_color || undefined,
    '--tax-brand-secondary': community.brand_secondary_color || undefined,
  };

  return (
    <div className="tax-app" style={brandStyle}>
      <TaxEmployeeAuthProvider communitySlug={community.id}>
        <EmployeeGate parsed={parsed} community={community} />
      </TaxEmployeeAuthProvider>
    </div>
  );
}

function EmployeeGate({ parsed, community }) {
  const { status, error, redirectTo, signOut } = useEmployeeAuth();

  if (status === 'unauthenticated') {
    return <PortalLogin community={community}
                        titleKey="employee.login.title"
                        subtitleKey="employee.login.subtitle" />;
  }
  if (status === 'loading' || status === 'linking') {
    return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">Loading…</div></div>;
  }
  if (status === 'error') {
    return <SignInProblem error={error} redirectTo={redirectTo} signOut={signOut} />;
  }
  if (parsed.route === 'employee-profile') return <EmployeeProfile />;
  if (parsed.route === 'employee-thread') return <EmployeeThread threadId={parsed.threadId} />;
  if (parsed.route === 'owner-customers') return <OwnerCustomers />;
  if (parsed.route === 'owner-customer-detail') return <OwnerCustomerDetail customerId={parsed.customerId} />;
  if (parsed.route === 'owner-staff') return <OwnerStaff />;
  if (parsed.route === 'owner-staff-detail') return <OwnerStaffDetail employeeId={parsed.employeeId} />;
  if (parsed.route === 'owner-leads') return <OwnerLeads />;
  if (parsed.route === 'owner-settings') return <OwnerSettings />;
  if (parsed.route === 'owner-articles') return <OwnerHelpAdmin />;
  if (parsed.route === 'owner-faqs') return <OwnerFaqAdmin />;
  if (parsed.route === 'owner-service-catalog') return <OwnerServicesAdmin />;
  if (parsed.route === 'owner-tasks') return <OwnerTasks />;
  if (parsed.route === 'owner-reminders') return <OwnerReminders />;
  if (parsed.route === 'owner-progress')  return <OwnerProgress />;
  if (parsed.route === 'owner-audit') return <OwnerAudit />;
  if (parsed.route === 'owner-email-templates') return <OwnerEmailTemplates />;
  if (parsed.route === 'owner-workflows') return <OwnerRelationshipWorkflows />;
  if (parsed.route === 'owner-services') return <OwnerRelationshipTypes />;
  if (parsed.route === 'owner-setup') return <OwnerSetup />;
  if (parsed.route === 'owner-whatsapp') return <OwnerWhatsApp />;
  if (parsed.route === 'employee-help') return <EmployeeHelp />;
  if (parsed.route === 'employee-inbox') return <EmployeeInbox />;
  if (parsed.route === 'owner-dashboard') return <OwnerDashboard />;
  return <OwnerDashboard />;
}

// Phase 5: platform subtree. Mounts the TaxPlatformAuthProvider — no
// community context here since the platform admin operates cross-tenant.
// Gate behavior is similar to the employee gate but the auth path checks
// against GLOBAL_ADMIN_EMAILS (no DB employee lookup).
function PlatformRoot({ parsed }) {
  return (
    <div className="tax-app">
      <TaxPlatformAuthProvider>
        <PlatformGate parsed={parsed} />
      </TaxPlatformAuthProvider>
    </div>
  );
}

function PlatformGate({ parsed }) {
  const { status, error, signIn, signOut } = useTaxPlatformAuth();

  if (status === 'unauthenticated') {
    return (
      <div className="tax-fullscreen">
        <div className="tax-fullscreen__inner" style={{ maxWidth: 460 }}>
          <h2 style={{ marginTop: 0 }}>Platform admin sign-in</h2>
          <p style={{ color: 'var(--tax-muted)' }}>
            This area is restricted to platform administrators (emails listed in <code>GLOBAL_ADMIN_EMAILS</code>).
          </p>
          <button type="button" className="tax-btn tax-btn--primary tax-btn--block"
                  onClick={signIn} disabled={!firebaseReady}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || status === 'verifying') {
    return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">Loading…</div></div>;
  }
  if (status === 'error') {
    return (
      <div className="tax-fullscreen">
        <div className="tax-fullscreen__inner" style={{ maxWidth: 460 }}>
          <div className="tax-msg tax-msg--error" role="alert" style={{ textAlign: 'left' }}>
            <strong>Platform admin access denied</strong>
            <div style={{ marginTop: 6 }}>{error || 'Your email is not listed in GLOBAL_ADMIN_EMAILS.'}</div>
          </div>
          <button type="button" className="tax-btn tax-btn--primary" style={{ marginTop: 16 }} onClick={signOut}>
            Try a different account
          </button>
        </div>
      </div>
    );
  }
  if (parsed.route === 'platform-create') return <PlatformCommunityCreate />;
  return <PlatformDashboard />;
}

// Phase 4n.18: shared sign-in error block for both the customer portal and
// the staff portal. When the server returned a `wrong_portal` payload, the
// auth provider stashes a redirectTo — we render a prominent "Go to the
// correct portal" CTA so the user isn't stuck with just "Try a different
// account". The fallback wording covers every other 403 (not provisioned,
// account collision, etc.).
function SignInProblem({ error, redirectTo, signOut }) {
  const isWrongPortal = !!redirectTo;
  return (
    <div className="tax-fullscreen">
      <div className="tax-fullscreen__inner" style={{ maxWidth: 480 }}>
        <div className="tax-msg tax-msg--error" role="alert" style={{ textAlign: 'left' }}>
          <strong>{isWrongPortal ? 'Sign in at a different portal' : 'Sign-in problem'}</strong>
          <div style={{ marginTop: 6 }}>{error}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {isWrongPortal && (
            <a href={redirectTo} className="tax-btn tax-btn--primary"
               style={{ textDecoration: 'none' }}>
              Go to the right portal
            </a>
          )}
          <button type="button"
                  className={isWrongPortal ? 'tax-btn tax-btn--ghost' : 'tax-btn tax-btn--primary'}
                  onClick={signOut}>
            Try a different account
          </button>
        </div>
      </div>
    </div>
  );
}
