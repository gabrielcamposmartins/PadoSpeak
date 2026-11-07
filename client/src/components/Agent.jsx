/**
 * Assistente: a conversa com o agente (veja `server/src/agent.rs`). Parece uma conversa direta com
 * alguém: o que a pessoa pede, o que ele responde e as ações que ele fez, com ✓ ou ✗. Ações que falam pelos
 * outros (mensagem, notificação) ou mudam o que é de todos aparecem num cartão para confirmar.
 *
 * O agente roda no servidor; enquanto ele trabalha, chega o que está fazendo (`agent:status`). Se a pessoa
 * sai e volta no meio, a tela confere de tempos em tempos até ele terminar.
 */
import { useEffect, useRef, useState } from 'react';
import { Sparkles, SendHorizontal, RotateCcw, Check, X, CircleCheck, CircleAlert, LoaderCircle, KeyRound, ShieldCheck } from 'lucide-react';
import { useStore } from '../store.js';
import { RichText } from './Emotes.jsx';
import { MobileBack } from './Mobile.jsx';
import { useLayout } from '../lib/layout.js';
import './agent.css';

const SUGGESTIONS = [
  'Mande no #geral que a partida de hoje foi adiada',
  'Quais mensagens falaram de “churrasco” esta semana?',
  'Crie um canal de voz chamado Jogos neste servidor',
  'Mude o app para o tema escuro',
];

/** O contexto que vai junto do pedido: hora do aparelho e onde a pessoa estava. */
function requestContext() {
  const s = useStore.getState();
  const now = new Date();
  return {
    localTime: now.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' }),
    tzOffset: -now.getTimezoneOffset(),
    guildId: s.agentFrom?.guildId || null,
    channelId: s.agentFrom?.channelId || null,
  };
}

export default function Agent() {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState(null); // o que acabou de ser mandado, enquanto a resposta não vem
  const [error, setError] = useState(null);
  const status = useStore((s) => s.agentStatus);
  const isOwner = useStore((s) => Boolean(s.appAdmin?.owner));
  const phone = useLayout() === 'phone';
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const api = () => useStore.getState().api();

  const load = () =>
    api()
      .get('/api/agent')
      .then((d) => {
        setData(d);
        return d;
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
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
  const openKeys = () => useStore.getState().openModal({ type: 'settings', tab: 'assistente' });

  const items = data?.items || [];
  const pending = data?.pending || [];
  const working = sending || data?.busy;

  return (
    <div className="agent-chat">
      <header className="agent-head">
        {phone && <MobileBack />}
        <span className="agent-avatar" aria-hidden="true">
          <Sparkles size={22} />
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
              'Faz o que você pedir no app, só com o acesso que você já tem'
            )}
          </small>
        </div>
        <button className="gloss tool" onClick={reset} disabled={working || !items.length} title="Apagar esta conversa e começar outra">
          <RotateCcw size={18} className="ico-blue" />
          Nova conversa
        </button>
      </header>

      <div className="agent-list" ref={listRef} aria-live="polite">
        {data && !data.ready && (
          <div className="agent-card glass">
            <KeyRound size={20} className="ico-purple" />
            <div>
              <b>O assistente ainda não foi configurado</b>
              <p>
                {isOwner
                  ? 'Ponha uma chave da API da Anthropic no painel do administrador, na aba Assistente (ou só para você, em Configurações → Assistente).'
                  : 'O administrador ainda não pôs uma chave da API. Se você tiver a sua, dá para usar o assistente com ela.'}
              </p>
              <div className="agent-confirm-actions">
                {isOwner && (
                  <button className="btn" onClick={() => useStore.getState().goAdmin()}>
                    Abrir o painel
                  </button>
                )}
                <button className={isOwner ? 'btn ghost' : 'btn'} onClick={openKeys}>
                  Pôr a minha chave
                </button>
              </div>
            </div>
          </div>
        )}
        {data?.ready && !items.length && !draft && !working && (
          <div className="agent-empty">
            <Sparkles size={34} className="ico-purple" />
            <p>
              Peça em português, como pediria a um amigo. O assistente manda e apaga mensagens, cria e apaga canais e servidores,
              ajusta permissões, pesquisa, fixa e favorita mensagens, mexe na música e na aparência do app.
            </p>
            <p className="agent-note">
              <ShieldCheck size={14} /> Mensagens, notificações, remoções e mudanças que afetam os outros só acontecem depois que você confirma.
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
          <div className="agent-confirm glass" role="alertdialog" aria-label="Confirmar as ações do assistente">
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
        className="agent-compose glass"
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
          placeholder={data?.full ? 'Esta conversa ficou longa: comece uma nova' : pending.length ? 'Ou peça outra coisa (as ações acima não serão feitas)' : 'Peça alguma coisa ao assistente…'}
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
          <SendHorizontal size={18} />
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
        <Sparkles size={14} />
      </span>
      <div className="agent-body">
        {item.actions?.length > 0 && (
          <ul className="agent-actions">
            {item.actions.map((a, i) => (
              <li key={i} className={a.ok === false ? 'fail' : a.ok ? 'ok' : 'wait'}>
                {a.ok === false ? <CircleAlert size={14} /> : a.ok ? <CircleCheck size={14} /> : <LoaderCircle size={14} />}
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
      </div>
    </div>
  );
}
