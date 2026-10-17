import { isTauri } from './env.js';

/**
 * Tamanho da janela do app do Windows. Enquanto ninguém entrou (carregando, entrando, atualizando) a
 * janela é só o cartão: 380 de largura e a altura do formulário, sem maximizar nem redimensionar. Depois
 * de entrar ela vira a janela grande de sempre.
 */
export const COMPACT_WIDTH = 380;
/** Altura da tela de carregamento: a mesma do formulário "Entrar", para não pular ao trocar. */
export const BOOT_HEIGHT = 600;
const FULL = { width: 1280, height: 800, minWidth: 940, minHeight: 560 };

let mode = null; // 'compact' | 'full'
let compactHeight = BOOT_HEIGHT;
let fitTimer = null;
// As chamadas à janela vão em fila, para trocar de modo e de altura não se atropelarem.
let queue = Promise.resolve();
const run = (fn) => {
  queue = queue.then(fn).catch((e) => console.warn('[janela]', e));
  return queue;
};
const tauri = () => Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/api/dpi')]);

/** Liga o modo da janela: 'compact' (o cartão) ou 'full' (o app). */
export function setWindowMode(next) {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('compact', isTauri && next === 'compact');
  if (!isTauri || next === mode) return;
  // A primeira vez só acerta o que a configuração já abriu (380×600 no centro).
  const first = mode === null;
  mode = next;
  run(async () => {
    const [{ getCurrentWindow }, { LogicalSize }] = await tauri();
    const w = getCurrentWindow();
    if (next === 'compact') {
      if (await w.isMaximized()) await w.unmaximize();
      await w.setMinSize(null);
      await w.setResizable(false);
      await w.setMaximizable(false);
      await w.setSize(new LogicalSize(COMPACT_WIDTH, compactHeight));
      if (!first) await w.center();
    } else {
      // Telas pequenas (notebook de 1366×768): a janela cabe na área livre da tela.
      const width = Math.min(FULL.width, Math.max(FULL.minWidth, screen.availWidth - 40));
      const height = Math.min(FULL.height, Math.max(FULL.minHeight, screen.availHeight - 40));
      await w.setResizable(true);
      await w.setMaximizable(true);
      await w.setMinSize(new LogicalSize(FULL.minWidth, FULL.minHeight));
      await w.setSize(new LogicalSize(width, height));
      await w.center();
    }
  });
}

/** Altura do cartão (o formulário mudou de tamanho): a janela pequena acompanha. */
export function setCompactHeight(height) {
  const h = Math.ceil(height);
  if (!h || h === compactHeight) return;
  compactHeight = h;
  if (!isTauri || mode !== 'compact') return;
  // Várias mudanças seguidas (o formulário montando, uma mensagem de erro): um só redimensionamento.
  clearTimeout(fitTimer);
  fitTimer = setTimeout(
    () =>
      run(async () => {
        const [{ getCurrentWindow }, { LogicalSize }] = await tauri();
        if (mode === 'compact') await getCurrentWindow().setSize(new LogicalSize(COMPACT_WIDTH, compactHeight));
      }),
    80,
  );
}
