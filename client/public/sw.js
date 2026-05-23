// Tax America service worker (Phase 4n.61).
//
// Strategy:
//   • App-shell precache — install snapshots the bundle list at first
//     load (root HTML + manifest + logo); future loads serve them from
//     cache so a tab that opens on a flaky connection still gets
//     interactive UI within milliseconds.
//   • Runtime cache — same-origin GETs for static assets (built JS /
//     CSS / images under /assets/) get a stale-while-revalidate fetch:
//     return the cached copy immediately, refresh it in the
//     background for next time.
//   • API calls and POST/PUT/DELETE never hit the SW cache. We let
//     them fail when offline so the UI can surface a real error
//     instead of pretending a write succeeded.
//   • Offline navigation fallback — when a navigation request fails
//     (no network), serve the cached root document so the SPA can
//     render its own "you're offline" state.

const VERSION = 'v1';
const APP_CACHE = `tax-app-${VERSION}`;
const RUNTIME_CACHE = `tax-rt-${VERSION}`;
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/tax/tax-america-services-logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* offline first-load — fine, runtime fetches will warm the cache */ })
  );
});

self.addEventListener('activate', (event) => {
  // Drop old caches whose version doesn't match the current SW.
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== APP_CACHE && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}
function isStaticAsset(url) {
  return url.pathname.startsWith('/assets/') ||
         url.pathname.endsWith('.css') ||
         url.pathname.endsWith('.js')  ||
         url.pathname.endsWith('.svg') ||
         url.pathname.endsWith('.png') ||
         url.pathname.endsWith('.jpg') ||
         url.pathname.endsWith('.webp') ||
         url.pathname.endsWith('.woff2');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                  // never cache writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // pass-through cross-origin
  if (isApiRequest(url)) return;                     // never cache API responses

  // Navigation requests — try network first, fall back to the cached
  // root document so an offline reload still boots the SPA.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/') || caches.match(req))
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const networkFetch = fetch(req).then(resp => {
          if (resp && resp.status === 200) cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);  // offline — fall back to cache
        return cached || networkFetch;
      })
    );
  }
});

// Allow the page to nudge the SW to skip waiting + activate immediately
// after a refresh. Useful when shipping a new bundle and the user
// already has the app open.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
