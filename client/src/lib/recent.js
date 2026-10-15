// Arquivos recentes deste aparelho (para o menu rápido do clipe no celular): o que veio pelo
// "Compartilhar", imagens coladas e fotos/vídeos da câmera. Ficam só aqui (IndexedDB), por 7 dias.
const DB = 'padospeak-recent';
const STORE = 'files';
const MAX_ITEMS = 12;
const MAX_FILE = 25 * 1024 * 1024;
const MAX_AGE = 7 * 86400000;

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('sem IndexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const run = async (mode, fn) => {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out?.result ?? out);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
};

/** Os recentes, do mais novo para o mais velho: `[{ id, name, type, size, at, source, blob }]`. */
export async function listRecent() {
  try {
    const all = (await run('readonly', (s) => s.getAll())) || [];
    const fresh = all.filter((f) => Date.now() - f.at < MAX_AGE).sort((a, b) => b.at - a.at);
    const old = all.filter((f) => !fresh.slice(0, MAX_ITEMS).includes(f));
    if (old.length) run('readwrite', (s) => old.forEach((f) => s.delete(f.id))).catch(() => {});
    return fresh.slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

/** Guarda arquivos como recentes. `source`: 'compartilhado' | 'colado' | 'câmera'. */
export async function addRecent(files, source) {
  const items = files
    .filter((f) => f.size <= MAX_FILE)
    .map((f, i) => ({ id: `${Date.now()}-${i}-${f.name}`, name: f.name, type: f.type, size: f.size, at: Date.now() + i, source, blob: f }));
  if (!items.length) return;
  try {
    const all = (await run('readonly', (s) => s.getAll())) || [];
    // o mesmo arquivo de novo só sobe para o topo
    const dupes = all.filter((a) => items.some((f) => f.name === a.name && f.size === a.size));
    await run('readwrite', (s) => {
      dupes.forEach((d) => s.delete(d.id));
      items.forEach((f) => s.put(f));
    });
    await listRecent();
  } catch {
    /* sem recentes neste navegador */
  }
}
