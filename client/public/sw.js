// Service worker do PadoSpeak instalado (PWA): abre a interface na hora mesmo com a rede lenta e
// mostra as notificações push com o app fechado.
const CACHE = 'padospeak-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // API, WebSocket e música sempre pela rede.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  // A página: rede primeiro (sempre a versão nova); sem rede, a última que abriu.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  // Arquivos com hash no nome, ícones e telas de abertura não mudam: cache primeiro.
  if (/^\/(assets|icons|splash)\//.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    (async () => {
      await self.registration.showNotification(d.title || 'PadoSpeak', {
        body: d.body || '',
        tag: d.tag,
        renotify: Boolean(d.tag),
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: d.url || '/' },
      });
      // Número no ícone: quantos avisos estão esperando.
      if (self.navigator.setAppBadge) {
        const pending = await self.registration.getNotifications();
        self.navigator.setAppBadge(pending.length).catch(() => {});
      }
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: 'open', url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
