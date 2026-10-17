// Tamanho da tela: celular (uma tela por vez, abas embaixo), tablet na vertical (lista em gaveta) ou
// desktop (o layout de sempre, também no iPad na horizontal). O app do Windows é sempre desktop: ele só
// fica estreito na janela pequena de entrada e carregamento, que não é o app.
import { useSyncExternalStore } from 'react';
import { isTauri } from './env.js';

const media = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
const phone = media('(max-width: 640px)');
const tablet = media('(max-width: 939px)');

/** 'phone' | 'tablet' | 'desktop' */
export const currentLayout = () => (isTauri ? 'desktop' : phone?.matches ? 'phone' : tablet?.matches ? 'tablet' : 'desktop');

function subscribe(cb) {
  phone?.addEventListener('change', cb);
  tablet?.addEventListener('change', cb);
  return () => {
    phone?.removeEventListener('change', cb);
    tablet?.removeEventListener('change', cb);
  };
}

export const useLayout = () => useSyncExternalStore(subscribe, currentLayout, () => 'desktop');

const narrow = media('(max-width: 1180px)');
/** Tela estreita demais para a lista de membros ao lado da conversa (ela abre por cima). */
export const useNarrow = () =>
  useSyncExternalStore(
    (cb) => {
      narrow?.addEventListener('change', cb);
      return () => narrow?.removeEventListener('change', cb);
    },
    () => Boolean(narrow?.matches),
    () => false,
  );

/** Toque (celular/tablet): sem "passar o mouse", botões maiores. */
export const isTouch = Boolean(media('(pointer: coarse)')?.matches);

/** iPhone e iPad (o iPad novo se apresenta como Mac, mas tem toque). */
export const isIOS =
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** Instalado na tela de início (PWA) ou aberto pelo app. */
export const isStandalone =
  Boolean(media('(display-mode: standalone)')?.matches) ||
  (typeof navigator !== 'undefined' && navigator.standalone === true);

/**
 * Atributos no <html> para o CSS e a altura visível de verdade: com o teclado do celular aberto, a
 * caixa de escrever sobe junto em vez de ficar escondida atrás dele.
 */
export function watchViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  // Maior altura vista nesta orientação: bem menor que ela = teclado aberto.
  let full = 0;
  let wide = window.innerWidth > window.innerHeight;
  const update = () => {
    root.dataset.layout = currentLayout();
    const h = vv ? vv.height : window.innerHeight;
    const nowWide = window.innerWidth > window.innerHeight;
    if (nowWide !== wide) {
      wide = nowWide;
      full = 0;
    }
    full = Math.max(full, h);
    // Teclado aberto: a margem do indicador de início do iPhone (safe-area) fica escondida atrás dele,
    // então a caixa de escrever não reserva esse espaço (ficava um vão entre ela e o teclado).
    if (isTouch && h < full - 120) root.dataset.kb = '1';
    else delete root.dataset.kb;
    root.style.setProperty('--app-h', `${Math.round(h)}px`);
    // O iOS rola a página para mostrar o campo; o app já se ajustou à altura, então volta ao topo.
    if (vv && currentLayout() !== 'desktop' && window.scrollY) window.scrollTo(0, 0);
  };
  if (isTouch) root.dataset.touch = '1';
  if (isIOS) root.dataset.ios = '1';
  if (isStandalone) root.dataset.standalone = '1';
  update();
  vv?.addEventListener('resize', update);
  window.addEventListener('resize', update);
  subscribe(update);
}
