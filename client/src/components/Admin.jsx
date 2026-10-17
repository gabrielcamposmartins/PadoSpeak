// Painel do administrador do app: usuários, servidores, tempo de uso por plataforma e os dias e
// horários de mais acesso. Só o dono do app (e quem ele liberar) vê.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RefreshCw, Users, Server, MessageSquare, Clock, Radio, UserPlus, X, Search, ChevronDown } from 'lucide-react';
import { useStore } from '../store.js';
import Avatar, { UserName } from './Avatar.jsx';
import { SceneArt } from './Aero.jsx';
import { fmtSize } from './Files.jsx';
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

const USER_SORTS = [
  ['period', 'Mais tempo no período'],
  ['total', 'Mais tempo no total'],
  ['recent', 'Visto por último'],
  ['new', 'Mais novos'],
  ['name', 'Nome'],
];

function UsersTable({ users, now }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('period');
  const list = users
    .filter((u) => `${plain(u.user.displayName)} ${u.user.username}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort(
      {
        period: (a, b) => b.periodMs - a.periodMs,
        total: (a, b) => b.totalMs - a.totalMs,
        recent: (a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0),
        new: (a, b) => b.createdAt - a.createdAt,
        name: (a, b) => plain(a.user.displayName).localeCompare(plain(b.user.displayName)),
      }[sort],
    );
  return (
    <>
      <div className="adm-tools">
        <label className="adm-search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pessoa" aria-label="Buscar pessoa" />
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordenar pessoas">
          {USER_SORTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Pessoa</th>
              <th>Plataformas</th>
              <th className="num">No período</th>
              <th className="num">No total</th>
              <th>Última vez</th>
              <th className="num">Servidores</th>
              <th>Conta criada</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
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
      </div>
    </>
  );
}

/** Integrantes de um servidor, abertos embaixo da linha dele (carregados na primeira vez). */
function GuildMembers({ guildId }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    useStore
      .getState()
      .adminGuildMembers(guildId)
      .then(setList)
      .catch((e) => setError(e.message));
  }, [guildId]);
  if (error) return <p className="error-text">{error}</p>;
  if (!list) return <p className="adm-members-empty">Carregando integrantes…</p>;
  if (!list.length) return <p className="adm-members-empty">Nenhum integrante.</p>;
  return (
    <ul className="adm-members">
      {list.map((m) => (
        <li key={m.user.id}>
          <Avatar user={m.user} size={24} frame={false} status={m.online ? undefined : 'off'} />
          <span className="adm-member-name">
            <UserName user={m.user} />
            <small>@{m.user.username}</small>
          </span>
          {m.role && <span className="chip">{m.role}</span>}
          <small className="adm-member-since" title="Entrou no servidor">
            {m.online && <b className="adm-online">online · </b>}desde {fmtDate(m.joinedAt)}
          </small>
        </li>
      ))}
    </ul>
  );
}

function GuildsTable({ guilds, base, now }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        <thead>
          <tr>
            <th>Servidor</th>
            <th>Dono</th>
            <th className="num">Membros</th>
            <th className="num">Canais</th>
            <th className="num">Mensagens</th>
            <th className="num">Arquivos</th>
            <th>Última mensagem</th>
            <th>Criado</th>
          </tr>
        </thead>
        <tbody>
          {guilds.map((g) => (
            <Fragment key={g.id}>
            <tr>
              <td>
                <span className="adm-who">
                  <button
                    type="button"
                    className="adm-expand"
                    aria-expanded={open.has(g.id)}
                    aria-label={`${open.has(g.id) ? 'Esconder' : 'Ver'} os integrantes de ${g.name}`}
                    title={open.has(g.id) ? 'Esconder os integrantes' : 'Ver os integrantes'}
                    onClick={() => toggle(g.id)}
                  >
                    <ChevronDown size={14} />
                  </button>
                  <span className={`gel guild guild-icon adm-gicon${g.iconUrl ? ' has-img' : ''}`} style={{ '--c': g.iconColor }}>
                    {g.iconUrl ? <img src={base + g.iconUrl} alt="" /> : <span>{g.name.slice(0, 2).toUpperCase()}</span>}
                  </span>
                  <b>{g.name}</b>
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
            {open.has(g.id) && (
              <tr className="adm-members-row">
                <td colSpan={8}>
                  <GuildMembers guildId={g.id} />
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
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
          {data.viewers.map((v) => (
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
