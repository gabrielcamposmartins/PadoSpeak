// App desktop rodando em segundo plano (janela fechada, ícone na bandeja do Windows):
// os avisos viram notificações do Windows e uma chamada recebida traz a janela de volta.
import { isTauri } from './env.js';
import { plain } from './text.js';

const appWindow = () => import('@tauri-apps/api/window').then((m) => m.getCurrentWindow());

/** A janela está escondida na bandeja ou minimizada (o aviso no canto não seria visto). */
async function outOfSight() {
  const win = await appWindow();
  return !(await win.isVisible()) || (await win.isMinimized());
}

/** Notificação do Windows quando o app não está à vista. */
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
