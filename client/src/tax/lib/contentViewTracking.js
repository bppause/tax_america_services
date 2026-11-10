// Per-item engagement tracking for the public marketing site — which
// individual services and articles a visitor opens, and how long they
// kept it open. Separate concern from pageviewTracking.js (which only
// tracks the containing page), feeding the same owner-facing Website
// Metrics dashboard's engagement section
// (OwnerWebsiteMetrics.jsx / GET /admin/content-engagement/summary).
//
// No PII — same anonymous visitorId/sessionId as pageviewTracking.js
// (deliberately not re-exported from there to keep these two trackers
// independent; both just read the same localStorage/sessionStorage keys).

import { useEffect, useRef } from 'react';
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

function sendPing(communitySlug, kind, itemId, event, durationMs) {
  const visitorId = getOrCreate(window.localStorage, VISITOR_KEY);
  const sessionId = getOrCreate(window.sessionStorage, SESSION_KEY);
  taxApi.publicContentView({ communitySlug, kind, itemId, event, durationMs, visitorId, sessionId }).catch(() => {});
}

// `kind` is 'service' | 'article'. `isOpen` is whether this particular
// item is currently the one being viewed — for a modal-based item (a
// service's detail popup), call this once inside the modal with
// isOpen=true, so mount sends the 'click' and unmount sends the
// 'close'+duration. For a toggle-based item (an inline-expanding
// article), call this once per item with isOpen bound to that item's
// own expanded state — switching to a different item flips this one
// back to false and fires its close in the same render.
export function useContentViewTracking(communitySlug, kind, itemId, isOpen) {
  const openedAtRef = useRef(null);

  useEffect(() => {
    if (!communitySlug || !itemId) return;
    if (isOpen) {
      openedAtRef.current = Date.now();
      sendPing(communitySlug, kind, itemId, 'click');
    } else if (openedAtRef.current) {
      const durationMs = Date.now() - openedAtRef.current;
      openedAtRef.current = null;
      sendPing(communitySlug, kind, itemId, 'close', durationMs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communitySlug, kind, itemId, isOpen]);

  // Catches the modal-unmount case (isOpen never flips to false — the
  // component is just removed) and the "navigated away while still
  // open" case for the toggle-based usage.
  useEffect(() => () => {
    if (openedAtRef.current) {
      const durationMs = Date.now() - openedAtRef.current;
      openedAtRef.current = null;
      sendPing(communitySlug, kind, itemId, 'close', durationMs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
