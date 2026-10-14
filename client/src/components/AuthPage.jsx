import { useState } from 'react';
import { Server, Wifi, Download } from 'lucide-react';
import { useStore, localAuthenticate, connRegistry, knownProfiles, lastProfile } from '../store.js';
import Avatar from './Avatar.jsx';
import { isDesktop, DOWNLOAD_URL } from '../lib/env.js';
import Logo from './Logo.jsx';
import { SceneArt, TitleBar } from './Aero.jsx';

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
  const [form, setForm] = useState(() => ({ username: lastProfile(base), password: '', displayName: '' }));
  // Como no Messenger: a foto de quem já entrou neste PC aparece ao digitar o usuário.
  const known = mode === 'login' ? knownProfiles(base)[form.username.trim().toLowerCase()] : null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isDesktop) await localAuthenticate(mode, form);
      else await useStore.getState().authenticate(mode, form);
    } catch (err) {
      setError(
        isDesktop && err.status === 401
          ? 'Usuário ou senha incorretos neste PC. Ainda não tem perfil aqui? Use “Criar perfil”.'
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (m) => {
    setMode(m);
    setError('');
  };

  return (
    <div className="auth-page scene">
      <SceneArt wide />
      <div className="auth-card window">
        <TitleBar title="PadoSpeak" />
        <div className="auth-body">
          <div className="brand">
            <Logo size={40} />
            <span>
              Pado<em>Speak</em>
            </span>
          </div>

          {known ? (
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

          <form onSubmit={submit} className="auth-form">
            <label className="field">
              <span>Usuário</span>
              <input
                value={form.username}
                onChange={update('username')}
                autoComplete="username"
                placeholder="seu_usuario"
                required
                autoFocus={!form.username}
              />
            </label>
            {mode === 'register' && (
              <label className="field">
                <span>Nome de exibição</span>
                <input value={form.displayName} onChange={update('displayName')} placeholder="Opcional" />
              </label>
            )}
            <label className="field">
              <span>Senha</span>
              <input
                type="password"
                value={form.password}
                onChange={update('password')}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="••••••••"
                required
                autoFocus={Boolean(form.username)}
              />
            </label>

            {isDesktop ? (
              <div className="server-box">
                <Wifi size={16} />
                <div className="server-text">
                  Perfil local · funciona sem internet
                  <span className="server-hint">
                    Depois de entrar, o PadoSpeak mostra quem está na sua rede e conecta ao servidor
                    {' '}
                    {serverUrl.replace(/^https?:\/\//, '')} se a sua conta lá tiver o mesmo usuário e senha.
                  </span>
                </div>
              </div>
            ) : (
              <div className="server-box">
                <Server size={16} />
                <div className="server-text">
                  Servidor
                  <b title={serverUrl}>{serverUrl}</b>
                </div>
              </div>
            )}

            {(error || localError) && <p className="error-text">{error || localError}</p>}
            <button className="go big-go" disabled={busy}>
              {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : isDesktop ? 'Criar perfil' : 'Criar conta'}
            </button>
          </form>

          {/* No navegador: convite para baixar o app (perfil local, rede local, bandeja do Windows). */}
          {!isDesktop && (
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
