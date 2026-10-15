// Qual conexão (servidor, perfil local ou PC da rede) alimenta um pedaço da tela.
// Conversas e chamadas da rede local usam os mesmos componentes do servidor, só que com outro store.
import { createContext, useContext, useEffect, useReducer } from 'react';
import { getConn, useStore } from '../store.js';

const ConnContext = createContext('server');

export function ConnProvider({ conn, children }) {
  return <ConnContext.Provider value={conn || 'server'}>{children}</ConnContext.Provider>;
}

export const useConnKey = () => useContext(ConnContext);

/** Store (hook do zustand) da conexão atual. Os dados de interface continuam em `useStore`. */
export function useConn() {
  const key = useContext(ConnContext);
  // Re-renderiza quando a conexão é criada ou fechada.
  useStore((s) => s.connKeys.includes(key));
  return getConn(key);
}

/**
 * Valor calculado a partir de todas as conexões (ex.: não lidas somadas), atualizado quando qualquer
 * uma muda. `select` recebe a lista de estados e deve devolver um valor simples (número, texto).
 */
/** Mensagens não lidas em todas as conexões (conversas privadas). */
export const unreadTotal = (states) => states.reduce((n, st) => n + Object.values(st.unread).reduce((a, b) => a + b, 0), 0);

export function useAcross(select) {
  const keys = useStore((s) => s.connKeys);
  const [, force] = useReducer((x) => x + 1, 0);
  const joined = keys.join('|');
  useEffect(() => {
    const unsubs = joined.split('|').map((k) => getConn(k).subscribe(force));
    return () => unsubs.forEach((u) => u());
  }, [joined]);
  return select(keys.map((k) => getConn(k).getState()));
}

/** Store da conexão com chamada em andamento (ou o servidor). */
export function useVoiceConn() {
  const key = useAcross((states) => states.find((s) => s.voice)?.key || 'server');
  return getConn(key);
}
