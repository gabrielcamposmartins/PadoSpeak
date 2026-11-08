// Cache das imagens dos stickers neste aparelho (IndexedDB), para não baixar tudo de novo a cada vez que o app
// abre. Um sticker nunca muda (o id vem da própria imagem), então o que foi baixado vale para sempre; os menos
// usados saem quando o cache passa do limite.
const DB = 'padospeak-stickers';
const STORE = 'img';
const MAX_BYTES = 150 * 1024 * 1024;
const MAX_ITEMS = 800;

/** Endereço da imagem → URL do blob já aberta nesta sessão. */
const opened = new Map();
const loading = new Map();
let dbPromise = null;
let writes = 0;

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('sem IndexedDB'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueado'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Tira os menos usados quando o cache passa do limite (roda de vez em quando, depois de gravar). */
async function trim(db) {
  const items = [];
  await tx(db, 'readonly', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      items.push({ key: c.key, at: c.value.at || 0, size: c.value.blob?.size || 0 });
      c.continue();
    };
  });
  items.sort((a, b) => b.at - a.at);
  let total = 0;
  const drop = items.filter((it, i) => (total += it.size) > MAX_BYTES || i >= MAX_ITEMS);
  if (drop.length) await tx(db, 'readwrite', (s) => drop.forEach((it) => s.delete(it.key)));
}

/** URL da imagem já aberta nesta sessão (para mostrar na hora, sem esperar), ou null. */
export const stickerUrlNow = (src) => opened.get(src) || null;

/**
 * URL (blob) da imagem do sticker: do cache deste aparelho ou baixada (e guardada). Sem IndexedDB, devolve o
 * próprio endereço. Rejeita se o sticker não existe mais.
 */
export function stickerUrl(src) {
  if (opened.has(src)) return Promise.resolve(opened.get(src));
  if (loading.has(src)) return loading.get(src);
  const job = (async () => {
    let db = null;
    try {
      db = await openDb();
      const hit = await tx(db, 'readonly', (s) => s.get(src));
      if (hit?.blob) {
        const url = URL.createObjectURL(hit.blob);
        opened.set(src, url);
        // marca como usado agora (sem esperar)
        tx(db, 'readwrite', (s) => s.put({ ...hit, at: Date.now() }, src)).catch(() => {});
        return url;
      }
    } catch {
      db = null;
    }
    const res = await fetch(src, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`sticker ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('não é imagem');
    const url = URL.createObjectURL(blob);
    opened.set(src, url);
    if (db) {
      tx(db, 'readwrite', (s) => s.put({ blob, at: Date.now() }, src))
        .then(() => (++writes % 20 === 1 ? trim(db) : null))
        .catch(() => {});
    }
    return url;
  })().finally(() => loading.delete(src));
  loading.set(src, job);
  return job;
}

/** Esquece um sticker (apagado da coleção): a próxima vez ele é conferido no servidor. */
export async function forgetSticker(src) {
  const url = opened.get(src);
  opened.delete(src);
  if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
  try {
    const db = await openDb();
    await tx(db, 'readwrite', (s) => s.delete(src));
  } catch {}
}
