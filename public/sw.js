// Cache only the public application shell. Room/API/signaling responses and
// invitation URLs must never be persisted. A call always needs a live server.
const CACHE = 'tongping-shell-1.1.1';
const SHELL = ['/', '/styles.css', '/app.js', '/rtc.js', '/audio-meter.js', '/favicon.svg', '/app.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('tongping-shell-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search || url.hash || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(request).then(async (response) => {
    if (response.ok) {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      } catch { /* A full or unavailable cache must not block online use. */ }
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    return cached || new Response('请联网后重新打开同屏。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
