// Sons rápidos: os botões de gel logo abaixo da lista de canais / amigos online, e a folha que abre na
// tela de chamada do celular. Mostra só os sons que estão no atalho (de 1 a 3 linhas de 3); sem nenhum,
// só a linha "Sons rápidos — Nenhum". Montar o atalho e a biblioteca fica em Configurações → Sons.
// Na chamada, um toque toca para todos; fora dela, toca só para você ouvir. À direita do título, a
// caixa de som dos efeitos sonoros dos outros (ver SoundFx.jsx).
import { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { useVoiceConn } from './conn.jsx';
import { SoundIcon } from './SoundIcons.jsx';
import { plain } from '../lib/text.js';
import { playSoundboard } from '../lib/soundboard.js';
import SoundFx from './SoundFx.jsx';

/** Som tocado há pouco por outra pessoa (para oferecer "Copiar"). */
function useRecentOther(vc, meId) {
  const last = vc((s) => s.soundLast);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => tick((n) => n + 1), 8000);
    return () => clearTimeout(t);
  }, [last]);
  if (!last || last.by?.id === meId || Date.now() - last.at > 8000) return null;
  return last;
}

/** Relógio que anda (4 vezes por segundo) só enquanto algum som está esperando para tocar de novo. */
function useCooldownClock(cooldowns) {
  const [now, setNow] = useState(Date.now());
  const until = Math.max(0, ...Object.values(cooldowns || {}).map((c) => c.until));
  useEffect(() => {
    if (until <= Date.now()) return;
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [until]);
  return now;
}

export default function SoundPanel({ variant = 'side' }) {
  const vc = useVoiceConn();
  const lib = vc((s) => s.sounds);
  const voice = vc((s) => s.voice);
  const me = vc((s) => s.me);
  const guildOff = vc((s) => (s.voice && !s.voice.dm ? s.guilds.find((g) => g.id === s.voice.guildId)?.sounds === false : false));
  const volume = useStore((s) => s.prefs.soundboardVolume ?? 0.8);
  const [playing, setPlaying] = useState(null);
  const recent = useRecentOther(vc, me?.id);
  const [copied, setCopied] = useState(null);
  const cooldowns = vc((s) => s.soundCooldowns);
  const now = useCooldownClock(cooldowns);
  if (!me) return null;
  const st = vc.getState();
  const rows = lib?.rows || 1;
  const byId = new Map((lib?.sounds || []).map((x) => [x.id, x]));
  // Só os botões com som, na ordem do atalho.
  const board = (lib?.slots || [])
    .slice(0, rows * 3)
    .map((id) => id && byId.get(id))
    .filter(Boolean);
  const live = Boolean(voice) && !guildOff;

  const waitOf = (snd) => {
    const c = cooldowns[snd.id];
    return live && c && c.until > now ? c : null;
  };
  const press = (snd) => {
    // Esperando: não manda de novo (o servidor recusaria), só mostra quanto falta.
    if (waitOf(snd)) return;
    setPlaying(snd.id);
    setTimeout(() => setPlaying((p) => (p === snd.id ? null : p)), 700);
    if (live) st.playBoardSound(snd.id);
    else playSoundboard(st.soundUrl(snd), volume).catch(() => {});
  };
  const copy = async (snd) => {
    try {
      await st.copySound(snd.id);
      setCopied(snd.id);
      useStore.getState().notify(`“${snd.name}” foi para a sua biblioteca.`, 'info');
    } catch (e) {
      useStore.getState().notify(e.message);
    }
  };
  const hasSpace = (lib?.sounds.length || 0) < (lib?.max || 10);
  const empty = board.length === 0;

  return (
    <section className={`sound-panel aero-glass ${variant}${live ? ' live' : ''}${empty ? ' empty' : ''}`} aria-label="Sons rápidos">
      <div className="sp-head">
        <span className="aero-title">
          <svg className="orb" viewBox="0 0 32 32" aria-hidden="true">
            <use href="#snd-orb" />
          </svg>
          Sons rápidos
          {empty && <span className="sp-none">— Nenhum</span>}
        </span>
        {!empty && variant === 'sheet' && <small className="sp-hint">{live ? 'toque para todos ouvirem' : 'entre numa chamada'}</small>}
        <span className="sp-grow" />
        <SoundFx />
      </div>
      {guildOff && !empty && <p className="sp-note">Os sons rápidos estão desligados neste servidor.</p>}
      {!empty && (
        <div className="sp-grid">
          {board.map((snd) => {
            const wait = waitOf(snd);
            const left = wait ? Math.ceil((wait.until - now) / 1000) : 0;
            return (
              <button
                key={snd.id}
                type="button"
                className={`snd t-${snd.tone}${playing === snd.id ? ' playing' : ''}${live ? '' : ' idle'}${wait ? ' cooling' : ''}`}
                onClick={() => press(snd)}
                aria-disabled={wait ? true : undefined}
                title={
                  wait
                    ? `Espere ${left} s para tocar “${snd.name}” de novo`
                    : live
                      ? `Tocar “${snd.name}” para todos da chamada`
                      : `Ouvir “${snd.name}” (fora de chamada, só você ouve)`
                }
                aria-label={wait ? `${snd.name}: espere ${left} segundos` : live ? `Tocar ${snd.name} para todos` : `Ouvir ${snd.name}`}
              >
                <SoundIcon icon={snd.icon} />
                <span className="n">{snd.name}</span>
                {wait && (
                  <span className="snd-wait" aria-hidden="true">
                    <i style={{ height: `${Math.max(0, Math.min(100, ((wait.until - now) / (wait.until - wait.from)) * 100))}%` }} />
                    <b>{left}</b>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {recent && (
        <div className="sp-recent" role="status">
          <span className="sp-recent-txt">
            <b>{plain(recent.by.displayName)}</b> tocou “{recent.sound.name}”
          </span>
          {copied !== recent.sound.id && hasSpace && (
            <button type="button" className="sp-copy" onClick={() => copy(recent.sound)}>
              Copiar para mim
            </button>
          )}
        </div>
      )}
    </section>
  );
}
