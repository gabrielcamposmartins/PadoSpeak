// Caixa de som ao lado de "Sons rápidos": o volume dos efeitos sonoros (aparece ao passar o mouse),
// clique muta os efeitos dos outros para mim, e o botão direito abre quem está na chamada para mutar
// cada pessoa — para mim, ou para todos do servidor (administrador).
import { useRef, useState } from 'react';
import { useStore, usePerms } from '../store.js';
import { useVoiceConn } from './conn.jsx';
import { SoundIcon } from './SoundIcons.jsx';
import VolumeSlider from './Volume.jsx';
import Avatar, { UserName } from './Avatar.jsx';
import { PointMenu } from './VoiceMenus.jsx';
import { plain } from '../lib/text.js';

const NOBODY = [];

export function useSoundFx() {
  const off = useStore((s) => Boolean(s.prefs.soundboardOff));
  const volume = useStore((s) => s.prefs.soundboardVolume ?? 0.8);
  const set = (patch) => useStore.getState().setAppearance(patch);
  return { off, volume, setOff: (v) => set({ soundboardOff: v }), setVolume: (v) => set({ soundboardVolume: v, soundboardOff: false }) };
}

/** Botões "Para mim" e "Para todos" de uma pessoa. */
export function SoundMuteChips({ user, guildId, conn }) {
  const mine = useStore((s) => Boolean(s.prefs.soundMutes?.[user.id]));
  const perms = usePerms(conn, guildId);
  const all = conn((s) => Boolean(guildId && s.guilds.find((g) => g.id === guildId)?.soundMutes?.includes(user.id)));
  const name = plain(user.displayName) || user.username;
  return (
    <span className="fx-chips">
      <button
        type="button"
        className={`fx-chip${mine ? ' on' : ''}`}
        aria-pressed={mine}
        title={mine ? `Voltar a ouvir os efeitos de ${name}` : `Não ouvir os efeitos de ${name} (só você)`}
        onClick={() => useStore.getState().toggleSoundMute(user)}
      >
        Para mim
      </button>
      {guildId && perms.admin && (
        <button
          type="button"
          className={`fx-chip all${all ? ' on' : ''}`}
          aria-pressed={all}
          title={all ? `Deixar ${name} tocar efeitos de novo neste servidor` : `Ninguém do servidor ouve os efeitos de ${name}`}
          onClick={() => conn.getState().setGuildSoundMute(guildId, user.id, !all)}
        >
          Para todos
        </button>
      )}
    </span>
  );
}

/** Menu do botão direito: volume, mutar todos e cada pessoa da chamada (mais quem já está mutado). */
function SoundFxMenu({ x, y, onClose }) {
  const vc = useVoiceConn();
  const { off, volume, setOff, setVolume } = useSoundFx();
  const me = vc((s) => s.me?.id);
  const voice = vc((s) => s.voice);
  const participants = vc((s) => (s.voice ? s.voiceStates[s.voice.channelId] : null)) || NOBODY;
  const muted = useStore((s) => s.prefs.soundMutes) || {};
  const guildId = voice && !voice.dm ? voice.guildId : null;
  const people = [];
  for (const p of participants) if (p.user.id !== me && !people.some((u) => u.id === p.user.id)) people.push(p.user);
  const away = Object.entries(muted)
    .filter(([id]) => !people.some((u) => u.id === id))
    .map(([id, u]) => ({ id, displayName: u.displayName, username: u.username }));
  return (
    <PointMenu x={x} y={y} onClose={onClose} label="Efeitos sonoros">
      <div className="ctx-head">
        <SoundIcon icon={off ? 'speaker-off' : 'speaker'} className="fx-head-ico" /> Efeitos sonoros
      </div>
      <div className="ctx-vol">
        <VolumeSlider label="Volume dos efeitos sonoros" value={volume} onChange={setVolume} />
      </div>
      <label className="ctx-item fx-all">
        <input type="checkbox" checked={off} onChange={(e) => setOff(e.target.checked)} />
        <span>Mutar os efeitos de todos (para mim)</span>
      </label>
      <div className="fx-sec">{voice ? 'Na chamada' : 'Entre numa chamada para ver quem está nela'}</div>
      {voice && !people.length && <p className="fx-empty">Só você por aqui.</p>}
      {people.map((u) => (
        <div className="fx-person" key={u.id}>
          <Avatar user={u} size={22} frame={false} />
          <span className="fx-name">
            <UserName user={u} />
          </span>
          <SoundMuteChips user={u} guildId={guildId} conn={vc} />
        </div>
      ))}
      {away.length > 0 && (
        <>
          <div className="fx-sec">Mutados por você</div>
          {away.map((u) => (
            <div className="fx-person" key={u.id}>
              <span className="fx-name">{plain(u.displayName) || u.username}</span>
              <SoundMuteChips user={u} guildId={null} conn={vc} />
            </div>
          ))}
        </>
      )}
    </PointMenu>
  );
}

/** A caixa de som do painel. */
export default function SoundFx() {
  const { off, volume, setOff, setVolume } = useSoundFx();
  const [menu, setMenu] = useState(null);
  // Celular: sem mouse, o toque longo abre o menu (que também tem o volume).
  const hold = useRef({ timer: 0, fired: false });
  const startHold = (e) => {
    if (e.pointerType === 'mouse') return;
    const { clientX: x, clientY: y } = e;
    hold.current.fired = false;
    clearTimeout(hold.current.timer);
    hold.current.timer = setTimeout(() => {
      hold.current.fired = true;
      setMenu({ x, y });
    }, 500);
  };
  const endHold = () => clearTimeout(hold.current.timer);
  const label = off ? 'Efeitos sonoros mutados: clique para ouvir de novo' : 'Clique para mutar os efeitos sonoros dos outros';
  return (
    <span className={`sp-fx${off ? ' off' : ''}`}>
      <span className="sp-fx-pop aero-glass" role="group" aria-label="Volume dos efeitos sonoros">
        <VolumeSlider label="Volume dos efeitos sonoros" value={off ? 0 : volume} onChange={setVolume} />
      </span>
      <button
        type="button"
        className="sp-fx-btn"
        aria-pressed={off}
        aria-label={off ? 'Ouvir os efeitos sonoros' : 'Mutar os efeitos sonoros'}
        title={`${label} · botão direito (ou toque longo): volume e mutar pessoas específicas`}
        onClick={() => {
          if (hold.current.fired) hold.current.fired = false;
          else setOff(!off);
        }}
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onPointerCancel={endHold}
        onContextMenu={(e) => {
          e.preventDefault();
          endHold();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <SoundIcon icon={off ? 'speaker-off' : 'speaker'} className="sp-fx-ico" />
      </button>
      {menu && <SoundFxMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </span>
  );
}
