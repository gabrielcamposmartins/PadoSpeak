import { suppressNoise } from './noise.js';
import { plain } from './text.js';
import { isTauri } from './env.js';
import { startNativeScreenAudio } from './screenAudio.js';
import { keepAwake } from './audioWake.js';
import { videoTarget } from './videoBudget.js';

// Voz, câmera e compartilhamento de tela via WebRTC em malha (P2P), com "perfect negotiation".
// O servidor Rust só repassa a sinalização (oferta/resposta/ICE) entre quem está no mesmo canal.

export const SCREEN_PRESETS = {
  '1080p60': { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 9_000_000, hint: 'motion' },
  '1080p30': { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, hint: 'detail' },
  '720p30': { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 2_500_000, hint: 'detail' },
};
const CAMERA = { width: 1280, height: 720, fps: 30, bitrate: 1_500_000 };
const SPEAKING_THRESHOLD = 0.02;
const SPEAKING_HOLD_MS = 300;
/** Amostras de latência guardadas (uma a cada 2 s → 3 minutos). */
const LATENCY_SAMPLES = 90;
// Reconexão por par: caiu (ou nunca conectou) → reinicia o ICE; continua sem conexão → refaz a conexão
// inteira (de novo, no máximo a cada RESET_EVERY_MS). Quem não consegue direto passa pelo TURN.
const RESTART_AFTER_MS = 6000;
const RESET_AFTER_MS = 15000;
const RESET_EVERY_MS = 20000;
/** "Sem conexão" na tela depois de tanto tempo sem conectar. */
const TROUBLE_AFTER_MS = 5000;
/** Eventos guardados por par (para o diagnóstico). */
const PEER_LOG = 30;
// Conexão com o servidor caiu (internet oscilou, servidor reiniciando para atualizar): o áudio continua,
// porque vai direto entre os aparelhos. O app volta para a chamada quando reconecta; sem voltar a
// tempo, a chamada acaba.
const RESUME_MS = 45000;
/** Depois de voltar, quanto tempo esperar por quem ainda não voltou (antes de tirar da chamada). */
const ORPHAN_MS = 30000;
/**
 * Pings seguidos sem resposta (um a cada 2 s, cada um espera 3 s) antes de trocar a conexão com o
 * servidor: a internet pode sumir sem fechar a conexão, e o navegador leva minutos para desistir dela.
 */
const MISSED_PINGS = 3;
/** A senha do relay (TURN) vale 24 h: numa chamada mais longa, pede outra quando falta menos que isto. */
const ICE_REFRESH_BEFORE_MS = 60 * 60 * 1000;
/** A rede mudou (Wi-Fi ↔ 4G): reinicia o ICE de cada par que ainda não reiniciou nesse intervalo. */
const NET_CHANGE_WINDOW_MS = 15000;
/** Microfone emudecido pelo sistema (parou de entregar som) por mais que isto: avisa. */
const MIC_STALL_MS = 2500;
/**
 * Celular: trocar de app pausa (ou encerra) a câmera e o microfone, e o iPhone só entrega esses avisos
 * quando a página volta. Até este tempo depois de voltar, uma trilha que caiu é religada, e não tratada
 * como aparelho desconectado.
 */
const AWAY_GRACE_MS = 3000;
/** Na volta, espera o sistema devolver as trilhas pausadas antes de abrir de novo as que não voltaram. */
const REVIVE_DELAY_MS = 1200;

/** Restrições da câmera no tamanho da chamada; `pick` escolhe qual (deviceId ou facingMode). */
const cameraVideo = (pick) => ({
  ...pick,
  width: { ideal: CAMERA.width },
  height: { ideal: CAMERA.height },
  frameRate: { ideal: CAMERA.fps },
});

/**
 * Codec do vídeo que eu envio (câmera e tela). Sem escolha, o navegador usa VP8, que no Windows é
 * codificado pelo processador, uma vez para cada pessoa assistindo (a chamada é em malha): transmitir um
 * jogo em 1080p60 para 3 pessoas ocupava uns 9 dos 12 núcleos de um Ryzen 5 5600X, e o computador
 * travava. Com um codificador de H.264 na placa de vídeo (NVENC, AMF, Quick Sync, o do celular), a mesma
 * transmissão custa menos de 2 núcleos. Sem ele, fica o padrão do navegador.
 */
let videoCodec;
function hardwareVideoCodec() {
  videoCodec ??= (async () => {
    if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) return null;
    // High e Constrained Baseline 4.2 (1080p60): basta a placa saber um deles.
    for (const codec of ['avc1.64002a', 'avc1.42e02a']) {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec,
        hardwareAcceleration: 'prefer-hardware',
        width: 1920,
        height: 1080,
        framerate: 60,
        bitrate: 6_000_000,
      }).catch(() => ({}));
      if (supported) return 'video/H264';
    }
    return null;
  })();
  return videoCodec;
}

// Com o RNNoise ligado, o supressor nativo do navegador fica desligado para não processar o áudio duas vezes.
/** Chave local de cada par (não muda quando ele volta com outro id). */
let peerSeq = 0;

const audioConstraints = (deviceId, rnnoise) => ({
  deviceId: deviceId ? { exact: deviceId } : undefined,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: !rnnoise,
  autoGainControl: true,
});

export class VoiceClient {
  constructor({ rt, iceServers, onChange, onNotice }) {
    this.rt = rt;
    this.iceServers = iceServers;
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.noiseSuppression = true;
    this.rawMic = null;
    this.nsPipe = null;
    this.peers = new Map();
    this.mic = null;
    this.camera = null;
    this.screen = null;
    this.devices = { mic: '', camera: '', output: '' };
    // Vídeo sob demanda: câmera/tela de alguém só começam a chegar quando você pede (ou pelas preferências).
    this.watchPrefs = { camera: false, screen: false, dmCamera: true };
    this.state = {
      channelId: null,
      guildId: null,
      muted: false,
      deafened: false,
      screenPreset: '1080p30',
      micAvailable: true,
      error: null,
    };
    this.speaking = {};
    // Pessoas que eu silenciei só para mim (ids de usuário).
    this.localMutes = new Set();
    this.latency = [];
    this.peerNames = new Map();
    this.peerSlots = new Map();
    this.lastLoud = {};
    this.meters = new Map();
    this.unsubs = [];
    // Desligam o `keepAwake` dos AudioContext da chamada.
    this.sleepless = [];
    this.missedPings = 0;
  }

  // ---------- Ciclo de vida ----------

  async join(channelId, { muted = false, deafened = false, devices, noiseSuppression = true, watch } = {}) {
    Object.assign(this.devices, devices || {});
    Object.assign(this.watchPrefs, watch || {});
    this.noiseSuppression = noiseSuppression;
    this.state.muted = muted;
    this.state.deafened = deafened;
    const codec = hardwareVideoCodec();
    try {
      await this.acquireMic();
    } catch (e) {
      console.warn('[voz] microfone indisponível; entrando só para ouvir:', e.message);
      this.mic = null;
      this.state.micAvailable = false;
    }
    this.applyMicEnabled();
    this.videoCodec = await codec;
    this.audioCtx = new AudioContext();
    this.sleepless.push(keepAwake(this.audioCtx));

    const on = (ev, fn) => this.unsubs.push(this.rt.on(ev, fn));
    on('voice:peer-joined', (p) => {
      this.adopt(p);
      this.changed();
    });
    on('voice:peer-left', ({ peerId }) => this.removePeer(peerId));
    on('voice:peer-state', (p) => {
      this.ensurePeer(p.peerId, p);
      this.changed();
    });
    on('voice:signal', ({ from, data }) => this.handleSignal(from, data));
    // Uma chamada por conta: entrar por outro aparelho tira este da chamada.
    on('voice:kicked', ({ reason } = {}) =>
      this.cleanup(reason === 'elsewhere' ? 'Você entrou na chamada por outro aparelho' : 'Você foi removido do canal de voz'),
    );
    // Um moderador me silenciou (ou tirou o silêncio) para todos.
    on('voice:server-mute', ({ muted, by }) => {
      this.state.serverMuted = muted;
      this.applyMicEnabled();
      this.onNotice?.(muted ? `${by.displayName} silenciou você para todos neste canal.` : `${by.displayName} tirou o seu silêncio.`);
      this.changed();
    });
    on('disconnected', () => this.suspend());
    // Quando a chamada deste canal começou (volta junto se o servidor reiniciar: o contador continua).
    on('voice:channel', (d) => {
      if (d.channelId === this.state.channelId && d.since) this.callSince = d.since;
    });
    on('ready', (d) => {
      if (d?.iceServers) this.setIceServers(d.iceServers);
      this.resume();
    });
    // Rede trocada: o caminho da mídia morreu, mas a conexão só percebe em uns 10 s (veja checkPeers).
    this.onNetwork = () => {
      this.netChangedAt = Date.now();
    };
    this.netType = navigator.connection?.type;
    this.onConnection = () => {
      const type = navigator.connection?.type;
      if (type === this.netType) return;
      this.netType = type;
      this.onNetwork();
    };
    window.addEventListener('online', this.onNetwork);
    navigator.connection?.addEventListener?.('change', this.onConnection);
    // Microfone que voltou a ser conectado, depois de a chamada ter ficado sem nenhum.
    this.onDevices = () => this.findMic();
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDevices);
    // Voltou para o app (celular): religa o que o sistema pausou ou encerrou em segundo plano.
    this.onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      this.shownAt = Date.now();
      this.scheduleRevive();
    };
    document.addEventListener('visibilitychange', this.onVisibility);

    const res = await this.rt.request('voice:join', { channelId, muted, deafened });
    if (res.error) {
      this.cleanup();
      throw new Error(res.error);
    }
    if (res.iceServers) this.setIceServers(res.iceServers);
    this.selfId = this.rt.peerId;
    this.bootId = res.bootId || null;
    this.joinedAt = Date.now();
    this.callSince = res.since || null;
    this.state.channelId = res.channelId;
    this.state.guildId = res.guildId;
    this.state.dm = Boolean(res.dm);
    for (const p of res.peers) this.ensurePeer(p.peerId, p);
    // Quem já estava no canal (ou mandou sinal antes da resposta) recebe o pedido conforme as preferências.
    for (const peer of this.peers.values()) this.applyAutoWatch(peer);
    if (this.mic) this.watchLevel('me', this.mic);
    this.meterTimer = setInterval(() => this.tickSpeaking(), 120);
    this.statsTimer = setInterval(() => {
      this.collectStats();
      this.startLateSenders();
      this.checkPeers();
      this.refreshIce();
    }, 2000);
    this.changed();
  }

  leave() {
    if (this.state.channelId) this.rt.send('voice:leave');
    this.cleanup();
  }

  /** A conexão com o servidor caiu: mantém a chamada esperando a volta (até RESUME_MS). */
  suspend() {
    if (!this.state.channelId || this.suspended) return;
    this.suspended = { was: this.selfId };
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => this.cleanup('Conexão com o servidor perdida'), RESUME_MS);
    this.changed();
  }

  /**
   * Reconectou: volta para a chamada. No mesmo servidor, o lugar guardado é retomado; num servidor que
   * reiniciou, cada um volta por conta própria e as conexões de mídia são reaproveitadas pelo id antigo.
   */
  async resume() {
    const pending = this.suspended;
    if (!pending || !this.state.channelId) return;
    const res = await this.rt.request('voice:join', {
      channelId: this.state.channelId,
      muted: this.state.muted,
      deafened: this.state.deafened,
      resume: {
        was: pending.was,
        since: this.joinedAt,
        callSince: this.callSince,
        video: Boolean(this.camera),
        screen: Boolean(this.screen),
        cameraStreamId: this.camera?.id || null,
        screenStreamId: this.screen?.id || null,
      },
    });
    if (this.suspended !== pending) return;
    // Caiu de novo enquanto pedia: espera a próxima reconexão.
    if (res.error === 'Sem conexão com o servidor' || res.error === 'Conexão perdida' || res.error === 'Tempo esgotado') return;
    if (res.error) return this.cleanup(res.error);
    clearTimeout(this.resumeTimer);
    this.suspended = null;
    if (res.iceServers) this.setIceServers(res.iceServers);
    this.selfId = this.rt.peerId;
    const sameServer = Boolean(res.bootId) && res.bootId === this.bootId;
    this.bootId = res.bootId || null;
    if (sameServer && res.resumed === 'new') {
      // Demorou demais e o servidor já tinha tirado você: os outros fecharam a conexão, então refaz todas.
      for (const id of [...this.peers.keys()]) this.removePeer(id, false);
      for (const p of res.peers) this.ensurePeer(p.peerId, p);
      for (const peer of this.peers.values()) this.applyAutoWatch(peer);
    } else {
      const back = new Set();
      for (const p of res.peers) back.add(this.adopt(p).id);
      // Quem ainda não voltou (servidor reiniciado) fica até ORPHAN_MS.
      const now = Date.now();
      for (const peer of this.peers.values()) if (!back.has(peer.id)) peer.orphanSince = now;
      for (const peer of this.peers.values()) peer.polite = this.selfId < peer.id;
    }
    this.changed();
  }

  /** Senhas novas do relay (TURN): valem para as conexões novas e para as próximas reconexões das atuais. */
  setIceServers(list) {
    if (!Array.isArray(list) || !list.length) return;
    this.iceServers = list;
    // O usuário da senha começa pelo horário (em segundos) em que ela vence.
    const ends = list.map((s) => /^(\d+):/.exec(s.username || '')?.[1]).filter(Boolean);
    this.iceExpiresAt = ends.length ? Math.min(...ends.map(Number)) * 1000 : null;
    for (const peer of this.peers.values()) {
      if (peer.pc.signalingState === 'closed') continue;
      try {
        peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers: list });
      } catch (e) {
        console.warn('[voz] senha do relay', e);
      }
    }
  }

  /** Chamada chegando às 24 h da senha do relay: pede uma nova (no máximo uma vez por minuto). */
  async refreshIce() {
    const now = Date.now();
    if (!this.iceExpiresAt || now < this.iceExpiresAt - ICE_REFRESH_BEFORE_MS || now - (this.iceRefreshAt || 0) < 60000) return;
    this.iceRefreshAt = now;
    const res = await this.rt.request('turn:refresh');
    if (res?.iceServers) this.setIceServers(res.iceServers);
  }

  /** Alguém na chamada (entrando ou voltando com outro id, `was`): reaproveita a conexão de mídia que já existe. */
  adopt(info) {
    if (info.was && info.was !== info.peerId && this.peers.has(info.was) && !this.peers.has(info.peerId)) {
      this.rekey(info.was, info.peerId);
    }
    const peer = this.ensurePeer(info.peerId, info);
    peer.orphanSince = null;
    return peer;
  }

  /** A mesma pessoa com um id novo (reconectou): troca a chave sem mexer na conexão. */
  rekey(oldId, newId) {
    const peer = this.peers.get(oldId);
    this.peers.delete(oldId);
    peer.id = newId;
    peer.info.peerId = newId;
    peer.polite = (this.selfId || this.rt.peerId || '') < newId;
    this.peers.set(newId, peer);
    for (const [key, m] of [...this.meters]) {
      if (m.owner !== oldId) continue;
      this.meters.delete(key);
      m.owner = newId;
      this.meters.set(`${newId}:${m.stream.id}`, m);
    }
    for (const map of [this.speaking, this.lastLoud]) {
      if (oldId in map) {
        map[newId] = map[oldId];
        delete map[oldId];
      }
    }
    for (const map of [this.peerNames, this.peerSlots]) {
      if (map.has(oldId)) {
        map.set(newId, map.get(oldId));
        map.delete(oldId);
      }
    }
    this.peerLog(peer, 'voltou depois de reconectar ao servidor');
  }

  cleanup(reason = null) {
    clearTimeout(this.resumeTimer);
    clearTimeout(this.micMuteTimer);
    this.suspended = null;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    window.removeEventListener('online', this.onNetwork);
    navigator.connection?.removeEventListener?.('change', this.onConnection);
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDevices);
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearTimeout(this.reviveTimer);
    if (this.unblock) {
      window.removeEventListener('click', this.unblock, true);
      window.removeEventListener('keydown', this.unblock, true);
      this.unblock = null;
    }
    this.sleepless.forEach((stop) => stop());
    this.sleepless = [];
    for (const id of [...this.peers.keys()]) this.removePeer(id, false);
    for (const s of [this.rawMic, this.mic, this.camera, this.screen]) s?.getTracks().forEach((t) => t.stop());
    this.screenAudio?.stop();
    this.screenAudio = null;
    this.nsPipe?.close();
    this.nsPipe = null;
    this.rawMic = this.mic = this.camera = this.screen = null;
    clearInterval(this.meterTimer);
    clearInterval(this.statsTimer);
    this.meters.clear();
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.boostCtx?.close().catch(() => {});
    this.boostCtx = null;
    this.state.channelId = null;
    this.state.guildId = null;
    this.state.error = reason;
    this.speaking = {};
    this.changed();
  }

  // ---------- Pares ----------

  ensurePeer(peerId, info) {
    let peer = this.peers.get(peerId);
    if (peer) {
      if (info) {
        const wasLive = Boolean(peer.info.screen);
        Object.assign(peer.info, info);
        // A transmissão acabou: da próxima vez é preciso pedir de novo (a não ser que assista automaticamente).
        if (wasLive && !peer.info.screen && peer.watching.screen && !this.watchPrefs.screen) this.setWatching(peer, { screen: false });
        this.applyAudio(peer);
      }
      return peer;
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    peer = {
      id: peerId,
      // Não muda quando a pessoa volta com outro id (sons de entrada/saída, listas na tela).
      key: `p${++peerSeq}`,
      info: { peerId, ...(info || {}) },
      pc,
      // Um lado "educado" cede em colisões de oferta; o critério só precisa ser determinístico.
      polite: (this.selfId || this.rt.peerId || '') < peerId,
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      streams: new Map(),
      audioEls: new Map(),
      senders: {},
      // O que esta pessoa pediu para receber de mim / o que eu pedi para receber dela.
      wants: { camera: false, screen: false },
      watching: { camera: false, screen: false },
      volume: 1,
      streamVolume: 1,
      boosts: new Map(), // streamId -> { source, gain }: volume acima de 100% (Web Audio)
      streamMuted: false,
      connectionState: 'new',
      // Desde quando está sem conexão (nunca conectou: desde a criação).
      badSince: Date.now(),
      lastRestart: 0,
      lastReset: 0,
      resets: 0,
      log: [],
    };
    this.peers.set(peerId, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(peer.id, { description: pc.localDescription });
      } catch (e) {
        console.warn('[voz] negotiationneeded', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(peer.id, { candidate });
    };
    pc.onconnectionstatechange = () => {
      peer.connectionState = pc.connectionState;
      this.peerLog(peer, `conexão: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        // Já entrou de fato na chamada (alguém ouve você): daqui para frente, uma pessoa instável não é você.
        this.linked = true;
        peer.badSince = null;
        this.sendWant(peer);
      } else if (!peer.badSince) peer.badSince = Date.now();
      // Só um lado reinicia o ICE: os dois ao mesmo tempo colidem (veja checkPeers).
      if (pc.connectionState === 'failed') this.restartIce(peer);
      this.changed();
    };
    pc.oniceconnectionstatechange = () => this.peerLog(peer, `ice: ${pc.iceConnectionState}`);
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      peer.streams.set(stream.id, stream);
      if (track.kind === 'audio') {
        this.playAudio(peer, stream);
        this.watchLevel(peer.id, stream);
      }
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) {
          peer.streams.delete(stream.id);
          this.stopAudio(peer, stream.id);
        }
        this.changed();
      };
      track.onunmute = () => this.changed();
      this.changed();
    };

    // Na primeira negociação só o lado não educado oferece. Se os dois oferecem juntos, o educado desfaz a
    // oferta no meio da coleta ICE e o Chrome às vezes nunca mais gera candidatos ("Conectando…" para
    // sempre). O educado só anexa a voz depois de responder (startSenders).
    peer.createdAt = Date.now();
    if (peer.polite) peer.lateSenders = true;
    else this.startSenders(peer);
    if (this.state.channelId) this.applyAutoWatch(peer);
    return peer;
  }

  /** Anexa a voz (sempre vai; câmera e tela só depois que a pessoa pedir, em syncVideo). */
  startSenders(peer) {
    peer.lateSenders = false;
    const { pc } = peer;
    if (pc.signalingState === 'closed') return;
    if (this.mic) {
      if (!peer.senders.mic) peer.senders.mic = pc.addTrack(this.mic.getAudioTracks()[0], this.mic);
    } else if (!peer.polite && !pc.getTransceivers().length) {
      // Sem microfone: ainda assim inicia a negociação para ouvir a outra pessoa.
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    this.syncVideo(peer);
  }

  /** Rede de segurança: se a oferta inicial não chegar (versão antiga do outro lado, por exemplo), anexa assim mesmo. */
  startLateSenders() {
    for (const peer of this.peers.values()) {
      if (peer.lateSenders && Date.now() - peer.createdAt > 3000) this.startSenders(peer);
    }
  }

  /** Pede câmera/tela de um par recém-chegado conforme as preferências (chamada direta: câmera). */
  applyAutoWatch(peer) {
    if (peer.autoApplied) return;
    peer.autoApplied = true;
    const camera = this.watchPrefs.camera || (this.state.dm && this.watchPrefs.dmCamera !== false);
    const screen = this.watchPrefs.screen;
    if (camera || screen) this.setWatching(peer, { camera: camera || peer.watching.camera, screen: screen || peer.watching.screen });
  }

  /** Receptor: liga/desliga o recebimento da câmera ou da tela de um par e avisa o par. */
  setWatching(peer, patch) {
    const next = { ...peer.watching, ...patch };
    if (next.camera === peer.watching.camera && next.screen === peer.watching.screen) return;
    peer.watching = next;
    peer.wantDirty = true;
    this.sendWant(peer);
  }

  /**
   * O pedido só sai com a conexão de voz já estabelecida: mandado antes, faz os dois lados oferecerem ao
   * mesmo tempo na negociação inicial (o Chrome às vezes não se recupera dessa colisão).
   */
  sendWant(peer) {
    if (!peer.wantDirty || peer.pc.connectionState !== 'connected') return;
    peer.wantDirty = false;
    this.signal(peer.id, { want: peer.watching });
  }

  watch(peerId, kind, on) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.setWatching(peer, { [kind]: on });
    this.changed();
  }

  /** Emissor: deixa as trilhas de vídeo de um par de acordo com o que está ligado e o que ele pediu. */
  syncVideo(peer) {
    const { pc, senders, wants } = peer;
    if (pc.signalingState === 'closed' || peer.lateSenders) return;
    const camTrack = this.camera?.getVideoTracks()[0];
    const before = [Boolean(senders.camera), Boolean(senders.screenVideo)];
    if (camTrack && wants.camera && !senders.camera) {
      senders.camera = pc.addTrack(camTrack, this.camera);
      this.preferVideoCodec(pc, senders.camera);
    } else if ((!camTrack || !wants.camera) && senders.camera) {
      pc.removeTrack(senders.camera);
      senders.camera = null;
    }
    if (this.screen && wants.screen && !senders.screenVideo) this.addScreenTracks(peer);
    else if ((!this.screen || !wants.screen) && senders.screenVideo) {
      for (const k of ['screenVideo', 'screenAudio']) {
        if (senders[k]) pc.removeTrack(senders[k]);
        senders[k] = null;
      }
    }
    // Mudou quantos assistem: o teto de envio é redividido entre todos.
    if (before[0] !== Boolean(senders.camera) || before[1] !== Boolean(senders.screenVideo)) this.retuneVideo();
  }

  /** Recalcula o envio de vídeo para todos (o teto de envio é dividido entre quem assiste). */
  retuneVideo() {
    for (const peer of this.peers.values()) this.tuneSenders(peer);
  }

  removePeer(peerId, notify = true) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    for (const id of [...peer.audioEls.keys()]) this.stopAudio(peer, id);
    for (const key of this.meters.keys()) if (key.startsWith(`${peerId}:`)) this.meters.delete(key);
    delete this.speaking[peerId];
    this.peers.delete(peerId);
    if (notify) this.changed();
  }

  signal(to, data) {
    this.rt.send('voice:signal', { to, data });
  }

  peerLog(peer, text) {
    peer.log.push(`${new Date().toLocaleTimeString('pt-BR')} ${text}`);
    if (peer.log.length > PEER_LOG) peer.log.shift();
  }

  /** Reinicia o ICE (só o lado não educado; o educado responde à oferta). `force`: a rede mudou. */
  restartIce(peer, force = false) {
    if (peer.polite || peer.pc.signalingState === 'closed' || (!force && Date.now() - peer.lastRestart < RESTART_AFTER_MS)) return;
    peer.lastRestart = Date.now();
    this.peerLog(peer, 'reiniciando o ICE');
    peer.pc.restartIce();
  }

  /**
   * Refaz a conexão com um par do zero (nova RTCPeerConnection), mantendo volume, mudo e o que eu
   * estava assistindo. `fromRemote`: o outro lado pediu (não avisa de volta).
   */
  resetPeer(peerId, fromRemote = false) {
    const old = this.peers.get(peerId);
    if (!old) return;
    if (!fromRemote) this.signal(peerId, { reset: true });
    const keep = {
      key: old.key,
      orphanSince: old.orphanSince,
      info: old.info,
      volume: old.volume,
      streamVolume: old.streamVolume,
      streamMuted: old.streamMuted,
      watching: old.watching,
      resets: old.resets + 1,
      log: old.log,
    };
    this.removePeer(peerId, false);
    const peer = this.ensurePeer(peerId, keep.info);
    Object.assign(peer, {
      key: keep.key,
      // Esperando voltar depois de o servidor reiniciar: refazer a conexão não zera a espera.
      orphanSince: keep.orphanSince,
      volume: keep.volume,
      streamVolume: keep.streamVolume,
      streamMuted: keep.streamMuted,
      resets: keep.resets,
      log: keep.log,
      lastReset: Date.now(),
      autoApplied: true,
    });
    if (keep.watching.camera || keep.watching.screen) {
      peer.watching = { ...keep.watching };
      peer.wantDirty = true;
    }
    this.applyAudio(peer);
    this.peerLog(peer, fromRemote ? 'conexão refeita (pedido do outro lado)' : 'conexão refeita');
    this.changed();
  }

  /** A cada 2 s: quem está sem conexão há um tempo tem o ICE reiniciado e, se não voltar, a conexão refeita. */
  checkPeers() {
    // Sem servidor não há como sinalizar (reiniciar o ICE ou refazer): só espera.
    if (this.suspended) return;
    const now = Date.now();
    // A rede mudou há pouco (e o servidor já responde): cada par reinicia o ICE uma vez, sem esperar.
    const netChange = this.netChangedAt && now - this.netChangedAt < NET_CHANGE_WINDOW_MS ? this.netChangedAt : 0;
    for (const peer of [...this.peers.values()]) {
      if (peer.orphanSince && now - peer.orphanSince > ORPHAN_MS) {
        this.peerLog(peer, 'não voltou depois de o servidor reiniciar');
        this.removePeer(peer.id);
        continue;
      }
      if (netChange && (peer.netRestartAt || 0) < netChange) {
        peer.netRestartAt = now;
        this.peerLog(peer, 'a rede mudou: reiniciando o ICE');
        // Quem reinicia é o lado não educado; o educado pede.
        if (peer.polite) this.signal(peer.id, { restartRequest: true });
        else this.restartIce(peer, true);
        continue;
      }
      if (!peer.badSince || peer.pc.connectionState === 'connected') continue;
      const bad = now - peer.badSince;
      if (bad > RESET_AFTER_MS && now - Math.max(peer.lastReset, peer.createdAt) > RESET_EVERY_MS) {
        if (peer.polite) {
          // Quem refaz é o lado não educado; este só pede (e espera a vez de novo).
          peer.lastReset = now;
          this.peerLog(peer, 'pedindo para refazer a conexão');
          this.signal(peer.id, { resetRequest: true });
        } else this.resetPeer(peer.id);
      } else if (bad > RESTART_AFTER_MS && peer.pc.connectionState !== 'new') this.restartIce(peer);
    }
  }

  handleSignal(from, data) {
    // O outro lado refez a conexão comigo: refaço a minha também (antes de qualquer sinal novo dele).
    if (data.reset) return this.resetPeer(from, true);
    const peer = this.ensurePeer(from);
    if (data.resetRequest) {
      if (!peer.polite) this.resetPeer(from);
      return;
    }
    // A rede do outro lado mudou: reinicio o ICE na hora.
    if (data.restartRequest) {
      if (!peer.polite) this.restartIce(peer, true);
      return;
    }
    // Processa em ordem: a negociação não pode intercalar descrições.
    peer.queue = peer.queue.then(() => this.processSignal(peer, data)).catch((e) => console.warn('[voz] sinal', e));
  }

  async processSignal(peer, { description, candidate, want }) {
    const { pc } = peer;
    if (want) {
      peer.wants = { camera: Boolean(want.camera), screen: Boolean(want.screen) };
      this.syncVideo(peer);
      this.changed();
    } else if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.signal(peer.id, { description: pc.localDescription });
        if (peer.lateSenders) this.startSenders(peer);
      }
      this.tuneSenders(peer);
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        if (!peer.ignoreOffer) console.warn('[voz] ICE', e);
      }
    }
  }

  /**
   * Bitrate/fps/resolução do vídeo que vai para este par: a qualidade escolhida, dividida entre quem
   * assiste e reduzida quando a conexão passa pelo relay ou o envio é codificado pelo processador
   * (veja videoBudget.js).
   */
  tuneSenders(peer) {
    const viewers = (key) => [...this.peers.values()].filter((p) => p.senders[key]).length;
    const targets = [
      [peer.senders.camera, CAMERA, 'camera', 'camera'],
      [peer.senders.screenVideo, SCREEN_PRESETS[this.state.screenPreset], 'screen', 'screenVideo'],
    ];
    for (const [sender, preset, kind, key] of targets) {
      if (!sender?.track) continue;
      const target = videoTarget({
        kind,
        preset,
        viewers: viewers(key),
        relay: peer.stats?.route === 'relay',
        software: kind === 'screen' && Boolean(peer.softwareScreen),
      });
      const apply = (params) => {
        Object.assign(params.encodings[0], {
          maxBitrate: target.bitrate,
          maxFramerate: target.fps,
          scaleResolutionDownBy: target.scale,
          priority: kind === 'screen' ? 'high' : 'medium',
          networkPriority: kind === 'screen' ? 'high' : 'medium',
        });
        return params;
      };
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      apply(params);
      if (kind === 'screen') params.degradationPreference = preset.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
      sender.setParameters(params).catch(() => {
        // Navegador sem degradationPreference: de novo sem ela (com parâmetros novos, os de antes venceram).
        const again = sender.getParameters();
        if (!again.encodings?.length) return;
        sender.setParameters(apply(again)).catch((e) => console.warn('[voz] setParameters', e));
      });
    }
  }

  // ---------- Áudio remoto ----------

  playAudio(peer, stream) {
    if (peer.audioEls.has(stream.id)) return;
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = stream;
    if (this.devices.output && el.setSinkId) el.setSinkId(this.devices.output).catch(() => {});
    this.play(el);
    peer.audioEls.set(stream.id, el);
    this.applyAudio(peer);
  }

  /** Toca um áudio da chamada. Se o navegador bloquear (a página ainda não recebeu um toque), pede um. */
  play(el) {
    el.play().catch((e) => {
      if (e?.name === 'NotAllowedError') this.audioBlocked();
    });
  }

  /** O navegador bloqueou o som: avisa e tenta de novo no primeiro clique ou tecla. */
  audioBlocked() {
    if (this.unblock || !this.state.channelId) return;
    this.state.audioBlocked = true;
    this.onNotice?.('O navegador bloqueou o som da chamada: toque em qualquer lugar da tela para ouvir.');
    this.unblock = () => {
      window.removeEventListener('click', this.unblock, true);
      window.removeEventListener('keydown', this.unblock, true);
      this.unblock = null;
      this.state.audioBlocked = false;
      for (const peer of this.peers.values()) for (const el of peer.audioEls.values()) if (el.paused) this.play(el);
      this.audioCtx?.resume().catch(() => {});
      this.boostCtx?.resume().catch(() => {});
      this.changed();
    };
    window.addEventListener('click', this.unblock, true);
    window.addEventListener('keydown', this.unblock, true);
    this.changed();
  }

  /**
   * Aplica ensurdecer, volume da voz e volume/mudo da transmissão aos <audio> do par. Até 100% o
   * próprio <audio> resolve; acima disso o som passa por um ganho do Web Audio (o <audio> fica mudo,
   * mas tocando: sem ele o Chrome não entrega o áudio da chamada ao Web Audio).
   */
  applyAudio(peer) {
    // A voz some se eu silenciei a pessoa para mim ou se um moderador a silenciou para todos.
    const voiceOff = this.localMutes.has(peer.info.user?.id) || Boolean(peer.info.serverMuted);
    for (const [streamId, el] of peer.audioEls) {
      const isScreen = streamId === peer.info.screenStreamId;
      const off = this.state.deafened || (isScreen ? peer.streamMuted : voiceOff);
      const volume = isScreen ? peer.streamVolume : peer.volume;
      const boost = volume > 1 ? this.boost(peer, streamId, el) : null;
      if (boost) {
        el.muted = true;
        el.volume = 1;
        boost.gain.gain.value = off ? 0 : volume;
      } else {
        this.unboost(peer, streamId);
        el.muted = off;
        el.volume = Math.min(1, volume);
      }
    }
  }

  /** Ganho acima de 100% para um áudio do par (criado na primeira vez). */
  boost(peer, streamId, el) {
    const have = peer.boosts.get(streamId);
    if (have) return have;
    try {
      if (!this.boostCtx) {
        this.boostCtx = new AudioContext();
        // Suspenso, quem está acima de 100% fica mudo (o <audio> dele está sem som).
        this.sleepless.push(keepAwake(this.boostCtx));
        if (this.devices.output && this.boostCtx.setSinkId) this.boostCtx.setSinkId(this.devices.output).catch(() => {});
      }
      this.boostCtx.resume?.().catch(() => {});
      const source = this.boostCtx.createMediaStreamSource(el.srcObject);
      const gain = this.boostCtx.createGain();
      // Limitador: amplificado, um grito não estoura (distorce) a saída.
      const limiter = this.boostCtx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      source.connect(gain).connect(limiter).connect(this.boostCtx.destination);
      const b = { source, gain, limiter };
      peer.boosts.set(streamId, b);
      return b;
    } catch (e) {
      console.warn('[voz] volume acima de 100%', e);
      return null;
    }
  }

  unboost(peer, streamId) {
    const b = peer.boosts.get(streamId);
    if (!b) return;
    b.source.disconnect();
    b.gain.disconnect();
    b.limiter.disconnect();
    peer.boosts.delete(streamId);
  }

  stopAudio(peer, streamId) {
    const el = peer.audioEls.get(streamId);
    if (!el) return;
    this.unboost(peer, streamId);
    el.pause();
    el.srcObject = null;
    peer.audioEls.delete(streamId);
  }

  /** Quem eu silenciei só para mim (ids de usuário). */
  setLocalMutes(ids) {
    this.localMutes = new Set(ids);
    this.peers.forEach((p) => this.applyAudio(p));
    // Antes de entrar no canal não há o que avisar (um aviso sem canal encerraria a chamada).
    if (this.state.channelId) this.changed();
  }

  setPeerVolume(peerId, volume) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.volume = volume;
    this.applyAudio(peer);
    this.changed();
  }

  /** Volume/mudo só do áudio da tela compartilhada por um par (não afeta a voz). */
  setStreamAudio(peerId, { volume, muted }) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (volume !== undefined) peer.streamVolume = volume;
    if (muted !== undefined) peer.streamMuted = muted;
    this.applyAudio(peer);
    this.changed();
  }

  /** Quem transmite: silencia/reativa o áudio da tela que está sendo enviado. */
  setScreenAudioMuted(muted) {
    this.state.screenAudioMuted = muted;
    this.screen?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.changed();
  }

  // ---------- Indicador de fala ----------

  watchLevel(owner, stream) {
    if (!this.audioCtx || !stream.getAudioTracks().length) return;
    const key = `${owner}:${stream.id}`;
    if (this.meters.has(key)) return;
    const source = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.meters.set(key, { owner, stream, analyser, buf: new Float32Array(analyser.fftSize) });
  }

  tickSpeaking() {
    const now = performance.now();
    const loud = {};
    for (const m of this.meters.values()) {
      // Áudio da tela compartilhada não conta como "falando".
      const peer = this.peers.get(m.owner);
      if (peer && m.stream.id === peer.info.screenStreamId) continue;
      m.analyser.getFloatTimeDomainData(m.buf);
      let sum = 0;
      for (const v of m.buf) sum += v * v;
      if (Math.sqrt(sum / m.buf.length) > SPEAKING_THRESHOLD) loud[m.owner] = true;
    }
    const next = {};
    for (const owner of new Set([...Object.keys(loud), ...Object.keys(this.lastLoud)])) {
      if (loud[owner]) this.lastLoud[owner] = now;
      const muted = owner === 'me' ? this.state.muted || this.state.deafened : this.peers.get(owner)?.info.muted;
      if (!muted && now - (this.lastLoud[owner] || 0) < SPEAKING_HOLD_MS) next[owner] = true;
    }
    const changed =
      Object.keys(next).length !== Object.keys(this.speaking).length ||
      Object.keys(next).some((k) => !this.speaking[k]);
    if (changed) {
      this.speaking = next;
      this.changed();
    }
  }

  // ---------- Controles locais ----------

  applyMicEnabled() {
    const enabled = !this.state.muted && !this.state.deafened && !this.state.serverMuted;
    for (const s of [this.rawMic, this.mic]) s?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  /** Abre o microfone e, se ligado, passa pelo RNNoise. Define rawMic (dispositivo) e mic (o que é enviado). */
  async acquireMic() {
    // Fora de contexto seguro (HTTP sem ser localhost) o navegador nem expõe mediaDevices.
    if (!navigator.mediaDevices) throw new Error('mediaDevices indisponível (página sem HTTPS)');
    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(this.devices.mic, this.noiseSuppression), video: false });
    } catch (e) {
      // O microfone escolhido nas configurações não está conectado: usa o padrão do sistema.
      if (!this.devices.mic || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e;
      this.devices.mic = '';
      raw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints('', this.noiseSuppression), video: false });
      this.onNotice?.('O microfone escolhido nas configurações não está conectado: usando o padrão do sistema.');
    }
    this.watchMicTrack(raw.getAudioTracks()[0]);
    let pipe = null;
    if (this.noiseSuppression) {
      try {
        pipe = await suppressNoise(raw);
      } catch (e) {
        console.warn('[voz] RNNoise indisponível; usando o supressor do navegador:', e);
        this.onNotice?.('Supressão de ruído por IA indisponível neste dispositivo — usando a do navegador.');
      }
    }
    this.rawMic = raw;
    this.nsPipe = pipe;
    this.mic = pipe ? pipe.stream : raw;
    this.applyMicEnabled();
  }

  /** Microfone que cai (desconectado, bloqueado) ou que o sistema parou de entregar no meio da chamada. */
  watchMicTrack(track) {
    if (!track) return;
    const current = () => track === this.rawMic?.getAudioTracks()[0];
    track.onended = () => {
      if (!current()) return;
      // Em segundo plano o sistema encerra o microfone: na volta ele é aberto de novo, o mesmo de antes.
      if (this.away()) this.scheduleRevive();
      else this.recoverMic();
    };
    track.onmute = () => {
      clearTimeout(this.micMuteTimer);
      // Trocas de aparelho emudecem por um instante: só avisa se continuar.
      this.micMuteTimer = setTimeout(() => {
        if (!current() || !this.state.channelId) return;
        if (this.away()) return this.scheduleRevive();
        this.state.micStalled = true;
        this.onNotice?.('Seu microfone parou de mandar som. Confira se outro programa ou o sistema bloqueou o acesso a ele.');
        this.changed();
      }, MIC_STALL_MS);
    };
    track.onunmute = () => {
      clearTimeout(this.micMuteTimer);
      if (!this.state.micStalled) return;
      this.state.micStalled = false;
      this.changed();
    };
  }

  /** O microfone sumiu no meio da chamada: continua com o padrão do sistema; sem nenhum, só ouvindo. */
  async recoverMic() {
    if (!this.state.channelId || this.recoveringMic) return;
    this.recoveringMic = true;
    clearTimeout(this.micMuteTimer);
    this.state.micStalled = false;
    this.devices.mic = '';
    try {
      await this.replaceMic();
      this.onNotice?.('O microfone foi desconectado: a chamada continua com o microfone padrão do sistema.');
    } catch (e) {
      console.warn('[voz] nenhum microfone', e);
      this.dropMic();
      this.onNotice?.('O microfone foi desconectado e não há outro: você continua na chamada só ouvindo.');
    } finally {
      this.recoveringMic = false;
    }
    this.changed();
  }

  /** Sem microfone nenhum: os outros deixam de receber a minha voz, e eu continuo ouvindo. */
  dropMic() {
    for (const peer of this.peers.values()) peer.senders.mic?.replaceTrack(null).catch(() => {});
    for (const s of [this.rawMic, this.mic]) s?.getTracks().forEach((t) => t.stop());
    this.nsPipe?.close();
    this.nsPipe = null;
    this.rawMic = this.mic = null;
    for (const k of [...this.meters.keys()]) if (k.startsWith('me:')) this.meters.delete(k);
    this.state.micAvailable = false;
    this.lostMic = true;
  }

  /** Um aparelho foi conectado depois de a chamada perder o microfone: volta a mandar a voz. */
  async findMic() {
    if (!this.lostMic || this.mic || this.recoveringMic || !this.state.channelId) return;
    this.recoveringMic = true;
    try {
      await this.replaceMic();
      this.lostMic = false;
      this.state.micAvailable = true;
      this.onNotice?.('Microfone encontrado: os outros voltaram a ouvir você.');
      this.changed();
    } catch {
      /* ainda sem microfone */
    } finally {
      this.recoveringMic = false;
    }
  }

  /** Troca o microfone em uso (dispositivo ou supressão) sem renegociar a chamada. */
  async replaceMic() {
    const old = { raw: this.rawMic, mic: this.mic, pipe: this.nsPipe };
    await this.acquireMic();
    const track = this.mic.getAudioTracks()[0];
    for (const peer of this.peers.values()) {
      if (peer.senders.mic) await peer.senders.mic.replaceTrack(track);
      else if (!peer.lateSenders) peer.senders.mic = peer.pc.addTrack(track, this.mic);
    }
    for (const s of [old.raw, old.mic]) s?.getTracks().forEach((t) => t.stop());
    old.pipe?.close();
    for (const k of [...this.meters.keys()]) if (k.startsWith('me:')) this.meters.delete(k);
    this.watchLevel('me', this.mic);
    this.changed();
  }

  async setNoiseSuppression(on) {
    this.noiseSuppression = on;
    if (this.mic) await this.replaceMic();
  }

  pushState(patch) {
    if (this.state.channelId) this.rt.send('voice:state', patch);
  }

  setMuted(muted) {
    this.state.muted = muted;
    if (!muted && this.state.deafened) this.setDeafened(false);
    this.applyMicEnabled();
    this.pushState({ muted, deafened: this.state.deafened });
    this.changed();
  }

  setDeafened(deafened) {
    this.state.deafened = deafened;
    this.peers.forEach((p) => this.applyAudio(p));
    this.applyMicEnabled();
    this.pushState({ muted: this.state.muted, deafened });
    this.changed();
  }

  async setCamera(on) {
    if (on && !this.camera) {
      const pick = { deviceId: this.devices.camera ? { exact: this.devices.camera } : undefined };
      this.camera = await navigator.mediaDevices.getUserMedia({ video: cameraVideo(pick) });
      this.cameraPick = pick;
      const track = this.camera.getVideoTracks()[0];
      // Termina sozinha quando o Windows entrega a webcam a outro programa (ou ela é desconectada).
      track.onended = () => {
        // Celular em segundo plano: o sistema tirou a câmera do app, e ela volta junto com ele.
        if (this.away()) return this.scheduleRevive();
        this.onNotice?.(
          'Sua câmera foi desligada: outro programa (ou outra janela do PadoSpeak) passou a usá-la, ou ela foi desconectada.',
        );
        this.setCamera(false);
      };
      // Estado antes das trilhas: quem recebe já sabe que este stream é a câmera.
      this.pushState({ video: true, cameraStreamId: this.camera.id });
      for (const peer of this.peers.values()) this.syncVideo(peer);
    } else if (!on && this.camera) {
      this.state.cameraFacing = 'user';
      for (const peer of this.peers.values()) {
        if (peer.senders.camera) peer.pc.removeTrack(peer.senders.camera);
        peer.senders.camera = null;
      }
      this.camera.getTracks().forEach((t) => t.stop());
      this.camera = null;
      this.pushState({ video: false, cameraStreamId: null });
    }
    this.changed();
  }

  /**
   * Celular/tablet: troca entre a câmera frontal e a traseira sem sair da chamada. A câmera atual fecha
   * antes de a outra abrir: o iPhone (e vários Android) não abre duas ao mesmo tempo, encerra a primeira
   * por conta própria (e isso desligava a câmera) ou derruba a página inteira.
   */
  async flipCamera() {
    if (!this.camera || this.flipping) return;
    this.flipping = true;
    const facing = this.state.cameraFacing === 'environment' ? 'user' : 'environment';
    const old = this.camera.getVideoTracks()[0];
    const onended = old?.onended || null;
    const open = (mode) => navigator.mediaDevices.getUserMedia({ video: cameraVideo({ facingMode: { ideal: mode } }) });
    if (old) {
      old.onended = null;
      old.stop();
      this.camera.removeTrack(old);
    }
    try {
      let next;
      let now = facing;
      try {
        next = await open(facing);
      } catch (e) {
        // A outra câmera não abriu: volta para a que estava, e só desliga se nem ela abrir.
        now = this.state.cameraFacing;
        try {
          next = await open(now);
        } catch {
          throw e;
        }
      }
      if (!this.camera) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = next.getVideoTracks()[0];
      track.onended = onended;
      // Mesmo stream (quem recebe continua reconhecendo a câmera), só a trilha muda.
      this.camera.addTrack(track);
      for (const peer of this.peers.values()) if (peer.senders.camera) await peer.senders.camera.replaceTrack(track);
      this.state.cameraFacing = now;
      this.cameraPick = { facingMode: { ideal: now } };
      if (now !== facing) this.onNotice?.('Não deu para abrir a outra câmera deste aparelho.');
    } catch (e) {
      if (this.camera) await this.setCamera(false);
      throw e;
    } finally {
      this.flipping = false;
      this.reviveMic();
      this.changed();
    }
  }

  /**
   * No iPhone, abrir a câmera (ou trocar de app) às vezes cala ou encerra o microfone: abre ele de novo,
   * o mesmo de antes; se não abrir, segue como microfone desconectado.
   */
  reviveMic() {
    if (!this.state.channelId || this.recoveringMic) return;
    const t = this.rawMic?.getAudioTracks()[0];
    if (!t) return this.findMic();
    if (t.readyState !== 'ended' && !t.muted) return;
    clearTimeout(this.micMuteTimer);
    this.recoveringMic = true;
    this.replaceMic()
      .then(() => {
        this.state.micStalled = false;
        this.recoveringMic = false;
      })
      .catch(() => {
        this.recoveringMic = false;
        this.recoverMic();
      });
  }

  /** A página está em segundo plano, ou acabou de voltar dele (veja AWAY_GRACE_MS). */
  away() {
    return document.visibilityState !== 'visible' || Date.now() - (this.shownAt || 0) < AWAY_GRACE_MS;
  }

  /** Religa câmera, microfone e o som da chamada um pouco depois de a página voltar a aparecer. */
  scheduleRevive() {
    if (document.visibilityState !== 'visible' || !this.state.channelId) return;
    clearTimeout(this.reviveTimer);
    this.reviveTimer = setTimeout(() => {
      if (!this.state.channelId) return;
      this.reviveMic();
      this.reviveCamera();
      // O iPhone pausa os <audio> da chamada em segundo plano.
      for (const peer of this.peers.values()) for (const el of peer.audioEls.values()) if (el.paused) this.play(el);
    }, REVIVE_DELAY_MS);
  }

  /**
   * A câmera parou enquanto o app estava em segundo plano (o celular não deixa filmar fora da tela):
   * abre de novo a mesma, no mesmo stream, como na troca de câmera.
   */
  async reviveCamera() {
    const old = this.camera?.getVideoTracks()[0];
    if (!this.camera || this.flipping || (old?.readyState === 'live' && !old.muted)) return;
    this.flipping = true;
    const onended = old?.onended || null;
    if (old) {
      old.onended = null;
      old.stop();
      this.camera.removeTrack(old);
    }
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: cameraVideo(this.cameraPick || {}) });
      if (!this.camera) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = next.getVideoTracks()[0];
      track.onended = onended;
      this.camera.addTrack(track);
      for (const peer of this.peers.values()) if (peer.senders.camera) await peer.senders.camera.replaceTrack(track);
    } catch (e) {
      console.warn('[voz] a câmera não voltou', e);
      if (this.camera) await this.setCamera(false);
      this.onNotice?.('Não deu para religar a sua câmera na volta para o app: ligue de novo pelo botão.');
    } finally {
      this.flipping = false;
      this.reviveMic();
      this.changed();
    }
  }

  addScreenTracks(peer) {
    const [video] = this.screen.getVideoTracks();
    const [audio] = this.screen.getAudioTracks();
    peer.senders.screenVideo = peer.pc.addTrack(video, this.screen);
    this.preferVideoCodec(peer.pc, peer.senders.screenVideo);
    if (audio) peer.senders.screenAudio = peer.pc.addTrack(audio, this.screen);
    this.tuneSenders(peer);
  }

  /** Põe o codec da placa de vídeo (`hardwareVideoCodec`) na frente, antes de negociar a trilha nova. */
  preferVideoCodec(pc, sender) {
    if (!this.videoCodec) return;
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
    const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
    if (!transceiver?.setCodecPreferences || !codecs) return;
    // H.264 com packetization-mode=1 primeiro: é o que os codificadores das placas usam.
    const mode1 = (c) => /packetization-mode=1/.test(c.sdpFmtpLine || '');
    const first = codecs.filter((c) => c.mimeType === this.videoCodec).sort((a, b) => mode1(b) - mode1(a));
    try {
      transceiver.setCodecPreferences([...first, ...codecs.filter((c) => !first.includes(c))]);
    } catch (e) {
      console.warn('[voz] codec do vídeo', e);
    }
  }

  /**
   * Pede ao sistema a tela/janela a transmitir. O som é sempre pedido: assim o seletor mostra a opção
   * "Compartilhar áudio", e é ela que decide se a transmissão vai com som (veja `takeScreenAudio`).
   */
  async pickScreen(presetKey) {
    const preset = SCREEN_PRESETS[presetKey];
    const videoOpts = {
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    };
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    try {
      return await navigator.mediaDevices.getDisplayMedia(
        touch
          ? // Celular/tablet (app instalado ou navegador): só o essencial, que todos aceitam.
            { video: videoOpts, audio: true }
          : {
              video: videoOpts,
              // restrictOwnAudio: o som desta página (as vozes da chamada) não entra na transmissão.
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true },
              systemAudio: 'include',
              // Chrome 141+: ao escolher uma janela, oferece o som só daquela janela.
              windowAudio: 'window',
              selfBrowserSurface: 'exclude',
              surfaceSwitching: isTauri ? 'exclude' : 'include',
            },
      );
    } catch (e) {
      // Alguns aparelhos não capturam o áudio junto: tenta só a imagem.
      if (!['TypeError', 'NotSupportedError', 'OverconstrainedError'].includes(e.name)) throw e;
      return navigator.mediaDevices.getDisplayMedia({ video: videoOpts });
    }
  }

  /**
   * App do Windows: o som da janela escolhida (ou do sistema sem o PadoSpeak). Sempre capturado, mas só
   * vai ligado se a pessoa escolheu transmitir com som — assim dá para ligar e desligar durante a
   * transmissão sem escolher a janela de novo.
   */
  async nativeScreenAudio(video) {
    try {
      const audio = await startNativeScreenAudio(video);
      if (audio.fallback)
        this.onNotice?.('Não deu para separar o som desta janela: a transmissão leva o som do computador (sem o PadoSpeak).');
      return audio;
    } catch (e) {
      console.warn('[voz] som da transmissão', e);
      this.onNotice?.(`A transmissão vai sem som: ${e.message}`);
      return null;
    }
  }

  /**
   * O som da transmissão conforme a opção "Compartilhar áudio" do seletor (`stream` acabou de vir dele).
   * No app do Windows o som do seletor é trocado pelo do próprio Windows (só a janela escolhida, ou o
   * sistema sem o PadoSpeak), que é sempre capturado e vai desligado se a pessoa não marcou o som —
   * assim dá para ligar depois, pelo botão ou pelo dock. Devolve `{ wants, native }`.
   */
  async takeScreenAudio(stream) {
    const wants = stream.getAudioTracks().length > 0;
    let native = null;
    if (isTauri) {
      for (const t of stream.getAudioTracks()) {
        stream.removeTrack(t);
        t.stop();
      }
      native = await this.nativeScreenAudio(stream.getVideoTracks()[0]);
      if (native) stream.addTrack(native.track);
    }
    stream.getAudioTracks().forEach((t) => (t.enabled = wants));
    return { wants, native };
  }

  /** Nome do que está sendo transmitido (título da janela ou "Tela inteira"). */
  static screenLabel(video) {
    const surface = video?.getSettings?.().displaySurface;
    if (surface === 'monitor') return 'Tela inteira';
    const label = (video?.label || '').replace(/^(window|screen|web-contents-media-stream):[^:]*:?\d*:?/, '').trim();
    return label || (surface === 'browser' ? 'Aba do navegador' : 'Janela');
  }

  async setScreen(on, presetKey = this.state.screenPreset) {
    if (on && !this.screen) {
      const preset = SCREEN_PRESETS[presetKey];
      this.screen = await this.pickScreen(presetKey);
      const { wants, native } = await this.takeScreenAudio(this.screen);
      this.screenAudio = native;
      this.state.screenAudioMuted = !wants;
      const [video] = this.screen.getVideoTracks();
      video.contentHint = preset.hint;
      video.onended = () => this.setScreen(false);
      this.state.screenLabel = VoiceClient.screenLabel(video);
      this.state.screenPreset = presetKey;
      this.pushState({ screen: true, screenStreamId: this.screen.id });
      for (const peer of this.peers.values()) this.syncVideo(peer);
    } else if (!on && this.screen) {
      for (const peer of this.peers.values()) {
        for (const k of ['screenVideo', 'screenAudio']) {
          if (peer.senders[k]) peer.pc.removeTrack(peer.senders[k]);
          peer.senders[k] = null;
        }
      }
      this.screen.getTracks().forEach((t) => t.stop());
      this.screenAudio?.stop();
      this.screenAudio = null;
      this.screen = null;
      this.pushState({ screen: false, screenStreamId: null });
    }
    this.changed();
  }

  /**
   * Troca o que está sendo transmitido (outra janela, a tela inteira…) sem parar a transmissão: quem
   * está assistindo continua assistindo, só a imagem (e o som) mudam.
   */
  async switchScreen() {
    if (!this.screen) return;
    const preset = SCREEN_PRESETS[this.state.screenPreset];
    // O som da nova escolha também vem da opção "Compartilhar áudio" do seletor.
    const next = await this.pickScreen(this.state.screenPreset);
    const { wants, native } = await this.takeScreenAudio(next);
    const [video] = next.getVideoTracks();
    const [audio] = next.getAudioTracks();
    if (!this.screen) {
      // Parou enquanto escolhia.
      next.getTracks().forEach((t) => t.stop());
      native?.stop();
      return;
    }
    video.contentHint = preset.hint;
    video.onended = () => this.setScreen(false);
    this.state.screenAudioMuted = !wants;
    const [oldVideo] = this.screen.getVideoTracks();
    const [oldAudio] = this.screen.getAudioTracks();
    for (const peer of this.peers.values()) {
      const { pc, senders } = peer;
      if (pc.signalingState === 'closed') continue;
      if (senders.screenVideo) await senders.screenVideo.replaceTrack(video).catch((e) => console.warn('[voz] trocar imagem', e));
      if (senders.screenAudio) await senders.screenAudio.replaceTrack(audio || null).catch((e) => console.warn('[voz] trocar som', e));
      else if (senders.screenVideo && audio) senders.screenAudio = pc.addTrack(audio, this.screen);
    }
    // O mesmo stream continua (quem recebe reconhece a transmissão pelo id): só as trilhas mudam.
    for (const old of [oldVideo, oldAudio]) {
      if (!old) continue;
      old.onended = null;
      this.screen.removeTrack(old);
      if (old !== this.screenAudio?.track) old.stop();
    }
    this.screenAudio?.stop();
    this.screenAudio = native;
    this.screen.addTrack(video);
    if (audio) this.screen.addTrack(audio);
    this.state.screenLabel = VoiceClient.screenLabel(video);
    this.peers.forEach((peer) => this.tuneSenders(peer));
    this.changed();
  }

  /** Troca a qualidade da transmissão sem pedir para escolher a tela de novo. */
  async setScreenPreset(presetKey) {
    this.state.screenPreset = presetKey;
    const video = this.screen?.getVideoTracks()[0];
    if (video) {
      const p = SCREEN_PRESETS[presetKey];
      video.contentHint = p.hint;
      await video
        .applyConstraints({
          width: { ideal: p.width, max: p.width },
          height: { ideal: p.height, max: p.height },
          frameRate: { ideal: p.fps, max: p.fps },
        })
        .catch((e) => console.warn('[voz] applyConstraints', e));
      this.peers.forEach((peer) => this.tuneSenders(peer));
    }
    this.changed();
  }

  async setDevices(devices) {
    const prev = { ...this.devices };
    Object.assign(this.devices, devices);
    if (this.devices.output !== prev.output) {
      this.peers.forEach((p) => p.audioEls.forEach((el) => el.setSinkId?.(this.devices.output).catch(() => {})));
      this.boostCtx?.setSinkId?.(this.devices.output || '').catch(() => {});
    }
    if (this.mic && this.devices.mic !== prev.mic) await this.replaceMic();
    if (this.camera && this.devices.camera !== prev.camera) {
      await this.setCamera(false);
      await this.setCamera(true);
    }
  }

  // ---------- Diagnóstico (getStats) ----------

  /** Coleta, por par, o caminho da conexão e o que chega/sai de cada trilha de vídeo. */
  async collectStats() {
    for (const peer of this.peers.values()) {
      try {
        const report = await peer.pc.getStats();
        const byId = new Map();
        report.forEach((s) => byId.set(s.id, s));
        const prev = peer.prevStats || new Map();
        const kbps = (s, field) => {
          const p = prev.get(s.id);
          return p && s.timestamp > p.timestamp
            ? Math.round(((s[field] - p[field]) * 8) / (s.timestamp - p.timestamp))
            : null;
        };
        const codec = (s) => byId.get(s.codecId)?.mimeType?.replace('video/', '') || '?';
        const screenTrack = this.screen?.getVideoTracks()[0]?.id;
        let screenPowerEfficient;
        const video = {};
        const audio = { in: [], out: [] };
        let path = null;
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            audio.in.push({
              kbps: kbps(s, 'bytesReceived'),
              bytes: s.bytesReceived || 0,
              lost: s.packetsLost || 0,
              packets: s.packetsReceived || 0,
              jitterMs: s.jitter != null ? Math.round(s.jitter * 1000) : null,
              level: s.audioLevel != null ? Math.round(s.audioLevel * 1000) / 1000 : null,
              concealed: s.totalSamplesReceived ? Math.round((100 * (s.concealedSamples || 0)) / s.totalSamplesReceived) : 0,
            });
          } else if (s.type === 'outbound-rtp' && s.kind === 'audio') {
            audio.out.push({ kbps: kbps(s, 'bytesSent'), bytes: s.bytesSent || 0 });
          } else if (s.type === 'inbound-rtp' && s.kind === 'video') {
            video[s.trackIdentifier] = {
              dir: 'in',
              codec: codec(s),
              w: s.frameWidth || 0,
              h: s.frameHeight || 0,
              fps: Math.round(s.framesPerSecond || 0),
              frames: s.framesDecoded || 0,
              bytes: s.bytesReceived || 0,
              kbps: kbps(s, 'bytesReceived'),
              lost: s.packetsLost || 0,
              keyframes: s.keyFramesDecoded || 0,
              decoder: s.decoderImplementation,
            };
          } else if (s.type === 'outbound-rtp' && s.kind === 'video') {
            const trackId = byId.get(s.mediaSourceId)?.trackIdentifier;
            if (trackId && trackId === screenTrack && typeof s.powerEfficientEncoder === 'boolean') screenPowerEfficient = s.powerEfficientEncoder;
            if (trackId)
              video[trackId] = {
                dir: 'out',
                codec: codec(s),
                w: s.frameWidth || 0,
                h: s.frameHeight || 0,
                fps: Math.round(s.framesPerSecond || 0),
                frames: s.framesEncoded || 0,
                bytes: s.bytesSent || 0,
                kbps: kbps(s, 'bytesSent'),
                limitedBy: s.qualityLimitationReason,
                encoder: s.encoderImplementation,
              };
          } else if (s.type === 'transport' && s.selectedCandidatePairId) {
            const pair = byId.get(s.selectedCandidatePairId);
            const l = byId.get(pair?.localCandidateId);
            const r = byId.get(pair?.remoteCandidateId);
            if (pair)
              path = {
                local: `${l?.candidateType}/${l?.protocol}${l?.relayProtocol ? `/turn-${l.relayProtocol}` : ''}`,
                remote: `${r?.candidateType}/${r?.protocol}`,
                rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
              };
          }
        });
        peer.prevStats = byId;
        const route = path ? (path.local.startsWith('relay') || path.remote.startsWith('relay') ? 'relay' : 'direto') : null;
        if (route && route !== peer.stats?.route) this.peerLog(peer, `caminho: ${route} (${path.local} → ${path.remote})`);
        // A tela para este par sendo codificada pelo processador (sem placa, ou a placa sem vaga para mais
        // um envio): duas amostras seguidas (4 s) antes de reduzir, porque o começo pode oscilar.
        if (screenPowerEfficient === false) peer.softwareSamples = (peer.softwareSamples || 0) + 1;
        else if (screenPowerEfficient === true || !screenTrack) peer.softwareSamples = 0;
        const software = (peer.softwareSamples || 0) >= 2;
        if (software !== Boolean(peer.softwareScreen))
          this.peerLog(peer, software ? 'tela codificada pelo processador: indo em 720p' : 'tela codificada pela placa de vídeo');
        const retune = route !== (peer.stats?.route ?? null) || software !== Boolean(peer.softwareScreen);
        peer.softwareScreen = software;
        peer.stats = { connection: peer.pc.connectionState, ice: peer.pc.iceConnectionState, path, route, video, audio };
        if (retune) this.tuneSenders(peer);
      } catch (e) {
        console.warn('[voz] getStats', e);
      }
    }
    await this.sampleLatency();
    this.changed();
  }

  /** Guarda a latência até o servidor (ping no WebSocket) e o RTT da conexão com cada participante. */
  async sampleLatency() {
    const t0 = performance.now();
    const pong = await this.rt.request('ping', {}, 3000);
    // O servidor parou de responder sem a conexão cair: troca de conexão e volta para a chamada.
    if (pong?.error === 'Tempo esgotado') {
      this.missedPings += 1;
      if (this.missedPings >= MISSED_PINGS && !this.suspended && this.rt.status === 'connected') {
        this.missedPings = 0;
        console.warn('[voz] o servidor parou de responder: trocando de conexão');
        this.rt.reconnectNow?.();
      }
    } else if (!pong?.error) this.missedPings = 0;
    const sample = { t: Date.now(), server: pong?.error ? null : Math.round(performance.now() - t0), peers: {} };
    for (const p of this.peers.values()) {
      if (p.info.user) this.peerNames.set(p.id, plain(p.info.user.displayName));
      // Cor por pessoa, atribuída na primeira aparição e nunca reaproveitada (slot 0 = servidor).
      if (!this.peerSlots.has(p.id)) this.peerSlots.set(p.id, this.peerSlots.size + 1);
      sample.peers[p.id] = p.stats?.path?.rttMs ?? null;
    }
    this.latency.push(sample);
    if (this.latency.length > LATENCY_SAMPLES) this.latency.shift();
  }

  /** Séries para o gráfico: servidor primeiro, depois cada participante na ordem em que apareceu. */
  latencyHistory() {
    const ids = [];
    for (const s of this.latency) for (const id of Object.keys(s.peers)) if (!ids.includes(id)) ids.push(id);
    return {
      samples: this.latency,
      series: [
        { id: 'server', label: 'Servidor', slot: 0 },
        ...ids.map((id) => ({ id, label: this.peerNames.get(id) || 'Participante', slot: this.peerSlots.get(id) })),
      ],
    };
  }

  /** Estatísticas da trilha de vídeo de um stream (recebido de um par, ou enviado para o primeiro par conectado). */
  videoStats(stream, peerId) {
    const trackId = stream?.getVideoTracks()[0]?.id;
    if (!trackId) return null;
    if (peerId) return this.peers.get(peerId)?.stats?.video[trackId] || null;
    for (const p of this.peers.values()) if (p.stats?.video[trackId]) return p.stats.video[trackId];
    return null;
  }

  /** Relatório em texto para colar quando algo não funciona. */
  diagnostics() {
    const lines = [
      `PadoSpeak · ${new Date().toISOString()}`,
      `UA: ${navigator.userAgent}`,
      `contexto seguro: ${window.isSecureContext} · microfone: ${this.state.micAvailable} · supressão RNNoise: ${Boolean(this.nsPipe)}`,
      // Sem a senha do TURN (o relatório pode ser colado em qualquer lugar).
      `ICE: ${JSON.stringify((this.iceServers || []).map((s) => ({ urls: s.urls, ...(s.credential ? { senha: 'temporária' } : {}) })))}`,
      `local: mudo=${this.state.muted} surdo=${this.state.deafened} silenciado-pelo-mod=${Boolean(this.state.serverMuted)} microfone-ativo=${Boolean(this.mic?.getAudioTracks()[0]?.enabled)} saída=${this.devices.output || 'padrão'}`,
      `local: câmera=${Boolean(this.camera)} tela=${Boolean(this.screen)} preset=${this.state.screenPreset}${this.screenAudio ? ` som-da-tela=${this.screenAudio.mode}${this.screenAudio.source ? `(${this.screenAudio.source})` : ''}` : ''}`,
      `local: microfone-parado=${Boolean(this.state.micStalled)} som-bloqueado=${Boolean(this.state.audioBlocked)} codec-da-placa=${this.videoCodec || 'nenhum'} senha-do-relay-até=${this.iceExpiresAt ? new Date(this.iceExpiresAt).toISOString() : '?'}`,
    ];
    const limit = (sender) => {
      const e = sender?.track && sender.getParameters().encodings?.[0];
      return e ? `${Math.round((e.maxBitrate || 0) / 1000)} kbps · ${e.maxFramerate ?? '?'} fps · ÷${e.scaleResolutionDownBy ?? 1}` : '-';
    };
    for (const p of this.peers.values()) {
      lines.push(
        '',
        `par ${p.info.user?.username || p.id}: conexão=${p.pc.connectionState} ice=${p.pc.iceConnectionState} sinalização=${p.pc.signalingState}`,
      );
      lines.push(`  caminho: ${p.stats?.route || 'nenhum'} ${JSON.stringify(p.stats?.path || null)} · conexões refeitas: ${p.resets}`);
      if (p.senders.camera || p.senders.screenVideo)
        lines.push(`  envio de vídeo: tela=${limit(p.senders.screenVideo)} câmera=${limit(p.senders.camera)}${p.softwareScreen ? ' (tela pelo processador)' : ''}`);
      for (const a of p.stats?.audio?.in || [])
        lines.push(
          `  voz recebida: ${a.kbps ?? '?'} kbps · pacotes=${a.packets} perdidos=${a.lost} jitter=${a.jitterMs ?? '?'}ms nível=${a.level ?? '?'} preenchido=${a.concealed}%`,
        );
      for (const a of p.stats?.audio?.out || []) lines.push(`  voz enviada: ${a.kbps ?? '?'} kbps`);
      const els = [...p.audioEls.entries()].map(
        ([id, el]) =>
          `${id === p.info.screenStreamId ? 'tela' : 'voz'}:${el.paused ? 'PAUSADO' : 'tocando'}${el.muted ? '/mudo' : ''}/vol=${el.volume}${p.boosts.has(id) ? '/amplificado' : ''}`,
      );
      lines.push(
        `  áudio aqui: ${els.join(' ') || 'nenhum'} · volume=${Math.round(p.volume * 100)}% · silenciado-por-mim=${this.localMutes.has(p.info.user?.id)} · mudo-dele=${Boolean(p.info.muted)} silenciado-pelo-mod=${Boolean(p.info.serverMuted)}`,
      );
      lines.push(
        `  anunciado: câmera=${Boolean(p.info.video)} tela=${Boolean(p.info.screen)} streams recebidos=${p.streams.size}`,
        `  assistindo: câmera=${p.watching.camera} tela=${p.watching.screen} · pediu de mim: câmera=${p.wants.camera} tela=${p.wants.screen}`,
      );
      for (const [id, v] of Object.entries(p.stats?.video || {}))
        lines.push(`  vídeo ${v.dir} ${id.slice(0, 8)}: ${JSON.stringify(v)}`);
      if (p.log.length) lines.push('  histórico:', ...p.log.map((l) => `    ${l}`));
    }
    return lines.join('\n');
  }

  // ---------- Snapshot para a UI ----------

  changed() {
    this.onChange?.(this.snapshot());
  }

  snapshot() {
    const s = this.state;
    return {
      channelId: s.channelId,
      guildId: s.guildId,
      dm: Boolean(s.dm),
      selfId: this.selfId,
      muted: s.muted,
      deafened: s.deafened,
      serverMuted: Boolean(s.serverMuted),
      micAvailable: s.micAvailable,
      noiseSuppression: Boolean(this.nsPipe),
      error: s.error,
      screenPreset: s.screenPreset,
      screenHasAudio: Boolean(this.screen?.getAudioTracks().length),
      screenLabel: this.screen ? s.screenLabel || '' : '',
      screenAudioMuted: Boolean(s.screenAudioMuted),
      video: Boolean(this.camera),
      cameraFacing: s.cameraFacing || 'user',
      screen: Boolean(this.screen),
      localCamera: this.camera,
      localScreen: this.screen,
      localCameraStats: this.videoStats(this.camera),
      localScreenStats: this.videoStats(this.screen),
      // Quantas pessoas estão recebendo sua câmera/tela agora.
      cameraViewers: [...this.peers.values()].filter((p) => p.senders.camera).length,
      screenViewers: [...this.peers.values()].filter((p) => p.senders.screenVideo).length,
      linked: Boolean(this.linked),
      // Sem conexão com o servidor, esperando para voltar (o áudio continua).
      resuming: Boolean(this.suspended),
      speaking: { ...this.speaking },
      peers: [...this.peers.values()].map((p) => ({
        peerId: p.id,
        key: p.key,
        user: p.info.user,
        muted: Boolean(p.info.muted),
        deafened: Boolean(p.info.deafened),
        serverMuted: Boolean(p.info.serverMuted),
        localMuted: this.localMutes.has(p.info.user?.id),
        volume: p.volume,
        streamVolume: p.streamVolume,
        streamMuted: p.streamMuted,
        screenHasAudio: Boolean(p.streams.get(p.info.screenStreamId)?.getAudioTracks().length),
        connectionState: p.connectionState,
        // Sem conexão de mídia com esta pessoa há alguns segundos (você não a ouve, ela não te ouve).
        trouble: Boolean(p.badSince && Date.now() - p.badSince > TROUBLE_AFTER_MS),
        route: p.stats?.route || null,
        cameraStats: p.info.video ? this.videoStats(p.streams.get(p.info.cameraStreamId), p.id) : null,
        screenStats: p.info.screen ? this.videoStats(p.streams.get(p.info.screenStreamId), p.id) : null,
        cameraStream: p.info.video ? p.streams.get(p.info.cameraStreamId) || null : null,
        screenStream: p.info.screen ? p.streams.get(p.info.screenStreamId) || null : null,
        screenAnnounced: Boolean(p.info.screen),
        cameraAnnounced: Boolean(p.info.video),
        watchingCamera: p.watching.camera,
        watchingScreen: p.watching.screen,
      })),
    };
  }
}
