// Login (ou vínculo) com o Google: o servidor monta o endereço da página do Google, o app abre numa
// janela (no app do Windows, no navegador do sistema; no celular, uma aba) e pergunta ao servidor até o
// login terminar. Assim funciona igual no navegador, no app instalado e no app do Windows.
import { isTauri, openExternal } from './env.js';

const POLL_MS = 1500;
const GIVE_UP_MS = 10 * 60_000;

/**
 * `base`: endereço do servidor; `purpose`: 'login' ou 'link' (vincular, com o `token` da conta).
 * Devolve o resultado do servidor ({ token, user } no login; { linked } no vínculo). `signal` cancela.
 *
 * Se a volta do Google abrir em outro navegador (o do sistema, no app do Windows), a página mostra um código
 * e o servidor só termina o login com ele: `askCode(erro)` pede o código à pessoa (o `erro` vem preenchido
 * quando o anterior estava errado). Assim, quem só tiver o endereço da página do Google não entra na conta.
 */
export async function googleFlow(base, { purpose = 'login', token, signal, askCode } = {}) {
  // A janela abre já no clique (senão o navegador bloqueia) e recebe o endereço depois.
  const popup = !isTauri ? window.open('', 'padospeak-google', 'width=480,height=640') : null;
  let begin;
  try {
    const res = await fetch(`${base}/api/auth/google/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ purpose }),
    });
    begin = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(begin.error || `Erro ${res.status}`);
  } catch (e) {
    popup?.close();
    throw e;
  }
  if (isTauri) await openExternal(begin.url);
  else if (popup && !popup.closed) popup.location.href = begin.url;
  else window.open(begin.url, '_blank');

  const started = Date.now();
  let code = '';
  while (Date.now() - started < GIVE_UP_MS) {
    if (signal?.aborted) throw new Error('Cancelado');
    if (!code) await new Promise((r) => setTimeout(r, POLL_MS));
    const q = `state=${encodeURIComponent(begin.state)}${code ? `&code=${encodeURIComponent(code)}` : ''}`;
    const res = await fetch(`${base}/api/auth/google/poll?${q}`).catch(() => null);
    code = '';
    if (!res) continue;
    const data = await res.json().catch(() => ({}));
    if (res.status === 202) {
      if (data.needCode) code = await requestCode(askCode, '');
      continue;
    }
    if (res.status === 400 && data.retry) {
      code = await requestCode(askCode, data.error);
      continue;
    }
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    try {
      popup?.close();
    } catch {
      /* a página fecha sozinha */
    }
    return data;
  }
  throw new Error('O login com o Google demorou demais. Tente de novo.');
}

async function requestCode(askCode, error) {
  if (!askCode) throw new Error('Termine o login com o Google no mesmo navegador em que você começou.');
  const code = String((await askCode(error)) || '').trim();
  if (!code) throw new Error('Cancelado');
  return code;
}

/** O que este servidor oferece na entrada (e-mail e Google). */
export async function authOptions(base) {
  try {
    const res = await fetch(`${base}/api/auth/options`);
    return res.ok ? await res.json() : { email: false, google: false };
  } catch {
    return { email: false, google: false };
  }
}
