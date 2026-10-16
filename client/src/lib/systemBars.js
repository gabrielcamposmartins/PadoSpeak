// Celular: a barra de status (horas, bateria) e a barra de navegação do sistema (voltar, início) com
// exatamente a cor das bordas do app, no tema claro ou escuro, em vez do azul fixo do manifesto.
//  - As bordas da tela começam numa cor sólida (`--sysbar-top` / `--sysbar-bottom`, ver
//    `.mobile-app::before/::after` no CSS): a cena do perfil no alto da tela inicial, ou a cor da tela
//    comum (`--bar-top`); embaixo, `--bar-bottom`.
//  - Barra de status: `<meta name="theme-color">` com a mesma cor, trocada na hora.
//  - Barra de navegação (Android): sai do `theme_color` do manifesto; o service worker reescreve o
//    manifesto com a cor de baixo (o Android relê quando atualiza o app instalado).
//  - iPhone: a página fica por baixo das duas barras (status "black-translucent" + safe area), então
//    a própria borda do app aparece nelas.
import { currentLayout } from './layout.js';
import { isTauri } from './env.js';

let last = '';
let meta = null;

const rootVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function apply() {
  if (document.hidden || currentLayout() !== 'phone') return;
  const atTop = document.elementFromPoint(window.innerWidth / 2, 1);
  const atBottom = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1);
  // Telas por cima do app (chamada, faixa da chamada) dizem a própria cor: data-sysbar="--variavel".
  const own = (el, attr) => {
    const name = el?.closest(`[${attr}]`)?.getAttribute(attr);
    return name ? rootVar(name) : '';
  };
  const top = own(atTop, 'data-sysbar') || (atTop?.closest('.scene') && rootVar('--scene-top')) || rootVar('--bar-top');
  const bottom = own(atBottom, 'data-sysbar-bottom') || rootVar('--bar-bottom');
  if (!top || !bottom) return;
  const key = `${top}|${bottom}`;
  if (key === last) return;
  last = key;
  const root = document.documentElement.style;
  root.setProperty('--sysbar-top', top);
  root.setProperty('--sysbar-bottom', bottom);
  root.backgroundColor = bottom;
  meta ||= document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = top;
  navigator.serviceWorker?.controller?.postMessage({ type: 'bars', top, bottom, background: bottom });
}

/** Acompanha a tela (troca de tema, de cena ou de tela) e atualiza as barras do sistema. */
export function watchSystemBars() {
  if (typeof window === 'undefined' || isTauri) return;
  const tick = () => {
    try {
      apply();
    } catch {
      /* tenta de novo no próximo */
    }
  };
  setInterval(tick, 600);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('resize', tick);
  tick();
}
