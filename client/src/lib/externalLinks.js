// App do Windows: um link (mensagem, perfil, notas…) abre numa aba do navegador padrão do sistema, em
// vez de uma janela do próprio WebView (ou de nada). Cliques que o app já trata (download de anexos,
// convites) chegam aqui com `defaultPrevented` e ficam como estão.
import { isTauri, openExternal } from './env.js';

const external = (href) => {
  try {
    const url = new URL(href, location.href);
    return /^https?:$/.test(url.protocol) && url.origin !== location.origin ? url.href : null;
  } catch {
    return null;
  }
};

function onClick(e) {
  if (e.defaultPrevented || (e.type === 'auxclick' && e.button !== 1)) return;
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || a.hasAttribute('download')) return;
  const url = external(a.getAttribute('href'));
  if (!url) return;
  e.preventDefault();
  openExternal(url).catch((err) => console.warn('[link]', err));
}

export function initExternalLinks() {
  if (!isTauri) return;
  // Depois dos cliques do React (que ficam na raiz do app): só o que ninguém tratou.
  window.addEventListener('click', onClick);
  window.addEventListener('auxclick', onClick);
  const open = window.open.bind(window);
  window.open = (href, ...rest) => {
    const url = href && external(String(href));
    if (!url) return open(href, ...rest);
    openExternal(url).catch((err) => console.warn('[link]', err));
    return null;
  };
}
