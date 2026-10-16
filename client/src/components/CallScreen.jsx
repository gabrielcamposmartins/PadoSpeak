// Celular: a chamada em tela própria, de ponta a ponta — chamada privada ou canal de voz, com vídeo e
// tela compartilhada (o palco é a VoiceView). A seta para baixo minimiza: a chamada continua e uma
// faixa verde no alto da tela leva de volta. Os sons rápidos abrem numa folha por cima dos botões.
import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  SwitchCamera,
  MonitorUp,
  MonitorOff,
  PhoneOff,
  Phone,
  LayoutGrid,
  ChevronRight,
} from 'lucide-react';
import { useStore } from '../store.js';
import { useVoiceConn } from './conn.jsx';
import { useLayout } from '../lib/layout.js';
import { plain } from '../lib/text.js';
import { useServerPing } from './hooks.js';
import VoiceView from './VoiceView.jsx';
import SoundPanel from './SoundPanel.jsx';
import Avatar from './Avatar.jsx';

/** Quando cada chamada começou a valer (alguém do outro lado conectou), para o relógio. */
const started = new Map();

function useClock(voice) {
  const [, tick] = useState(0);
  const id = voice?.channelId;
  const connected = Boolean(voice?.peers.length);
  if (id && connected && !started.has(id)) started.set(id, Date.now());
  useEffect(() => {
    if (!id) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [id]);
  useEffect(() => () => id && started.delete(id), [id]);
  const at = id && started.get(id);
  if (!at) return null;
  const sec = Math.floor((Date.now() - at) / 1000);
  const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return sec >= 3600 ? `${Math.floor(sec / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Barrinhas de qualidade a partir do ping até o servidor. */
function Quality({ ping }) {
  if (ping == null) return null;
  const bars = ping < 120 ? 3 : ping < 250 ? 2 : 1;
  return (
    <span className={`cs-quality q${bars}`} title={`${ping} ms até o servidor`} aria-label={`Conexão ${bars === 3 ? 'boa' : bars === 2 ? 'média' : 'fraca'}`}>
      <i />
      <i />
      <i />
    </span>
  );
}

const canShare = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);

export default function CallScreen() {
  const phone = useLayout() === 'phone';
  const vc = useVoiceConn();
  const voice = vc((s) => s.voice);
  const dm = vc((s) => (s.voice?.dm ? s.dms.find((d) => d.id === s.voice.channelId) : null));
  const channel = vc((s) =>
    s.voice && !s.voice.dm ? s.guildData[s.voice.guildId]?.channels.find((c) => c.id === s.voice.channelId) : null,
  );
  const guild = vc((s) => (s.voice && !s.voice.dm ? s.guilds.find((g) => g.id === s.voice.guildId) : null));
  const minimized = useStore((s) => s.callMinimized);
  const muted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.selfDeafened);
  const [sheet, setSheet] = useState(false);
  const clock = useClock(voice);
  const ping = useServerPing(Boolean(voice), vc);
  const lastId = useRef(null);

  // Chamada nova: abre a tela cheia.
  useEffect(() => {
    const id = voice?.channelId || null;
    if (id && id !== lastId.current) useStore.setState({ callMinimized: false });
    if (!id) setSheet(false);
    lastId.current = id;
  }, [voice?.channelId]);

  // Faixa da chamada minimizada: o app desce um pouco para ela caber no alto.
  const showBar = phone && voice && minimized;
  useEffect(() => {
    document.documentElement.classList.toggle('has-callbar', Boolean(showBar));
    return () => document.documentElement.classList.remove('has-callbar');
  }, [showBar]);

  if (!phone || !voice) return null;
  const st = vc.getState();
  const calling = voice.dm && voice.peers.length === 0;
  const title = dm ? plain(dm.recipient.displayName) : channel ? channel.name : 'Chamada';
  const sub = dm ? null : guild?.name;
  const status = calling ? 'Chamando…' : clock || 'Conectando…';
  const stageChannel = dm ? { id: dm.id, name: title, dm: true } : channel || { id: voice.channelId, name: title };
  const minimize = () => useStore.setState({ callMinimized: true });
  const restore = () => useStore.setState({ callMinimized: false });

  if (minimized) {
    return (
      <button type="button" className="call-bar" data-sysbar="--callbar" onClick={restore}>
        <Phone size={14} />
        <span className="cb-text">
          {dm ? `Em chamada com ${title}` : `🔊 ${title}`} · {status}
        </span>
        <span className="cb-back">
          Voltar <ChevronRight size={14} />
        </span>
      </button>
    );
  }

  return (
    <div className="call-screen" role="dialog" aria-label={dm ? `Chamada com ${title}` : `Canal de voz ${title}`} data-sysbar="--call-top" data-sysbar-bottom="--call-bottom">
      <header className="cs-head">
        <button type="button" className="cs-ic" onClick={minimize} title="Minimizar (a chamada continua)" aria-label="Minimizar a chamada">
          <ChevronDown size={20} />
        </button>
        <div className="cs-title">
          <b>{dm ? title : `🔊 ${title}`}</b>
          <span>
            {sub ? `${sub} · ` : ''}
            <span className="cs-clock">{status}</span>
            <Quality ping={ping} />
          </span>
        </div>
        <span className="cs-ic-space" />
      </header>

      <div className="cs-stage">
        {calling && dm ? (
          <div className="cs-calling">
            <div className="cs-rings">
              <span />
              <span />
              <span />
              <Avatar user={dm.recipient} size={112} />
            </div>
            <b>{title}</b>
            <span>Chamando…</span>
          </div>
        ) : (
          <VoiceView channel={stageChannel} variant="call" />
        )}
      </div>

      <div className="cs-bottom">
      {sheet && (
        <div className="cs-sheet">
          <div className="cs-grab" onClick={() => setSheet(false)} />
          <SoundPanel variant="sheet" />
        </div>
      )}

      <nav className="cs-dock" aria-label="Controles da chamada">
        <CtlButton on={!muted && !deafened} off={muted || deafened} label="Microfone" onClick={st.toggleMute} pressed={muted}>
          {muted || deafened ? <MicOff /> : <Mic />}
        </CtlButton>
        <CtlButton off={deafened} label={deafened ? 'Ouvir' : 'Ensurdecer'} onClick={st.toggleDeafen} pressed={deafened}>
          {deafened ? <HeadphoneOff /> : <Headphones />}
        </CtlButton>
        <CtlButton on={voice.video} label="Câmera" onClick={st.toggleCamera} pressed={voice.video}>
          {voice.video ? <Video /> : <VideoOff />}
        </CtlButton>
        {voice.video ? (
          <CtlButton label="Virar" onClick={st.flipCamera}>
            <SwitchCamera />
          </CtlButton>
        ) : canShare ? (
          <CtlButton on={voice.screen} label={voice.screen ? 'Parar' : 'Transmitir'} onClick={() => st.toggleScreen('720p30')} pressed={voice.screen}>
            {voice.screen ? <MonitorOff /> : <MonitorUp />}
          </CtlButton>
        ) : null}
        <CtlButton on={sheet} label="Sons" onClick={() => setSheet((v) => !v)} pressed={sheet}>
          <LayoutGrid />
        </CtlButton>
        <button type="button" className="cs-hangup" onClick={st.leaveVoice} aria-label={dm ? 'Desligar' : 'Sair do canal'}>
          <PhoneOff />
          <span>{dm ? 'Desligar' : 'Sair'}</span>
        </button>
      </nav>
      </div>
    </div>
  );
}

function CtlButton({ on, off, label, onClick, pressed, children }) {
  return (
    <button
      type="button"
      className={`cs-ctl${on ? ' on' : ''}${off ? ' off' : ''}`}
      onClick={onClick}
      aria-pressed={pressed == null ? undefined : Boolean(pressed)}
      aria-label={label}
    >
      <span className="b">{children}</span>
      <span className="l">{label}</span>
    </button>
  );
}
