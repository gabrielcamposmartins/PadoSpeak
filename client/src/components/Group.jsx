// Cabeçalho de lista que encolhe (Conversas, Amigos online, Canais de texto e de voz, Membros…). A escolha
// fica guardada neste aparelho, por lista.
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const KEY = 'padospeak.collapsed';
const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
};

/** `[recolhida, alternar]` da lista `id` (ex.: `dms`, `text:<servidor>`). */
export function useCollapsed(id) {
  const [all, setAll] = useState(read);
  const collapsed = Boolean(all[id]);
  const toggle = () => {
    const next = { ...read() };
    if (collapsed) delete next[id];
    else next[id] = 1;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
    setAll(next);
  };
  return [collapsed, toggle];
}

/** O título é um botão: clicar recolhe ou mostra a lista. `children`: botões ao lado (ex.: "+"). */
export function GroupHeader({ title, collapsed, onToggle, children }) {
  return (
    <div className="grp">
      <button type="button" className="grp-toggle" aria-expanded={!collapsed} onClick={onToggle} title={collapsed ? 'Mostrar' : 'Recolher'}>
        <ChevronDown size={12} className="grp-chevron" />
        <span className="grp-title">{title}</span>
      </button>
      {children}
    </div>
  );
}
