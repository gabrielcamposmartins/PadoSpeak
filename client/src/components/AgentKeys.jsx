/**
 * Chaveiro do assistente (veja `server/src/agent.rs`, "Chaves e modelo"): as chaves da API guardadas, a que
 * está em uso e o modelo.
 *
 * - `scope="admin"` (painel do administrador): as chaves do app, que valem para todo mundo. Só o dono muda.
 * - `scope="me"` (Configurações → Assistente): as chaves da própria pessoa. Sem escolher uma, vale a do app;
 *   o modelo só se escolhe com chave própria (com a do app, é o dono quem paga e escolhe).
 *
 * As chaves aparecem escondidas (início e fim); o olho busca a chave inteira no servidor.
 */
import { useEffect, useState } from 'react';
import { Eye, EyeOff, Trash2, Copy, Plus, KeyRound, Building2, Server, Cpu, Users, UserPlus, X, Repeat, CalendarClock, RefreshCw, Coins } from 'lucide-react';
import Avatar, { UserName } from './Avatar.jsx';
import { plain } from '../lib/text.js';
import { useStore } from '../store.js';
import './agent.css';

const PATHS = {
  admin: { view: '/api/admin/agent', keys: '/api/admin/agent/keys', models: '/api/admin/agent/models' },
  me: { view: '/api/agent/settings', keys: '/api/agent/keys', models: '/api/agent/models' },
};

export default function AgentKeys({ scope = 'me' }) {
  const paths = PATHS[scope];
  const admin = scope === 'admin';
  const [info, setInfo] = useState(null);
  const [models, setModels] = useState([]);
  const [shown, setShown] = useState({}); // id -> chave inteira
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false); // digitando um modelo fora da lista
  const st = useStore.getState();
  const api = () => st.api();

  const apply = (d) => {
    setInfo(d);
    setModel(d.model || '');
    setModels((m) => (m.length ? m : d.models || []));
  };
  const loadModels = () =>
    api()
      .get(paths.models)
      .then((d) => d.models?.length && setModels(d.models))
      .catch(() => {});
  useEffect(() => {
    api().get(paths.view).then(apply, () => setInfo(null));
    loadModels();
  }, [scope]);

  if (!info) return null;
  const canEdit = admin ? info.canEdit : true;
  const keys = info.keys || [];
  const ownActive = !admin && Boolean(info.active);

  const run = async (fn, done) => {
    setBusy(true);
    try {
      apply(await fn());
      if (done) st.notify(done, 'info');
      return true;
    } catch (e) {
      st.notify(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const ok = await run(() => api().post(paths.keys, { label: label.trim(), apiKey: key.trim() }), 'Chave guardada');
    if (ok) {
      setKey('');
      setLabel('');
      loadModels();
    }
  };
  const choose = async (id) => {
    if (await run(() => api().put(paths.view, { active: id }))) loadModels();
  };
  const remove = (k) => run(() => api().del(`${paths.keys}/${encodeURIComponent(k.id)}`), 'Chave apagada');
  const toggleShow = async (k) => {
    if (shown[k.id]) return setShown(({ [k.id]: _, ...rest }) => rest);
    try {
      const d = await api().get(`${paths.keys}/${encodeURIComponent(k.id)}/reveal`);
      setShown((s) => ({ ...s, [k.id]: d.key }));
    } catch (e) {
      st.notify(e.message);
    }
  };
  const copy = async (k) => {
    try {
      const full = shown[k.id] || (await api().get(`${paths.keys}/${encodeURIComponent(k.id)}/reveal`)).key;
      await navigator.clipboard.writeText(full);
      st.notify('Chave copiada', 'info');
    } catch (e) {
      st.notify(e.message || 'Não deu para copiar');
    }
  };
  const saveModel = (value) => {
    const m = value.trim();
    if (m === (info.model || '')) return;
    run(() => api().put(paths.view, { model: m }), m ? `Modelo: ${m}` : 'Modelo padrão');
  };

  const modelEditable = canEdit && (admin || ownActive);
  const name = `agent-key-${scope}`;
  // a lista do seletor: os modelos da chave, mais o atual se ele não estiver nela
  const current = admin ? info.model : model;
  const options = current && !models.some((m) => m.id === current) ? [...models, { id: current, name: current }] : models;

  return (
    <div className="agent-keys">
      <h3>Assistente</h3>
      {admin && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={Boolean(info.enabled)}
            disabled={!canEdit || busy}
            onChange={(e) => run(() => api().put(paths.view, { enabled: e.target.checked }), e.target.checked ? 'Assistente ligado' : 'Assistente desligado')}
          />
          <span>
            Ligar o assistente
            <small className="check-hint">
              Aparece para todo mundo (ou só para quem você escolher, abaixo). Ele faz o que a pessoa pede no app, só com o acesso que ela já tem, e pede
              confirmação antes de mandar mensagens, mudar o que é de todos ou apagar.
            </small>
          </span>
        </label>
      )}
      <p className="kv">
        {admin
          ? `O assistente usa a chave marcada, cobrada na conta dela pela Anthropic. ${info.access === 'list' ? 'Ela vale para você e para as pessoas que você liberar abaixo.' : 'Ela vale para todo mundo, menos para quem usar uma chave própria.'}`
          : 'O assistente usa a chave configurada pelo administrador do app. Também dá para usar uma chave própria: nesse caso, os pedidos são cobrados na conta dela e o modelo é escolhido aqui.'}
      </p>

      <div className="settings-sec">{admin ? 'Chave da API em uso' : 'Qual chave usar'}</div>
      <div className="agent-keys-list" role="radiogroup" aria-label="Chave em uso">
        {!admin && (
          <KeyRow
            name={name}
            active={!ownActive}
            disabled={busy}
            onPick={() => choose('')}
            icon={<Building2 size={18} />}
            title="Chave do app"
            tag="padrão"
            sub={
              info.appKey
                ? `Configurada pelo administrador · ${info.appModel}`
                : info.appBlocked
                  ? 'O administrador não liberou a chave do app para você'
                  : 'O administrador ainda não pôs uma chave'
            }
          />
        )}
        {keys.map((k) => (
          <KeyRow
            key={k.id}
            name={name}
            active={k.active}
            disabled={busy || !canEdit}
            onPick={() => choose(k.id)}
            icon={k.env ? <Server size={18} /> : <KeyRound size={18} />}
            title={k.label}
            hint={shown[k.id] || k.hint}
            revealed={Boolean(shown[k.id])}
          >
            {canEdit && (
              <span className="agent-key-tools">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => toggleShow(k)}
                  title={shown[k.id] ? 'Esconder' : 'Ver a chave inteira'}
                  aria-label={shown[k.id] ? 'Esconder a chave' : 'Ver a chave inteira'}
                >
                  {shown[k.id] ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button type="button" className="icon-btn" onClick={() => copy(k)} title="Copiar" aria-label="Copiar a chave">
                  <Copy size={16} />
                </button>
                {!k.env && (
                  <button type="button" className="icon-btn danger" disabled={busy} onClick={() => remove(k)} title="Apagar esta chave" aria-label="Apagar esta chave">
                    <Trash2 size={16} />
                  </button>
                )}
              </span>
            )}
          </KeyRow>
        ))}
        {!keys.length && (
          <p className="agent-keys-empty">
            {admin ? 'Nenhuma chave ainda. Sem chave, o assistente não funciona, mesmo ligado.' : 'Você ainda não pôs nenhuma chave sua.'}
          </p>
        )}
      </div>

      {canEdit ? (
        <form
          className="agent-key-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) add();
          }}
        >
          <div className="agent-key-add-head">
            <Plus size={16} aria-hidden="true" />
            <b>Adicionar uma chave</b>
            <small>Crie em console.anthropic.com, em API Keys</small>
          </div>
          <div className="agent-key-add-fields">
            <input placeholder="Nome (opcional)" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} disabled={busy} aria-label="Nome da chave" />
            <input
              type="password"
              autoComplete="off"
              placeholder="sk-ant-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={busy}
              aria-label="Chave da API da Anthropic"
            />
            <button className="btn" type="submit" disabled={busy || !key.trim()}>
              {busy ? 'Conferindo…' : 'Adicionar'}
            </button>
          </div>
        </form>
      ) : (
        <p className="kv">Só o dono do app mexe nas chaves.</p>
      )}

      <div className="settings-sec">Modelo</div>
      <div className="agent-model">
        <Cpu size={18} className="ico-purple" aria-hidden="true" />
        {custom ? (
          <form
            className="agent-model-custom"
            onSubmit={(e) => {
              e.preventDefault();
              setCustom(false);
              saveModel(model);
            }}
          >
            <input autoFocus value={model} placeholder="claude-…" onChange={(e) => setModel(e.target.value)} aria-label="Nome do modelo" disabled={busy} />
            <button className="btn" type="submit" disabled={busy || !model.trim()}>
              Usar
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setCustom(false);
                setModel(info.model || '');
              }}
            >
              Cancelar
            </button>
          </form>
        ) : (
          <select
            value={current || ''}
            disabled={!modelEditable || busy}
            aria-label="Modelo do assistente"
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setModel('');
                setCustom(true);
                return;
              }
              setModel(e.target.value);
              saveModel(e.target.value);
            }}
          >
            {!admin && <option value="">Igual ao do app ({info.appModel})</option>}
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                {admin && m.id === info.defaultModel ? ' · padrão' : ''}
              </option>
            ))}
            <option value={OTHER}>Outro modelo…</option>
          </select>
        )}
      </div>
      <p className="agent-model-note">
        {admin
          ? info.access === 'list'
            ? 'Vale para você e para quem você liberar abaixo.'
            : 'Vale para todos que usam a chave do app.'
          : ownActive
            ? 'Vale só para você, com a sua chave.'
            : 'Com a chave do app, o modelo é o que o administrador escolheu. Para escolher, use uma chave sua.'}
      </p>
      {!admin && (
        <>
          <div className="settings-sec">Confirmações</div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(info.auto)}
              disabled={busy}
              onChange={(e) =>
                run(() => api().put(paths.view, { auto: e.target.checked }), e.target.checked ? 'Modo automático ligado' : 'Modo automático desligado')
              }
            />
            <span>
              Modo automático
              <small className="check-hint">
                O assistente faz as ações sem pedir confirmação: mandar mensagens, pôr música, mudar canais e cargos, agendar e apagar. Antes de apagar
                algo que não tem volta, ele confere com você no texto.
              </small>
            </span>
          </label>
        </>
      )}
      {admin && <AppAccess info={info} canEdit={canEdit} busy={busy} run={run} api={api} />}
      {admin && <AppRepeat info={info} canEdit={canEdit} busy={busy} run={run} api={api} />}
      {admin && <AppUsage api={api} />}
      {admin && <AppJobs api={api} />}
    </div>
  );
}

/**
 * Quem usa o assistente (painel): todo mundo, ou só as pessoas que o dono liberar (por nome de usuário). Para
 * quem não está na lista, o assistente nem aparece; quem está nela usa a chave e o modelo do app.
 */
function AppAccess({ info, canEdit, busy, run, api }) {
  const [name, setName] = useState('');
  const people = info.people || [];
  const list = info.access === 'list';
  const setAccess = (v) => run(() => api().put('/api/admin/agent', { access: v }), v === 'list' ? 'Só as pessoas escolhidas' : 'Assistente para todos');
  const add = async () => {
    if (await run(() => api().post('/api/admin/agent/people', { username: name.trim() }), 'Liberado')) setName('');
  };
  return (
    <div className="agent-access">
      <div className="settings-sec">
        <Users size={14} aria-hidden="true" /> Quem usa o assistente
      </div>
      <div className="agent-access-opts" role="radiogroup" aria-label="Quem usa o assistente">
        <label className="checkbox">
          <input type="radio" name="agent-access" checked={!list} disabled={!canEdit || busy} onChange={() => setAccess('all')} />
          <span>
            Todo mundo
            <small className="check-hint">O assistente aparece para todos. Quem não usar uma chave própria usa a do app.</small>
          </span>
        </label>
        <label className="checkbox">
          <input type="radio" name="agent-access" checked={list} disabled={!canEdit || busy} onChange={() => setAccess('list')} />
          <span>
            Só as pessoas que eu escolher
            <small className="check-hint">
              O assistente só aparece para quem você liberar, com a chave e o modelo do app. Para os outros, ele não aparece. Você
              (@{info.owner}) sempre tem acesso.
            </small>
          </span>
        </label>
      </div>
      {list && (
        <>
          {canEdit && (
            <form
              className="adm-grant"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) add();
              }}
            >
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="nome_de_usuario" aria-label="Usuário para liberar o assistente" disabled={busy} />
              <button className="btn" disabled={busy || !name.trim()}>
                <UserPlus size={15} /> Liberar
              </button>
            </form>
          )}
          {people.length === 0 ? (
            <p className="kv">Ninguém liberado ainda: só você vê o assistente.</p>
          ) : (
            <div className="adm-viewers">
              {people.map((p) => (
                <div className="block-row" key={p.user.id}>
                  <Avatar user={p.user} size={22} frame={false} />
                  <span className="nm">
                    <UserName user={p.user} /> <small>@{p.user.username}</small>
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      className="gloss mini"
                      title="Tirar a liberação"
                      aria-label={`Tirar a liberação de ${plain(p.user.displayName) || p.user.username}`}
                      disabled={busy}
                      onClick={() => run(() => api().del(`/api/admin/agent/people/${encodeURIComponent(p.user.id)}`), 'Liberação retirada')}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Quem pode agendar com o assistente tarefas que se repetem ("todo dia às 9h…"). Agendar uma vez vale para todos. */
const REPEAT_OPTS = [
  ['none', 'Ninguém', 'O assistente só agenda tarefas para uma vez. As que já repetiam rodam a próxima vez e param.'],
  ['admins', 'Só administradores do app', 'Quem vê o painel do administrador pode repetir; os outros agendam uma vez só.'],
  ['all', 'Todo mundo', 'Qualquer pessoa com o assistente pode agendar tarefas que se repetem (as do assistente, no mínimo de hora em hora).'],
];
const REPEAT_DONE = { none: 'Repetir desligado', admins: 'Repetir só para administradores', all: 'Repetir para todos' };

function AppRepeat({ info, canEdit, busy, run, api }) {
  const value = info.repeat || 'admins';
  return (
    <div className="agent-access">
      <div className="settings-sec">
        <Repeat size={14} aria-hidden="true" /> Tarefas agendadas que se repetem
      </div>
      <div className="agent-access-opts" role="radiogroup" aria-label="Quem agenda tarefas que se repetem">
        {REPEAT_OPTS.map(([v, label, hint]) => (
          <label key={v} className="checkbox">
            <input
              type="radio"
              name="agent-repeat"
              checked={value === v}
              disabled={!canEdit || busy}
              onChange={() => run(() => api().put('/api/admin/agent', { repeat: v }), REPEAT_DONE[v])}
            />
            <span>
              {label}
              <small className="check-hint">{hint}</small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

const USAGE_RANGES = [
  [7, '7 dias'],
  [30, '30 dias'],
  [0, 'Tudo'],
];
const fmtTokens = (n) => new Intl.NumberFormat('pt-BR', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n || 0);

/** Tokens gastos com o assistente por pessoa (painel): no período escolhido, com a parte paga pela chave da própria pessoa. */
function AppUsage({ api }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const load = (d = days) =>
    api()
      .get(`/api/admin/agent/usage?days=${d}`)
      .then(setData, (e) => useStore.getState().notify(e.message));
  useEffect(() => {
    load(days);
  }, [days]);
  const people = data?.people || [];
  const t = data?.total;
  return (
    <div className="agent-access agent-usage">
      <div className="settings-sec agent-jobs-head">
        <Coins size={14} aria-hidden="true" /> Tokens gastos
        <span className="agent-usage-range" role="radiogroup" aria-label="Período">
          {USAGE_RANGES.map(([d, label]) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} className={`gloss mini${days === d ? ' pressed' : ''}`} onClick={() => setDays(d)}>
              {label}
            </button>
          ))}
        </span>
        <button type="button" className="gloss mini" title="Atualizar" aria-label="Atualizar os tokens gastos" onClick={() => load()}>
          <RefreshCw size={13} />
        </button>
      </div>
      {!data ? (
        <p className="kv">Carregando…</p>
      ) : people.length === 0 ? (
        <p className="kv">Ninguém usou o assistente neste período.</p>
      ) : (
        <div className="agent-usage-wrap">
          <table className="agent-usage-table">
            <thead>
              <tr>
                <th scope="col">Pessoa</th>
                <th scope="col">Pedidos</th>
                <th scope="col" title="Tokens de entrada (sem o cache)">Entrada</th>
                <th scope="col" title="Tokens de saída (inclui o raciocínio)">Saída</th>
                <th scope="col" title="Cache lido / escrito">Cache</th>
                <th scope="col">Total</th>
                <th scope="col" title="Parte paga pela chave da própria pessoa">Chave própria</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.user.id}>
                  <th scope="row">
                    <span className="agent-usage-who">
                      <Avatar user={p.user} size={20} frame={false} />
                      <UserName user={p.user} />
                    </span>
                  </th>
                  <td>{fmtTokens(p.total.requests)}</td>
                  <td>{fmtTokens(p.total.input)}</td>
                  <td>{fmtTokens(p.total.output)}</td>
                  <td>
                    {fmtTokens(p.total.cacheRead)} / {fmtTokens(p.total.cacheWrite)}
                  </td>
                  <td className="agent-usage-total" title={`${(p.total.tokens || 0).toLocaleString('pt-BR')} tokens · ${p.total.webSearches} pesquisas`}>
                    {fmtTokens(p.total.tokens)}
                  </td>
                  <td>{p.own.tokens ? fmtTokens(p.own.tokens) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{fmtTokens(t.requests)}</td>
                <td>{fmtTokens(t.input)}</td>
                <td>{fmtTokens(t.output)}</td>
                <td>
                  {fmtTokens(t.cacheRead)} / {fmtTokens(t.cacheWrite)}
                </td>
                <td className="agent-usage-total">{fmtTokens(t.tokens)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <small className="kv">Contado a partir desta versão. Os pedidos das tarefas agendadas entram na conta de quem agendou.</small>
    </div>
  );
}

const JOB_KIND = { message: 'Mensagem', action: 'Ação', task: 'Tarefa do assistente' };
const fmtWhen = (ts) =>
  new Date(ts).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function repeatLabel(min) {
  if (!min) return 'uma vez';
  if (min === 1440) return 'todo dia';
  if (min === 10080) return 'toda semana';
  if (min % 1440 === 0) return `a cada ${min / 1440} dias`;
  if (min % 60 === 0) return `a cada ${min / 60} h`;
  return `a cada ${min} min`;
}

/** As tarefas agendadas de todo mundo (painel): de quem é, o que faz, quando roda; o dono pode apagar. */
function AppJobs({ api }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api()
      .get('/api/admin/agent/jobs')
      .then(setData, (e) => useStore.getState().notify(e.message));
  useEffect(() => {
    load();
  }, []);
  const remove = (job) =>
    useStore.getState().openModal({
      type: 'confirm',
      title: 'Apagar a tarefa agendada?',
      text: `${JOB_KIND[job.kind] || 'Tarefa'} de ${plain(job.user.displayName) || job.user.username}: “${job.what}”. Ela não roda mais, e a pessoa recebe um aviso.`,
      confirmLabel: 'Apagar',
      action: async () => {
        setBusy(true);
        try {
          setData(await api().del(`/api/admin/agent/jobs/${encodeURIComponent(job.id)}`));
          useStore.getState().notify('Tarefa apagada', 'info');
        } catch (e) {
          useStore.getState().notify(e.message);
          load();
        } finally {
          setBusy(false);
        }
      },
    });
  const jobs = data?.jobs || [];
  return (
    <div className="agent-access agent-jobs">
      <div className="settings-sec agent-jobs-head">
        <CalendarClock size={14} aria-hidden="true" /> Tarefas agendadas
        {data && <span className="agent-jobs-count">{jobs.length}</span>}
        <button type="button" className="gloss mini" title="Atualizar a lista" aria-label="Atualizar a lista de tarefas agendadas" onClick={load} disabled={busy}>
          <RefreshCw size={13} />
        </button>
      </div>
      {!data ? (
        <p className="kv">Carregando…</p>
      ) : jobs.length === 0 ? (
        <p className="kv">Ninguém tem tarefas agendadas agora.</p>
      ) : (
        <ul className="agent-jobs-list" aria-label="Tarefas agendadas">
          {jobs.map((j) => (
            <li key={j.id} className="agent-job">
              <Avatar user={j.user} size={26} frame={false} />
              <div className="agent-job-main">
                <div className="agent-job-top">
                  <UserName user={j.user} /> <small>@{j.user.username}</small>
                  <span className={`agent-job-kind k-${j.kind}`}>{JOB_KIND[j.kind] || j.kind}</span>
                </div>
                <div className="agent-job-what">{j.what}</div>
                <div className="agent-job-meta">
                  <span title={new Date(j.runAt).toLocaleString('pt-BR')}>Próxima: {fmtWhen(j.runAt)}</span>
                  <span>{repeatLabel(j.repeatMinutes)}</span>
                  {j.runs > 0 && <span>rodou {j.runs}×</span>}
                  {j.lastError && <span className="agent-job-err" title={j.lastError}>último erro: {j.lastError}</span>}
                </div>
              </div>
              {data.canEdit && (
                <button
                  type="button"
                  className="gloss mini danger-ico"
                  title="Apagar esta tarefa"
                  aria-label={`Apagar a tarefa de ${plain(j.user.displayName) || j.user.username}: ${j.what}`}
                  disabled={busy}
                  onClick={() => remove(j)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const OTHER = '__outro__';

/** Uma opção da lista de chaves: o círculo de seleção, o ícone, o nome (com "Em uso") e a chave escondida. */
function KeyRow({ name, active, disabled, onPick, icon, title, tag, sub, hint, revealed, children }) {
  return (
    <label className={`agent-key-row${active ? ' on' : ''}${disabled ? ' locked' : ''}`}>
      <input className="sr-only" type="radio" name={name} checked={active} disabled={disabled} onChange={onPick} aria-label={`Usar ${title}`} />
      <span className="agent-key-radio" aria-hidden="true" />
      <span className="agent-key-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="agent-key-name">
        <span className="agent-key-title">
          <b>{title}</b>
          {tag && <span className="agent-key-tag">{tag}</span>}
          {active && <span className="agent-key-badge">Em uso</span>}
        </span>
        {hint && <span className={`agent-key-hint${revealed ? ' full' : ''}`}>{hint}</span>}
        {sub && <small>{sub}</small>}
      </span>
      {children}
    </label>
  );
}
