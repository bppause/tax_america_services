import { createContext, useContext, useMemo } from 'react';
import { useT } from '../i18n';

// Public-landing copy override layer. The community row carries an
// optional landing_copy_i18n JSONB blob keyed by the same i18n string
// keys the components otherwise read from the bundled translations.
// When an entry exists for the current locale, it replaces the
// bundled default; when it's missing or empty, the bundle wins.
//
// Components that render owner-overridable copy should call
// useLandingCopy().pick(key) instead of useT().t(key). The hook
// gracefully no-ops outside the provider (e.g., portal pages) by
// falling through to t().

const Ctx = createContext(null);

export function LandingCopyProvider({ community, children }) {
  const { locale, t } = useT();
  const value = useMemo(() => {
    const copy = community?.landing_copy_i18n || {};
    const pick = (key) => {
      const entry = copy[key];
      if (entry && typeof entry === 'object') {
        const v = locale === 'es' ? entry.es : entry.en;
        if (typeof v === 'string' && v.trim()) return v;
      }
      return t(key);
    };
    return { pick };
  }, [community, locale, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLandingCopy() {
  const { t } = useT();
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return { pick: (k) => t(k) };
}
