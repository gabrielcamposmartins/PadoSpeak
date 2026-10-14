// App desktop fora de foco (atrás de outro programa, minimizado ou na bandeja do Windows):
// os avisos viram notificações do Windows e uma chamada recebida traz a janela de volta.
import { isTauri } from './env.js';
import { plain } from './text.js';

const appWindow = () => import('@tauri-apps/api/window').then((m) => m.getCurrentWindow());

/**
 * A janela está em foco? No app do Windows o `document.hasFocus()` do WebView continua "em foco" com a
 * janela atrás de outro programa, então vale o foco real da janela (avisado pelo Tauri).
 */
let windowFocused = true;
if (isTauri) {
  appWindow().then(async (win) => {
    windowFocused = await win.isFocused().catch(() => true);
    await win.onFocusChanged(({ payload }) => {
      windowFocused = payload;
      if (payload) window.dispatchEvent(new Event('padospeak:focus'));
    });
  });
}

/** A pessoa está olhando o PadoSpeak agora (janela em foco e visível)? */
export const appHasFocus = () => !document.hidden && (isTauri ? windowFocused : document.hasFocus());

/**
 * A pessoa não está olhando o PadoSpeak: janela na bandeja, minimizada ou atrás de outro programa
 * (sem foco). Aí o aviso no canto da janela não seria visto.
 */
async function outOfSight() {
  const win = await appWindow();
  return !(await win.isVisible()) || (await win.isMinimized()) || !(await win.isFocused());
}

/**
 * Notificação do Windows quando o app não está em foco: título com o nome de quem mandou e o texto.
 * Clicar nela traz a janela e abre `url` (ex.: a conversa).
 */
export async function systemNotify(text, user, url) {
  if (!isTauri) return;
  try {
    if (!(await outOfSight())) return;
    const name = user ? plain(user.displayName) || user.username : '';
    let body = plain(text);
    if (name && body.startsWith(`${name} diz: `)) body = body.slice(name.length + 6);
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('notify_windows', { title: name || 'PadoSpeak', body, url: url || '/' });
  } catch (e) {
    // Sem notificação do sistema: o aviso continua aparecendo dentro do app.
    console.warn('[notificação]', e);
  }
}

/** Clique numa notificação do Windows: o app já trouxe a janela; abre o lugar dela. */
export async function onNotificationClick(open) {
  if (!isTauri) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen('notification-open', (e) => open(e.payload));
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
