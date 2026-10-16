// Entrar com o Google, "esqueci minha senha" (código por e-mail) e a aba "Conta" das configurações
// (vincular o e-mail e o Google).
import { useEffect, useRef, useState } from 'react';
import { Mail, Check, X, Send, ShieldCheck } from 'lucide-react';
import { useStore } from '../store.js';
import { googleFlow, authOptions } from '../lib/google.js';

/** Opções de entrada deste servidor ({ email, google }). */
export function useAuthOptions(base) {
  const [opts, setOpts] = useState({ email: false, google: false });
  useEffect(() => {
    if (!base) return;
    let alive = true;
    authOptions(base).then((o) => alive && setOpts(o));
    return () => {
      alive = false;
    };
  }, [base]);
  return opts;
}

/** O "G" do Google, com as quatro cores. */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.7 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.2 5.6c4.2-3.9 7.1-9.6 7.1-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.2A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.2z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.7 2.3-8.7 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.2C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/**
 * Um login (ou vínculo) com o Google em andamento: `run(opções)` chama o `googleFlow` e, se a volta do Google
 * abrir em outro navegador, `ask` fica preenchido até a pessoa digitar o código que a página mostrou.
 */
function useGoogleFlow(base) {
  const [waiting, setWaiting] = useState(false);
  const [ask, setAsk] = useState(null);
  const ctrl = useRef(null);
  const answer = useRef(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  const askCode = (error) =>
    new Promise((resolve, reject) => {
      const signal = ctrl.current.signal;
      if (signal.aborted) return reject(new Error('Cancelado'));
      answer.current = resolve;
      setAsk({ error });
      signal.addEventListener('abort', () => reject(new Error('Cancelado')), { once: true });
    });
  const run = async (opts) => {
    ctrl.current = new AbortController();
    setWaiting(true);
    try {
      return await googleFlow(base, { ...opts, signal: ctrl.current.signal, askCode });
    } finally {
      setWaiting(false);
      setAsk(null);
    }
  };
  const submit = (code) => {
    setAsk(null);
    answer.current?.(code);
  };
  return { waiting, ask, run, submit, cancel: () => ctrl.current?.abort() };
}

/** "Esperando o Google…" com o cancelar e, quando preciso, o campo do código da página de retorno. */
function GoogleWaiting({ flow }) {
  const [code, setCode] = useState('');
  if (!flow.waiting) return null;
  return (
    <>
      <button type="button" className="link-inline" onClick={flow.cancel}>
        Cancelar
      </button>
      {flow.ask && (
        <form
          className="acc-form google-code"
          onSubmit={(e) => {
            e.preventDefault();
            flow.submit(code);
            setCode('');
          }}
        >
          <label className="field grow">
            <span>Código que apareceu no navegador</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={8}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABC123"
              required
              autoFocus
            />
          </label>
          <button className="btn green" disabled={code.replace(/[^a-z0-9]/gi, '').length !== 6}>
            <Check size={14} /> Confirmar
          </button>
          {flow.ask.error && <p className="error-text">{flow.ask.error}</p>}
        </form>
      )}
    </>
  );
}

/**
 * Botão "Entrar com o Google". `onDone(resultado)` recebe { token, user, created } do servidor.
 * Enquanto a pessoa está na página do Google, o botão mostra "Esperando o Google…" e dá para cancelar.
 */
export function GoogleButton({ base, onDone, onError, label = 'Entrar com o Google', disabled }) {
  const flow = useGoogleFlow(base);
  const start = async () => {
    try {
      await onDone(await flow.run({}));
    } catch (e) {
      if (e.message !== 'Cancelado') onError?.(e);
    }
  };
  return (
    <div className="google-row">
      <button type="button" className="google-btn" onClick={start} disabled={disabled || flow.waiting}>
        <GoogleG />
        {flow.waiting ? 'Esperando o Google…' : label}
      </button>
      <GoogleWaiting flow={flow} />
    </div>
  );
}

/** "Esqueci minha senha": manda o código para o e-mail da conta. */
export function ForgotForm({ base, onBack, onSent }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${base}/api/auth/forgot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
      onSent(email.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} className="auth-form">
      <p className="auth-reset">Digite o e-mail da sua conta. Mandamos um código que vale no lugar da senha por 30 minutos.</p>
      <label className="field">
        <span>E-mail</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="voce@exemplo.com" required autoFocus />
      </label>
      {error && <p className="error-text">{error}</p>}
      <button className="go big-go" disabled={busy}>
        {busy ? 'Mandando…' : 'Mandar o código'}
      </button>
      <button type="button" className="link-inline auth-back" onClick={onBack}>
        Voltar para entrar
      </button>
    </form>
  );
}

/** Configurações → Conta: e-mail (para entrar e recuperar a senha) e Google. */
export function AccountSettings() {
  const me = useStore((s) => s.me);
  const base = useStore((s) => s.baseUrl);
  const [acc, setAcc] = useState(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const st = useStore.getState();
  useEffect(() => {
    if (!me) return;
    st.getAccount()
      .then(setAcc)
      .catch((e) => setError(e.message));
  }, [me?.id]);
  if (!me) return <p className="kv">Entre na sua conta do servidor para ver as opções da conta.</p>;
  if (!acc) return <p className="kv">{error || 'Carregando…'}</p>;
  const run = async (fn, ok) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const next = await fn();
      if (next && 'hasPassword' in next) setAcc(next);
      if (ok) setNote(ok);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const showForm = !acc.email || editing;

  return (
    <div className="account-tab">
      <div className="settings-sec">E-mail</div>
      <p className="kv">Com o e-mail confirmado você entra com ele no lugar do usuário e recebe um código se esquecer a senha.</p>
      {!acc.mail && !acc.email && <p className="kv">Este servidor ainda não manda e-mails, então ainda não dá para vincular um.</p>}
      {acc.email && !editing && (
        <div className="acc-row">
          <Mail size={16} />
          <span className="acc-val">
            {acc.email} <small className="acc-ok">
              <ShieldCheck size={13} /> confirmado
            </small>
          </span>
          {acc.mail && (
            <button type="button" className="btn ghost" onClick={() => setEditing(true)}>
              Trocar
            </button>
          )}
          <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => st.removeEmail())}>
            Remover
          </button>
        </div>
      )}
      {acc.mail && showForm && (
        <form
          className="acc-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => st.startEmail(email), `Mandamos um código para ${email.trim()}. Confira a caixa de entrada (e o spam).`);
          }}
        >
          <label className="field grow">
            <span>{acc.email ? 'E-mail novo' : 'Seu e-mail'}</span>
            <input id="acc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" required />
          </label>
          <button className="btn" disabled={busy || !email.trim()}>
            <Send size={14} /> Mandar código
          </button>
          {editing && (
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          )}
        </form>
      )}
      {acc.pendingEmail && showForm && (
        <form
          className="acc-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const next = await st.verifyEmail(code);
              setEditing(false);
              setCode('');
              return next;
            }, 'E-mail confirmado.');
          }}
        >
          <label className="field grow">
            <span>Código mandado para {acc.pendingEmail}</span>
            <input
              id="acc-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
            />
          </label>
          <button className="btn green" disabled={busy || code.replace(/\D/g, '').length !== 6}>
            <Check size={14} /> Confirmar
          </button>
        </form>
      )}

      <div className="settings-sec">Google</div>
      {acc.google ? (
        <div className="acc-row">
          <GoogleG />
          <span className="acc-val">Conta Google vinculada: você pode entrar com ela.</span>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => st.unlinkGoogle())}>
            <X size={14} /> Desvincular
          </button>
        </div>
      ) : acc.googleEnabled ? (
        <>
          <p className="kv">Vincule para entrar com o Google, inclusive no celular e em outros computadores.</p>
          <LinkGoogle
            base={base}
            onLinked={() => run(() => st.getAccount(), 'Conta Google vinculada.')}
            onError={(e) => setError(e.message)}
          />
        </>
      ) : (
        <p className="kv">Este servidor ainda não tem o login com o Google.</p>
      )}
      {!acc.hasPassword && <p className="kv">Sua conta foi criada pelo Google e não tem senha. Para criar uma, use “Esqueci minha senha” na tela de entrada.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="acc-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

function LinkGoogle({ base, onLinked, onError }) {
  const flow = useGoogleFlow(base);
  return (
    <div className="google-row">
      <button
        type="button"
        className="google-btn"
        disabled={flow.waiting}
        onClick={async () => {
          try {
            await flow.run({ purpose: 'link', token: useStore.getState().sessionToken() });
            await onLinked();
          } catch (e) {
            if (e.message !== 'Cancelado') onError(e);
          }
        }}
      >
        <GoogleG />
        {flow.waiting ? 'Esperando o Google…' : 'Vincular conta Google'}
      </button>
      <GoogleWaiting flow={flow} />
    </div>
  );
}
