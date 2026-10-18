// Entrar com o Google, "esqueci minha senha" (código por e-mail) e a aba "Conta" das configurações
// (vincular o e-mail e o Google).
import { useEffect, useRef, useState } from 'react';
import { Mail, Check, X, Send, ShieldCheck, KeyRound, MailCheck, ArrowLeft, AtSign } from 'lucide-react';
import { useStore, connRegistry } from '../store.js';
import { isDesktop } from '../lib/env.js';
import { plain } from '../lib/text.js';
import { googleFlow, authOptions } from '../lib/google.js';

/** Opções de entrada deste servidor ({ email, google }). */
export function useAuthOptions(base) {
  // Começa com as da última vez: o formulário já abre no tamanho certo (no app do Windows a janela tem a
  // altura dele) em vez de crescer quando a resposta chega.
  const key = `padospeak.authOptions:${base}`;
  const [opts, setOpts] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key)) || { email: false, google: false };
    } catch {
      return { email: false, google: false };
    }
  });
  useEffect(() => {
    if (!base) return;
    let alive = true;
    authOptions(base).then((o) => {
      if (!alive) return;
      setOpts(o);
      // Sem resposta (sem internet) vem tudo desligado: não apaga o que já se sabia.
      try {
        if (o.email || o.google) localStorage.setItem(key, JSON.stringify(o));
      } catch {}
    });
    return () => {
      alive = false;
    };
  }, [base, key]);
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
  const ready = code.replace(/[^a-z0-9]/gi, '').length === 6;
  const send = () => {
    flow.submit(code);
    setCode('');
  };
  return (
    <>
      <button type="button" className="link-inline" onClick={flow.cancel}>
        Cancelar
      </button>
      {flow.ask && (
        // Sem <form>: o botão do Google costuma ficar dentro do formulário de login, e um formulário dentro
        // do outro faz o navegador enviar (e recarregar) a página ao confirmar o código.
        <div className="acc-form google-code" role="group" aria-label="Código do Google">
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
              autoFocus
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                e.stopPropagation();
                if (ready) send();
              }}
            />
          </label>
          <button type="button" className="btn green" disabled={!ready} onClick={send}>
            <Check size={14} /> Confirmar
          </button>
          {flow.ask.error && <p className="error-text">{flow.ask.error}</p>}
        </div>
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

/** Formata o código de recuperação enquanto a pessoa digita: ABCD-EFGH. */
const fmtResetCode = (v) => {
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};
/** a•••@gmail.com */
const maskEmail = (e) => e.replace(/^(.)[^@]*(@.*)$/, (_, a, d) => `${a}•••${d}`);

/**
 * "Esqueci minha senha", em três passos na mesma tela: o e-mail da conta, o código que chega por e-mail e
 * a senha nova. `onReset({ username, password, newPassword })` troca a senha e entra (o código vale como
 * a senha temporária).
 */
export function ForgotForm({ base, onBack, onReset }) {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${base}/api/auth/forgot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
      setStep('code');
      setWait(60);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setError('');
    if (pass.length < 6) return setError('A senha nova precisa de pelo menos 6 caracteres.');
    if (pass !== repeat) return setError('As duas senhas não são iguais.');
    setBusy(true);
    try {
      await onReset({ username: email.trim(), password: code, newPassword: pass });
    } catch (err) {
      setError(err.status === 401 ? 'Código incorreto ou vencido. Confira o e-mail ou peça outro código.' : err.message);
    } finally {
      setBusy(false);
    }
  };
  const steps = [
    ['email', 'E-mail'],
    ['code', 'Nova senha'],
  ];
  const at = steps.findIndex(([k]) => k === step);

  return (
    <div className="recover">
      <div className="recover-head">
        <span className="recover-orb" aria-hidden="true">
          {step === 'email' ? <KeyRound size={26} /> : <MailCheck size={26} />}
        </span>
        <div>
          <h2>{step === 'email' ? 'Recuperar a senha' : 'Confira o seu e-mail'}</h2>
          <p>
            {step === 'email'
              ? 'Digite o e-mail confirmado da sua conta. Mandamos um código para você criar uma senha nova.'
              : `Se ${maskEmail(email.trim())} for de uma conta, o código já está chegando. Ele vale por 30 minutos; confira também o spam.`}
          </p>
        </div>
      </div>
      <ol className="recover-steps" aria-label="Etapas">
        {steps.map(([k, label], i) => (
          <li key={k} className={i < at ? 'done' : i === at ? 'on' : ''} aria-current={i === at ? 'step' : undefined}>
            <span className="dot">{i < at ? <Check size={12} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {step === 'email' ? (
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label className="field">
            <span>E-mail</span>
            <span className="input-ico">
              <Mail size={16} aria-hidden="true" />
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="voce@exemplo.com" required autoFocus />
            </span>
          </label>
          {error && <p className="error-text">{error}</p>}
          <button className="go big-go" disabled={busy || !email.trim()}>
            {busy ? 'Mandando…' : 'Mandar o código'}
          </button>
        </form>
      ) : (
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="field">
            <span>Código do e-mail</span>
            <input
              className="recover-code"
              value={code}
              onChange={(e) => setCode(fmtResetCode(e.target.value))}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABCD-EFGH"
              inputMode="text"
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>Senha nova</span>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" minLength={6} placeholder="Pelo menos 6 caracteres" required />
          </label>
          <label className="field">
            <span>Repita a senha nova</span>
            <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" minLength={6} required />
          </label>
          {error && <p className="error-text">{error}</p>}
          <button className="go big-go" disabled={busy || code.length !== 9}>
            {busy ? 'Salvando…' : 'Salvar a senha e entrar'}
          </button>
          <div className="recover-links">
            <button type="button" className="link-inline" disabled={wait > 0 || busy} onClick={send}>
              {wait > 0 ? `Mandar outro código em ${wait} s` : 'Mandar outro código'}
            </button>
            <button
              type="button"
              className="link-inline"
              onClick={() => {
                setStep('email');
                setError('');
                setCode('');
              }}
            >
              Usar outro e-mail
            </button>
          </div>
        </form>
      )}
      <button type="button" className="link-inline auth-back" onClick={onBack}>
        <ArrowLeft size={14} /> Voltar para entrar
      </button>
    </div>
  );
}

/** Um @ válido a partir de um nome ou e-mail: sem acentos, espaço vira "_", 3–24 letras, números, _ ou . */
export function handleFrom(text) {
  const base = plain(String(text || ''))
    .split('@')[0]
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.]/g, '')
    .toLowerCase()
    .slice(0, 24);
  return base.length >= 3 ? base : base ? `${base}${'user'.slice(base.length)}` : '';
}

/**
 * Confere enquanto a pessoa digita se o @ está livre: { state: 'idle' | 'checking' | 'ok' | 'taken', error }.
 * `current`: o @ que já é da pessoa (sempre livre para ela).
 */
export function useHandleCheck(value, current = '') {
  const [res, setRes] = useState({ state: 'idle', error: '' });
  useEffect(() => {
    const v = value.trim().replace(/^@/, '');
    if (!v || v.toLowerCase() === current.toLowerCase()) return setRes({ state: 'idle', error: '' });
    setRes({ state: 'checking', error: '' });
    let alive = true;
    const t = setTimeout(() => {
      useStore
        .getState()
        .usernameAvailable(v)
        .then((r) => alive && setRes(r.available ? { state: 'ok', error: '' } : { state: 'taken', error: r.error || 'Esse @ já é de outra pessoa' }))
        .catch(() => alive && setRes({ state: 'idle', error: '' }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value, current]);
  return res;
}

/** Campo do @ com o aviso de livre ou já usado embaixo. */
export function HandleField({ value, onChange, check, label = 'Usuário (@)', hint, ...rest }) {
  const id = useRef(`handle-${Math.random().toString(36).slice(2)}`).current;
  return (
    <label className="field grow handle-field">
      <span>{label}</span>
      <span className="handle-input">
        <AtSign size={14} aria-hidden="true" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/^@/, '').replace(/\s/g, ''))}
          autoComplete="username"
          spellCheck={false}
          maxLength={24}
          aria-describedby={id}
          aria-invalid={check.state === 'taken' || undefined}
          {...rest}
        />
      </span>
      <small id={id} className={`handle-note ${check.state}`} aria-live="polite">
        {check.state === 'checking'
          ? 'Conferindo…'
          : check.state === 'ok'
            ? '✓ Disponível'
            : check.state === 'taken'
              ? check.error
              : hint || '3 a 24 letras, números, _ ou .'}
      </small>
    </label>
  );
}

/** Configurações → Conta: trocar o @ (ninguém pode ter o mesmo). */
function HandleSettings({ me }) {
  const [value, setValue] = useState(me.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const check = useHandleCheck(value, me.username);
  useEffect(() => setValue(me.username), [me.username]);
  const changed = value.trim() && value.trim() !== me.username;
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNote('');
    try {
      const user = await useStore.getState().changeUsername(value);
      // App do Windows: o perfil local deste PC acompanha o @ da conta do servidor.
      if (isDesktop) await connRegistry.get('local')?.getState().changeUsername(user.username).catch(() => {});
      setNote(`Pronto: agora você é @${user.username}. Para entrar, use o @ novo (ou o e-mail).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="settings-sec">Usuário (@)</div>
      <p className="kv">É como as pessoas te acham e te mencionam. Ninguém pode ter o mesmo @ que outra pessoa.</p>
      <form className="acc-form" onSubmit={save}>
        <HandleField value={value} onChange={setValue} check={check} label="Seu @" />
        <button className="btn" disabled={busy || !changed || check.state === 'taken' || check.state === 'checking'}>
          <Check size={14} /> Salvar
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {note && (
        <p className="acc-note" role="status">
          {note}
        </p>
      )}
    </>
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
      <HandleSettings me={me} />
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
      <div className="settings-sec">Seus dados</div>
      <p className="kv">
        Veja o que o PadoSpeak guarda e as regras de uso:{' '}
        <a href={`${base}/privacidade`} target="_blank" rel="noreferrer">
          Política de Privacidade
        </a>{' '}
        e{' '}
        <a href={`${base}/termos`} target="_blank" rel="noreferrer">
          Termos de Serviço
        </a>
        .
      </p>
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
