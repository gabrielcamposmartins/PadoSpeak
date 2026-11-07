// Chamar mais gente para a chamada de uma conversa privada: amigos de quem chama (e o outro da conversa,
// se ainda não entrou). Quem não é da conversa entra só na chamada (veja `GuestCall.jsx`).
import { useState } from 'react';
import { Phone, UserPlus } from 'lucide-react';
import { useStore } from '../store.js';
import { useVoiceConn } from './conn.jsx';
import Avatar from './Avatar.jsx';
import { FormattedText } from './Emotes.jsx';
import { plain } from '../lib/text.js';

/** Até quantas pessoas cabem numa chamada privada (o servidor confere: `hub::CALL_MAX`). */
const CALL_MAX = 10;

export function CallInviteModal({ close }) {
  const vc = useVoiceConn();
  const voice = vc((s) => s.voice);
  const allFriends = vc((s) => s.friends);
  const online = vc((s) => s.online);
  const me = vc((s) => s.me);
  const invites = vc((s) => s.callInvites);
  const dm = vc((s) => (s.voice?.dm ? s.dms.find((d) => d.id === s.voice.channelId) : null));
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Map());
  const [busy, setBusy] = useState(false);
  if (!voice?.dm) {
    return (
      <div className="modal-body">
        <p className="sub">A chamada acabou.</p>
      </div>
    );
  }
  const inCall = new Set([me?.id, ...voice.peers.map((p) => p.user?.id)]);
  const calling = new Set(invites.map((i) => i.user.id));
  // O outro da conversa que ainda não entrou (pode ser chamado de novo) vem primeiro, depois os amigos.
  const people = [];
  if (dm && !inCall.has(dm.recipient.id)) people.push(dm.recipient);
  for (const f of Object.values(allFriends)) {
    if (f.status === 'friend' && !inCall.has(f.user.id) && !people.some((p) => p.id === f.user.id)) people.push(f.user);
  }
  const needle = q.trim().toLowerCase();
  const list = people
    .filter((u) => `${plain(u.displayName)} ${u.username}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(Boolean(online[b.id])) - Number(Boolean(online[a.id])));
  const room = CALL_MAX - inCall.size - calling.size;
  const toggle = (u) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(u.id)) next.delete(u.id);
      else if (next.size < room) next.set(u.id, u);
      return next;
    });
  const send = async () => {
    setBusy(true);
    try {
      const users = [...picked.values()];
      await vc.getState().inviteToCall(users);
      useStore.getState().notify(users.length === 1 ? `Chamando ${plain(users[0].displayName)}…` : `Chamando ${users.length} pessoas…`, 'info');
      close();
    } catch (e) {
      useStore.getState().notify(e.message);
      setBusy(false);
    }
  };
  return (
    <>
      <div className="modal-body">
        <h2>Chamar para a chamada</h2>
        <p className="sub">Quem não é desta conversa entra só na chamada, sem ver as mensagens. Cabem até {CALL_MAX} pessoas.</p>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar amigos" aria-label="Buscar amigos" />
        <div className="pick-list">
          {list.length === 0 && <p className="sub">{people.length ? 'Ninguém com esse nome.' : 'Todos os seus amigos já estão na chamada.'}</p>}
          {list.map((u) => {
            const on = picked.has(u.id);
            const ringing = calling.has(u.id);
            return (
              <label key={u.id} className={`pick-row pick-check${on ? ' on' : ''}`}>
                <input type="checkbox" checked={on} disabled={!on && picked.size >= room} onChange={() => toggle(u)} />
                <Avatar user={u} size={32} online={Boolean(online[u.id])} />
                <span>
                  <b>
                    <FormattedText text={u.displayName} />
                  </b>{' '}
                  <small>{ringing ? 'chamando…' : `@${u.username}`}</small>
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button className="btn" disabled={busy || picked.size === 0} onClick={send}>
          <Phone size={15} /> {picked.size > 1 ? `Chamar ${picked.size} pessoas` : 'Chamar'}
        </button>
      </div>
    </>
  );
}

/** Botão "Chamar mais gente" (no dock da chamada, na conversa e na tela de chamada do celular). */
export function InviteButton({ className = 'ball', label = false }) {
  const open = () => useStore.getState().openModal({ type: 'callInvite' });
  return (
    <button type="button" className={className} onClick={open} title="Chamar mais gente para a chamada" aria-label="Chamar mais gente para a chamada">
      <UserPlus size={label ? 20 : undefined} className={label ? 'ico-green' : undefined} />
      {label && 'Chamar mais'}
    </button>
  );
}

/** "Chamando Ana, Bia…": quem foi chamado e ainda não entrou. */
export function PendingInvites() {
  const vc = useVoiceConn();
  const invites = vc((s) => s.callInvites);
  if (!invites.length) return null;
  const names = invites.map((i) => plain(i.user.displayName));
  return (
    <div className="call-pending" role="status">
      <span className="call-pending-faces">
        {invites.slice(0, 3).map((i) => (
          <Avatar key={i.user.id} user={i.user} size={22} />
        ))}
      </span>
      Chamando {names.length > 3 ? `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}` : names.join(', ')}…
    </div>
  );
}
