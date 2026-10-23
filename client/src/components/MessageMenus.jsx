// Menus da conversa, no alto da conversa privada e do canal de texto: pesquisar nas mensagens, as
// fixadas (valem para todos da conversa) e as favoritas (só de quem favoritou). Clicar numa mensagem
// abre a conversa dela e leva até ela, carregando as anteriores se precisar.
import { useEffect, useRef, useState } from 'react';
import { Search, Pin, PinOff, Star, LoaderCircle, Hash, AtSign } from 'lucide-react';
import { useStore, messageSummary } from '../store.js';
import { useConn } from './conn.jsx';
import { Floating, FormattedText, plain } from './Emotes.jsx';
import Avatar, { UserName } from './Avatar.jsx';

const when = (ts) =>
  new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Uma mensagem nas listas: quem, quando, onde e o começo do texto. Clicar leva até ela. */
function MessageCard({ m, where, note, onOpen, action }) {
  const { verb, text } = messageSummary(m.content);
  const shown = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return (
    <div className="mm-card">
      <button type="button" className="mm-open" onClick={onOpen} title="Ir para a mensagem">
        <Avatar user={m.author} size={28} frame={false} />
        <span className="mm-body">
          <span className="mm-meta">
            <UserName user={m.author} className="mm-name" />
            <small>
              {when(m.createdAt)}
              {where && <> · {where}</>}
            </small>
          </span>
          <span className="mm-text">
            {verb !== 'diz' && (
              <i>
                {verb}
                {shown ? ': ' : ''}
              </i>
            )}
            <FormattedText text={shown} size={16} />
          </span>
          {note && <small className="mm-note">{note}</small>}
        </span>
      </button>
      {action}
    </div>
  );
}

function Empty({ children }) {
  return <p className="mm-empty">{children}</p>;
}

function Loading() {
  return (
    <p className="mm-empty" role="status">
      <LoaderCircle size={18} className="spin" /> Carregando…
    </p>
  );
}

/** Pesquisa: nesta conversa/canal ou, nos servidores, em todos os canais de texto que eu vejo. */
function SearchPanel({ channel, guildId, onPick }) {
  const useC = useConn();
  const channels = useC((s) => (guildId ? s.guildData[guildId]?.channels : null));
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('here'); // here | guild
  const [res, setRes] = useState({ query: '', results: null, next: null, scanned: 0, loading: false });
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const run = async (more = false, where = scope) => {
    const query = more ? res.query : q.trim();
    if (!query) return;
    setRes((r) => ({ ...r, loading: true, ...(more ? {} : { query, results: null, scanned: 0 }) }));
    try {
      const out = await useC.getState().searchMessages({
        q: query,
        ...(where === 'guild' ? { guild: guildId } : { channel: channel.id }),
        before: more ? res.next : undefined,
      });
      setRes((r) => ({
        query,
        results: more ? [...(r.results || []), ...out.results] : out.results,
        next: out.next,
        scanned: (more ? r.scanned : 0) + out.scanned,
        loading: false,
      }));
    } catch (e) {
      setRes((r) => ({ ...r, loading: false, results: r.results || [] }));
      useStore.getState().notify(e.message);
    }
  };
  const channelName = (id) => channels?.find((c) => c.id === id)?.name;
  const { results, next, loading } = res;
  return (
    <>
      <form
        className="mm-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={200}
          placeholder={guildId ? 'Pesquisar mensagens' : `Pesquisar na conversa com ${channel.name}`}
          aria-label="Pesquisar mensagens"
          enterKeyHint="search"
        />
        <button className="btn" disabled={!q.trim() || loading}>
          Buscar
        </button>
      </form>
      {guildId && (
        <div className="mm-chips" role="radiogroup" aria-label="Onde pesquisar">
          {[
            ['here', `Em #${channel.name}`],
            ['guild', 'No servidor todo'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={scope === id}
              className={scope === id ? 'on' : ''}
              onClick={() => {
                setScope(id);
                if (res.query) run(false, id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="mm-list">
        {results === null ? (
          loading ? (
            <Loading />
          ) : (
            <Empty>Escreva uma ou mais palavras. Maiúsculas e acentos não importam, e o nome dos arquivos também conta.</Empty>
          )
        ) : (
          <>
            {results.map((m) => (
              <MessageCard
                key={m.id}
                m={m}
                where={scope === 'guild' && channelName(m.channelId) ? `#${channelName(m.channelId)}` : null}
                onOpen={() => onPick(m, guildId ? { guildId } : { dm: true })}
              />
            ))}
            {!results.length && !next && <Empty>Nenhuma mensagem com “{res.query}”.</Empty>}
            {next && (
              <div className="mm-more">
                {!results.length && <span>Nada nas {res.scanned.toLocaleString('pt-BR')} mensagens mais recentes.</span>}
                <button type="button" className="btn secondary" disabled={loading} onClick={() => run(true)}>
                  {loading ? 'Procurando…' : 'Procurar nas mais antigas'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Fixadas desta conversa ou canal (para todos). */
function PinsPanel({ channel, guildId, canPin, onPick }) {
  const useC = useConn();
  const seq = useC((s) => s.pinsSeq[channel.id] || 0);
  const me = useC((s) => s.me);
  const members = useC((s) => (guildId ? s.guildData[guildId]?.members : null));
  const [list, setList] = useState(null);
  useEffect(() => {
    let live = true;
    useC
      .getState()
      .loadPins(channel.id)
      .then(
        (l) => live && setList(l),
        (e) => {
          if (!live) return;
          setList([]);
          useStore.getState().notify(e.message);
        },
      );
    return () => {
      live = false;
    };
  }, [channel.id, seq]);
  const nameOf = (id) => {
    if (id === me?.id) return 'você';
    const u = members?.find((x) => x.id === id) || (channel.recipient?.id === id ? channel.recipient : null);
    return u ? plain(u.displayName) || u.username : 'alguém';
  };
  if (!list) return <Loading />;
  return (
    <div className="mm-list">
      {list.length === 0 && (
        <Empty>
          Nenhuma mensagem fixada. Passe o mouse numa mensagem (ou segure, no celular) e toque no alfinete para fixar: ela fica aqui
          para todos {guildId ? 'do canal' : 'da conversa'}.
        </Empty>
      )}
      {list.map((m) => (
        <MessageCard
          key={m.id}
          m={m}
          note={`Fixada por ${nameOf(m.pinnedBy)} em ${when(m.pinnedAt)}`}
          onOpen={() => onPick(m, guildId ? { guildId } : { dm: true })}
          action={
            canPin && (
              <button
                type="button"
                className="gloss mini mm-act"
                title="Desafixar"
                aria-label="Desafixar"
                onClick={() => useC.getState().setPin(m.id, false)}
              >
                <PinOff size={14} />
              </button>
            )
          }
        />
      ))}
    </div>
  );
}

/** Minhas favoritas (só eu vejo): de todas as conversas ou só desta. */
function StarsPanel({ channel, onPick }) {
  const useC = useConn();
  const count = useC((s) => Object.values(s.marks.star || {}).filter(Boolean).length);
  const [list, setList] = useState(null);
  const [onlyHere, setOnlyHere] = useState(false);
  useEffect(() => {
    let live = true;
    useC
      .getState()
      .loadStars()
      .then(
        (l) => live && setList(l),
        (e) => {
          if (!live) return;
          setList([]);
          useStore.getState().notify(e.message);
        },
      );
    return () => {
      live = false;
    };
  }, [count]);
  const where = (p) =>
    p?.dm ? (
      <>
        <AtSign size={11} /> {plain(p.recipient?.displayName) || p.recipient?.username}
      </>
    ) : (
      <>
        <Hash size={11} /> {p?.channelName} · {p?.guildName}
      </>
    );
  const shown = (list || []).filter((m) => !onlyHere || m.channelId === channel.id);
  return (
    <>
      <div className="mm-chips" role="radiogroup" aria-label="Quais favoritas">
        {[
          [false, 'Todas'],
          [true, 'Desta conversa'],
        ].map(([v, label]) => (
          <button key={label} type="button" role="radio" aria-checked={onlyHere === v} className={onlyHere === v ? 'on' : ''} onClick={() => setOnlyHere(v)}>
            {label}
          </button>
        ))}
      </div>
      {!list ? (
        <Loading />
      ) : (
        <div className="mm-list">
          {shown.length === 0 && (
            <Empty>
              {list.length && onlyHere
                ? 'Nenhuma favorita nesta conversa.'
                : 'Nenhuma favorita ainda. Toque na estrela de uma mensagem para guardá-la aqui. Só você vê as suas favoritas.'}
            </Empty>
          )}
          {shown.map((m) => (
            <MessageCard
              key={m.id}
              m={m}
              where={where(m.place)}
              onOpen={() => onPick(m, m.place?.dm ? { dm: true } : { guildId: m.place?.guildId })}
              action={
                <button
                  type="button"
                  className="gloss mini mm-act star-on"
                  title="Tirar das favoritas"
                  aria-label="Tirar das favoritas"
                  onClick={() => useC.getState().setMark('star', m.id, false)}
                >
                  <Star size={14} fill="currentColor" />
                </button>
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

const MENUS = {
  search: { icon: Search, label: 'Pesquisar', title: 'Pesquisar mensagens', cls: 'ico-blue' },
  pins: { icon: Pin, label: 'Fixadas', title: 'Mensagens fixadas', cls: 'ico-pin' },
  stars: { icon: Star, label: 'Favoritas', title: 'Minhas favoritas (só você vê)', cls: 'ico-gold' },
};

/**
 * Botões (e menus) da conversa: `channel` é o canal de texto ou a conversa privada (com `recipient`);
 * `guildId` só nos servidores; `canPin`: posso fixar e desafixar aqui.
 */
export default function ChatMenus({ channel, guildId, canPin, align = 'right' }) {
  const [open, setOpen] = useState(null);
  const refs = { search: useRef(null), pins: useRef(null), stars: useRef(null) };
  const useC = useConn();
  // Mudou de conversa: o menu aberto era da outra.
  useEffect(() => setOpen(null), [channel.id]);
  // Ctrl+F (ou ⌘F) abre a pesquisa da conversa aberta.
  useEffect(() => {
    const key = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen('search');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const pick = (m, place) => {
    setOpen(null);
    useC.getState().jumpTo(m, place);
  };
  const menu = open && MENUS[open];
  return (
    <>
      {Object.entries(MENUS).map(([id, { icon: Icon, label, title, cls }]) => (
        <button
          key={id}
          ref={refs[id]}
          type="button"
          className={`gloss tool${open === id ? ' pressed' : ''}`}
          title={title}
          aria-label={title}
          aria-expanded={open === id}
          onClick={() => setOpen(open === id ? null : id)}
        >
          <Icon size={20} className={cls} />
          {label}
        </button>
      ))}
      {menu && (
        <Floating
          anchorRef={refs[open]}
          onClose={() => setOpen(null)}
          align={align}
          place="below"
          className="mm-pop"
          role="dialog"
          aria-label={menu.title}
        >
          <div className="popover-title">{menu.title}</div>
          {open === 'search' && <SearchPanel channel={channel} guildId={guildId} onPick={pick} />}
          {open === 'pins' && <PinsPanel channel={channel} guildId={guildId} canPin={canPin} onPick={pick} />}
          {open === 'stars' && <StarsPanel channel={channel} onPick={pick} />}
        </Floating>
      )}
    </>
  );
}
