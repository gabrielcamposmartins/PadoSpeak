// Efeitos sonoros sintetizados com Web Audio (sem arquivos de áudio).
// Cada som é uma função (contexto, saída, instante) — a mesma usada para tocar no app e para gravar
// os arquivos de prévia (OfflineAudioContext).
let ctx = null;
let enabled = true;

const audio = () => {
  ctx ||= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
};

/**
 * Celular (principalmente iPhone): o áudio só pode começar dentro de um toque. Chamada no primeiro
 * toque na tela, deixa os sons prontos para os avisos que chegarem depois.
 */
export function unlockAudio() {
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

export const setSoundsEnabled = (on) => {
  enabled = on;
};

/** Um tom com envelope (ataque curto, decaimento exponencial); `to` faz a frequência deslizar. */
function tone(ac, out, t, freq, dur, { type = 'sine', volume = 0.12, attack = 0.012, to } = {}) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/**
 * Nota com timbre de marimba/sino: fundamental e parciais inarmônicos que somem rápido, como uma
 * lâmina batida. `echo` repete a nota mais baixa logo depois (o "brilho" dos avisos do Messenger).
 */
function mallet(ac, out, t, freq, dur, { volume = 0.12, echo = 0 } = {}) {
  for (const [ratio, level, decay] of [
    [1, 1, dur],
    [2.76, 0.35, dur * 0.35],
    [5.4, 0.12, dur * 0.18],
  ]) {
    tone(ac, out, t, freq * ratio, decay, { volume: volume * level, attack: 0.004 });
  }
  if (echo) tone(ac, out, t + 0.09, freq, dur * 0.8, { volume: volume * echo, attack: 0.004 });
}

/** Sequência de notas [frequência Hz, duração s]; devolve quando termina. */
function notes(ac, out, t, seq, { gap = 0.015, ...opts } = {}) {
  for (const [freq, dur] of seq) {
    tone(ac, out, t, freq, dur, opts);
    t += dur + gap;
  }
  return t;
}

/** Ruído curto filtrado (batida, estalo). */
function noise(ac, out, t, dur, { volume = 0.2, freq = 800, q = 1 } = {}) {
  const len = Math.ceil(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ac.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(out);
  src.start(t);
}

/** Opções de som do "chamar atenção" (a escolhida fica em `NUDGE_SOUND`). */
export const NUDGE_VARIANTS = {
  // 1. O atual: chocalho grave de onda quadrada e um sininho.
  chocalho: {
    name: 'Chocalho e sininho',
    play: (ac, out, t) => {
      const end = notes(
        ac,
        out,
        t,
        [
          [210, 0.05],
          [160, 0.05],
          [230, 0.05],
          [150, 0.05],
          [220, 0.05],
          [170, 0.05],
          [240, 0.05],
          [140, 0.08],
        ],
        { type: 'square', volume: 0.05, gap: 0.008 },
      );
      notes(
        ac,
        out,
        end + 0.04,
        [
          [1046.5, 0.08],
          [1318.5, 0.16],
        ],
        { type: 'triangle', volume: 0.1 },
      );
    },
  },
  // 2. Celular vibrando na mesa: zumbido grave com tremor, duas vezes.
  vibracao: {
    name: 'Celular vibrando',
    play: (ac, out, t) => {
      for (const start of [t, t + 0.42]) {
        const osc = ac.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 118;
        const lfo = ac.createOscillator();
        lfo.frequency.value = 32;
        const lfoGain = ac.createGain();
        lfoGain.gain.value = 0.045;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.06, start + 0.02);
        gain.gain.setValueAtTime(0.06, start + 0.28);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        lfo.connect(lfoGain).connect(gain.gain);
        osc.connect(lp).connect(gain).connect(out);
        osc.start(start);
        lfo.start(start);
        osc.stop(start + 0.36);
        lfo.stop(start + 0.36);
      }
    },
  },
  // 3. Batidas na porta: três toques secos e um "plim" de vidro.
  batidas: {
    name: 'Batidas na porta',
    play: (ac, out, t) => {
      [0, 0.14, 0.28].forEach((d) => {
        tone(ac, out, t + d, 190, 0.11, { volume: 0.22, attack: 0.003, to: 95 });
        noise(ac, out, t + d, 0.05, { volume: 0.35, freq: 1400, q: 0.8 });
      });
      tone(ac, out, t + 0.5, 1567.98, 0.35, { type: 'triangle', volume: 0.07 });
      tone(ac, out, t + 0.5, 3135.96, 0.25, { volume: 0.025 });
    },
  },
  // 4. Sininho de vidro: arpejo brilhante subindo, bem Aero.
  vidro: {
    name: 'Sininho de vidro',
    play: (ac, out, t) => {
      [1318.51, 1567.98, 2093.0, 2637.02].forEach((f, i) => {
        tone(ac, out, t + i * 0.07, f, 0.45, { type: 'triangle', volume: 0.075 });
        tone(ac, out, t + i * 0.07, f * 2, 0.25, { volume: 0.02 });
      });
      tone(ac, out, t + 0.32, 2093.0, 0.6, { type: 'sine', volume: 0.05 });
    },
  },
  // 5. Bolhas: estalos que sobem de tom, como bolhas estourando.
  bolhas: {
    name: 'Bolhas estourando',
    play: (ac, out, t) => {
      [
        [0, 320, 900],
        [0.09, 420, 1100],
        [0.18, 360, 1000],
        [0.27, 520, 1400],
        [0.36, 460, 1300],
      ].forEach(([d, from, to]) => tone(ac, out, t + d, from, 0.09, { volume: 0.14, attack: 0.004, to }));
      notes(
        ac,
        out,
        t + 0.55,
        [
          [1174.66, 0.08],
          [1567.98, 0.18],
        ],
        { type: 'triangle', volume: 0.08 },
      );
    },
  },
};

/** Som escolhido para o "chamar atenção". */
export const NUDGE_SOUND = 'bolhas';

export const SOUND_DEFS = {
  // Alguém entrou / saiu do canal de voz (ou eu mesmo).
  join: (ac, out, t) =>
    notes(ac, out, t, [
      [523.25, 0.09],
      [783.99, 0.16],
    ]),
  leave: (ac, out, t) =>
    notes(ac, out, t, [
      [659.25, 0.09],
      [392.0, 0.16],
    ]),
  // Começou / parou de transmitir a tela.
  streamStart: (ac, out, t) =>
    notes(
      ac,
      out,
      t,
      [
        [523.25, 0.07],
        [659.25, 0.07],
        [987.77, 0.14],
      ],
      { type: 'triangle', volume: 0.14 },
    ),
  streamStop: (ac, out, t) =>
    notes(
      ac,
      out,
      t,
      [
        [987.77, 0.07],
        [659.25, 0.07],
        [523.25, 0.14],
      ],
      { type: 'triangle', volume: 0.14 },
    ),
  // Mensagem nova: duas notas curtas subindo, de marimba, com um eco leve (no estilo do Messenger).
  message: (ac, out, t) => {
    mallet(ac, out, t, 1046.5, 0.22, { volume: 0.11 });
    mallet(ac, out, t + 0.11, 1568, 0.42, { volume: 0.12, echo: 0.25 });
  },
  // Chamada recusada / encerrada.
  callEnd: (ac, out, t) =>
    notes(
      ac,
      out,
      t,
      [
        [440, 0.12],
        [349.23, 0.2],
      ],
      { volume: 0.1 },
    ),
  // Toque de chamada recebida e o "chamando…" de quem liga.
  ring: (ac, out, t) =>
    notes(
      ac,
      out,
      t,
      [
        [659.25, 0.12],
        [783.99, 0.12],
        [659.25, 0.12],
        [783.99, 0.2],
      ],
      { type: 'triangle', volume: 0.1 },
    ),
  ringback: (ac, out, t) =>
    notes(
      ac,
      out,
      t,
      [
        [440, 0.35],
        [440, 0.35],
      ],
      { volume: 0.05, gap: 0.2 },
    ),
  nudge: (ac, out, t) => NUDGE_VARIANTS[NUDGE_SOUND].play(ac, out, t),
};

/** Últimos sons tocados (diagnóstico e testes): nome, quando e se o áudio estava liberado. */
export const soundLog = [];
if (typeof globalThis !== 'undefined') globalThis.__padospeakSounds = soundLog;

export function playSound(name) {
  if (!enabled || !SOUND_DEFS[name]) return;
  try {
    const ac = audio();
    soundLog.push({ name, at: Date.now(), state: ac.state });
    if (soundLog.length > 50) soundLog.shift();
    SOUND_DEFS[name](ac, ac.destination, ac.currentTime + 0.01);
  } catch {
    /* sem áudio disponível */
  }
}

/** Repete um som a cada `everyMs` até chamar a função devolvida. */
export function loopSound(name, everyMs = 2500) {
  playSound(name);
  const t = setInterval(() => playSound(name), everyMs);
  return () => clearInterval(t);
}
