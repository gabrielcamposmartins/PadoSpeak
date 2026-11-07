// Cargos de cada servidor (veja server/src/roles.rs, vindo dos "times" do HardLine): a etiqueta colorida
// embaixo do nome (junto da mensagem pessoal, sem tomar o lugar dela) e a janela Cargos (botão ao lado de
// Convidar), onde quem tem a permissão cria, edita e apaga os cargos. Como em Membros e permissões: à
// esquerda os cargos, à direita quem tem o escolhido e as permissões que ele dá.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Search, X, Users, ShieldCheck } from 'lucide-react';
import { useStore } from '../store.js';
import Avatar, { UserName } from './Avatar.jsx';
import { plain } from '../lib/text.js';
import { rolesOn } from '../modules.js';

/** Cores prontas para os cargos (qualquer outra no seletor). */
export const ROLE_COLORS = ['#1a8fd6', '#18aab2', '#2b9a4a', '#7cb518', '#e39a1c', '#c2410c', '#d9534f', '#db2777', '#7b44c8', '#5b7690'];

const NONE = [];
const nameOf = (u) => plain(u.displayName) || u.username;
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'pt-BR', { sensitivity: 'base' });

/** Os cargos do servidor (carrega na primeira vez; depois chegam sozinhos por `roles:update`). */
export function useRoles(guildId) {
  const on = useStore(rolesOn);
  const roles = useStore((s) => (guildId ? s.guildRoles[guildId] : null));
  useEffect(() => {
    if (on && guildId && roles === undefined) useStore.getState().loadRoles(guildId);
  }, [on, guildId, roles]);
  return (on && roles) || NONE;
}

/** Os cargos que a pessoa tem no servidor. */
export function useUserRoles(guildId, userId) {
  const roles = useRoles(guildId);
  return useMemo(() => roles.filter((t) => t.members.includes(userId)), [roles, userId]);
}

/** Um cargo numa etiqueta com a cor dele. */
export function RolePill({ role, onClick, on }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`role-pill${onClick ? ' pick' : ''}${on === false ? ' off' : ''}`}
      style={{ '--role': role.color }}
      onClick={onClick}
      aria-pressed={onClick ? Boolean(on) : undefined}
      title={role.name}
    >
      <span className="role-pill-name">{role.name}</span>
    </Tag>
  );
}

/**
 * Os cargos da pessoa em etiquetas (junto da mensagem pessoal, nunca no lugar dela), sempre numa linha só: as que não cabem
 * viram "+N" no fim da linha (com os nomes na dica). Mede as cápsulas numa cópia escondida.
 */
export function RolePills({ guildId, userId }) {
  const mine = useUserRoles(guildId, userId);
  const box = useRef(null);
  const [fit, setFit] = useState(mine.length);
  const key = mine.map((t) => `${t.id}:${t.name}`).join('|');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => {
      const width = el.clientWidth;
      const pills = [...el.querySelectorAll('.role-pills-measure > .role-pill:not(.more)')].map((p) => p.offsetWidth);
      const more = el.querySelector('.role-pills-measure > .more')?.offsetWidth || 26;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 3;
      const all = pills.reduce((n, w) => n + w, 0) + gap * Math.max(0, pills.length - 1);
      if (all <= width) return setFit(pills.length);
      let used = 0;
      let n = 0;
      while (n < pills.length) {
        const next = used + (n ? gap : 0) + pills[n];
        if (next + gap + more > width) break;
        used = next;
        n++;
      }
      // pelo menos uma (cortada com "…") antes do +N
      setFit(Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);
  if (!mine.length) return null;
  const shown = mine.slice(0, fit);
  const rest = mine.slice(fit);
  return (
    <span className="role-pills" ref={box}>
      {shown.map((t) => (
        <RolePill key={t.id} role={t} />
      ))}
      {rest.length > 0 && (
        <span className="role-pill more" title={rest.map((t) => t.name).join(', ')}>
          +{rest.length}
        </span>
      )}
      <span className="role-pills-measure" aria-hidden="true">
        {mine.map((t) => (
          <RolePill key={t.id} role={t} />
        ))}
        <span className="role-pill more">+{mine.length}</span>
      </span>
    </span>
  );
}

/**
 * Botão "+" discreto que abre a busca e a lista do que dá para escolher (`items`); escolher chama `onPick`
 * e a lista continua aberta para escolher mais. `text(item)`: o texto da busca; `render(item)`: a linha.
 */
function PickPop({ items, onPick, text, render, placeholder, label, empty }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const t = q.trim().toLowerCase();
  const found = items.filter((it) => !t || text(it).toLowerCase().includes(t));
  return (
    <span className="people-picker" ref={ref}>
      <button
        type="button"
        className={`people-add${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <Plus size={14} />
      </button>
      {open && (
        <div className="people-pop" role="dialog" aria-label={label}>
          <label className="role-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={q}
              autoFocus
              placeholder={placeholder}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (found[0]) {
                    onPick(found[0]);
                    setQ('');
                  }
                }
              }}
              aria-label={placeholder}
            />
          </label>
          <div className="people-found">
            {found.slice(0, 60).map((it) => (
              <button
                key={it.id}
                type="button"
                className="people-opt"
                onClick={() => {
                  onPick(it);
                  setQ('');
                }}
              >
                {render(it)}
              </button>
            ))}
            {!found.length && <p className="kv">{items.length ? 'Nada encontrado.' : empty}</p>}
          </div>
        </div>
      )}
    </span>
  );
}

/** O "+" de pessoas: busca entre `candidates` (membros ou amigos). */
export function PeoplePicker({ candidates, onPick, placeholder = 'Procurar pessoas', label = 'Adicionar pessoas' }) {
  return (
    <PickPop
      items={[...candidates].sort(byName)}
      onPick={onPick}
      text={(u) => `${nameOf(u)} ${u.username}`}
      placeholder={placeholder}
      label={label}
      empty="Todos já foram adicionados."
      render={(u) => (
        <>
          <Avatar user={u} size={22} frame={false} />
          <UserName user={u} />
          <small>@{u.username}</small>
        </>
      )}
    />
  );
}

/** O bonequinho do cargo (como o do botão Início, mas um só) com a cor dele. */
export function RoleIcon({ color, size = 22 }) {
  return (
    <svg className="role-icon" width={size} height={size * 1.1} viewBox="0 0 20 22" aria-hidden="true" style={{ '--role': color }}>
      <circle className="role-icon-head" cx="10" cy="6.6" r="5.2" strokeWidth="1.2" />
      <path className="role-icon-body" d="M1.4 21.2c0-6.4 3.9-10 8.6-10s8.6 3.6 8.6 10z" strokeWidth="1.2" />
    </svg>
  );
}

/** Cores prontas e o seletor para qualquer outra. */
function RoleColors({ value, onPick }) {
  const custom = value && !ROLE_COLORS.includes(value);
  return (
    <div className="look-swatches role-colors" role="radiogroup" aria-label="Cor do cargo">
      {ROLE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          className={`swatch-btn${value === c ? ' on' : ''}`}
          style={{ '--sw': c }}
          onClick={() => onPick(c)}
        />
      ))}
      <label className={`swatch-btn picker${custom ? ' on' : ''}`} title="Escolher outra cor" style={custom ? { '--sw': value } : undefined}>
        <input type="color" aria-label="Outra cor" value={value || ROLE_COLORS[0]} onChange={(e) => onPick(e.target.value.toLowerCase())} />
        <span aria-hidden="true">+</span>
      </label>
    </div>
  );
}

const countBits = (n) => {
  let c = 0;
  for (let b = n; b; b &= b - 1) c++;
  return c;
};

/**
 * A janela Cargos: à esquerda os cargos (e criar um novo), à direita o escolhido: nome, cor, quem o tem
 * (o "+" adiciona) e as permissões que ele dá (`renderPerms(bits, onToggle, disabled, who)`, a mesma tela
 * de Membros e permissões). Permissões e quem tem um cargo que dá permissões: só administradores.
 */
export function RolesManager({ guildId, perms, renderPerms }) {
  const roles = useRoles(guildId);
  const members = useStore((s) => s.guildData[guildId]?.members) || NONE;
  const st = useStore.getState();
  const [sel, setSel] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = perms.roles;
  const picked = roles.find((t) => t.id === sel) || roles[0] || null;
  const run = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      st.notify(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const color = ROLE_COLORS[roles.length % ROLE_COLORS.length];
    const before = new Set(roles.map((t) => t.id));
    await run(async () => {
      await st.createRole(guildId, { name: name.trim(), color, members: [] });
      setName('');
      const made = (useStore.getState().guildRoles[guildId] || NONE).find((t) => !before.has(t.id));
      if (made) setSel(made.id);
    });
  };
  return (
    <div className="pm-split roles-split">
      <nav className="pm-list" aria-label="Cargos do servidor">
        {canEdit && (
          <form className="role-new" onSubmit={create}>
            <input value={name} maxLength={32} placeholder="Novo cargo (ex.: Moderação)" onChange={(e) => setName(e.target.value)} aria-label="Nome do cargo novo" />
            <button className="gloss round mini" disabled={busy || !name.trim()} title="Criar cargo" aria-label="Criar cargo">
              <Plus size={15} />
            </button>
          </form>
        )}
        {roles.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`pm-item${picked?.id === t.id ? ' on' : ''}`}
            aria-current={picked?.id === t.id || undefined}
            onClick={() => setSel(t.id)}
            style={{ '--role': t.color }}
          >
            <RoleIcon color={t.color} />
            <span className="pm-item-name">
              <b>{t.name}</b>
              <small>
                {t.members.length} {t.members.length === 1 ? 'pessoa' : 'pessoas'}
                {t.perms ? ` · ${countBits(t.perms)} ${countBits(t.perms) === 1 ? 'permissão' : 'permissões'}` : ''}
              </small>
            </span>
          </button>
        ))}
        {!roles.length && <p className="kv">{canEdit ? 'Nenhum cargo ainda: dê um nome acima para criar o primeiro.' : 'Este servidor ainda não tem cargos.'}</p>}
      </nav>
      <section className="pm-detail">
        {picked ? (
          <RoleDetail key={picked.id} guildId={guildId} role={picked} members={members} perms={perms} renderPerms={renderPerms} />
        ) : (
          <p className="kv">
            Os cargos aparecem numa etiqueta colorida embaixo do nome (a mensagem pessoal continua lá) e podem dar permissões a quem os tem.
            Uma pessoa pode ter vários cargos.
          </p>
        )}
      </section>
    </div>
  );
}

/** O cargo escolhido: nome, cor, apagar, quem está nele e as permissões que dá. */
function RoleDetail({ guildId, role, members, perms, renderPerms }) {
  const st = useStore.getState();
  const [name, setName] = useState(role.name);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(role.name), [role.name]);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = (patch) => run(() => st.updateRole(guildId, role.id, patch));
  // cargo que dá permissões: só administradores mexem em quem o tem (senão quem gerencia se daria permissões)
  const locked = Boolean(role.perms) && !perms.admin;
  const canEdit = perms.roles;
  const canPeople = canEdit && !locked;
  const withRole = members.filter((m) => role.members.includes(m.id)).sort(byName);
  const outside = members.filter((m) => !role.members.includes(m.id));
  return (
    <div className="role-detail" style={{ '--role': role.color }}>
      <div className="pm-detail-head">
        <RoleIcon color={role.color} size={28} />
        {canEdit ? (
          <input
            className="role-name"
            value={name}
            maxLength={32}
            aria-label="Nome do cargo"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => (name.trim() && name.trim() !== role.name ? save({ name: name.trim() }) : setName(role.name))}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        ) : (
          <b className="role-name-ro">{role.name}</b>
        )}
        <RolePill role={{ ...role, name: name.trim() || role.name }} />
        {canEdit &&
          !locked &&
          (confirm ? (
            <span className="role-confirm">
              <button type="button" className="btn danger small-btn" disabled={busy} onClick={() => run(() => st.deleteRole(guildId, role.id))}>
                Apagar
              </button>
              <button type="button" className="btn ghost small-btn" onClick={() => setConfirm(false)}>
                Cancelar
              </button>
            </span>
          ) : (
            <button type="button" className="gloss mini danger-ico" title="Apagar o cargo" aria-label="Apagar o cargo" onClick={() => setConfirm(true)}>
              <Trash2 size={14} />
            </button>
          ))}
      </div>
      <div className="role-detail-body">
        {canEdit && (
          <div className="field">
            <span>Cor</span>
            <RoleColors value={role.color} onPick={(color) => color !== role.color && save({ color })} />
          </div>
        )}
        <div className="role-block">
          <div className="role-block-head">
            <Users size={14} aria-hidden="true" />
            <b>Pessoas com o cargo ({withRole.length})</b>
            {canPeople && (
              <PeoplePicker
                candidates={outside}
                placeholder="Procurar no servidor"
                label="Dar o cargo a mais pessoas"
                onPick={(u) => save({ members: [...role.members, u.id] })}
              />
            )}
          </div>
          {locked && <p className="kv">Este cargo dá permissões: só administradores escolhem quem o tem.</p>}
          {withRole.length ? (
            <div className="role-people">
              {withRole.map((m) => (
                <span key={m.id} className="role-person">
                  <Avatar user={m} size={26} frame={false} />
                  <span className="role-person-name">
                    <UserName user={m} />
                    <small>@{m.username}</small>
                  </span>
                  {canPeople && (
                    <button
                      type="button"
                      className="role-x"
                      disabled={busy}
                      aria-label={`Tirar o cargo de ${nameOf(m)}`}
                      title="Tirar o cargo"
                      onClick={() => save({ members: role.members.filter((id) => id !== m.id) })}
                    >
                      <X size={14} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <p className="kv">Ninguém com este cargo ainda{canPeople ? ': use o + para adicionar.' : '.'}</p>
          )}
        </div>
        <div className="role-block">
          <div className="role-block-head">
            <ShieldCheck size={14} aria-hidden="true" />
            <b>Permissões do cargo</b>
          </div>
          <p className="kv">
            Quem tem o cargo ganha estas permissões, somadas às que já tem.{' '}
            {perms.admin ? '' : 'Só administradores mudam as permissões de um cargo.'}
          </p>
          {renderPerms(role.perms || 0, (bit, on) => save({ perms: on ? (role.perms || 0) | bit : (role.perms || 0) & ~bit }), busy || !perms.admin, role.name)}
        </div>
      </div>
    </div>
  );
}
