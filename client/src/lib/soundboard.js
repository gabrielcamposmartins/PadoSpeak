// Sons rápidos: baixa cada som uma vez (fica em cache decodificado) e toca com o volume escolhido, na
// saída de áudio escolhida nas configurações. Quem está ensurdecido não ouve (o store não chama).

const buffers = new Map(); // url -> Promise<AudioBuffer>
let ctx = null;
let master = null;
let sinkId = '';

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** No celular o áudio só começa depois de um toque: o primeiro toque deixa os sons prontos. */
export function unlockSoundboard() {
  try {
    const ac = audio();
    const src = ac.createBufferSource();
    src.buffer = ac.createBuffer(1, 1, 22050);
    src.connect(ac.destination);
    src.start(0);
  } catch {
    /* sem áudio */
  }
}

/** Saída de áudio (fone, caixa…) escolhida nas configurações. */
export function setSoundboardOutput(id) {
  sinkId = id || '';
  if (ctx?.setSinkId) ctx.setSinkId(sinkId).catch(() => {});
}

function load(url) {
  if (!buffers.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Som indisponível (${r.status})`);
        return r.arrayBuffer();
      })
      .then((data) => audio().decodeAudioData(data));
    p.catch(() => buffers.delete(url));
    buffers.set(url, p);
  }
  return buffers.get(url);
}

/** Baixa antes (botões do atalho), para tocar sem atraso. */
export function preloadSound(url) {
  load(url).catch(() => {});
}

const playing = new Set();

/** Toca um som (volume de 0 a 1). Devolve quando começa. */
export async function playSoundboard(url, volume = 0.8) {
  const ac = audio();
  if (sinkId && ac.setSinkId && ac.sinkId !== sinkId) ac.setSinkId(sinkId).catch(() => {});
  const buffer = await load(url);
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = Math.max(0, Math.min(1.5, volume));
  src.buffer = buffer;
  src.connect(gain).connect(master);
  src.start();
  playing.add(src);
  src.onended = () => playing.delete(src);
  return buffer.duration;
}

/** Para todos os sons (ensurdeceu, saiu da chamada). */
export function stopSoundboard() {
  for (const src of playing) {
    try {
      src.stop();
    } catch {
      /* já parou */
    }
  }
  playing.clear();
}

/** Duração de um arquivo de áudio escolhido para enviar (s), ou erro se não der para ler. */
export async function audioDuration(file) {
  const ac = audio();
  const buffer = await ac.decodeAudioData(await file.arrayBuffer());
  return buffer.duration;
}
