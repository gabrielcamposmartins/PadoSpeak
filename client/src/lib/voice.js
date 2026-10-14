import { suppressNoise } from './noise.js';
import { plain } from './text.js';

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
    this.latency = [];
    this.peerNames = new Map();
    this.peerSlots = new Map();
    this.lastLoud = {};
    this.meters = new Map();
    this.unsubs = [];
  }

  // ---------- Ciclo de vida ----------

  async join(channelId, { muted = false, deafened = false, devices, noiseSuppression = true } = {}) {
    Object.assign(this.devices, devices || {});
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
    if (this.mic) this.watchLevel('me', this.mic);
    this.meterTimer = setInterval(() => this.tickSpeaking(), 120);
    this.statsTimer = setInterval(() => this.collectStats(), 2000);
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
    this.nsPipe?.close();
    this.nsPipe = null;
    this.rawMic = this.mic = this.camera = this.screen = null;
    clearInterval(this.meterTimer);
    clearInterval(this.statsTimer);
    this.meters.clear();
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
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
        Object.assign(peer.info, info);
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
      volume: 1,
      streamVolume: 1,
      streamMuted: false,
      connectionState: 'new',
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
      if (pc.connectionState === 'failed') pc.restartIce();
      this.changed();
    };
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

    // Envia tudo o que já está ativo localmente.
    if (this.mic) peer.senders.mic = pc.addTrack(this.mic.getAudioTracks()[0], this.mic);
    if (this.camera) peer.senders.camera = pc.addTrack(this.camera.getVideoTracks()[0], this.camera);
    if (this.screen) this.addScreenTracks(peer);
    return peer;
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

  handleSignal(from, data) {
    const peer = this.ensurePeer(from);
    // Processa em ordem: a negociação não pode intercalar descrições.
    peer.queue = peer.queue.then(() => this.processSignal(peer, data)).catch((e) => console.warn('[voz] sinal', e));
  }

  async processSignal(peer, { description, candidate }) {
    const { pc } = peer;
    if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.signal(peer.id, { description: pc.localDescription });
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

  /** Aplica ensurdecer, volume da voz e volume/mudo da transmissão aos <audio> do par. */
  applyAudio(peer) {
    for (const [streamId, el] of peer.audioEls) {
      const isScreen = streamId === peer.info.screenStreamId;
      el.muted = this.state.deafened || (isScreen && peer.streamMuted);
      el.volume = isScreen ? peer.streamVolume : peer.volume;
    }
  }

  stopAudio(peer, streamId) {
    const el = peer.audioEls.get(streamId);
    if (!el) return;
    el.pause();
    el.srcObject = null;
    peer.audioEls.delete(streamId);
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
    const enabled = !this.state.muted && !this.state.deafened;
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
      else peer.senders.mic = peer.pc.addTrack(track, this.mic);
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
      for (const peer of this.peers.values()) peer.senders.camera = peer.pc.addTrack(track, this.camera);
    } else if (!on && this.camera) {
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

  addScreenTracks(peer) {
    const [video] = this.screen.getVideoTracks();
    const [audio] = this.screen.getAudioTracks();
    peer.senders.screenVideo = peer.pc.addTrack(video, this.screen);
    if (audio) peer.senders.screenAudio = peer.pc.addTrack(audio, this.screen);
    this.tuneSenders(peer);
  }

  async setScreen(on, presetKey = this.state.screenPreset) {
    if (on && !this.screen) {
      const preset = SCREEN_PRESETS[presetKey];
      this.screen = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: preset.width, max: preset.width },
          height: { ideal: preset.height, max: preset.height },
          frameRate: { ideal: preset.fps, max: preset.fps },
        },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
      this.state.screenAudioMuted = false;
      const [video] = this.screen.getVideoTracks();
      video.contentHint = preset.hint;
      video.onended = () => this.setScreen(false);
      this.state.screenPreset = presetKey;
      this.pushState({ screen: true, screenStreamId: this.screen.id });
      for (const peer of this.peers.values()) this.addScreenTracks(peer);
    } else if (!on && this.screen) {
      for (const peer of this.peers.values()) {
        for (const k of ['screenVideo', 'screenAudio']) {
          if (peer.senders[k]) peer.pc.removeTrack(peer.senders[k]);
          peer.senders[k] = null;
        }
      }
      this.screen.getTracks().forEach((t) => t.stop());
      this.screen = null;
      this.pushState({ screen: false, screenStreamId: null });
    }
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
        let path = null;
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
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
                local: `${l?.candidateType}/${l?.protocol}`,
                remote: `${r?.candidateType}/${r?.protocol}`,
                rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
              };
          }
        });
        peer.prevStats = byId;
        peer.stats = { connection: peer.pc.connectionState, ice: peer.pc.iceConnectionState, path, video };
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
      `contexto seguro: ${window.isSecureContext} · microfone: ${this.state.micAvailable} · supressão RNNoise: ${Boolean(this.nsPipe)} · ICE: ${JSON.stringify(this.iceServers)}`,
      `local: câmera=${Boolean(this.camera)} tela=${Boolean(this.screen)} preset=${this.state.screenPreset}`,
    ];
    for (const p of this.peers.values()) {
      lines.push(
        '',
        `par ${p.info.user?.username || p.id}: conexão=${p.pc.connectionState} ice=${p.pc.iceConnectionState} sinalização=${p.pc.signalingState}`,
      );
      lines.push(`  caminho: ${JSON.stringify(p.stats?.path || null)}`);
      lines.push(
        `  anunciado: câmera=${Boolean(p.info.video)} tela=${Boolean(p.info.screen)} streams recebidos=${p.streams.size}`,
      );
      for (const [id, v] of Object.entries(p.stats?.video || {}))
        lines.push(`  vídeo ${v.dir} ${id.slice(0, 8)}: ${JSON.stringify(v)}`);
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
      micAvailable: s.micAvailable,
      noiseSuppression: Boolean(this.nsPipe),
      error: s.error,
      screenPreset: s.screenPreset,
      screenHasAudio: Boolean(this.screen?.getAudioTracks().length),
      screenAudioMuted: Boolean(s.screenAudioMuted),
      video: Boolean(this.camera),
      screen: Boolean(this.screen),
      localCamera: this.camera,
      localScreen: this.screen,
      localCameraStats: this.videoStats(this.camera),
      localScreenStats: this.videoStats(this.screen),
      speaking: { ...this.speaking },
      peers: [...this.peers.values()].map((p) => ({
        peerId: p.id,
        user: p.info.user,
        muted: Boolean(p.info.muted),
        deafened: Boolean(p.info.deafened),
        volume: p.volume,
        streamVolume: p.streamVolume,
        streamMuted: p.streamMuted,
        screenHasAudio: Boolean(p.streams.get(p.info.screenStreamId)?.getAudioTracks().length),
        connectionState: p.connectionState,
        cameraStats: p.info.video ? this.videoStats(p.streams.get(p.info.cameraStreamId), p.id) : null,
        screenStats: p.info.screen ? this.videoStats(p.streams.get(p.info.screenStreamId), p.id) : null,
        cameraStream: p.info.video ? p.streams.get(p.info.cameraStreamId) || null : null,
        screenStream: p.info.screen ? p.streams.get(p.info.screenStreamId) || null : null,
        screenAnnounced: Boolean(p.info.screen),
      })),
    };
  }
}
