import { create } from 'zustand';
import { isTauri } from './env.js';

/**
 * Atualização automática do app desktop (mesmo esquema do Pokeru).
 *
 * Ao abrir, o PadoSpeak pergunta ao GitHub se há versão nova (o `latest.json` da última release),
 * baixa, instala e reinicia. Quem confere a assinatura é o atualizador do Tauri: só instala pacotes
 * assinados com a chave do projeto, então uma release adulterada é recusada.
 *
 * No Windows o instalador roda em modo silencioso (`quiet` na tauri.conf.json) e reabre o app sozinho;
 * o que aparece é só o aviso de progresso. No navegador nada disso existe.
 */
export const useUpdate = create((set) => ({
  stage: 'idle', // idle | checking | downloading | installing | ready | error
  version: null,
  notes: null,
  progress: null, // 0 a 1 enquanto baixa (null se o tamanho não vier)
  error: null,
  set: (patch) => set(patch),
  dismiss: () => set({ stage: 'idle', error: null }),
}));

/** Procura, baixa e instala a versão nova; ao terminar, reinicia. `false` quando não havia nada. */
export async function runAutoUpdate() {
  const st = useUpdate.getState();
  if (st.stage !== 'idle' || !isTauri) return false;
  st.set({ stage: 'checking', error: null });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      st.set({ stage: 'idle' });
      return false;
    }
    st.set({ stage: 'downloading', version: update.version, notes: update.body ?? null, progress: 0 });
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === 'Started') {
        total = ev.data.contentLength ?? 0;
        got = 0;
      } else if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        useUpdate.getState().set({ progress: total ? Math.min(1, got / total) : null });
      } else if (ev.event === 'Finished') {
        useUpdate.getState().set({ stage: 'installing', progress: 1 });
      }
    });
    st.set({ stage: 'ready' });
    // No Windows o instalador fecha o app e o reabre; no macOS/Linux quem reinicia é esta linha.
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return true;
  } catch (err) {
    // Sem internet ou sem release não pode atrapalhar quem só quer conversar.
    console.warn('[atualização]', err);
    useUpdate.getState().set({ stage: 'error', error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
