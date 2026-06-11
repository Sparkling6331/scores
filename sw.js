const CACHE = 'scores-v3';
const STATIC = [
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Laisser passer les requêtes Google Drive/Auth sans interception
  if (
    url.hostname.endsWith('google.com') ||
    url.hostname.endsWith('googleapis.com') ||
    url.hostname.endsWith('googleusercontent.com')
  ) return;

  // Network-first pour HTML, JS, CSS : toujours la version à jour
  const isAppFile = /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isAppFile) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first pour les icônes et assets statiques
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
