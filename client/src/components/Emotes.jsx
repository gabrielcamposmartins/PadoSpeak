// Emoticons no estilo Aero (desenhos próprios em SVG, com brilho de vidro) e o texto formatado das mensagens.
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { plain, visibleLength, paletteOf, colorSpans, MENTION_RE, mentionsUser } from '../lib/text.js';
import { useStore } from '../store.js';

export { plain, visibleLength, mentionsUser };

const INK = '#6b3d00';
const line = { fill: 'none', stroke: INK, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const EYES = (
  <>
    <ellipse cx="11.5" cy="13" rx="1.8" ry="2.6" fill={INK} />
    <ellipse cx="20.5" cy="13" rx="1.8" ry="2.6" fill={INK} />
  </>
);
const SMILE = <path d="M9.5 18.5 Q16 25 22.5 18.5" {...line} />;
const FROWN = <path d="M10 22.5 Q16 17 22 22.5" {...line} />;
const CLOSED = (
  <>
    <path d="M9.5 13.5 Q11.5 15.5 13.5 13.5" {...line} />
    <path d="M18.5 13.5 Q20.5 15.5 22.5 13.5" {...line} />
  </>
);

/** Rosto com gradiente e reflexo; `tone` troca as cores (bravo, diabinho). */
function Face({ id, tone = ['#fff7c2', '#ffd84a', '#f2a300', '#c98200'], children, before }) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}f`} cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor={tone[0]} />
          <stop offset=".45" stopColor={tone[1]} />
          <stop offset="1" stopColor={tone[2]} />
        </radialGradient>
      </defs>
      {before}
      <circle cx="16" cy="16" r="14" fill={`url(#${id}f)`} stroke={tone[3]} strokeWidth="1.2" />
      <ellipse cx="16" cy="8.6" rx="8.6" ry="4.6" fill="#fff" opacity=".55" />
      {children}
    </>
  );
}

/** Forma com gradiente vertical brilhante (coração, estrela, nota…). */
function Glossy({ id, d, colors, stroke, gloss = [11, 10, 4, 2.6] }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={colors[0]} />
          <stop offset=".5" stopColor={colors[1]} />
          <stop offset="1" stopColor={colors[2]} />
        </linearGradient>
      </defs>
      <path d={d} fill={`url(#${id}g)`} stroke={stroke} strokeWidth="1.1" strokeLinejoin="round" />
      <ellipse cx={gloss[0]} cy={gloss[1]} rx={gloss[2]} ry={gloss[3]} fill="#fff" opacity=".6" />
    </>
  );
}

const HEART =
  'M16 28 C 6 20, 2 14, 5.5 8.5 C 8.5 4.5 13.5 5.5 16 9.5 C 18.5 5.5 23.5 4.5 26.5 8.5 C 30 14 26 20 16 28 Z';
const STAR = 'M16 2.5 L19.8 11.2 L29.2 11.9 L22 18 L24.3 27.3 L16 22.3 L7.7 27.3 L10 18 L2.8 11.9 L12.2 11.2 Z';

/** Código → desenho. A ordem é a da janela de emoticons. */
export const EMOTES = [
  { code: ':)', name: 'Sorriso', draw: (id) => <Face id={id}>{EYES}{SMILE}</Face> },
  {
    code: ':D',
    name: 'Risada',
    draw: (id) => (
      <Face id={id}>
        {EYES}
        <path d="M8.5 17.5 Q16 29 23.5 17.5 Z" fill="#7a2a00" />
        <path d="M10 18.2 Q16 19.8 22 18.2 L21.4 19.8 Q16 21.2 10.6 19.8 Z" fill="#fff" />
        <ellipse cx="16" cy="23.6" rx="3.4" ry="1.5" fill="#ff7a8a" />
      </Face>
    ),
  },
  {
    code: ';)',
    name: 'Piscadinha',
    draw: (id) => (
      <Face id={id}>
        <ellipse cx="11.5" cy="13" rx="1.8" ry="2.6" fill={INK} />
        <path d="M18.5 13.5 Q20.5 11.5 22.5 13.5" {...line} />
        {SMILE}
      </Face>
    ),
  },
  { code: ':(', name: 'Triste', draw: (id) => <Face id={id}>{EYES}{FROWN}</Face> },
  {
    code: ':P',
    name: 'Língua',
    draw: (id) => (
      <Face id={id}>
        {EYES}
        <path d="M14 19.6 Q14 25.5 16.5 25.5 Q19 25.5 19 19.6 Z" fill="#ff6f86" stroke="#c94a5a" strokeWidth=".8" />
        <path d="M10 19 Q16 21.5 22 19" {...line} />
      </Face>
    ),
  },
  {
    code: ':O',
    name: 'Surpreso',
    draw: (id) => (
      <Face id={id}>
        <ellipse cx="11.5" cy="12.5" rx="2" ry="3" fill={INK} />
        <ellipse cx="20.5" cy="12.5" rx="2" ry="3" fill={INK} />
        <ellipse cx="16" cy="21.5" rx="3" ry="3.6" fill="#7a2a00" />
      </Face>
    ),
  },
  {
    code: ':@',
    name: 'Bravo',
    draw: (id) => (
      <Face id={id} tone={['#ffd0b0', '#ff7a45', '#d8321a', '#a82410']}>
        <path d="M8 9.5 L13.5 12.2" {...line} strokeWidth="2.4" />
        <path d="M24 9.5 L18.5 12.2" {...line} strokeWidth="2.4" />
        <ellipse cx="11.8" cy="14.2" rx="1.6" ry="2" fill={INK} />
        <ellipse cx="20.2" cy="14.2" rx="1.6" ry="2" fill={INK} />
        {FROWN}
      </Face>
    ),
  },
  {
    code: '(H)',
    name: 'Descolado',
    draw: (id) => (
      <Face id={id}>
        <path
          d="M6.5 11.5 H25.5 V13.2 Q25 17.5 20.8 17.5 Q17.2 17.5 16.6 13.6 H15.4 Q14.8 17.5 11.2 17.5 Q7 17.5 6.5 13.2 Z"
          fill="#1b2a3a"
        />
        <path d="M8.5 12.8 L11 12.8 M19 12.8 L21.5 12.8" stroke="#9fd8ff" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M11 21.5 Q17 25 22 20" {...line} />
      </Face>
    ),
  },
  {
    code: ":'(",
    name: 'Chorando',
    draw: (id) => (
      <Face id={id}>
        {CLOSED}
        <path d="M10.6 16.5 Q8.8 20 10.6 21.6 Q12.4 20 10.6 16.5 Z" fill="#5cc8f5" stroke="#1a8fd6" strokeWidth=".6" />
        <path d="M21.4 16.5 Q19.6 20 21.4 21.6 Q23.2 20 21.4 16.5 Z" fill="#5cc8f5" stroke="#1a8fd6" strokeWidth=".6" />
        <path d="M11.5 24 Q16 20 20.5 24" {...line} />
      </Face>
    ),
  },
  {
    code: ':$',
    name: 'Envergonhado',
    draw: (id) => (
      <Face id={id}>
        <ellipse cx="11.5" cy="14" rx="1.6" ry="2.2" fill={INK} />
        <ellipse cx="20.5" cy="14" rx="1.6" ry="2.2" fill={INK} />
        <circle cx="8.3" cy="18.4" r="2.6" fill="#ff6f86" opacity=".6" />
        <circle cx="23.7" cy="18.4" r="2.6" fill="#ff6f86" opacity=".6" />
        <path d="M12.5 21.5 q1.75 -1.5 3.5 0 t3.5 0" {...line} />
      </Face>
    ),
  },
  {
    code: ':S',
    name: 'Confuso',
    draw: (id) => (
      <Face id={id}>
        {EYES}
        <path d="M9.5 21 q2.2 -2.5 4.3 0 t4.3 0 t4.3 0" {...line} />
      </Face>
    ),
  },
  {
    code: ':*',
    name: 'Beijo',
    draw: (id) => (
      <Face id={id}>
        <path d="M9.5 13.5 Q11.5 11.6 13.5 13.5" {...line} />
        <path d="M18.5 13.5 Q20.5 11.6 22.5 13.5" {...line} />
        <path d="M13.2 20.6 Q16 18.2 18.8 20.6 Q16 23 13.2 20.6 Z" fill="#e8305a" />
        <path d="M24 5.8 C 22.4 4.4 20.6 6.2 22.2 7.8 L24 9.6 L25.8 7.8 C 27.4 6.2 25.6 4.4 24 5.8 Z" fill="#ff4f6e" />
      </Face>
    ),
  },
  {
    code: '|-)',
    name: 'Com sono',
    draw: (id) => (
      <Face id={id}>
        <path d="M9.5 14 H13.5 M18.5 14 H22.5" {...line} />
        <ellipse cx="16" cy="21.5" rx="1.7" ry="1.4" fill="#7a2a00" />
        <path d="M22 3.5 h4 l-4 4 h4" fill="none" stroke="#1a8fd6" strokeWidth="1.5" strokeLinejoin="round" />
      </Face>
    ),
  },
  {
    code: '(A)',
    name: 'Anjo',
    draw: (id) => (
      <Face id={id}>
        {CLOSED}
        {SMILE}
        <ellipse cx="16" cy="3.4" rx="8" ry="2.2" fill="none" stroke="#ffe066" strokeWidth="2.2" />
        <ellipse cx="16" cy="3.4" rx="8" ry="2.2" fill="none" stroke="#c99a00" strokeWidth=".6" />
      </Face>
    ),
  },
  {
    code: '(6)',
    name: 'Diabinho',
    draw: (id) => (
      <Face
        id={id}
        tone={['#ff9a8a', '#e2331f', '#a8170b', '#7d1006']}
        before={
          <>
            <path d="M6.5 8 L4.5 0.8 L11.5 5 Z" fill="#7d1006" />
            <path d="M25.5 8 L27.5 0.8 L20.5 5 Z" fill="#7d1006" />
          </>
        }
      >
        <path d="M9 11 L13.5 13.5 M23 11 L18.5 13.5" {...line} stroke="#3a0a00" />
        <path d="M9 18.5 Q16 25 23 18.5" {...line} stroke="#3a0a00" />
      </Face>
    ),
  },
  {
    code: '*-)',
    name: 'Pensativo',
    draw: (id) => (
      <Face id={id}>
        <ellipse cx="10.8" cy="12.2" rx="1.7" ry="2.4" fill={INK} />
        <ellipse cx="19.8" cy="12.2" rx="1.7" ry="2.4" fill={INK} />
        <path d="M18 8.6 Q20.4 6.8 22.8 8.6" {...line} />
        <path d="M12 21.2 L20 20" {...line} />
      </Face>
    ),
  },
  {
    code: '(L)',
    name: 'Coração',
    draw: (id) => <Glossy id={id} d={HEART} colors={['#ff9aa8', '#e8243c', '#b3122a']} stroke="#8e0d20" />,
  },
  {
    code: '(U)',
    name: 'Coração partido',
    draw: (id) => (
      <>
        <Glossy id={id} d={HEART} colors={['#c9b3bb', '#a0505e', '#6e2a36']} stroke="#5a1e28" />
        <path d="M16 9.5 L14 14 L17.6 17 L14.8 21 L16.4 27" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      </>
    ),
  },
  {
    code: '(*)',
    name: 'Estrela',
    draw: (id) => <Glossy id={id} d={STAR} colors={['#fff3a0', '#ffc928', '#e09a00']} stroke="#b97800" gloss={[13, 11, 4, 2]} />,
  },
  {
    code: '(G)',
    name: 'Presente',
    draw: (id) => (
      <>
        <Glossy id={id} d="M6 14 H26 V27 Q26 29 24 29 H8 Q6 29 6 27 Z" colors={['#9ae4ff', '#1ea2e2', '#0a72b4']} stroke="#075a8e" gloss={[11, 17, 3.5, 1.6]} />
        <rect x="4.5" y="10" width="23" height="5" rx="1.5" fill="#5cc8f5" stroke="#075a8e" strokeWidth="1" />
        <rect x="14.4" y="10" width="3.2" height="19" fill="#e8243c" />
        <ellipse cx="12" cy="7.8" rx="4" ry="2.4" fill="none" stroke="#e8243c" strokeWidth="2.2" transform="rotate(-20 12 7.8)" />
        <ellipse cx="20" cy="7.8" rx="4" ry="2.4" fill="none" stroke="#e8243c" strokeWidth="2.2" transform="rotate(20 20 7.8)" />
      </>
    ),
  },
  {
    code: '(C)',
    name: 'Café',
    draw: (id) => (
      <>
        <path d="M22 15 Q28.5 15 28 19.5 Q27.5 24 22 23.5" fill="none" stroke="#7a95ab" strokeWidth="2.4" />
        <Glossy id={id} d="M5 12 H23 V25 Q23 29 19 29 H9 Q5 29 5 25 Z" colors={['#ffffff', '#e4f2fb', '#b8d3e6']} stroke="#7a95ab" gloss={[9, 17, 2, 4]} />
        <ellipse cx="14" cy="12.6" rx="8.2" ry="1.9" fill="#6b3d1a" />
        <path d="M10 9 q-2 -2.5 0 -5 M14.5 9 q-2 -2.5 0 -5 M19 9 q-2 -2.5 0 -5" fill="none" stroke="#9db3c4" strokeWidth="1.4" strokeLinecap="round" />
      </>
    ),
  },
  {
    code: '(8)',
    name: 'Música',
    draw: (id) => (
      <>
        <path d="M12.5 24 V8 L26 5 V20.5" fill="none" stroke="#0b74b8" strokeWidth="2.6" strokeLinejoin="round" />
        <Glossy id={id} d="M5.6 24 a3.9 3.4 0 1 0 7.8 0 a3.9 3.4 0 1 0 -7.8 0 Z" colors={['#9ae4ff', '#1ea2e2', '#0a72b4']} stroke="#075a8e" gloss={[8.4, 22.6, 1.6, 0.9]} />
        <ellipse cx="22.2" cy="20.5" rx="3.9" ry="3.4" fill="#1ea2e2" stroke="#075a8e" strokeWidth="1.1" />
        <ellipse cx="21.4" cy="19.2" rx="1.6" ry=".9" fill="#fff" opacity=".6" />
      </>
    ),
  },
  {
    code: '(F)',
    name: 'Flor',
    draw: (id) => (
      <>
        <path d="M16 18 V31" stroke="#3c9c15" strokeWidth="2.2" />
        <path d="M16 26 Q21 21 24 24 Q20 28 16 26 Z" fill="#6fd03b" />
        {[0, 72, 144, 216, 288].map((a) => (
          <circle
            key={a}
            cx={16 + 6 * Math.sin((a * Math.PI) / 180)}
            cy={12 - 6 * Math.cos((a * Math.PI) / 180)}
            r="4.6"
            fill="#ff8fc8"
            stroke="#d6418f"
            strokeWidth="1"
          />
        ))}
        <Glossy id={id} d="M12.6 12 a3.4 3.4 0 1 0 6.8 0 a3.4 3.4 0 1 0 -6.8 0 Z" colors={['#fff3a0', '#ffc928', '#e09a00']} stroke="#b97800" gloss={[15, 10.8, 1.4, 0.8]} />
      </>
    ),
  },
  {
    code: '(#)',
    name: 'Sol',
    draw: (id) => (
      <>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <path key={a} d="M16 1.5 L18.2 7 H13.8 Z" fill="#ff9d1c" transform={`rotate(${a} 16 16)`} />
        ))}
        <Glossy id={id} d="M7.5 16 a8.5 8.5 0 1 0 17 0 a8.5 8.5 0 1 0 -17 0 Z" colors={['#fff3a0', '#ffc928', '#f29000']} stroke="#c97300" gloss={[13.5, 11.5, 4, 2.2]} />
      </>
    ),
  },
  {
    code: '(V)',
    name: 'Certo',
    draw: (id) => (
      <Glossy
        id={id}
        d="M3.5 17.2 L9.4 11.6 L13.6 15.8 L22.8 4.8 L28.6 10.2 L13.8 27 Z"
        colors={['#e2ffb4', '#5fcf2a', '#2a930c']}
        stroke="#1f6e07"
        gloss={[21.5, 8.6, 2.6, 1.2]}
      />
    ),
  },
  {
    code: '(X)',
    name: 'Errado',
    draw: (id) => (
      <Glossy
        id={id}
        d="M5 10 L10 5 L16 11 L22 5 L27 10 L21 16 L27 22 L22 27 L16 21 L10 27 L5 22 L11 16 Z"
        colors={['#ffc9bf', '#f0452f', '#b3150b']}
        stroke="#860e06"
        gloss={[11.5, 8.8, 2.4, 1.1]}
      />
    ),
  },
  {
    code: '(PADO)',
    name: 'Gorro do Pado',
    draw: () => (
      <g transform="scale(.5)">
        <rect width="64" height="64" rx="16" fill="#D93F3A" />
        <path
          d="M14 43C14 26 24 13.5 36 13.5C45.5 13.5 51.5 21 53.2 33L48.4 33.6C47.4 28.2 45 25 41.2 24.4C44.8 29.4 47.3 35.8 49.2 43Z"
          fill="#fff"
        />
        <circle cx="51" cy="36.4" r="5.8" fill="#fff" stroke="#D93F3A" strokeWidth="2.6" />
        <rect x="10" y="40.5" width="44" height="11.5" rx="5.75" fill="#fff" stroke="#D93F3A" strokeWidth="2.6" />
        <ellipse cx="32" cy="14" rx="26" ry="12" fill="#fff" opacity=".35" />
      </g>
    ),
  },
];

const BY_CODE = new Map(EMOTES.map((e) => [e.code, e]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMOTE_RE = new RegExp(
  [...BY_CODE.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|'),
);

export function Emote({ code, size = 20 }) {
  const id = useId().replace(/:/g, '');
  const e = BY_CODE.get(code);
  if (!e) return code;
  return (
    <svg className="emote" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={e.name}>
      <title>{`${e.name} ${e.code}`}</title>
      {e.draw(id)}
    </svg>
  );
}

// ---------- Texto rico: formatação, cores, links e emoticons ----------

/** Cores da paleta de texto (ficam mais claras no tema escuro, via CSS). */
export const TEXT_COLORS = [
  ['#e2331f', 'Vermelho'],
  ['#e8781a', 'Laranja'],
  ['#c79100', 'Dourado'],
  ['#2e9e1a', 'Verde'],
  ['#0f9f9a', 'Aqua'],
  ['#1a7fc4', 'Azul'],
  ['#7b44c8', 'Roxo'],
  ['#d6418f', 'Rosa'],
];

/** `[cor=#hex]…[/cor]` com o `[/cor]` certo (pode haver outra cor dentro); sem par, o mais próximo. */
const COLOR_RULE_RE = /\[cor=(#[0-9a-fA-F]{6})\]([\s\S]+?)\[\/cor\]/;
const colorMatch = {
  exec(rest) {
    const lazy = COLOR_RULE_RE.exec(rest);
    if (!lazy) return null;
    const span = colorSpans(rest.slice(lazy.index)).find((s) => s.open === 0);
    if (!span || span.innerEnd === span.innerStart) return lazy;
    const whole = rest.slice(lazy.index, lazy.index + span.end);
    return Object.assign([whole, span.hex, whole.slice(span.innerStart, span.innerEnd)], { index: lazy.index });
  },
};

const FORMAT_RULES = [
  { re: colorMatch, color: true },
  { re: /\*\*([\s\S]+?)\*\*/, tag: 'b' },
  { re: /__([\s\S]+?)__/, tag: 'u' },
  { re: /~~([\s\S]+?)~~/, tag: 's' },
  { re: /\*(?=\S)([^*\n]*?\S)\*/, tag: 'i' },
];
const LINK_RULE = { re: /https?:\/\/[^\s<]+/, link: true };
const EMOTE_RULE = { re: EMOTE_RE, emote: true };
const MENTION_RULE = { re: MENTION_RE, mention: true };

function parse(text, opts, key = 'k') {
  const rules = [
    ...(opts.format ? FORMAT_RULES : []),
    ...(opts.links ? [LINK_RULE] : []),
    ...(opts.mentions ? [MENTION_RULE] : []),
    EMOTE_RULE,
  ];
  const out = [];
  let rest = text;
  let n = 0;
  while (rest) {
    let best = null;
    for (const rule of rules) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    const { rule, m } = best;
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${key}.${n++}`;
    if (rule.emote) out.push(<Emote key={k} code={m[0]} size={opts.emoteSize} />);
    else if (rule.mention) {
      const who = m[1].toLowerCase();
      const mine = who === 'everyone' || who === opts.me;
      out.push(
        <span key={k} className={`mention${who === 'everyone' ? ' everyone' : ''}${mine ? ' me' : ''}`}>
          {m[0]}
        </span>,
      );
    }
    else if (rule.link)
      out.push(
        <a key={k} href={m[0]} target="_blank" rel="noreferrer noopener">
          {m[0]}
        </a>,
      );
    else if (rule.color)
      out.push(
        <span key={k} className="tc" style={{ '--tc': m[1] }}>
          {parse(m[2], opts, k)}
        </span>,
      );
    else {
      const Tag = rule.tag;
      out.push(<Tag key={k}>{parse(m[1], opts, k)}</Tag>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out.map((x, i) => (typeof x === 'string' ? <Fragment key={`${key}t${i}`}>{x}</Fragment> : x));
}

/**
 * Mensagem: **negrito**, *itálico*, __sublinhado__, ~~riscado~~, [cor=#hex]…[/cor], links, emoticons e
 * menções (@usuario, @everyone — as que falam comigo, `me`, ficam mais fortes).
 */
export function RichText({ text, me }) {
  return parse(text, { format: true, links: true, mentions: true, me: me?.toLowerCase(), emoteSize: 22 });
}

/** Nome e mensagem pessoal: formatação, cores e emoticons (sem links). */
export function FormattedText({ text, size = 16 }) {
  if (!text) return null;
  return parse(String(text), { format: true, emoteSize: size });
}

/** Nomes e mensagens pessoais: só emoticons. */
export function EmojiText({ text, size = 16 }) {
  if (!text) return null;
  return parse(String(text), { emoteSize: size });
}

// ---------- Janelinhas flutuantes (emoticons, cores, status) ----------

/**
 * Janelinha presa a um botão (`anchorRef`), desenhada no <body> para não ser cortada pelos painéis de vidro.
 * Abre para cima quando cabe (ou `place="below"`); fecha ao clicar fora ou com Esc.
 */
export function Floating({ anchorRef, onClose, align = 'left', place = 'auto', className = '', children, ...rest }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    if (!a || !box) return;
    if (place === 'right') {
      // Ao lado do que foi clicado (como o perfil rápido de quem está na voz).
      const fits = a.right + 10 + box.width < window.innerWidth - 8;
      const left = fits ? a.right + 10 : Math.max(8, a.left - box.width - 10);
      setPos({ left, top: Math.max(8, Math.min(a.top - 10, window.innerHeight - box.height - 8)) });
      return;
    }
    const above = place === 'above' || (place === 'auto' && a.top > box.height + 12);
    const left =
      align === 'right' ? Math.max(8, a.right - box.width) : Math.min(a.left, window.innerWidth - box.width - 8);
    setPos({ left: Math.max(8, left), top: above ? a.top - box.height - 6 : a.bottom + 6 });
  }, [anchorRef, align, place]);
  useEffect(() => {
    const down = (e) => !ref.current?.contains(e.target) && !anchorRef.current?.contains(e.target) && onClose();
    const key = (e) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    const away = () => onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', away);
    };
  }, [anchorRef, onClose]);
  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Janela com a grade de emoticons. */
export function EmojiPicker({ anchorRef, onPick, onClose, align }) {
  return (
    <Floating anchorRef={anchorRef} onClose={onClose} align={align} className="emoji-picker" role="dialog" aria-label="Emoticons">
      <div className="popover-title">Emoticons</div>
      <div className="emoji-grid">
        {EMOTES.map((e) => (
          <button
            key={e.code}
            type="button"
            className="emoji-btn"
            title={`${e.name}  ${e.code}`}
            aria-label={e.name}
            onClick={() => onPick(e.code)}
          >
            <Emote code={e.code} size={26} />
          </button>
        ))}
      </div>
      <div className="popover-hint">Dica: digite o código, como :) ou (L)</div>
    </Floating>
  );
}

/** Nome de uma cor da paleta padrão (ou nada, se for outra). */
const colorName = (hex) => TEXT_COLORS.find(([h]) => h.toLowerCase() === hex.toLowerCase())?.[1];

/** Paleta de cores do texto. */
export function ColorPicker({ anchorRef, onPick, onClose }) {
  const [custom, setCustom] = useState('#3a8ee0');
  const palette = paletteOf(useStore((s) => s.prefs));
  const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
  const others = TEXT_COLORS.filter(([hex]) => !palette.some((p) => p.toLowerCase() === hex.toLowerCase()));
  return (
    <Floating anchorRef={anchorRef} onClose={onClose} className="color-picker" role="dialog" aria-label="Cor do texto">
      <div className="popover-title">Sua paleta</div>
      <div className="color-grid palette-grid">
        {palette.map((hex, i) => (
          <button
            key={i}
            type="button"
            className="color-swatch numbered"
            style={{ background: hex }}
            title={`${colorName(hex) || `Cor ${i + 1}`} (${mod}+${i + 1})`}
            aria-label={`${colorName(hex) || `Cor ${i + 1} da paleta`} (${mod}+${i + 1})`}
            onClick={() => onPick(hex)}
          >
            <span>{i + 1}</span>
          </button>
        ))}
      </div>
      {others.length > 0 && (
        <>
          <div className="popover-title">Outras</div>
          <div className="color-grid">
            {others.map(([hex, name]) => (
              <button
                key={hex}
                type="button"
                className="color-swatch"
                style={{ background: hex }}
                title={name}
                aria-label={name}
                onClick={() => onPick(hex)}
              />
            ))}
          </div>
        </>
      )}
      <div className="color-custom">
        <span className="color-well" style={{ '--sw': custom }} title="Outra cor">
          <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Outra cor" />
        </span>
        <button type="button" className="gloss small-btn" onClick={() => onPick(custom)}>
          Usar esta cor
        </button>
      </div>
    </Floating>
  );
}

/** Insere texto no lugar da seleção (ou no cursor) e deixa o cursor logo depois. */
export function insertText(el, value, setValue, text) {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  setValue(value.slice(0, start) + text + value.slice(end));
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    el.setSelectionRange(start + text.length, start + text.length);
  });
}

/** Insere/embrulha texto na seleção de um campo controlado e devolve o foco com a seleção certa. */
export function editField(el, value, setValue, before, after = '', placeholder = '') {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const selected = value.slice(start, end) || placeholder;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  setValue(next);
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    const a = start + before.length;
    el.setSelectionRange(after ? a : a + selected.length, a + selected.length);
  });
}
