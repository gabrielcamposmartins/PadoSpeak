// Logo do PadoSpeak: gorro de Natal branco sobre vermelho pastel (mesmo desenho de assets/logo.svg).
export default function Logo({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="PadoSpeak" role="img">
      <rect width="64" height="64" rx="16" fill="#D93F3A" />
      <path
        d="M14 43C14 26 24 13.5 36 13.5C45.5 13.5 51.5 21 53.2 33L48.4 33.6C47.4 28.2 45 25 41.2 24.4C44.8 29.4 47.3 35.8 49.2 43Z"
        fill="#fff"
      />
      <circle cx="51" cy="36.4" r="5.8" fill="#fff" stroke="#D93F3A" strokeWidth="2.6" />
      <rect x="10" y="40.5" width="44" height="11.5" rx="5.75" fill="#fff" stroke="#D93F3A" strokeWidth="2.6" />
    </svg>
  );
}
