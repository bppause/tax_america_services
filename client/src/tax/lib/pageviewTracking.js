// Anonymous page-view tracking for the public marketing site only —
// Landing, PublicFaqs, PublicArticles, PublicCalendar. Never the
// authenticated customer or employee portals, which have their own
// separate tracking (see EmployeeShell.jsx's activity-ping effect).
// Feeds the owner-facing Website Metrics dashboard
// (OwnerWebsiteMetrics.jsx / GET /admin/website-metrics/summary).
//
// No PII: visitorId (persisted in localStorage, so repeat visits count
// as the same person) and sessionId (per-tab, sessionStorage) are random
// ids generated here and never tied to a name, email, or IP on the
// server.

import { useEffect } from 'react';
import { taxApi } from '../api';

const VISITOR_KEY = 'tax.visitorId';
const SESSION_KEY = 'tax.sessionId';

function randomId() {
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch (_e) { /* ignore */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreate(storage, key) {
  try {
    const existing = storage.getItem(key);
    if (existing) return existing;
    const id = randomId();
    storage.setItem(key, id);
    return id;
  } catch (_e) {
    return randomId();
  }
}

// `page` is one of 'landing' | 'faqs' | 'articles' | 'calendar' — the
// server rejects anything else. Fires once per mount; best-effort, so a
// failed ping never surfaces to the visitor.
export function usePageviewPing(communitySlug, page) {
  useEffect(() => {
    if (!communitySlug || !page) return;
    const visitorId = getOrCreate(window.localStorage, VISITOR_KEY);
    const sessionId = getOrCreate(window.sessionStorage, SESSION_KEY);
    taxApi.publicPageview({
      communitySlug, page,
      path: window.location.pathname,
      visitorId, sessionId,
      referrer: document.referrer || '',
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communitySlug, page]);
}
