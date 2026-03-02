const CACHE_NAME = 'quickserve-cache-v4';
const PRECACHE_URLS = [
  './',
  './index10.html',
  './manifest.json',
  './icon.svg',
  './service-worker.js'
];
const EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  'https://unpkg.com/lucide@latest',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js'
];

async function precacheLocalAssets(cache) {
  await Promise.all(
    PRECACHE_URLS.map((url) =>
      cache.add(url).catch((error) => {
        console.warn(`Local precache failed: ${url}`, error);
      })
    )
  );
}

async function precacheExternalAssets(cache) {
  await Promise.all(
    EXTERNAL_ASSETS.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response && response.ok && response.type !== 'opaque') {
          await cache.put(url, response);
        }
      } catch (error) {
        console.warn(`External precache failed: ${url}`, error);
      }
    })
  );
}

async function warmCache() {
  const cache = await caches.open(CACHE_NAME);
  await precacheLocalAssets(cache);
  await precacheExternalAssets(cache);
}

self.addEventListener('install', (event) => {
  event.waitUntil(warmCache());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const requestUrl = new URL(request.url);

  // Cross-origin requests (Firebase/CDN): network-first with cache fallback.
  // Do not serve opaque responses for module/script CORS requests.
  if (requestUrl.origin !== self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse && !(request.mode === 'cors' && cachedResponse.type === 'opaque')) {
            return cachedResponse;
          }
          throw new Error(`No cached response for ${request.url}`);
        })
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index10.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cachedResponse) => {
      if (cachedResponse && request.mode === 'cors' && cachedResponse.type === 'opaque') {
        cachedResponse = undefined;
      }
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

self.addEventListener('message', (event) => {
  if (!event?.data || event.data.type !== 'WARM_CACHE') return;
  event.waitUntil(warmCache());
});
