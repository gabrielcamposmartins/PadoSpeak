import { useEffect, useRef, useState } from 'react';
import {
  Hash,
  Volume2,
  MessageSquare,
  Phone,
  UserPlus,
  UserMinus,
  UserCheck,
  Camera,
  Trash2,
  Vibrate,
  BellOff,
  X,
  Download,
  Lock,
  Crown,
  Shield,
  FileText,
  FileArchive,
  FileVideo,
  FileAudio,
  File as FileIcon,
  LogOut,
} from 'lucide-react';
import {
  useStore,
  getConn,
  primaryConn,
  activeVoiceConn,
  connRegistry,
  syncProfileEverywhere,
  localLogout,
  serverAuthenticate,
  usePerms,
  PERM,
} from '../store.js';
import { isDesktop, isTauri } from '../lib/env.js';
import { ConnProvider, useConn } from './conn.jsx';
import Avatar, { useUser, UserName, colorClass, colorStyle } from './Avatar.jsx';
import LatencyChart from './LatencyChart.jsx';
import { TitleBar } from './Aero.jsx';
import { FormattedText } from './Emotes.jsx';
import FormatTools from './FormatTools.jsx';
import { fmtSize } from './Files.jsx';
import { plain, visibleLength } from '../lib/text.js';

const TITLES = {
  profile: 'Perfil',
  editProfile: 'Meu perfil',
  newDm: 'Nova conversa',
  diagnostics: 'Diagnóstico da chamada',
  guild: 'Servidor',
  channel: 'Novo canal',
  invite: 'Convite',
  confirm: 'Confirmar',
  settings: 'Configurações',
  serverLogin: 'Entrar no servidor',
  guildSettings: 'Configurações do servidor',
};

/** Fundo do banner do perfil (acima da foto) a partir de uma cor. */
const bannerBackground = (c) => `linear-gradient(135deg, color-mix(in srgb, ${c} 55%, #fff), ${c})`;

/** Paleta pronta da cor do sistema (todas combinam com o visual Aero). */
export const ACCENTS = [
  ['#1a8fd6', 'Céu'],
  ['#18aab2', 'Aqua'],
  ['#3c9c15', 'Grama'],
  ['#d93f3a', 'Pado'],
  ['#e8a317', 'Sol'],
  ['#8c63e0', 'Ametista'],
  ['#f07a3c', 'Coral'],
  ['#4c6d86', 'Grafite'],
];

/** Escolha de cor: paleta pronta, seletor livre e "padrão". */
function ColorChoice({ value, onChange, palette, label, defaultLabel = 'Padrão' }) {
  const custom = value && !palette.some(([hex]) => hex.toLowerCase() === value.toLowerCase());
  return (
    <div className="color-choice" role="radiogroup" aria-label={label}>
      <button
        type="button"
        role="radio"
        aria-checked={!value}
        className={`swatch-btn none${!value ? ' on' : ''}`}
        title={defaultLabel}
        onClick={() => onChange(null)}
      >
        {defaultLabel}
      </button>
      {palette.map(([hex, name]) => (
        <button
          key={hex}
          type="button"
          role="radio"
          aria-checked={value?.toLowerCase() === hex.toLowerCase()}
          aria-label={name}
          title={name}
          className={`swatch-btn${value?.toLowerCase() === hex.toLowerCase() ? ' on' : ''}`}
          style={{ '--sw': hex }}
          onClick={() => onChange(hex)}
        />
      ))}
      <label className={`swatch-btn picker${custom ? ' on' : ''}`} title="Escolher outra cor" style={custom ? { '--sw': value } : undefined}>
        <input
          type="color"
          aria-label={`${label}: outra cor`}
          value={value || palette[0][0]}
          onChange={(e) => onChange(e.target.value)}
        />
        <span aria-hidden="true">+</span>
      </label>
    </div>
  );
}

function Modal({ children, onClose, size, title }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${size ? ` ${size}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <TitleBar title={`PadoSpeak — ${title}`} onClose={onClose} />
        {children}
      </div>
    </div>
  );
}

/** Formulário com estado de envio e erro, comum aos modais. */
function useAction(fn, close) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await fn();
      close();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function GuildModal({ close }) {
  const me = useStore((s) => s.me);
  if (!me)
    return (
      <>
        <div className="modal-body">
          <h2>Servidores ficam num servidor</h2>
          <p className="sub">
            Para criar ou entrar em servidores (como o “padoru”), conecte-se a um servidor de comunidade — ou hospede o
            seu neste PC e convide a galera.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={close}>
            Agora não
          </button>
          <button
            className="btn"
            onClick={() => {
              close();
              useStore.getState().goHost();
            }}
          >
            Abrir Hostear
          </button>
        </div>
      </>
    );
  return <GuildForm close={close} me={me} />;
}

function GuildForm({ close, me }) {
  const [tab, setTab] = useState('create');
  const [name, setName] = useState(`Servidor de ${plain(me.displayName)}`);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction(
    () => (tab === 'create' ? useStore.getState().createGuild(name) : useStore.getState().joinGuild(code)),
    close,
  );
  return (
    <form onSubmit={run}>
      <div className="modal-body">
        <h2>{tab === 'create' ? 'Crie seu servidor' : 'Entre em um servidor'}</h2>
        <p className="sub">
          {tab === 'create'
            ? 'Seu servidor é onde você e seus amigos se encontram.'
            : 'Cole abaixo o convite que você recebeu.'}
        </p>
        <div className="tabs">
          <button type="button" className={tab === 'create' ? 'active' : ''} onClick={() => setTab('create')}>
            Criar
          </button>
          <button type="button" className={tab === 'join' ? 'active' : ''} onClick={() => setTab('join')}>
            Entrar com convite
          </button>
        </div>
        {tab === 'create' ? (
          <label className="field">
            <span>Nome do servidor</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={48} required />
          </label>
        ) : (
          <label className="field">
            <span>Link ou código do convite</span>
            <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="a1b2c3d4e5" required />
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button className="btn" disabled={busy}>
          {tab === 'create' ? 'Criar' : 'Entrar'}
        </button>
      </div>
    </form>
  );
}

function ChannelModal({ close, guildId, channelType, channelId }) {
  const channel = useStore((s) => s.guildData[guildId]?.channels.find((c) => c.id === channelId));
  const members = useStore((s) => s.guildData[guildId]?.members) || [];
  const memberPerms = useStore((s) => s.guildData[guildId]?.perms) || {};
  const access = useStore((s) => s.guildData[guildId]?.channelAccess?.[channelId]);
  const ownerId = useStore((s) => s.guilds.find((g) => g.id === guildId)?.ownerId);
  const perms = usePerms(useStore, guildId);
  const editing = Boolean(channel);
  const [type, setType] = useState(channel?.type || channelType || 'text');
  const [name, setName] = useState(channel?.name || '');
  const [isPrivate, setPrivate] = useState(Boolean(channel?.private));
  const [allowed, setAllowed] = useState(() => new Set(access || []));
  // Dono e admins sempre veem; a lista é só para os outros.
  const alwaysSees = (m) => m.id === ownerId || (memberPerms[m.id] & PERM.ADMIN) !== 0;
  const { busy, error, run } = useAction(async () => {
    const st = useStore.getState();
    if (!editing) return st.createChannel(guildId, name, type);
    if (name.trim() !== channel.name) await st.updateChannel(channelId, name);
    const before = new Set(access || []);
    const changed =
      isPrivate !== Boolean(channel.private) ||
      (isPrivate && (before.size !== allowed.size || [...allowed].some((id) => !before.has(id))));
    if (perms.admin && changed) await st.setChannelAccess(channelId, isPrivate, [...allowed]);
  }, close);
  return (
    <form onSubmit={run}>
      <div className="modal-body">
        <h2>{editing ? `Editar ${type === 'text' ? '#' : ''}${channel.name}` : 'Criar canal'}</h2>
        <p className="sub">&nbsp;</p>
        {!editing && (
          <>
            <div className={`radio-card${type === 'text' ? ' active' : ''}`} onClick={() => setType('text')}>
              <Hash />
              <div>
                Texto<small>Mensagens, links e opiniões</small>
              </div>
            </div>
            <div className={`radio-card${type === 'voice' ? ' active' : ''}`} onClick={() => setType('voice')}>
              <Volume2 />
              <div>
                Voz<small>Voz, vídeo e compartilhamento de tela em 1080p</small>
              </div>
            </div>
          </>
        )}
        <label className="field" style={{ marginTop: editing ? 0 : 16 }}>
          <span>Nome do canal</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'text' ? 'novo-canal' : 'Sala de jogos'}
            maxLength={32}
            required
          />
        </label>
        {editing && perms.admin && (
          <div className="channel-access">
            <label className="checkbox">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
              <span>
                <Lock size={13} /> Canal privado
                <small className="check-hint">
                  Só as pessoas marcadas abaixo veem este canal (o dono e os administradores sempre veem).
                </small>
              </span>
            </label>
            {isPrivate && (
              <div className="access-list" role="group" aria-label="Quem pode ver o canal">
                {members.map((m) => {
                  const always = alwaysSees(m);
                  return (
                    <label key={m.id} className={`access-row${always ? ' always' : ''}`}>
                      <input
                        type="checkbox"
                        checked={always || allowed.has(m.id)}
                        disabled={always}
                        onChange={(e) => {
                          const next = new Set(allowed);
                          if (e.target.checked) next.add(m.id);
                          else next.delete(m.id);
                          setAllowed(next);
                        }}
                      />
                      <Avatar user={m} size={22} frame={false} />
                      <UserName user={m} className="access-name" />
                      {always && <small>{m.id === ownerId ? 'dono' : 'admin'}</small>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button className="btn" disabled={busy || !name.trim()}>
          {editing ? 'Salvar' : 'Criar canal'}
        </button>
      </div>
    </form>
  );
}

const isLoopback = (url) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(url);

function InviteModal({ close, guild }) {
  const serverUrl = useStore((s) => s.serverUrl);
  const addresses = useStore((s) => s.config?.addresses) || [];
  // Quem hospeda costuma estar conectado via localhost; o convite precisa do endereço na rede.
  const options = isLoopback(serverUrl) && addresses.length ? addresses : [serverUrl];
  const [base, setBase] = useState(options[0]);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState(guild.inviteCode || '');
  useEffect(() => {
    if (!code) useStore.getState().fetchInvite(guild.id).then(setCode, (e) => useStore.getState().notify(e.message));
  }, [guild.id]);
  const link = code ? `${base}/invite/${code}` : 'Carregando…';
  return (
    <>
      <div className="modal-body">
        <h2>Convide amigos para {guild.name}</h2>
        <p className="sub">Quem abrir o link (ou colar o código em “Entrar com convite”) entra no servidor.</p>
        {options.length > 1 && (
          <label className="field">
            <span>Endereço do servidor</span>
            <select
              value={base}
              onChange={(e) => {
                setBase(e.target.value);
                setCopied(false);
              }}
            >
              {options.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="field">
          <span>Link de convite</span>
          <div className="copy-row">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button
              className={`btn${copied ? ' green' : ''}`}
              onClick={() => {
                navigator.clipboard?.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <small>
            Código: <code>{code || '…'}</code> · No app PadoSpeak, use o endereço <code>{base}</code> na tela de
            login.
          </small>
        </div>
      </div>
      <div className="modal-foot">
        <span />
        <button className="btn" onClick={close}>
          Pronto
        </button>
      </div>
    </>
  );
}

function ConfirmModal({ close, title, text, action }) {
  const { busy, error, run } = useAction(action, close);
  return (
    <>
      <div className="modal-body">
        <h2>{title}</h2>
        {text && <p className="sub">{text}</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button className="btn red" onClick={run} disabled={busy} autoFocus>
          Confirmar
        </button>
      </div>
    </>
  );
}

function DeviceSelect({ k, kind, label, choice, setChoice, devices }) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={choice[k]} onChange={(e) => setChoice((c) => ({ ...c, [k]: e.target.value }))}>
        <option value="">Padrão do sistema</option>
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Dispositivo ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Nome das cenas: o mesmo índice vale para o claro e o escuro (Céu↔Noite, Aquário↔Abismo). */
const SCENES = [
  ['Céu', 'Céu de dia · Noite no tema escuro'],
  ['Aquário', 'Aquário · Abismo no tema escuro'],
  ['Aurora', 'Aurora (nos dois temas)'],
  ['Sistema', 'Céu na cor do sistema'],
];

function SettingsModal({ close }) {
  const prim = primaryConn();
  const me = prim((s) => s.me);
  const serverUrl = prim((s) => s.baseUrl);
  const accent = useStore((s) => s.prefs.accent || null);
  const saved = useStore((s) => s.prefs.devices) || {};
  const [devices, setDevices] = useState([]);
  const [choice, setChoice] = useState({ mic: '', camera: '', output: '', ...saved });
  const [rnnoise, setRnnoise] = useState(useStore.getState().prefs.noiseSuppression !== false);
  const [sounds, setSounds] = useState(useStore.getState().prefs.sounds !== false);
  const [repeatAlerts, setRepeatAlerts] = useState(useStore.getState().prefs.repeatAlerts !== false);
  // App desktop: iniciar com o Windows (abre minimizado na bandeja).
  const [autostart, setAutostart] = useState(null);
  const [autostartOn, setAutostartOn] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('autostart_get'))
      .then((a) => {
        setAutostart(a);
        setAutostartOn(a.enabled);
      })
      .catch(() => {});
  }, []);
  const [watch, setWatch] = useState(() => {
    const p = useStore.getState().prefs;
    return {
      autoWatchCamera: Boolean(p.autoWatchCamera),
      autoWatchScreen: Boolean(p.autoWatchScreen),
      autoWatchDmCamera: p.autoWatchDmCamera !== false,
    };
  });
  const nudge = prim((s) => s.nudgeSettings);
  const [theme, setTheme] = useState(useStore.getState().prefs.theme || 'light');
  const [scene, setScene] = useState(useStore.getState().prefs.scene ?? 0);
  const [needsPermission, setNeedsPermission] = useState(false);
  const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => {
        setDevices(list);
        setNeedsPermission(list.some((d) => !d.label));
      })
      .catch(() => {});
  }, []);

  const props = { choice, setChoice, devices };

  return (
    <>
      <div className="modal-body">
        <h2>Configurações</h2>
        <p className="sub">
          {isDesktop ? (
            <>
              Perfil local <b>@{me.username}</b> neste PC
            </>
          ) : (
            <>
              Conectado como <b>@{me.username}</b> em {serverUrl}
            </>
          )}
        </p>
        <div className="settings-cols">
          <section className="settings-col">
            <div className="settings-sec">Aparência</div>
            <label className="field">
              <span>Tema</span>
              <select
                value={theme}
                onChange={(e) => {
                  setTheme(e.target.value);
                  useStore.getState().setAppearance({ theme: e.target.value });
                }}
              >
                <option value="light">Claro (Aero) — padrão</option>
                <option value="dark">Escuro (Aero noturno)</option>
                <option value="system">Igual ao sistema</option>
              </select>
            </label>
            <div className="field">
              <span>Cena do perfil</span>
              <div className="scene-pick" role="radiogroup" aria-label="Cena do perfil">
                {SCENES.map(([name, hint], i) => (
                  <button
                    key={name}
                    title={hint}
                    type="button"
                    role="radio"
                    aria-checked={scene === i}
                    className={`scene-swatch s${i}${scene === i ? ' on' : ''}`}
                    onClick={() => {
                      setScene(i);
                      useStore.getState().setAppearance({ scene: i });
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Cor do sistema</span>
              <ColorChoice
                label="Cor do sistema"
                value={accent}
                palette={ACCENTS}
                defaultLabel="Aero"
                onChange={(hex) => useStore.getState().setAppearance({ accent: hex })}
              />
              <small>Seleções, abas, links e o brilho dos botões. A cena “Sistema” pinta o céu do topo com ela.</small>
            </div>
            <div className="settings-sec">Chamar atenção</div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={nudge?.allowNudges ?? true}
                disabled={!nudge}
                onChange={(e) => {
                  for (const c of connRegistry.values()) if (c.getState().me) c.getState().setAllowNudges(e.target.checked);
                }}
              />
              <span>
                Permitir que chamem a minha atenção
                <small className="check-hint">
                  A janela treme, pisca laranja na barra de tarefas e toca um som. Cada pessoa pode chamar até 3 vezes por
                  minuto.
                </small>
              </span>
            </label>
            {nudge?.allowNudges !== false && (
              <div className="block-list">
                <div className="block-title">Não aceitar de ({nudge?.nudgeBlocks.length || 0})</div>
                {nudge?.nudgeBlocks.length ? (
                  nudge.nudgeBlocks.map((u) => (
                    <div className="block-row" key={u.id}>
                      <Avatar user={u} size={22} frame={false} />
                      <span className="nm">
                        <FormattedText text={u.displayName} /> <small>@{u.username}</small>
                      </span>
                      <button
                        type="button"
                        className="gloss mini"
                        title="Voltar a aceitar"
                        aria-label={`Voltar a aceitar de ${plain(u.displayName)}`}
                        onClick={() => prim.getState().setNudgeBlocked(u.id, false)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="kv">Ninguém bloqueado. Para bloquear alguém, abra o perfil da pessoa.</p>
                )}
              </div>
            )}
          </section>
          <section className="settings-col">
            <div className="settings-sec">Voz e áudio</div>
            <DeviceSelect {...props} k="mic" kind="audioinput" label="Microfone" />
            <label className="checkbox">
              <input type="checkbox" checked={rnnoise} onChange={(e) => setRnnoise(e.target.checked)} />
              <span>
                Supressão de ruído por IA (RNNoise)
                <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>
                  Remove teclado, ventilador e barulho de fundo do seu microfone.
                </small>
              </span>
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={sounds} onChange={(e) => setSounds(e.target.checked)} />
              <span>
                Sons de chamada
                <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>
                  Entradas e saídas no canal de voz, transmissões, mensagens diretas e toque de chamada.
                </small>
              </span>
            </label>
            {canPickOutput && <DeviceSelect {...props} k="output" kind="audiooutput" label="Saída de áudio" />}
            <DeviceSelect {...props} k="camera" kind="videoinput" label="Câmera" />
            {needsPermission && (
              <p className="kv">
                Os nomes dos dispositivos aparecem depois que você permitir o acesso (entre em um canal de voz).
              </p>
            )}
            <div className="settings-sec">Vídeo e transmissões</div>
            <p className="kv">
              Câmeras e transmissões só chegam quando você clica para ver — assim não gastam sua internet à toa.
            </p>
            {[
              ['autoWatchDmCamera', 'Ver a câmera automaticamente em chamadas diretas', 'Chamadas de voz entre você e um amigo.'],
              ['autoWatchCamera', 'Ver câmeras automaticamente nos servidores', 'Abre a câmera de todo mundo do canal de voz.'],
              ['autoWatchScreen', 'Assistir transmissões automaticamente', 'Abre toda tela compartilhada assim que começar.'],
            ].map(([k, label, hint]) => (
              <label className="checkbox" key={k}>
                <input type="checkbox" checked={watch[k]} onChange={(e) => setWatch({ ...watch, [k]: e.target.checked })} />
                <span>
                  {label}
                  <small className="check-hint">{hint}</small>
                </span>
              </label>
            ))}
            {autostart?.available && (
              <>
                <div className="settings-sec">Sistema</div>
                <label className="checkbox">
                  <input type="checkbox" checked={autostartOn} onChange={(e) => setAutostartOn(e.target.checked)} />
                  <span>
                    Iniciar o PadoSpeak com o Windows
                    <small className="check-hint">Abre minimizado na bandeja, perto do relógio, para receber mensagens e chamadas.</small>
                  </span>
                </label>
              </>
            )}
            <div className="settings-sec">Notificações</div>
            <label className="checkbox">
              <input type="checkbox" checked={repeatAlerts} onChange={(e) => setRepeatAlerts(e.target.checked)} />
              <span>
                Receber notificações repetidas
                <small className="check-hint">
                  Desligado: se um amigo ficar online várias vezes seguidas (ou alternar entre offline e online), você
                  recebe no máximo um aviso dessa pessoa a cada 10 minutos.
                </small>
              </span>
            </label>
          </section>
        </div>
      </div>
      <div className="modal-foot">
        <button
          className="btn red"
          onClick={() => {
            close();
            if (isDesktop) localLogout();
            else useStore.getState().logout();
          }}
        >
          Sair da conta
        </button>
        <button
          className="btn"
          onClick={() => {
            useStore.getState().setDevices(choice);
            useStore.getState().setSounds(sounds);
            useStore.getState().setRepeatAlerts(repeatAlerts);
            if (autostart?.available && autostartOn !== autostart.enabled)
              import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke('autostart_set', { on: autostartOn }))
                .catch((e) => useStore.getState().notify(`Iniciar com o Windows: ${e}`));
            useStore.getState().setWatchPrefs(watch);
            if (rnnoise !== (useStore.getState().prefs.noiseSuppression !== false))
              useStore.getState().setNoiseSuppression(rnnoise);
            close();
          }}
        >
          Salvar
        </button>
      </div>
    </>
  );
}

function DiagnosticsModal({ close }) {
  const [text, setText] = useState(() => activeVoiceConn().getState().diagnostics());
  const [latency, setLatency] = useState(() => activeVoiceConn().getState().latencyHistory());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      setText(activeVoiceConn().getState().diagnostics());
      setLatency(activeVoiceConn().getState().latencyHistory());
    }, 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <div className="modal-body">
        <h2>Diagnóstico da chamada</h2>
        <p className="sub">Latência e estado da conexão com cada participante.</p>
        <LatencyChart data={latency} />
        <details className="diag-details">
          <summary>Relatório técnico</summary>
          <textarea className="diag" readOnly value={text} onFocus={(e) => e.target.select()} />
        </details>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={close}>
          Fechar
        </button>
        <button
          className={`btn${copied ? ' green' : ''}`}
          onClick={() => {
            navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? 'Copiado' : 'Copiar relatório'}
        </button>
      </div>
    </>
  );
}

// ---------- Perfil ----------

const fmtDate = (ts) => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });

function ProfileModal({ close, userId, conn }) {
  return (
    <ConnProvider conn={conn}>
      <ProfileCard close={close} userId={userId} />
    </ConnProvider>
  );
}

function ProfileCard({ close, userId }) {
  const useC = useConn();
  const isServer = useC((s) => s.kind === 'server');
  const me = useC((s) => s.me);
  const friend = useC((s) => s.friends[userId]);
  const online = useC((s) => Boolean(s.online[userId]));
  const nudgeBlocked = useC((s) => Boolean(s.nudgeSettings?.nudgeBlocks.some((u) => u.id === userId)));
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const user = useUser(profile?.user);
  const { openDm, callUser, sendFriendRequest, acceptFriend, removeFriend } = useC.getState();
  const { openModal } = useStore.getState();

  useEffect(() => {
    useC
      .getState()
      .fetchProfile(userId)
      .then(setProfile)
      .catch((e) => setError(e.message));
  }, [userId, friend?.status]);

  if (error)
    return (
      <div className="modal-body">
        <p className="error-text">{error}</p>
      </div>
    );
  if (!profile)
    return (
      <div className="modal-body">
        <p className="sub">Carregando perfil…</p>
      </div>
    );

  const isMe = userId === me?.id;
  const status = friend?.status;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      useStore.getState().notify(e.message);
    }
  };

  return (
    <div className="profile-card">
      <div className="profile-banner" style={{ background: bannerBackground(user.bannerColor || user.avatarColor) }} />
      <div className="profile-head">
        <Avatar user={user} size={80} status={online ? undefined : 'off'} />
        {isMe && (
          <button className="btn secondary" onClick={() => openModal({ type: 'editProfile' })}>
            Editar perfil
          </button>
        )}
      </div>
      <div className="profile-body">
        <h2>
          <UserName user={user} /> {(user.lan || !isServer) && <span className="lan-tag">LAN</span>}
        </h2>
        <div className="profile-username">@{user.username}</div>
        {profile.bio && (
          <section>
            <h4>Sobre mim</h4>
            <p className={colorClass(user.bioColor, 'profile-bio')} style={colorStyle(user.bioColor)}>
              <FormattedText text={profile.bio} />
            </p>
          </section>
        )}
        <section>
          <h4>Membro desde</h4>
          <p>{fmtDate(profile.createdAt)}</p>
        </section>
        {!isMe && profile.mutualGuilds.length > 0 && (
          <section>
            <h4>Servidores em comum — {profile.mutualGuilds.length}</h4>
            <div className="chips">
              {profile.mutualGuilds.map((g) => (
                <span className="chip" key={g}>
                  {g}
                </span>
              ))}
            </div>
          </section>
        )}
        {!isMe && (
          <div className="profile-actions">
            <button className="btn" onClick={run(async () => (await openDm(userId), close()))}>
              <MessageSquare size={16} /> Mensagem
            </button>
            <button className="btn green" onClick={run(async () => (close(), await callUser(userId)))}>
              <Phone size={16} /> Ligar
            </button>
            {isServer && !status && (
              <button className="btn secondary" onClick={run(() => sendFriendRequest(user.username))}>
                <UserPlus size={16} /> Adicionar amigo
              </button>
            )}
            {status === 'incoming' && (
              <button className="btn secondary" onClick={run(() => acceptFriend(userId))}>
                <UserCheck size={16} /> Aceitar pedido
              </button>
            )}
            {status === 'outgoing' && (
              <button className="btn secondary" onClick={run(() => removeFriend(userId))}>
                Cancelar pedido
              </button>
            )}
            {status === 'friend' && (
              <button className="btn ghost" title="Desfazer amizade" onClick={run(() => removeFriend(userId))}>
                <UserMinus size={16} />
              </button>
            )}
            <button
              className={`btn ghost${nudgeBlocked ? ' pressed' : ''}`}
              title={nudgeBlocked ? 'Voltar a aceitar chamar atenção desta pessoa' : 'Não aceitar chamar atenção desta pessoa'}
              aria-pressed={nudgeBlocked}
              onClick={() => useC.getState().setNudgeBlocked(userId, !nudgeBlocked)}
            >
              {nudgeBlocked ? <BellOff size={16} /> : <Vibrate size={16} />}
              {nudgeBlocked ? 'Bloqueado' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Recorta no centro e reduz para 256×256 (WebP, ou PNG se o navegador não gerar WebP). */
async function prepareAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close?.();
  const blob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  const webp = await blob('image/webp', 0.9);
  return webp?.type === 'image/webp' ? webp : blob('image/png');
}

/**
 * Campo do perfil (nome e mensagem pessoal) com a mesma barra de formatação da caixa de mensagem:
 * a cor, o negrito etc. ficam como tags no próprio texto. `max` conta só o que aparece na tela.
 */
function ProfileField({ id, label, value, setValue, max, maxRaw, multiline, placeholder, required, hint }) {
  const ref = useRef(null);
  const Input = multiline ? 'textarea' : 'input';
  const set = (next) => {
    if (visibleLength(next) > max) return useStore.getState().notify(`Esse campo aceita até ${max} caracteres`, 'info');
    setValue(next);
  };
  return (
    <div className="field profile-field">
      <label htmlFor={id}>
        <span>{label}</span>
      </label>
      <FormatTools inputRef={ref} text={value} setText={set} maxRaw={maxRaw} label={`Formatação: ${label}`} />
      <Input
        id={id}
        ref={ref}
        rows={multiline ? 3 : undefined}
        value={value}
        onChange={(e) => set(e.target.value)}
        maxLength={maxRaw}
        placeholder={placeholder}
        required={required}
        style={multiline ? { resize: 'none' } : undefined}
      />
      {hint}
    </div>
  );
}

/** A cor antiga do perfil (escolhida à parte) vira tag no próprio texto. */
const withLegacyColor = (text, color) =>
  color && text && !text.includes('[cor=') ? `[cor=${color}]${text}[/cor]` : text;

function EditProfileModal({ close }) {
  const prim = primaryConn();
  const me = prim((s) => s.me);
  const base = prim((s) => s.baseUrl);
  const [name, setName] = useState(() => withLegacyColor(me.displayName, me.nameColor));
  const [bio, setBio] = useState('');
  const [banner, setBanner] = useState(me.bannerColor || null);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const { busy, error, run } = useAction(async () => {
    await prim.getState().updateProfile({ displayName: name, bio, nameColor: '', bioColor: '', bannerColor: banner || '' });
    syncProfileEverywhere();
  }, close);

  useEffect(() => {
    prim
      .getState()
      .fetchProfile(me.id)
      .then((p) => {
        setBio(withLegacyColor(p.bio, p.bioColor ?? me.bioColor));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [me.id]);

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      await prim.getState().uploadAvatar(await prepareAvatar(file));
      syncProfileEverywhere();
    } catch (err) {
      useStore.getState().notify(err.message || 'Não foi possível usar essa imagem');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={run}>
      <div className="modal-body">
        <h2>Meu perfil</h2>
        <p className="sub">Como as outras pessoas veem você.</p>
        <div className="field">
          <span>Cor do banner</span>
          <div className="banner-preview" style={{ background: bannerBackground(banner || me.avatarColor) }} />
          <ColorChoice
            label="Cor do banner"
            value={banner}
            palette={ACCENTS}
            defaultLabel="Da foto"
            onChange={setBanner}
          />
        </div>
        <div className="avatar-edit">
          <button
            type="button"
            className="avatar-edit-pic"
            onClick={() => fileRef.current?.click()}
            title="Trocar foto"
          >
            <Avatar user={me} base={base} size={96} />
            <span className="avatar-edit-overlay">
              <Camera size={22} />
              {uploading ? 'Enviando…' : 'Trocar'}
            </span>
          </button>
          <div className="avatar-edit-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              <Camera size={16} /> Escolher imagem
            </button>
            {me.avatarUrl && (
              <button
                type="button"
                className="btn ghost"
                onClick={async () => {
                  await prim.getState().removeAvatar();
                  syncProfileEverywhere();
                }}
              >
                <Trash2 size={16} /> Remover foto
              </button>
            )}
            <small>PNG, JPEG, WebP ou GIF. A imagem é recortada em quadrado.</small>
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={pick} />
        </div>
        <ProfileField
          id="pf-name"
          label="Nome de exibição"
          value={name}
          setValue={setName}
          max={32}
          maxRaw={128}
          required
          hint={<small>{32 - visibleLength(name)} caracteres restantes</small>}
        />
        <ProfileField
          id="pf-bio"
          label="Sobre mim"
          multiline
          value={bio}
          setValue={setBio}
          max={190}
          maxRaw={600}
          placeholder={loaded ? 'Conte um pouco sobre você' : 'Carregando…'}
          hint={
            <small>
              {190 - visibleLength(bio)} caracteres restantes · @{me.username}
            </small>
          }
        />
        <div className="profile-preview">
          <span className="preview-label">Prévia</span>
          <b>
            <FormattedText text={plain(name).trim() ? name : me.username} size={18} />
          </b>
          {bio && (
            <span className="pm">
              <FormattedText text={bio} />
            </span>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button className="btn" disabled={busy || !loaded}>
          Salvar
        </button>
      </div>
    </form>
  );
}

function NewDmModal({ close }) {
  const allFriends = useStore((s) => s.friends);
  const friends = Object.values(allFriends).filter((f) => f.status === 'friend');
  const online = useStore((s) => s.online);
  const [q, setQ] = useState('');
  const list = friends.filter((f) =>
    `${plain(f.user.displayName)} ${f.user.username}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <>
      <div className="modal-body">
        <h2>Nova conversa</h2>
        <p className="sub">Escolha um amigo. Para falar com alguém de um servidor, clique na foto da pessoa.</p>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar amigos" />
        <div className="pick-list">
          {list.length === 0 && <p className="sub">Nenhum amigo encontrado.</p>}
          {list.map((f) => (
            <button
              key={f.user.id}
              className="pick-row"
              onClick={async () => {
                close();
                await useStore.getState().openDm(f.user.id);
              }}
            >
              <Avatar user={f.user} size={32} online={Boolean(online[f.user.id])} />
              <span>
                <b>
                  <FormattedText text={f.user.displayName} />
                </b>{' '}
                <small>@{f.user.username}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="modal-foot">
        <span />
        <button className="btn ghost" onClick={close}>
          Fechar
        </button>
      </div>
    </>
  );
}

/** Entrar (ou criar conta) no servidor de comunidade, sem mexer no perfil local. */
function ServerLoginModal({ close }) {
  const url = useStore((s) => s.baseUrl);
  const localName = connRegistry.get('local')?.getState().me?.username || '';
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ username: localName, password: '' });
  const { busy, error, run } = useAction(() => serverAuthenticate(mode, form), close);
  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form onSubmit={run}>
      <div className="modal-body">
        <h2>{url.replace(/^https?:\/\//, '')}</h2>
        <p className="sub">
          Amigos e servidores ficam nesta conta. Se o usuário for o mesmo do seu perfil local, nome, foto e mensagem
          pessoal são copiados do perfil local.
        </p>
        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Entrar
          </button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Criar conta
          </button>
        </div>
        <label className="field">
          <span>Usuário</span>
          <input value={form.username} onChange={update('username')} autoComplete="username" required />
        </label>
        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            value={form.password}
            onChange={update('password')}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            autoFocus
          />
        </label>
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="modal-foot">
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            close();
            useStore.getState().goHost();
          }}
        >
          Trocar servidor
        </button>
        <button className="btn" disabled={busy}>
          {mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>
      </div>
    </form>
  );
}

/** Janelas mais largas que o padrão. */
/** Configuração do servidor (só o dono): nome, ícone e os arquivos enviados nos canais. */
/** Ícone do tipo de arquivo para os cards. */
function fileKindIcon(f) {
  if (f.mime.startsWith('video/')) return FileVideo;
  if (f.mime.startsWith('audio/')) return FileAudio;
  if (/zip|rar|7z|tar|gzip/.test(f.mime) || /\.(zip|rar|7z|tar|gz)$/i.test(f.name)) return FileArchive;
  if (f.mime.startsWith('text/') || /pdf|document|sheet|presentation/.test(f.mime)) return FileText;
  return FileIcon;
}

/** Arquivos enviados nos canais, em cards (prévia para imagens). */
function GuildFiles({ guildId }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const st = useStore.getState();
  const load = () =>
    st
      .guildFiles(guildId)
      .then(setFiles)
      .catch((e) => st.notify(e.message));
  useEffect(() => {
    load();
  }, [guildId]);
  const when = (ms) => new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  if (!files) return <p className="kv">Carregando…</p>;
  return (
    <>
      <p className="kv gs-files-sum">
        {files.files.length} {files.files.length === 1 ? 'arquivo' : 'arquivos'} · {fmtSize(files.total)}
        {files.stored != null && files.stored < files.total && ` (ocupam ${fmtSize(files.stored)} comprimidos)`} · até{' '}
        {fmtSize(files.maxFile)} por arquivo
      </p>
      {files.files.length === 0 ? (
        <p className="kv">Nenhum arquivo enviado nos canais ainda.</p>
      ) : (
        <div className="gs-file-grid" aria-label="Arquivos no servidor">
          {files.files.map((f) => {
            const Icon = fileKindIcon(f);
            return (
              <div className="gs-card" key={f.id}>
                <a className="gs-card-thumb" href={st.fileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
                  {f.mime.startsWith('image/') ? (
                    <img src={st.fileUrl(f.id)} alt="" loading="lazy" />
                  ) : (
                    <Icon size={34} strokeWidth={1.5} />
                  )}
                </a>
                <div className="gs-card-body">
                  <a className="gs-card-name" href={st.fileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
                    {f.name}
                  </a>
                  <span className="gs-card-meta">
                    {fmtSize(f.size)} · #{f.channelName || 'canal apagado'}
                  </span>
                  <span className="gs-card-meta">
                    {plain(f.by) || f.byUsername} · {when(f.createdAt)}
                  </span>
                </div>
                <div className="gs-card-actions">
                  <a className="gloss mini" href={st.fileUrl(f.id, true)} download={f.name} title="Baixar" aria-label={`Baixar ${f.name}`}>
                    <Download size={14} />
                  </a>
                  <button
                    className="gloss mini danger-ico"
                    title="Apagar arquivo"
                    aria-label={`Apagar ${f.name}`}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await st.deleteFile(f.id);
                        await load();
                      } catch (e) {
                        st.notify(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

const PERM_OPTIONS = [
  { bit: PERM.ADMIN, label: 'Administrador', hint: 'Tudo, menos excluir o servidor' },
  { bit: PERM.INVITE, label: 'Convidar pessoas', hint: 'Vê e compartilha o convite' },
  { bit: PERM.CHANNELS, label: 'Criar e editar canais', hint: 'Cria, renomeia e exclui canais' },
];

/** Membros e o que cada um pode fazer. */
function GuildMembers({ guildId, perms: mine }) {
  const members = useStore((s) => s.guildData[guildId]?.members) || [];
  const memberPerms = useStore((s) => s.guildData[guildId]?.perms) || {};
  const ownerId = useStore((s) => s.guilds.find((g) => g.id === guildId)?.ownerId);
  const [busy, setBusy] = useState(null);
  const sorted = [...members].sort((a, b) => (a.id === ownerId ? -1 : b.id === ownerId ? 1 : 0));
  const toggle = async (m, bit, on) => {
    const cur = memberPerms[m.id] || 0;
    setBusy(m.id);
    try {
      await useStore.getState().setMemberPerms(guildId, m.id, on ? cur | bit : cur & ~bit);
    } catch (e) {
      useStore.getState().notify(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="gs-members" role="table" aria-label="Permissões dos membros">
      <div className="gs-member gs-member-head" role="row">
        <span>Membro</span>
        {PERM_OPTIONS.map((o) => (
          <span key={o.bit} title={o.hint}>
            {o.label}
          </span>
        ))}
      </div>
      {sorted.map((m) => {
        const owner = m.id === ownerId;
        const bits = owner ? 7 : memberPerms[m.id] || 0;
        const isAdmin = (bits & PERM.ADMIN) !== 0;
        // Só o dono mexe em admins (e em quem é admin).
        const locked = owner || (isAdmin && !mine.owner);
        return (
          <div className="gs-member" role="row" key={m.id}>
            <span className="gs-member-who">
              <Avatar user={m} size={28} frame={false} />
              <UserName user={m} className="gs-member-name" />
              {owner && <Crown size={13} className="crown" aria-label="Dono" />}
              {!owner && isAdmin && <Shield size={13} className="crown admin-badge" aria-label="Administrador" />}
            </span>
            {PERM_OPTIONS.map((o) => {
              const implied = o.bit !== PERM.ADMIN && isAdmin;
              const disabled = busy === m.id || locked || implied || (o.bit === PERM.ADMIN && !mine.owner);
              return (
                <label key={o.bit} className="gs-perm" title={owner ? 'O dono tem todas as permissões' : o.hint}>
                  <input
                    type="checkbox"
                    aria-label={`${o.label}: ${plain(m.displayName) || m.username}`}
                    checked={(bits & o.bit) !== 0 || implied}
                    disabled={disabled}
                    onChange={(e) => toggle(m, o.bit, e.target.checked)}
                  />
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function GuildSettingsModal({ guildId, close }) {
  const guild = useStore((s) => s.guilds.find((g) => g.id === guildId));
  const base = useStore((s) => s.baseUrl);
  const perms = usePerms(useStore, guildId);
  const [tab, setTab] = useState('geral');
  const [name, setName] = useState(guild?.name || '');
  const [busy, setBusy] = useState(false);
  const iconInput = useRef(null);
  const st = useStore.getState();
  if (!guild) return null;
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const pickIcon = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) run(async () => st.uploadGuildIcon(guildId, await prepareAvatar(file)));
  };
  const tabs = [
    ['geral', 'Geral'],
    ...(perms.admin
      ? [
          ['membros', 'Membros e permissões'],
          ['arquivos', 'Arquivos'],
        ]
      : []),
  ];
  const myPerms = PERM_OPTIONS.filter((o) => (o.bit === PERM.ADMIN ? perms.admin : o.bit === PERM.INVITE ? perms.invite : perms.channels));
  return (
    <>
      <div className="modal-body guild-settings">
        <h2>Configurações do servidor</h2>
        {tabs.length > 1 && (
          <div className="gs-tabs" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'on' : ''}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {tab === 'geral' && (
          <>
            {perms.admin ? (
              <div className="gs-top">
                <div className="gs-icon">
                  <span className={`gel guild guild-icon big${guild.iconUrl ? ' has-img' : ''}`} style={{ '--c': guild.iconColor }}>
                    {guild.iconUrl ? <img src={base + guild.iconUrl} alt="" /> : <span>{guild.name.slice(0, 2).toUpperCase()}</span>}
                  </span>
                  <div className="gs-icon-actions">
                    <button className="btn secondary" disabled={busy} onClick={() => iconInput.current?.click()}>
                      <Camera size={16} /> Escolher ícone
                    </button>
                    {guild.iconUrl && (
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => st.removeGuildIcon(guildId))}>
                        <Trash2 size={16} /> Remover ícone
                      </button>
                    )}
                    <small>PNG, JPEG, WebP ou GIF. A imagem é recortada em quadrado.</small>
                    <input ref={iconInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={pickIcon} />
                  </div>
                </div>
                <form
                  className="field gs-name"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => st.updateGuild(guildId, { name }));
                  }}
                >
                  <label htmlFor="gs-name">Nome do servidor</label>
                  <div className="gs-name-row">
                    <input id="gs-name" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} required />
                    <button className="btn" disabled={busy || !name.trim() || name.trim() === guild.name}>
                      Salvar
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="gs-mine">
                <p className="kv">
                  {myPerms.length
                    ? `Você pode: ${myPerms.map((o) => o.label.toLowerCase()).join(', ')}.`
                    : 'Você é membro deste servidor. Os administradores podem te dar permissões para convidar pessoas ou criar canais.'}
                </p>
              </div>
            )}
            <div className="settings-sec">{perms.owner ? 'Excluir servidor' : 'Sair do servidor'}</div>
            <div className="gs-danger">
              <p className="kv">
                {perms.owner
                  ? 'Todos os canais, mensagens e arquivos serão apagados para sempre.'
                  : 'Você precisará de um novo convite para voltar.'}
              </p>
              <button
                className="btn red"
                onClick={() =>
                  st.openModal({
                    type: 'confirm',
                    title: perms.owner ? `Excluir "${guild.name}"?` : `Sair de "${guild.name}"?`,
                    text: perms.owner
                      ? 'Todos os canais e mensagens serão apagados para sempre.'
                      : 'Você precisará de um novo convite para voltar.',
                    action: () => (perms.owner ? st.deleteGuild(guild.id) : st.leaveGuild(guild.id)),
                  })
                }
              >
                {perms.owner ? <Trash2 size={16} /> : <LogOut size={16} />}
                {perms.owner ? 'Excluir servidor' : 'Sair do servidor'}
              </button>
            </div>
          </>
        )}
        {tab === 'membros' && perms.admin && <GuildMembers guildId={guildId} perms={perms} />}
        {tab === 'arquivos' && perms.admin && <GuildFiles guildId={guildId} />}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={close}>
          Pronto
        </button>
      </div>
    </>
  );
}

const SIZES = { diagnostics: 'wide', settings: 'settings', guildSettings: 'wide' };

const MODALS = {
  serverLogin: ServerLoginModal,
  profile: ProfileModal,
  editProfile: EditProfileModal,
  newDm: NewDmModal,
  diagnostics: DiagnosticsModal,
  guild: GuildModal,
  channel: ChannelModal,
  invite: InviteModal,
  confirm: ConfirmModal,
  settings: SettingsModal,
  guildSettings: GuildSettingsModal,
};

export default function Modals() {
  const modal = useStore((s) => s.modal);
  const close = useStore((s) => s.closeModal);
  if (!modal) return null;
  const Component = MODALS[modal.type];
  return (
    <Modal
      onClose={close}
      size={SIZES[modal.type]}
      title={modal.type === 'channel' && modal.channelId ? 'Editar canal' : TITLES[modal.type]}
    >
      <Component key={modal.userId || modal.type} {...modal} close={close} />
    </Modal>
  );
}
