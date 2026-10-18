// Painel do administrador do app: usuários, servidores, tempo de uso por plataforma e os dias e
// horários de mais acesso. Só o dono do app (e quem ele liberar) vê. Cada servidor abre com os
// integrantes, as mensagens dos canais de texto e os arquivos. As tabelas ordenam por qualquer coluna.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  RefreshCw,
  Users,
  Server,
  MessageSquare,
  Clock,
  Radio,
  UserPlus,
  X,
  Search,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Hash,
  Lock,
  Paperclip,
  Trash2,
} from 'lucide-react';
import { useStore } from '../store.js';
import Avatar, { UserName } from './Avatar.jsx';
import { SceneArt } from './Aero.jsx';
import { fmtSize, FileView, VoiceNote, parseFile, parseVoice } from './Files.jsx';
import { MessageSticker, parseSticker } from './Stickers.jsx';
import { RichText, EmojiText } from './Emotes.jsx';
import { plain } from '../lib/text.js';

const HOUR = 3600 * 1000;
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const SHORT_DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const PLATFORM = { app: 'App do Windows', pwa: 'App instalado (PWA)', navegador: 'Navegador' };

/** "3 h 20 min", "45 min", "agora há pouco". */
function fmtTime(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return ms > 0 ? 'menos de 1 min' : '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `${h.toLocaleString('pt-BR')} h`;
}

/** "app · computador · Windows" → "App do Windows · computador · Windows". */
const platformLabel = (label) => {
  const [p, ...rest] = label.split(' · ');
  return [PLATFORM[p] || p, ...rest].join(' · ');
};
const fmtHours = (min) => (min >= 60 ? `${(min / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h` : `${min} min`);
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
function fmtAgo(ts, now) {
  if (!ts) return 'nunca';
  const min = Math.round((now - ts) / 60000);
  if (min < 2) return 'agora há pouco';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

/** Mapa de calor: dia da semana × hora (horário deste aparelho), em horas de uso somadas. */
function Heatmap({ activity }) {
  const [hover, setHover] = useState(null);
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ minutes: 0, peak: 0 })));
    for (const a of activity) {
      const d = new Date(a.h);
      const cell = g[d.getDay()][d.getHours()];
      cell.minutes += a.minutes;
      cell.peak = Math.max(cell.peak, a.users);
    }
    return g;
  }, [activity]);
  const max = Math.max(1, ...grid.flat().map((c) => c.minutes));
  const shade = (m) => (m ? 12 + Math.round((m / max) * 88) : 0);
  return (
    <div className="adm-heat" onMouseLeave={() => setHover(null)}>
      <div className="adm-heat-grid" role="table" aria-label="Uso por dia da semana e hora">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="adm-heat-h" aria-hidden={h % 3 !== 0}>
            {h % 3 === 0 ? `${h}h` : ''}
          </span>
        ))}
        {grid.map((row, d) => (
          <div className="adm-heat-row" role="row" key={d}>
            <span className="adm-heat-d" role="rowheader">
              {SHORT_DAYS[d]}
            </span>
            {row.map((c, h) => (
              <span
                key={h}
                role="cell"
                tabIndex={0}
                aria-label={`${WEEKDAYS[d]}, ${h}h às ${h + 1}h: ${fmtHours(c.minutes)} de uso, pico de ${c.peak} ${c.peak === 1 ? 'pessoa' : 'pessoas'}`}
                className={`adm-cell${hover?.d === d && hover?.h === h ? ' on' : ''}`}
                style={{ '--v': `${shade(c.minutes)}%` }}
                onMouseEnter={() => setHover({ d, h, c })}
                onFocus={() => setHover({ d, h, c })}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="adm-heat-foot">
        <span className="adm-tip" aria-live="polite">
          {hover ? (
            <>
              <b>
                {WEEKDAYS[hover.d]}, {hover.h}h–{hover.h + 1}h
              </b>{' '}
              · {fmtHours(hover.c.minutes)} de uso · pico de {hover.c.peak} {hover.c.peak === 1 ? 'pessoa' : 'pessoas'} ao mesmo tempo
            </>
          ) : (
            'Passe o mouse num quadrado para ver os detalhes.'
          )}
        </span>
        <span className="adm-legend" aria-hidden="true">
          menos <i className="adm-legend-bar" /> mais
        </span>
      </div>
    </div>
  );
}

/** Barras simples (uma série): rótulo embaixo, valor na dica. */
function Bars({ items, label }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="adm-bars-wrap">
      <div className="adm-bars" role="list" aria-label={label} onMouseLeave={() => setHover(null)}>
        {items.map((it, i) => (
          <div
            key={it.key}
            role="listitem"
            tabIndex={0}
            className={`adm-bar${hover === i ? ' on' : ''}`}
            aria-label={`${it.full}: ${it.text}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
          >
            <i style={{ height: `${Math.max(it.value ? 3 : 0, (it.value / max) * 100)}%` }} />
            <span>{it.label}</span>
          </div>
        ))}
      </div>
      <div className="adm-tip">{hover != null ? `${items[hover].full}: ${items[hover].text}` : ' '}</div>
    </div>
  );
}

function Charts({ activity }) {
  const byDay = Array.from({ length: 7 }, () => 0);
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const a of activity) {
    const d = new Date(a.h);
    byDay[d.getDay()] += a.minutes;
    byHour[d.getHours()] += a.minutes;
  }
  const best = (arr) => arr.indexOf(Math.max(...arr));
  const total = byDay.reduce((x, y) => x + y, 0);
  return (
    <>
      <p className="kv adm-summary">
        {total
          ? `Dia mais movimentado: ${WEEKDAYS[best(byDay)].toLowerCase()} · horário de pico: ${best(byHour)}h às ${best(byHour) + 1}h (horário deste aparelho).`
          : 'Ainda não há uso registrado neste período.'}
      </p>
      <Heatmap activity={activity} />
      <div className="adm-two">
        <section>
          <h4>Por dia da semana</h4>
          <Bars
            label="Uso por dia da semana"
            items={byDay.map((v, d) => ({ key: d, value: v, label: SHORT_DAYS[d], full: WEEKDAYS[d], text: `${fmtHours(v)} de uso` }))}
          />
        </section>
        <section>
          <h4>Por horário</h4>
          <Bars
            label="Uso por hora do dia"
            items={byHour.map((v, h) => ({ key: h, value: v, label: h % 3 === 0 ? `${h}h` : '', full: `${h}h às ${h + 1}h`, text: `${fmtHours(v)} de uso` }))}
          />
        </section>
      </div>
    </>
  );
}

function Platforms({ list }) {
  const max = Math.max(1, ...list.map((p) => p.ms));
  if (!list.length) return <p className="kv">Nenhuma sessão no período.</p>;
  return (
    <div className="adm-plat">
      {list.map((p) => (
        <div className="adm-plat-row" key={`${p.platform}-${p.device}`}>
          <span className="adm-plat-name">
            {PLATFORM[p.platform] || p.platform}
            {p.device && <small> · {p.device}</small>}
          </span>
          <span className="adm-plat-bar">
            <i style={{ width: `${(p.ms / max) * 100}%` }} />
          </span>
          <span className="adm-plat-val">
            {fmtTime(p.ms)} · {p.users} {p.users === 1 ? 'pessoa' : 'pessoas'}
          </span>
        </div>
      ))}
    </div>
  );
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const nameOf = (u) => plain(u?.displayName || '') || u?.username || '';

/**
 * Tabela ordenável: `columns` dá, para cada chave, o valor da linha e o sentido do primeiro clique
 * (texto de A a Z, números do maior para o menor). Vazios ficam sempre no fim; empates seguem o nome.
 */
function useSort(list, columns, initial = 'name') {
  const [sort, setSort] = useState({ key: initial, dir: columns[initial].dir || 'asc' });
  const rows = useMemo(() => {
    const cmp = (col, a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;
      if (y == null || y === '') return -1;
      return typeof x === 'string' ? collator.compare(x, y) : x - y;
    };
    const col = columns[sort.key];
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const c = cmp(col, a, b);
      const nulls = (col.value(a) ?? '') === '' || (col.value(b) ?? '') === '';
      return (nulls ? c : sign * c) || (columns.name ? cmp(columns.name, a, b) : 0);
    });
  }, [list, sort]);
  const th = (key, label, num) => {
    const on = sort.key === key;
    const Icon = on ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
    return (
      <th key={key} className={num ? 'num' : undefined} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className={`adm-sort${on ? ' on' : ''}`}
          title={`Ordenar por ${label.toLowerCase()}`}
          onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: columns[key].dir || 'asc' }))}
        >
          {label}
          <Icon size={12} aria-hidden="true" />
        </button>
      </th>
    );
  };
  return { rows, th };
}

const matches = (q, ...texts) => texts.join(' ').toLowerCase().includes(q.trim().toLowerCase());

function SearchBox({ value, onChange, label }) {
  return (
    <div className="adm-tools">
      <label className="adm-search">
        <Search size={14} />
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} aria-label={label} />
      </label>
    </div>
  );
}

function UsersTable({ users, now }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => users.filter((u) => matches(q, plain(u.user.displayName), u.user.username)), [users, q]);
  const { rows, th } = useSort(list, {
    name: { value: (u) => nameOf(u.user) },
    platforms: { value: (u) => (u.platforms[0] ? platformLabel(u.platforms[0].label) : null) },
    period: { value: (u) => u.periodMs || null, dir: 'desc' },
    total: { value: (u) => u.totalMs || null, dir: 'desc' },
    last: { value: (u) => (u.online ? Number.MAX_SAFE_INTEGER : u.lastSeenAt), dir: 'desc' },
    guilds: { value: (u) => u.guilds, dir: 'desc' },
    created: { value: (u) => u.createdAt, dir: 'desc' },
  });
  return (
    <>
      <SearchBox value={q} onChange={setQ} label="Buscar pessoa" />
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              {th('name', 'Pessoa')}
              {th('platforms', 'Plataformas')}
              {th('period', 'No período', true)}
              {th('total', 'No total', true)}
              {th('last', 'Última vez')}
              {th('guilds', 'Servidores', true)}
              {th('created', 'Conta criada')}
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.user.id}>
                <td>
                  <span className="adm-who">
                    <Avatar user={u.user} size={26} frame={false} status={u.online ? undefined : 'off'} />
                    <span>
                      <UserName user={u.user} />
                      <small>@{u.user.username}</small>
                    </span>
                  </span>
                </td>
                <td className="adm-plats">
                  {u.platforms.length
                    ? u.platforms.slice(0, 3).map((p) => (
                        <span key={p.label} className="chip" title={fmtTime(p.ms)}>
                          {platformLabel(p.label)}
                        </span>
                      ))
                    : '—'}
                </td>
                <td className="num">{fmtTime(u.periodMs)}</td>
                <td className="num">{fmtTime(u.totalMs)}</td>
                <td>{u.online ? <b className="adm-online">online agora</b> : fmtAgo(u.lastSeenAt, now)}</td>
                <td className="num">{u.guilds}</td>
                <td>{fmtDate(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="adm-empty">Ninguém encontrado.</p>}
      </div>
    </>
  );
}

/** Carrega uma vez (e de novo quando `key` muda). */
function useLoad(fn, key) {
  const [state, setState] = useState({ data: null, error: '' });
  useEffect(() => {
    let alive = true;
    setState({ data: null, error: '' });
    fn().then(
      (data) => alive && setState({ data, error: '' }),
      (e) => alive && setState({ data: null, error: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return state;
}

const ROLE_ORDER = { dono: 2, admin: 1 };

function GuildMembers({ guildId }) {
  const { data, error } = useLoad(() => useStore.getState().adminGuildMembers(guildId), guildId);
  const [q, setQ] = useState('');
  const list = useMemo(() => (data || []).filter((m) => matches(q, plain(m.user.displayName), m.user.username)), [data, q]);
  const { rows, th } = useSort(list, {
    name: { value: (m) => nameOf(m.user) },
    role: { value: (m) => ROLE_ORDER[m.role] || null, dir: 'desc' },
    online: { value: (m) => (m.online ? 1 : null), dir: 'desc' },
    joined: { value: (m) => m.joinedAt, dir: 'desc' },
  });
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="adm-empty">Carregando integrantes…</p>;
  return (
    <>
      <SearchBox value={q} onChange={setQ} label="Buscar integrante" />
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              {th('name', 'Pessoa')}
              {th('role', 'Função')}
              {th('online', 'Status')}
              {th('joined', 'Entrou')}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.user.id}>
                <td>
                  <span className="adm-who">
                    <Avatar user={m.user} size={24} frame={false} status={m.online ? undefined : 'off'} />
                    <span>
                      <UserName user={m.user} />
                      <small>@{m.user.username}</small>
                    </span>
                  </span>
                </td>
                <td>{m.role ? <span className="chip">{m.role}</span> : '—'}</td>
                <td>{m.online ? <b className="adm-online">online</b> : 'offline'}</td>
                <td>{fmtDate(m.joinedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="adm-empty">Nenhum integrante.</p>}
      </div>
    </>
  );
}

const fmtStamp = (ts) =>
  new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Uma mensagem como na conversa (texto, arquivo, voz ou sticker), sem as ferramentas. */
function AdminMessage({ m, me }) {
  const sticker = parseSticker(m.content);
  const file = !sticker && parseFile(m.content);
  const voice = !sticker && !file && parseVoice(m.content);
  const caption = sticker?.caption || file?.caption || '';
  return (
    <li className="adm-msg">
      <Avatar user={m.author} size={30} frame={false} />
      <div className="adm-msg-body">
        <div className="adm-msg-head">
          <UserName user={m.author} />
          <small>@{m.author.username}</small>
          <time dateTime={new Date(m.createdAt).toISOString()}>{fmtStamp(m.createdAt)}</time>
          {m.editedAt && <small>(editada)</small>}
        </div>
        {m.reply && (
          <div className="adm-msg-reply">
            ↪ {m.reply.authorName}: {m.reply.preview || '…'}
          </div>
        )}
        <div className="adm-msg-content">
          {sticker ? <MessageSticker sticker={sticker} /> : file ? <FileView file={file} /> : voice ? <VoiceNote voice={voice} /> : <RichText text={m.content} me={me} />}
          {caption && <RichText text={caption} me={me} />}
        </div>
        {m.reactions?.length > 0 && (
          <div className="adm-msg-reacts">
            {m.reactions.map((r) => (
              <span key={r.emoji} className="chip" title={`${r.users.length} ${r.users.length === 1 ? 'reação' : 'reações'}`}>
                <EmojiText text={r.emoji} size={14} /> {r.users.length}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

const PAGE = 50;

/** Canais de texto do servidor à esquerda; as mensagens do canal escolhido à direita. */
function GuildMessages({ guildId, now }) {
  const st = useStore.getState();
  const me = useStore((s) => s.me?.username);
  const { data: channels, error } = useLoad(() => st.adminGuildChannels(guildId), guildId);
  const sorted = useMemo(() => [...(channels || [])].sort((a, b) => collator.compare(a.name, b.name)), [channels]);
  const [picked, setPicked] = useState(null);
  const channel = sorted.find((c) => c.id === picked) || sorted[0];
  const [msgs, setMsgs] = useState(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const listRef = useRef(null);
  const jump = useRef(false);
  useEffect(() => {
    if (!channel) return;
    let alive = true;
    setMsgs(null);
    setQ('');
    st.adminChannelMessages(channel.id).then(
      (list) => {
        if (!alive) return;
        jump.current = true;
        setMsgs(list);
        setMore(list.length === PAGE);
      },
      (e) => alive && st.notify(e.message),
    );
    return () => {
      alive = false;
    };
  }, [channel?.id]);
  useLayoutEffect(() => {
    if (jump.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
      jump.current = false;
    }
  }, [msgs]);
  const older = async () => {
    if (!msgs?.length) return;
    setBusy(true);
    const el = listRef.current;
    const from = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const list = await st.adminChannelMessages(channel.id, msgs[0].createdAt);
      setMsgs((cur) => [...list, ...cur]);
      setMore(list.length === PAGE);
      requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - from));
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (error) return <p className="error-text">{error}</p>;
  if (!channels) return <p className="adm-empty">Carregando canais…</p>;
  if (!sorted.length) return <p className="adm-empty">Este servidor não tem canais de texto.</p>;
  const shown = msgs && q.trim() ? msgs.filter((m) => matches(q, plain(m.content), plain(m.author.displayName), m.author.username)) : msgs;
  return (
    <div className="adm-chat">
      <nav className="adm-chans" aria-label="Canais de texto">
        {sorted.map((c) => (
          <button key={c.id} type="button" className={c.id === channel.id ? 'on' : ''} aria-current={c.id === channel.id || undefined} onClick={() => setPicked(c.id)}>
            {c.private ? <Lock size={13} aria-label="Canal privado" /> : <Hash size={13} aria-hidden="true" />}
            <span className="adm-chan-name">{c.name}</span>
            <small title={c.lastMessageAt ? `Última mensagem ${fmtAgo(c.lastMessageAt, now)}` : undefined}>{c.messages.toLocaleString('pt-BR')}</small>
          </button>
        ))}
      </nav>
      <section className="adm-msgs" aria-label={`Mensagens de #${channel.name}`}>
        <div className="adm-msgs-head">
          <b>
            #{channel.name}
            {channel.private && <small> · privado</small>}
          </b>
          <label className="adm-search">
            <Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nas mensagens carregadas" aria-label="Buscar nas mensagens carregadas" />
          </label>
        </div>
        <div className="adm-msgs-list" ref={listRef}>
          {!msgs ? (
            <p className="adm-empty">Carregando mensagens…</p>
          ) : !msgs.length ? (
            <p className="adm-empty">Nenhuma mensagem neste canal.</p>
          ) : (
            <>
              {more && !q.trim() && (
                <button type="button" className="gloss small-btn adm-older" onClick={older} disabled={busy}>
                  {busy ? 'Carregando…' : 'Carregar mensagens mais antigas'}
                </button>
              )}
              <ul>
                {shown.map((m) => (
                  <AdminMessage key={m.id} m={m} me={me} />
                ))}
              </ul>
              {!shown.length && <p className="adm-empty">Nada encontrado nas {msgs.length} mensagens carregadas.</p>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

const KIND = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', text: 'Texto' };
const fileKind = (f) => (f.kind === 'voice' ? 'Mensagem de voz' : f.mime === 'application/pdf' ? 'PDF' : f.mime === 'application/zip' ? 'ZIP' : KIND[f.mime.split('/')[0]] || 'Arquivo');

function GuildFiles({ guildId }) {
  const [version, setVersion] = useState(0);
  const { data, error } = useLoad(() => useStore.getState().adminGuildFiles(guildId), `${guildId}:${version}`);
  const [busy, setBusy] = useState(null);
  /** Apaga o arquivo do servidor (a mensagem fica com "Arquivo removido"), depois de confirmar. */
  const remove = (f) =>
    useStore.getState().openModal({
      type: 'confirm',
      title: `Apagar “${f.name}”?`,
      text: `O arquivo some do servidor e a mensagem em #${f.channelName || 'canal'} fica com “Arquivo removido”. Não dá para desfazer.`,
      action: async () => {
        setBusy(f.id);
        try {
          await useStore.getState().deleteFile(f.id);
          setVersion((v) => v + 1);
        } catch (e) {
          useStore.getState().notify(e.message);
        } finally {
          setBusy(null);
        }
      },
    });
  const fileUrl = useStore((s) => s.fileUrl);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const list = useMemo(() => (data?.files || []).filter((f) => matches(q, f.name, f.channelName, plain(f.by), f.byUsername)), [data, q]);
  const { rows, th } = useSort(list, {
    name: { value: (f) => f.name },
    kind: { value: fileKind },
    size: { value: (f) => f.size, dir: 'desc' },
    channel: { value: (f) => f.channelName },
    by: { value: (f) => plain(f.by) || f.byUsername },
    date: { value: (f) => f.createdAt, dir: 'desc' },
  });
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="adm-empty">Carregando arquivos…</p>;
  return (
    <>
      <p className="kv adm-summary">
        {data.files.length.toLocaleString('pt-BR')} {data.files.length === 1 ? 'arquivo' : 'arquivos'} · {fmtSize(data.total)} enviados · {fmtSize(data.stored)} guardados no
        disco
      </p>
      <SearchBox value={q} onChange={setQ} label="Buscar arquivo, canal ou pessoa" />
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              {th('name', 'Arquivo')}
              {th('kind', 'Tipo')}
              {th('size', 'Tamanho', true)}
              {th('channel', 'Canal')}
              {th('by', 'Enviado por')}
              {th('date', 'Enviado em')}
              <th>
                <span className="sr-only">Apagar</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <Fragment key={f.id}>
                <tr>
                  <td className="adm-file">
                    <span className="adm-who">
                      <button
                        type="button"
                        className="adm-expand"
                        aria-expanded={open === f.id}
                        aria-label={`${open === f.id ? 'Esconder' : 'Ver'} ${f.name}`}
                        title={open === f.id ? 'Esconder' : 'Ver aqui'}
                        onClick={() => setOpen(open === f.id ? null : f.id)}
                      >
                        <ChevronDown size={14} />
                      </button>
                      <a href={fileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
                        {f.name}
                      </a>
                      {f.nsfw && <span className="chip">NSFW</span>}
                    </span>
                  </td>
                  <td>{fileKind(f)}</td>
                  <td className="num">{fmtSize(f.size)}</td>
                  <td>#{f.channelName || '—'}</td>
                  <td>
                    {plain(f.by)} <small>@{f.byUsername}</small>
                  </td>
                  <td>{fmtStamp(f.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="adm-expand adm-del"
                      title="Apagar o arquivo"
                      aria-label={`Apagar ${f.name}`}
                      disabled={busy === f.id}
                      onClick={() => remove(f)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
                {open === f.id && (
                  <tr className="adm-members-row">
                    <td colSpan={7}>
                      <div className="adm-file-view">
                        {f.kind === 'voice' ? (
                          <VoiceNote voice={{ id: f.id, duration: 0, mime: f.mime }} />
                        ) : (
                          <FileView file={{ id: f.id, size: f.size, mime: f.mime, name: f.name, nsfw: f.nsfw }} />
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="adm-empty">{data.files.length ? 'Nada encontrado.' : 'Nenhum arquivo neste servidor.'}</p>}
      </div>
    </>
  );
}

/** Um servidor aberto: integrantes, mensagens dos canais de texto e arquivos. */
function GuildDetail({ guild: g, base, now, onBack }) {
  const [tab, setTab] = useState('integrantes');
  return (
    <>
      <div className="adm-guild-head">
        <button type="button" className="gloss small-btn" onClick={onBack}>
          <ArrowLeft size={14} /> Servidores
        </button>
        <span className={`gel guild guild-icon adm-gicon big${g.iconUrl ? ' has-img' : ''}`} style={{ '--c': g.iconColor }}>
          {g.iconUrl ? <img src={base + g.iconUrl} alt="" /> : <span>{g.name.slice(0, 2).toUpperCase()}</span>}
        </span>
        <div className="adm-guild-title">
          <h3>{g.name}</h3>
          <small>
            Dono: {g.owner} @{g.ownerUsername} · criado em {fmtDate(g.createdAt)}
          </small>
        </div>
      </div>
      <div className="adm-subtabs" role="tablist" aria-label={`Sobre ${g.name}`}>
        {[
          ['integrantes', Users, `Integrantes (${g.members})`],
          ['mensagens', MessageSquare, `Mensagens (${g.messages.toLocaleString('pt-BR')})`],
          ['arquivos', Paperclip, `Arquivos (${fmtSize(g.fileBytes)})`],
        ].map(([id, Icon, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <Icon size={14} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>
      {tab === 'integrantes' && <GuildMembers guildId={g.id} />}
      {tab === 'mensagens' && <GuildMessages guildId={g.id} now={now} />}
      {tab === 'arquivos' && <GuildFiles guildId={g.id} />}
    </>
  );
}

function GuildsTable({ guilds, base, now }) {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const list = useMemo(() => guilds.filter((g) => matches(q, g.name, g.owner, g.ownerUsername)), [guilds, q]);
  const { rows, th } = useSort(list, {
    name: { value: (g) => g.name },
    owner: { value: (g) => g.owner || g.ownerUsername },
    members: { value: (g) => g.members, dir: 'desc' },
    channels: { value: (g) => g.channels, dir: 'desc' },
    messages: { value: (g) => g.messages, dir: 'desc' },
    files: { value: (g) => g.fileBytes, dir: 'desc' },
    last: { value: (g) => g.lastMessageAt, dir: 'desc' },
    created: { value: (g) => g.createdAt, dir: 'desc' },
  });
  const opened = guilds.find((g) => g.id === openId);
  if (opened) return <GuildDetail guild={opened} base={base} now={now} onBack={() => setOpenId(null)} />;
  return (
    <>
      <SearchBox value={q} onChange={setQ} label="Buscar servidor ou dono" />
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              {th('name', 'Servidor')}
              {th('owner', 'Dono')}
              {th('members', 'Membros', true)}
              {th('channels', 'Canais', true)}
              {th('messages', 'Mensagens', true)}
              {th('files', 'Arquivos', true)}
              {th('last', 'Última mensagem')}
              {th('created', 'Criado')}
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id} className="adm-click" onClick={() => setOpenId(g.id)}>
                <td>
                  <span className="adm-who">
                    <span className={`gel guild guild-icon adm-gicon${g.iconUrl ? ' has-img' : ''}`} style={{ '--c': g.iconColor }}>
                      {g.iconUrl ? <img src={base + g.iconUrl} alt="" /> : <span>{g.name.slice(0, 2).toUpperCase()}</span>}
                    </span>
                    <button type="button" className="adm-link" onClick={() => setOpenId(g.id)} title="Ver integrantes, mensagens e arquivos">
                      {g.name}
                    </button>
                  </span>
                </td>
                <td>
                  {g.owner} <small>@{g.ownerUsername}</small>
                </td>
                <td className="num">{g.members}</td>
                <td className="num">{g.channels}</td>
                <td className="num">{g.messages.toLocaleString('pt-BR')}</td>
                <td className="num">{fmtSize(g.fileBytes)}</td>
                <td>{g.lastMessageAt ? fmtAgo(g.lastMessageAt, now) : '—'}</td>
                <td>{fmtDate(g.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="adm-empty">Nenhum servidor encontrado.</p>}
      </div>
    </>
  );
}

/** Quem pode ver o painel (o dono libera ou tira). */
function Viewers({ owner }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const st = useStore.getState();
  useEffect(() => {
    st.adminViewers().then(setData, (e) => st.notify(e.message));
  }, []);
  const run = async (fn) => {
    setBusy(true);
    try {
      setData(await fn());
      setName('');
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <p className="kv">Carregando…</p>;
  return (
    <>
      <p className="kv">
        O painel é do usuário <b>@{data.owner}</b>
        {owner ? '. Você pode liberar para outras pessoas.' : '. Só ele escolhe quem mais vê.'}
      </p>
      {owner && (
        <form
          className="adm-grant"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) run(() => st.grantAdmin(name));
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="nome_de_usuario" aria-label="Usuário para liberar o painel" />
          <button className="btn" disabled={busy || !name.trim()}>
            <UserPlus size={15} /> Liberar
          </button>
        </form>
      )}
      {data.viewers.length === 0 ? (
        <p className="kv">Ninguém mais vê o painel.</p>
      ) : (
        <div className="adm-viewers">
          {[...data.viewers].sort((a, b) => collator.compare(nameOf(a.user), nameOf(b.user))).map((v) => (
            <div className="block-row" key={v.user.id}>
              <Avatar user={v.user} size={22} frame={false} />
              <span className="nm">
                <UserName user={v.user} /> <small>@{v.user.username} · desde {fmtDate(v.grantedAt)}</small>
              </span>
              {owner && (
                <button
                  type="button"
                  className="gloss mini"
                  title="Tirar o acesso"
                  aria-label={`Tirar o acesso de ${plain(v.user.displayName) || v.user.username}`}
                  disabled={busy}
                  onClick={() => run(() => st.revokeAdmin(v.user.id))}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const PERIODS = [
  [7, '7 dias'],
  [30, '30 dias'],
  [90, '90 dias'],
];

export default function AdminPage() {
  const access = useStore((s) => s.appAdmin);
  const base = useStore((s) => s.baseUrl);
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('uso');
  const st = useStore.getState();
  const load = async () => {
    setLoading(true);
    try {
      setData(await st.adminOverview(days));
    } catch (e) {
      st.notify(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (access?.canView) load();
  }, [days, access?.canView]);

  if (!access?.canView)
    return (
      <div className="host-page">
        <div className="host-body">
          <div className="host-col">
            <button className="gloss small-btn host-back-plain" onClick={() => st.leaveAdmin()}>
              <ArrowLeft size={14} /> Voltar
            </button>
            <p className="kv">Você não tem acesso a este painel.</p>
          </div>
        </div>
      </div>
    );

  const t = data?.totals;
  const tiles = t
    ? [
        [Users, 'Pessoas', t.users.toLocaleString('pt-BR'), `${t.onlineNow} online agora`],
        [Server, 'Servidores', t.guilds.toLocaleString('pt-BR'), `${t.inVoice} em canais de voz agora`],
        [MessageSquare, 'Mensagens', (t.messages + t.dmMessages).toLocaleString('pt-BR'), `${t.dmMessages.toLocaleString('pt-BR')} em conversas diretas`],
        [Clock, `Uso em ${days} dias`, fmtTime(t.periodMs), 'somando todo mundo'],
        [Radio, 'Conexões abertas', t.connections, 'abas e apps conectados agora'],
      ]
    : [];
  return (
    <div className="host-page admin-page">
      <section className="host-band scene aqua">
        <SceneArt />
        <button className="gloss mini host-back" onClick={() => st.leaveAdmin()} title="Voltar" aria-label="Voltar">
          <ArrowLeft size={16} />
        </button>
        <div className="host-state">
          <h1>Painel do administrador</h1>
          <p>Pessoas, servidores e uso do PadoSpeak em {base.replace(/^https?:\/\//, '')}</p>
        </div>
        <div className="host-actions">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Período">
            {PERIODS.map(([v, l]) => (
              <option key={v} value={v}>
                Últimos {l}
              </option>
            ))}
          </select>
          <button className="gloss mini" onClick={load} disabled={loading} title="Atualizar" aria-label="Atualizar">
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </section>
      {!data ? (
        <div className="boot">Carregando painel…</div>
      ) : (
        <div className="adm-body">
          <div className="adm-tiles">
            {tiles.map(([Icon, label, value, hint]) => (
              <div className="adm-tile glass" key={label}>
                <Icon size={18} className="adm-tile-ico" />
                <span className="adm-tile-label">{label}</span>
                <b>{value}</b>
                <small>{hint}</small>
              </div>
            ))}
          </div>
          <div className="gs-tabs adm-tabs" role="tablist">
            {[
              ['uso', 'Uso e horários'],
              ['pessoas', `Pessoas (${data.users.length})`],
              ['servidores', `Servidores (${data.guilds.length})`],
              ['acesso', 'Quem vê o painel'],
            ].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <section className="adm-panel glass">
            {tab === 'uso' && (
              <>
                <h3>Dias e horários de mais acesso</h3>
                <Charts activity={data.activity} />
                <h3>Plataformas</h3>
                <Platforms list={data.platforms} />
              </>
            )}
            {tab === 'pessoas' && <UsersTable users={data.users} now={data.now} />}
            {tab === 'servidores' && <GuildsTable guilds={data.guilds} base={base} now={data.now} />}
            {tab === 'acesso' && <Viewers owner={access.owner} />}
          </section>
        </div>
      )}
    </div>
  );
}
