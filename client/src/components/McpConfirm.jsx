/**
 * Confirmações do assistente pedidas por outros programas do computador (o MCP do app do Windows; veja
 * `server/src/agent_mcp.rs`): as mesmas ações que o balão confirma — mandar mensagens, mudar o que é de todos,
 * apagar. Aparecem em todos os aparelhos da pessoa; responder num fecha nos outros (`agent:mcp-done`).
 */
import { useState } from 'react';
import { Check, X, Plug } from 'lucide-react';
import { useStore } from '../store.js';
import './agent.css';

export default function McpConfirm() {
  const asks = useStore((s) => s.mcpAsks) || [];
  const [busy, setBusy] = useState('');
  if (!asks.length) return null;
  const ask = asks[0];
  const answer = async (approve) => {
    const st = useStore.getState();
    setBusy(ask.id);
    try {
      await st.api().post(`/api/agent/mcp/confirm/${encodeURIComponent(ask.id)}`, { approve });
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy('');
      useStore.setState((s) => ({ mcpAsks: (s.mcpAsks || []).filter((a) => a.id !== ask.id) }));
    }
  };
  const detail = typeof ask.detail === 'string' ? ask.detail : '';
  return (
    <div className="mcp-confirm agent-confirm" role="alertdialog" aria-label="Confirmar a ação pedida por outro app">
      <b className="mcp-confirm-title">
        <Plug size={16} aria-hidden="true" /> Outro app quer usar o assistente
        {asks.length > 1 && <span className="mcp-confirm-more">+{asks.length - 1}</span>}
      </b>
      <span>{ask.label}</span>
      {detail && <pre>{detail}</pre>}
      <small className="kv">Pedido por um programa com IA ligado ao PadoSpeak pelo app do Windows (Configurações → Assistente → Outros apps).</small>
      <div className="agent-confirm-actions">
        <button className="btn" disabled={busy === ask.id} onClick={() => answer(true)}>
          <Check size={16} /> Permitir
        </button>
        <button className="btn ghost" disabled={busy === ask.id} onClick={() => answer(false)}>
          <X size={16} /> Recusar
        </button>
      </div>
    </div>
  );
}
