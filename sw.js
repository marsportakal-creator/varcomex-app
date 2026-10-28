/*
 * Service worker: yalnızca arayüz dosyalarını önbelleğe alır (uygulama çevrimdışı da açılır).
 * MQTT.js (CDN) ve MQTT bağlantısı önbelleğe alınmaz. Dosyalar değişince SURUM'u artır.
 */
const SURUM = 'varcomex-ui-v2';
const DOSYALAR = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SURUM).then((c) => c.addAll(DOSYALAR)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((adlar) => Promise.all(adlar.filter((a) => a !== SURUM).map((a) => caches.delete(a))))
      .then(() => self.clients.claim())
  );
});

// Ayni kaynaktaki arayuz dosyalari: once ag (guncel surum), ag yoksa onbellek.
// Baska kaynaklar (CDN, MQTT) hic ellenmez.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((yanit) => {
        const kopya = yanit.clone();
        if (yanit.ok) caches.open(SURUM).then((c) => c.put(e.request, kopya));
        return yanit;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
