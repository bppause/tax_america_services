// Phase 4n.20: shared helper for "last sign-in" badges. Used by customer
// + staff detail pages (kept inline before Phase 4n.20) and by the list
// summary rows. Centralizing here so the format stays consistent across
// every surface admins look at.

export function formatLastSignIn(iso, locale, t) {
  if (!iso) return t('owner.lastSignIn.never');
  try {
    const formatted = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
    return t('owner.lastSignIn.recent', { date: formatted });
  } catch (_e) {
    return t('owner.lastSignIn.recent', { date: iso });
  }
}

// Compact variant for list rows — drops the wrapping "last sign-in" prefix
// so it fits inline with other metadata. Returns just the date (or the
// "never" copy when null).
export function formatLastSignInCompact(iso, locale, t) {
  if (!iso) return t('owner.lastSignIn.neverCompact');
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
      { year: 'numeric', month: 'short', day: 'numeric' })
      .format(new Date(iso));
  } catch (_e) { return iso; }
}

// Date + time, no wrapping text and no "never" fallback (caller decides
// what to show for a null timestamp). Used where knowing *when today*
// something happened matters — e.g. a task's "last viewed" line/tooltip
// — unlike the date-only compact variant above.
export function formatDateTime(iso, locale) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
  } catch (_e) { return iso; }
}
