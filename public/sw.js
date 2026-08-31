const CACHE = 'xo-arena-v5';
const ASSETS = ['/', '/index.html', '/css/style.css', '/manifest.json', '/icons/icon.svg',
  '/js/engine.js', '/js/ai.js', '/js/storage.js', '/js/audio.js', '/js/net.js', '/js/ui.js', '/js/app.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api')) return;  // ต้องสดเสมอ
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match('/index.html'))));
});