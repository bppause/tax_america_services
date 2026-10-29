// Employee auth context (Phase 3).
//
// Parallel to the customer-side AuthProvider but operates against
// /employee/auth/link + /employee/me. Same Firebase project — the route
// you visit determines which provider mounts (/portal/* mounts the
// customer provider; /employee/* mounts this one).
//
// Impersonation: when sessionStorage holds an active impersonation state
// targeting an employee, we skip Firebase entirely and fetch /employee/me
// using the impersonation token.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { onTaxAuthChanged, signOutTax, signInWithGoogle, firebaseReady } from './firebase';
import { taxApi, getImpersonation, clearImpersonation, setEmployeeSessionToken, clearEmployeeSessionToken } from '../api';

const EmpAuthCtx = createContext({
  fbUser: null, employee: null, community: null,
  status: 'loading', error: '',
  impersonation: null,
  signOut: () => {},
  switchAccount: () => {},
  refreshMe: () => {},
  exitImpersonation: () => {},
});

export function TaxEmployeeAuthProvider({ communitySlug, children }) {
  const [fbUser, setFbUser] = useState(null);
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState(firebaseReady ? 'loading' : 'error');
  const [error, setError] = useState(firebaseReady ? '' : 'Firebase is not configured.');
  // Phase 4n.18: stashed redirect when the server says this email belongs
  // to the customer portal instead.
  const [redirectTo, setRedirectTo] = useState('');
  const [impersonation, setImpersonationState] = useState(() => {
    const imp = getImpersonation();
    return imp && imp.targetType === 'employee' ? imp : null;
  });

  useEffect(() => {
    if (!firebaseReady || impersonation) return;
    const unsub = onTaxAuthChanged((user) => {
      setFbUser(user);
      if (!user) { setMe(null); setStatus('unauthenticated'); setError(''); }
    });
    return () => { try { unsub(); } catch (_e) {} };
  }, [impersonation]);

  useEffect(() => {
    if (impersonation) return;
    if (!fbUser) return;
    let cancelled = false;
    setStatus('linking'); setError(''); setRedirectTo('');
    (async () => {
      try {
        const linked = await taxApi.employeeAuthLink({ uid: fbUser.uid, email: fbUser.email, communitySlug });
        // Store the per-device token BEFORE the next call, so getEmployeeMe
        // (and everything after) already carries it as x-tax-session.
        setEmployeeSessionToken(linked?.sessionToken);
        const data = await taxApi.getEmployeeMe({ uid: fbUser.uid, email: fbUser.email, communitySlug });
        if (cancelled) return;
        setMe(data); setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setMe(null);
        setStatus('error');
        if (err?.body?.error === 'wrong_portal') {
          setError(err.body.message || 'You have an account in a different role at this practice.');
          setRedirectTo(err.body.redirectTo || '');
        } else {
          setError(err?.message || 'Could not link your staff account.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [fbUser, communitySlug, impersonation]);

  useEffect(() => {
    if (!impersonation) return;
    let cancelled = false;
    setStatus('linking'); setError('');
    (async () => {
      try {
        const data = await taxApi.getEmployeeMe({ uid: '', email: '', communitySlug: impersonation.communitySlug });
        if (cancelled) return;
        setMe(data); setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        clearImpersonation();
        setImpersonationState(null);
        setMe(null);
        setStatus('error');
        setError(err?.message || 'Impersonation session ended.');
      }
    })();
    return () => { cancelled = true; };
  }, [impersonation]);

  // An admin force-logged this device out (see GET/POST /admin/employee-
  // sessions* and the Staff page). api.js dispatches this the moment any
  // request comes back 401 session_revoked — fires at most once per page
  // load in practice (once signed out, there's no auth header left to
  // trigger it again) but a tight re-entrancy guard isn't worth the code.
  useEffect(() => {
    if (impersonation) return;
    const onRevoked = () => {
      signOutTax().catch(() => {});
      window.location.href = `/tax/${communitySlug}/employee`;
    };
    window.addEventListener('tax:session-revoked', onRevoked);
    return () => window.removeEventListener('tax:session-revoked', onRevoked);
  }, [impersonation, communitySlug]);

  const refreshMe = useCallback(async () => {
    if (impersonation) {
      try { const data = await taxApi.getEmployeeMe({ communitySlug: impersonation.communitySlug }); setMe(data); }
      catch (_e) {}
      return;
    }
    if (!fbUser) return;
    try {
      const data = await taxApi.getEmployeeMe({ uid: fbUser.uid, email: fbUser.email, communitySlug });
      setMe(data);
    } catch (_e) {}
  }, [fbUser, communitySlug, impersonation]);

  const signOut = useCallback(async () => {
    if (impersonation) {
      clearImpersonation();
      setImpersonationState(null);
      window.location.href = `/tax/${impersonation.communitySlug}/employee`;
      return;
    }
    // Best-effort — so this device's row stops showing as "active" in an
    // admin's "who's logged in where" list right away instead of only
    // going stale after several minutes of no further requests.
    try { await taxApi.employeeAuthSignOut({ uid: fbUser?.uid, email: fbUser?.email, communitySlug }); } catch (_e) {}
    clearEmployeeSessionToken();
    try { await signOutTax(); } catch (_e) {}
    setFbUser(null); setMe(null); setStatus('unauthenticated');
  }, [impersonation, fbUser, communitySlug]);

  // One-click "log out and log in as another user": signs out of the
  // current Firebase session, then immediately reopens the Google account
  // picker (prompt=select_account, set in firebase.js) instead of leaving
  // the operator to sign out and separately click "Sign in" again. Not
  // offered during impersonation — that has its own exit flow above.
  const switchAccount = useCallback(async () => {
    if (impersonation) return;
    try { await taxApi.employeeAuthSignOut({ uid: fbUser?.uid, email: fbUser?.email, communitySlug }); } catch (_e) {}
    clearEmployeeSessionToken();
    try { await signOutTax(); } catch (_e) {}
    setFbUser(null); setMe(null); setStatus('unauthenticated');
    try { await signInWithGoogle(); } catch (_e) { /* picker closed/cancelled — stay signed out */ }
  }, [impersonation, fbUser, communitySlug]);

  const exitImpersonation = useCallback(async () => {
    if (!impersonation) return;
    const { token, communitySlug: cs, realAdminEmail, realAdminUid } = impersonation;
    try {
      await taxApi.adminEndImpersonation(
        { uid: realAdminUid, email: realAdminEmail, adminEmail: realAdminEmail, communitySlug: cs },
        token,
      );
    } catch (_e) {}
    clearImpersonation();
    setImpersonationState(null);
    // Stay on /employee — page reload picks up the real Firebase admin session.
    window.location.href = `/tax/${cs}/employee`;
  }, [impersonation]);

  const value = {
    fbUser,
    employee: me?.employee || null,
    community: me?.community || null,
    assignments: me?.assignments || [],
    // customerAccess: { hasCustomerRow } — set when this employee's email
    // is ALSO a tax_customers row for the same community. Surfaces a
    // "Switch to customer view" link in EmployeeShell.
    customerAccess: me?.customerAccess || { hasCustomerRow: false },
    impersonation,
    status, error, redirectTo,
    signOut, switchAccount, refreshMe, exitImpersonation,
  };
  return <EmpAuthCtx.Provider value={value}>{children}</EmpAuthCtx.Provider>;
}

export function useEmployeeAuth() { return useContext(EmpAuthCtx); }
