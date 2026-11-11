import { useEffect, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  MonitorUp,
  MonitorOff,
  PhoneOff,
  Maximize,
  Settings,
  Volume2,
  Activity,
  AudioWaveform,
  VolumeX,
  X,
  SwitchCamera,
  EyeOff,
  WifiOff,
  RefreshCw,
  Pin,
} from 'lucide-react';
import { useStore } from '../store.js';
import { useConn } from './conn.jsx';
import { plain } from '../lib/text.js';
import { SCREEN_PRESETS } from '../lib/voice.js';
import Avatar from './Avatar.jsx';
import { FormattedText } from './Emotes.jsx';
import { useServerPing } from './hooks.js';
import { enterFullscreen } from '../lib/fullscreen.js';
import { useLayout, isTouch } from '../lib/layout.js';
import { pickAutoFocus } from '../lib/callFocus.js';
import { MobileBack } from './Mobile.jsx';
import { InviteButton } from './CallInvite.jsx';
import VolumeSlider from './Volume.jsx';
import { VoiceMemberMenu } from './VoiceMenus.jsx';
import { TileFx, HandBadge } from './CallFx.jsx';

/**
 * O botão de compartilhar tela fica em todo lugar (inclusive no app instalado no celular). Onde o
 * navegador não oferece captura de tela (ou sem HTTPS), ele explica por que não dá.
 */
const canShareScreen = true;

/** Celular: a faixa com a sua câmera fica num canto e dá para arrastar com o dedo. */
function useDraggable(enabled) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef(null);
  if (!enabled) return {};
  return {
    style: { transform: `translate(${pos.x}px, ${pos.y}px)` },
    onPointerDown: (e) => {
      drag.current = { sx: e.clientX, sy: e.clientY, x: pos.x, y: pos.y, moved: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
      if (d.moved) setPos({ x: d.x + dx, y: d.y + dy });
    },
    onPointerUp: () => {
      setTimeout(() => (drag.current = null), 0);
    },
    // Arrastou: não conta como toque para destacar o vídeo.
    onClickCapture: (e) => {
      if (drag.current?.moved) e.stopPropagation();
    },
  };
}

/** <video> que acompanha o MediaStream e mede o que é de fato desenhado (resolução/fps). */
function StreamVideo({ stream, mirror, onStats }) {
  const ref = useRef(null);
  // Trocar de câmera troca a trilha dentro do mesmo stream: o Safari só mostra a nova com o stream
  // reatribuído (senão a sua imagem fica preta).
  const trackId = stream?.getVideoTracks()[0]?.id;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject === stream) el.srcObject = null;
    el.srcObject = stream;
    el.play?.().catch(() => {});
  }, [stream, trackId]);
  // O celular pausa os vídeos quando a pessoa troca de app, e nem sempre volta a tocá-los.
  useEffect(() => {
    const replay = () => {
      const el = ref.current;
      if (document.visibilityState === 'visible' && el?.paused && el.srcObject) el.play?.().catch(() => {});
    };
    document.addEventListener('visibilitychange', replay);
    return () => document.removeEventListener('visibilitychange', replay);
  }, []);
  useEffect(() => {
    if (!onStats) return;
    let lastFrames = 0;
    const t = setInterval(() => {
      const el = ref.current;
      if (!el?.videoWidth) {
        onStats(null);
        return;
      }
      const frames = el.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      onStats({ w: el.videoWidth, h: el.videoHeight, fps: lastFrames ? frames - lastFrames : null });
      lastFrames = frames;
    }, 1000);
    return () => clearInterval(t);
  }, [onStats]);
  return <video ref={ref} autoPlay playsInline muted className={mirror ? 'mirror' : undefined} />;
}

const LIMIT = { bandwidth: 'banda', cpu: 'CPU', other: 'outro' };
/** Vídeo preso por mais que isto entra no histórico do diagnóstico (menos é só o começo normal). */
const NOTE_VIDEO_AFTER_MS = 5000;
/** Conexão caída por mais que isto é falha de verdade (antes disso a reconexão automática ainda age). */
const FAILED_AFTER_MS = 20000;
const CONNECTING = 'Conectando…';

function fmtStats(st, self) {
  const rate = st.kbps == null ? '' : st.kbps >= 1000 ? ` · ${(st.kbps / 1000).toFixed(1)} Mbps` : ` · ${st.kbps} kbps`;
  const limit =
    self && st.limitedBy && st.limitedBy !== 'none' ? ` · limitado por ${LIMIT[st.limitedBy] || st.limitedBy}` : '';
  return `${st.w}×${st.h} · ${st.fps} fps · ${st.codec}${rate}${limit}`;
}

/**
 * O que está segurando um vídeo recebido, em termos técnicos, a partir do getStats. Quase sempre passa
 * sozinho (o começo da transmissão, a imagem que parou de mudar), então só o diagnóstico mostra.
 */
function videoDetail(tile, rendered) {
  const st = tile.stats;
  if (tile.self || !tile.stream || tile.connection !== 'connected' || !st) return null;
  if (st.bytes === 0) return 'conectado, mas nenhum dado de vídeo está chegando';
  if (st.frames === 0) return `dados chegando, mas o vídeo não decodifica (${st.codec}${st.decoder ? `, ${st.decoder}` : ''})`;
  if (rendered && rendered.fps === 0 && st.fps > 0) return 'o vídeo chega e decodifica, mas não está sendo desenhado';
  return null;
}

const isDown = (c) => c === 'failed' || c === 'disconnected' || c === 'closed';

/**
 * O que o card diz enquanto um vídeo recebido não aparece: até estabilizar é sempre "Conectando…". Com
 * imagem na tela, mesmo parada, nada. `failed`: a conexão continua caída depois de `FAILED_AFTER_MS`.
 */
function videoProblem(tile, rendered, failed) {
  if (tile.self || !tile.stream) return null;
  if (failed)
    return 'A conexão de mídia com esta pessoa falhou. Em redes diferentes é preciso um servidor TURN; na mesma rede, verifique o firewall.';
  return tile.connection !== 'connected' || !rendered?.w ? CONNECTING : null;
}

/** Lado menor do card (para a foto crescer quando o card é grande). */
function useShortSide(ref) {
  const [side, setSide] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setSide(Math.round(Math.min(e.contentRect.width, e.contentRect.height))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return side;
}

function Tile({ tile, focused, pinned, grid, onFocus }) {
  const [rendered, setRendered] = useState(null);
  const [menu, setMenu] = useState(null);
  const voice = useConn()((s) => s.voice);
  const ref = useRef(null);
  // Card grande (coluna da grade ou foco): foto 2,5× maior, sem passar de 55% do lado menor.
  const side = useShortSide(ref);
  const baseSize = focused ? 96 : 54;
  const fitted = side >= 280 ? Math.round(Math.min(baseSize * 2.5, side * 0.55)) : baseSize;
  // Na grade com mais de 4 pessoas a foto é 2,5× maior, mas sempre cabendo no card com espaço para o
  // nome embaixo: com mais gente na chamada os cards encolhem e a foto encolhe junto.
  const avatarSize = grid && side ? Math.max(baseSize, Math.round(Math.min(fitted * 2.5, side * 0.6, side - 70))) : fitted;
  const { setPeerVolume, setStreamAudio, setScreenAudioMuted, watchPeer, noteVideo, setHand } = useConn().getState();
  const name = plain(tile.user?.displayName) || 'alguém';
  const kind = tile.kind === 'screen' ? 'screen' : 'camera';
  const isScreen = tile.kind === 'screen';
  const detail = videoDetail(tile, rendered);
  const down = Boolean(tile.stream) && !tile.self && isDown(tile.connection);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!down) return undefined;
    const t = setTimeout(() => setFailed(true), FAILED_AFTER_MS);
    return () => clearTimeout(t);
  }, [down]);
  useEffect(() => {
    if (!detail) return undefined;
    const t = setTimeout(() => noteVideo(tile.peerId, `${isScreen ? 'tela' : 'câmera'}: ${detail}`), NOTE_VIDEO_AFTER_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);
  const problem =
    videoProblem(tile, rendered, failed) ||
    (tile.trouble && !isScreen ? `Sem conexão de voz com ${name} — você não ouve e não é ouvido. Tentando reconectar…` : null);
  const badge = tile.stats?.w
    ? `${tile.self ? 'enviando ' : ''}${fmtStats(tile.stats, tile.self)}`
    : rendered?.w
      ? `${rendered.w}×${rendered.h}${rendered.fps != null ? ` · ${rendered.fps} fps` : ''}`
      : null;
  return (
    <div
      ref={ref}
      className={`tile${tile.speaking ? ' speaking' : ''}${tile.live ? ' streaming' : ''}${isScreen ? ' screen' : ''}`}
      // A cor do banner do perfil (ou da foto, como no perfil) borrada atrás da pessoa.
      style={tile.user && (tile.user.bannerColor || tile.user.avatarColor) ? { '--banner': tile.user.bannerColor || tile.user.avatarColor } : undefined}
      onClick={onFocus}
      onContextMenu={(e) => {
        if (!tile.user || !voice) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      title={focused && pinned ? 'Fixado aqui. Clique para voltar à grade' : 'Clique para fixar o destaque aqui'}
    >
      {focused && pinned && (
        <span className="tile-pin" title="Destaque fixado (não troca para quem fala)" aria-label="Destaque fixado">
          <Pin size={14} aria-hidden="true" />
        </span>
      )}
      {menu && (
        <VoiceMemberMenu
          x={menu.x}
          y={menu.y}
          p={{ peerId: tile.self ? voice.selfId : tile.peerId, user: tile.user, serverMuted: tile.serverMuted }}
          channelId={voice.channelId}
          guildId={voice.dm ? null : voice.guildId}
          onClose={() => setMenu(null)}
        />
      )}
      {tile.stream ? (
        <StreamVideo
          stream={tile.stream}
          mirror={tile.self && !isScreen && tile.facing !== 'environment'}
          onStats={setRendered}
        />
      ) : tile.pending ? (
        <span className="waiting">{CONNECTING}</span>
      ) : tile.offer === 'screen' ? (
        <div className="tile-offer">
          <Avatar user={tile.user} size={focused ? 72 : 40} status="live" />
          <span>{name} está transmitindo</span>
          <button
            className="btn green"
            onClick={(e) => {
              e.stopPropagation();
              watchPeer(tile.peerId, 'screen', true);
              if (!focused) onFocus?.();
            }}
          >
            <MonitorUp size={15} /> Assistir transmissão
          </button>
        </div>
      ) : (
        <>
        <Avatar
          user={tile.user}
          size={avatarSize}
          status={tile.live ? 'live' : 'voice'}
          speaking={tile.speaking}
        />
        {tile.offer === 'camera' && (
          <button
            className="gloss tile-cam-offer"
            title={`Ver a câmera de ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              watchPeer(tile.peerId, 'camera', true);
            }}
          >
            <Video size={14} /> Ver câmera
          </button>
        )}
        </>
      )}
      {problem && <div className="tile-problem">{problem}</div>}
      {!isScreen && <TileFx userId={tile.user?.id} />}
      {!isScreen && tile.hand && <HandBadge self={tile.self} onLower={() => setHand(false)} />}
      {isScreen && (
        <div className="tile-badges">
          <span className="live">AO VIVO</span>
          {tile.self && tile.viewers != null && (
            <span className="res">{tile.viewers === 1 ? '1 assistindo' : `${tile.viewers} assistindo`}</span>
          )}
          {badge && <span className="res">{badge}</span>}
        </div>
      )}
      {!isScreen && badge && (focused || problem) && (
        <div className="tile-badges">
          <span className="res">{badge}</span>
        </div>
      )}
      <span className="tag">
        {tile.serverMuted && <MicOff size={13} className="server-muted" aria-label="silenciado para todos" />}
        {tile.localMuted && <VolumeX size={13} aria-label="silenciado para você" />}
        {tile.trouble && <WifiOff size={13} className="server-muted" aria-label="sem conexão de voz com você" />}
        {tile.muted && !tile.serverMuted && <MicOff size={13} />}
        {isScreen && tile.hasAudio && tile.audioMuted && <VolumeX size={13} />}
        <span>
          {isScreen
            ? tile.self
              ? 'Sua tela'
              : `Tela de ${plain(tile.user?.displayName) || '…'}`
            : tile.self
              ? 'Você'
              : tile.user?.displayName
                ? <FormattedText text={tile.user.displayName} size={14} />
                : 'Conectando…'}
        </span>
      </span>
      <div className="tile-tools" onClick={(e) => e.stopPropagation()}>
        {!tile.self && !isScreen && (
          <label className="tool-pill" title="Volume deste usuário">
            <Volume2 size={14} />
            <VolumeSlider
              label={`Volume de ${plain(tile.user?.displayName) || 'alguém'}`}
              value={tile.volume}
              max={2}
              onChange={(v) => setPeerVolume(tile.peerId, v)}
            />
          </label>
        )}
        {isScreen && tile.hasAudio && !tile.self && (
          <span className="tool-pill">
            <button
              title={tile.audioMuted ? 'Ativar áudio da transmissão' : 'Silenciar áudio da transmissão'}
              onClick={() => setStreamAudio(tile.peerId, { muted: !tile.audioMuted })}
            >
              {tile.audioMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <VolumeSlider
              label="Volume da transmissão"
              value={tile.audioMuted ? 0 : tile.streamVolume}
              max={2}
              onChange={(v) => setStreamAudio(tile.peerId, { volume: v, muted: false })}
            />
          </span>
        )}
        {isScreen && tile.hasAudio && tile.self && (
          <button
            className="tool-btn"
            title={tile.audioMuted ? 'Enviar áudio da transmissão' : 'Parar de enviar o áudio da transmissão'}
            onClick={() => setScreenAudioMuted(!tile.audioMuted)}
          >
            {tile.audioMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        )}
        {!tile.self && tile.watching && (tile.stream || tile.pending) && (
          <button
            className="tool-btn"
            title={kind === 'screen' ? 'Parar de assistir a transmissão' : `Parar de ver a câmera de ${name}`}
            aria-label={kind === 'screen' ? 'Parar de assistir' : 'Parar de ver a câmera'}
            onClick={() => watchPeer(tile.peerId, kind, false)}
          >
            {kind === 'screen' ? <EyeOff size={14} /> : <VideoOff size={14} />}
          </button>
        )}
        {tile.stream && (
          <button
            className="tool-btn tile-full"
            title="Tela cheia"
            aria-label="Tela cheia"
            onClick={() => {
              const video = ref.current?.querySelector('video');
              if (video) enterFullscreen(video);
            }}
          >
            <Maximize size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Mini gráfico de latência até o servidor + RTT atual com cada pessoa, sobre o palco. */
function DiagCard({ onClose }) {
  const useC = useConn();
  const [data, setData] = useState(() => useC.getState().latencyHistory());
  useEffect(() => {
    const t = setInterval(() => setData(useC.getState().latencyHistory()), 2000);
    return () => clearInterval(t);
  }, []);
  const recent = data.samples.slice(-30);
  const values = recent.map((s) => s.server).filter((v) => v != null);
  const max = Math.max(20, ...values) * 1.2;
  const pts = recent
    .map((s, i) => (s.server == null ? null : `${(i / Math.max(1, recent.length - 1)) * 200},${50 - (s.server / max) * 46}`))
    .filter(Boolean);
  const last = data.samples.at(-1);
  const fmt = (v) => (v == null ? '—' : `${Math.round(v)} ms`);
  return (
    <div className="diag-card glass" onClick={(e) => e.stopPropagation()}>
      <div className="diag-head">
        <Activity size={14} />
        <b>Diagnóstico da chamada</b>
        <button className="tool-x" aria-label="Fechar diagnóstico" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <svg
        viewBox="0 0 200 50"
        className="diag-spark"
        role="img"
        aria-label={`Latência até o servidor nos últimos ${recent.length * 2} segundos`}
      >
        {pts.length > 1 && (
          <>
            <path d={`M0,50 L${pts.join(' L')} L200,50 Z`} className="spark-fill" />
            <path d={`M${pts.join(' L')}`} className="spark-line" />
          </>
        )}
      </svg>
      <div className="diag-rows">
        {data.series.map((s) => (
          <span key={s.id}>
            {s.label} <b>{fmt(s.id === 'server' ? last?.server : last?.peers[s.id])}</b>
          </span>
        ))}
      </div>
      <button className="gloss diag-more" onClick={() => useStore.getState().openModal({ type: 'diagnostics' })}>
        Ver gráfico completo
      </button>
    </div>
  );
}

/**
 * Palco da chamada. `variant="call"`: dentro da tela de chamada do celular (CallScreen), que tem o
 * próprio cabeçalho e os próprios botões.
 */
export default function VoiceView({ channel, variant }) {
  const callScreen = variant === 'call';
  const useC = useConn();
  const voice = useC((s) => s.voice);
  const me = useC((s) => s.me);
  const muted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.selfDeafened);
  const layout = useLayout();
  const phone = layout === 'phone';
  // Destaque: 'auto' (padrão: a transmissão, ou a câmera de quem fala; veja lib/callFocus.js), 'grid' (clicou em
  // Grade: fica na grade) ou o id do vídeo que a pessoa clicou (fixado nele). No celular, o automático sem
  // vídeo destaca quem está com você (sua câmera vai para o canto).
  const [focusMode, setFocusMode] = useState('auto');
  // o vídeo fixado tinha imagem (câmera ou tela) quando foi clicado: se ela some, o destaque volta ao automático
  const pinVideo = useRef(false);
  const hasVideo = (t) => Boolean(t && (t.kind === 'screen' || t.stream || t.offer));
  const pin = (t) => {
    pinVideo.current = hasVideo(t);
    setFocusMode(t.id);
  };
  const autoRef = useRef({ id: null, since: 0 });
  const [, setFocusTick] = useState(0);
  const stripDrag = useDraggable(phone);
  // Pedido de "assistir a transmissão" (clique em quem está ao vivo): destaca a tela da pessoa assim que chegar.
  const focusRequest = useStore((s) => s.focusRequest);
  const [preset, setPreset] = useState('auto');
  const [showDiag, setShowDiag] = useState(false);
  const store = useC.getState();
  const inCall = voice?.channelId === channel.id;
  const nsOn = useStore((s) => s.prefs.noiseSuppression !== false);
  const ping = useServerPing(inCall, useC);

  const tiles = [];
  if (inCall) {
    tiles.push({
      id: 'me',
      self: true,
      user: me,
      stream: voice.localCamera,
      stats: voice.localCameraStats,
      facing: voice.cameraFacing,
      speaking: voice.speaking.me,
      muted: muted || deafened,
      serverMuted: voice.serverMuted,
      live: Boolean(voice.localScreen),
      hand: voice.hand,
    });
    if (voice.localScreen)
      tiles.push({
        id: 'me:screen',
        kind: 'screen',
        self: true,
        user: me,
        stream: voice.localScreen,
        stats: voice.localScreenStats,
        hasAudio: voice.screenHasAudio,
        audioMuted: voice.screenAudioMuted,
        viewers: voice.screenViewers,
      });
    for (const p of voice.peers) {
      tiles.push({
        id: p.peerId,
        peerId: p.peerId,
        user: p.user,
        stream: p.cameraStream,
        stats: p.cameraStats,
        connection: p.connectionState,
        trouble: p.trouble,
        // Câmera ligada, mas você ainda não pediu para ver.
        offer: p.cameraAnnounced && !p.watchingCamera && !p.cameraStream ? 'camera' : null,
        watching: p.watchingCamera,
        speaking: voice.speaking[p.peerId],
        muted: p.muted || p.deafened,
        serverMuted: p.serverMuted,
        localMuted: p.localMuted,
        volume: p.volume,
        live: Boolean(p.screenAnnounced),
        hand: p.hand,
      });
      if (p.screenAnnounced) {
        tiles.push({
          id: `${p.peerId}:screen`,
          kind: 'screen',
          user: p.user,
          stream: p.screenStream,
          stats: p.screenStats,
          peerId: p.peerId,
          hasAudio: p.screenHasAudio,
          audioMuted: p.streamMuted,
          streamVolume: p.streamVolume,
          connection: p.connectionState,
          pending: p.watchingScreen && !p.screenStream,
          offer: !p.watchingScreen && !p.screenStream ? 'screen' : null,
          watching: p.watchingScreen,
        });
      }
    }
  }

  useEffect(() => {
    if (!focusRequest) return;
    const tile = tiles.find((t) => t.kind === 'screen' && t.user?.id === focusRequest.userId);
    if (tile) {
      if (!tile.watching) store.watchPeer(tile.peerId, 'screen', true);
      pin(tile);
      useStore.setState({ focusRequest: null });
    } else if (Date.now() - focusRequest.at > 20000) useStore.setState({ focusRequest: null });
  });

  const auto = pickAutoFocus({ tiles, prev: autoRef.current.id, since: autoRef.current.since, now: Date.now(), phone });
  useEffect(() => {
    if (auto.id !== autoRef.current.id) autoRef.current = { id: auto.id, since: Date.now() };
    // alguém começou a falar, mas o destaque ainda não pode trocar: olha de novo quando puder
    if (!auto.wait) return undefined;
    const t = setTimeout(() => setFocusTick((n) => n + 1), auto.wait);
    return () => clearTimeout(t);
  });
  const pinned = focusMode !== 'auto' && focusMode !== 'grid';
  // o vídeo fixado sumiu (a pessoa saiu, desligou a câmera ou parou de transmitir): volta ao automático
  const pinTile = pinned ? tiles.find((t) => t.id === focusMode) : null;
  const pinGone = inCall && pinned && (!pinTile || (pinVideo.current && !hasVideo(pinTile)));
  useEffect(() => {
    if (pinGone) setFocusMode('auto');
  }, [pinGone]);
  const focusedId = !inCall || focusMode === 'grid' ? null : focusMode === 'auto' || pinGone ? auto.id : focusMode;
  // A miniatura da chamada (fora desta tela, veja MiniCall) mostra o mesmo foco.
  useEffect(() => {
    if (inCall) useStore.setState({ callFocus: focusedId || null });
  }, [inCall, focusedId]);

  if (!inCall) {
    return (
      <div className="voice-view stage">
        <div className="stage-empty">
          <h2>{channel.name}</h2>
          <p>Ninguém está ouvindo você ainda.</p>
          <button className="btn green" onClick={() => store.joinVoice(channel.id)}>
            Entrar na chamada
          </button>
        </div>
      </div>
    );
  }

  const focused = tiles.find((t) => t.id === focusedId);
  const others = tiles.filter((t) => t !== focused);
  // "Foco": o automático; sem vídeo para destacar, fixa em alguém (como antes)
  const pickFocus = () => (auto.id ? setFocusMode('auto') : pin(tiles.find((t) => !t.self) || tiles[0]));
  const isPinned = pinned && !pinGone;
  const connectedCount = voice.peers.length + 1;

  return (
    <div className="voice-view stage">
      {!channel.dm && !callScreen && (
        <header className="stage-head">
          {phone && <MobileBack />}
          <Volume2 size={20} />
          <div className="stage-title">
            <b>{channel.name}</b>
            <span>
              {connectedCount} {connectedCount === 1 ? 'conectado' : 'conectados'} · P2P
              {ping != null ? ` · ${ping} ms` : ''}
            </span>
          </div>
          <div className="seg" role="group" aria-label="Layout">
            <button aria-pressed={Boolean(focused)} className={focused ? 'on' : ''} onClick={pickFocus}>
              Foco
            </button>
            <button aria-pressed={!focused} className={focused ? '' : 'on'} onClick={() => setFocusMode('grid')}>
              Grade
            </button>
          </div>
        </header>
      )}

      <div className="voice-stage">
        {focused ? (
          <>
            <div className="voice-focus">
              <Tile tile={focused} focused pinned={isPinned} onFocus={() => (isPinned ? setFocusMode('grid') : pin(focused))} />
            </div>
            {others.length > 0 && (
              <div className={`voice-strip${phone ? ' pip' : ''}`} {...stripDrag}>
                {others.map((t) => (
                  <Tile key={t.id} tile={t} onFocus={() => pin(t)} />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="voice-grid">
            {tiles.map((t) => (
              <Tile key={t.id} tile={t} grid={connectedCount > 4} onFocus={() => pin(t)} />
            ))}
          </div>
        )}
        {showDiag && <DiagCard onClose={() => setShowDiag(false)} />}
      </div>

      {!callScreen && (
      <div className="voice-controls">
        <div className="dock">
          <button
            className={`ball${muted || deafened ? ' red' : ''}`}
            onClick={store.toggleMute}
            title={muted ? 'Ativar microfone' : 'Silenciar'}
            aria-label={muted ? 'Ativar microfone' : 'Silenciar'}
            aria-pressed={muted}
          >
            {muted || deafened ? <MicOff /> : <Mic />}
          </button>
          <button
            className={`ball${deafened ? ' red' : ''}`}
            onClick={store.toggleDeafen}
            title={deafened ? 'Ativar áudio' : 'Ensurdecer'}
            aria-label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
            aria-pressed={deafened}
          >
            {deafened ? <HeadphoneOff /> : <Headphones />}
          </button>
          <button
            className={`ball${voice.video ? ' on' : ''}`}
            onClick={store.toggleCamera}
            title="Câmera"
            aria-label="Câmera"
            aria-pressed={voice.video}
          >
            {voice.video ? <Video /> : <VideoOff />}
          </button>
          {isTouch && voice.video && (
            <button className="ball" onClick={store.flipCamera} title="Trocar câmera" aria-label="Trocar câmera frontal e traseira">
              <SwitchCamera />
            </button>
          )}
          {canShareScreen && (
          <div className="ctrl-group">
            <button
              className={`ball${voice.screen ? ' on' : ''}`}
              onClick={() => store.toggleScreen(preset)}
              title={voice.screen ? 'Parar transmissão' : 'Compartilhar tela'}
              aria-label={voice.screen ? 'Parar transmissão' : 'Compartilhar tela'}
            >
              {voice.screen ? <MonitorOff /> : <MonitorUp />}
            </button>
            {voice.screen && (
              <button
                className="ball"
                onClick={store.switchScreen}
                title="Trocar a transmissão: outra janela ou a tela inteira, sem parar"
                aria-label="Trocar a transmissão"
              >
                <RefreshCw />
              </button>
            )}
            {voice.screen &&
              (() => {
                // O som começa como foi escolhido no seletor ("Compartilhar áudio"); aqui liga e desliga.
                const noTrack = !voice.screenHasAudio;
                const on = voice.screenHasAudio && !voice.screenAudioMuted;
                return (
                  <button
                    className={`ball${on ? '' : ' red'}`}
                    onClick={() => store.setScreenAudioMuted(!voice.screenAudioMuted)}
                    disabled={noTrack}
                    aria-pressed={on}
                    aria-label={on ? 'Transmissão com som' : 'Transmissão sem som'}
                    title={
                      noTrack
                        ? 'Esta transmissão está sem som. Para ter som, use Trocar e marque “Compartilhar áudio” no seletor.'
                        : on
                          ? 'Com som: clique para transmitir sem som'
                          : 'Sem som: clique para transmitir com som'
                    }
                  >
                    {on ? <Volume2 /> : <VolumeX />}
                  </button>
                );
              })()}
            <label className="quality">
              Qualidade
              <select
                value={voice.screen ? voice.screenPreset : preset}
                onChange={(e) => {
                  setPreset(e.target.value);
                  if (voice.screen) store.setScreenPreset(e.target.value);
                }}
                title="Qualidade da transmissão de tela"
              >
                {Object.entries(SCREEN_PRESETS).map(([k, p]) => (
                  <option key={k} value={k}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          )}
          <button
            className={`ball${nsOn ? ' aqua' : ''}`}
            onClick={() => store.setNoiseSuppression(!nsOn)}
            title={nsOn ? 'Supressão de ruído: ligada' : 'Supressão de ruído: desligada'}
            aria-label="Supressão de ruído por IA"
            aria-pressed={nsOn}
          >
            <AudioWaveform />
          </button>
          <button
            className={`ball${showDiag ? ' pressed' : ''}`}
            onClick={() => setShowDiag((v) => !v)}
            title="Diagnóstico da chamada"
            aria-label="Diagnóstico da chamada"
            aria-pressed={showDiag}
          >
            <Activity />
          </button>
          <button
            className="ball"
            onClick={() => store.openModal({ type: 'settings', focus: 'devices' })}
            title="Dispositivos"
            aria-label="Dispositivos"
          >
            <Settings />
          </button>
          {channel.dm && useC === useStore && <InviteButton />}
          <button className="ball red hangup" onClick={store.leaveVoice} title="Desconectar" aria-label="Desconectar">
            <PhoneOff />
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
