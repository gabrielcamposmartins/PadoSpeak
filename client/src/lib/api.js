// Acesso HTTP a um servidor PadoSpeak. O app pode falar com vários ao mesmo tempo (servidor, perfil
// local e PCs da rede), então cada conexão tem o seu cliente (`createApi`) e o token fica salvo por endereço.
// No app desktop, a sessão do servidor de comunidade também é separada por perfil local (`scope`): dois
// perfis no mesmo PC nunca usam a conta um do outro.
import { defaultServerUrl } from './env.js';

const SERVER_KEY = 'padospeak.serverUrl';
const tokenKey = (url, scope) => `padospeak.token:${url}${scope ? `#${scope}` : ''}`;

export const storage = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* armazenamento indisponível: segue só em memória */
    }
  },
};

export const normalizeUrl = (url) => {
  let u = String(url || '')
    .trim()
    .replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `${/^(localhost|127\.|10\.|192\.168\.|172\.)/.test(u) ? 'http' : 'https'}://${u}`;
  return u;
};

/** Endereço do servidor de comunidade escolhido (no app desktop, mudado na página Hostear). */
export const savedServerUrl = () => normalizeUrl(storage.get(SERVER_KEY) || defaultServerUrl());
export const saveServerUrl = (url) => storage.set(SERVER_KEY, normalizeUrl(url) || null);

export const loadToken = (url, scope) => storage.get(tokenKey(url, scope));
export const saveToken = (url, t, scope) => storage.set(tokenKey(url, scope), t);

export class ApiError extends Error {
  /** `data`: o resto da resposta (ex.: `retryAfter` ms e `attemptsLeft` do login). */
  constructor(status, message, data) {
    super(message);
    this.status = status;
    if (data?.retryAfter) this.retryAfter = data.retryAfter;
    if (data?.attemptsLeft != null) this.attemptsLeft = data.attemptsLeft;
  }
}

/** Cliente de um servidor: `base()` e `token()` são lidos a cada chamada (o endereço pode mudar). */
export function createApi(base, token) {
  async function request(method, path, body) {
    let res;
    // Blobs (ex.: foto de perfil) vão crus, com o próprio tipo; o resto vai em JSON.
    const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
    const t = token();
    try {
      res = await fetch(base() + path, {
        method,
        headers: {
          ...(body !== undefined
            ? { 'content-type': isBlob ? body.type || 'application/octet-stream' : 'application/json' }
            : {}),
          ...(t ? { authorization: `Bearer ${t}` } : {}),
        },
        body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, `Não foi possível conectar a ${base()}`);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error || `Erro ${res.status}`, data);
    return data;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, body = {}) => request('POST', p, body),
    patch: (p, body = {}) => request('PATCH', p, body),
    put: (p, body) => request('PUT', p, body),
    del: (p, body) => request('DELETE', p, body),
    /** Baixa um arquivo (ex.: a foto de perfil, para copiar para outro servidor). */
    async blob(path) {
      const res = await fetch(base() + path);
      if (!res.ok) throw new ApiError(res.status, `Erro ${res.status}`);
      return res.blob();
    },
  };
}
