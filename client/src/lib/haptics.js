// Vibração dos avisos no celular com o PadoSpeak aberto (com o app fechado, quem vibra é a notificação
// do sistema — ver public/sw.js). Android: Vibration API. iPhone (iOS 18+): o Safari não tem a API,
// mas dá o "toque" do sistema ao ligar um interruptor nativo (<input type="checkbox" switch>).
import { isTauri } from './env.js';
import { isTouch } from './layout.js';

export const PATTERNS = {
  message: [180, 90, 180],
  nudge: [90, 50, 90, 50, 90, 50, 260],
  ring: [900, 500, 900],
};

let iosSwitch = null;
const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

function iosTap() {
  if (!iosSwitch) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}

/** Vibra com o padrão do aviso (`message`, `nudge`, `ring` ou uma lista em ms). Só no celular. */
export function haptic(kind = 'message') {
  if (!isTouch || isTauri || typeof document === 'undefined' || document.hidden) return;
  const pattern = Array.isArray(kind) ? kind : PATTERNS[kind] || PATTERNS.message;
  try {
    if (canVibrate) {
      navigator.vibrate(pattern);
      return;
    }
    // iPhone: um toque por pulso do padrão.
    let t = 0;
    pattern.forEach((ms, i) => {
      if (i % 2 === 0) setTimeout(iosTap, t);
      t += ms;
    });
  } catch {
    /* sem vibração */
  }
}

/** Para uma vibração em andamento (ex.: a chamada foi atendida). */
export function stopHaptic() {
  if (canVibrate) navigator.vibrate(0);
}
