// Arquivos pesados dos recursos que rodam no aparelho (hoje: o reconhecimento de gestos da câmera). Não vêm com o
// app: na primeira vez que o recurso é usado, o app busca o `manifest.json` em /api/models (do servidor da conversa,
// depois do servidor principal), baixa cada arquivo, confere o SHA-256 e guarda no IndexedDB. Com o SHA conferido,
// o espelho público (jsDelivr, Google) também serve, se o servidor não tiver os arquivos.
import { useStore } from '../store.js';

const DB = 'padospeak-models';
const STORE = 'files';
/** Manifesto encontrado nesta sessão (por endereço do servidor). */
let found = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Servidores para procurar os arquivos, na ordem: o da conversa aberta, o principal, a página. */
function servers() {
  const list = [];
  const st = useStore.getState();
  if (st.baseUrl != null) list.push(st.baseUrl);
  try {
    if (typeof location !== 'undefined' && /^https?:/.test(location.origin)) list.push(location.origin);
  } catch {}
  return [...new Set(list.filter((u) => u != null))];
}

/** O manifesto (o primeiro servidor que tiver). */
async function manifest() {
  if (found) return found;
  for (const base of servers()) {
    try {
      const res = await fetch(`${base}/api/models/manifest.json`, { cache: 'no-cache' });
      if (!res.ok) continue;
      const m = await res.json();
      if (m?.assets) return (found = { base, assets: m.assets });
    } catch {}
  }
  throw new Error('Os arquivos deste recurso não estão disponíveis neste servidor.');
}

async function fetchVerified(urls, sha256, onProgress) {
  let last = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onProgress?.(got, total);
      }
      const buf = await new Blob(parts).arrayBuffer();
      if (hex(await crypto.subtle.digest('SHA-256', buf)) !== sha256) throw new Error('arquivo diferente do esperado');
      return buf;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Não deu para baixar: ${last?.message || 'sem conexão'}`);
}

/**
 * Os arquivos pedidos (`ids` do manifesto) como `{ id: ArrayBuffer }`: do IndexedDB se já foram baixados, senão
 * baixados agora. `onProgress(fração)` acompanha o download.
 */
export async function loadAssets(ids, onProgress) {
  const m = await manifest();
  let db = null;
  try {
    db = await openDb();
  } catch {}
  const out = {};
  const missing = [];
  for (const id of ids) {
    const a = m.assets[id];
    if (!a) throw new Error('O servidor tem uma versão diferente deste recurso.');
    const hit = db && (await tx(db, 'readonly', (s) => s.get(a.sha256)).catch(() => null));
    if (hit?.buf) out[id] = hit.buf;
    else missing.push([id, a]);
  }
  if (missing.length) {
    try {
      await navigator.storage?.persist?.();
    } catch {}
    const total = missing.reduce((n, [, a]) => n + a.size, 0) || 1;
    let done = 0;
    for (const [id, a] of missing) {
      const urls = [`${m.base}/api/models/${a.file}`, a.mirror].filter(Boolean);
      const buf = await fetchVerified(urls, a.sha256, (got) => onProgress?.(Math.min(1, (done + got) / total)));
      done += a.size;
      out[id] = buf;
      if (db) await tx(db, 'readwrite', (s) => s.put({ buf, id, size: a.size, at: Date.now() }, a.sha256)).catch(() => {});
    }
    // versões antigas (o servidor atualizou o recurso) saem
    if (db) {
      const keep = new Set(Object.values(m.assets).map((a) => a.sha256));
      const keys = await tx(db, 'readonly', (s) => s.getAllKeys()).catch(() => []);
      const old = (keys || []).filter((k) => !keep.has(k));
      if (old.length) await tx(db, 'readwrite', (s) => old.forEach((k) => s.delete(k))).catch(() => {});
    }
  }
  onProgress?.(1);
  return out;
}

/** O que está guardado: `[{ id, size }]`. */
export async function storageInfo() {
  try {
    const db = await openDb();
    const all = await tx(db, 'readonly', (s) => s.getAll());
    return (all || []).map((r) => ({ id: r.id, size: r.size || r.buf?.byteLength || 0 }));
  } catch {
    return [];
  }
}

/** Apaga tudo o que foi baixado (baixa de novo quando precisar). */
export async function removeAll() {
  found = null;
  try {
    const db = await openDb();
    await tx(db, 'readwrite', (s) => s.clear());
  } catch {}
}
