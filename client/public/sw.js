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

// "Compartilhar" do Android: guarda o que veio e abre o app, que pergunta para qual conversa mandar.
const SHARE = 'padospeak-share';
async function receiveShare(req) {
  try {
    const form = await req.formData();
    await caches.delete(SHARE);
    const cache = await caches.open(SHARE);
    const files = [];
    for (const [i, f] of form.getAll('files').entries()) {
      if (!f || typeof f === 'string' || !f.size) continue;
      const key = `/__share/file/${i}`;
      await cache.put(key, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
      files.push({ key, name: f.name || `arquivo-${i + 1}`, type: f.type });
    }
    const text = [form.get('title'), form.get('text'), form.get('url')]
      .filter((t) => typeof t === 'string' && t.trim())
      .filter((t, i, all) => all.indexOf(t) === i)
      .join('\n');
    await cache.put('/__share/meta', new Response(JSON.stringify({ text, files }), { headers: { 'content-type': 'application/json' } }));
  } catch {
    /* abre o app mesmo assim */
  }
  return Response.redirect('/?compartilhar=1', 303);
}

// Cores das barras do sistema no app instalado: o Android pinta a barra de navegação (e a de status
// ao abrir) com o `theme_color` do manifesto, que não muda com o tema. O app conta as cores das
// bordas da tela (ver lib/systemBars.js) e o manifesto sai com elas — o Android relê o manifesto
// quando atualiza o app instalado.
const BARS = 'padospeak-bars';
async function themedManifest(req) {
  const res = await fetch(req).catch(() => caches.match('/manifest.webmanifest'));
  if (!res || !res.ok) return res;
  try {
    const saved = await (await caches.open(BARS)).match('/__bars');
    const bars = saved ? await saved.json() : null;
    const manifest = await res.clone().json();
    if (bars?.bottom) manifest.theme_color = bars.bottom;
    if (bars?.background) manifest.background_color = bars.background;
    return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/manifest+json' } });
  } catch {
    return res;
  }
}

self.addEventListener('message', (e) => {
  if (e.data?.type !== 'bars') return;
  const { top, bottom, background } = e.data;
  e.waitUntil(
    caches.open(BARS).then((c) => c.put('/__bars', new Response(JSON.stringify({ top, bottom, background })))),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname === '/compartilhar') {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method === 'GET' && url.origin === location.origin && url.pathname === '/manifest.webmanifest') {
    e.respondWith(themedManifest(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // API, WebSocket e música sempre pela rede.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  // A página: rede primeiro (sempre a versão nova); sem rede, a última que abriu.
  if (req.mode === 'navigate') {
    // Páginas avulsas (privacidade, termos): direto da rede, sem trocar o app guardado.
    if (/^\/(privacidade|termos)(\.html)?$/.test(url.pathname)) return;
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

// Vibração por tipo de aviso (Android; o iPhone usa o som e a vibração do próprio sistema).
const VIBRATE = {
  message: [180, 90, 180],
  nudge: [90, 50, 90, 50, 90, 50, 260],
  call: [900, 500, 900, 500, 900, 500, 900, 500, 900],
  friend: [180, 90, 180],
  guild: [140, 80, 140],
};

/**
 * Ícone da notificação: a foto de quem mandou; sem foto, a inicial na cor da pessoa (como o avatar
 * do app). Sem nada disso, o ícone do PadoSpeak.
 */
async function senderIcon(d) {
  if (d.icon) {
    try {
      const res = await fetch(new URL(d.icon, location.origin));
      if (res.ok) return new URL(d.icon, location.origin).href;
    } catch {
      /* sem rede: a inicial */
    }
  }
  if (!d.initial || typeof OffscreenCanvas === 'undefined') return '/icons/icon-192.png';
  try {
    const size = 192;
    const canvas = new OffscreenCanvas(size, size);
    const g = canvas.getContext('2d');
    const color = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : '#2f8fd8';
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, color);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = color;
    g.globalAlpha = 0.55;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.font = `bold ${size * 0.5}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(d.initial.slice(0, 2), size / 2, size / 2 + size * 0.03);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(bin)}`;
  } catch {
    return '/icons/icon-192.png';
  }
}

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    (async () => {
      const call = d.kind === 'call';
      await self.registration.showNotification(d.title || 'PadoSpeak', {
        body: d.body || '',
        tag: d.tag,
        // Mesma conversa: a notificação nova substitui a anterior e avisa de novo (som e vibração).
        renotify: Boolean(d.tag),
        silent: false,
        vibrate: VIBRATE[d.kind] || VIBRATE.message,
        icon: await senderIcon(d),
        badge: '/icons/badge-96.png',
        timestamp: Date.now(),
        // Chamada: fica na tela até atender ou recusar.
        requireInteraction: call,
        actions: call
          ? [
              { action: 'answer', title: 'Atender' },
              { action: 'decline', title: 'Recusar' },
            ]
          : [],
        data: { url: d.url || '/', kind: d.kind || 'message' },
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
  let url = (e.notification.data && e.notification.data.url) || '/';
  // Chamada: "Atender" abre o app já atendendo; "Recusar" abre e recusa.
  if (e.action === 'answer' || e.action === 'decline') url += `${url.includes('?') ? '&' : '?'}call=${e.action}`;
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
