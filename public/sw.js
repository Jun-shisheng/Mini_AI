/* Offline shell only. API responses, credentials and conversations are never cached. */
// npm run build injects a content-addressed version and integrity-checked static file list.
const BUILD = /* PALM_BUILD_START */ { "version": "source-v2", "files": [] } /* PALM_BUILD_END */;
const CACHE_PREFIX = 'palm-shell-';
const SHELL_CACHE = `${CACHE_PREFIX}${BUILD.version}`;
const SHELL_FILES = new Set([
  '/', '/index.html', '/manifest.webmanifest', '/icons/pet.png',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
]);
const BUILD_FILES = new Map(BUILD.files.map((file) => [file.path, file.integrity]));

function isShellAsset(url) {
  return url.origin === self.location.origin && !url.search && (
    SHELL_FILES.has(url.pathname) || BUILD_FILES.has(url.pathname) ||
    (!BUILD.files.length && /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg|webp)$/.test(url.pathname))
  );
}

function cacheableResponse(response, expectedUrl) {
  return response.ok && response.type !== 'opaque' && !response.redirected &&
    new URL(response.url || expectedUrl).origin === self.location.origin;
}

async function fetchStatic(path) {
  const integrity = BUILD_FILES.get(path);
  const request = new Request(new URL(path, self.location.origin), {
    cache: 'reload', credentials: 'omit', redirect: 'error',
    ...(integrity ? { integrity } : {}),
  });
  const response = await fetch(request);
  if (!cacheableResponse(response, request.url)) throw new Error(`Missing app asset: ${path}`);
  return { request, response };
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const { response } = await fetchStatic('/index.html');
      if (!response.headers.get('content-type')?.includes('text/html')) {
        throw new Error('The app shell is not available for offline caching.');
      }
      const markup = await response.clone().text();
      const assets = new Set([
        ...SHELL_FILES,
        ...BUILD_FILES.keys(),
      ].filter((path) => path !== '/' && path !== '/index.html'));

      // Fallback for an explicitly versioned, manually assembled build. Production uses
      // the complete build manifest, including dynamically imported JavaScript chunks.
      if (!BUILD.files.length) {
        for (const match of markup.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
          const url = new URL(match[1], self.location.origin);
          if (url.pathname.startsWith('/assets/') && isShellAsset(url)) assets.add(url.pathname);
        }
      }
      // This cache belongs only to the installing version. The active worker's cache
      // remains untouched until every new file has loaded and the new worker activates.
      await Promise.all([...assets].map(async (path) => {
        const asset = await fetchStatic(path);
        await cache.put(asset.request, asset.response);
      }));
      await cache.put('/index.html', response.clone());
      await cache.put('/', response);
      // No skipWaiting: do not replace the app underneath an active chat.
    } catch (error) {
      await caches.delete(SHELL_CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Let the network handle every API request, including all auth and chat traffic.
  if (request.method !== 'GET' || url.pathname === '/api' || url.pathname.startsWith('/api/') ||
      !isShellAsset(url)) return;

  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('/index.html');
      // Pin the document to this worker's version. Fetching a newer index into the
      // active cache could pair it with missing chunks and break the next offline launch.
      if (cached) return cached;
      try { return await fetch(request); } catch {
        return new Response('PalmChat 暂时无法连接。请联网后重新打开；聊天内容不会写入离线缓存。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const asset = await fetchStatic(url.pathname);
    await cache.put(asset.request, asset.response.clone());
    return asset.response;
  })());
});
