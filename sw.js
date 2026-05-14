const CACHE = 'scores-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './drive.js',
  './stats.js',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first pour les API Google, cache-first pour le shell
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Laisser passer les requêtes Google sans interception
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('googleusercontent.com')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Mettre en cache les ressources locales récupérées
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
