// "Chamar atenção": treme a janela e pisca o botão do app na barra de tarefas (laranja no Windows).
import { isTauri } from './env.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OFFSETS = [
  [-12, 0],
  [12, 0],
  [-10, -6],
  [10, 6],
  [-12, 4],
  [12, -4],
  [-8, 0],
  [8, 0],
  [-4, 4],
  [4, -4],
  [0, 0],
];
let shaking = false;

/** Treme a janela do app (no navegador, treme a página). */
export async function shakeWindow() {
  if (shaking) return;
  shaking = true;
  try {
    navigator.vibrate?.([120, 60, 120]);
    if (isTauri) {
      const { getCurrentWindow, PhysicalPosition } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      if (!(await win.isMaximized()) && !(await win.isFullscreen())) {
        const p = await win.outerPosition();
        for (const [dx, dy] of OFFSETS) {
          await win.setPosition(new PhysicalPosition(p.x + dx, p.y + dy));
          await sleep(30);
        }
        await win.setPosition(new PhysicalPosition(p.x, p.y));
        return;
      }
    }
    const root = document.getElementById('root');
    root?.classList.remove('nudge-shake');
    void root?.offsetWidth;
    root?.classList.add('nudge-shake');
    await sleep(650);
    root?.classList.remove('nudge-shake');
  } catch {
    /* sem permissão de janela: só o som e o aviso */
  } finally {
    shaking = false;
  }
}

/** Pisca o botão na barra de tarefas até a janela receber o foco. */
export async function flashTaskbar() {
  if (!isTauri || document.hasFocus()) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
  } catch {
    /* ignora */
  }
}
