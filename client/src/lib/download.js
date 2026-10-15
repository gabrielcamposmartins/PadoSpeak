// Downloads com retorno visual: o app baixa o arquivo (para saber o progresso e quando termina) e
// depois entrega ao navegador para salvar. Arquivos enormes vão direto pelo navegador (não cabem na memória).
import { useSyncExternalStore } from 'react';
import { isTouch } from './layout.js';

const MAX_IN_MEMORY = (isTouch ? 300 : 1536) * 1024 * 1024;

const active = new Map(); // url -> { name, loaded, total }
let snapshot = [];
const listeners = new Set();
const emit = () => {
  snapshot = [...active.entries()].map(([url, d]) => ({ url, ...d }));
  listeners.forEach((f) => f());
};
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Downloads em andamento: `[{ url, name, loaded, total }]`. */
export const useDownloads = () => useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

/** Andamento do download deste endereço (ou null). */
export const useDownload = (url) => useDownloads().find((d) => d.url === url) || null;

/** Porcentagem baixada (ou null se o tamanho não é conhecido). */
export const percent = (d) => (d?.total ? Math.min(99, Math.floor((d.loaded / d.total) * 100)) : null);

const save = (href, name) => {
  const a = Object.assign(document.createElement('a'), { href, download: name, rel: 'noopener' });
  document.body.append(a);
  a.click();
  a.remove();
};

/** Baixa `url` como `name` (`size`: tamanho esperado, para o progresso). */
export async function startDownload(url, name, size = 0) {
  if (active.has(url)) return;
  if (size > MAX_IN_MEMORY || typeof ReadableStream === 'undefined') return save(url, name);
  active.set(url, { name, loaded: 0, total: size });
  emit();
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(String(res.status));
    // Arquivo guardado comprimido chega com o tamanho comprimido no cabeçalho: vale o tamanho real.
    const total = size || Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (Date.now() - last > 120) {
        last = Date.now();
        active.set(url, { name, loaded, total });
        emit();
      }
    }
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
    const obj = URL.createObjectURL(blob);
    save(obj, name);
    setTimeout(() => URL.revokeObjectURL(obj), 60_000);
  } catch {
    // Não deu pelo app: o navegador baixa sozinho.
    save(url, name);
  } finally {
    active.delete(url);
    emit();
  }
}
