// App desktop fora de foco (atrás de outro programa, minimizado ou na bandeja do Windows):
// os avisos viram notificações do Windows e uma chamada recebida traz a janela de volta.
import { isTauri } from './env.js';
import { plain } from './text.js';

const appWindow = () => import('@tauri-apps/api/window').then((m) => m.getCurrentWindow());

/**
 * A pessoa não está olhando o PadoSpeak: janela na bandeja, minimizada ou atrás de outro programa
 * (sem foco). Aí o aviso no canto da janela não seria visto.
 */
async function outOfSight() {
  const win = await appWindow();
  return !(await win.isVisible()) || (await win.isMinimized()) || !(await win.isFocused());
}

/** Notificação do Windows quando o app não está em foco. */
export async function systemNotify(text) {
  if (!isTauri) return;
  try {
    if (!(await outOfSight())) return;
    const n = await import('@tauri-apps/plugin-notification');
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === 'granted';
    if (granted) n.sendNotification({ title: 'PadoSpeak', body: plain(text) });
  } catch {
    // Sem notificação do sistema: o aviso continua aparecendo dentro do app.
  }
}

/** Mostra a janela (saindo da bandeja ou do minimizado) e traz para a frente. */
export async function showAppWindow() {
  if (!isTauri) return;
  try {
    const win = await appWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch {
    // ignora: a chamada ainda aparece quando a pessoa abrir o app
  }
}
