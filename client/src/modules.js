/**
 * Módulos do PadoSpeak (veja `server/src/modules.rs`). O chat de texto é o núcleo e está sempre ligado; o
 * resto o dono do app liga e desliga (painel do administrador → Módulos) ou o servidor fixa pela variável
 * `MODULES`. Cada servidor conectado manda os dele no `/api/config` (`config.modules`) e avisa quando mudam
 * (`app:modules`).
 *
 * Este arquivo não importa nada do app (o store e as telas importam dele).
 */

/** O catálogo, na ordem do painel. `requires`: o módulo sem o qual este não funciona. */
export const MODULES = [
  {
    key: 'voice',
    name: 'Chamadas de voz e vídeo',
    desc: 'Canais de voz, chamadas nas conversas, câmera e compartilhamento de tela.',
  },
  { key: 'music', name: 'Música', desc: 'Fila de música nos canais de voz.', requires: 'voice' },
  { key: 'sounds', name: 'Sons rápidos', desc: 'Efeitos sonoros que todos na chamada ouvem.', requires: 'voice' },
  { key: 'roles', name: 'Cargos', desc: 'Cargos dentro dos servidores, com cor, etiqueta nos membros e permissões próprias.' },
  {
    key: 'agent',
    name: 'Assistente',
    desc: 'Um assistente de IA que faz o que a pessoa pedir, só com o acesso que ela já tem. Usa a chave da API da Anthropic.',
    off: true,
  },
];

const OFF_BY_DEFAULT = new Set(MODULES.filter((m) => m.off).map((m) => m.key));

/**
 * O módulo está ligado nesse servidor? `s` é o estado de uma conexão (o store principal ou o de outro
 * servidor). Servidor antigo, sem `modules`: tudo ligado (o assistente vinha em `config.agent`).
 */
export function moduleOn(s, key) {
  const m = s?.config?.modules;
  if (key === 'agent' && !m) return s?.config?.agent === true;
  if (OFF_BY_DEFAULT.has(key)) return m?.[key] === true;
  if (m) return m[key] !== false;
  return true;
}

export const voiceOn = (s) => moduleOn(s, 'voice');
export const musicOn = (s) => moduleOn(s, 'music');
export const soundsOn = (s) => moduleOn(s, 'sounds');
export const rolesOn = (s) => moduleOn(s, 'roles');

/** Os módulos depois das dependências (sem chamadas não há música nem sons), como o servidor guarda. */
export function normalizeModules(m) {
  const out = { ...m };
  for (const mod of MODULES) if (mod.requires && out[mod.requires] === false) out[mod.key] = false;
  return out;
}
