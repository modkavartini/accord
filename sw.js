/* Accord service worker — makes repeat loads (and the Android app's WebView)
 * near-instant by serving the static shell from a cache while revalidating in
 * the background. The dynamic bits — Firestore, the parse-form function, the
 * update manifest, the APK — always go straight to the network so nothing
 * stale is ever served for data.
 *
 * Bump VERSION when the caching structure changes; individual assets don't
 * need it because they're revalidated on every fetch (stale-while-revalidate).
 */
const VERSION = 'accord-v1';
const SHELL_CACHE   = `${VERSION}-shell`;   // same-origin HTML/CSS/JS
const VENDOR_CACHE  = `${VERSION}-vendor`;  // Firebase SDK + Google Fonts

// Critical shell precached on install so the very first gate/dashboard open
// after an install is already warm. Everything else is cached on first use.
const PRECACHE = [
  '/css/style.css',
  '/js/gate.js',
  '/js/firebase-core.js',
  '/js/firestore-rest.js',
  '/js/match.js',
  '/js/firebase.js',
  '/js/dashboard.js',
  '/js/app-shell.js',
  '/gate.html',
  '/dashboard.html',
  '/public/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // allSettled, not addAll: one missing/renamed asset must not abort install.
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, VENDOR_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Hosts whose responses are safe to cache (versioned or effectively static).
const VENDOR_HOSTS = new Set([
  'www.gstatic.com',        // Firebase SDK modules (pinned to /10.12.2/)
  'fonts.googleapis.com',   // font CSS
  'fonts.gstatic.com',      // font files
]);

// Never cache these — they're per-request data or must stay fresh.
function isDynamic(url) {
  return (
    url.hostname.endsWith('.googleapis.com') ||  // Firestore, Identity Toolkit, etc.
    url.pathname.startsWith('/.netlify/') ||     // parse-form, api, reader-status
    url.pathname === '/app-release.json' ||      // OTA update manifest
    url.pathname.startsWith('/download/')         // the APK
  );
}

// Serve from cache immediately, refresh the cache in the background.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      // Cache opaque (cross-origin, no-CORS) and OK responses; skip errors.
      if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || network || fetch(request);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Data / functions / manifest / APK: straight to network, no interception.
  if (isDynamic(url)) return;

  // Vendored SDK + fonts: cache across visits (the big first-load cost).
  if (VENDOR_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, VENDOR_CACHE));
    return;
  }

  // Our own origin: shell assets + HTML documents.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // Anything else (rare): default network handling.
});
