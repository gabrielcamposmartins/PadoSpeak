// "Compartilhar" do celular (Android, app instalado): o sistema manda o print/arquivo/link para
// /compartilhar; o service worker guarda no cache e abre o app em /?compartilhar=1, e aqui o app pega.
const CACHE = 'padospeak-share';

export const hasShared = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('compartilhar');

/** O que foi compartilhado: `{ files: File[], text }` (ou null). Some do cache ao ler. */
export async function takeShared() {
  if (typeof caches === 'undefined') return null;
  const cache = await caches.open(CACHE);
  const meta = await cache.match('/__share/meta');
  if (!meta) return null;
  const { text = '', files = [] } = await meta.json().catch(() => ({}));
  const out = [];
  for (const f of files) {
    const res = await cache.match(f.key);
    if (res) out.push(new File([await res.blob()], f.name, { type: f.type || 'application/octet-stream' }));
  }
  await caches.delete(CACHE);
  return out.length || text ? { files: out, text } : null;
}
