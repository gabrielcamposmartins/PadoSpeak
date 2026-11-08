import { useEffect, useState } from 'react';
import { ChartBar, Check, Plus, X, Lock, Clock } from 'lucide-react';
import { useStore, parsePoll, POLL_TAG } from '../store.js';
import { ConnProvider, useConn } from './conn.jsx';
import { plain } from './Emotes.jsx';

export const MAX_OPTIONS = 10;
const MAX_QUESTION = 300;
const MAX_OPTION = 100;
/** Quanto tempo a enquete fica aberta (horas; 0 = até alguém encerrar). */
const DURATIONS = [
  [1, '1 hora'],
  [4, '4 horas'],
  [8, '8 horas'],
  [24, '24 horas'],
  [72, '3 dias'],
  [168, '1 semana'],
  [0, 'Sem prazo'],
];

/** "em 5 min", "em 3 h", "em 2 dias" até `ts`. */
function timeLeft(ts, now) {
  const min = Math.max(1, Math.round((ts - now) / 60000));
  if (min < 60) return `em ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `em ${h} h`;
  return `em ${Math.round(h / 24)} dias`;
}

/** Hora de agora, que anda sozinha (a enquete fecha na hora certa sem precisar de outra mensagem). */
function useNow(every = 30000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** Janela "Criar enquete" (botão acima da caixa de texto, só nos canais de texto dos servidores). */
export function PollModal({ close, channelId, channelName, conn }) {
  return (
    <ConnProvider conn={conn}>
      <PollForm close={close} channelId={channelId} channelName={channelName} />
    </ConnProvider>
  );
}

function PollForm({ close, channelId, channelName }) {
  const useC = useConn();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const folded = filled.map((o) => o.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, ''));
  const repeated = new Set(folded).size !== folded.length;
  const ready = question.trim() && filled.length >= 2 && !repeated;
  const setOption = (i, v) => setOptions((list) => list.map((o, j) => (j === i ? v : o)));
  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    const content = `${POLL_TAG}\n${JSON.stringify({ q: question.trim(), o: filled, m: multiple, h: hours })}`;
    const ok = await useC.getState().sendMessage(channelId, content);
    setBusy(false);
    if (ok) close();
  };
  return (
    <form onSubmit={submit}>
      <div className="modal-body poll-form">
        <h2>Criar enquete</h2>
        <p className="sub">Em #{channelName}. Todo mundo do canal pode votar e ver o resultado.</p>
        <label className="field">
          <span>Pergunta</span>
          <input
            autoFocus
            value={question}
            maxLength={MAX_QUESTION}
            placeholder="Qual jogo hoje à noite?"
            onChange={(e) => setQuestion(e.target.value)}
            required
          />
        </label>
        <div className="field" role="group" aria-label="Opções">
          <span>Opções</span>
          <div className="poll-form-options">
            {options.map((o, i) => (
              <div key={i} className="poll-form-option">
                <input
                  value={o}
                  maxLength={MAX_OPTION}
                  placeholder={`Opção ${i + 1}`}
                  aria-label={`Opção ${i + 1}`}
                  onChange={(e) => setOption(i, e.target.value)}
                  onKeyDown={(e) => {
                    // Enter na última opção cria a próxima.
                    if (e.key === 'Enter' && i === options.length - 1 && o.trim() && options.length < MAX_OPTIONS) {
                      e.preventDefault();
                      setOptions((list) => [...list, '']);
                      setTimeout(() => e.target.closest('.poll-form-options')?.querySelector('.poll-form-option:last-child input')?.focus());
                    }
                  }}
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    className="gloss mini"
                    title="Tirar esta opção"
                    aria-label={`Tirar a opção ${i + 1}`}
                    onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {options.length < MAX_OPTIONS && (
            <button type="button" className="btn ghost poll-add" onClick={() => setOptions((list) => [...list, ''])}>
              <Plus size={14} /> Adicionar opção
            </button>
          )}
          {repeated && <small className="error-text">Há duas opções iguais.</small>}
        </div>
        <label className="field">
          <span>Duração</span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {DURATIONS.map(([h, label]) => (
              <option key={h} value={h}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
          <span>Permitir várias respostas</span>
        </label>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button className="btn" disabled={!ready || busy}>
          Publicar enquete
        </button>
      </div>
    </form>
  );
}

/** A enquete dentro da mensagem: as opções com as barras dos votos; clicar vota (ou tira o voto). */
export function PollView({ m, me, canEnd, readOnly = false }) {
  const useC = useConn();
  const users = useC((s) => s.users);
  const members = useC((s) => s.guildData[s.currentGuildId]?.members);
  const now = useNow();
  const def = parsePoll(m.content);
  const poll = m.poll || (def && { ...def, options: def.options.map((text) => ({ text, users: [] })), voters: 0, closed: false });
  if (!poll) return null;
  const closed = poll.closed || (poll.endsAt != null && poll.endsAt <= now);
  const mine = poll.options.flatMap((o, i) => (o.users.includes(me.id) ? [i] : []));
  const total = poll.options.reduce((n, o) => n + o.users.length, 0);
  const top = Math.max(0, ...poll.options.map((o) => o.users.length));
  const nameOf = (id) => {
    if (id === me.id) return 'Você';
    const u = users[id] || members?.find((x) => x.id === id) || (m.author.id === id ? m.author : null);
    return u ? plain(u.displayName) || u.username : 'alguém';
  };
  const pick = (i) => {
    if (closed || readOnly) return;
    let next;
    if (poll.multiple) next = mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i].sort((a, b) => a - b);
    else next = mine.length === 1 && mine[0] === i ? [] : [i];
    useC.getState().votePoll(m.id, next);
  };
  const end = () =>
    useStore.getState().openModal({
      type: 'confirm',
      title: 'Encerrar a enquete?',
      text: 'Ninguém mais vai poder votar, e o resultado fica como está.',
      confirmLabel: 'Encerrar',
      action: () => useC.getState().endPoll(m.id),
    });
  const status = closed
    ? 'Encerrada'
    : poll.endsAt
      ? `Termina ${timeLeft(poll.endsAt, now)}`
      : 'Sem prazo';
  return (
    <div className={`poll${closed ? ' closed' : ''}`} role="group" aria-label={`Enquete: ${poll.question}`}>
      <div className="poll-head">
        <ChartBar size={15} className="poll-ico" aria-hidden="true" />
        <span className="poll-q">{poll.question}</span>
      </div>
      <div className="poll-hint">
        {closed ? 'Resultado final' : poll.multiple ? 'Escolha uma ou mais respostas' : 'Escolha uma resposta'}
      </div>
      <div className="poll-options">
        {poll.options.map((o, i) => {
          const n = o.users.length;
          const pct = total ? Math.round((n / total) * 100) : 0;
          const chosen = mine.includes(i);
          const winner = closed && n > 0 && n === top;
          const who = n ? o.users.slice(0, 12).map(nameOf).join(', ') + (n > 12 ? ` e mais ${n - 12}` : '') : 'Ninguém votou nesta ainda';
          return (
            <button
              key={i}
              type="button"
              className={`poll-option${chosen ? ' mine' : ''}${winner ? ' winner' : ''}`}
              style={{ '--pct': `${pct}%` }}
              aria-pressed={chosen}
              disabled={closed || readOnly}
              title={closed ? who : `${who}${chosen ? ' · clique para tirar o seu voto' : ''}`}
              onClick={() => pick(i)}
            >
              <span className="poll-bar" aria-hidden="true" />
              <span className={`poll-mark${poll.multiple ? ' square' : ''}`} aria-hidden="true">
                {chosen && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="poll-text">{o.text}</span>
              <span className="poll-count">
                {n} · {pct}%
              </span>
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        <span>
          {poll.voters} {poll.voters === 1 ? 'pessoa votou' : 'pessoas votaram'}
        </span>
        <span className="poll-status" title={poll.endsAt ? new Date(poll.endsAt).toLocaleString('pt-BR') : undefined}>
          {closed ? <Lock size={11} /> : <Clock size={11} />} {status}
        </span>
        {!closed && canEnd && !readOnly && (
          <button type="button" className="poll-end" onClick={end}>
            Encerrar
          </button>
        )}
      </div>
    </div>
  );
}
