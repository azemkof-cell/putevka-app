// Путёвка service worker: keeps the driver's waybills available without a network.
const STATIC = 'pv-static-v4';
const PAGES = 'pv-pages-v1';
const PRECACHE = ['/offline', '/app.css?v=4', '/app.js?v=4', '/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![STATIC, PAGES].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data === 'logout') caches.delete(PAGES);
});

// Driver pages: network first, remember the last good copy for offline use.
const keepOffline = (path) => path === '/d' || path.startsWith('/d/sheet/') || path === '/d/print-week';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (keepOffline(url.pathname) && res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(PAGES).then((c) => c.put(url.pathname, copy));
        }
        return res;
      } catch {
        const hit = keepOffline(url.pathname) && (await caches.match(url.pathname, { cacheName: PAGES }));
        return hit || (await caches.match('/offline')) || Response.error();
      }
    })());
    return;
  }

  if (/\.(css|js|png|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(STATIC).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});

// Web Push: the server sends { title, body, url, tag }; a tap opens that page.
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: 'Путёвка', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Путёвка', {
    body: m.body || '', tag: m.tag || undefined, renotify: !!m.tag, data: { url: m.url || '/' },
    icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', lang: 'ru'
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(location.origin));
    return open ? open.navigate(url).then((c) => (c || open).focus()) : self.clients.openWindow(url);
  }));
});
