// Contador de mensagens não lidas no ícone do app: no app do Windows, uma bolinha verde com o número
// no canto do ícone da barra de tarefas; no app instalado (PWA), o contador do próprio sistema.
import { isTauri } from './env.js';
import { setBadge } from './pwa.js';

let shown = -1;

/** Mostra (ou tira, com 0) o número de mensagens não lidas no ícone do app. */
export async function setUnreadBadge(count) {
  const n = Math.max(0, count | 0);
  if (n === shown) return;
  shown = n;
  if (!isTauri) return setBadge(n);
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.setOverlayIcon(n > 0 ? await drawBadge(n) : undefined);
  } catch (e) {
    console.warn('[contador]', e);
  }
}

/** Bolinha verde (no estilo dos botões Aero) com o número em branco, em PNG. */
async function drawBadge(n) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const r = size / 2;
  const fill = g.createRadialGradient(r * 0.7, r * 0.6, 1, r, r, r);
  fill.addColorStop(0, '#9af07a');
  fill.addColorStop(0.55, '#3fb124');
  fill.addColorStop(1, '#23800f');
  g.beginPath();
  g.arc(r, r, r - 1, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = '#1b5e0b';
  g.stroke();
  const label = n > 99 ? '99+' : String(n);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${label.length === 1 ? 21 : label.length === 2 ? 17 : 12}px "Segoe UI", sans-serif`;
  g.shadowColor = 'rgba(0, 60, 0, 0.6)';
  g.shadowBlur = 2;
  g.fillText(label, r, r + 1);
  const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
