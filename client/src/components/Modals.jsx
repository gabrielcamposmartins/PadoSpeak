import { useEffect, useId, useRef, useState } from 'react';
import {
  Hash,
  TriangleAlert,
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
  Ban,
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
  Mic,
  Timer,
  Pin,
  Check,
  Settings2,
  Users,
  Bell,
  FolderOpen,
  MonitorUp,
  Palette,
  SlidersHorizontal,
  Type,
  RotateCcw,
  ScrollText,
  ImagePlus,
  ArrowRightLeft,
  ListPlus,
  SkipForward,
  SkipBack,
  Pause,
  ListX,
  MicOff,
  PhoneOff,
  Monitor,
  Smartphone,
  Share,
  SquarePlus,
  CircleCheck,
  Gamepad2,
  EyeOff,
  Plus,
  Music2,
  KeyRound,
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
  serverEnterWithToken,
  usePerms,
  PERM,
  DEFAULT_NOTIFY,
  setMyActivity,
  FONT_SCALES,
  fontScaleOf,
} from '../store.js';
import { currentActivity, listPrograms, setCustomPrograms } from '../lib/activity.js';
import { setGameOverlay, setOverlayBlocked } from '../lib/gameOverlay.js';
import { SoundsModal, UserSoundsModal, SoundSettings } from './SoundLibrary.jsx';
import { GoogleButton, useAuthOptions, AccountSettings } from './AccountAuth.jsx';
import VolumeSlider from './Volume.jsx';
import { isDesktop, isTauri, DOWNLOAD_URL, DEFAULT_SERVER, openExternal } from '../lib/env.js';
import { usePwa, installState, install, pushStatus, enablePush, disablePush } from '../lib/pwa.js';
import { ConnProvider, useConn } from './conn.jsx';
import Avatar, { useUser, UserName, colorClass, colorStyle, Orb } from './Avatar.jsx';
import LatencyChart from './LatencyChart.jsx';
import { TitleBar } from './Aero.jsx';
import { FormattedText, Floating, TEXT_COLORS } from './Emotes.jsx';
import FormatTools, { formatKey, usePalette, DEFAULT_PALETTE, SHORTCUTS, MOD } from './FormatTools.jsx';
import { fmtSize, fmtLeft, useNow, DownloadLink, ttlWords } from './Files.jsx';
import { plain, visibleLength } from '../lib/text.js';
import changelogMd from '../changelog.md?raw';
import { useLoginLock, LoginLock } from './LoginLock.jsx';
import {
  HOTKEY_ACTIONS,
  DEFAULT_HOTKEYS,
  hotkeysOf,
  formatHotkey,
  hotkeyFromEvent,
  sameHotkey,
  pauseGlobalHotkeys,
  refreshHotkeys,
  hotkeyProblems,
  onHotkeyProblems,
  soloRecorder,
} from '../lib/hotkeys.js';
import { isTouch as touchDevice, currentLayout } from '../lib/layout.js';

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
  changelog: 'Notas de atualização',
  share: 'Compartilhar',
  sounds: 'Sons rápidos',
  userSounds: 'Sons',
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
    if (!editing) return st.createChannel(guildId, name, type, perms.admin && isPrivate ? [...allowed] : null);
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
        {perms.admin && (
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

/** `confirmLabel`/`tone`: texto e cor do botão (vermelho por padrão, para excluir e sair). */
function ConfirmModal({ close, title, text, action, confirmLabel = 'Confirmar', tone = 'red' }) {
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
        <button className={`btn ${tone}`} onClick={run} disabled={busy} autoFocus>
          {confirmLabel}
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
/** Temas: id, nome e a explicação curta embaixo. */
const THEMES = [
  ['light', 'Claro', 'Aero (padrão)'],
  ['dark', 'Escuro', 'Aero noturno'],
  ['system', 'Sistema', 'Igual ao aparelho'],
];

const SCENES = [
  ['Céu', 'Céu de dia · Noite no tema escuro'],
  ['Aquário', 'Aquário · Abismo no tema escuro'],
  ['Aurora', 'Aurora (nos dois temas)'],
  ['Sistema', 'Céu na cor do sistema'],
  ['Sakura', 'Galho de cerejeira florida'],
  ['Ameixeira', 'Galho de ameixeira florida'],
  ['Folhas verdes', 'Galho com folhas verdes'],
];

const SETTINGS_TABS = [
  ['aparencia', 'Aparência', Palette],
  ['funcionalidade', 'Funcionalidade', SlidersHorizontal],
  ['notificacoes', 'Notificações', Bell],
  ['formatacao', 'Formatação de texto', Type],
  ['sons', 'Sons', Music2],
  ['apps', 'Apps', Download],
  ['conta', 'Conta', KeyRound],
];

/**
 * Configurações → Conta: "Esconder meu perfil de". Quem está na lista vê a inicial do nome no lugar da foto,
 * o nome e o status, sem a mensagem pessoal e o banner; o resto (conversas, chamadas, servidores) continua.
 * Fica no servidor de comunidade (é lá que estão os servidores e as pessoas).
 */
function HiddenProfile() {
  const me = useStore((s) => s.me);
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!me) return;
    useStore.getState().listHidden().then(setList, (e) => setError(e.message));
  }, [me?.id]);
  if (!me) return null;
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      setList(await fn());
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (e) => {
    e.preventDefault();
    if (name.trim() && (await run(() => useStore.getState().hideProfileFrom(name.trim())))) setName('');
  };
  return (
    <>
      <div className="settings-sec">Esconder meu perfil de</div>
      <p className="kv">
        Quem estiver aqui vê a inicial do seu nome no lugar da sua foto, seu nome e seu status, mas não a foto, a mensagem pessoal nem o
        banner. Todo o resto continua igual (conversas, chamadas e servidores). Ex.: o servidor do trabalho.
      </p>
      <form className="hidden-add" onSubmit={add}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="@usuario da pessoa"
          aria-label="Usuário da pessoa"
          autoComplete="off"
        />
        <button className="btn" disabled={busy || !name.trim()}>
          Esconder
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      <div className="block-list">
        {list?.length ? (
          list.map((u) => (
            <div className="block-row" key={u.id}>
              <Avatar user={u} size={22} frame={false} />
              <span className="nm">
                <FormattedText text={u.displayName} /> <small>@{u.username}</small>
              </span>
              <button type="button" className="btn ghost mini-btn" disabled={busy} onClick={() => run(() => useStore.getState().unhideProfileFrom(u.id))}>
                Mostrar
              </button>
            </div>
          ))
        ) : list ? (
          <p className="kv">Ninguém na lista: todos veem seu perfil completo.</p>
        ) : null}
      </div>
    </>
  );
}

const OVERLAY_CORNERS = [
  ['tl', 'Canto superior esquerdo'],
  ['tr', 'Canto superior direito'],
  ['bl', 'Canto inferior esquerdo'],
  ['br', 'Canto inferior direito'],
];

/** Onde a sobreposição fica na tela do jogo: clique num dos cantos da telinha. */
function OverlayCornerPicker({ value, onChange }) {
  const label = OVERLAY_CORNERS.find(([id]) => id === value)?.[1];
  return (
    <div className="ovp">
      <div className="ovp-screen" role="radiogroup" aria-label="Posição da sobreposição na tela do jogo">
        {OVERLAY_CORNERS.map(([id, name]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value === id}
            className={`ovp-spot ovp-${id}${value === id ? ' on' : ''}`}
            title={name}
            aria-label={name}
            onClick={() => onChange(id)}
          >
            {value === id ? (
              <span className="ovp-mini" aria-hidden="true">
                <i className="ovp-song" />
                <i className="ovp-who" />
                <i className="ovp-who talk" />
                <i className="ovp-who" />
              </span>
            ) : (
              <span className="ovp-dot" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
      <small className="check-hint">
        <b>{label}</b> · clique num canto da tela para mudar.
      </small>
    </div>
  );
}

/**
 * Jogos sem sobreposição: vale na hora. Pelo nome que aparece no status, então entram tanto os jogos
 * reconhecidos sozinhos quanto os programas adicionados para o status.
 */
/** As duas listas de jogos: sem sobreposição e fora da atividade. */
const GAME_LISTS = {
  overlay: {
    pref: 'overlayBlocked',
    title: 'Não mostrar a sobreposição em',
    field: 'Jogo sem sobreposição',
    remove: (n) => `Mostrar a sobreposição em ${n} de novo`,
    pick: (n) => `Não mostrar a sobreposição em ${n}`,
    apply: (next) => setOverlayBlocked(next),
  },
  activity: {
    pref: 'activityBlocked',
    title: 'Não mostrar na atividade',
    field: 'Jogo fora da atividade',
    remove: (n) => `Mostrar ${n} na atividade de novo`,
    pick: (n) => `Não mostrar ${n} na atividade`,
    // O jogo aberto agora pode ter entrado (ou saído) da lista: o status muda na hora.
    apply: () => setMyActivity(currentActivity()),
  },
};
/** Quantos jogos sugeridos aparecem como botões (o campo sugere todos). */
const GAME_IDEAS_MAX = 12;

function GameBlocklist({ kind }) {
  const cfg = GAME_LISTS[kind];
  const list = useStore((s) => s.prefs[cfg.pref]) || [];
  const custom = useStore((s) => s.prefs.customGames) || [];
  const seen = useStore((s) => s.prefs.seenGames) || [];
  const [name, setName] = useState('');
  const listId = useId();
  const has = (n) => list.some((x) => x.toLowerCase() === n.trim().toLowerCase());
  const save = (next) => {
    useStore.getState().setAppearance({ [cfg.pref]: next });
    cfg.apply(next);
  };
  const add = (n) => {
    const nm = n.trim().slice(0, 80);
    if (!nm || has(nm)) return;
    save([...list, nm].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })));
    setName('');
  };
  // Sugestões: o jogo aberto agora, os jogos já detectados (mais recentes primeiro) e os programas do status.
  const now = currentActivity()?.name;
  const ideas = [...new Set([now, ...seen, ...custom.map((c) => c.name)].filter(Boolean))].filter((n) => !has(n));
  return (
    <div className="block-list overlay-block">
      <div className="block-title">
        {cfg.title}
        {list.length ? ` (${list.length})` : ''}
      </div>
      {list.map((n) => (
        <div className="block-row" key={n}>
          <EyeOff size={15} aria-hidden="true" />
          <span className="nm">{n}</span>
          <button type="button" className="gloss mini" title="Tirar da lista" aria-label={cfg.remove(n)} onClick={() => save(list.filter((x) => x !== n))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <form
        className="overlay-block-add"
        onSubmit={(e) => {
          e.preventDefault();
          add(name);
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          list={listId}
          placeholder="Nome do jogo, como aparece no status"
          aria-label={cfg.field}
        />
        <datalist id={listId}>
          {ideas.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button type="submit" className="btn" disabled={!name.trim() || has(name)}>
          <Plus size={14} /> Adicionar
        </button>
      </form>
      {ideas.length > 0 && (
        <div className="overlay-block-ideas">
          {ideas.slice(0, GAME_IDEAS_MAX).map((n) => (
            <button key={n} type="button" className="chip" onClick={() => add(n)} title={cfg.pick(n)}>
              <Plus size={12} aria-hidden="true" /> {n}
              {n === now && <small> · aberto agora</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Configurações → Conta: quem eu bloqueei (desbloquear daqui). */
function BlockedUsers() {
  const prim = primaryConn();
  const list = prim((s) => s.nudgeSettings?.blocks);
  if (!list) return null;
  return (
    <>
      <div className="settings-sec">Pessoas bloqueadas</div>
      <p className="kv">Quem está aqui não é seu amigo e vocês não podem mandar pedido de amizade um ao outro.</p>
      <div className="block-list">
        {list.length ? (
          list.map((u) => (
            <div className="block-row" key={u.id}>
              <Avatar user={u} size={22} frame={false} />
              <span className="nm">
                <FormattedText text={u.displayName} /> <small>@{u.username}</small>
              </span>
              <button type="button" className="btn ghost mini-btn" onClick={() => prim.getState().setBlocked(u.id, false)}>
                Desbloquear
              </button>
            </div>
          ))
        ) : (
          <p className="kv">Ninguém bloqueado. Para bloquear alguém, use o botão direito na pessoa ou o perfil dela.</p>
        )}
      </div>
    </>
  );
}

/** Notificações com o PadoSpeak fechado (app instalado / navegador com push). */
function PushToggle() {
  usePwa();
  const status = pushStatus();
  const [busy, setBusy] = useState(false);
  if (status === 'unsupported') return null;
  const toggle = async (on) => {
    setBusy(true);
    try {
      if (on) await enablePush(primaryConn());
      else await disablePush(primaryConn());
    } catch (e) {
      useStore.getState().notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="settings-sec">Neste aparelho</div>
      <label className="checkbox">
        <input type="checkbox" checked={status === 'on'} disabled={busy || status === 'denied'} onChange={(e) => toggle(e.target.checked)} />
        <span>
          Receber notificações com o PadoSpeak fechado
          <small className="check-hint">
            {status === 'denied'
              ? 'Bloqueadas no aparelho: libere as notificações do PadoSpeak nas configurações do sistema.'
              : 'Mensagens, chamadas e “chamar atenção” aparecem como notificação do aparelho.'}
          </small>
        </span>
      </label>
    </>
  );
}

const NOTIFY_LEVEL = { all: 'Todas as mensagens', mentions: 'Só menções', none: 'Nenhuma mensagem' };

/** Atalhos para as notificações de cada servidor (ficam nas configurações do servidor). */
function GuildNotifyLinks() {
  const guilds = useStore((s) => s.guilds);
  const notify = useStore((s) => s.guildNotify);
  if (!guilds.length) return null;
  return (
    <>
      <div className="settings-sec">Servidores</div>
      <p className="kv">Mensagens, menções, entradas na voz e transmissões: cada servidor tem as suas.</p>
      <div className="block-list">
        {guilds.map((g) => (
          <div className="block-row" key={g.id}>
            <span className="nm">
              <FormattedText text={g.name} />{' '}
              <small>{NOTIFY_LEVEL[{ ...DEFAULT_NOTIFY, ...notify[g.id] }.messages] || ''}</small>
            </span>
            <button
              type="button"
              className="gloss mini"
              title="Notificações do servidor"
              aria-label={`Notificações de ${plain(g.name)}`}
              onClick={() => useStore.getState().openModal({ type: 'guildSettings', guildId: g.id, tab: 'notificacoes' })}
            >
              <Bell size={13} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/** Instalar o PadoSpeak: o app para Windows e o app instalável (PWA), em qualquer aparelho. */
function AppsTab() {
  usePwa();
  const serverUrl = primaryConn()((s) => s.baseUrl);
  const [help, setHelp] = useState(null);
  const state = installState();
  // No app desktop, o app instalável vem do servidor de comunidade aberto no navegador.
  const webUrl = /^https:\/\//.test(serverUrl || '') ? serverUrl : DEFAULT_SERVER;
  const download = (e) => {
    if (!isTauri) return;
    e.preventDefault();
    openExternal(DOWNLOAD_URL).catch((err) => useStore.getState().notify(String(err?.message || err)));
  };
  const installPwa = async () => {
    if (state.mode === 'prompt') return install();
    if (state.mode === 'desktop') {
      await openExternal(webUrl).catch((err) => useStore.getState().notify(String(err?.message || err)));
      return setHelp('desktop');
    }
    setHelp(state.mode === 'manual' ? state.browser : state.mode);
  };
  const helpText = {
    desktop: (
      <>
        Abrimos o PadoSpeak no seu navegador (<b>{webUrl.replace(/^https:\/\//, '')}</b>). Lá, clique no ícone de instalar na
        barra de endereço, ou no menu do navegador → “Instalar PadoSpeak”. No celular, abra o mesmo endereço.
      </>
    ),
    ios: (
      <>
        No Safari, toque em <Share size={14} aria-label="Compartilhar" /> Compartilhar (embaixo) e depois em{' '}
        <SquarePlus size={14} aria-hidden="true" /> “Adicionar à Tela de Início”.
      </>
    ),
    ipad: (
      <>
        No Safari, toque em <Share size={14} aria-label="Compartilhar" /> Compartilhar (no alto, à direita) e depois em{' '}
        <SquarePlus size={14} aria-hidden="true" /> “Adicionar à Tela de Início”.
      </>
    ),
    android: <>No menu ⋮ do navegador, toque em “Instalar app” ou “Adicionar à tela inicial”.</>,
    safari: <>No Safari, abra o menu Arquivo → “Adicionar ao Dock”.</>,
    firefox: <>O Firefox não instala apps de sites. Abra este endereço no Chrome ou no Edge e use o ícone de instalar na barra de endereço.</>,
    chromium: (
      <>
        Clique no ícone de instalar na barra de endereço, ou no menu ⋮ do navegador → “Instalar PadoSpeak”. Se a opção não aparecer, o
        app já pode estar instalado neste computador.
      </>
    ),
  }[help];
  const installed = state.mode === 'installed';
  return (
    <>
      <div className="settings-sec">PadoSpeak para Windows</div>
      <div className="app-offer">
        <Monitor size={30} className="ico-blue" aria-hidden="true" />
        <div className="install-text">
          <b>App para Windows</b>
          <span>Fica na bandeja perto do relógio, avisa com as notificações do Windows e pode iniciar junto com o computador.</span>
        </div>
        <a className="btn" href={DOWNLOAD_URL} onClick={download}>
          <Download size={15} /> Baixar para Windows
        </a>
      </div>
      <div className="settings-sec">App instalável (celular, tablet e computador)</div>
      <div className="app-offer">
        <Smartphone size={30} className="ico-green" aria-hidden="true" />
        <div className="install-text">
          <b>Instalar o PadoSpeak</b>
          <span>Abre direto da tela inicial ou da área de trabalho, em tela cheia, e recebe notificações.</span>
        </div>
        <button type="button" className="go" onClick={installPwa} disabled={installed}>
          {installed ? <CircleCheck size={15} /> : <Download size={15} />} {installed ? 'Já instalado' : 'Instalar app'}
        </button>
      </div>
      {installed && <p className="kv">Você está usando o PadoSpeak instalado neste aparelho.</p>}
      {helpText && (
        <p className="kv app-help" role="status">
          {helpText}
        </p>
      )}
    </>
  );
}

/** Tamanho da fonte, cores da paleta pessoal (Ctrl+1…8) e a lista de atalhos. */
function TextFormatting() {
  const palette = usePalette();
  const set = (i, hex) => {
    const next = [...palette];
    next[i] = hex;
    useStore.getState().setAppearance({ textPalette: next });
  };
  const isDefault = palette.every((c, i) => c.toLowerCase() === DEFAULT_PALETTE[i].toLowerCase());
  const fontScale = useStore((s) => fontScaleOf(s.prefs));
  return (
    <>
      <div className="settings-sec">Tamanho da fonte</div>
      <div className="field">
        <div className="font-pick" role="radiogroup" aria-label="Tamanho da fonte">
          {FONT_SCALES.map(([value, name]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={fontScale === value}
              className={`font-opt${fontScale === value ? ' on' : ''}`}
              onClick={() => useStore.getState().setAppearance({ fontScale: value })}
            >
              <span className="font-opt-aa" style={{ '--fo': value }} aria-hidden="true">
                Aa
              </span>
              {name}
            </button>
          ))}
        </div>
        <small>
          As letras de todo o app, neste aparelho.
          {currentLayout() === 'phone' ? ' No celular elas já ficam um pouco maiores que no computador.' : ''}
        </small>
      </div>
      <div className="settings-sec">Sua paleta</div>
      <p className="kv">
        Pinte o texto com {MOD}+1 a {MOD}+8. Sem nada selecionado, a cor pinta a mensagem toda (repetir a mesma cor tira).
      </p>
      <div className="palette-edit">
        {palette.map((hex, i) => (
          <label key={i} className="palette-slot" title={`Cor ${i + 1}`}>
            <span className="color-well" style={{ '--sw': hex }}>
              <input type="color" value={hex} aria-label={`Cor ${i + 1} (${MOD}+${i + 1})`} onChange={(e) => set(i, e.target.value)} />
            </span>
            <span className="palette-key">
              {MOD}+{i + 1}
            </span>
            <span className="tc palette-sample" style={{ '--tc': hex }}>
              Exemplo de texto
            </span>
          </label>
        ))}
      </div>
      <button type="button" className="btn ghost" disabled={isDefault} onClick={() => useStore.getState().setAppearance({ textPalette: null })}>
        <RotateCcw size={15} /> Voltar às cores padrão
      </button>
      <div className="settings-sec">Atalhos</div>
      <table className="shortcut-table">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                {keys.split(' … ').map((k, i) => (
                  <span key={k}>
                    {i > 0 && ' … '}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
              <td>{what}</td>
            </tr>
          ))}
          <tr>
            <td>
              <kbd>Enter</kbd> / <kbd>Shift+Enter</kbd>
            </td>
            <td>Enviar / quebrar linha</td>
          </tr>
        </tbody>
      </table>
      <p className="kv">Com um trecho selecionado, o atalho de negrito, itálico etc. formata só ele (e desfaz se já estiver formatado).</p>
    </>
  );
}

/** Um atalho de voz: clique no campo e aperte as teclas (Esc cancela). */
function HotkeyField({ action, label, value, others, onChange }) {
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState('');
  const [, bump] = useState(0);
  useEffect(() => onHotkeyProblems(() => bump((n) => n + 1)), []);
  useEffect(() => {
    if (!recording) return;
    // O atalho global engoliria as teclas: fica desligado enquanto grava.
    pauseGlobalHotkeys();
    const solo = soloRecorder();
    const accept = (hotkey) => {
      const taken = others.find((o) => sameHotkey(o.value, hotkey));
      if (taken) return setMsg(`Esse atalho já é de “${taken.label}”.`);
      setRecording(false);
      setMsg('');
      onChange(hotkey);
    };
    // Ctrl, Alt, Shift ou Win sozinho: vale ao soltar sem ter apertado outra tecla.
    const onUp = (e) => {
      const hotkey = solo.keyup(e);
      if (hotkey) accept(hotkey);
    };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) solo.keydown(e);
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false);
        setMsg('');
        return refreshHotkeys();
      }
      const r = hotkeyFromEvent(e);
      if (r.waiting) return;
      if (r.error) return setMsg(r.error);
      accept(r.hotkey);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [recording, others, onChange]);
  const stop = () => {
    if (!recording) return;
    setRecording(false);
    setMsg('');
    refreshHotkeys();
  };
  const isDefault = sameHotkey(value, DEFAULT_HOTKEYS[action]);
  return (
    <div className="hotkey-field">
      <span className="hotkey-label">{label}</span>
      <div className="hotkey-row">
        <button
          type="button"
          className={`hotkey-input${recording ? ' recording' : ''}${value ? '' : ' empty'}`}
          onClick={() => (recording ? stop() : setRecording(true))}
          onBlur={stop}
          aria-label={`Atalho: ${label}`}
          title={
            recording
              ? 'Aperte as teclas do atalho, ou toque Ctrl, Alt, Shift ou Win sozinho (Esc cancela)'
              : 'Clique para trocar o atalho'
          }
        >
          {recording ? 'Aperte as teclas…' : formatHotkey(value)}
        </button>
        {value && (
          <button type="button" className="btn ghost mini" onClick={() => onChange(null)} title="Sem atalho" aria-label={`Tirar o atalho: ${label}`}>
            <X size={14} />
          </button>
        )}
        {!isDefault && (
          <button type="button" className="btn ghost hotkey-reset" onClick={() => onChange(DEFAULT_HOTKEYS[action])} title={`Voltar ao padrão (${formatHotkey(DEFAULT_HOTKEYS[action])})`}>
            Padrão
          </button>
        )}
      </div>
      {msg && <small className="hotkey-msg">{msg}</small>}
      {!msg && hotkeyProblems.has(action) && (
        <small className="hotkey-msg">
          O Windows não deixou usar esse atalho em segundo plano (outro programa já usa): ele só funciona com o PadoSpeak em foco.
          Escolha outro.
        </small>
      )}
    </div>
  );
}

/** Atalhos de silenciar e ensurdecer. */
function VoiceHotkeys() {
  const prefs = useStore((s) => s.prefs);
  const map = hotkeysOf(prefs);
  const set = (action) => (value) => useStore.getState().setAppearance({ hotkeys: { ...hotkeysOf(useStore.getState().prefs), [action]: value } });
  return (
    <>
      <div className="settings-sec">Atalhos de voz</div>
      {HOTKEY_ACTIONS.map((a) => (
        <HotkeyField
          key={a.id}
          action={a.id}
          label={a.label}
          value={map[a.id]}
          others={HOTKEY_ACTIONS.filter((o) => o.id !== a.id).map((o) => ({ label: o.label, value: map[o.id] }))}
          onChange={set(a.id)}
        />
      ))}
      <p className="kv">
        Pode ser uma combinação (Ctrl + Shift + M) ou só Ctrl, Alt, Shift ou Win: aí vale o toque, apertar e soltar a tecla
        sozinha.
      </p>
      <p className="kv">
        {isTauri
          ? 'Funcionam em qualquer lugar do Windows: com o PadoSpeak minimizado, na bandeja ou atrás de um jogo.'
          : 'Funcionam com o PadoSpeak aberto e em foco (o navegador não deixa usar atalhos com a janela em segundo plano). Para usar em qualquer lugar, use o app para Windows.'}
      </p>
    </>
  );
}

/** Sons rápidos: ouvir os dos outros e o volume (vale na hora). */
function SoundboardPrefs() {
  const off = useStore((s) => Boolean(s.prefs.soundboardOff));
  const volume = useStore((s) => s.prefs.soundboardVolume ?? 0.8);
  const set = (patch) => useStore.getState().setAppearance(patch);
  return (
    <>
      <label className="checkbox">
        <input type="checkbox" checked={!off} onChange={(e) => set({ soundboardOff: !e.target.checked })} />
        <span>
          Ouvir os sons rápidos na chamada
          <small className="check-hint">Os sons que as pessoas tocam pelos botões de sons rápidos.</small>
        </span>
      </label>
      {!off && (
        <label className="field sound-volume">
          <span>Volume dos sons rápidos</span>
          <VolumeSlider label="Volume dos sons rápidos" value={volume} onChange={(v) => set({ soundboardVolume: v })} />
        </label>
      )}
    </>
  );
}

/**
 * Programas que também aparecem no status (“Jogando …”) além dos jogos reconhecidos sozinhos. Vale na hora:
 * a lista fica neste PC e vai para o app do Windows, que olha a janela em foco.
 */
function CustomPrograms() {
  const list = useStore((s) => s.prefs.customGames) || [];
  const [programs, setPrograms] = useState(null);
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const save = (next) => {
    useStore.getState().setAppearance({ customGames: next });
    setCustomPrograms(next);
  };
  const open = () => {
    setPick('');
    setName('');
    listPrograms()
      .then(setPrograms)
      .catch((e) => {
        setPrograms([]);
        useStore.getState().notify(`Não deu para listar os programas: ${e}`);
      });
  };
  const choose = (exe) => {
    setPick(exe);
    if (exe) setName(exe.replace(/\.exe$/i, ''));
  };
  const add = () => {
    const nm = name.trim();
    if (!pick || !nm) return;
    save([...list.filter((c) => c.exe.toLowerCase() !== pick.toLowerCase()), { exe: pick, name: nm }]);
    setPrograms(null);
  };
  return (
    <>
      {list.length > 0 && (
        <div className="block-list">
          <div className="block-title">Adicionados por você ({list.length})</div>
          {list.map((c) => (
            <div className="block-row" key={c.exe}>
              <Gamepad2 size={15} aria-hidden="true" />
              <span className="nm">
                Jogando {c.name} <small>{c.exe}</small>
              </span>
              <button
                type="button"
                className="gloss mini"
                title="Tirar da lista"
                aria-label={`Tirar ${c.name} da lista`}
                onClick={() => save(list.filter((x) => x !== c))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {programs ? (
        <div className="block-list custom-program-add">
          <div className="block-title">Escolha o programa aberto no computador</div>
          <div className="custom-program-list" role="listbox" aria-label="Programas abertos">
            {programs.length ? (
              programs.map((p) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={pick === p.exe}
                  key={p.exe}
                  className={pick === p.exe ? 'on' : ''}
                  title={p.path}
                  onClick={() => choose(p.exe)}
                >
                  <b>{p.title}</b>
                  <small>{p.exe}</small>
                </button>
              ))
            ) : (
              <p className="kv">Nenhum programa com janela aberta. Abra o jogo e clique em Atualizar.</p>
            )}
          </div>
          {pick && (
            <input
              type="text"
              value={name}
              maxLength={80}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="Nome no status"
              aria-label="Nome no status (Jogando …)"
            />
          )}
          <div className="custom-program-actions">
            <button type="button" className="btn" disabled={!pick || !name.trim()} onClick={add}>
              <Plus size={14} /> Adicionar
            </button>
            <button type="button" className="btn ghost" onClick={open} title="Abriu o jogo agora? Atualize a lista">
              <RotateCcw size={14} /> Atualizar
            </button>
            <button type="button" className="btn ghost" onClick={() => setPrograms(null)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <p className="kv custom-program-hint">
          Não está achando seu jogo?{' '}
          <button type="button" className="link-inline" onClick={open}>
            Adicione-o
          </button>
        </p>
      )}
    </>
  );
}

/** `focus: 'devices'`: abre em Funcionalidade, já na parte de microfone, saída e câmera (atalho da chamada). */
function SettingsModal({ close, tab: startTab, focus }) {
  const prim = primaryConn();
  const me = prim((s) => s.me);
  const serverUrl = prim((s) => s.baseUrl);
  const accent = useStore((s) => s.prefs.accent || null);
  const saved = useStore((s) => s.prefs.devices) || {};
  const [tab, setTab] = useState(startTab || (focus === 'devices' ? 'funcionalidade' : 'aparencia'));
  useEffect(() => {
    if (focus !== 'devices') return;
    const t = setTimeout(() => {
      const el = document.getElementById('settings-devices');
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el?.classList.add('flash');
    }, 60);
    return () => clearTimeout(t);
  }, [focus]);
  const [devices, setDevices] = useState([]);
  const [choice, setChoice] = useState({ mic: '', camera: '', output: '', ...saved });
  const [rnnoise, setRnnoise] = useState(useStore.getState().prefs.noiseSuppression !== false);
  const [sounds, setSounds] = useState(useStore.getState().prefs.sounds !== false);
  const [repeatAlerts, setRepeatAlerts] = useState(useStore.getState().prefs.repeatAlerts !== false);
  const [nearbyVisible, setNearbyVisible] = useState(useStore.getState().prefs.nearbyVisible !== false);
  const [shareActivity, setShareActivity] = useState(useStore.getState().prefs.shareActivity !== false);
  const [gameOverlay, setGameOverlayOn] = useState(useStore.getState().prefs.gameOverlay === true);
  const [overlayCorner, setOverlayCorner] = useState(useStore.getState().prefs.gameOverlayCorner || 'tl');
  // App desktop: iniciar com o Windows (com a janela aberta, ou só na bandeja).
  const [autostart, setAutostart] = useState(null);
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartTray, setAutostartTray] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('autostart_get'))
      .then((a) => {
        setAutostart(a);
        setAutostartOn(a.enabled);
        setAutostartTray(Boolean(a.tray));
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
  const sceneOn = useStore((s) => s.prefs.sceneOn !== false);
  const [needsPermission, setNeedsPermission] = useState(false);
  const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const hasServer = useStore((s) => Boolean(s.me));
  const myBackground = prim((s) => s.myBackground);
  const receipts = useStore((s) => s.prefs.receipts) || {};
  const setReceipts = (patch) => useStore.getState().setAppearance({ receipts: { ...receipts, ...patch } });

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

  const appearance = (
    <>
      <div className="settings-sec">Tema e cores</div>
      <div className="field">
        <span id="theme-pick-label">Tema</span>
        <div className="theme-pick" role="radiogroup" aria-labelledby="theme-pick-label">
          {THEMES.map(([id, name, hint]) => (
            <label key={id} className={`theme-opt t-${id}${theme === id ? ' on' : ''}`}>
              <input
                type="radio"
                name="theme"
                value={id}
                className="sr-only"
                checked={theme === id}
                onChange={() => {
                  setTheme(id);
                  useStore.getState().setAppearance({ theme: id });
                }}
              />
              <span className="theme-mini" aria-hidden="true">
                <i className="tm-sky" />
                <i className="tm-row" />
                <i className="tm-row short" />
              </span>
              <span className="theme-name">
                <span className="theme-dot" aria-hidden="true" />
                {name}
              </span>
              <small>{hint}</small>
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Cena do perfil</span>
        <label className="checkbox">
          <input type="checkbox" checked={sceneOn} onChange={(e) => useStore.getState().setAppearance({ sceneOn: e.target.checked })} />
          <span>
            Mostrar a cena no topo
            <small className="check-hint">
              Desligada, a imagem de fundo cobre também o topo, e a sua foto e o seu nome ganham um fundo para continuar fáceis de ler.
            </small>
          </span>
        </label>
        <div className={`scene-pick${sceneOn ? '' : ' off'}`} role="radiogroup" aria-label="Cena do perfil">
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
      <div className="settings-sec">Mensagens</div>
      <div className="field">
        <span>Cor das minhas mensagens</span>
        <ColorChoice
          label="Cor das minhas mensagens"
          value={me.messageColor || null}
          palette={TEXT_COLORS}
          defaultLabel="Padrão"
          onChange={async (hex) => {
            try {
              await prim.getState().updateProfile({ messageColor: hex || '' });
              syncProfileEverywhere();
            } catch (e) {
              useStore.getState().notify(e.message);
            }
          }}
        />
        <small>Todos veem suas mensagens nesta cor. Num servidor, o servidor pode usar a cor dele no lugar.</small>
      </div>
      <div className="settings-sec">Imagem de fundo do Início</div>
      <BackgroundPick
        url={myBackground}
        base={serverUrl}
        label="imagem de fundo do Início"
        onPick={(b) => prim.getState().setMyBackground(b)}
        onRemove={() => prim.getState().setMyBackground(null)}
      />
    </>
  );

  const features = (
    <div className="settings-cols">
      <section className="settings-col">
        <div className="settings-sec" id="settings-devices">
          Voz e áudio
        </div>
        <DeviceSelect {...props} k="mic" kind="audioinput" label="Microfone" />
        <label className="checkbox">
          <input type="checkbox" checked={rnnoise} onChange={(e) => setRnnoise(e.target.checked)} />
          <span>
            Supressão de ruído por IA (RNNoise)
            <small className="check-hint">Remove teclado, ventilador e barulho de fundo do seu microfone.</small>
          </span>
        </label>
        {canPickOutput && <DeviceSelect {...props} k="output" kind="audiooutput" label="Saída de áudio" />}
        <DeviceSelect {...props} k="camera" kind="videoinput" label="Câmera" />
        {needsPermission && (
          <p className="kv">Os nomes dos dispositivos aparecem depois que você permitir o acesso (entre em um canal de voz).</p>
        )}
        {(isTauri || !touchDevice) && <VoiceHotkeys />}
        <div className="settings-sec">Vídeo e transmissões</div>
        <p className="kv">Câmeras e transmissões só chegam quando você clica para ver — assim não gastam sua internet à toa.</p>
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
      </section>
      <section className="settings-col">
        {isTauri && (
          <>
            <div className="settings-sec">Atividade</div>
            <label className="checkbox">
              <input type="checkbox" checked={shareActivity} onChange={(e) => setShareActivity(e.target.checked)} />
              <span>
                Mostrar o jogo que estou jogando
                <small className="check-hint">
                  Aparece “Jogando …” no seu status para amigos e servidores enquanto o jogo estiver aberto (o PadoSpeak
                  reconhece o jogo pela janela em foco).
                </small>
              </span>
            </label>
            {shareActivity && <CustomPrograms />}
            {shareActivity && <GameBlocklist kind="activity" />}
            <label className="checkbox">
              <input type="checkbox" checked={gameOverlay} onChange={(e) => setGameOverlayOn(e.target.checked)} />
              <span>
                Sobreposição nos jogos
                <small className="check-hint">
                  Durante uma chamada, mostra por cima do jogo as fotos de quem está nela (quem fala acende) e a música
                  tocando. Vale para os mesmos jogos da atividade, no modo janela ou janela sem bordas.
                </small>
              </span>
            </label>
            {gameOverlay && <OverlayCornerPicker value={overlayCorner} onChange={setOverlayCorner} />}
            {gameOverlay && <GameBlocklist kind="overlay" />}
          </>
        )}
        <div className="settings-sec">Vistos nas mensagens</div>
        <label className="checkbox">
          <input type="checkbox" checked={receipts.show !== false} onChange={(e) => setReceipts({ show: e.target.checked })} />
          <span>
            Mostrar os vistos nas minhas mensagens
            <small className="check-hint">✓ enviada, ✓✓ recebida e o olho quando alguém visualizou.</small>
          </span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={receipts.sendRead !== false} onChange={(e) => setReceipts({ sendRead: e.target.checked })} />
          <span>
            Avisar quando eu visualizar
            <small className="check-hint">
              Desligado: ninguém vê o olho quando você lê, e você também não vê o dos outros (como no WhatsApp). O ✓✓ de
              recebida continua.
            </small>
          </span>
        </label>
        {hasServer && (
          <>
            <div className="settings-sec">Rede</div>
            <label className="checkbox">
              <input type="checkbox" checked={nearbyVisible} onChange={(e) => setNearbyVisible(e.target.checked)} />
              <span>
                Aparecer para quem está na mesma rede
                <small className="check-hint">
                  Pessoas com o PadoSpeak aberto no mesmo Wi-Fi veem você em “Na sua rede” (e você vê elas), mesmo sem serem
                  amigos.
                </small>
              </span>
            </label>
          </>
        )}
        {autostart?.available && (
          <>
            <div className="settings-sec">Sistema</div>
            <label className="checkbox">
              <input type="checkbox" checked={autostartOn} onChange={(e) => setAutostartOn(e.target.checked)} />
              <span>
                Iniciar o PadoSpeak com o Windows
                <small className="check-hint">Abre a janela do PadoSpeak quando você entra no Windows.</small>
              </span>
            </label>
            {autostartOn && (
              <label className="checkbox sub-check">
                <input type="checkbox" checked={autostartTray} onChange={(e) => setAutostartTray(e.target.checked)} />
                <span>
                  Abrir só na bandeja
                  <small className="check-hint">Sem mostrar a janela: fica perto do relógio, recebendo mensagens e chamadas.</small>
                </span>
              </label>
            )}
          </>
        )}
      </section>
    </div>
  );

  const notifications = (
    <div className="settings-cols">
      <section className="settings-col">
        <PushToggle />
        <p className="kv busy-hint">
          <Orb status="busy" />
          <span>
            Com o status <b>Ocupado</b>, você não recebe notificações nem sons de aviso, só ligações.
          </span>
        </p>
        <div className="settings-sec">Sons</div>
        <label className="checkbox">
          <input type="checkbox" checked={sounds} onChange={(e) => setSounds(e.target.checked)} />
          <span>
            Sons de chamada e de avisos
            <small className="check-hint">Entradas e saídas no canal de voz, transmissões, mensagens diretas e toque de chamada.</small>
          </span>
        </label>
        <div className="settings-sec">Amigos</div>
        <div className="online-notify" role="group" aria-labelledby="online-notify-label">
          <span id="online-notify-label">Notificar meus amigos quando eu ficar online no:</span>
          <span className="online-notify-opts">
            {[
              ['onlineNotifyDesktop', 'Desktop'],
              ['onlineNotifyPhone', 'Smartphone'],
            ].map(([k, label]) => (
              <label className="checkbox" key={k}>
                <input
                  type="checkbox"
                  checked={k === 'onlineNotifyDesktop' ? nudge?.[k] !== false : nudge?.[k] === true}
                  disabled={!nudge}
                  onChange={(e) => {
                    for (const c of connRegistry.values()) if (c.getState().me) c.getState().setOnlineNotify({ [k]: e.target.checked });
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </span>
          <small className="check-hint">Smartphone vale também para tablet. Desktop é o app do Windows e o navegador do computador.</small>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={repeatAlerts} onChange={(e) => setRepeatAlerts(e.target.checked)} />
          <span>
            Receber notificações repetidas
            <small className="check-hint">
              Desligado: se um amigo ficar online várias vezes seguidas (ou alternar entre offline e online), você recebe no
              máximo um aviso dessa pessoa a cada 10 minutos.
            </small>
          </span>
        </label>
        <GuildNotifyLinks />
      </section>
      <section className="settings-col">
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
              A janela treme, pisca laranja na barra de tarefas e toca um som. Cada pessoa pode chamar até 3 vezes por minuto.
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
    </div>
  );

  return (
    <>
      <div className="modal-body settings-body">
        <div className="gs-tabs settings-tabs" role="tablist">
          {SETTINGS_TABS.map(([id, label, Icon]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
        <div className="settings-pane">
          {tab === 'aparencia' && appearance}
          {tab === 'funcionalidade' && features}
          {tab === 'notificacoes' && notifications}
          {tab === 'formatacao' && <TextFormatting />}
          {tab === 'sons' && (
            <section className="settings-col">
              <SoundSettings />
              <div className="settings-sec">Ouvir</div>
              <SoundboardPrefs />
            </section>
          )}
          {tab === 'conta' && (
            <section className="settings-col">
              <AccountSettings />
              <HiddenProfile />
              <BlockedUsers />
            </section>
          )}
          {tab === 'apps' && <AppsTab />}
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
            const st = useStore.getState();
            st.setDevices(choice);
            st.setSounds(sounds);
            st.setRepeatAlerts(repeatAlerts);
            if (shareActivity !== (st.prefs.shareActivity !== false)) {
              st.setAppearance({ shareActivity });
              setMyActivity(currentActivity());
            }
            if (gameOverlay !== (st.prefs.gameOverlay === true) || overlayCorner !== (st.prefs.gameOverlayCorner || 'tl')) {
              st.setAppearance({ gameOverlay, gameOverlayCorner: overlayCorner });
              setGameOverlay(gameOverlay, overlayCorner);
            }
            if (nearbyVisible !== (st.prefs.nearbyVisible !== false)) {
              st.setAppearance({ nearbyVisible });
              st.lanHello();
            }
            if (autostart?.available && (autostartOn !== autostart.enabled || (autostartOn && autostartTray !== Boolean(autostart.tray))))
              import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke('autostart_set', { on: autostartOn, tray: autostartTray }))
                .catch((e) => st.notify(`Iniciar com o Windows: ${e}`));
            st.setWatchPrefs(watch);
            if (rnnoise !== (st.prefs.noiseSuppression !== false)) st.setNoiseSuppression(rnnoise);
            close();
          }}
        >
          Salvar
        </button>
      </div>
    </>
  );
}

// ---------- Notas de atualização ----------

/** Negrito, itálico, `código` e links de uma linha das notas. */
function inlineMd(text, key) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<b key={k}>{m[1]}</b>);
    else if (m[2]) out.push(<i key={k}>{m[2]}</i>);
    else if (m[3]) out.push(<code key={k}>{m[3]}</code>);
    else
      out.push(
        <a key={k} href={m[4]} target="_blank" rel="noreferrer">
          {m[4]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** As notas (`changelog.md`) em versões: `{ version, date, blocks }`. */
export function parseChangelog(md) {
  const versions = [];
  let cur = null;
  let list = null;
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const line = raw.trimEnd();
    const v = /^## ([\d.]+)(?:\s+—\s+(.+))?$/.exec(line);
    if (v) {
      cur = { version: v[1], date: v[2] || '', blocks: [] };
      versions.push(cur);
      list = null;
      continue;
    }
    if (!cur || !line.trim()) {
      list = null;
      continue;
    }
    const h = /^###\s+(.+)$/.exec(line);
    const li = /^(\s*)- (.+)$/.exec(line);
    if (h) {
      cur.blocks.push({ type: 'h', text: h[1] });
      list = null;
    } else if (li) {
      if (li[1].length >= 2 && list?.items.length) list.items[list.items.length - 1].sub.push(li[2]);
      else {
        if (!list) {
          list = { type: 'ul', items: [] };
          cur.blocks.push(list);
        }
        list.items.push({ text: li[2], sub: [] });
      }
    } else {
      cur.blocks.push({ type: 'p', text: line.trim() });
      list = null;
    }
  }
  return versions;
}

export const CHANGELOG = parseChangelog(changelogMd);
export const LATEST_NOTES = CHANGELOG[0]?.version || '';

function ChangelogModal({ close }) {
  const [open, setOpen] = useState(0);
  useEffect(() => {
    if (LATEST_NOTES) useStore.getState().setAppearance({ notesSeen: LATEST_NOTES });
  }, []);
  return (
    <>
      <div className="modal-body changelog">
        <h2>Notas de atualização</h2>
        <p className="sub">O que mudou em cada versão do PadoSpeak.</p>
        <div className="cl-list">
          {CHANGELOG.map((v, i) => (
            <section key={v.version} className={`cl-version${open === i ? ' open' : ''}`}>
              <button type="button" className="cl-head" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
                <b>Versão {v.version}</b>
                {i === 0 && <span className="cl-new">mais recente</span>}
                <small>{v.date}</small>
              </button>
              {open === i && (
                <div className="cl-body">
                  {v.blocks.map((b, j) =>
                    b.type === 'h' ? (
                      <h4 key={j}>{inlineMd(b.text, `${i}-${j}`)}</h4>
                    ) : b.type === 'p' ? (
                      <p key={j}>{inlineMd(b.text, `${i}-${j}`)}</p>
                    ) : (
                      <ul key={j}>
                        {b.items.map((it, k) => (
                          <li key={k}>
                            {inlineMd(it.text, `${i}-${j}-${k}`)}
                            {it.sub.length > 0 && (
                              <ul>
                                {it.sub.map((sub, l) => (
                                  <li key={l}>{inlineMd(sub, `${i}-${j}-${k}-${l}`)}</li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    ),
                  )}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
      <div className="modal-foot">
        <span />
        <button className="btn" onClick={close}>
          Fechar
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

/** "5 min", "1 h 20 min" desde quando começou a jogar. */
function sinceText(t) {
  const min = Math.max(1, Math.round((Date.now() - t) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

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
  const game = useC((s) => (s.online[userId] || userId === s.me?.id ? s.activities?.[userId] : null));
  const nudgeBlocked = useC((s) => Boolean(s.nudgeSettings?.nudgeBlocks.some((u) => u.id === userId)));
  const blocked = useC((s) => Boolean(s.nudgeSettings?.blocks?.some((u) => u.id === userId)));
  // Abre na hora com o que já se sabe (o perfil da última vez, ou o usuário da lista) e completa por trás.
  const [profile, setProfile] = useState(() => useC.getState().cachedProfile(userId));
  const [error, setError] = useState('');
  const known = useC((s) => s.users[userId] || s.friends[userId]?.user || (s.me?.id === userId ? s.me : null));
  const user = useUser(profile?.user || known);
  const { openDm, callUser, sendFriendRequest, acceptFriend, removeFriend } = useC.getState();
  const { openModal } = useStore.getState();

  useEffect(() => {
    let live = true;
    useC
      .getState()
      .fetchProfile(userId)
      .then((p) => live && setProfile(p))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [userId, friend?.status]);

  if (error && !profile)
    return (
      <div className="modal-body">
        <p className="error-text">{error}</p>
      </div>
    );
  if (!user)
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
      </div>
      <div className="profile-body">
        <h2>
          <UserName user={user} /> {(user.lan || !isServer) && <span className="lan-tag">LAN</span>}
        </h2>
        <div className="profile-username">@{user.username}</div>
        {game?.name && (
          <section className="profile-game">
            <h4>Jogando</h4>
            <p>
              <Gamepad2 size={16} aria-hidden="true" /> <b>{game.name}</b>
              {game.since ? <span className="sub"> · há {sinceText(game.since)}</span> : null}
            </p>
          </section>
        )}
        {profile?.bio && (
          <section>
            <h4>Sobre mim</h4>
            <p className={colorClass(user.bioColor, 'profile-bio')} style={colorStyle(user.bioColor)}>
              <FormattedText text={profile.bio} />
            </p>
          </section>
        )}
        <section>
          <h4>Membro desde</h4>
          <p>{profile ? fmtDate(profile.createdAt) : '…'}</p>
        </section>
        {!isMe && profile?.mutualGuilds?.length > 0 && (
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
        {isMe && (
          <div className="profile-actions">
            <button className="btn" onClick={() => openModal({ type: 'editProfile' })}>
              <Palette size={16} /> Personalizar perfil
            </button>
            <button className="btn secondary" onClick={() => openModal({ type: 'settings', tab: 'sons' })}>
              <Music2 size={16} /> Editar sons
            </button>
          </div>
        )}
        {!isMe && (
          <div className="profile-actions">
            <button className="btn" onClick={run(async () => (await openDm(userId), close()))}>
              <MessageSquare size={16} /> Mensagem
            </button>
            <button className="btn green" onClick={run(async () => (close(), await callUser(userId)))}>
              <Phone size={16} /> Ligar
            </button>
            {isServer && !status && !blocked && (
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
              className="btn ghost"
              title="Ver os sons rápidos desta pessoa (e copiar)"
              aria-label="Sons rápidos"
              onClick={() => useStore.getState().openModal({ type: 'userSounds', userId, conn: useC.getState().key })}
            >
              <Music2 size={16} />
            </button>
            <button
              className={`btn ghost${nudgeBlocked ? ' pressed' : ''}`}
              title={nudgeBlocked ? 'Voltar a aceitar chamar atenção desta pessoa' : 'Não aceitar chamar atenção desta pessoa'}
              aria-label={nudgeBlocked ? 'Voltar a aceitar chamar atenção' : 'Não aceitar chamar atenção'}
              aria-pressed={nudgeBlocked}
              onClick={() => useC.getState().setNudgeBlocked(userId, !nudgeBlocked)}
            >
              {nudgeBlocked ? <BellOff size={16} /> : <Vibrate size={16} />}
            </button>
            {isServer && (
              <button
                className={`btn ghost${blocked ? ' pressed' : ' danger-text'}`}
                title={blocked ? 'Bloqueado: clique para desbloquear' : 'Bloquear: desfaz a amizade e impede pedidos de amizade'}
                aria-label={blocked ? 'Desbloquear' : 'Bloquear'}
                aria-pressed={blocked}
                onClick={() =>
                  blocked
                    ? useC.getState().setBlocked(userId, false)
                    : openModal({
                        type: 'confirm',
                        title: `Bloquear ${plain(user.displayName)}?`,
                        text: 'A amizade é desfeita e vocês não podem mais mandar pedido de amizade um ao outro. Dá para desbloquear depois em Configurações → Conta.',
                        action: () => useC.getState().setBlocked(userId, true),
                      })
                }
              >
                <Ban size={16} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Recorta no centro e reduz para 256×256 (WebP, ou PNG se o navegador não gerar WebP). */
/** Foto animada até este tamanho vai como está (o servidor aceita até 2 MB). */
const ANIMATED_MAX = 2 * 1024 * 1024;

/** GIF com mais de um quadro ou WebP animado (desenhar no canvas guardaria só o primeiro quadro). */
async function isAnimated(file) {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const ascii = (from, n) => String.fromCharCode(...head.subarray(from, from + n));
  if (ascii(0, 3) === 'GIF') {
    // cada quadro tem um bloco de controle 21 F9 04; a partir do segundo, é animado
    const all = new Uint8Array(await file.arrayBuffer());
    let frames = 0;
    for (let i = 0; i < all.length - 2; i++) if (all[i] === 0x21 && all[i + 1] === 0xf9 && all[i + 2] === 0x04 && ++frames > 1) return true;
    return false;
  }
  // WebP estendido (VP8X) com o bit de animação
  return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && ascii(12, 4) === 'VP8X' && (head[20] & 0x02) !== 0;
}

/**
 * Foto pronta para enviar: recortada em quadrado de 256 px (WebP). Com `animated`, GIF/WebP animado
 * vai como está (o recorte em quadrado fica por conta da tela), para não parar no primeiro quadro.
 */
async function prepareAvatar(file, { animated = false } = {}) {
  if (animated && (await isAnimated(file))) {
    if (file.size > ANIMATED_MAX) throw new Error('A foto animada deve ter até 2 MB');
    return file;
  }
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
        onKeyDown={(e) => formatKey(e, ref.current, value, set, maxRaw)}
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
  // App desktop sem alcançar o servidor: o perfil de lá é o que vale, então a mudança feita agora fica só
  // neste PC até o servidor voltar (e aí é trocada pelo perfil do servidor).
  const offline = useStore((s) => isDesktop && ['unreachable', 'connecting'].includes(s.serverStatus));
  const [name, setName] = useState(() => withLegacyColor(me.displayName, me.nameColor));
  const cached = prim.getState().cachedProfile(me.id);
  const [bio, setBio] = useState(() => (cached ? withLegacyColor(cached.bio, cached.bioColor ?? me.bioColor) : ''));
  const [banner, setBanner] = useState(me.bannerColor || null);
  const [loaded, setLoaded] = useState(Boolean(cached));
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const { busy, error, run } = useAction(async () => {
    await prim.getState().updateProfile({ displayName: name, bio, nameColor: '', bioColor: '', bannerColor: banner || '' });
    syncProfileEverywhere();
  }, close);

  useEffect(() => {
    // Já veio do cache (que é limpo quando o perfil muda): não sobrescreve o que a pessoa começou a digitar.
    if (loaded) return;
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
      await prim.getState().uploadAvatar(await prepareAvatar(file, { animated: true }));
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
            <small>PNG, JPEG, WebP ou GIF (animado também, até 2 MB). A imagem é recortada em quadrado.</small>
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
        {offline && (
          <p className="sp-warn" role="status">
            <TriangleAlert size={15} />
            Sem conexão com o servidor: o perfil de lá é o que vale. O que você mudar agora fica só neste PC e volta a
            ser o do servidor quando ele conectar.
          </p>
        )}
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

/** Compartilhado pelo celular: escolher a conversa (a prévia de envio abre nela). */
function ShareModal({ close }) {
  const shared = useStore((s) => s.sharePending);
  const dms = useStore((s) => s.dms) || [];
  const guilds = useStore((s) => s.guilds) || [];
  const guildData = useStore((s) => s.guildData);
  const [q, setQ] = useState('');
  // Os canais de cada servidor (no celular eles só carregam quando o servidor é aberto).
  useEffect(() => {
    const st = useStore.getState();
    for (const g of st.guilds || []) if (!st.guildData[g.id]) st.loadGuild(g.id).catch(() => {});
  }, []);
  const match = (t) => plain(t || '').toLowerCase().includes(q.trim().toLowerCase());
  const cancel = () => {
    useStore.setState({ sharePending: null });
    close();
  };
  const pick = async (target, open) => {
    useStore.setState((s) => ({ sharePending: s.sharePending && { ...s.sharePending, target } }));
    close();
    await open();
  };
  if (!shared) return null;
  const what = shared.files.length
    ? shared.files.length === 1
      ? shared.files[0].name
      : `${shared.files.length} arquivos`
    : shared.text.slice(0, 80);
  const dmList = dms.filter((d) => match(d.recipient?.displayName) || match(d.recipient?.username) || match(d.name));
  const channels = guilds.flatMap((g) =>
    (guildData[g.id]?.channels || [])
      .filter((c) => c.type === 'text' && (match(c.name) || match(g.name)))
      .map((c) => ({ guild: g, channel: c })),
  );
  return (
    <>
      <div className="modal-body">
        <h2>Compartilhar com…</h2>
        <p className="sub">
          <b>{what}</b> — escolha a conversa. Antes de enviar, dá para ver a prévia e escrever um texto junto.
        </p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar conversa ou canal" aria-label="Buscar conversa ou canal" />
        <div className="pick-list share-list">
          {dmList.length === 0 && channels.length === 0 && <p className="sub">Nenhuma conversa encontrada.</p>}
          {dmList.map((d) => (
            <button key={d.id} className="pick-row" onClick={() => pick(d.id, () => useStore.getState().selectDm(d.id))}>
              <Avatar user={d.recipient} size={32} />
              <span>
                <b>
                  <FormattedText text={d.recipient?.displayName || d.name} />
                </b>{' '}
                <small>@{d.recipient?.username}</small>
              </span>
            </button>
          ))}
          {channels.map(({ guild, channel }) => (
            <button
              key={channel.id}
              className="pick-row"
              onClick={() =>
                pick(channel.id, async () => {
                  await useStore.getState().selectGuild(guild.id);
                  useStore.getState().selectTextChannel(channel.id);
                })
              }
            >
              <span className="share-hash">
                <Hash size={18} />
              </span>
              <span>
                <b>{channel.name}</b> <small>{guild.name}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="modal-foot">
        <span />
        <button className="btn ghost" onClick={cancel}>
          Cancelar
        </button>
      </div>
    </>
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
  const [form, setForm] = useState({ username: localName, password: '', newPassword: '', repeat: '' });
  const options = useAuthOptions(url);
  const [googleError, setGoogleError] = useState('');
  // Muitas tentativas: aviso com contagem regressiva; perto do bloqueio, quantas tentativas restam.
  const lockout = useLoginLock(form.username);
  const locked = mode !== 'register' && lockout.locked;
  const { busy, error, run } = useAction(async () => {
    try {
      await serverLogin();
    } catch (e) {
      const { locked: nowLocked, hint } = lockout.track(e);
      if (nowLocked) throw new Error('');
      throw hint ? new Error(`${e.message.replace(/\.?$/, '.')}${hint}`) : e;
    }
  }, close);
  async function serverLogin() {
    if (mode === 'reset') {
      if (form.newPassword !== form.repeat) throw new Error('As duas senhas não são iguais.');
      return serverAuthenticate('new-password', { username: form.username, password: form.password, newPassword: form.newPassword });
    }
    try {
      await serverAuthenticate(mode, form);
    } catch (e) {
      // Senha redefinida pelo administrador: entrou com o código, agora cria a senha nova.
      if (e.status === 428) {
        setMode('reset');
        throw new Error('Sua senha foi redefinida. Crie uma senha nova para entrar.');
      }
      throw e;
    }
  }
  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form onSubmit={run}>
      <div className="modal-body">
        <h2>{url.replace(/^https?:\/\//, '')}</h2>
        <p className="sub">
          Amigos e servidores ficam nesta conta. Se o usuário for o mesmo do seu perfil local, o perfil do servidor
          (nome, foto e mensagem pessoal) passa a valer também neste PC. Uma conta nova começa com o perfil deste PC.
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
          <span>{mode === 'register' ? 'Usuário' : 'Usuário ou e-mail'}</span>
          <input value={form.username} onChange={update('username')} autoComplete="username" required />
        </label>
        {mode === 'reset' ? (
          <>
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
              required
              autoFocus
            />
          </label>
        )}
        {locked ? <LoginLock left={lockout.left} /> : (error || googleError) && <p className="error-text">{error || googleError}</p>}
        {mode !== 'reset' && options.google && (
          <GoogleButton
            base={url}
            onDone={async (res) => {
              await serverEnterWithToken(res);
              close();
            }}
            onError={(e) => setGoogleError(e.message)}
          />
        )}
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
        <button className="btn" disabled={busy || locked}>
          {mode === 'login' ? 'Entrar' : mode === 'reset' ? 'Salvar e entrar' : 'Criar conta'}
        </button>
      </div>
    </form>
  );
}

/** Botão minimalista: só o ícone, com o nome numa dica ao passar o mouse (e para leitores de tela). */
export function IconBtn({ icon: Icon, label, tip = 'above', className = '', size = 16, ...rest }) {
  return (
    <button type="button" className={`ico-btn tip-${tip} ${className}`} data-tip={label} aria-label={label} {...rest}>
      <Icon size={size} />
    </button>
  );
}

/** Ícone do tipo de arquivo para os cards. */
function fileKindIcon(f) {
  if (f.kind === 'voice') return Mic;
  if (f.mime.startsWith('video/')) return FileVideo;
  if (f.mime.startsWith('audio/')) return FileAudio;
  if (/zip|rar|7z|tar|gzip/.test(f.mime) || /\.(zip|rar|7z|tar|gz)$/i.test(f.name)) return FileArchive;
  if (f.mime.startsWith('text/') || /pdf|document|sheet|presentation/.test(f.mime)) return FileText;
  return FileIcon;
}

const DAY = 24 * 3600 * 1000;
/** Validades que dá para escolher (null = não expira). */
const TTL_OPTIONS = [
  [null, 'Nunca'],
  [3600 * 1000, '1 hora'],
  [DAY, '1 dia'],
  [7 * DAY, '7 dias'],
  [30 * DAY, '30 dias'],
  [90 * DAY, '90 dias'],
];
const ttlLabel = (ms) => TTL_OPTIONS.find(([v]) => v === ms)?.[1] || (ms ? `${Math.round(ms / DAY)} dias` : 'Nunca');

function TtlSelect({ value, onChange, label, id, options = TTL_OPTIONS, disabled }) {
  const known = options.some(([v]) => v === value);
  return (
    <select id={id} aria-label={label} value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {!known && <option value={String(value ?? '')}>{ttlLabel(value)}</option>}
      {options.map(([v, l]) => (
        <option key={l} value={String(v ?? '')}>
          {l}
        </option>
      ))}
    </select>
  );
}

/** Validade de um arquivo no card: mostra quanto falta e deixa o administrador mudar. */
function FileTtl({ f, onChanged }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const st = useStore.getState();
  if (f.big)
    return (
      <IconBtn
        icon={Timer}
        label={`Arquivo grande: ${f.expiresAt ? `some em ${fmtLeft(f.expiresAt)}` : 'não some sozinho'} (a validade dos grandes é a do painel do administrador do app)`}
        tip="left"
        disabled
        className="mini-ico"
        size={14}
      />
    );
  return (
    <span className="tool-wrap">
      <span ref={btn}>
        <IconBtn icon={Timer} label="Validade" tip="left" className={`mini-ico${open ? ' pressed' : ''}`} size={14} onClick={() => setOpen(!open)} />
      </span>
      {open && (
        <Floating anchorRef={btn} onClose={() => setOpen(false)} align="right" className="ttl-pop" role="dialog" aria-label={`Validade de ${f.name}`}>
          <div className="popover-title">Some daqui a</div>
          {TTL_OPTIONS.map(([v, l]) => (
            <button
              key={l}
              type="button"
              className="ttl-opt"
              onClick={async () => {
                setOpen(false);
                try {
                  await st.setFileTtl(f.id, v);
                  onChanged();
                } catch (e) {
                  st.notify(e.message);
                }
              }}
            >
              {v ? l : 'Não expira'}
            </button>
          ))}
        </Floating>
      )}
    </span>
  );
}

/** Arquivos enviados nos canais, em cards (prévia para imagens), com a validade de cada um. */
function GuildFiles({ guildId }) {
  const guild = useStore((s) => s.guilds.find((g) => g.id === guildId));
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const st = useStore.getState();
  const now = useNow(30000);
  const load = () =>
    st
      .guildFiles(guildId)
      .then(setFiles)
      .catch((e) => st.notify(e.message));
  useEffect(() => {
    load();
  }, [guildId]);
  const when = (ms) => new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const setGuildTtl = (key) => async (ms) => {
    try {
      await st.updateGuild(guildId, { [key]: ms });
    } catch (e) {
      st.notify(e.message);
    }
  };
  return (
    <>
      <div className="gs-ttl">
        <label className="field" htmlFor="gs-file-ttl">
          <span>Arquivos novos somem depois de</span>
          <TtlSelect id="gs-file-ttl" label="Validade dos arquivos novos" value={guild?.fileTtlMs ?? null} onChange={setGuildTtl('fileTtlMs')} />
        </label>
        <label className="field" htmlFor="gs-voice-ttl">
          <span>Mensagens de voz somem depois de</span>
          <TtlSelect id="gs-voice-ttl" label="Validade das mensagens de voz" value={guild?.voiceTtlMs ?? null} onChange={setGuildTtl('voiceTtlMs')} />
        </label>
      </div>
      {!files ? (
        <p className="kv">Carregando…</p>
      ) : (
        <>
          <p className="kv gs-files-sum">
            {files.files.length} {files.files.length === 1 ? 'arquivo' : 'arquivos'} · {fmtSize(files.total)}
            {files.stored != null && files.stored < files.total && ` (ocupam ${fmtSize(files.stored)} comprimidos)`} · até{' '}
            {fmtSize(files.maxFile)} por arquivo
          </p>
          {files.big && (
            <p className="kv gs-big">
              <Timer size={13} /> Acima de {fmtSize(files.maxFile)}, o arquivo é grande:{' '}
              {files.big.ttlMs ? `fica só ${ttlWords(files.big.ttlMs)}` : 'não some sozinho'}, até {files.big.maxCount} de cada vez somando{' '}
              {fmtSize(files.big.maxTotal)} (agora: {files.big.count}, {fmtSize(files.big.total)}).
            </p>
          )}
          {files.files.length === 0 ? (
            <p className="kv">Nenhum arquivo enviado nos canais ainda.</p>
          ) : (
            <div className="gs-file-grid" aria-label="Arquivos no servidor">
              {files.files.map((f) => {
                const Icon = fileKindIcon(f);
                return (
                  <div className={`gs-card${f.big ? ' big' : ''}`} key={f.id}>
                    <a className={`gs-card-thumb${f.nsfw ? ' nsfw' : ''}`} href={st.fileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
                      {f.mime.startsWith('image/') ? (
                        <img src={st.fileUrl(f.id)} alt="" loading="lazy" />
                      ) : (
                        <Icon size={34} strokeWidth={1.5} />
                      )}
                    </a>
                    <div className="gs-card-body">
                      <a className="gs-card-name" href={st.fileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
                        {f.kind === 'voice' ? 'Mensagem de voz' : f.name}
                      </a>
                      <span className="gs-card-meta">
                        {fmtSize(f.size)} · #{f.channelName || 'canal apagado'}
                      </span>
                      <span className="gs-card-meta">
                        {plain(f.by) || f.byUsername} · {when(f.createdAt)}
                      </span>
                      <span className={`gs-card-meta ttl${f.expiresAt ? ' on' : ''}`}>
                        {f.expiresAt ? `some em ${fmtLeft(f.expiresAt, now)}` : 'não expira'}
                      </span>
                    </div>
                    <div className="gs-card-actions">
                      <FileTtl f={f} onChanged={load} />
                      <DownloadLink
                        className="ico-btn mini-ico tip-left"
                        href={st.fileUrl(f.id, true)}
                        name={f.name}
                        size={f.size}
                        iconSize={14}
                        data-tip="Baixar"
                        aria-label={`Baixar ${f.name}`}
                      />
                      <IconBtn
                        icon={Trash2}
                        size={14}
                        tip="left"
                        className="mini-ico danger"
                        label={`Apagar ${f.kind === 'voice' ? 'mensagem de voz' : f.name}`}
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
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

const PERM_OPTIONS = [
  { bit: PERM.ADMIN, flag: 'admin', label: 'Administrador', hint: 'Tudo, menos excluir o servidor', icon: Shield },
  { bit: PERM.INVITE, flag: 'invite', label: 'Convidar pessoas', hint: 'Vê e compartilha o convite', icon: UserPlus },
  { bit: PERM.CHANNELS, flag: 'channels', label: 'Criar e editar canais', hint: 'Cria, renomeia e exclui canais', icon: Hash },
  { bit: PERM.PIN, flag: 'pin', label: 'Fixar mensagens', hint: 'Fixa e desafixa mensagens nos canais de texto', icon: Pin },
  { bit: PERM.MUTE, flag: 'mute', label: 'Silenciar na voz', hint: 'Silencia alguém para todos no canal de voz', icon: MicOff },
  { bit: PERM.DISCONNECT, flag: 'disconnect', label: 'Desconectar da voz', hint: 'Tira alguém do canal de voz', icon: PhoneOff },
  { bit: PERM.MOVE, flag: 'move', label: 'Mover entre canais', hint: 'Move alguém para outro canal de voz', icon: ArrowRightLeft },
  { bit: PERM.MUSIC_ADD, flag: 'musicAdd', label: 'Pôr músicas na fila', hint: 'Adiciona músicas do YouTube e do Spotify', icon: ListPlus },
  { bit: PERM.SOUNDS, flag: 'sounds', label: 'Tocar efeitos sonoros', hint: 'Usa os sons rápidos nos canais de voz', icon: Volume2 },
  { bit: PERM.MUSIC_PAUSE_OTHERS, flag: 'musicPauseOthers', label: 'Pausar música de outros', hint: 'Pausa e retoma a música que outra pessoa pôs', icon: Pause },
  { bit: PERM.MUSIC_SKIP_OTHERS, flag: 'musicSkipOthers', label: 'Pular música de outros', hint: 'Pula a música que outra pessoa pôs', icon: SkipForward },
  { bit: PERM.MUSIC_REMOVE_OTHERS, flag: 'musicRemoveOthers', label: 'Tirar da fila música de outros', hint: 'Remove da fila a música que outra pessoa pôs', icon: ListX },
  { bit: PERM.MUSIC_RESTART_OTHERS, flag: 'musicRestartOthers', label: 'Recomeçar música de outros', hint: 'Volta ao início a música que outra pessoa pôs', icon: RotateCcw },
  { bit: PERM.MUSIC_PREVIOUS, flag: 'musicPrevious', label: 'Voltar para a anterior', hint: 'Toca de novo a música que tocou antes', icon: SkipBack },
  { bit: PERM.MUSIC_CLEAR, flag: 'musicClear', label: 'Limpar a fila', hint: 'Tira todas as músicas da fila de uma vez', icon: Trash2 },
];
const opt = (bit) => PERM_OPTIONS.find((o) => o.bit === bit);
/** As permissões em categorias, para a tela de permissões. */
const PERM_GROUPS = [
  { id: 'geral', title: 'Geral', icon: Settings2, perms: [PERM.ADMIN, PERM.INVITE, PERM.CHANNELS, PERM.PIN].map(opt) },
  { id: 'voz', title: 'Voz', icon: Mic, perms: [PERM.MUTE, PERM.DISCONNECT, PERM.MOVE, PERM.SOUNDS].map(opt) },
  {
    id: 'musica',
    title: 'Música',
    icon: Music2,
    note: 'Pausar, pular, tirar da fila e recomeçar as próprias músicas: todos podem.',
    perms: [
      PERM.MUSIC_ADD,
      PERM.MUSIC_PAUSE_OTHERS,
      PERM.MUSIC_SKIP_OTHERS,
      PERM.MUSIC_REMOVE_OTHERS,
      PERM.MUSIC_RESTART_OTHERS,
      PERM.MUSIC_PREVIOUS,
      PERM.MUSIC_CLEAR,
    ].map(opt),
  },
];
/** Quantas permissões dá para escolher (sem contar "Administrador"). */
const PERM_COUNT = PERM_OPTIONS.length - 1;
const countBits = (bits) => PERM_OPTIONS.filter((o) => o.bit !== PERM.ADMIN && (bits & o.bit) !== 0).length;

/**
 * As permissões em categorias (Geral, Voz, Música), uma caixa de marcar por linha com a explicação embaixo.
 * `admin`: mostra "Administrador" (só na lista personalizada); com ele marcado, as outras ficam marcadas.
 */
function PermGroups({ bits, onToggle, disabled, admin = false, adminLocked = false, who }) {
  const isAdmin = admin && (bits & PERM.ADMIN) !== 0;
  return (
    <div className="perm-groups">
      {PERM_GROUPS.map((g) => (
        <fieldset key={g.id} className="perm-group">
          <legend>
            <g.icon size={14} aria-hidden="true" /> {g.title}
          </legend>
          {g.perms
            .filter((o) => admin || o.bit !== PERM.ADMIN)
            .map((o) => {
              const implied = isAdmin && o.bit !== PERM.ADMIN;
              return (
                <label key={o.bit} className={`perm-row${o.bit === PERM.ADMIN ? ' admin' : ''}`}>
                  <input
                    type="checkbox"
                    checked={(bits & o.bit) !== 0 || implied}
                    disabled={disabled || implied || (o.bit === PERM.ADMIN && adminLocked)}
                    aria-label={`${o.label}: ${who}`}
                    onChange={(e) => onToggle(o.bit, e.target.checked)}
                  />
                  <o.icon size={15} aria-hidden="true" />
                  <span>
                    {o.label}
                    <small>{o.hint}</small>
                  </span>
                </label>
              );
            })}
          {g.note && <p className="perm-note">{g.note}</p>}
        </fieldset>
      ))}
    </div>
  );
}
const ALL_BITS = PERM_OPTIONS.reduce((n, o) => n | o.bit, 0);

/**
 * Permissões: à esquerda "Todos os membros" (o padrão) e as pessoas em ordem alfabética; à direita,
 * as permissões de quem está escolhido. Mudar algo de quem usa o padrão personaliza só para essa
 * pessoa, e "Voltar ao padrão" desfaz.
 */
function GuildMembers({ guildId, perms: mine }) {
  const guild = useStore((s) => s.guilds.find((g) => g.id === guildId));
  const members = useStore((s) => s.guildData[guildId]?.members) || [];
  const custom = useStore((s) => s.guildData[guildId]?.perms) || {};
  const [busy, setBusy] = useState(null);
  const [sel, setSel] = useState('default');
  const [q, setQ] = useState('');
  const st = useStore.getState();
  const ownerId = guild?.ownerId;
  const defaults = guild?.defaultPerms ?? PERM.INVITE;
  const name = (m) => plain(m.displayName) || m.username;
  const byName = (a, b) => name(a).localeCompare(name(b), 'pt-BR', { sensitivity: 'base' });
  const owner = members.find((m) => m.id === ownerId);
  const people = members
    .filter((m) => m.id !== ownerId)
    .filter((m) => `${name(m)} ${m.username}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort(byName);
  const picked = sel === 'default' ? null : members.find((m) => m.id === sel);
  const isCustom = (m) => m.id in custom;
  const summary = (m) => {
    if (m.id === ownerId) return 'Dono · todas';
    if (!isCustom(m)) return 'Padrão';
    const bits = custom[m.id] || 0;
    return bits & PERM.ADMIN ? 'Administrador' : `Personalizado · ${countBits(bits)}/${PERM_COUNT}`;
  };

  const run = async (id, fn) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(null);
    }
  };
  const toggleDefault = (bit, on) =>
    run('default', () => st.updateGuild(guildId, { defaultPerms: on ? defaults | bit : defaults & ~bit }));
  // Quem usa o padrão parte dele; quem já é personalizado parte do que tem.
  const toggle = (m, bit, on) => {
    const bits = isCustom(m) ? custom[m.id] || 0 : defaults;
    return run(m.id, () => st.setMemberPerms(guildId, m.id, on ? bits | bit : bits & ~bit, true));
  };

  const item = (key, avatar, label, sub, extra) => (
    <button
      key={key}
      type="button"
      className={`pm-item${sel === key ? ' on' : ''}`}
      aria-current={sel === key || undefined}
      onClick={() => setSel(key)}
    >
      {avatar}
      <span className="pm-item-name">
        {label}
        <small>{sub}</small>
      </span>
      {extra}
    </button>
  );

  let head;
  let body;
  if (!picked) {
    head = (
      <div className="pm-detail-head">
        <span className="pm-all-ico" aria-hidden="true">
          <Users size={16} />
        </span>
        <span className="pm-item-name">
          <b>Todos os membros</b>
          <small>Quem não tem permissões personalizadas pode:</small>
        </span>
      </div>
    );
    body = <PermGroups bits={defaults} who="todos" disabled={busy === 'default'} onToggle={toggleDefault} />;
  } else if (picked.id === ownerId) {
    head = (
      <div className="pm-detail-head">
        <Avatar user={picked} size={32} frame={false} />
        <span className="pm-item-name">
          <b>
            <UserName user={picked} /> <Crown size={13} className="crown" aria-label="Dono" />
          </b>
          <small>Dono do servidor: tem todas as permissões.</small>
        </span>
      </div>
    );
    body = <PermGroups bits={ALL_BITS} admin who={name(picked)} disabled onToggle={() => {}} />;
  } else {
    const bits = isCustom(picked) ? custom[picked.id] || 0 : defaults;
    const isAdmin = isCustom(picked) && (bits & PERM.ADMIN) !== 0;
    const locked = isAdmin && !mine.owner; // só o dono mexe em admins
    head = (
      <div className="pm-detail-head">
        <Avatar user={picked} size={32} frame={false} />
        <span className="pm-item-name">
          <b>
            <UserName user={picked} />
            {isAdmin && <Shield size={13} className="crown admin-badge" aria-label="Administrador" />}
          </b>
          <small>
            {isCustom(picked)
              ? 'Permissões personalizadas: valem só para esta pessoa.'
              : 'Usa o padrão. Mudar qualquer permissão personaliza só para esta pessoa.'}
          </small>
        </span>
        {isCustom(picked) && (
          <button
            type="button"
            className="gloss small-btn pm-reset"
            disabled={busy === picked.id || locked}
            onClick={() => run(picked.id, () => st.setMemberPerms(guildId, picked.id, 0, false))}
          >
            <RotateCcw size={13} /> Voltar ao padrão
          </button>
        )}
      </div>
    );
    body = (
      <PermGroups
        bits={bits}
        admin
        adminLocked={!mine.owner}
        who={name(picked)}
        disabled={busy === picked.id || locked}
        onToggle={(bit, on) => toggle(picked, bit, on)}
      />
    );
  }

  return (
    <div className="gs-perms pm-split">
      <nav className="pm-list" aria-label="Escolha de quem ver as permissões">
        {item(
          'default',
          <span className="pm-all-ico" aria-hidden="true">
            <Users size={15} />
          </span>,
          <b>Todos os membros</b>,
          'Padrão do servidor',
        )}
        <input className="pm-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar membro" aria-label="Buscar membro" />
        {owner &&
          !q.trim() &&
          item(owner.id, <Avatar user={owner} size={24} frame={false} />, <UserName user={owner} />, summary(owner), <Crown size={13} className="crown" aria-label="Dono" />)}
        {people.map((m) =>
          item(
            m.id,
            <Avatar user={m} size={24} frame={false} />,
            <UserName user={m} />,
            summary(m),
            isCustom(m) && (custom[m.id] & PERM.ADMIN ? <Shield size={13} className="crown admin-badge" aria-label="Administrador" /> : <span className="pm-dot" title="Personalizado" />),
          ),
        )}
        {!people.length && q.trim() && <p className="kv">Ninguém encontrado.</p>}
      </nav>
      <section className="pm-detail">
        {head}
        <div className="perm-one">{body}</div>
      </section>
    </div>
  );
}

/** O que avisar neste servidor (cada pessoa escolhe; vale para o app e para o push). */
function GuildNotify({ guildId }) {
  const saved = useStore((s) => s.guildNotify[guildId]);
  const channels = useStore((s) => s.guildData[guildId]?.channels) || [];
  const perms = usePerms(useStore, guildId);
  const [n, setN] = useState({ ...DEFAULT_NOTIFY, ...saved });
  const [status, setStatus] = useState('');
  const save = async (next) => {
    setN(next);
    setStatus('Salvando…');
    try {
      await useStore.getState().setGuildNotify(guildId, next);
      setStatus('Salvo');
    } catch (e) {
      setStatus('');
      useStore.getState().notify(e.message);
    }
  };
  const text = channels.filter((c) => c.type === 'text');
  const voice = channels.filter((c) => c.type === 'voice');
  const announce = async (c, on) => {
    try {
      await useStore.getState().setChannelAnnounce(c.id, on);
    } catch (e) {
      useStore.getState().notify(e.message);
    }
  };
  return (
    <div className="gs-notify">
      <section className="gs-box">
        <div className="gs-box-head">
          <b>Mensagens nos canais de texto</b>
          <small aria-live="polite">{status}</small>
        </div>
        <div className="gs-radios" role="radiogroup" aria-label="Mensagens nos canais">
          {[
            ['all', 'Todas as mensagens'],
            ['mentions', 'Só quando me mencionarem (@usuário)'],
            ['none', 'Nenhuma'],
          ].map(([v, l]) => (
            <label key={v} className="radio-line">
              <input type="radio" name="gs-msgs" checked={n.messages === v} onChange={() => save({ ...n, messages: v })} />
              {l}
            </label>
          ))}
        </div>
        {n.messages === 'all' && text.length > 0 && (
          <div className="gs-channels" role="group" aria-label="Canais que avisam">
            {text.map((c) => (
              <label key={c.id} className="perm-chip">
                <input
                  type="checkbox"
                  checked={!n.mutedChannels.includes(c.id)}
                  aria-label={`Avisar mensagens em #${c.name}`}
                  onChange={(e) =>
                    save({
                      ...n,
                      mutedChannels: e.target.checked ? n.mutedChannels.filter((id) => id !== c.id) : [...n.mutedChannels, c.id],
                    })
                  }
                />
                <Hash size={13} /> {c.name}
              </label>
            ))}
          </div>
        )}
      </section>
      <section className="gs-box">
        <div className="gs-box-head">
          <b>Também avisar quando</b>
        </div>
        {[
          ['voiceJoin', 'Alguém entrar em um canal de voz', Volume2],
          ['streams', 'Alguém começar a transmitir a tela', MonitorUp],
          ['members', 'Alguém novo entrar no servidor', UserPlus],
        ].map(([k, l, Icon]) => (
          <label key={k} className="checkbox">
            <input type="checkbox" checked={Boolean(n[k])} onChange={(e) => save({ ...n, [k]: e.target.checked })} />
            <span>
              <Icon size={14} /> {l}
            </span>
          </label>
        ))}
        <p className="kv">
          Os avisos aparecem no app e, com ele fechado ou em segundo plano, como notificação no celular ou no navegador.
        </p>
      </section>
      {perms.channels && voice.length > 0 && (
        <section className="gs-box">
          <div className="gs-box-head">
            <b>Canais de voz que avisam quem entra</b>
            <small>vale para todos do servidor</small>
          </div>
          <div className="gs-channels" role="group" aria-label="Canais de voz que avisam quando alguém entra">
            {voice.map((c) => (
              <label key={c.id} className="perm-chip">
                <input
                  type="checkbox"
                  checked={c.announceJoin !== false}
                  aria-label={`Avisar quando alguém entrar em ${c.name}`}
                  onChange={(e) => announce(c, e.target.checked)}
                />
                <Volume2 size={13} /> {c.name}
              </label>
            ))}
          </div>
          <p className="kv">
            Quem entra num canal desmarcado não gera o aviso “entrou em 🔊 …” para ninguém, mesmo para quem pediu esse aviso.
          </p>
        </section>
      )}
    </div>
  );
}

/** Reduz a imagem de fundo para no máximo 1920×1080 (sem distorcer). */
async function prepareBackground(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bitmap.width, 1080 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  const webp = await blob('image/webp', 0.85);
  return webp?.type === 'image/webp' ? webp : blob('image/jpeg', 0.88);
}

/** Escolher/tirar uma imagem de fundo (com a prévia, cortada como na tela). */
function BackgroundPick({ url, base, onPick, onRemove, label }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      useStore.getState().notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-pick">
      <div className="bg-preview" style={url ? { backgroundImage: `url("${base}${url}")` } : undefined}>
        {!url && <span>Sem imagem</span>}
      </div>
      <div className="bg-actions">
        <IconBtn icon={ImagePlus} label={`Escolher ${label}`} disabled={busy} onClick={() => input.current?.click()} />
        {url && <IconBtn icon={Trash2} label={`Tirar ${label}`} disabled={busy} onClick={() => run(onRemove)} />}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) run(async () => onPick(await prepareBackground(file)));
          }}
        />
      </div>
      <small>A imagem cobre a janela toda: se o formato for diferente, ela aumenta e corta as sobras (sem faixas pretas).</small>
    </div>
  );
}

// ---------- Registro do servidor ----------

const LOG_KINDS = [
  ['', 'Tudo'],
  ['member', 'Entradas e saídas'],
  ['voice', 'Canais de voz'],
  ['message', 'Mensagens'],
  ['settings', 'Configurações'],
];
const LOG_PERIODS = [
  [0, 'Qualquer data'],
  [DAY, 'Últimas 24 horas'],
  [7 * DAY, 'Últimos 7 dias'],
  [30 * DAY, 'Últimos 30 dias'],
];
const LOG_ICON = { member: UserPlus, voice: Volume2, message: MessageSquare, settings: Settings2 };

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'menos de 1 minuto';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

const SETTING_LABELS = {
  name: 'nome',
  defaultPerms: 'permissões padrão',
  fileTtlMs: 'validade dos arquivos',
  voiceTtlMs: 'validade das mensagens de voz',
  msgColor: 'cor das mensagens',
  msgColorMode: 'regra da cor das mensagens',
  moveSound: 'som ao mover alguém',
  sounds: 'sons rápidos',
};
const permNames = (bits) =>
  PERM_OPTIONS.filter((o) => (bits & o.bit) !== 0)
    .map((o) => o.label.toLowerCase())
    .join(', ') || 'nenhuma';

/** Frase de um item do registro. */
function describe(e, channelName) {
  const a = <b>{e.actor?.name || e.actor?.username || 'alguém'}</b>;
  const t = <b>{e.target?.name || e.target?.username || 'alguém'}</b>;
  const ch = e.channelName || e.detail?.name || 'canal apagado';
  const d = e.detail || {};
  switch (e.kind) {
    case 'member.join':
      return <>{a} entrou no servidor</>;
    case 'member.leave':
      return <>{a} saiu do servidor</>;
    case 'voice.join':
      return <>{a} entrou em 🔊 {ch}</>;
    case 'voice.leave':
      return (
        <>
          {a} saiu de 🔊 {ch} depois de {fmtDuration(d.durationMs || 0)}
        </>
      );
    case 'voice.move':
      return (
        <>
          {a} moveu {t} de 🔊 {channelName(d.from)} para 🔊 {ch}
        </>
      );
    case 'voice.mute':
      return <>{a} silenciou {t} para todos em 🔊 {ch}</>;
    case 'voice.unmute':
      return <>{a} tirou o silêncio de {t} em 🔊 {ch}</>;
    case 'voice.disconnect':
      return <>{a} desconectou {t} de 🔊 {ch}</>;
    case 'message.send':
      return (
        <>
          {a} em #{ch}: <span className="log-text">{d.text}</span>
        </>
      );
    case 'message.edit':
      return (
        <>
          {a} editou em #{ch}: <span className="log-text old">{d.before}</span> → <span className="log-text">{d.text}</span>
        </>
      );
    case 'message.pin':
      return (
        <>
          {a} fixou em #{ch}: <span className="log-text">{d.text}</span>
        </>
      );
    case 'message.unpin':
      return (
        <>
          {a} desafixou em #{ch}: <span className="log-text">{d.text}</span>
        </>
      );
    case 'message.delete':
      return (
        <>
          {a} apagou {e.target ? <>uma mensagem de {t}</> : 'uma mensagem'} em #{ch}: <span className="log-text">{d.text}</span>
        </>
      );
    case 'settings.guild':
      return (
        <>
          {a} mudou {Object.keys(d).map((k) => SETTING_LABELS[k] || k).join(', ')}
          {d.name ? <> (nome: “{d.name}”)</> : null}
        </>
      );
    case 'settings.perms':
      return d.custom === false ? (
        <>
          {a} tirou {t} da lista de permissões (voltou ao padrão)
        </>
      ) : (
        <>
          {a} deu a {t}: {permNames(d.perms)}
        </>
      );
    case 'settings.icon':
      return <>{a} {d.on ? 'trocou' : 'removeu'} o ícone do servidor</>;
    case 'settings.background':
      return <>{a} {d.on ? 'trocou' : 'removeu'} a imagem de fundo do servidor</>;
    case 'settings.channel_create':
      return (
        <>
          {a} criou o canal {d.private ? 'privado ' : ''}
          {d.type === 'voice' ? '🔊 ' : '#'}
          {d.name}
        </>
      );
    case 'settings.channel_order':
      return <>{a} mudou a ordem dos canais de {d.type === 'voice' ? 'voz' : 'texto'}</>;
    case 'settings.channel_delete':
      return (
        <>
          {a} excluiu o canal {d.type === 'voice' ? '🔊 ' : '#'}
          {d.name}
        </>
      );
    case 'settings.channel_rename':
      return (
        <>
          {a} renomeou {d.from} para {d.to}
        </>
      );
    case 'settings.channel_access':
      return d.private ? (
        <>
          {a} deixou {d.name} privado ({d.people} {d.people === 1 ? 'pessoa' : 'pessoas'} com acesso)
        </>
      ) : (
        <>
          {a} deixou {d.name} público
        </>
      );
    case 'settings.file_delete':
      return (
        <>
          {a} apagou o arquivo {d.name}
          {e.target && e.target.id !== e.actor?.id ? <> de {t}</> : null}
        </>
      );
    case 'settings.file_ttl':
      return (
        <>
          {a} mudou a validade de {d.name} ({d.expiresAt ? `some em ${new Date(d.expiresAt).toLocaleString('pt-BR')}` : 'não expira'})
        </>
      );
    default:
      return (
        <>
          {a} · {e.kind}
        </>
      );
  }
}

function GuildLog({ guildId }) {
  const members = useStore((s) => s.guildData[guildId]?.members) || [];
  const channels = useStore((s) => s.guildData[guildId]?.channels) || [];
  const [filters, setFilters] = useState({ kind: '', user: '', channel: '', q: '', period: 0 });
  const [q, setQ] = useState('');
  const [data, setData] = useState({ entries: null, next: null });
  const [loading, setLoading] = useState(false);
  const channelName = (id) => channels.find((c) => c.id === id)?.name || 'canal apagado';
  const load = async (before) => {
    setLoading(true);
    try {
      const res = await useStore.getState().guildLog(guildId, {
        kind: filters.kind,
        user: filters.user,
        channel: filters.channel,
        q: filters.q,
        since: filters.period ? Date.now() - filters.period : '',
        before: before || '',
      });
      setData((d) => ({ entries: before ? [...(d.entries || []), ...res.entries] : res.entries, next: res.next }));
    } catch (e) {
      useStore.getState().notify(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [guildId, filters]);
  // Busca por texto com um pequeno atraso enquanto digita.
  useEffect(() => {
    const t = setTimeout(() => q !== filters.q && setFilters((f) => ({ ...f, q })), 400);
    return () => clearTimeout(t);
  }, [q]);
  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: k === 'period' ? Number(e.target.value) : e.target.value }));
  const day = (ts) => {
    const d = new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    return d[0].toUpperCase() + d.slice(1);
  };
  let lastDay = '';
  return (
    <div className="gs-log">
      <div className="log-filters" role="group" aria-label="Filtros do registro">
        <select aria-label="Tipo" value={filters.kind} onChange={set('kind')}>
          {LOG_KINDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select aria-label="Pessoa" value={filters.user} onChange={set('user')}>
          <option value="">Todas as pessoas</option>
          {[...members]
            .sort((x, y) => plain(x.displayName).localeCompare(plain(y.displayName)))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {plain(m.displayName) || m.username}
              </option>
            ))}
        </select>
        <select aria-label="Canal" value={filters.channel} onChange={set('channel')}>
          <option value="">Todos os canais</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.type === 'voice' ? '🔊 ' : '#'}
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Período" value={filters.period} onChange={set('period')}>
          {LOG_PERIODS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Buscar no registro" placeholder="Buscar (nome, texto…)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {data.entries == null ? (
        <p className="kv">Carregando…</p>
      ) : data.entries.length === 0 ? (
        <p className="kv">Nada no registro com esses filtros.</p>
      ) : (
        <ol className="log-list" aria-label="Registro">
          {data.entries.map((e) => {
            const d = day(e.at);
            const sep = d !== lastDay;
            lastDay = d;
            const Icon = LOG_ICON[e.kind.split('.')[0]] || Settings2;
            return (
              <li key={e.id} className={`log-row k-${e.kind.split('.')[0]}`}>
                {sep && <div className="log-day">{d}</div>}
                <div className="log-line">
                  <Icon size={14} className="log-ico" />
                  <span className="log-desc">{describe(e, channelName)}</span>
                  <time dateTime={new Date(e.at).toISOString()}>
                    {new Date(e.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {data.next && (
        <div className="log-more">
          <button type="button" className="btn ghost" disabled={loading} onClick={() => load(data.next)}>
            {loading ? 'Carregando…' : 'Carregar mais'}
          </button>
        </div>
      )}
    </div>
  );
}

const GS_TABS = [
  ['geral', 'Geral', Settings2, false],
  ['membros', 'Membros e permissões', Users, true],
  ['notificacoes', 'Notificações', Bell, false],
  ['arquivos', 'Arquivos', FolderOpen, true],
  ['registro', 'Registro', ScrollText, true],
];

function GuildSettingsModal({ guildId, tab: startTab }) {
  const guild = useStore((s) => s.guilds.find((g) => g.id === guildId));
  const base = useStore((s) => s.baseUrl);
  const perms = usePerms(useStore, guildId);
  const [tab, setTab] = useState(startTab || 'geral');
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
  const tabs = GS_TABS.filter(([, , , admin]) => !admin || perms.admin);
  const current = tabs.find(([id]) => id === tab) || tabs[0];
  const myPerms = PERM_OPTIONS.filter((o) => perms[o.flag]);
  return (
    <div className="gs-layout">
      <nav className="gs-rail" role="tablist" aria-label="Seções" aria-orientation="vertical">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={current[0] === id}
            aria-label={label}
            data-tip={label}
            className={`gs-rail-btn tip-right${current[0] === id ? ' on' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={19} />
          </button>
        ))}
      </nav>
      <div className="gs-pane guild-settings">
        <div className="gs-pane-head">
          <span className={`gel guild guild-icon small${guild.iconUrl ? ' has-img' : ''}`} style={{ '--c': guild.iconColor }}>
            {guild.iconUrl ? <img src={base + guild.iconUrl} alt="" /> : <span>{guild.name.slice(0, 2).toUpperCase()}</span>}
          </span>
          <div>
            <h2>{current[1]}</h2>
            <small>{guild.name}</small>
          </div>
        </div>
        <div className="gs-pane-body">
          {current[0] === 'geral' && (
            <>
              {perms.admin ? (
                <div className="gs-top">
                  <div className="gs-icon">
                    <span className={`gel guild guild-icon big${guild.iconUrl ? ' has-img' : ''}`} style={{ '--c': guild.iconColor }}>
                      {guild.iconUrl ? <img src={base + guild.iconUrl} alt="" /> : <span>{guild.name.slice(0, 2).toUpperCase()}</span>}
                    </span>
                    <div className="gs-icon-actions">
                      <IconBtn icon={Camera} label="Escolher ícone" disabled={busy} onClick={() => iconInput.current?.click()} />
                      {guild.iconUrl && (
                        <IconBtn icon={Trash2} label="Remover ícone" disabled={busy} onClick={() => run(() => st.removeGuildIcon(guildId))} />
                      )}
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
                      <button
                        className="ico-btn tip-above"
                        data-tip="Salvar nome"
                        aria-label="Salvar nome"
                        disabled={busy || !name.trim() || name.trim() === guild.name}
                      >
                        <Check size={16} />
                      </button>
                    </div>
                  </form>
                </div>
              ) : null}
              {perms.admin && (
                <>
                  <div className="settings-sec">Aparência do servidor</div>
                  <div className="field">
                    <span>Imagem de fundo</span>
                    <BackgroundPick
                      url={guild.backgroundUrl}
                      base={base}
                      label="imagem de fundo"
                      onPick={(b) => st.setGuildBackground(guildId, b)}
                      onRemove={() => st.setGuildBackground(guildId, null)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="gs-msgmode">Cor das mensagens</label>
                    <select
                      id="gs-msgmode"
                      value={guild.msgColorMode || 'user'}
                      onChange={(e) => run(() => st.updateGuild(guildId, { msgColorMode: e.target.value }))}
                    >
                      <option value="user">Definida pelo usuário</option>
                      <option value="user_first">Preferência pela cor do usuário</option>
                      <option value="server">Cor do servidor</option>
                    </select>
                    {(guild.msgColorMode || 'user') !== 'user' && (
                      <ColorChoice
                        label="Cor das mensagens do servidor"
                        value={guild.msgColor || null}
                        palette={TEXT_COLORS}
                        defaultLabel="Nenhuma"
                        onChange={(hex) => run(() => st.updateGuild(guildId, { msgColor: hex }))}
                      />
                    )}
                    <small>
                      {
                        {
                          user: 'Cada pessoa usa a cor que escolheu nas configurações dela.',
                          user_first: 'Quem escolheu uma cor usa a sua; quem não escolheu usa a cor do servidor.',
                          server: 'Todas as mensagens usam a cor do servidor (mesmo de quem escolheu outra).',
                        }[guild.msgColorMode || 'user']
                      }
                    </small>
                  </div>
                  <div className="settings-sec">Voz</div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={guild.moveSound !== false}
                      onChange={(e) => run(() => st.updateGuild(guildId, { moveSound: e.target.checked }))}
                    />
                    <span>
                      Tocar um som para todos quando alguém for movido de canal
                      <small className="check-hint">Toca para quem está no canal de origem e no de destino.</small>
                    </span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={guild.sounds !== false}
                      onChange={(e) => run(() => st.updateGuild(guildId, { sounds: e.target.checked }))}
                    />
                    <span>
                      Permitir sons rápidos nos canais de voz
                      <small className="check-hint">Desligado, ninguém toca sons para os outros nos canais deste servidor.</small>
                    </span>
                  </label>
                </>
              )}
              {!perms.admin && (
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
                <IconBtn
                  icon={perms.owner ? Trash2 : LogOut}
                  label={perms.owner ? 'Excluir servidor' : 'Sair do servidor'}
                  tip="left"
                  className="danger"
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
                />
              </div>
            </>
          )}
          {current[0] === 'membros' && <GuildMembers guildId={guildId} perms={perms} />}
          {current[0] === 'notificacoes' && <GuildNotify guildId={guildId} />}
          {current[0] === 'arquivos' && <GuildFiles guildId={guildId} />}
          {current[0] === 'registro' && <GuildLog guildId={guildId} />}
        </div>
      </div>
    </div>
  );
}

const SIZES = { diagnostics: 'wide', settings: 'settings', guildSettings: 'gs-window', changelog: 'wide', sounds: 'wide' };

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
  changelog: ChangelogModal,
  share: ShareModal,
  sounds: SoundsModal,
  userSounds: UserSoundsModal,
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
