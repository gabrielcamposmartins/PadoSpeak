// Onde este cliente está rodando.
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Painel de hospedagem do binário (`padospeak-server`), ou /host durante o desenvolvimento.
export const isPanel =
  typeof window !== 'undefined' &&
  (window.__PADOSPEAK_PANEL__ === true || (import.meta.env.DEV && location.pathname === '/host'));

/** Instalador da última versão do app desktop (link fixo da release mais recente no GitHub). */
export const DOWNLOAD_URL = 'https://github.com/gabrielcamposmartins/PadoSpeak/releases/latest/download/PadoSpeak-setup.exe';

/** Servidor de comunidade padrão do app desktop. */
export const DEFAULT_SERVER = 'https://padospeak.padoru.org';

/**
 * Nó local apontado à mão (testes no navegador e desenvolvimento): `?localNode=http://localhost:47821`.
 * Fica salvo na aba, então recarregar a página mantém o modo desktop.
 */
const localOverride = (() => {
  if (typeof window === 'undefined') return null;
  try {
    const q = new URLSearchParams(location.search).get('localNode');
    if (q) sessionStorage.setItem('padospeak.localNode', q);
    return sessionStorage.getItem('padospeak.localNode');
  } catch {
    return null;
  }
})();

/** Modo desktop: perfil local (login offline), rede local e servidor de comunidade separado. */
export const isDesktop = isTauri || Boolean(localOverride);

/** No navegador o cliente é servido pelo próprio servidor; no app desktop o padrão é o servidor da comunidade. */
export const defaultServerUrl = () => (isDesktop ? DEFAULT_SERVER : location.origin);

/** Endereço do nó local (o servidor embutido que guarda o perfil deste PC). */
export async function localNodeUrl() {
  if (localOverride) return localOverride.replace(/\/+$/, '');
  const { invoke } = await import('@tauri-apps/api/core');
  const info = await invoke('local_node');
  return info.url;
}
