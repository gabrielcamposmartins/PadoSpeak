// Filtro dos gestos (puro, sem DOM): o reconhecedor devolve um palpite por quadro, e um gesto só vale quando fica
// parado na mão por um tempo, com confiança, sem repetir logo em seguida. O aceno é a palma aberta indo e voltando.

/** Gestos que valem, com a confiança mínima e quanto tempo segurar (ms). Punho fechado e palma parada ficam de fora
 *  (aparecem demais sem querer). */
export const GESTURES = {
  // (o padrão do MediaPipe é 0,5; numa foto nítida de joinha ele dá ~0,7: o tempo segurando filtra o resto)
  Thumb_Up: { min: 0.6, hold: 600 },
  Thumb_Down: { min: 0.6, hold: 600 },
  Victory: { min: 0.65, hold: 600 },
  ILoveYou: { min: 0.6, hold: 600 },
  Pointing_Up: { min: 0.65, hold: 900 },
};
const SHARE = 0.7; // dos quadros na janela, quantos precisam ser o gesto
const MIN_FRAMES = 3;
const REARM_MS = 500; // o mesmo gesto só vale de novo depois de sumir por este tempo
const SAME_MS = 3000;
const ANY_MS = 1000;
const WAVE_MS = 1200;
const WAVE_TURNS = 3; // idas e voltas (3 = direita, esquerda, direita)
const WAVE_AMP = 0.06;

/**
 * `push({ gesture, score, wrist: {x, y} | null }, t)` a cada quadro; devolve o gesto que acabou de valer
 * (`Thumb_Up`, …, ou `wave`) ou `null`.
 */
export function createGestureFilter() {
  let frames = []; // { t, g, s, x }
  const lastSeen = {}; // gesto → último quadro em que apareceu
  const armed = {}; // gesto → pode valer de novo
  const lastFired = {}; // gesto → quando valeu
  let lastAny = -Infinity;

  const fire = (g, t) => {
    if (t - lastAny < ANY_MS || t - (lastFired[g] ?? -Infinity) < SAME_MS) return null;
    lastAny = t;
    lastFired[g] = t;
    armed[g] = false;
    return g;
  };

  return {
    push(frame, t) {
      const g = frame?.gesture || 'None';
      frames.push({ t, g, s: frame?.score || 0, x: frame?.wrist ? frame.wrist.x : null });
      // guarda o bastante para a janela do aceno e para os aparelhos lentos (até 1 quadro por segundo)
      frames = frames.filter((f) => t - f.t <= Math.max(WAVE_MS, 2600));
      if (g !== 'None') lastSeen[g] = t;
      for (const k of Object.keys(GESTURES)) {
        if (armed[k] === false && t - (lastSeen[k] ?? -Infinity) >= REARM_MS) armed[k] = true;
      }
      // um gesto parado (num aparelho lento, com poucos quadros por segundo, a janela cresce até caberem 3 quadros)
      const rule = GESTURES[g];
      if (rule && armed[g] !== false) {
        const recent = frames.slice(-4);
        const gap = recent.length > 1 ? (recent[recent.length - 1].t - recent[0].t) / (recent.length - 1) : 0;
        const holdMs = Math.max(rule.hold, gap * 2.2);
        const win = frames.filter((f) => t - f.t <= holdMs);
        const covered = win.length && t - win[0].t >= holdMs * 0.75;
        const hits = win.filter((f) => f.g === g && f.s >= rule.min).length;
        if (covered && win.length >= MIN_FRAMES && hits / win.length >= SHARE) {
          const out = fire(g, t);
          if (out) return out;
        }
      }
      // aceno: palma aberta, o pulso indo e voltando
      if (g === 'Open_Palm' && armed.wave !== false) {
        const palm = frames.filter((f) => f.g === 'Open_Palm' && f.x != null && t - f.t <= WAVE_MS);
        if (palm.length >= 4) {
          // conta as viradas: o pulso foi para um lado pelo menos WAVE_AMP e voltou pelo menos WAVE_AMP
          let turns = 0;
          let dir = 0;
          let anchor = palm[0].x;
          for (const { x } of palm.slice(1)) {
            if (dir === 0) {
              if (Math.abs(x - anchor) >= WAVE_AMP) {
                dir = Math.sign(x - anchor);
                anchor = x;
              }
            } else if ((x - anchor) * dir > 0) anchor = x;
            else if (Math.abs(x - anchor) >= WAVE_AMP) {
              turns++;
              dir = -dir;
              anchor = x;
            }
          }
          if (turns >= WAVE_TURNS - 1) {
            const out = fire('wave', t);
            if (out) {
              frames = [];
              return out;
            }
          }
        }
      }
      if (armed.wave === false && t - (lastSeen.Open_Palm ?? -Infinity) >= REARM_MS) armed.wave = true;
      return null;
    },
  };
}
