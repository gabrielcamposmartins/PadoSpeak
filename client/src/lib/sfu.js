// Ligação com o SFU de um nó de mídia (veja server/src/media/sfu.rs; veio do HardLine): cada um manda voz,
// câmera e tela uma vez só para o nó, e recebe de lá o que os outros mandam.
//
// Duas conexões: a de envio (`pub`, este lado oferece, com o que está mandando) e a de recebimento (`sub`,
// o nó oferece, com o que pedi para receber). Assim nunca os dois lados oferecem juntos. O nó é ICE-lite:
// só precisa dos endereços dele, que vêm no SDP (não há troca de candidatos).
//
// Tudo o que sai é cifrado aqui (mediaCrypt.js) e só é decifrado por quem está na chamada: o nó repassa
// sem conseguir ouvir nem ver. A sinalização vai pelo WebSocket de sempre, com o id do nó (`node`): na
// troca de nó, a ligação com o de antes continua até a nova ficar pronta.
import { MediaCrypt } from './mediaCrypt.js';

/** Câmera em três camadas: cada um recebe a que cabe no quadro em que ela aparece. */
export const CAMERA_LAYERS = [
  { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
];
/** Sem conectar em tanto tempo, a tentativa falhou (até o nó, direto ou pelo TURN, leva 1 a 3 s). */
const CONNECT_MS = 6000;
/** Conectada, mas sem caminho por tanto tempo: refaz. */
const DISCONNECTED_MS = 5000;
/** Sem o batimento do nó (um a cada 250 ms) por tanto tempo, a ligação não está servindo. */
export const BEAT_LOST_MS = 800;

export class SfuLink {
  /**
   * @param {object} o
   * @param {string} o.node id do nó de mídia
   * @param {import('./realtime.js').Realtime} o.rt
   * @param {RTCIceServer[]} o.iceServers
   * @param {MediaCrypt} o.crypt
   * @param {(peerId: string) => string | null} o.ownerOf o usuário de uma conexão da chamada
   * @param {(e: RTCTrackEvent, info: { peerId: string, source: string, streamId: string } | undefined) => void} o.onTrack
   * @param {(state: string) => void} o.onState estado da ligação (`new`, `connecting`, `connected`, `failed`)
   * @param {(v: { camera: number, screen: number }) => void} o.onViewers quantos recebem minha câmera/tela
   * @param {() => void} o.onReset a ligação foi refeita: o que chegava por ela acabou
   * @param {() => void} o.onUnreachable não deu para chegar ao nó daqui
   * @param {(text: string) => void} o.log
   */
  constructor(o) {
    Object.assign(this, o);
    this.state = 'new';
    this.tracks = {};
    // fonte (mic/camera/screen/screenAudio) → { transceiver, stream }
    this.sources = new Map();
    this.viewers = { camera: 0, screen: 0 };
    this.everConnected = false;
    this.unsubs = [];
    this.queue = Promise.resolve();
    this.wants = null;
    this.sentWants = '';
    this.lastBeat = 0;
    // Banda de partida da tela, que vai junto da resposta do nó (veja `startScreen`).
    this.startKbps = 0;
  }

  /** Conectada e com o batimento do nó chegando: dá para mandar e ouvir por ela. */
  isReady() {
    return this.state === 'connected' && Date.now() - this.lastBeat < BEAT_LOST_MS;
  }

  /** Esteve pronta e parou de bater: o nó (ou o caminho até ele) caiu. */
  isLost() {
    return this.everReady && !this.isReady();
  }

  /** Recebo a voz de `peerId` por esta ligação (há uma trilha de microfone dele nela). */
  carries(peerId) {
    return Object.values(this.tracks).some((t) => t?.peerId === peerId && t.source === 'mic');
  }

  /** Liga (ou religa) as duas conexões com o nó e publica o que já está sendo enviado. */
  async start() {
    this.closePcs();
    const gen = (this.gen = (this.gen || 0) + 1);
    this.startedAt = Date.now();
    this.badSince = null;
    this.setState('connecting');
    if (!this.unsubs.length) {
      const on = (ev, fn) => this.unsubs.push(this.rt.on(ev, (d) => d?.node === this.node && fn(d)));
      on('sfu:offer', (d) => {
        this.queue = this.queue.then(() => this.handleOffer(d)).catch((e) => console.warn('[sfu] oferta', e));
      });
      on('sfu:viewers', (v) => {
        this.viewers = { camera: v.camera || 0, screen: v.screen || 0 };
        this.onViewers?.(this.viewers);
      });
      // O nó perdeu esta ligação (ficou sem caminho): recomeça.
      on('sfu:lost', () => this.restart('o nó perdeu a ligação'));
    }
    const config = { iceServers: this.iceServers, bundlePolicy: 'max-bundle', ...MediaCrypt.pcConfig() };
    this.sub = new RTCPeerConnection(config);
    this.pub = new RTCPeerConnection(config);
    // Garante algo para negociar mesmo sem microfone nem câmera.
    this.pub.createDataChannel('hl');
    this.sub.ondatachannel = ({ channel }) => {
      channel.onmessage = () => {
        this.lastBeat = Date.now();
        if (this.state === 'connected') this.everReady = true;
      };
    };
    this.sub.ontrack = (e) => {
      const info = this.tracks[e.transceiver?.mid];
      // Decifrar com as chaves de quem mandou (a transformação vai antes do primeiro quadro).
      const owner = (info?.peerId && this.ownerOf(info.peerId)) || `conn:${info?.peerId || '?'}`;
      this.crypt.attachReceiver(e.receiver, e.track.kind, owner);
      this.onTrack?.(e, info);
    };
    for (const pc of [this.sub, this.pub]) pc.onconnectionstatechange = () => this.watchState();
    // As trilhas que já estavam sendo enviadas vão na conexão nova.
    const kept = [...this.sources.entries()];
    this.sources.clear();
    for (const [source, { track, stream, opts }] of kept) this.attach(source, track, stream, opts);
    const res = await this.rt.request('sfu:join', { node: this.node });
    if (gen !== this.gen) return;
    if (res?.error) {
      this.log?.(`SFU: ${res.error}`);
      return;
    }
    this.sentWants = '';
    this.flushWants();
    await this.negotiate();
  }

  /** Refaz as duas conexões do zero. */
  restart(why) {
    if (this.closed) return;
    this.log?.(`SFU: refazendo a ligação (${why})`);
    this.onReset?.();
    this.start().catch((e) => console.warn('[sfu] refazer', e));
  }

  closePcs() {
    for (const pc of [this.sub, this.pub]) {
      if (!pc) continue;
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.ondatachannel = null;
      pc.close();
    }
    this.sub = this.pub = null;
    this.tracks = {};
  }

  /** Fecha a ligação. `tell`: avisa o nó (sem isso, ele percebe sozinho quando a conexão some). */
  close(tell = true) {
    if (this.closed) return;
    this.closed = true;
    this.gen = (this.gen || 0) + 1;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.closePcs();
    if (tell) this.rt.send('sfu:leave', { node: this.node });
    this.setState('closed');
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState?.(state);
  }

  /** Estado das duas conexões juntas: só está conectada quando as duas estão. */
  watchState() {
    const states = [this.sub?.connectionState, this.pub?.connectionState];
    let state = 'connecting';
    if (states.every((s) => s === 'connected')) state = 'connected';
    else if (states.some((s) => s === 'failed')) state = 'failed';
    else if (states.some((s) => s === 'disconnected')) state = 'disconnected';
    if (state === 'connected') {
      this.everConnected = true;
      this.badSince = null;
    } else if (!this.badSince) this.badSince = Date.now();
    this.setState(state);
  }

  /** A cada 2 s: ligação caída ou que nunca conectou é refeita. */
  check() {
    if (this.closed || !this.sub) return;
    const now = Date.now();
    const failed = this.state === 'failed';
    const stuck = this.state !== 'connected' && now - this.startedAt > CONNECT_MS && (!this.badSince || now - this.badSince > CONNECT_MS);
    const dropped = this.state === 'disconnected' && this.badSince && now - this.badSince > DISCONNECTED_MS;
    if (!failed && !stuck && !dropped) return;
    // Nunca conectou: UDP bloqueado e sem relay que alcance o nó. Daqui, a voz fica na malha.
    if (!this.everConnected) {
      if (!this.unreachable) {
        this.unreachable = true;
        this.log?.('SFU: o nó não é alcançável daqui');
        this.onUnreachable?.();
      }
      // Continua tentando de vez em quando (a rede pode mudar).
      if (now - this.startedAt < 30000) return;
    }
    this.restart(failed ? 'falhou' : stuck ? 'não conectou' : 'caiu');
  }

  setIceServers(list) {
    this.iceServers = list;
    for (const pc of [this.sub, this.pub]) {
      try {
        pc?.setConfiguration({ ...pc.getConfiguration(), iceServers: list });
      } catch (e) {
        console.warn('[sfu] senha do relay', e);
      }
    }
  }

  /* ---------------------------------------------------------- recebimento */

  async handleOffer({ sdp, tracks }) {
    const pc = this.sub;
    if (!pc || pc.signalingState === 'closed') return;
    // Antes da descrição: o `ontrack` (durante o setRemoteDescription) já sabe de quem é cada trilha.
    this.tracks = tracks || {};
    await pc.setRemoteDescription(sdp);
    await pc.setLocalDescription();
    if (pc !== this.sub) return;
    this.rt.send('sfu:answer', { node: this.node, sdp: pc.localDescription });
  }

  /** O que eu quero receber de cada um: `{ peerId: { camera, screen, quality } }`. */
  setWants(wants) {
    this.wants = wants;
    this.flushWants();
  }

  flushWants() {
    if (!this.wants || !this.sub) return;
    const json = JSON.stringify(this.wants);
    if (json === this.sentWants) return;
    this.sentWants = json;
    this.rt.send('sfu:want', { node: this.node, peers: this.wants });
  }

  /** Acabou de chegar a chave de quem manda: um quadro-chave dos vídeos dele (os de antes não decifraram). */
  askKeyframe(peerId) {
    if (this.sub) this.rt.send('sfu:keyframe', { node: this.node, from: peerId });
  }

  /* ---------------------------------------------------------- envio */

  /**
   * Liga, troca ou desliga o que vai numa fonte. Trocar a trilha (outro microfone, a câmera de trás)
   * não renegocia; ligar e desligar renegociam a conexão de envio.
   * @param {'mic' | 'camera' | 'screen' | 'screenAudio'} source
   * @param {MediaStreamTrack | null} track
   * @param {MediaStream} [stream] quem recebe reconhece câmera e tela pelo id dele
   * @param {{ sendEncodings?: RTCRtpEncodingParameters[], prefer?: (pc: RTCPeerConnection, sender: RTCRtpSender) => void }} [opts]
   */
  async setSource(source, track, stream, opts = {}) {
    const have = this.sources.get(source);
    if (track && have && have.stream === stream) {
      have.track = track;
      await have.transceiver?.sender.replaceTrack(track).catch((e) => console.warn('[sfu] trocar trilha', e));
      return;
    }
    if (have) {
      if (this.pub && have.transceiver && this.pub.signalingState !== 'closed') this.pub.removeTrack(have.transceiver.sender);
      this.sources.delete(source);
    }
    if (track) this.attach(source, track, stream, opts);
    if (this.pub) await this.negotiate();
  }

  /** Põe a trilha num transceiver novo da conexão de envio (sem negociar ainda), já cifrando. */
  attach(source, track, stream, opts = {}) {
    const entry = { track, stream, opts, transceiver: null };
    this.sources.set(source, entry);
    if (!this.pub) return;
    entry.transceiver = this.pub.addTransceiver(track, {
      direction: 'sendonly',
      streams: stream ? [stream] : [],
      ...(opts.sendEncodings ? { sendEncodings: opts.sendEncodings.map((e) => ({ ...e })) } : {}),
    });
    this.crypt.attachSender(entry.transceiver.sender, track.kind);
    opts.prefer?.(this.pub, entry.transceiver.sender);
  }

  sender(source) {
    return this.sources.get(source)?.transceiver?.sender || null;
  }

  /**
   * A tela vai começar a sair para quem assiste. Sem vídeo saindo, o navegador estima a banda pelo que a
   * voz usa (~130 kbps) e só sonda mais se ela estiver folgada: com alguém falando, ou logo depois de a
   * estimativa cair, não sonda, e a imagem sobe só 8% por segundo (mais de um minuto até 9 Mbps). Uma
   * banda de partida na negociação faz a estimativa recomeçar dela. O valor precisa mudar: repetido, o
   * navegador não reaplica. `up`: estimativa atual do envio, em kbps. Devolve a renegociação, se houve.
   */
  startScreen(kbps, up) {
    const entry = this.sources.get('screen');
    if (!entry || entry.live) return null;
    entry.live = true;
    if (up != null && up >= kbps) return null;
    this.startKbps = this.startKbps === kbps ? kbps - 1 : kbps;
    return this.negotiate();
  }

  /** Ninguém mais assiste: quem vier depois liga a tela de novo. */
  stopScreen() {
    const entry = this.sources.get('screen');
    if (entry) entry.live = false;
  }

  isScreenLive() {
    return Boolean(this.sources.get('screen')?.live);
  }

  /** Renegocia a conexão de envio (em fila: uma oferta de cada vez). */
  negotiate() {
    this.queue = this.queue.then(() => this.publish()).catch((e) => console.warn('[sfu] publicar', e));
    return this.queue;
  }

  async publish() {
    const pc = this.pub;
    if (!pc || pc.signalingState === 'closed') return;
    await pc.setLocalDescription(await pc.createOffer());
    const tracks = [];
    for (const [source, { transceiver, stream }] of this.sources) {
      if (transceiver?.mid) tracks.push({ mid: transceiver.mid, source, streamId: stream?.id || '' });
    }
    const res = await this.rt.request('sfu:publish', { node: this.node, sdp: pc.localDescription, tracks });
    if (pc !== this.pub || pc.signalingState === 'closed') return;
    if (res?.error || !res?.sdp) {
      this.log?.(`SFU: envio recusado (${res?.error || 'sem resposta'})`);
      await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      return;
    }
    const answer = keepCodecOrder(pc.localDescription.sdp, res.sdp.sdp);
    const screen = this.sources.get('screen')?.transceiver?.mid;
    await pc.setRemoteDescription({ type: 'answer', sdp: screen != null && this.startKbps ? withStartBitrate(answer, screen, this.startKbps) : answer });
  }
}

/** Põe a banda de partida nos codecs de vídeo de uma mídia da resposta (`x-google-start-bitrate`). */
export function withStartBitrate(sdp, mid, kbps) {
  const param = `x-google-start-bitrate=${kbps}`;
  return sdp
    .split(/\r\n(?=m=)/)
    .map((sec) => {
      if (!new RegExp(`\\r\\na=mid:${mid}(\\r\\n|$)`).test(sec)) return sec;
      let out = sec;
      for (const [, pt] of sec.matchAll(/^a=rtpmap:(\d+) (?:H264|VP8|VP9|AV1)\//gm)) {
        const fmtp = new RegExp(`^a=fmtp:${pt} .*$`, 'm');
        out = fmtp.test(out)
          ? out.replace(fmtp, (line) => `${line};${param}`)
          : out.replace(new RegExp(`^a=rtpmap:${pt} .*$`, 'm'), (line) => `${line}\r\na=fmtp:${pt} ${param}`);
      }
      return out;
    })
    .join('\r\n');
}

/**
 * O nó responde com os codecs na ordem dele, e o navegador envia com o primeiro da resposta: a
 * preferência da oferta (H.264 da placa de vídeo na tela, `preferVideoCodec`) se perderia. Reordena
 * cada mídia da resposta na ordem em que a oferta listou os mesmos codecs.
 */
export function keepCodecOrder(offer, answer) {
  const sections = (sdp) => sdp.split(/\r\n(?=m=)/);
  const order = new Map();
  for (const sec of sections(offer)) {
    const mid = /\r\na=mid:(\S+)/.exec(sec)?.[1];
    const m = /^m=\S+ \S+ \S+ (.*)$/m.exec(sec);
    if (mid && m) order.set(mid, m[1].split(' '));
  }
  return sections(answer)
    .map((sec) => {
      const mid = /\r\na=mid:(\S+)/.exec(sec)?.[1];
      const want = order.get(mid);
      if (!want) return sec;
      return sec.replace(/^(m=\S+ \S+ \S+ )(.*)$/m, (_, head, list) => {
        const pts = list.trim().split(' ');
        const rank = (pt) => (want.includes(pt) ? want.indexOf(pt) : want.length);
        return head + [...pts].sort((a, b) => rank(a) - rank(b)).join(' ');
      });
    })
    .join('\r\n');
}
