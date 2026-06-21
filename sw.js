// Camp Utilities — Service Worker
// App document: network-first (always show the latest deployed build when online)
// Static libraries/icons: cache-first (versioned, safe to cache long-term)

const CACHE = 'camp-utils-v8';

const SHELL = [
  './camputilities.html',
  './manifest.json',
  './icon.svg',
  './logo.png',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

// Install: cache everything, then take over immediately
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(SHELL);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activate: delete old caches so a stale build can never be served again
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Decide whether a request is for the app's own HTML document.
function isAppDocument(request) {
  if (request.mode === 'navigate') return true;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return url.pathname === '/' ||
         url.pathname.endsWith('.html') ||
         url.pathname.endsWith('/');
}

self.addEventListener('fetch', function(e) {
  // Skip non-GET and Anthropic API calls (need live network)
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('api.anthropic.com')) return;
  // Never cache the shared backend API — it must always hit the network so
  // records/categories stay in sync across devices.
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;

  // App document → NETWORK-FIRST. This guarantees that a device which once
  // cached an older build still upgrades to the latest deploy whenever it is
  // online, instead of being stuck on a stale "preview" version. The cache is
  // only used as an offline fallback.
  if (isAppDocument(e.request)) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match('./camputilities.html');
        });
      })
    );
    return;
  }

  // Everything else (CDN libraries, icons) → CACHE-FIRST.
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;

      return fetch(e.request).then(function(response) {
        if (response && response.status === 200 && (
          e.request.url.includes('cdn.jsdelivr.net') ||
          e.request.url.includes('cdnjs.cloudflare.com') ||
          e.request.url.includes(self.location.origin)
        )) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match('./camputilities.html');
      });
    })
  );
});
