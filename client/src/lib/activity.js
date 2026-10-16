// Jogo em foco ("Jogando Counter-Strike 2"): o app do Windows olha a janela em foco e reconhece o jogo
// (lista de jogos conhecidos + pastas da Steam, Epic, Riot, Xbox…; veja desktop/src-tauri/src/activity.rs).
// O jogo continua no status enquanto estiver aberto, mesmo voltando para o PadoSpeak.
// No navegador e no celular não há como saber: nada é mandado.
import { isTauri } from './env.js';

let current = null;

/** O jogo detectado agora ({ type: 'playing', name, since } ou null). */
export const currentActivity = () => current;

/** Começa a ouvir o app do Windows; `onChange` recebe a atividade a cada troca. */
export async function watchActivity(onChange) {
  if (!isTauri) return;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');
    const apply = (a) => {
      current = a?.name ? { type: 'playing', name: a.name, since: a.since } : null;
      onChange(current);
    };
    await listen('activity', (e) => apply(e.payload));
    apply(await invoke('activity_get'));
  } catch (e) {
    console.warn('[atividade]', e);
  }
}
