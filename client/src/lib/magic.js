// Palavras com efeito nas mensagens: "stars"/"estrelas", "bubbles"/"bolhas", "confete"/"confetti" e
// "arco-íris"/"rainbow" (a palavra inteira, sem diferenciar maiúsculas). A palavra aparece colorida e,
// ao abrir a conversa com ela ou passar o mouse por cima, sobem partículas pela janela (o arco-íris
// cruza a janela de um canto ao outro). Não aparece em nenhuma tela do app: só está documentado no README.
// Quem pediu menos movimento no sistema vê só a palavra colorida.

/** Palavra → efeito. */
const WORDS = {
  stars: 'stars',
  estrelas: 'stars',
  bubbles: 'bubbles',
  bolhas: 'bubbles',
  confete: 'confetti',
  confetti: 'confetti',
  'arco-íris': 'rainbow',
  'arco-iris': 'rainbow',
  rainbow: 'rainbow',
};

/** A palavra sozinha (sem letra, número, "_" ou "-" grudado antes ou depois). */
export const MAGIC_RE = /(?<![\p{L}\p{N}_-])(stars|estrelas|bubbles|bolhas|confetti|confete|arco-[íi]ris|rainbow)(?![\p{L}\p{N}_-])/iu;

export const magicKind = (word) => WORDS[word.toLowerCase()] || null;

/** Emoticons e stickers com o mesmo efeito das palavras (código do emoticon → efeito). */
const EMOTES = { '(ESTRELAS)': 'stars', '(BOLHAS)': 'bubbles', '(CONFETE)': 'confetti', '(ARCOIRIS)': 'rainbow' };
export const magicEmoteKind = (code) => EMOTES[code] || null;

/** Efeitos dos emoticons num texto (inclusive um sticker `[sticker:emote:(BOLHAS)]`). */
export function magicEmotesIn(text) {
  const found = new Set();
  for (const [code, kind] of Object.entries(EMOTES)) if (String(text || '').includes(code)) found.add(kind);
  return found;
}

/** Efeitos que aparecem num texto (para tocar ao abrir a conversa). */
export function magicIn(text) {
  const found = new Set();
  const re = new RegExp(MAGIC_RE.source, 'giu');
  for (const m of String(text || '').matchAll(re)) found.add(magicKind(m[1]));
  return found;
}

const RAINBOW = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#32ade6', '#5856d6', '#af52de'];
const CONFETTI = ['#5ac8fa', '#ff2d55', '#ffcc00', '#34c759', '#af52de', '#ff9500'];
const running = new Set();
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (a, b) => a + Math.random() * (b - a);

const STAR = (color) =>
  `<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="${color}" stroke="#c98a00" stroke-width="0.8" stroke-linejoin="round" d="M12 1.8l3.1 6.4 7 1-5.1 4.9 1.2 7-6.2-3.3-6.2 3.3 1.2-7L1.9 9.2l7-1z"/></svg>`;

/** Uma camada por cima de tudo, que não recebe cliques; some sozinha no fim. */
function layer(ms) {
  const el = document.createElement('div');
  el.className = 'magic-layer';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

/**
 * Partículas subindo do pé da janela. Estrelas e bolhas sobem balançando de um lado para o outro; o confete
 * sai do centro de baixo e se abre em leque, do reto para cima até a diagonal dos cantos, girando.
 */
function rise(kind) {
  const total = kind === 'confetti' ? 2600 : 3800;
  const el = layer(total + 200);
  const count = { stars: 45, bubbles: 38, confetti: 80 }[kind];
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    const size = kind === 'confetti' ? rand(12, 18) : kind === 'bubbles' ? rand(34, 60) : rand(20, 34);
    p.className = `magic-p ${kind}`;
    p.style.left = kind === 'confetti' ? `calc(50% + ${rand(-24, 24)}px)` : `${rand(2, 96)}%`;
    p.style.width = `${size}px`;
    p.style.height = `${kind === 'confetti' ? size * 0.55 : size}px`;
    if (kind === 'stars') p.innerHTML = STAR(Math.random() < 0.7 ? '#ffd60a' : '#ffe680');
    if (kind === 'confetti') p.style.background = CONFETTI[i % CONFETTI.length];
    el.appendChild(p);
    if (kind === 'confetti') {
      // Qualquer direção do leque: reto para o topo, na diagonal até os cantos, ou no meio do caminho.
      const dx = rand(-0.62, 0.62) * w;
      const spin = rand(360, 900) * (Math.random() < 0.5 ? -1 : 1);
      const dur = rand(1200, 1900);
      p.animate(
        [
          { transform: 'translate(0, 0) rotate(0deg) scale(0.5)', opacity: 0 },
          { transform: `translate(${dx * 0.3}px, ${-h * 0.3}px) rotate(${spin * 0.3}deg) scale(1)`, opacity: 1, offset: 0.15 },
          { transform: `translate(${dx * 0.75}px, ${-h * 0.75}px) rotate(${spin * 0.75}deg) scale(1)`, opacity: 1, offset: 0.7 },
          { transform: `translate(${dx}px, ${-h - 60}px) rotate(${spin}deg) scale(0.9)`, opacity: 0 },
        ],
        { duration: dur, delay: rand(0, total - dur), easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'both' },
      );
      continue;
    }
    const sway = rand(-60, 60);
    const spin = kind === 'stars' ? rand(-140, 140) : 0;
    const dur = rand(2200, 3200);
    p.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg) scale(0.6)', opacity: 0 },
        { transform: `translate(${sway * 0.4}px, ${-h * 0.25}px) rotate(${spin * 0.3}deg) scale(1)`, opacity: 1, offset: 0.2 },
        { transform: `translate(${-sway * 0.5}px, ${-h * 0.65}px) rotate(${spin * 0.7}deg) scale(1)`, opacity: 0.9, offset: 0.65 },
        { transform: `translate(${sway}px, ${-h - 60}px) rotate(${spin}deg) scale(${kind === 'bubbles' ? 1.15 : 0.9})`, opacity: 0 },
      ],
      { duration: dur, delay: rand(0, total - dur), easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'both' },
    );
  }
  return total;
}

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** Espuminha (nuvem fofa) no pé do arco-íris, centrada em (x, y); `s` é a escala. */
function foam(x, y, s) {
  const g = svgEl('g', { class: 'magic-foam' });
  const puffs = [
    [-46, 6, 20],
    [-26, -12, 24],
    [0, -20, 28],
    [27, -10, 24],
    [48, 6, 19],
    [-14, 10, 22],
    [16, 10, 22],
  ];
  for (const [cx, cy, r] of puffs) g.appendChild(svgEl('circle', { cx: x + cx * s, cy: y + cy * s, r: r * s }));
  return g;
}

/**
 * Arco-íris: as cores se desenham do canto esquerdo ao direito, misturadas umas nas outras (desfocadas), com
 * uma espuminha em cada ponta; fica um pouco e some.
 */
function arc() {
  const total = 3400;
  const draw = 1500;
  const el = layer(total + 200);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const band = Math.max(9, Math.min(20, w / 64));
  const foot = h - Math.max(18, h * 0.04);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, class: 'magic-arc' });
  const defs = svgEl('defs');
  const blur = svgEl('filter', { id: 'magic-rb-blur', x: '-10%', y: '-10%', width: '120%', height: '120%' });
  blur.appendChild(svgEl('feGaussianBlur', { stdDeviation: band * 0.55 }));
  defs.appendChild(blur);
  svg.appendChild(defs);
  const bands = svgEl('g', { filter: 'url(#magic-rb-blur)' });
  RAINBOW.forEach((color, i) => {
    const off = band * 1.5 + i * band;
    const path = svgEl('path', {
      d: `M ${off} ${foot} A ${w / 2 - off} ${foot * 0.8 - off} 0 0 1 ${w - off} ${foot}`,
      stroke: color,
      'stroke-width': band * 1.25,
      fill: 'none',
      pathLength: '1',
    });
    path.style.strokeDasharray = '1';
    bands.appendChild(path);
    path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: draw, delay: i * 40, easing: 'ease-in-out', fill: 'both' });
  });
  svg.appendChild(bands);
  // Espuminhas: a da esquerda aparece com o começo do arco; a da direita, quando ele chega lá.
  const s = band / 13;
  const mid = band * 1.5 + band * 3;
  [
    [foam(mid, foot, s), 0],
    [foam(w - mid, foot, s), draw - 250],
  ].forEach(([g, delay]) => {
    svg.appendChild(g);
    g.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], {
      duration: 450,
      delay,
      easing: 'ease-out',
      fill: 'both',
    });
  });
  el.appendChild(svg);
  svg.animate([{ opacity: 0.9 }, { opacity: 0.9, offset: 0.75 }, { opacity: 0 }], { duration: total, fill: 'both' });
  return total;
}

/** Toca o efeito (um de cada vez por tipo: passar o mouse de novo no meio não empilha). */
export function playMagic(kind) {
  if (!kind || running.has(kind) || reduced() || typeof document === 'undefined') return;
  running.add(kind);
  const ms = kind === 'rainbow' ? arc() : rise(kind);
  setTimeout(() => running.delete(kind), ms);
}

/** Cada letra de uma cor (arco-íris). */
export const rainbowColor = (i) => RAINBOW[i % RAINBOW.length];
