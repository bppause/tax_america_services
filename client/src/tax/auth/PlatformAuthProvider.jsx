// Platform auth context — Phase 5.
//
// Distinct from the customer/employee providers. The platform admin is
// signed in via Firebase (Google) and verified against GLOBAL_ADMIN_EMAILS
// on the server. There's no DB role lookup or per-community state; the
// "identity" is just an email + a verified flag.
//
// Status flow: loading → unauthenticated → verifying → ready (or error).

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { onTaxAuthChanged, signInWithGoogle, signOutTax, firebaseReady } from './firebase';
import { taxApi } from '../api';

const PlatformAuthCtx = createContext({
  switchAccount: () => {},
  fbUser: null,
  email: '',
  status: 'loading',
  error: '',
  signIn: () => {},
  signOut: () => {},
});

export function TaxPlatformAuthProvider({ children }) {
  const [fbUser, setFbUser] = useState(null);
  const [status, setStatus] = useState(firebaseReady ? 'loading' : 'error');
  const [error, setError] = useState(firebaseReady ? '' : 'Firebase is not configured.');

  useEffect(() => {
    if (!firebaseReady) return;
    const unsub = onTaxAuthChanged((user) => {
      setFbUser(user);
      if (!user) { setStatus('unauthenticated'); setError(''); }
    });
    return () => { try { unsub(); } catch (_e) {} };
  }, []);

  // When fbUser appears, verify it against the env-list of platform admins.
  useEffect(() => {
    if (!fbUser) return;
    let cancelled = false;
    setStatus('verifying'); setError('');
    (async () => {
      try {
        await taxApi.platformVerify({ uid: fbUser.uid, email: fbUser.email });
        if (cancelled) return;
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        // 403 = signed in but not authorized; 401 = no creds. Both bubble
        // a clear message so the dashboard can prompt for sign-out.
        setError(err?.message || 'Not authorized for the platform admin area.');
      }
    })();
    return () => { cancelled = true; };
  }, [fbUser]);

  const signIn = useCallback(async () => {
    try { await signInWithGoogle(); }
    catch (e) { setError(e?.message || 'Sign-in failed.'); setStatus('error'); }
  }, []);

  const signOut = useCallback(async () => {
    try { await signOutTax(); } catch (_e) {}
    setFbUser(null); setStatus('unauthenticated');
  }, []);

  // One-click "log out and log in as another user" — signs out, then
  // immediately reopens the Google account picker (prompt=select_account,
  // set in firebase.js) rather than leaving the admin to sign out and
  // separately click "Sign in" again.
  const switchAccount = useCallback(async () => {
    try { await signOutTax(); } catch (_e) {}
    setFbUser(null); setStatus('unauthenticated');
    try { await signInWithGoogle(); }
    catch (e) { setError(e?.message || 'Sign-in failed.'); setStatus('error'); }
  }, []);

  const value = {
    fbUser,
    email: fbUser?.email || '',
    status, error,
    signIn, signOut, switchAccount,
  };
  return <PlatformAuthCtx.Provider value={value}>{children}</PlatformAuthCtx.Provider>;
}

export function useTaxPlatformAuth() { return useContext(PlatformAuthCtx); }
