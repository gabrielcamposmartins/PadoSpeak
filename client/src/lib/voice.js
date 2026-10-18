import { suppressNoise } from './noise.js';
import { plain } from './text.js';
import { isTauri } from './env.js';
import { startNativeScreenAudio } from './screenAudio.js';

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

// Com o RNNoise ligado, o supressor nativo do navegador fica desligado para não processar o áudio duas vezes.
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
  }

  // ---------- Ciclo de vida ----------

  async join(channelId, { muted = false, deafened = false, devices, noiseSuppression = true, watch } = {}) {
    Object.assign(this.devices, devices || {});
    Object.assign(this.watchPrefs, watch || {});
    this.noiseSuppression = noiseSuppression;
    this.state.muted = muted;
    this.state.deafened = deafened;
    try {
      await this.acquireMic();
    } catch (e) {
      console.warn('[voz] microfone indisponível; entrando só para ouvir:', e.message);
      this.mic = null;
      this.state.micAvailable = false;
    }
    this.applyMicEnabled();
    this.audioCtx = new AudioContext();

    const on = (ev, fn) => this.unsubs.push(this.rt.on(ev, fn));
    on('voice:peer-joined', (p) => {
      this.ensurePeer(p.peerId, p);
      this.changed();
    });
    on('voice:peer-left', ({ peerId }) => this.removePeer(peerId));
    on('voice:peer-state', (p) => {
      this.ensurePeer(p.peerId, p);
      this.changed();
    });
    on('voice:signal', ({ from, data }) => this.handleSignal(from, data));
    on('voice:kicked', () => this.cleanup('Você foi removido do canal de voz'));
    // Um moderador me silenciou (ou tirou o silêncio) para todos.
    on('voice:server-mute', ({ muted, by }) => {
      this.state.serverMuted = muted;
      this.applyMicEnabled();
      this.onNotice?.(muted ? `${by.displayName} silenciou você para todos neste canal.` : `${by.displayName} tirou o seu silêncio.`);
      this.changed();
    });
    on('disconnected', () => this.cleanup('Conexão com o servidor perdida'));

    const res = await this.rt.request('voice:join', { channelId, muted, deafened });
    if (res.error) {
      this.cleanup();
      throw new Error(res.error);
    }
    this.selfId = this.rt.peerId;
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
    }, 2000);
    this.changed();
  }

  leave() {
    if (this.state.channelId) this.rt.send('voice:leave');
    this.cleanup();
  }

  cleanup(reason = null) {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
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
        this.signal(peerId, { description: pc.localDescription });
      } catch (e) {
        console.warn('[voz] negotiationneeded', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(peerId, { candidate });
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
        this.watchLevel(peerId, stream);
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
    if (camTrack && wants.camera && !senders.camera) senders.camera = pc.addTrack(camTrack, this.camera);
    else if ((!camTrack || !wants.camera) && senders.camera) {
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

  /** Reinicia o ICE (só o lado não educado; o educado responde à oferta). */
  restartIce(peer) {
    if (peer.polite || peer.pc.signalingState === 'closed' || Date.now() - peer.lastRestart < RESTART_AFTER_MS) return;
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
    const now = Date.now();
    for (const peer of [...this.peers.values()]) {
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

  /** Bitrate/fps alvo por tipo de vídeo — é o que garante a tela nítida em 1080p. */
  tuneSenders(peer) {
    const targets = [
      [peer.senders.camera, CAMERA, null],
      [peer.senders.screenVideo, SCREEN_PRESETS[this.state.screenPreset], 'screen'],
    ];
    for (const [sender, preset, kind] of targets) {
      if (!sender?.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      Object.assign(params.encodings[0], {
        maxBitrate: preset.bitrate,
        maxFramerate: preset.fps,
        scaleResolutionDownBy: 1,
        priority: kind ? 'high' : 'medium',
        networkPriority: kind ? 'high' : 'medium',
      });
      if (kind) params.degradationPreference = preset.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
      sender.setParameters(params).catch(() => {
        delete params.degradationPreference;
        sender.setParameters(params).catch((e) => console.warn('[voz] setParameters', e));
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
    el.play().catch(() => {});
    peer.audioEls.set(stream.id, el);
    this.applyAudio(peer);
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
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(this.devices.mic, this.noiseSuppression),
      video: false,
    });
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
      this.camera = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: this.devices.camera ? { exact: this.devices.camera } : undefined,
          width: { ideal: CAMERA.width },
          height: { ideal: CAMERA.height },
          frameRate: { ideal: CAMERA.fps },
        },
      });
      const track = this.camera.getVideoTracks()[0];
      // Termina sozinha quando o Windows entrega a webcam a outro programa (ou ela é desconectada).
      track.onended = () => {
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

  /** Celular/tablet: troca entre a câmera frontal e a traseira sem sair da chamada. */
  async flipCamera() {
    if (!this.camera) return;
    const facing = this.state.cameraFacing === 'environment' ? 'user' : 'environment';
    const next = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facing },
        width: { ideal: CAMERA.width },
        height: { ideal: CAMERA.height },
        frameRate: { ideal: CAMERA.fps },
      },
    });
    const track = next.getVideoTracks()[0];
    const old = this.camera.getVideoTracks()[0];
    track.onended = old?.onended || null;
    // Mesmo stream (quem recebe continua reconhecendo a câmera), só a trilha muda.
    for (const peer of this.peers.values()) if (peer.senders.camera) await peer.senders.camera.replaceTrack(track);
    if (old) {
      old.onended = null;
      old.stop();
      this.camera.removeTrack(old);
    }
    this.camera.addTrack(track);
    this.state.cameraFacing = facing;
    this.changed();
  }

  addScreenTracks(peer) {
    const [video] = this.screen.getVideoTracks();
    const [audio] = this.screen.getAudioTracks();
    peer.senders.screenVideo = peer.pc.addTrack(video, this.screen);
    if (audio) peer.senders.screenAudio = peer.pc.addTrack(audio, this.screen);
    this.tuneSenders(peer);
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
        peer.stats = { connection: peer.pc.connectionState, ice: peer.pc.iceConnectionState, path, route, video, audio };
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
    ];
    for (const p of this.peers.values()) {
      lines.push(
        '',
        `par ${p.info.user?.username || p.id}: conexão=${p.pc.connectionState} ice=${p.pc.iceConnectionState} sinalização=${p.pc.signalingState}`,
      );
      lines.push(`  caminho: ${p.stats?.route || 'nenhum'} ${JSON.stringify(p.stats?.path || null)} · conexões refeitas: ${p.resets}`);
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
      speaking: { ...this.speaking },
      peers: [...this.peers.values()].map((p) => ({
        peerId: p.id,
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
