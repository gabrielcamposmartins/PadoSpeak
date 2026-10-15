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
  Mic,
  Timer,
  Check,
  ChevronLeft,
  ChevronRight,
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
  MicOff,
  PhoneOff,
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
  DEFAULT_NOTIFY,
} from '../store.js';
import { isDesktop, isTauri } from '../lib/env.js';
import { ConnProvider, useConn } from './conn.jsx';
import Avatar, { useUser, UserName, colorClass, colorStyle } from './Avatar.jsx';
import LatencyChart from './LatencyChart.jsx';
import { TitleBar } from './Aero.jsx';
import { FormattedText, Floating, TEXT_COLORS } from './Emotes.jsx';
import FormatTools, { formatKey, usePalette, DEFAULT_PALETTE, SHORTCUTS, MOD } from './FormatTools.jsx';
import { fmtSize, fmtLeft, useNow } from './Files.jsx';
import { plain, visibleLength } from '../lib/text.js';
import changelogMd from '../changelog.md?raw';

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

const SETTINGS_TABS = [
  ['aparencia', 'Aparência', Palette],
  ['funcionalidade', 'Funcionalidade', SlidersHorizontal],
  ['formatacao', 'Formatação de texto', Type],
];

/** Cores da paleta pessoal (Ctrl+1…8) e a lista de atalhos. */
function TextFormatting() {
  const palette = usePalette();
  const set = (i, hex) => {
    const next = [...palette];
    next[i] = hex;
    useStore.getState().setAppearance({ textPalette: next });
  };
  const isDefault = palette.every((c, i) => c.toLowerCase() === DEFAULT_PALETTE[i].toLowerCase());
  return (
    <>
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

function SettingsModal({ close }) {
  const prim = primaryConn();
  const me = prim((s) => s.me);
  const serverUrl = prim((s) => s.baseUrl);
  const accent = useStore((s) => s.prefs.accent || null);
  const saved = useStore((s) => s.prefs.devices) || {};
  const [tab, setTab] = useState('aparencia');
  const [devices, setDevices] = useState([]);
  const [choice, setChoice] = useState({ mic: '', camera: '', output: '', ...saved });
  const [rnnoise, setRnnoise] = useState(useStore.getState().prefs.noiseSuppression !== false);
  const [sounds, setSounds] = useState(useStore.getState().prefs.sounds !== false);
  const [repeatAlerts, setRepeatAlerts] = useState(useStore.getState().prefs.repeatAlerts !== false);
  const [nearbyVisible, setNearbyVisible] = useState(useStore.getState().prefs.nearbyVisible !== false);
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
        <div className="settings-sec">Voz e áudio</div>
        <DeviceSelect {...props} k="mic" kind="audioinput" label="Microfone" />
        <label className="checkbox">
          <input type="checkbox" checked={rnnoise} onChange={(e) => setRnnoise(e.target.checked)} />
          <span>
            Supressão de ruído por IA (RNNoise)
            <small className="check-hint">Remove teclado, ventilador e barulho de fundo do seu microfone.</small>
          </span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={sounds} onChange={(e) => setSounds(e.target.checked)} />
          <span>
            Sons de chamada
            <small className="check-hint">Entradas e saídas no canal de voz, transmissões, mensagens diretas e toque de chamada.</small>
          </span>
        </label>
        {canPickOutput && <DeviceSelect {...props} k="output" kind="audiooutput" label="Saída de áudio" />}
        <DeviceSelect {...props} k="camera" kind="videoinput" label="Câmera" />
        {needsPermission && (
          <p className="kv">Os nomes dos dispositivos aparecem depois que você permitir o acesso (entre em um canal de voz).</p>
        )}
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
        <div className="settings-sec">Notificações</div>
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
        <p className="kv">As notificações de cada servidor ficam nas configurações do servidor.</p>
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
                <small className="check-hint">Abre minimizado na bandeja, perto do relógio, para receber mensagens e chamadas.</small>
              </span>
            </label>
          </>
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
          {tab === 'formatacao' && <TextFormatting />}
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
            if (nearbyVisible !== (st.prefs.nearbyVisible !== false)) {
              st.setAppearance({ nearbyVisible });
              st.lanHello();
            }
            if (autostart?.available && autostartOn !== autostart.enabled)
              import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke('autostart_set', { on: autostartOn }))
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
    return <IconBtn icon={Timer} label="Arquivo grande: some 10 minutos depois do envio" tip="left" disabled className="mini-ico" size={14} />;
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
              <Timer size={13} /> Acima de {fmtSize(files.maxFile)}: o arquivo fica só {Math.round(files.big.ttlMs / 60000)} minutos,
              até {files.big.maxCount} de cada vez somando {fmtSize(files.big.maxTotal)} (agora: {files.big.count},{' '}
              {fmtSize(files.big.total)}).
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
                    <a className="gs-card-thumb" href={st.fileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
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
                      <a
                        className="ico-btn mini-ico tip-left"
                        href={st.fileUrl(f.id, true)}
                        download={f.name}
                        data-tip="Baixar"
                        aria-label={`Baixar ${f.name}`}
                      >
                        <Download size={14} />
                      </a>
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
  { bit: PERM.ADMIN, label: 'Administrador', hint: 'Tudo, menos excluir o servidor', icon: Shield },
  { bit: PERM.INVITE, label: 'Convidar pessoas', hint: 'Vê e compartilha o convite', icon: UserPlus },
  { bit: PERM.CHANNELS, label: 'Criar e editar canais', hint: 'Cria, renomeia e exclui canais', icon: Hash },
  { bit: PERM.MUTE, label: 'Silenciar na voz', hint: 'Silencia alguém para todos no canal de voz', icon: MicOff },
  { bit: PERM.DISCONNECT, label: 'Desconectar da voz', hint: 'Tira alguém do canal de voz', icon: PhoneOff },
  { bit: PERM.MOVE, label: 'Mover entre canais', hint: 'Move alguém para outro canal de voz', icon: ArrowRightLeft },
];
const PAGE = 6;

/**
 * Permissões: o padrão vale para todo mundo (começa só com "convidar"); quem é adicionado à lista
 * ganha permissões personalizadas, e tirar da lista volta ao padrão.
 */
function GuildMembers({ guildId, perms: mine }) {
  const guild = useStore((s) => s.guilds.find((g) => g.id === guildId));
  const members = useStore((s) => s.guildData[guildId]?.members) || [];
  const custom = useStore((s) => s.guildData[guildId]?.perms) || {};
  const [busy, setBusy] = useState(null);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const st = useStore.getState();
  const ownerId = guild?.ownerId;
  const defaults = guild?.defaultPerms ?? PERM.INVITE;
  const owner = members.find((m) => m.id === ownerId);
  const name = (m) => plain(m.displayName) || m.username;
  const listed = members.filter((m) => m.id !== ownerId && m.id in custom).sort((a, b) => name(a).localeCompare(name(b)));
  const pages = Math.max(1, Math.ceil(listed.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const shown = listed.slice(cur * PAGE, cur * PAGE + PAGE);
  const candidates = members
    .filter((m) => m.id !== ownerId && !(m.id in custom))
    .filter((m) => `${name(m)} ${m.username}`.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 8);

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
  const toggle = (m, bit, on) => {
    const bits = custom[m.id] || 0;
    return run(m.id, () => st.setMemberPerms(guildId, m.id, on ? bits | bit : bits & ~bit));
  };
  const add = (m) =>
    run(m.id, async () => {
      await st.setMemberPerms(guildId, m.id, defaults, true);
      setAdding(false);
      setQ('');
      // Vai para a página onde a pessoa entrou.
      const idx = [...listed, m].sort((a, b) => name(a).localeCompare(name(b))).findIndex((x) => x.id === m.id);
      setPage(Math.floor(idx / PAGE));
    });

  return (
    <div className="gs-perms">
      <section className="gs-box">
        <div className="gs-box-head">
          <b>Padrão para todos os membros</b>
          <small>Quem não está na lista abaixo pode:</small>
        </div>
        <div className="gs-default">
          {PERM_OPTIONS.filter((o) => o.bit !== PERM.ADMIN).map((o) => (
            <label key={o.bit} className="perm-chip" title={o.hint}>
              <input
                type="checkbox"
                checked={(defaults & o.bit) !== 0}
                disabled={busy === 'default'}
                aria-label={`${o.label}: todos`}
                onChange={(e) => toggleDefault(o.bit, e.target.checked)}
              />
              <o.icon size={14} /> {o.label}
            </label>
          ))}
        </div>
      </section>

      <section className="gs-box gs-custom">
        <div className="gs-box-head">
          <b>Permissões personalizadas</b>
          <small>{listed.length ? `${listed.length} na lista` : 'Ninguém na lista: todos usam o padrão.'}</small>
          <span className="tool-wrap gs-add">
            <IconBtn icon={UserPlus} label="Adicionar pessoa à lista" tip="left" className={adding ? 'pressed' : ''} onClick={() => setAdding(!adding)} />
          </span>
        </div>
        {adding && (
          <div className="gs-add-box">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar membro" aria-label="Buscar membro para adicionar" />
            <div className="gs-add-list" role="listbox" aria-label="Membros">
              {candidates.length === 0 && <p className="kv">Ninguém encontrado.</p>}
              {candidates.map((m) => (
                <button key={m.id} type="button" role="option" aria-selected={false} className="pick-row" disabled={busy === m.id} onClick={() => add(m)}>
                  <Avatar user={m} size={22} frame={false} />
                  <UserName user={m} />
                  <small>@{m.username}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {owner && (
          <div className="gs-member owner-row">
            <span className="gs-member-who">
              <Avatar user={owner} size={26} frame={false} />
              <UserName user={owner} className="gs-member-name" />
              <Crown size={13} className="crown" aria-label="Dono" />
            </span>
            <small>Dono — todas as permissões</small>
          </div>
        )}
        {listed.length > 0 && (
          <div className="gs-members" role="table" aria-label="Permissões personalizadas">
            <div className="gs-member gs-member-head" role="row">
              <span>Membro</span>
              {PERM_OPTIONS.map((o) => (
                <span key={o.bit} className="perm-col tip-above" data-tip={o.label} aria-label={o.label}>
                  <o.icon size={15} />
                </span>
              ))}
              <span />
            </div>
            {shown.map((m) => {
              const bits = custom[m.id] || 0;
              const isAdmin = (bits & PERM.ADMIN) !== 0;
              const locked = isAdmin && !mine.owner; // só o dono mexe em admins
              return (
                <div className="gs-member" role="row" key={m.id}>
                  <span className="gs-member-who">
                    <Avatar user={m} size={26} frame={false} />
                    <UserName user={m} className="gs-member-name" />
                    {isAdmin && <Shield size={13} className="crown admin-badge" aria-label="Administrador" />}
                  </span>
                  {PERM_OPTIONS.map((o) => {
                    const implied = o.bit !== PERM.ADMIN && isAdmin;
                    return (
                      <label key={o.bit} className="gs-perm" title={o.hint}>
                        <input
                          type="checkbox"
                          aria-label={`${o.label}: ${name(m)}`}
                          checked={(bits & o.bit) !== 0 || implied}
                          disabled={busy === m.id || locked || implied || (o.bit === PERM.ADMIN && !mine.owner)}
                          onChange={(e) => toggle(m, o.bit, e.target.checked)}
                        />
                      </label>
                    );
                  })}
                  <IconBtn
                    icon={X}
                    size={14}
                    tip="left"
                    className="mini-ico"
                    label={`Tirar ${name(m)} da lista (volta ao padrão)`}
                    disabled={busy === m.id || locked}
                    onClick={() => run(m.id, () => st.setMemberPerms(guildId, m.id, 0, false))}
                  />
                </div>
              );
            })}
          </div>
        )}
        {pages > 1 && (
          <div className="gs-pager">
            <IconBtn icon={ChevronLeft} label="Página anterior" disabled={cur === 0} onClick={() => setPage(cur - 1)} />
            <span>
              {cur * PAGE + 1}–{Math.min(listed.length, cur * PAGE + PAGE)} de {listed.length}
            </span>
            <IconBtn icon={ChevronRight} label="Próxima página" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
          </div>
        )}
      </section>
    </div>
  );
}

/** O que avisar neste servidor (cada pessoa escolhe; vale para o app e para o push). */
function GuildNotify({ guildId }) {
  const saved = useStore((s) => s.guildNotify[guildId]);
  const channels = useStore((s) => s.guildData[guildId]?.channels) || [];
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
          {a} criou o canal {d.type === 'voice' ? '🔊 ' : '#'}
          {d.name}
        </>
      );
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

function GuildSettingsModal({ guildId }) {
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
  const tabs = GS_TABS.filter(([, , , admin]) => !admin || perms.admin);
  const current = tabs.find(([id]) => id === tab) || tabs[0];
  const myPerms = PERM_OPTIONS.filter((o) => (o.bit === PERM.ADMIN ? perms.admin : o.bit === PERM.INVITE ? perms.invite : perms.channels));
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

const SIZES = { diagnostics: 'wide', settings: 'settings', guildSettings: 'gs-window', changelog: 'wide' };

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
