const CACHE_NAME = 'macro-tracker-v2';

// Only truly static, versioned external assets
const STATIC_ASSETS = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

// ── Install ───────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete ALL old caches so stale HTML never lingers ───
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. API — always network, never touch cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. App shell files (HTML, SW, manifest) — network-first, no caching
  //    Ensures every deploy is picked up immediately on all devices
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 3. External CDN assets (fonts, Chart.js) — cache-first
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
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
