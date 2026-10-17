import { create } from 'zustand';
import { isTauri } from './env.js';

/**
 * Atualização automática do app desktop (mesmo esquema do Pokeru).
 *
 * Ao abrir, o PadoSpeak pergunta ao GitHub se há versão nova (o `latest.json` da última release),
 * baixa, instala e reinicia. Quem confere a assinatura é o atualizador do Tauri: só instala pacotes
 * assinados com a chave do projeto, então uma release adulterada é recusada.
 *
 * No Windows o instalador roda em modo silencioso (`quiet` na tauri.conf.json) e reabre o app sozinho.
 * Tudo acontece na tela de carregamento, antes de o app abrir: ele só abre depois de saber que não há
 * versão nova (ou depois de instalar). No navegador nada disso existe.
 */
/** A procura por versão nova não segura a abertura por mais que isto (sem internet, GitHub lento…). */
const CHECK_MS = 3000;

export const useUpdate = create((set) => ({
  stage: 'idle', // idle | checking | downloading | installing | ready | error
  version: null,
  notes: null,
  progress: null, // 0 a 1 enquanto baixa (null se o tamanho não vier)
  total: 0, // bytes do pacote (0 se o tamanho não vier)
  error: null,
  set: (patch) => set(patch),
  dismiss: () => set({ stage: 'idle', error: null }),
}));

/** Aberto pela inicialização do Windows (só na bandeja): ninguém está esperando a janela. */
const HIDDEN_CHECK_MS = 20000;
/** Na bandeja, sem resposta ao abrir (internet ainda subindo): tenta de novo algumas vezes. */
const RETRY_MS = 3 * 60 * 1000;
const RETRIES = 3;

/** `{ update }` (null: não há versão nova) ou `{ failed: true }` (sem resposta a tempo ou erro). */
async function findUpdate(ms) {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    return await Promise.race([
      check({ timeout: ms }).then((update) => ({ update })),
      new Promise((ok) => setTimeout(() => ok({ failed: true }), ms)),
    ]);
  } catch (err) {
    console.warn('[atualização]', err);
    return { failed: true };
  }
}

/** Baixa e instala; o instalador fecha o app e o reabre com os mesmos argumentos (na bandeja, se veio de lá). */
async function install(update) {
  const st = useUpdate.getState();
  st.set({ stage: 'downloading', version: update.version, notes: update.body ?? null, progress: 0, total: 0 });
  let total = 0;
  let got = 0;
  await update.downloadAndInstall((ev) => {
    if (ev.event === 'Started') {
      total = ev.data.contentLength ?? 0;
      got = 0;
      useUpdate.getState().set({ total });
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
}

/**
 * Procura, baixa e instala a versão nova antes de o app abrir; ao terminar, reinicia. `false` quando não
 * havia nada (ou a procura passou de 3 s, ou deu erro): aí o app abre normalmente.
 *
 * Aberto pela inicialização do Windows, tudo acontece escondido na bandeja: a procura espera mais (a
 * internet pode estar subindo) e, sem resposta, tenta de novo em segundo plano depois de o app abrir.
 */
export async function runAutoUpdate() {
  const st = useUpdate.getState();
  if (st.stage !== 'idle' || !isTauri) return false;
  st.set({ stage: 'checking', error: null });
  const { invoke } = await import('@tauri-apps/api/core');
  const hidden = await invoke('launched_hidden').catch(() => false);
  const found = await findUpdate(hidden ? HIDDEN_CHECK_MS : CHECK_MS);
  try {
    if (found.update) {
      await install(found.update);
      return true;
    }
  } catch (err) {
    // Sem internet ou sem release não pode atrapalhar quem só quer conversar.
    console.warn('[atualização]', err);
    useUpdate.getState().set({ stage: 'error', error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  st.set({ stage: 'idle' });
  if (hidden && found.failed) retryHidden(RETRIES);
  return false;
}

/** Na bandeja: procura de novo e instala em silêncio, só enquanto a janela continuar escondida. */
function retryHidden(left) {
  if (!left) return;
  setTimeout(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    // A pessoa abriu o app: não fecha no meio do uso (atualiza na próxima vez que abrir).
    if (await getCurrentWindow().isVisible().catch(() => true)) return;
    const found = await findUpdate(HIDDEN_CHECK_MS);
    if (found.failed) return retryHidden(left - 1);
    if (!found.update || (await getCurrentWindow().isVisible().catch(() => true))) return;
    await install(found.update).catch((err) => {
      console.warn('[atualização]', err);
      useUpdate.getState().set({ stage: 'idle' });
    });
  }, RETRY_MS);
}
