// Quem fica em destaque na chamada, no modo automático (veja VoiceView):
// 1. uma transmissão de tela de outra pessoa tem prioridade sobre qualquer câmera;
// 2. senão, a câmera de quem está falando (a sua não: você não se destaca para si mesmo);
// 3. sem transmissão nem câmera, nada em destaque (a grade), ou, no celular, alguém da chamada.
// O destaque não pula de uma pessoa para outra a cada palavra: troca no máximo a cada `SWITCH_HOLD_MS` e fica
// em quem falou por último enquanto ninguém fala.

/** Tempo mínimo entre duas trocas de quem fala no destaque. */
export const SWITCH_HOLD_MS = 1500;

const isScreen = (t) => t.kind === 'screen';
/** A câmera ligada de outra pessoa (recebendo, ou anunciada e esperando você pedir para ver). */
const isCamera = (t) => !isScreen(t) && !t.self && Boolean(t.stream || t.offer === 'camera');

/**
 * @param {object} o
 * @param {Array<{ id: string, kind?: string, self?: boolean, peerId?: string, stream?: unknown, offer?: string | null, speaking?: boolean }>} o.tiles
 * @param {string | null} o.prev o destaque automático de antes
 * @param {number} o.since quando ele entrou no destaque (ms)
 * @param {number} o.now agora (ms)
 * @param {boolean} [o.phone]
 * @returns {{ id: string | null, wait: number }} `wait`: daqui a quanto tempo (ms) vale olhar de novo, porque
 *   alguém está falando e o destaque ainda não pode trocar para essa pessoa (0 = nada a esperar)
 */
export function pickAutoFocus({ tiles, prev, since, now, phone = false }) {
  const speakingPeers = new Set(tiles.filter((t) => !isScreen(t) && t.speaking && t.peerId).map((t) => t.peerId));

  // 1. transmissão: fica na mesma enquanto ela existir; uma nova vai para a de quem está falando
  const screens = tiles.filter((t) => isScreen(t) && !t.self);
  if (screens.length) {
    if (screens.some((t) => t.id === prev)) return { id: prev, wait: 0 };
    const shown = screens.filter((t) => t.stream);
    const pool = shown.length ? shown : screens;
    return { id: (pool.find((t) => speakingPeers.has(t.peerId)) || pool[0]).id, wait: 0 };
  }

  // 2. câmera de quem fala
  const cams = tiles.filter(isCamera);
  if (cams.length) {
    const kept = cams.some((t) => t.id === prev) ? prev : null;
    const talking = cams.filter((t) => t.speaking);
    if (!talking.length || talking.some((t) => t.id === kept)) {
      if (kept) return { id: kept, wait: 0 };
      const shown = cams.filter((t) => t.stream);
      return { id: (shown[0] || cams[0]).id, wait: 0 };
    }
    const wait = kept ? since + SWITCH_HOLD_MS - now : 0;
    if (wait > 0) return { id: kept, wait };
    return { id: talking[0].id, wait: 0 };
  }

  // 3. ninguém com vídeo
  if (phone) return { id: tiles.find((t) => !t.self)?.id || null, wait: 0 };
  return { id: null, wait: 0 };
}
