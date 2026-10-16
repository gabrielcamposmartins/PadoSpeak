// Biblioteca de sons rápidos (até 10): enviar um áudio curto escolhendo nome, ícone e cor de gel, ouvir,
// editar, apagar e escolher quais ficam nos botões do atalho. E a lista dos sons de outra pessoa,
// com "Copiar" para a sua biblioteca.
import { useEffect, useRef, useState } from 'react';
import { Play, Pencil, Trash2, Upload, Check, X } from 'lucide-react';
import { useStore, getConn } from '../store.js';
import { SoundIcon, SOUND_ICONS, SOUND_TONES } from './SoundIcons.jsx';
import { playSoundboard, audioDuration } from '../lib/soundboard.js';
import { plain } from '../lib/text.js';

const MAX_BYTES = 1024 * 1024;
const MAX_SECONDS = 5;
const fmtSec = (ms) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;

function useVolume() {
  return useStore((s) => s.prefs.soundboardVolume ?? 0.8);
}

/** Formulário de um som: nome, ícone e cor (enviar um novo ou editar). */
function SoundForm({ initial, file, onCancel, onSave, busy }) {
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [tone, setTone] = useState(initial.tone);
  return (
    <form
      className="snd-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave({ name: name.trim(), icon, tone });
      }}
    >
      <div className="snd-form-top">
        <span className={`snd preview t-${tone}`} aria-hidden="true">
          <SoundIcon icon={icon} />
          <span className="n">{name || 'Som'}</span>
        </span>
        <label className="field grow">
          <span>Nome</span>
          <input id="snd-name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoFocus />
          {file && <small>{file}</small>}
        </label>
      </div>
      <div className="field">
        <span id="snd-icon-label">Ícone</span>
        <div className="snd-icons" role="radiogroup" aria-labelledby="snd-icon-label">
          {SOUND_ICONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={icon === id}
              className={`snd-icon-pick${icon === id ? ' on' : ''}`}
              title={label}
              aria-label={label}
              onClick={() => setIcon(id)}
            >
              <SoundIcon icon={id} />
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span id="snd-tone-label">Cor do botão</span>
        <div className="snd-tones" role="radiogroup" aria-labelledby="snd-tone-label">
          {SOUND_TONES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={tone === id}
              className={`snd-tone-pick t-${id}${tone === id ? ' on' : ''}`}
              title={label}
              aria-label={label}
              onClick={() => setTone(id)}
            />
          ))}
        </div>
      </div>
      <div className="snd-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn green" disabled={busy || !name.trim()}>
          {busy ? 'Enviando…' : 'Salvar'}
        </button>
      </div>
    </form>
  );
}

export function SoundsModal({ slot = null, conn }) {
  const store = getConn(conn);
  const lib = store((s) => s.sounds);
  const volume = useVolume();
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null); // { file, durationMs }
  const [editing, setEditing] = useState(null); // id
  const [confirm, setConfirm] = useState(null); // id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const st = store.getState();
  useEffect(() => {
    if (!lib) st.loadSounds();
  }, []);
  if (!lib) return <div className="modal-body">Carregando…</div>;
  const { sounds, slots, rows, max } = lib;
  const size = rows * 3;
  const inBoard = (id) => slots.slice(0, size).includes(id);
  const freeSlots = slots.slice(0, size).filter((x) => !x).length;

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setError('');
    if (!file) return;
    if (file.size > MAX_BYTES) return setError(`“${file.name}” tem ${(file.size / 1048576).toFixed(1)} MB. O máximo é 1 MB.`);
    try {
      const seconds = await audioDuration(file);
      if (seconds > MAX_SECONDS + 0.25)
        return setError(`“${file.name}” tem ${seconds.toFixed(1)} s. O máximo é ${MAX_SECONDS} s: corte o áudio e envie de novo.`);
      setPending({ file, durationMs: seconds * 1000 });
    } catch {
      setError(`Não deu para ler “${file.name}”. Use um áudio MP3, OGG, WAV ou M4A.`);
    }
  };
  const save = async (meta) => {
    setBusy(true);
    setError('');
    try {
      const snd = await st.uploadSound(pending.file, { ...meta, durationMs: pending.durationMs });
      // Abriu pela casa vazia: o som novo vai para ela.
      if (slot != null && !inBoard(snd.id)) {
        const next = [...store.getState().sounds.slots.map((x) => (x === snd.id ? null : x))];
        next[slot] = snd.id;
        await st.setSoundBoard(next, rows);
      }
      setPending(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const toggleBoard = (id) => {
    const next = [...slots];
    if (inBoard(id)) next[next.indexOf(id)] = null;
    else {
      const at = slot != null && !next[slot] ? slot : next.findIndex((x, i) => !x && i < size);
      if (at < 0) return;
      next[at] = id;
    }
    st.setSoundBoard(next, rows).catch((e) => setError(e.message));
  };

  return (
    <div className="modal-body sound-lib">
      <div className="sl-head">
        <p className="kv">
          {slot != null ? `Escolha o som do botão ${slot + 1}, ou envie um novo.` : 'Seus sons rápidos. Os que estão “No atalho” aparecem nos botões.'}
        </p>
        <span className="sl-count">
          {sounds.length} de {max}
        </span>
        <button type="button" className="btn" disabled={sounds.length >= max || Boolean(pending)} onClick={() => fileRef.current?.click()}>
          <Upload size={15} /> Enviar som…
        </button>
        <input ref={fileRef} type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a" hidden onChange={pick} />
      </div>
      {error && (
        <p className="sl-error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <SoundForm
          initial={{ name: pending.file.name.replace(/\.[^.]+$/, '').slice(0, 24), icon: 'horn', tone: 'aqua' }}
          file={`${pending.file.name} · ${fmtSec(pending.durationMs)}`}
          busy={busy}
          onCancel={() => setPending(null)}
          onSave={save}
        />
      )}
      {sounds.length === 0 && !pending && (
        <p className="sl-empty">Nenhum som ainda. Envie um áudio de até 5 segundos, ou copie de alguém: quando uma pessoa toca um som na chamada, aparece “Copiar para mim”.</p>
      )}
      <ul className="sl-list">
        {sounds.map((snd) =>
          editing === snd.id ? (
            <li key={snd.id} className="sl-edit">
              <SoundForm
                initial={snd}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={async (meta) => {
                  setBusy(true);
                  try {
                    await st.editSound(snd.id, meta);
                    setEditing(null);
                  } catch (e) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </li>
          ) : (
            <li key={snd.id}>
              <span className={`sl-ico snd-tone t-${snd.tone}`}>
                <SoundIcon icon={snd.icon} />
              </span>
              <span className="sl-meta">
                <b>{snd.name}</b>
                <small>{fmtSec(snd.durationMs)}</small>
              </span>
              <button type="button" className="sl-btn" title="Ouvir" aria-label={`Ouvir ${snd.name}`} onClick={() => playSoundboard(st.soundUrl(snd), volume)}>
                <Play size={14} />
              </button>
              <button
                type="button"
                className={`sl-slot${inBoard(snd.id) ? ' in' : ''}`}
                disabled={!inBoard(snd.id) && freeSlots === 0}
                title={!inBoard(snd.id) && freeSlots === 0 ? 'O atalho está cheio: tire um som ou adicione uma linha' : undefined}
                onClick={() => toggleBoard(snd.id)}
              >
                {inBoard(snd.id) ? (
                  <>
                    <Check size={13} /> No atalho
                  </>
                ) : (
                  'Pôr no atalho'
                )}
              </button>
              <button type="button" className="sl-btn" title="Editar" aria-label={`Editar ${snd.name}`} onClick={() => setEditing(snd.id)}>
                <Pencil size={14} />
              </button>
              {confirm === snd.id ? (
                <span className="sl-confirm">
                  Apagar?
                  <button
                    type="button"
                    className="sl-btn red"
                    aria-label="Sim, apagar"
                    onClick={() => {
                      setConfirm(null);
                      st.deleteSound(snd.id).catch((e) => setError(e.message));
                    }}
                  >
                    <Check size={14} />
                  </button>
                  <button type="button" className="sl-btn" aria-label="Não apagar" onClick={() => setConfirm(null)}>
                    <X size={14} />
                  </button>
                </span>
              ) : (
                <button type="button" className="sl-btn" title="Apagar" aria-label={`Apagar ${snd.name}`} onClick={() => setConfirm(snd.id)}>
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ),
        )}
      </ul>
      <p className="sl-foot">
        MP3, OGG, WAV ou M4A de até 5 segundos e 1 MB. O som fica na sua conta e aparece em todos os seus aparelhos. Na chamada, cada pessoa
        pode tocar um som a cada 2 segundos.
      </p>
    </div>
  );
}

/** Sons de outra pessoa: ouvir e copiar para a minha biblioteca. */
export function UserSoundsModal({ userId, conn }) {
  const store = getConn(conn);
  const user = store((s) => s.users[userId]);
  const lib = store((s) => s.sounds);
  const volume = useVolume();
  const [list, setList] = useState(null);
  const [copied, setCopied] = useState({});
  const [error, setError] = useState('');
  const st = store.getState();
  useEffect(() => {
    st.userSounds(userId)
      .then(setList)
      .catch((e) => setError(e.message));
    if (!lib) st.loadSounds();
  }, [userId]);
  const full = (lib?.sounds.length || 0) >= (lib?.max || 10);
  return (
    <div className="modal-body sound-lib">
      <p className="kv">{user ? `Sons de ${plain(user.displayName)}.` : 'Sons desta pessoa.'} Ouça e copie para a sua biblioteca.</p>
      {error && <p className="sl-error">{error}</p>}
      {list && list.length === 0 && <p className="sl-empty">Esta pessoa ainda não tem sons.</p>}
      <ul className="sl-list">
        {(list || []).map((snd) => (
          <li key={snd.id}>
            <span className={`sl-ico snd-tone t-${snd.tone}`}>
              <SoundIcon icon={snd.icon} />
            </span>
            <span className="sl-meta">
              <b>{snd.name}</b>
              <small>{fmtSec(snd.durationMs)}</small>
            </span>
            <button type="button" className="sl-btn" title="Ouvir" aria-label={`Ouvir ${snd.name}`} onClick={() => playSoundboard(st.soundUrl(snd), volume)}>
              <Play size={14} />
            </button>
            <button
              type="button"
              className={`sl-slot${copied[snd.id] ? ' in' : ''}`}
              disabled={Boolean(copied[snd.id]) || full}
              title={full ? 'Sua biblioteca já tem 10 sons' : undefined}
              onClick={async () => {
                try {
                  await st.copySound(snd.id);
                  setCopied((c) => ({ ...c, [snd.id]: true }));
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              {copied[snd.id] ? (
                <>
                  <Check size={13} /> Copiado
                </>
              ) : (
                'Copiar'
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
