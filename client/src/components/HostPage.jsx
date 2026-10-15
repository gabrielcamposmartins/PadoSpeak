import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Power, Play, Copy, Check, LogIn, Globe, LogOut, RotateCcw } from 'lucide-react';
import { host } from '../lib/host.js';
import { isPanel, isTauri, isDesktop, DEFAULT_SERVER } from '../lib/env.js';
import { useStore, changeServer, disconnectServer } from '../store.js';
import { SceneArt } from './Aero.jsx';

const STATUS_TEXT = {
  off: 'Desconectado',
  connecting: 'Conectando…',
  online: 'Conectado',
  unreachable: 'Fora do ar ou sem internet — nova tentativa a cada minuto',
  login: 'Precisa entrar na conta',
  mismatch: 'Seu perfil local não tem conta lá com a mesma senha',
};

/**
 * Servidor de comunidade ao qual o app se conecta (guilds, amigos). O endereço mora aqui, nas
 * configurações de Hostear; o perfil local continua funcionando mesmo sem servidor.
 */
function ConnectionSection({ hostedUrl }) {
  const url = useStore((s) => s.baseUrl);
  const status = useStore((s) => s.serverStatus);
  const account = useStore((s) => s.me);
  const [draft, setDraft] = useState(url);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(url), [url]);
  const go = async (to) => {
    setBusy(true);
    try {
      await changeServer(to);
      const st = useStore.getState().serverStatus;
      if (st === 'login' || st === 'mismatch') useStore.getState().openModal({ type: 'serverLogin' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="glass host-addr" aria-label="Servidor de comunidade">
      <div className="sec">SERVIDOR DE COMUNIDADE (GUILDS E AMIGOS)</div>
      <form
        className="conn-row"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft);
        }}
      >
        <label className="sr-only" htmlFor="serverAddr">
          Endereço do servidor
        </label>
        <input id="serverAddr" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={DEFAULT_SERVER} />
        <button className="go" disabled={busy || !draft.trim()}>
          <Globe size={15} /> Conectar
        </button>
      </form>
      <div className={`conn-status ${status}`}>
        <span className={`orb ${status === 'online' ? 'on' : status === 'connecting' ? 'away' : 'off'}`} />
        <span className="conn-text">
          {STATUS_TEXT[status] || status}
          {account && (
            <>
              {' '}
              como <b>@{account.username}</b>
            </>
          )}
        </span>
        {(status === 'login' || status === 'mismatch') && (
          <button className="gloss small-btn" onClick={() => useStore.getState().openModal({ type: 'serverLogin' })}>
            <LogIn size={14} /> Entrar
          </button>
        )}
        {account && (
          <button className="gloss small-btn" onClick={disconnectServer} title="Sair da conta deste servidor">
            <LogOut size={14} /> Sair
          </button>
        )}
      </div>
      <div className="conn-quick">
        {url !== DEFAULT_SERVER && (
          <button className="gloss small-btn" disabled={busy} onClick={() => go(DEFAULT_SERVER)}>
            <RotateCcw size={14} /> Voltar para {DEFAULT_SERVER.replace(/^https?:\/\//, '')}
          </button>
        )}
        {hostedUrl && url !== hostedUrl && (
          <button className="gloss small-btn" disabled={busy} onClick={() => go(hostedUrl)}>
            <LogIn size={14} /> Usar o servidor que estou hospedando
          </button>
        )}
      </div>
      <p className="kv">
        Seu perfil local, as conversas e as chamadas com a rede local funcionam sem servidor. Servidores (guilds) e
        amigos ficam no servidor de comunidade. Se a conta lá tiver o mesmo usuário do perfil local, o perfil do servidor
        (nome, foto e mensagem pessoal) é o que vale: o perfil local guarda uma cópia para entrar sem internet.
      </p>
    </section>
  );
}

const BIND_OPTIONS = [
  { value: '0.0.0.0', label: 'Toda a rede (0.0.0.0)' },
  { value: '127.0.0.1', label: 'Só esta máquina (127.0.0.1)' },
];

function uptime(startedAt, now) {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

/** Tipo de cada endereço, para quem for compartilhar saber qual usar. */
function kindOf(url) {
  if (/\/\/(localhost|127\.|\[::1\])/.test(url)) return ['Esta máquina', 'local'];
  if (/\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)) return ['Rede local', 'lan'];
  return ['Internet', 'net'];
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="gloss copy-btn"
      title="Copiar"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {done ? 'Copiado' : 'Copiar'}
    </button>
  );
}

export default function HostPage() {
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(null);
  const [iceText, setIceText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState([]);
  const [now, setNow] = useState(Date.now());
  const lastLog = useRef(0);
  const logsEl = useRef(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const st = await host.status();
        if (!alive) return;
        setStatus(st);
        setDraft((d) => d || st.config);
        setIceText((t) => t || JSON.stringify(st.config.iceServers, null, 2));
        const fresh = await host.logs(lastLog.current);
        if (alive && fresh.length) {
          lastLog.current = fresh[fresh.length - 1].id;
          setLogs((l) => [...l, ...fresh].slice(-500));
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
      if (alive) setNow(Date.now());
    };
    refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const el = logsEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  if (!status || !draft) {
    // Sem o painel de hospedagem (ex.: testes no navegador), a conexão com o servidor continua aqui.
    if (isDesktop && error)
      return (
        <div className="host-page">
          <div className="host-body">
            <div className="host-col">
              <button className="gloss small-btn host-back-plain" onClick={() => useStore.getState().leaveHost()}>
                <ArrowLeft size={14} /> Voltar
              </button>
              <ConnectionSection hostedUrl={null} />
              <p className="kv">Hospedar um servidor só funciona no app desktop.</p>
            </div>
          </div>
        </div>
      );
    return <div className="boot">{error || 'Carregando painel…'}</div>;
  }

  const running = status.running;
  const locked = new Set(status.lockedKeys);
  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setDraft((d) => ({ ...d, [k]: k === 'port' ? Number(v) : v }));
  };
  const lockNote = (k) => locked.has(k) && <span className="locked"> · definido por variável de ambiente</span>;

  async function toggle() {
    setError('');
    setBusy(true);
    try {
      if (running) {
        setStatus(await host.stop());
      } else {
        let iceServers;
        try {
          iceServers = JSON.parse(iceText || '[]');
          if (!Array.isArray(iceServers)) throw new Error();
        } catch {
          throw new Error('Servidores ICE: informe uma lista JSON válida');
        }
        const st = await host.start({ ...draft, iceServers });
        setStatus(st);
        setDraft(st.config);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const hostedUrl = status.running ? `${status.config.https === 'off' ? 'http' : 'https'}://localhost:${status.config.port}` : null;

  /** Faz o app usar o servidor que este PC está hospedando. */
  function connectHere() {
    changeServer(hostedUrl).then(() => {
      const st = useStore.getState().serverStatus;
      if (st === 'login' || st === 'mismatch') useStore.getState().openModal({ type: 'serverLogin' });
      else if (st === 'online') useStore.getState().leaveHost();
    });
  }

  const s = status.stats;
  const t = status.totals;

  return (
    <div className="host-page">
      <section className={`host-band scene aqua${running ? ' running' : ''}`}>
        <SceneArt />
        {!isPanel && (
          <button
            className="gloss mini host-back"
            onClick={() => useStore.getState().leaveHost()}
            title="Voltar"
            aria-label="Voltar"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <span className={`big-orb${running ? ' on' : ''}`} aria-hidden="true" />
        <div className="host-state">
          <h1>{running ? 'Servidor rodando' : 'Servidor parado'}</h1>
          <p>
            {running
              ? `${status.config.serverName} · porta ${status.config.port} · ${
                  status.config.https === 'off' ? 'sem HTTPS' : 'HTTPS ativo'
                } · há ${uptime(status.startedAt, now)} · ${s.onlineUsers} online`
              : `${status.config.serverName} · ajuste a configuração e clique em Hostear para abrir o servidor.`}
          </p>
        </div>
        <div className="host-actions">
          {running && isTauri && (
            <button className="gloss big" onClick={connectHere}>
              <LogIn size={18} /> Entrar neste servidor
            </button>
          )}
          <button className={`${running ? 'stop' : 'go'} big host-btn`} onClick={toggle} disabled={busy}>
            {running ? <Power size={18} /> : <Play size={18} />}
            {busy ? (running ? 'Parando…' : 'Iniciando…') : running ? 'Parar servidor' : 'Hostear'}
          </button>
        </div>
      </section>
      {error && <p className="error-text host-error">{error}</p>}

      <div className="host-body">
        <section className="glass host-config" aria-label="Configuração">
          <div className="sec">
            CONFIGURAÇÃO {running && <span className="locked">· pare o servidor para editar</span>}
          </div>
          <fieldset disabled={running || busy} className="plain">
            <label className="field">
              <span>Nome do servidor{lockNote('serverName')}</span>
              <input value={draft.serverName} onChange={set('serverName')} disabled={locked.has('serverName')} />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>Porta{lockNote('port')}</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={draft.port}
                  onChange={set('port')}
                  disabled={locked.has('port')}
                />
              </label>
              <label className="field">
                <span>Escutar em{lockNote('host')}</span>
                <select value={draft.host} onChange={set('host')} disabled={locked.has('host')}>
                  {BIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  {!BIND_OPTIONS.some((o) => o.value === draft.host) && <option value={draft.host}>{draft.host}</option>}
                </select>
              </label>
            </div>
            <label className="field">
              <span>HTTPS{lockNote('https')}</span>
              <select value={draft.https} onChange={set('https')} disabled={locked.has('https')}>
                <option value="off">Desligado (HTTP)</option>
                <option value="self-signed">Certificado autoassinado</option>
                <option value="custom">Certificado próprio</option>
              </select>
            </label>
            {draft.https === 'custom' && (
              <div className="grid-2">
                <label className="field">
                  <span>Certificado (.pem/.crt){lockNote('tlsCert')}</span>
                  <input value={draft.tlsCert} onChange={set('tlsCert')} placeholder="/etc/ssl/padospeak/fullchain.pem" />
                </label>
                <label className="field">
                  <span>Chave privada{lockNote('tlsKey')}</span>
                  <input value={draft.tlsKey} onChange={set('tlsKey')} placeholder="/etc/ssl/padospeak/privkey.pem" />
                </label>
              </div>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.allowRegistration}
                onChange={set('allowRegistration')}
                disabled={locked.has('allowRegistration')}
              />
              Permitir que novas pessoas criem conta{lockNote('allowRegistration')}
            </label>
            <label className="field">
              <span>Servidores ICE — STUN/TURN (JSON){lockNote('iceServers')}</span>
              <textarea
                rows={4}
                value={iceText}
                onChange={(e) => setIceText(e.target.value)}
                disabled={locked.has('iceServers')}
                spellCheck={false}
                className="mono"
              />
              <small>
                Para chamadas entre redes diferentes (atrás de NAT restritivo), adicione um TURN, ex.:{' '}
                <code>{'{"urls":"turn:seu-ip:3478","username":"padospeak","credential":"senha"}'}</code>
              </small>
            </label>
            <div className="sec">MÚSICA (YOUTUBE)</div>
            <div className="grid-2">
              <label className="field">
                <span>Cookies do navegador{lockNote('musicCookiesBrowser')}</span>
                <select
                  value={draft.musicCookiesBrowser || ''}
                  onChange={set('musicCookiesBrowser')}
                  disabled={locked.has('musicCookiesBrowser') || Boolean(draft.musicCookiesFile)}
                >
                  <option value="">Não usar</option>
                  <option value="firefox">Firefox</option>
                  <option value="edge">Edge</option>
                  <option value="chrome">Chrome</option>
                  <option value="brave">Brave</option>
                </select>
              </label>
              <label className="field">
                <span>…ou arquivo cookies.txt{lockNote('musicCookiesFile')}</span>
                <input
                  value={draft.musicCookiesFile || ''}
                  onChange={set('musicCookiesFile')}
                  disabled={locked.has('musicCookiesFile')}
                  placeholder="C:\caminho\cookies.txt"
                />
              </label>
            </div>
            <small className="kv">
              Só é preciso se o YouTube recusar com “confirme que você não é um robô”. Use uma conta logada no navegador
              (o Firefox é o mais confiável; o Chrome no Windows pode bloquear a leitura) ou exporte um cookies.txt.
            </small>
          </fieldset>
          <div className="sec">BANCO DE DADOS (TURSO / LIBSQL)</div>
          <p className="kv">
            Modo:{' '}
            <b>{{ local: 'arquivo local', remote: 'remoto', 'embedded-replica': 'réplica embarcada' }[status.db.mode]}</b>
            {' · '}Local: <b>{status.db.location}</b>
          </p>
          <p className="kv">
            Pasta de dados: <b>{status.dataDir}</b>
          </p>
        </section>

        <div className="host-col">
          {isDesktop && <ConnectionSection hostedUrl={hostedUrl} />}
          <section className="glass host-addr" aria-label="Endereços">
            <div className="sec">CHAME A GALERA — COMPARTILHE UM DESTES ENDEREÇOS</div>
            {running ? (
              <>
                {status.urls.map((u) => {
                  const [label, cls] = kindOf(u);
                  return (
                    <div className="addr" key={u}>
                      <span className={`addr-tag ${cls}`}>{label}</span>
                      <span className="addr-url">{u}</span>
                      <CopyButton text={u} />
                    </div>
                  );
                })}
                <p className="kv">
                  Na internet, use o IP público ou um domínio, com a porta liberada no roteador/firewall.
                  {status.config.https === 'off' &&
                    ' No navegador, voz e vídeo exigem HTTPS fora de localhost — o app desktop funciona sem.'}
                </p>
              </>
            ) : (
              <p className="kv">Os endereços aparecem aqui assim que o servidor estiver no ar.</p>
            )}
          </section>

          <section className="stats" aria-label="Estatísticas">
            <div className="stat">
              <b>{s.onlineUsers}</b>
              <span>Online</span>
            </div>
            <div className="stat">
              <b>{s.voiceParticipants}</b>
              <span>Em voz</span>
            </div>
            <div className="stat">
              <b>{s.connections}</b>
              <span>Conexões</span>
            </div>
            <div className="stat">
              <b>{t.users}</b>
              <span>Contas</span>
            </div>
            <div className="stat">
              <b>{t.guilds}</b>
              <span>Servidores</span>
            </div>
            <div className="stat">
              <b>{t.messages.toLocaleString('pt-BR')}</b>
              <span>Mensagens</span>
            </div>
          </section>

          <section className="logs-panel" aria-label="Logs">
            <div className="logs-head">
              LOGS
              <span className="spacer" />
              <span className="logs-live">{running ? 'ao vivo' : 'parado'}</span>
              <span className={`orb ${running ? 'on' : 'off'}`} />
            </div>
            <div className="logs" ref={logsEl}>
              {logs.map((l) => (
                <div key={l.id} className={l.level}>
                  <time>{new Date(l.ts).toLocaleTimeString()}</time>
                  <span className="lvl">{{ warn: 'WARN', error: 'ERRO' }[l.level] || 'INFO'}</span> {l.text}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
