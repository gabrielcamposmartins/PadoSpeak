// Cifra e decifra os quadros de áudio e vídeo que passam pelo nó de mídia (SFU): o nó só repassa e não
// consegue ouvir nem ver nada. Veja mediaCrypt.js (chaves) e server/src/media/sfu.rs.
//
// Quadro cifrado: [cabeçalho aberto][cifrado + tag][iv 12][keyId 1][0xE2]
// - Opus: o quadro inteiro é cifrado (cabeçalho vazio).
// - VP8: os 10 primeiros bytes (quadro-chave) ou 3 (os outros) ficam abertos. É por eles que o nó (str0m)
//   reconhece o quadro-chave e troca a camada do simulcast.
// - H.264: até o 2º byte da primeira fatia (NAL 1 ou 5) fica aberto (o nó reconhece o quadro-chave pelo tipo
//   da NAL). O resto ganha a prevenção de emulação (0x03 depois de dois zeros), para o empacotador não achar
//   um começo de NAL no meio do cifrado.
// - O último byte fixo (0xE2) evita que o quadro termine em zero (zeros no fim podem ser cortados).
// - Só os bytes abertos do VP8 e os 2 da fatia H.264 entram como dados autenticados: o SPS do H.264 e os
//   códigos de início podem ser reescritos no caminho.

const TAIL = 0xe2;
const IV = 12;
let sendKeys = new Map(); // id → CryptoKey
let sendId = null;
// dono (id do usuário) → id da chave → CryptoKey
const keys = new Map();
// Avisos de "estou ouvindo fulano" (no máximo um a cada 250 ms por dono).
const lastAlive = new Map();
// Trilha que chegou antes de se saber de quem ela é (`conn:<id>`) → o dono.
const aliases = new Map();

const importKey = (raw, usage) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usage);

self.onmessage = async ({ data: m }) => {
  if (m.type === 'sendKey') {
    sendKeys.set(m.id, await importKey(m.raw, ['encrypt']));
    if (m.use || sendId == null) sendId = m.id;
    // Guarda só as últimas.
    if (sendKeys.size > 4) sendKeys.delete(sendKeys.keys().next().value);
  } else if (m.type === 'useSendKey') {
    if (sendKeys.has(m.id)) sendId = m.id;
  } else if (m.type === 'key') {
    let ring = keys.get(m.owner);
    if (!ring) keys.set(m.owner, (ring = new Map()));
    ring.set(m.id, await importKey(m.raw, ['decrypt']));
    if (ring.size > 4) ring.delete(ring.keys().next().value);
  } else if (m.type === 'drop') {
    keys.delete(m.owner);
  } else if (m.type === 'alias') {
    aliases.set(m.alias, m.owner);
  } else if (m.type === 'transform') {
    // Chromium sem RTCRtpScriptTransform: as streams vêm transferidas da página.
    run(m.readable, m.writable, m.options);
  }
};

// RTCRtpScriptTransform (Safari, Firefox, Chrome novo).
self.onrtctransform = ({ transformer }) => run(transformer.readable, transformer.writable, transformer.options);

function run(readable, writable, options) {
  const fn = options.op === 'encrypt' ? (f, c) => encrypt(f, c, options) : (f, c) => decrypt(f, c, options);
  readable.pipeThrough(new TransformStream({ transform: fn })).pipeTo(writable).catch(() => {});
}

function isH264(frame, data) {
  const mime = frame.getMetadata?.().mimeType;
  if (mime) return /h264/i.test(mime);
  return data.length > 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
}

/** Onde começa a parte cifrada: o cabeçalho que fica aberto e quantos bytes dele autenticam. */
function header(frame, data, kind) {
  if (kind === 'audio') return { open: 0, aad: 0, h264: false };
  if (isH264(frame, data)) {
    for (let i = 0; i + 3 < data.length; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0) continue;
      let start = -1;
      if (data[i + 2] === 1) start = i + 3;
      else if (data[i + 2] === 0 && data[i + 3] === 1) start = i + 4;
      if (start < 0 || start >= data.length) continue;
      const type = data[start] & 0x1f;
      if (type === 1 || type === 5) return { open: Math.min(start + 2, data.length), aad: 2, h264: true };
      i = start - 1;
    }
    // Só parâmetros (SPS/PPS), sem fatia: nada de imagem para esconder.
    return { open: data.length, aad: 0, h264: true };
  }
  const open = Math.min(frame.type === 'key' ? 10 : 3, data.length);
  return { open, aad: open, h264: false };
}

/** Prevenção de emulação do H.264: um 0x03 antes de 0x00–0x03 que venha depois de dois zeros. */
/** Zeros seguidos no fim do cabeçalho aberto (a prevenção de emulação continua a contagem). */
function trailingZeros(bytes) {
  let n = 0;
  for (let i = bytes.length - 1; i >= 0 && bytes[i] === 0 && n < 2; i--) n++;
  return n;
}

export function escape(bytes, zeros = 0) {
  // No pior caso, um byte a mais a cada dois.
  const out = new Uint8Array(bytes.length + Math.ceil(bytes.length / 2) + 1);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (zeros >= 2 && b <= 3) {
      out[n++] = 3;
      zeros = 0;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

export function unescape(bytes, zeros = 0) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function encrypt(frame, controller, { kind }) {
  const key = sendId != null && sendKeys.get(sendId);
  // Sem chave ainda: não sai nada aberto.
  if (!key) return;
  const data = new Uint8Array(frame.data);
  const h = header(frame, data, kind);
  if (h.open >= data.length) {
    controller.enqueue(frame);
    return;
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const aad = data.subarray(h.open - h.aad, h.open);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, data.subarray(h.open)));
  let body = join(sealed, iv, Uint8Array.of(sendId, TAIL));
  if (h.h264) body = escape(body, trailingZeros(data.subarray(0, h.open)));
  frame.data = join(data.subarray(0, h.open), body).buffer;
  controller.enqueue(frame);
}

async function decrypt(frame, controller, { kind, owner: who }) {
  const owner = aliases.get(who) || who;
  const data = new Uint8Array(frame.data);
  const h = header(frame, data, kind);
  if (h.open >= data.length) {
    controller.enqueue(frame);
    return;
  }
  let body = data.subarray(h.open);
  if (h.h264) body = unescape(body, trailingZeros(data.subarray(0, h.open)));
  if (body.length < IV + 2 + 16 || body[body.length - 1] !== TAIL) return;
  const id = body[body.length - 2];
  const key = keys.get(owner)?.get(id);
  if (!key) {
    self.postMessage({ type: 'missing', owner });
    return;
  }
  const iv = body.subarray(body.length - 2 - IV, body.length - 2);
  try {
    const aad = data.subarray(h.open - h.aad, h.open);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, body.subarray(0, body.length - 2 - IV)));
    frame.data = join(data.subarray(0, h.open), plain).buffer;
  } catch {
    return;
  }
  controller.enqueue(frame);
  if (kind === 'audio') {
    const now = Date.now();
    if (now - (lastAlive.get(owner) || 0) > 250) {
      lastAlive.set(owner, now);
      self.postMessage({ type: 'alive', owner });
    }
  }
}

// Para os testes (o worker não usa).
export { encrypt, decrypt, header };
