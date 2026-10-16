// Ícones dos sons rápidos no estilo Frutiger Aero: desenhos brilhantes (gradiente + reflexo) num único
// <svg> com os símbolos, montado uma vez no app; cada botão usa `<use href="#snd-…">`.

/** Ícones que um som pode ter (o id vai para o servidor) e o nome mostrado na escolha. */
export const SOUND_ICONS = [
  ['horn', 'Buzina'],
  ['clap', 'Aplausos'],
  ['drum', 'Tambor'],
  ['laugh', 'Risada'],
  ['cricket', 'Grilo'],
  ['cloud', 'Chuva'],
  ['bell', 'Sino'],
  ['star', 'Estrela'],
  ['heart', 'Coração'],
  ['boom', 'Explosão'],
];

/** Cores de gel dos botões. */
export const SOUND_TONES = [
  ['aqua', 'Aqua'],
  ['lime', 'Grama'],
  ['sun', 'Sol'],
  ['coral', 'Coral'],
  ['violet', 'Ametista'],
  ['teal', 'Lagoa'],
  ['sky', 'Céu'],
];

export function SoundIcon({ icon, className = 'snd-ico' }) {
  const id = ['plus', 'orb', 'speaker', 'speaker-off'].includes(icon) || SOUND_ICONS.some(([k]) => k === icon) ? icon : 'horn';
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <use href={`#snd-${id}`} />
    </svg>
  );
}

/** Os desenhos (uma vez na página). */
export function SoundSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="sg-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff6c2" />
          <stop offset=".5" stopColor="#ffc928" />
          <stop offset="1" stopColor="#d98a00" />
        </linearGradient>
        <linearGradient id="sg-red" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc1b5" />
          <stop offset=".5" stopColor="#f0503d" />
          <stop offset="1" stopColor="#b3150b" />
        </linearGradient>
        <linearGradient id="sg-peach" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff0dc" />
          <stop offset=".55" stopColor="#ffc58f" />
          <stop offset="1" stopColor="#e48a4a" />
        </linearGradient>
        <linearGradient id="sg-yellow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff7c2" />
          <stop offset=".55" stopColor="#ffd84a" />
          <stop offset="1" stopColor="#e09a00" />
        </linearGradient>
        <linearGradient id="sg-green" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e2ffb4" />
          <stop offset=".5" stopColor="#5fcf2a" />
          <stop offset="1" stopColor="#2a930c" />
        </linearGradient>
        <linearGradient id="sg-silver" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".5" stopColor="#dbe7f0" />
          <stop offset="1" stopColor="#9fb4c6" />
        </linearGradient>
        <linearGradient id="sg-cloud" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".6" stopColor="#d4e2ee" />
          <stop offset="1" stopColor="#8ea6bd" />
        </linearGradient>
        <linearGradient id="sg-drop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c4f1ff" />
          <stop offset="1" stopColor="#1e90e0" />
        </linearGradient>
        <linearGradient id="sg-pink" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd0dc" />
          <stop offset=".5" stopColor="#ff4f7a" />
          <stop offset="1" stopColor="#c01445" />
        </linearGradient>
        <radialGradient id="sg-boom" cx=".5" cy=".5" r=".55">
          <stop offset="0" stopColor="#fffbe0" />
          <stop offset=".45" stopColor="#ffd23a" />
          <stop offset="1" stopColor="#f2611c" />
        </radialGradient>
        <radialGradient id="sg-orb" cx=".5" cy=".35" r=".7">
          <stop offset="0" stopColor="#e6fbff" />
          <stop offset=".5" stopColor="#4fc0f2" />
          <stop offset="1" stopColor="#0a6fb0" />
        </radialGradient>

        <symbol id="snd-orb" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="url(#sg-orb)" stroke="#0a5f99" strokeWidth="1" />
          <path d="M11.5 12.5h3l4-3.5v14l-4-3.5h-3z" fill="#fff" />
          <path d="M21 12.5q2.4 3.5 0 7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
          <ellipse cx="16" cy="8.5" rx="9" ry="4.2" fill="#fff" opacity=".55" />
        </symbol>
        <symbol id="snd-speaker-box" viewBox="0 0 32 32">
          <rect x="3.5" y="4.5" width="15" height="23" rx="3.5" fill="url(#sg-silver)" stroke="#6f8aa3" strokeWidth="1" />
          <circle cx="11" cy="19.5" r="5.2" fill="url(#sg-orb)" stroke="#0a5f99" strokeWidth="1" />
          <circle cx="11" cy="19.5" r="1.9" fill="#0a5f99" opacity=".75" />
          <circle cx="11" cy="10" r="2.5" fill="url(#sg-orb)" stroke="#0a5f99" strokeWidth=".8" />
          <path d="M6 7h10" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity=".9" />
          <ellipse cx="9.4" cy="17.6" rx="2.2" ry="1.2" fill="#fff" opacity=".6" />
        </symbol>
        <symbol id="snd-speaker" viewBox="0 0 32 32">
          <use href="#snd-speaker-box" />
          <path d="M22 12.5q2.4 3.5 0 7" fill="none" stroke="#1e90e0" strokeWidth="2" strokeLinecap="round" />
          <path d="M25.2 9.5q4.6 6.5 0 13" fill="none" stroke="#1e90e0" strokeWidth="2" strokeLinecap="round" opacity=".8" />
        </symbol>
        <symbol id="snd-speaker-off" viewBox="0 0 32 32">
          <use href="#snd-speaker-box" />
          <circle cx="25" cy="16" r="5.6" fill="url(#sg-red)" stroke="#8e0f07" strokeWidth="1" />
          <path d="M22.8 13.8l4.4 4.4M27.2 13.8l-4.4 4.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </symbol>
        <symbol id="snd-horn" viewBox="0 0 32 32">
          <path d="M12 13 L24 6.5 Q29.5 4.5 29.5 16 Q29.5 27.5 24 25.5 L12 19 Z" fill="url(#sg-gold)" stroke="#a86a00" strokeWidth="1" />
          <ellipse cx="27" cy="16" rx="2.4" ry="8.5" fill="#b87800" opacity=".55" />
          <circle cx="7.5" cy="16" r="5.5" fill="url(#sg-red)" stroke="#8e0f07" strokeWidth="1" />
          <ellipse cx="6.2" cy="13.6" rx="2.6" ry="1.5" fill="#fff" opacity=".7" />
          <path d="M14 13.5 L23 8.8" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity=".75" />
        </symbol>
        <symbol id="snd-clap" viewBox="0 0 32 32">
          <g transform="rotate(-18 13 18)">
            <rect x="6" y="8" width="11" height="18" rx="5.5" fill="url(#sg-peach)" stroke="#b5642a" strokeWidth="1" />
            <ellipse cx="10" cy="12" rx="2.4" ry="3.6" fill="#fff" opacity=".6" />
          </g>
          <g transform="rotate(18 19 18)">
            <rect x="15" y="8" width="11" height="18" rx="5.5" fill="url(#sg-peach)" stroke="#b5642a" strokeWidth="1" />
            <ellipse cx="19" cy="12" rx="2.4" ry="3.6" fill="#fff" opacity=".6" />
          </g>
          <path d="M5 5l2 3M16 2.5v3.5M27 5l-2 3" stroke="#ffd84a" strokeWidth="2" strokeLinecap="round" />
        </symbol>
        <symbol id="snd-drum" viewBox="0 0 32 32">
          <ellipse cx="25" cy="7" rx="6" ry="2" fill="url(#sg-gold)" stroke="#a86a00" strokeWidth=".8" />
          <path d="M25 9v6" stroke="#8a96a3" strokeWidth="1.4" />
          <path d="M5 16v8q0 4 10 4t10-4v-8" fill="url(#sg-red)" stroke="#8e0f07" strokeWidth="1" />
          <ellipse cx="15" cy="16" rx="10" ry="4" fill="url(#sg-silver)" stroke="#7b8fa2" strokeWidth="1" />
          <ellipse cx="12" cy="15" rx="5" ry="1.4" fill="#fff" opacity=".8" />
          <path d="M3 6l9 9M10 3l5 11" stroke="#d9a35e" strokeWidth="2" strokeLinecap="round" />
          <path d="M8 21v5M22 21v5" stroke="#fff" strokeWidth="1.2" opacity=".55" />
        </symbol>
        <symbol id="snd-laugh" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="13" fill="url(#sg-yellow)" stroke="#c98200" strokeWidth="1" />
          <ellipse cx="12" cy="8.5" rx="6" ry="3.2" fill="#fff" opacity=".6" />
          <path d="M8.5 12.5q2.5-2.5 5 0M18.5 12.5q2.5-2.5 5 0" fill="none" stroke="#6b3d00" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M8.5 17.5 Q16 28 23.5 17.5 Z" fill="#7a2a00" />
          <path d="M10 18.2 Q16 19.6 22 18.2 L21.5 19.6 Q16 21 10.5 19.6 Z" fill="#fff" />
          <path d="M4.5 13.5q-2 3 0 4.5q2-1.5 0-4.5M27.5 13.5q-2 3 0 4.5q2-1.5 0-4.5" fill="url(#sg-drop)" />
        </symbol>
        <symbol id="snd-cricket" viewBox="0 0 32 32">
          <path d="M4 26 Q16 9 28 26 Z" fill="url(#sg-green)" stroke="#1f6e07" strokeWidth="1" opacity=".9" />
          <ellipse cx="17" cy="18" rx="8.5" ry="4.5" fill="url(#sg-green)" stroke="#1f6e07" strokeWidth="1" />
          <circle cx="8.5" cy="16.5" r="3.2" fill="url(#sg-green)" stroke="#1f6e07" strokeWidth="1" />
          <circle cx="7.6" cy="15.8" r=".9" fill="#10324d" />
          <path d="M7.5 13.5Q5 7 2 6M9.5 13.5Q10 7 13 4.5" fill="none" stroke="#2a7a0c" strokeWidth="1.1" strokeLinecap="round" />
          <path d="M20 21.5l4 4.5M15 22l-1.5 4" stroke="#1f6e07" strokeWidth="1.4" strokeLinecap="round" />
          <ellipse cx="16" cy="16" rx="4" ry="1.3" fill="#fff" opacity=".6" />
          <path d="M24 7q2 1 2 3M27 5q3 2 3 5" fill="none" stroke="#9de6ff" strokeWidth="1.4" strokeLinecap="round" />
        </symbol>
        <symbol id="snd-cloud" viewBox="0 0 32 32">
          <path d="M8 20 a5 5 0 0 1 1-9.9 a7 7 0 0 1 13.4 1.5 a4.3 4.3 0 0 1 1.6 8.4 Z" fill="url(#sg-cloud)" stroke="#6c86a0" strokeWidth="1" />
          <ellipse cx="14" cy="11" rx="5" ry="2" fill="#fff" opacity=".8" />
          <path
            d="M10 23q-1.5 2.5 0 3.5q1.5-1 0-3.5M16 24q-1.5 2.5 0 3.5q1.5-1 0-3.5M22 23q-1.5 2.5 0 3.5q1.5-1 0-3.5"
            fill="url(#sg-drop)"
            stroke="#1878c0"
            strokeWidth=".6"
          />
        </symbol>
        <symbol id="snd-bell" viewBox="0 0 32 32">
          <path d="M16 4 Q24 4 24.5 13 L25.5 21 Q27 23 27 24.5 H5 Q5 23 6.5 21 L7.5 13 Q8 4 16 4 Z" fill="url(#sg-gold)" stroke="#a86a00" strokeWidth="1" />
          <circle cx="16" cy="27" r="2.6" fill="url(#sg-gold)" stroke="#a86a00" strokeWidth=".8" />
          <path d="M11 8.5 Q13 6 16 6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".85" />
          <path d="M28 7q2 2 2 5M4 7q-2 2-2 5" fill="none" stroke="#9de6ff" strokeWidth="1.4" strokeLinecap="round" />
        </symbol>
        <symbol id="snd-star" viewBox="0 0 32 32">
          <path d="M16 2.5 L19.8 11.2 L29.2 11.9 L22 18 L24.3 27.3 L16 22.3 L7.7 27.3 L10 18 L2.8 11.9 L12.2 11.2 Z" fill="url(#sg-gold)" stroke="#b97800" strokeWidth="1.1" strokeLinejoin="round" />
          <ellipse cx="13.5" cy="11.5" rx="4" ry="2" fill="#fff" opacity=".65" />
        </symbol>
        <symbol id="snd-heart" viewBox="0 0 32 32">
          <path d="M16 28 C 6 20, 2 14, 5.5 8.5 C 8.5 4.5 13.5 5.5 16 9.5 C 18.5 5.5 23.5 4.5 26.5 8.5 C 30 14 26 20 16 28 Z" fill="url(#sg-pink)" stroke="#9e1036" strokeWidth="1.1" />
          <ellipse cx="11" cy="10" rx="3.6" ry="2.2" fill="#fff" opacity=".65" />
        </symbol>
        <symbol id="snd-boom" viewBox="0 0 32 32">
          <path
            d="M16 1.5 L19 10 L27.5 5.5 L23 13.5 L30.5 16 L23 18.5 L27.5 26.5 L19 22 L16 30.5 L13 22 L4.5 26.5 L9 18.5 L1.5 16 L9 13.5 L4.5 5.5 L13 10 Z"
            fill="url(#sg-boom)"
            stroke="#c7470c"
            strokeWidth="1"
            strokeLinejoin="round"
          />
          <ellipse cx="13.5" cy="12.5" rx="4" ry="2.2" fill="#fff" opacity=".7" />
        </symbol>
        <symbol id="snd-plus" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".6" />
          <path d="M16 11v10M11 16h10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </symbol>
      </defs>
    </svg>
  );
}
