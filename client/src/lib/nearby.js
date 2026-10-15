// Aparelhos na mesma rede (navegador e app instalado no celular, que não enxergam a rede local).
//
// O servidor agrupa as conexões que chegam do mesmo endereço público (ou do mesmo prefixo IPv6).
// No IPv4, várias casas podem dividir um endereço (CGNAT da operadora), então cada par confirma com
// uma conexão WebRTC *sem* servidor STUN/TURN: só os endereços locais entram, e ela só abre se os
// dois aparelhos estiverem mesmo na mesma rede local.
import { isDesktop } from './env.js';
import { isTouch } from './layout.js';

const PROBE_TIMEOUT_MS = 10000;
/** Depois de falhar, tenta de novo com o mesmo aparelho só depois disto. */
const RETRY_MS = 2 * 60 * 1000;

/** Como este aparelho aparece para os outros. */
export function deviceLabel() {
  if (isDesktop) return 'PadoSpeak no PC';
  if (isTouch) return /iPad|Tablet/i.test(navigator.userAgent) ? 'Tablet' : 'Celular';
  return 'Navegador';
}

export class NearbyProbe {
  /** `send(peerId, data)`: manda sinalização; `onResult(peerId, ok)`. */
  constructor({ send, onResult }) {
    this.send = send;
    this.onResult = onResult;
    this.probes = new Map(); // peerId -> { pc, timer }
    this.done = new Map(); // peerId -> { ok, at }
  }

  /** Nova lista do servidor: começa a testar quem ainda não foi confirmado (o de menor id oferece). */
  update(peers, myId) {
    const ids = new Set(peers.map((p) => p.peerId));
    for (const id of [...this.probes.keys()]) if (!ids.has(id)) this.stop(id);
    for (const id of [...this.done.keys()]) if (!ids.has(id)) this.done.delete(id);
    if (typeof RTCPeerConnection === 'undefined' || !myId) return;
    for (const p of peers) {
      if (p.direct || this.probes.has(p.peerId)) continue;
      const prev = this.done.get(p.peerId);
      if (prev && (prev.ok || Date.now() - prev.at < RETRY_MS)) continue;
      if (myId < p.peerId) this.start(p.peerId, true);
    }
  }

  start(peerId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const entry = { pc, timer: setTimeout(() => this.finish(peerId, false), PROBE_TIMEOUT_MS) };
    this.probes.set(peerId, entry);
    pc.onicecandidate = (e) => e.candidate && this.send(peerId, { ice: e.candidate.toJSON() });
    const watch = (dc) => {
      dc.onopen = () => {
        dc.send('oi');
        this.finish(peerId, true);
      };
    };
    if (initiator) {
      watch(pc.createDataChannel('rede-local'));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.send(peerId, { sdp: pc.localDescription.toJSON() }))
        .catch(() => this.finish(peerId, false));
    } else {
      pc.ondatachannel = (e) => watch(e.channel);
    }
    return entry;
  }

  async signal(from, data) {
    if (!data) return;
    try {
      if (data.sdp?.type === 'offer') {
        this.stop(from);
        const { pc } = this.start(from, false);
        await pc.setRemoteDescription(data.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        this.send(from, { sdp: pc.localDescription.toJSON() });
        return;
      }
      const pc = this.probes.get(from)?.pc;
      if (!pc) return;
      if (data.sdp) await pc.setRemoteDescription(data.sdp);
      else if (data.ice) await pc.addIceCandidate(data.ice);
    } catch {
      this.finish(from, false);
    }
  }

  finish(peerId, ok) {
    const entry = this.probes.get(peerId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.probes.delete(peerId);
    // Deixa a mensagem de teste chegar ao outro lado antes de fechar.
    setTimeout(() => entry.pc.close(), ok ? 1500 : 0);
    this.done.set(peerId, { ok, at: Date.now() });
    this.onResult(peerId, ok);
  }

  stop(peerId) {
    const entry = this.probes.get(peerId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.pc.close();
    this.probes.delete(peerId);
  }
}
