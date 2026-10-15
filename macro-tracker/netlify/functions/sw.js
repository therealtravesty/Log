// Lōg service worker
//
// Speed: the app opens from the copy saved on the phone (no waiting on the
// network), then checks for a newer version in the background. When a new
// deploy is found, the open app shows "Update ready — tap to refresh"; if the
// app isn't open, the new version is simply used on the next launch.

const SHELL_CACHE = 'log-shell-v3';      // the app page itself
const STATIC_CACHE = 'log-static-v3';    // fonts, Chart.js (versioned URLs)
const STATIC_ASSETS = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

// ── Install: save the app page + static assets ────────────────────
self.addEventListener('install', event => {
  event.waitUntil(Promise.all([
    caches.open(SHELL_CACHE).then(c => c.add(new Request('/index.html', { cache: 'no-store' })).catch(() => {})),
    caches.open(STATIC_CACHE).then(c => Promise.allSettled(STATIC_ASSETS.map(u => c.add(u).catch(() => {})))),
  ]).then(() => self.skipWaiting()));
});

// ── Activate: drop caches from older versions ─────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== STATIC_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function notifyClients(msg) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => c.postMessage(msg));
}

// ── Fetch ─────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. API — always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) {
    event.respondWith(fetch(req));
    return;
  }

  // 2. The app page — serve the saved copy instantly, refresh it in the background.
  //    The saved copy is read fully into memory BEFORE the background refresh
  //    replaces it; replacing a cache entry while it's still being read can
  //    stall the page load.
  if (url.origin === self.location.origin && (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('/index.html');
      const cachedText = cached ? await cached.text() : null;
      const refresh = (async () => {
        try {
          const res = await fetch('/index.html', { cache: 'no-store' });
          if (!res.ok) return null;
          const text = await res.text();
          if (text !== cachedText) {
            await cache.put('/index.html', new Response(text, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
            if (cachedText != null) notifyClients({ type: 'NEW_VERSION' });
          }
          return text;
        } catch (_) { return null; }
      })();
      event.waitUntil(refresh);
      const html = cachedText != null ? cachedText : await refresh;   // first visit waits for the network
      if (html == null) return fetch(req);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    })());
    return;
  }

  // 3. Other same-origin files (manifest, icons, sw.js) — network, cache as fallback
  if (url.origin === self.location.origin) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // 4. External CDN assets (fonts, Chart.js) — cache first
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res.ok && (url.hostname.includes('cdnjs') || url.hostname.includes('fonts.g') || url.hostname.includes('jsdelivr'))) {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});

// ── Background sync ───────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'macro-sync') event.waitUntil(flushSyncQueue());
});

async function flushSyncQueue() {
  const db = await openDB();
  const queue = await getAllPending(db);
  if (!queue.length) return;
  await Promise.allSettled(queue.map(async item => {
    const res = await fetch(item.url, {
      method: item.method,
      headers: { 'Content-Type': 'application/json' },
      body: item.body ? JSON.stringify(item.body) : undefined,
    });
    if (res.ok) await deletePending(db, item.id);
  }));
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE' }));
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('macro-sync-queue', 1);
    req.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains('queue'))
        e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readonly');
    const req = tx.objectStore('queue').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function deletePending(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    const req = tx.objectStore('queue').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
