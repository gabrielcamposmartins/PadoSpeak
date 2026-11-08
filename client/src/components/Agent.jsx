/**
 * Módulo Assistente: o balão do agente (veja `server/src/agent.rs`). Abre pelo ícone no pé do trilho dos
 * servidores, por cima da tela que já está aberta, sem sair dela: cada pedido leva o que está na tela (o
 * servidor, o canal ou a conversa, quem está na voz, a chamada; `lib/agentContext.js`).
 *
 * Parece uma conversa: o que a pessoa pede, o que ele responde (com as fontes, quando pesquisou na internet)
 * e as ações que ele fez, com ✓ ou ✗. Ações que falam pelos outros (mensagem, notificação) ou mudam
 * o que é de todos aparecem num cartão para confirmar.
 *
 * O agente roda no servidor; enquanto ele trabalha, chega o que está fazendo (`agent:status`). Fechar o balão
 * não interrompe o pedido: ao abrir de novo, ele confere de tempos em tempos até o agente terminar.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sparkles, SendHorizontal, RotateCcw, Check, X, CircleCheck, CircleAlert, LoaderCircle, KeyRound, ShieldCheck, Eye, Globe, Settings } from 'lucide-react';
import { useStore } from '../store.js';
import { storage } from '../lib/api.js';
import { RichText } from './Emotes.jsx';
import { useLayout } from '../lib/layout.js';
import { requestContext, scopeLabel } from '../lib/agentContext.js';
import './agent.css';

const SUGGESTIONS = [
  'Resuma o que falaram hoje neste servidor',
  'Por que a chamada está travando?',
  'Mande no #geral que a partida de hoje foi adiada',
  'Pesquise na internet as novidades da semana sobre IA',
];

/** O tamanho que a pessoa deu ao balão (puxando a borda de cima, a do lado ou o canto), neste aparelho. */
const SIZE_KEY = 'padospeak.agentSize';
const MIN_W = 320;
const MIN_H = 340;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function savedSize() {
  try {
    const v = JSON.parse(storage.get(SIZE_KEY) || 'null');
    return v?.w > 0 && v?.h > 0 ? { w: v.w, h: v.h } : null;
  } catch {
    return null;
  }
}

/**
 * Redimensionar: o balão fica preso embaixo, junto do ícone, então cresce para cima e para o lado livre: para a
 * direita no trilho, para a esquerda no canto inferior direito (`grows`: 'right' | 'left').
 * `edge`: 'x' (a borda do lado), 'y' (a de cima) ou 'xy' (o canto entre elas). Dois cliques voltam ao padrão.
 */
function useResize(boxRef, grows) {
  const [size, setSize] = useState(savedSize);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const start = (edge) => (e) => {
    if (e.button !== 0 || !boxRef.current) return;
    e.preventDefault();
    const box = boxRef.current.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY, w: box.width, h: box.height };
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const dx = grows === 'left' ? from.x - ev.clientX : ev.clientX - from.x;
      const room = grows === 'left' ? box.right - 8 : window.innerWidth - box.left - 8;
      const w = edge.includes('x') ? clamp(from.w + dx, MIN_W, room) : from.w;
      const h = edge.includes('y') ? clamp(from.h - (ev.clientY - from.y), MIN_H, box.bottom - 8) : from.h;
      // o último tamanho já fica na ref: ao soltar, o React pode ainda não ter desenhado o último movimento
      sizeRef.current = { w: Math.round(w), h: Math.round(h) };
      setSize(sizeRef.current);
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (sizeRef.current) storage.set(SIZE_KEY, JSON.stringify(sizeRef.current));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  const reset = () => {
    setSize(null);
    storage.set(SIZE_KEY, null);
  };
  return { size, start, reset };
}

/**
 * Onde o balão fica, com a seta apontando para o ícone: ao lado do ícone do trilho (`rail`) ou logo acima do
 * botão flutuante do canto inferior direito (`float`). No celular (ou sem o ícone à vista), uma folha embaixo.
 */
function useAnchor(phone, place) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const btn = document.querySelector('[data-agent-toggle]');
      const r = btn?.getBoundingClientRect();
      if (phone || !r || !r.width) return setPos(null);
      if (place === 'float') {
        return setPos({ float: true, right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 12, arrow: r.width / 2 - 7 });
      }
      const bottom = Math.max(8, window.innerHeight - r.bottom - 6);
      setPos({ left: r.right + 14, bottom, arrow: r.height / 2 + 6 - 7 });
    };
    measure();
    // o ícone pode mudar de lugar no mesmo quadro (trocou a posição nas Configurações)
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('agent-fab-moved', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('agent-fab-moved', measure);
    };
  }, [phone, place]);
  return pos;
}

/**
 * A última conversa e o rascunho da caixa de mensagem, por pessoa, fora do balão: abrir de novo mostra na hora
 * o que já se sabia (e atualiza por trás), e o texto que estava sendo escrito não se perde ao fechar.
 */
const cacheKey = (kind) => `padospeak.agent${kind}:${useStore.getState().me?.id || ''}`;
const memory = { data: new Map(), draft: new Map() };
function loadCached(kind) {
  const key = cacheKey(kind);
  if (memory[kind === 'Cache' ? 'data' : 'draft'].has(key)) return memory[kind === 'Cache' ? 'data' : 'draft'].get(key);
  try {
    const raw = storage.get(key);
    if (kind === 'Cache') return raw ? JSON.parse(raw) : null;
    return raw || '';
  } catch {
    return kind === 'Cache' ? null : '';
  }
}
function saveCached(kind, value) {
  const key = cacheKey(kind);
  memory[kind === 'Cache' ? 'data' : 'draft'].set(key, value);
  try {
    if (kind === 'Cache') {
      // só o que a tela usa; sem as confirmações pendentes (podem ter mudado até a próxima abertura)
      const keep = value ? { ...value, pending: [], items: (value.items || []).slice(-60) } : null;
      const raw = keep ? JSON.stringify(keep) : null;
      storage.set(key, raw && raw.length < 400_000 ? raw : null);
    } else storage.set(key, value || null);
  } catch {
    /* sem armazenamento: vale só a memória */
  }
}

export default function AgentPopover() {
  const [data, setDataState] = useState(() => loadCached('Cache'));
  const setData = (d) => {
    saveCached('Cache', d);
    setDataState(d);
  };
  const [text, setTextState] = useState(() => loadCached('Draft'));
  const setText = (t) => {
    saveCached('Draft', t);
    setTextState(t);
  };
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState(null); // o que acabou de ser mandado, enquanto a resposta não vem
  const [error, setError] = useState(null);
  const status = useStore((s) => s.agentStatus);
  const isOwner = useStore((s) => Boolean(s.appAdmin?.owner));
  const scope = useStore(scopeLabel);
  const phone = useLayout() === 'phone';
  const place = useStore((s) => (s.prefs?.agentPlace === 'float' ? 'float' : 'rail'));
  const focusTick = useStore((s) => s.agentFocus);
  const pos = useAnchor(phone, place);
  const boxRef = useRef(null);
  const resize = useResize(boxRef, pos?.float ? 'left' : 'right');
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const api = () => useStore.getState().api();
  const close = () => useStore.getState().openAgent(false);

  const load = () =>
    api()
      .get('/api/agent')
      .then((d) => {
        setData(d);
        return d;
      })
      .catch((e) => setError(e.message));

  // o dono mudou quem usa a chave do app: confere de novo se dá para pedir
  const accessTick = useStore((s) => s.agentAccess);
  useEffect(() => {
    load();
  }, [accessTick]);

  // O cursor vai para a caixa de mensagem ao abrir e a cada atalho do assistente (a caixa só aceita o foco
  // depois que o estado do assistente chega).
  useEffect(() => {
    if (data?.ready) inputRef.current?.focus();
  }, [data?.ready, focusTick]);

  // Fecha como uma dica: Esc, ou um clique fora (o ícone do trilho abre e fecha sozinho).
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && close();
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target) || e.target.closest?.('[data-agent-toggle]')) return;
      // um menu, uma janela ou uma notificação por cima não contam como "fora"
      if (e.target.closest?.('.overlay, .ctx-menu, .toast')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, []);

  // voltou com o agente no meio de um pedido: confere até ele terminar
  useEffect(() => {
    if (!data?.busy || sending) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [data?.busy, sending]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data, draft, status]);

  const act = async (fn, shown = null) => {
    setError(null);
    setSending(true);
    setDraft(shown);
    try {
      const res = await fn();
      setData(res);
      if (res?.error) setError(res.error);
    } catch (e) {
      setError(e.message);
      load();
    } finally {
      setSending(false);
      setDraft(null);
      inputRef.current?.focus();
    }
  };

  const send = (value = text) => {
    const msg = value.trim();
    if (!msg || sending) return;
    setText('');
    act(() => api().post('/api/agent/messages', { text: msg, ...requestContext() }), msg);
  };
  const confirm = (approve) => act(() => api().post('/api/agent/confirm', { approve }));
  const reset = () => act(() => api().del('/api/agent'));
  // as configurações abrem numa janela: o balão sai da frente
  const openKeys = () => {
    close();
    useStore.getState().openModal({ type: 'settings', tab: 'assistente' });
  };

  const items = data?.items || [];
  const pending = data?.pending || [];
  const working = sending || data?.busy;
  // o tamanho escolhido, sem passar da tela (no celular, só a altura)
  const sz = resize.size;
  const style = pos
    ? {
        ...(pos.float ? { right: pos.right } : { left: pos.left }),
        bottom: pos.bottom,
        '--arrow': `${pos.arrow}px`,
        ...(sz
          ? {
              width: Math.min(sz.w, window.innerWidth - (pos.float ? pos.right : pos.left) - 8),
              height: Math.min(sz.h, window.innerHeight - pos.bottom - 8),
            }
          : null),
      }
    : sz
      ? { height: Math.min(sz.h, window.innerHeight - 16) }
      : undefined;
  const grip = (edge, label) => (
    <div
      className={`agent-resize ${edge}`}
      onPointerDown={resize.start(edge)}
      onDoubleClick={resize.reset}
      title={`${label} (dois cliques voltam ao tamanho padrão)`}
      aria-hidden="true"
    />
  );

  return (
    <div
      ref={boxRef}
      className={`agent-pop${pos ? ` anchored${pos.float ? ' float' : ''}` : ' sheet'}`}
      style={style}
      role="dialog"
      aria-label="Assistente"
    >
      {grip('y', 'Arraste para mudar a altura')}
      {pos && grip('x', 'Arraste para mudar a largura')}
      {pos && grip('xy', 'Arraste para mudar o tamanho')}
      <header className="agent-head">
        <span className="agent-avatar" aria-hidden="true">
          <Sparkles size={18} />
        </span>
        <div className="agent-title">
          <b>Assistente</b>
          <small>
            {data?.model ? (
              <button type="button" className="agent-model-chip" onClick={openKeys} title="Chave e modelo do assistente">
                {data.model}
                {data.ownKey ? ' · sua chave' : ''}
              </button>
            ) : (
              'Só com o acesso que você já tem'
            )}
          </small>
        </div>
        <button className="gloss round mini" onClick={reset} disabled={working || !items.length} title="Nova conversa (apaga esta)" aria-label="Nova conversa">
          <RotateCcw size={15} className="ico-blue" />
        </button>
        <button className="gloss round mini" onClick={openKeys} title="Configurações do assistente (sua chave e modelo)" aria-label="Configurações do assistente">
          <Settings size={15} className="ico-purple" />
        </button>
        <button className="gloss round mini" onClick={close} title="Fechar (Esc)" aria-label="Fechar o assistente">
          <X size={15} />
        </button>
      </header>
      {scope && (
        <div className="agent-scope" title="O que vai junto do seu pedido">
          <Eye size={13} aria-hidden="true" />
          <span>Vendo: {scope}</span>
        </div>
      )}

      <div className="agent-list" ref={listRef} aria-live="polite">
        {data && !data.ready && (
          <div className="agent-card">
            <KeyRound size={20} className="ico-purple" />
            <div>
              <b>{data.appBlocked ? 'O assistente não está liberado para você' : 'O assistente ainda não foi configurado'}</b>
              <p>
                {data.appBlocked
                  ? 'Quem usa o assistente é escolhido pelo administrador do app. Para usar, peça a liberação.'
                  : isOwner
                    ? 'Configure uma chave da API no painel do administrador, na aba Assistente.'
                    : 'O administrador do app ainda não configurou o assistente.'}
              </p>
              <div className="agent-confirm-actions">
                {isOwner && (
                  <button
                    className="btn"
                    onClick={() => {
                      close();
                      useStore.getState().goAdmin();
                    }}
                  >
                    Abrir o painel
                  </button>
                )}
                <button className="btn ghost" onClick={openKeys}>
                  Configurações do assistente
                </button>
              </div>
            </div>
          </div>
        )}
        {data?.ready && !items.length && !draft && !working && (
          <div className="agent-empty">
            <Sparkles size={28} className="ico-purple" />
            <p>
              Peça em português, como pediria a um amigo. Ele vê o que está na sua tela, lê os canais do servidor, analisa a
              chamada, pesquisa na internet e faz o que você pedir no app.
            </p>
            <p className="agent-note">
              <ShieldCheck size={14} /> Mensagens, notificações, remoções e mudanças que afetam os outros só acontecem depois
              que você confirma.
            </p>
            <div className="agent-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="gloss" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((m, i) => (
          <Bubble key={i} item={m} />
        ))}
        {draft && <Bubble item={{ role: 'user', text: draft }} />}
        {pending.length > 0 && !sending && (
          <div className="agent-confirm" role="alertdialog" aria-label="Confirmar as ações do assistente">
            <b>O assistente quer:</b>
            <ul>
              {pending.map((p) => (
                <li key={p.id}>
                  <span>{p.label}</span>
                  {p.detail && <pre>{p.detail}</pre>}
                </li>
              ))}
            </ul>
            <div className="agent-confirm-actions">
              <button className="btn" onClick={() => confirm(true)}>
                <Check size={16} /> Confirmar
              </button>
              <button className="btn ghost" onClick={() => confirm(false)}>
                <X size={16} /> Recusar
              </button>
            </div>
          </div>
        )}
        {working && (
          <div className="agent-status">
            <LoaderCircle size={16} className="spin" />
            {status || 'Pensando…'}
          </div>
        )}
        {error && (
          <div className="agent-error">
            <CircleAlert size={16} /> {error}
          </div>
        )}
      </div>

      <form
        className="agent-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          maxLength={8000}
          disabled={!data?.ready || data?.full}
          placeholder={data?.full ? 'Esta conversa ficou longa: comece uma nova' : pending.length ? 'Ou peça outra coisa (as ações acima não serão feitas)' : 'Peça alguma coisa…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="Mensagem para o assistente"
        />
        <button className="go round" type="submit" disabled={!text.trim() || working} title="Mandar" aria-label="Mandar">
          <SendHorizontal size={17} />
        </button>
      </form>
    </div>
  );
}

function Bubble({ item }) {
  const me = useStore((s) => s.me);
  if (item.role === 'user') {
    return (
      <div className="agent-msg mine">
        <div className="agent-bubble">
          <RichText text={item.text} me={me?.username} />
        </div>
      </div>
    );
  }
  return (
    <div className="agent-msg">
      <span className="agent-avatar small" aria-hidden="true">
        <Sparkles size={13} />
      </span>
      <div className="agent-body">
        {item.actions?.length > 0 && (
          <ul className="agent-actions">
            {item.actions.map((a, i) => (
              <li key={i} className={a.ok === false ? 'fail' : a.ok ? 'ok' : 'wait'}>
                {a.ok === false ? <CircleAlert size={13} /> : a.ok ? <CircleCheck size={13} /> : <LoaderCircle size={13} />}
                {a.label}
              </li>
            ))}
          </ul>
        )}
        {item.text && (
          <div className="agent-bubble">
            <RichText text={item.text} me={me?.username} />
          </div>
        )}
        {item.sources?.length > 0 && (
          <ul className="agent-sources" aria-label="Fontes">
            {item.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
                  <Globe size={12} aria-hidden="true" />
                  <span>{s.title || hostOf(s.url)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
