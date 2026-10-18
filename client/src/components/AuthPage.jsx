import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { useStore, localAuthenticate, localRecover, localFromServer, connRegistry, knownProfiles, lastProfile } from '../store.js';
import { GoogleButton, ForgotForm, useAuthOptions, HandleField, useHandleCheck, handleFrom } from './AccountAuth.jsx';
import Avatar from './Avatar.jsx';
import { InstallCard } from './Mobile.jsx';
import { isDesktop, DOWNLOAD_URL } from '../lib/env.js';
import { isStandalone, isTouch } from '../lib/layout.js';
import { useLoginLock, LoginLock } from './LoginLock.jsx';

/**
 * Criar conta pelo e-mail com o @ escolhido (`handle`). Se a pessoa não mexeu no @ (`explicit` falso), ele
 * sai do nome de exibição ou do e-mail e ganha números quando já existe; o @ digitado é usado como está.
 * Depois de entrar, o servidor manda o código para confirmar o e-mail, e Configurações → Conta abre com o
 * campo do código.
 */
async function registerWithEmail(form, handle, explicit) {
  const email = form.email.trim();
  let username = handle;
  for (let attempt = 0; ; attempt++) {
    try {
      await useStore.getState().authenticate('register', { username, password: form.password, displayName: form.displayName, email });
      break;
    } catch (e) {
      if (explicit || e.status !== 409 || !/usuário/i.test(e.message) || attempt >= 4) throw e;
      username = `${handle.slice(0, 18)}${Math.floor(100 + Math.random() * 9900)}`;
    }
  }
  const st = useStore.getState();
  try {
    await st.startEmail(email);
    st.openModal({ type: 'settings', tab: 'conta' });
    st.notify(`Mandamos um código para ${email}. Confirme o e-mail em Configurações → Conta.`, 'info');
  } catch {
    // Servidor sem e-mail: a conta fica só com o usuário.
  }
}

/** O app para Windows só é oferecido no navegador de um computador com Windows (nunca no celular, no tablet
 * ou no PadoSpeak instalado como app). */
export const offerWindowsApp =
  !isDesktop && !isStandalone && !isTouch && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
import Logo from './Logo.jsx';
import { SceneArt } from './Aero.jsx';
import { CardTitleBar } from './WindowFrame.jsx';
import { LoadingBody } from './Loading.jsx';
import { setCompactHeight } from '../lib/appWindow.js';

/** App do Windows: a janela é o cartão, então acompanha a altura do formulário (barra de título + corpo). */
function useFitWindow() {
  const ref = useRef(null);
  useEffect(() => {
    const body = ref.current;
    if (!body) return;
    const bar = body.parentElement.querySelector('.titlebar');
    const fit = () => setCompactHeight((bar?.offsetHeight ?? 0) + body.offsetHeight);
    const ro = new ResizeObserver(fit);
    ro.observe(body);
    fit();
    return () => ro.disconnect();
  }, []);
  return ref;
}

/**
 * Entrada.
 * - App desktop: o **perfil local** fica neste PC (funciona sem internet). Depois de entrar, o app acha
 *   quem está na rede local e tenta, em silêncio, o servidor de comunidade.
 * - Navegador: conta do servidor que serviu a página.
 */
export default function AuthPage() {
  const serverUrl = useStore((s) => s.baseUrl);
  const localError = useStore((s) => s.localError);
  // Onde o perfil mora: o nó local no app desktop, o servidor no navegador.
  const base = (isDesktop ? connRegistry.get('local')?.getState().baseUrl : serverUrl) || '';
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState(() => ({ username: lastProfile(base), email: '', password: '', confirm: '', displayName: '', newPassword: '', repeat: '' }));
  // Como no Messenger: a foto de quem já entrou neste PC aparece ao digitar o usuário.
  const known = mode === 'login' ? knownProfiles(base)[form.username.trim().toLowerCase()] : null;
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const options = useAuthOptions(serverUrl);
  const lockout = useLoginLock(form.username);
  const locked = mode !== 'register' && lockout.locked;

  const bootText = useStore((s) => s.bootText);
  const bodyRef = useFitWindow();

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Criar conta pelo e-mail: o @ acompanha o nome de exibição (ou o e-mail) até a pessoa escrever o dela.
  const [handle, setHandle] = useState(null);
  const autoHandle = handleFrom(form.displayName) || handleFrom(form.email);
  const handleValue = handle ?? autoHandle;
  const handleCheck = useHandleCheck(mode === 'register' && !isDesktop ? handleValue : '');

  async function submit(e) {
    e.preventDefault();
    setError('');
    useStore.setState({ bootText: null });
    setBusy(true);
    try {
      if (mode === 'register' && form.password !== form.confirm) throw new Error('As duas senhas não são iguais.');
      if (mode === 'register' && !isDesktop) {
        if (!handleValue) throw new Error('Escolha o seu @.');
        if (handle != null && handleCheck.state === 'taken') throw new Error(handleCheck.error);
        await registerWithEmail(form, handleValue, handle != null);
        return;
      }
      if (mode === 'reset') {
        if (form.newPassword !== form.repeat) throw new Error('As duas senhas não são iguais.');
        const creds = { username: form.username, password: form.password, newPassword: form.newPassword };
        if (isDesktop) await localRecover(creds);
        else await useStore.getState().authenticate('new-password', creds);
      } else if (isDesktop) {
        try {
          await localAuthenticate(mode, form);
        } catch (err) {
          // Senha do perfil local esquecida: vale a da conta do servidor (ou o código de redefinição).
          if (mode !== 'login' || err.status !== 401) throw err;
          // Servidor fora do ar, muitas tentativas…: mostra o motivo de verdade (senha errada lá também
          // cai na mensagem de sempre).
          const r = await localRecover({ username: form.username, password: form.password }).catch((e) => ({ error: e }));
          if (r?.needsNew) return setMode('reset');
          if (r?.error && r.error.status !== 401) throw r.error;
          if (!r || r.error || r.wrong) {
            // Vale o que estiver mais perto do bloqueio: aqui no PC ou no servidor.
            const left = (r?.wrong || r?.error)?.attemptsLeft;
            if (left != null) err.attemptsLeft = Math.min(err.attemptsLeft ?? left, left);
            throw err;
          }
        }
      } else await useStore.getState().authenticate(mode, form);
    } catch (err) {
      // Senha redefinida pelo administrador: entrou com o código, agora cria a senha nova.
      if (!isDesktop && err.status === 428) {
        setMode('reset');
        return;
      }
      // Muitas tentativas: aviso com contagem regressiva no lugar do erro.
      const { locked: nowLocked, hint } = lockout.track(err);
      if (nowLocked) return setError('');
      setError(
        isDesktop && err.status === 401
          ? `Usuário ou senha incorretos (neste PC e no servidor).${hint} Primeira vez neste PC? Entre com o usuário e a senha da sua conta do servidor — ou use “Criar perfil”.`
          : hint
            ? `${err.message.replace(/\.?$/, '.')}${hint}`
            : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (m) => {
    setMode(m);
    setError('');
    setNote('');
  };
  // Google: no navegador entra direto; no app do Windows o perfil local vira o da conta.
  const google = async (res) => {
    if (isDesktop) await localFromServer(res);
    else await useStore.getState().enterWithToken(res.token, res.user);
  };

  return (
    <div className="auth-page scene">
      <SceneArt wide />
      <div className={`auth-card window${busy ? ' loading' : ''}`}>
        <CardTitleBar />
        {/* Entrando: a tela de carregamento por cima, com o formulário ainda montado (volta se der erro). */}
        {busy && <LoadingBody over text={bootText || 'Entrando…'} />}
        <div className="auth-body" ref={bodyRef}>
          <div className="brand">
            <Logo size={40} />
            <span>
              Pado<em>Speak</em>
            </span>
          </div>

          {mode === 'forgot' ? null : known ? (
            <div className="auth-known" aria-hidden="true">
              <Avatar user={known} base={base} size={104} status="on" />
            </div>
          ) : (
            <div className="frame on auth-pic" aria-hidden="true">
              <div className="pic">
                <svg width="112" height="112" viewBox="0 0 112 112">
                  <circle cx="56" cy="44" r="22" />
                  <path d="M14 112c0-26 19-42 42-42s42 16 42 42z" />
                </svg>
              </div>
            </div>
          )}

          {mode !== 'forgot' && (
          <div className="aero-tabs" role="tablist" aria-label="Acesso">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`tab${mode === 'login' ? ' on' : ''}`}
              onClick={() => switchTo('login')}
            >
              Entrar
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`tab${mode === 'register' ? ' on' : ''}`}
              onClick={() => switchTo('register')}
            >
              {isDesktop ? 'Criar perfil' : 'Criar conta'}
            </button>
          </div>
          )}

          {mode === 'forgot' ? (
            <ForgotForm
              base={serverUrl}
              onBack={() => switchTo('login')}
              onReset={async (creds) => {
                // O código vale como a senha temporária: troca pela nova e já entra.
                if (isDesktop) await localRecover(creds);
                else await useStore.getState().authenticate('new-password', creds);
              }}
            />
          ) : (
          <form onSubmit={submit} className="auth-form">
            {/* Criar conta (navegador e celular): pelo e-mail, que serve para entrar e recuperar a senha. */}
            {mode === 'register' && !isDesktop ? (
              <label className="field">
                <span>E-mail</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={update('email')}
                  autoComplete="email"
                  placeholder="voce@email.com"
                  required
                  autoFocus
                />
              </label>
            ) : (
              <label className="field">
                <span>{mode === 'register' ? 'Usuário' : 'Usuário ou e-mail'}</span>
                <input
                  value={form.username}
                  onChange={update('username')}
                  autoComplete="username"
                  placeholder="seu_usuario"
                  required
                  autoFocus={!form.username}
                />
              </label>
            )}
            {mode === 'register' && (
              <label className="field">
                <span>Nome de exibição</span>
                <input value={form.displayName} onChange={update('displayName')} placeholder="Opcional" />
              </label>
            )}
            {mode === 'register' && !isDesktop && (
              <HandleField
                value={handleValue}
                onChange={setHandle}
                check={handleCheck}
                required
                placeholder="seu_usuario"
                hint={handle == null ? 'Sai do nome de exibição; mude se quiser. Dá para trocar depois.' : undefined}
              />
            )}
            {mode === 'reset' ? (
              <>
                <p className="auth-reset" role="status">
                  Sua senha foi redefinida. Crie uma senha nova para a conta <b>@{form.username.trim()}</b>
                  {isDesktop ? ': ela vale no servidor e no perfil deste PC.' : '.'}
                </p>
                <label className="field">
                  <span>Senha nova</span>
                  <input
                    type="password"
                    value={form.newPassword}
                    onChange={update('newPassword')}
                    autoComplete="new-password"
                    minLength={6}
                    placeholder="Pelo menos 6 caracteres"
                    required
                    autoFocus
                  />
                </label>
                <label className="field">
                  <span>Repita a senha nova</span>
                  <input type="password" value={form.repeat} onChange={update('repeat')} autoComplete="new-password" minLength={6} required />
                </label>
              </>
            ) : (
              <label className="field">
                <span>Senha</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={update('password')}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="••••••••"
                  required
                  autoFocus={mode === 'login' && Boolean(form.username)}
                />
              </label>
            )}
            {mode === 'register' && (
              <label className="field">
                <span>Repita a senha</span>
                <input
                  type="password"
                  value={form.confirm}
                  onChange={update('confirm')}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  required
                />
              </label>
            )}

            {note && !error && <p className="auth-note" role="status">{note}</p>}
            {locked ? <LoginLock left={lockout.left} /> : (error || localError) && <p className="error-text">{error || localError}</p>}
            <button className="go big-go" disabled={busy || locked}>
              {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : mode === 'reset' ? 'Salvar e entrar' : isDesktop ? 'Criar perfil' : 'Criar conta'}
            </button>
            {mode === 'login' && options.email && (
              <button type="button" className="link-inline auth-forgot" onClick={() => switchTo('forgot')}>
                Esqueci minha senha
              </button>
            )}
          </form>
          )}
          {/* Fora do formulário: o código do Google (app do Windows) não pode enviar o login. */}
          {mode !== 'reset' && mode !== 'forgot' && options.google && (
            <div className="auth-google">
              <div className="auth-or">
                <span>ou</span>
              </div>
              <GoogleButton base={serverUrl} onDone={google} onError={(e) => setError(e.message)} />
            </div>
          )}

          <p className="auth-legal">
            <a href={`${serverUrl}/privacidade`} target="_blank" rel="noreferrer">
              Privacidade
            </a>
            {' · '}
            <a href={`${serverUrl}/termos`} target="_blank" rel="noreferrer">
              Termos de Serviço
            </a>
          </p>
          {/* No celular/tablet: instalar como app (PWA) — botão ou o passo a passo do iPhone/iPad. */}
          {!isDesktop && <InstallCard />}
          {/* No navegador: convite para baixar o app (perfil local, rede local, bandeja do Windows). */}
          {offerWindowsApp && (
            <div className="auth-download">
              <span>ou use o app</span>
              <a className="btn secondary block" href={DOWNLOAD_URL}>
                <Download size={16} /> Baixar o PadoSpeak para Windows
              </a>
              <small>Última versão · Windows 10 e 11 · atualiza sozinho</small>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
