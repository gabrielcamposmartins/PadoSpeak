// Cifragem da mídia que passa pelo nó de mídia (SFU): o nó só repassa quadros cifrados.
//
// - Cada um gera, ao entrar na chamada, um par ECDH P-256 (a chave privada não sai do navegador) e manda a
//   pública no `voice:join` (`e2e`).
// - Cada um tem a própria chave de mídia (AES-256-GCM) e a entrega a cada participante, embrulhada com
//   `HKDF(ECDH(minha privada, pública dele), sal = canal, "padospeak-midia")`, pelo `voice:signal { mediaKey }`.
//   O servidor só vê chaves embrulhadas; o nó, nem isso.
// - Quando alguém sai, a chave de mídia muda (as antigas continuam valendo por alguns quadros).
// - Os quadros são cifrados num worker (mediaCrypt.worker.js), por RTCRtpScriptTransform ou, no Chromium
//   sem ele, por `createEncodedStreams` (a conexão precisa de `encodedInsertableStreams`).
//
// A malha P2P não passa por aqui: lá o DTLS-SRTP já vai direto de um aparelho ao outro.

const enc = new TextEncoder();
const LABEL = 'padospeak-midia';
/** Depois de trocar de chave, espera este tempo antes de usar a nova (todos já receberam). */
const SWITCH_AFTER_MS = 1200;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const scriptTransform = () => typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window;
const encodedStreams = () => typeof RTCRtpSender !== 'undefined' && 'createEncodedStreams' in RTCRtpSender.prototype;

export class MediaCrypt {
  /** O navegador consegue cifrar os quadros (sem isso, o app fica na malha). */
  static supported() {
    return Boolean(globalThis.crypto?.subtle) && typeof Worker !== 'undefined' && (scriptTransform() || encodedStreams());
  }

  /** O que a conexão com o SFU precisa na configuração (Chromium sem RTCRtpScriptTransform). */
  static pcConfig() {
    return !scriptTransform() && encodedStreams() ? { encodedInsertableStreams: true } : {};
  }

  /**
   * @param {object} o
   * @param {string} o.salt o canal da chamada
   * @param {(to: string, payload: string) => void} o.send manda a chave embrulhada para a conexão `to`
   * @param {(owner: string) => void} [o.onKey] chegou a chave de alguém (vale pedir um quadro-chave)
   * @param {(owner: string) => void} [o.onAlive] chegou voz decifrada de alguém
   */
  constructor({ salt, send, onKey, onAlive }) {
    this.salt = salt;
    this.send = send;
    this.onKey = onKey;
    this.onAlive = onAlive;
    // id do usuário → { conn, pub, kek }
    this.peers = new Map();
    // Chaves que chegaram antes da chave pública de quem mandou.
    this.waiting = new Map();
    this.keyId = Math.floor(Math.random() * 200);
  }

  async init() {
    this.pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    this.publicKey = b64(await crypto.subtle.exportKey('raw', this.pair.publicKey));
    this.worker = new Worker(new URL('./mediaCrypt.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'alive') this.onAlive?.(data.owner);
    };
    await this.newSendKey(true);
    return this;
  }

  close() {
    this.closed = true;
    clearTimeout(this.rotateTimer);
    this.worker?.terminate();
    this.worker = null;
    this.peers.clear();
  }

  async newSendKey(use) {
    this.keyId = (this.keyId + 1) % 250;
    this.raw = crypto.getRandomValues(new Uint8Array(32));
    this.worker?.postMessage({ type: 'sendKey', id: this.keyId, raw: this.raw, use });
  }

  async kek(pub) {
    const theirs = await crypto.subtle.importKey('raw', unb64(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, this.pair.privateKey, 256);
    const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(this.salt), info: enc.encode(LABEL) },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /** Alguém na chamada (ou voltou com outra conexão): conhece a chave dele e manda a minha. */
  async setPeer(userId, conn, pub) {
    if (!userId || !pub || this.closed) return;
    const have = this.peers.get(userId);
    if (have && have.pub === pub) {
      have.conn = conn;
      return;
    }
    const peer = { conn, pub, kek: null };
    this.peers.set(userId, peer);
    try {
      peer.kek = await this.kek(pub);
    } catch (e) {
      console.warn('[cifra] chave pública inválida', e);
      return;
    }
    if (this.peers.get(userId) !== peer) return;
    await this.sendKeyTo(peer);
    const queued = this.waiting.get(userId);
    this.waiting.delete(userId);
    for (const payload of queued || []) await this.receive(userId, payload);
  }

  async sendKeyTo(peer) {
    if (!peer.kek || !peer.conn || this.closed) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new Uint8Array(33);
    plain[0] = this.keyId;
    plain.set(this.raw, 1);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, peer.kek, plain));
    const out = new Uint8Array(12 + sealed.length);
    out.set(iv);
    out.set(sealed, 12);
    this.send(peer.conn, b64(out));
  }

  /** Chegou a chave de mídia de alguém (embrulhada para mim). */
  async receive(userId, payload) {
    const peer = this.peers.get(userId);
    if (!peer?.kek) {
      const list = this.waiting.get(userId) || [];
      if (list.length < 4) list.push(payload);
      this.waiting.set(userId, list);
      return;
    }
    try {
      const raw = unb64(payload);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, peer.kek, raw.subarray(12)));
      this.worker?.postMessage({ type: 'key', owner: userId, id: plain[0], raw: plain.slice(1) });
      this.onKey?.(userId);
    } catch (e) {
      console.warn('[cifra] chave de mídia recusada', e);
    }
  }

  /** Saiu da chamada: a minha chave muda (quem saiu não decifra o que vier depois). */
  removePeer(userId) {
    if (!this.peers.delete(userId)) return;
    this.worker?.postMessage({ type: 'drop', owner: userId });
    clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(() => this.rotate(), 400);
  }

  async rotate() {
    if (this.closed) return;
    await this.newSendKey(false);
    for (const peer of this.peers.values()) await this.sendKeyTo(peer);
    const id = this.keyId;
    setTimeout(() => this.worker?.postMessage({ type: 'useSendKey', id }), SWITCH_AFTER_MS);
  }

  /** Uma trilha que chegou como `conn:<id>` é de `owner` (soube depois de quem ela era). */
  alias(alias, owner) {
    this.worker?.postMessage({ type: 'alias', alias, owner });
  }

  /** Cifra o que sai por este sender (conexão de envio com o SFU). */
  attachSender(sender, kind) {
    this.attach(sender, { op: 'encrypt', kind });
  }

  /** Decifra o que chega por este receiver, com as chaves de `owner` (id do usuário). */
  attachReceiver(receiver, kind, owner) {
    this.attach(receiver, { op: 'decrypt', kind, owner });
  }

  attach(target, options) {
    if (!this.worker || target.__crypt) return;
    target.__crypt = true;
    try {
      if (scriptTransform()) {
        target.transform = new RTCRtpScriptTransform(this.worker, options);
      } else {
        const { readable, writable } = target.createEncodedStreams();
        this.worker.postMessage({ type: 'transform', readable, writable, options }, [readable, writable]);
      }
    } catch (e) {
      console.warn('[cifra] transformação dos quadros', e);
    }
  }
}
