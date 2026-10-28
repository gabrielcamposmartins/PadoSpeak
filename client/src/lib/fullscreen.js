// Tela cheia que funciona em todo aparelho: o padrão, o prefixado do Safari (iPad e Mac antigos) e, no
// iPhone, que não deixa nenhum elemento em tela cheia, o player do próprio aparelho para o vídeo.

/** Elemento em tela cheia agora (ou null). */
export const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

/** Avisa quando a tela cheia muda (padrão e Safari). Devolve a função que para de ouvir. */
export function onFullscreenChange(cb) {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
  return () => {
    document.removeEventListener('fullscreenchange', cb);
    document.removeEventListener('webkitfullscreenchange', cb);
  };
}

/** Sai da tela cheia, se estiver nela. */
export function exitFullscreen() {
  if (!fullscreenElement()) return;
  try {
    const out = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen?.();
    out?.catch?.(() => {});
  } catch {
    /* já saiu */
  }
}

/** Player nativo do iPhone. Ao sair dele o iOS pausa o vídeo; a chamada continua, então volta a tocar. */
function nativeVideo(video) {
  if (!video?.webkitEnterFullscreen) return false;
  const resume = () => {
    video.removeEventListener('webkitendfullscreen', resume);
    video.play?.().catch(() => {});
  };
  video.addEventListener('webkitendfullscreen', resume);
  try {
    video.webkitEnterFullscreen();
    return true;
  } catch {
    video.removeEventListener('webkitendfullscreen', resume);
    return false;
  }
}

/**
 * Põe `el` em tela cheia. Se o navegador não deixar (iPhone) ou recusar, usa o player nativo de `video`
 * (por padrão, o próprio `el` quando ele é um vídeo). Devolve false se nada funcionou.
 */
export async function enterFullscreen(el, video = el instanceof HTMLVideoElement ? el : null) {
  // No iPhone a função pode até existir, mas `fullscreenEnabled` vem falso.
  const enabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  const req = el && (el.requestFullscreen || el.webkitRequestFullscreen);
  if (enabled && req) {
    try {
      await req.call(el);
      return true;
    } catch {
      /* recusado: tenta o player nativo */
    }
  }
  return nativeVideo(video);
}
