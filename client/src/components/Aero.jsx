// Peças do visual Aero: cena do céu (colinas, bolhas e raios de sol) e barra de título das janelas.
import { useId } from 'react';
import { X } from 'lucide-react';

/** Cena de fundo: o gradiente vem do tema (`--scene-bg`); estrelas e aurora só aparecem no escuro. */
/**
 * Flores e folhas soltas na faixa do topo (cenas Sakura, Ameixeira e Folhas verdes): uma camada da frente,
 * maior e com cor cheia, e uma de trás, pequena e clara, para dar profundidade. Sem galho.
 */
/** x, y, tamanho, giro — camada da frente. À esquerda de x≈400 fica o nome e o status: nada ali. */
const FRONT = [
  [1015, 30, 15, 10],
  [1185, 68, 13, -15],
  [865, 62, 12, -20],
  [705, 30, 13, 35],
  [565, 68, 11, 5],
  [470, 40, 10, 25],
  [1105, 14, 9, 50],
];
/** Camada de trás (menor e mais clara). */
const BACK = [
  [960, 76, 7, 20],
  [785, 16, 6, -10],
  [645, 52, 6, 40],
  [505, 20, 7, -25],
  [415, 74, 6, 15],
  [1245, 32, 6, 30],
  [905, 40, 5, -40],
  [1060, 84, 6, 10],
  [470, 84, 5, 55],
];
/** Pétalas (ou folhinhas) soltas, caindo. */
const LOOSE = [
  [935, 18, 20],
  [815, 84, -35],
  [605, 12, 60],
  [475, 58, -10],
  [1150, 44, 40],
  [430, 14, -50],
  [745, 74, 15],
];

/** Pétala apontando para cima a partir do centro; `notch`: com o recorte da sakura. */
const petal = (r, notch) =>
  notch
    ? `M0 0 C ${-r * 0.62} ${-r * 0.28}, ${-r * 0.58} ${-r * 0.96}, ${-r * 0.18} ${-r} L 0 ${-r * 0.84} L ${r * 0.18} ${-r} C ${r * 0.58} ${-r * 0.96}, ${r * 0.62} ${-r * 0.28}, 0 0 Z`
    : `M0 0 C ${-r * 0.68} ${-r * 0.22}, ${-r * 0.62} ${-r * 1.02}, 0 ${-r * 1.02} C ${r * 0.62} ${-r * 1.02}, ${r * 0.68} ${-r * 0.22}, 0 0 Z`;

/** Folha deitada para a direita a partir do cabinho, com nervura central e laterais. */
function Leaf({ l, id }) {
  const w = l * 0.24;
  return (
    <>
      <path d={`M${-l * 0.12} ${l * 0.02} L0 0`} stroke="#3c7a25" strokeWidth={l * 0.035} strokeLinecap="round" />
      <path
        d={`M0 0 C ${l * 0.22} ${-w}, ${l * 0.68} ${-w * 1.1}, ${l} 0 C ${l * 0.68} ${w * 1.05}, ${l * 0.22} ${w * 0.95}, 0 0 Z`}
        fill={`url(#${id}l)`}
        stroke="#2f6e22"
        strokeWidth={l * 0.018}
      />
      <path d={`M0 0 Q ${l * 0.5} ${-w * 0.1}, ${l * 0.94} 0`} fill="none" stroke="#e9ffd2" strokeOpacity=".55" strokeWidth={l * 0.022} />
      {[0.26, 0.46, 0.66].map((t) => (
        <g key={t} stroke="#e9ffd2" strokeOpacity=".4" strokeWidth={l * 0.014} fill="none">
          <path d={`M${l * t} ${-w * 0.04} Q ${l * (t + 0.1)} ${-w * 0.5}, ${l * (t + 0.2)} ${-w * 0.78}`} />
          <path d={`M${l * t} ${w * 0.04} Q ${l * (t + 0.1)} ${w * 0.5}, ${l * (t + 0.2)} ${w * 0.78}`} />
        </g>
      ))}
    </>
  );
}

/** Flor de cerejeira (pétalas recortadas, claras na ponta) ou de ameixeira (redondas, com muitos estames). */
function Flower({ r, kind, id }) {
  const sakura = kind === 'sakura';
  const angles = [0, 72, 144, 216, 288];
  const stamens = sakura ? [18, 70, 122, 174, 226, 278, 330] : [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <>
      {angles.map((t) => (
        <path key={t} d={petal(r, sakura)} transform={`rotate(${t})`} fill={`url(#${id}p)`} stroke={sakura ? '#f29bbb' : '#a8174a'} strokeWidth={r * 0.04} />
      ))}
      {sakura &&
        angles.map((t) => <path key={`v${t}`} d={`M0 ${-r * 0.22} L0 ${-r * 0.62}`} transform={`rotate(${t})`} stroke="#f48fb1" strokeWidth={r * 0.04} strokeLinecap="round" />)}
      <circle r={r * (sakura ? 0.2 : 0.24)} fill={sakura ? '#e2557f' : '#ffe9a8'} />
      {stamens.map((t) => {
        const len = r * (sakura ? 0.42 : 0.58);
        return (
          <g key={`s${t}`} transform={`rotate(${t})`}>
            <path d={`M0 ${-r * 0.12} L0 ${-len}`} stroke={sakura ? '#d84a76' : '#ffd23f'} strokeWidth={r * 0.035} strokeLinecap="round" />
            <circle cy={-len} r={r * (sakura ? 0.055 : 0.07)} fill={sakura ? '#b8174d' : '#ffb300'} />
          </g>
        );
      })}
    </>
  );
}

function Blooms({ kind }) {
  const id = useId().replace(/:/g, '');
  const leaves = kind === 'leaves';
  const item = (r) => (leaves ? <Leaf l={r * 2.6} id={id} /> : <Flower r={r} kind={kind} id={id} />);
  return (
    <g className={`blooms ${kind}`}>
      <defs>
        {kind === 'sakura' && (
          <linearGradient id={`${id}p`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#ff9fbf" />
            <stop offset=".45" stopColor="#ffd3e1" />
            <stop offset="1" stopColor="#fff6f9" />
          </linearGradient>
        )}
        {kind === 'plum' && (
          <linearGradient id={`${id}p`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#b3134a" />
            <stop offset=".55" stopColor="#e53d74" />
            <stop offset="1" stopColor="#ff8bb0" />
          </linearGradient>
        )}
        {leaves && (
          <linearGradient id={`${id}l`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#b7ec74" />
            <stop offset=".5" stopColor="#6cc24a" />
            <stop offset="1" stopColor="#3a8f2c" />
          </linearGradient>
        )}
      </defs>
      <g className="bloom-back">
        {BACK.map(([x, y, r, a]) => (
          <g key={x} transform={`translate(${x} ${y}) rotate(${leaves ? a * 3 : a})`}>
            {item(r)}
          </g>
        ))}
      </g>
      {LOOSE.map(([x, y, a]) => (
        <g key={x} className="bloom-loose" transform={`translate(${x} ${y}) rotate(${a})`}>
          {leaves ? <Leaf l={11} id={id} /> : <path d={petal(7, kind === 'sakura')} fill={`url(#${id}p)`} stroke={kind === 'sakura' ? '#f29bbb' : '#a8174a'} strokeWidth=".4" />}
        </g>
      ))}
      {FRONT.map(([x, y, r, a]) => (
        <g key={x} className="bloom-front" transform={`translate(${x} ${y}) rotate(${leaves ? a * 3 : a})`}>
          {item(r)}
        </g>
      ))}
    </g>
  );
}

export function SceneArt({ wide }) {
  // `wide`: a cena ocupa a tela toda (login); senão, é a faixa estreita do topo.
  return wide ? (
    <svg className="scene-art" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="sceneSun" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff" stopOpacity=".95" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="sceneBubW" cx=".5" cy=".5" r=".5">
          <stop offset=".55" stopColor="#fff" stopOpacity="0" />
          <stop offset=".9" stopColor="#fff" stopOpacity=".5" />
          <stop offset="1" stopColor="#fff" stopOpacity=".9" />
        </radialGradient>
      </defs>
      <g className="day-only">
        <circle cx="1040" cy="90" r="260" fill="url(#sceneSun)" />
        <path d="M1040 90 L760 800 L860 800 Z" fill="#fff" opacity=".09" />
        <path d="M1040 90 L960 800 L1080 800 Z" fill="#fff" opacity=".08" />
        <path d="M1040 90 L1200 800 L1300 800 Z" fill="#fff" opacity=".07" />
        <path d="M1040 90 L560 800 L620 800 Z" fill="#fff" opacity=".06" />
      </g>
      <g className="night-only">
        <path
          className="aurora"
          d="M200 180 C 420 90, 640 230, 860 150 S 1180 190, 1320 110 L1320 210 C 1180 290, 1000 220, 860 250 S 480 200, 200 280 Z"
        />
        <g fill="#fff">
          {[
            [120, 60, 1.4],
            [260, 120, 1],
            [380, 40, 1.2],
            [520, 90, 0.9],
            [660, 30, 1.3],
            [780, 110, 1],
            [900, 50, 1.1],
            [1010, 140, 0.8],
            [1150, 70, 1.3],
            [1230, 160, 1],
            [60, 200, 0.9],
            [340, 230, 1],
          ].map(([cx, cy, r]) => (
            <circle key={cx} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      </g>
      <path className="hill-b" d="M0 640 C 220 560, 460 580, 640 630 S 1020 600, 1280 540 L1280 800 L0 800 Z" />
      <path className="hill-a" d="M0 700 C 260 640, 520 650, 760 700 S 1120 690, 1280 660 L1280 800 L0 800 Z" />
      <path className="hill-edge" d="M0 700 C 260 640, 520 650, 760 700 S 1120 690, 1280 660" />
      <g className="bubbles">
        <circle cx="180" cy="200" r="46" />
        <circle cx="270" cy="330" r="22" />
        <circle cx="110" cy="420" r="14" />
        <circle cx="1120" cy="420" r="36" />
        <circle cx="1010" cy="520" r="16" />
        <circle cx="1210" cy="300" r="20" />
        <circle cx="880" cy="250" r="9" />
      </g>
      <g className="glints">
        <circle cx="164" cy="182" r="11" />
        <circle cx="263" cy="322" r="5" />
        <circle cx="1108" cy="406" r="8" />
      </g>
    </svg>
  ) : (
    <svg className="scene-art" viewBox="0 0 1280 96" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <g className="day-only">
        <path d="M760 -10 L860 96 L800 96 Z" fill="#fff" opacity=".13" />
        <path d="M880 -10 L1010 96 L940 96 Z" fill="#fff" opacity=".1" />
        <path d="M1000 -10 L1180 96 L1100 96 Z" fill="#fff" opacity=".08" />
      </g>
      <g className="night-only">
        <path
          className="aurora"
          d="M520 30 C 680 -10, 820 60, 960 22 S 1180 40, 1300 10 L1300 40 C 1180 70, 1060 46, 960 58 S 700 34, 520 62 Z"
        />
        <g fill="#fff">
          {[
            [560, 14, 1],
            [640, 40, 0.8],
            [700, 10, 1.2],
            [790, 30, 0.9],
            [860, 12, 1.1],
            [930, 44, 0.8],
            [1010, 8, 1],
            [1090, 30, 1.3],
            [1160, 12, 0.9],
            [1250, 34, 1],
            [470, 22, 0.8],
          ].map(([cx, cy, r]) => (
            <circle key={cx} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      </g>
      <path className="hill-b" d="M560 96 C 700 62, 860 58, 1010 74 S 1200 70, 1280 60 L1280 96 Z" />
      <path className="hill-a" d="M700 96 C 820 74, 960 70, 1090 82 S 1240 80, 1280 76 L1280 96 Z" />
      <path className="hill-edge" d="M700 96 C 820 74, 960 70, 1090 82 S 1240 80, 1280 76" />
      <g className="bubbles">
        <circle cx="1130" cy="30" r="16" />
        <circle cx="1180" cy="54" r="9" />
        <circle cx="1060" cy="18" r="7" />
        <circle cx="1230" cy="22" r="11" />
        <circle cx="990" cy="44" r="5" />
      </g>
      <g className="glints">
        <circle cx="1124" cy="24" r="4" />
        <circle cx="1177" cy="51" r="2.2" />
        <circle cx="1226" cy="18" r="2.8" />
      </g>
      <Blooms kind="sakura" />
      <Blooms kind="plum" />
      <Blooms kind="leaves" />
    </svg>
  );
}

/** Gorro do PadoSpeak em miniatura, para barras de título. */
export function MiniLogo({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#D93F3A" />
      <path
        d="M14 43C14 26 24 13.5 36 13.5C45.5 13.5 51.5 21 53.2 33L48.4 33.6C47.4 28.2 45 25 41.2 24.4C44.8 29.4 47.3 35.8 49.2 43Z"
        fill="#fff"
      />
      <rect x="10" y="40.5" width="44" height="11.5" rx="5.75" fill="#fff" />
    </svg>
  );
}

/** Barra de título de janela Aero (modais, avisos e chamada). */
export function TitleBar({ title = 'PadoSpeak', onClose, children }) {
  return (
    <div className="titlebar">
      <MiniLogo />
      <span className="tb-title">{title}</span>
      {children}
      {onClose && (
        <button type="button" className="tb-close" aria-label="Fechar" title="Fechar" onClick={onClose}>
          <X size={12} strokeWidth={2.6} />
        </button>
      )}
    </div>
  );
}

/** Ícone de "amigos" do botão Início (dois contatos, como no Messenger). */
export function BuddiesIcon() {
  return (
    <svg width="30" height="26" viewBox="0 0 30 26" aria-hidden="true" className="gel-glyph">
      <circle cx="19.5" cy="7" r="5" fill="#ffd3cf" stroke="#c4534c" strokeWidth="1.2" />
      <path d="M11 25c0-6 3.8-9.5 8.5-9.5S28 19 28 25z" fill="#ef8e8a" stroke="#c4534c" strokeWidth="1.2" />
      <circle cx="10" cy="9" r="5.5" fill="#d2ffbb" stroke="#3b8f1a" strokeWidth="1.2" />
      <path d="M1 25c0-6.5 4-10.5 9-10.5S19 18.5 19 25z" fill="#77d146" stroke="#3b8f1a" strokeWidth="1.2" />
    </svg>
  );
}
