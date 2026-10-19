// Quanto vídeo meu cada pessoa que assiste recebe. A chamada é em malha: cada uma tem o seu envio, e com
// 4 pessoas assistindo uma tela em 1080p eram até 36 Mbps de upload, o que satura muita internet de casa
// e faz a voz de todos picotar. O teto é dividido entre quem assiste.

/** Teto de envio somando todos que assistem, por tipo de vídeo. */
export const SCREEN_BUDGET_BPS = 12_000_000;
export const CAMERA_BUDGET_BPS = 3_000_000;
/** Abaixo disto a imagem fica ruim demais: com muita gente assistindo, o teto passa um pouco. */
const SCREEN_FLOOR_BPS = 1_200_000;
const CAMERA_FLOOR_BPS = 400_000;
/** Tela codificada pelo processador: vai como na qualidade 720p (menos trabalho por quadro). */
const SOFTWARE_SCREEN_BPS = 2_500_000;
/** Pelo relay (TURN) o servidor deixa 1,5 Mbps por sessão, somando voz, câmera e tela. */
export const RELAY_SCREEN_BPS = 900_000;
export const RELAY_CAMERA_BPS = 250_000;

/**
 * Alvo do envio de um vídeo para uma pessoa.
 * @param {object} o
 * @param {'screen' | 'camera'} o.kind
 * @param {{ bitrate: number, fps: number, height: number }} o.preset qualidade escolhida
 * @param {number} o.viewers quantas pessoas recebem este vídeo
 * @param {boolean} [o.relay] a conexão com esta pessoa passa pelo relay
 * @param {boolean} [o.software] o envio para esta pessoa está sendo codificado pelo processador
 * @returns {{ bitrate: number, fps: number, scale: number }} `scale`: quanto reduzir a resolução
 */
export function videoTarget({ kind, preset, viewers, relay = false, software = false }) {
  const screen = kind === 'screen';
  const share = (screen ? SCREEN_BUDGET_BPS : CAMERA_BUDGET_BPS) / Math.max(1, viewers);
  let bitrate = Math.min(preset.bitrate, Math.max(screen ? SCREEN_FLOOR_BPS : CAMERA_FLOOR_BPS, Math.round(share)));
  let fps = preset.fps;
  let scale = 1;
  // Sem a placa de vídeo (ou com ela já ocupada com os outros envios), 1080p pesa no processador.
  if (software && screen && preset.height > 720) {
    scale = preset.height / 720;
    fps = Math.min(fps, 30);
    bitrate = Math.min(bitrate, SOFTWARE_SCREEN_BPS);
  }
  if (relay) {
    bitrate = Math.min(bitrate, screen ? RELAY_SCREEN_BPS : RELAY_CAMERA_BPS);
    if (screen) {
      scale = Math.max(scale, preset.height / 720);
      fps = Math.min(fps, 15);
    }
  }
  return { bitrate, fps, scale };
}
