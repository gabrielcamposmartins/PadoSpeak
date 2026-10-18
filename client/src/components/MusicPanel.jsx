import { useEffect, useState } from 'react';
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  RotateCcw,
  Music,
  X,
  LoaderCircle,
  Volume2,
  ArrowLeft,
  History,
  Star,
  TrendingUp,
  ListPlus,
  Lock,
} from 'lucide-react';
import { useStore, usePerms } from '../store.js';
import { MusicPlayer } from '../lib/music.js';
import { plain } from '../lib/text.js';
import VolumeSlider from './Volume.jsx';
import { FormattedText } from './Emotes.jsx';

const fmt = (sec) => {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Links soltos/colados: aceita vários, separados por linha ou espaço (ignora comentários do text/uri-list). */
export function extractLinks(text) {
  return [
    ...new Set(
      String(text || '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => /^(https?:\/\/|spotify:)/i.test(s)),
    ),
  ];
}

const isSpotify = (track) => /spotify/i.test(track.pageUrl || '');

/** Mesma chave do servidor (`music::library::track_key`): a mesma música em links diferentes. */
export function trackKey(pageUrl = '') {
  const url = pageUrl.trim();
  const v = url.split(/[?&]/).find((p) => p.startsWith('v='));
  if (v) return `yt:${v.slice(2, 18)}`;
  if (url.startsWith('https://youtu.be/')) return `yt:${url.slice(17).split(/[?/]/)[0]}`;
  return url.split('?')[0].replace(/\/+$/, '');
}

/** Estrela: favorita/desfavorita a música. */
function FavStar({ track }) {
  const favorites = useStore((s) => s.musicLibrary.favorites);
  const key = trackKey(track.pageUrl);
  const on = favorites.some((f) => f.key === key);
  if (!track.pageUrl) return null;
  return (
    <button
      type="button"
      className={`gloss mini fav-star${on ? ' on' : ''}`}
      title={on ? 'Tirar das favoritas' : 'Favoritar'}
      aria-label={on ? `Tirar ${track.title} das favoritas` : `Favoritar ${track.title}`}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        useStore.getState().toggleFavorite(track, !on);
      }}
    >
      <Star size={13} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

/** Lista recolhível (Tocadas recentemente, Favoritas, Mais tocadas). */
function TrackSection({ icon: Icon, title, tracks, canAdd, empty, extra }) {
  const [open, setOpen] = useState(false);
  const { addMusic } = useStore.getState();
  return (
    <>
      <div className="queue-head">
        <button type="button" className="history-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon size={13} /> {title} ({tracks.length})
        </button>
      </div>
      {open &&
        (tracks.length === 0 ? (
          <p className="music-section-empty">{empty}</p>
        ) : (
          <ol className="music-queue music-history">
            {tracks.map((t) => (
              <li key={t.id || t.key} title={`${t.title}${t.addedBy ? ` · por ${plain(t.addedBy.displayName)}` : ''}`}>
                <div className="mq-text">
                  <span className="mq-title">{t.title}</span>
                  <span className="mq-sub">
                    <Source track={t} />
                    {t.addedBy?.displayName ? <FormattedText text={t.addedBy.displayName} size={13} /> : t.artist}
                    {t.durationMs ? ` · ${fmt(t.durationMs / 1000)}` : ''}
                    {extra?.(t)}
                  </span>
                </div>
                <FavStar track={t} />
                {canAdd && (
                  <button
                    type="button"
                    className="gloss mini"
                    title="Adicionar à fila"
                    aria-label={`Adicionar ${t.title} à fila`}
                    onClick={() => addMusic([t.pageUrl])}
                  >
                    <ListPlus size={13} />
                  </button>
                )}
              </li>
            ))}
          </ol>
        ))}
    </>
  );
}

function Source({ track }) {
  return isSpotify(track) ? <span className="src sp">Spotify</span> : <span className="src yt">YouTube</span>;
}

/** Arte padrão do player quando a faixa não tem capa: céu, colina, bolhas e a nota musical. */
function CoverArt() {
  return (
    <svg viewBox="0 0 270 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="npBub" cx=".5" cy=".5" r=".5">
          <stop offset=".55" stopColor="#fff" stopOpacity="0" />
          <stop offset=".92" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity=".9" />
        </radialGradient>
      </defs>
      <path d="M0 120 C 60 90, 140 92, 200 104 S 260 98, 270 94 L270 120 Z" fill="#9be86a" opacity=".85" />
      <path d="M40 -10 L90 120 L60 120 Z" fill="#fff" opacity=".12" />
      <circle cx="210" cy="36" r="20" fill="url(#npBub)" />
      <circle cx="203" cy="28" r="5" fill="#fff" opacity=".8" />
      <circle cx="244" cy="70" r="10" fill="url(#npBub)" />
      <circle cx="176" cy="74" r="7" fill="url(#npBub)" />
      <g
        transform="translate(46 26)"
        fill="none"
        stroke="#fff"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".95"
      >
        <path d="M18 52V12l36-6v40" />
        <circle cx="10" cy="52" r="8" fill="#fff" />
        <circle cx="46" cy="46" r="8" fill="#fff" />
      </g>
    </svg>
  );
}

/** Sem a permissão: o botão fica apagado e o balão explica. */
const noPerm = (what) => `Você não tem permissão para ${what} neste servidor`;

/**
 * `perms`: minhas permissões de música no servidor; `mine`: a música atual foi eu que pus (pular e
 * recomeçar a própria música sempre pode).
 */
function NowPlaying({ state, perms, mine }) {
  const canPrev = perms.musicPrevious;
  const canRestart = mine || perms.musicRestartOthers;
  const canPause = mine || perms.musicPauseOthers;
  const canSkip = mine || perms.musicSkipOthers;
  const { current } = state;
  const { track } = current;
  const offset = useStore((s) => s.serverOffset);
  const volume = useStore((s) => s.prefs.musicVolume ?? 0.5);
  const { musicControl, setMusicVolume } = useStore.getState();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const loading = current.startedAt == null;
  const paused = current.pausedAt != null;
  const pos = MusicPlayer.position(state, Date.now() + offset);
  const dur = track.durationMs ? track.durationMs / 1000 : NaN;

  return (
    <div className="now-playing">
      <div className="np-cover">
        {track.thumbnail ? <img src={track.thumbnail} alt="" /> : <CoverArt />}
        <span className="np-gloss" />
      </div>
      <div className="np-body">
        <div className="np-src">
          <Source track={track} />
          {track.addedBy && (
            <span>
              adicionado por <FormattedText text={track.addedBy.displayName} size={13} />
            </span>
          )}
        </div>
        <div className="np-title-row">
          <a className="np-title" href={track.pageUrl} target="_blank" rel="noreferrer" title={track.title}>
            {track.title}
          </a>
          <FavStar track={track} />
        </div>
        {track.artist && <div className="np-artist">{track.artist}</div>}
        <div
          className="np-progress"
          role="progressbar"
          aria-label="Progresso da música"
          aria-valuemin={0}
          aria-valuemax={Number.isFinite(dur) ? Math.round(dur) : undefined}
          aria-valuenow={Math.round(pos)}
        >
          <div style={{ width: `${Number.isFinite(dur) ? Math.min(100, (pos / dur) * 100) : 0}%` }} />
        </div>
        <div className="np-time">
          <span>{loading ? 'carregando…' : fmt(pos)}</span>
          <span>{fmt(dur)}</span>
        </div>
        <div className="np-controls">
          <button
            className="ball small"
            title={canPrev ? 'Voltar para a anterior' : noPerm('voltar para a música anterior')}
            aria-label="Voltar para a música anterior"
            disabled={!canPrev || !state.history?.length}
            onClick={() => musicControl('previous')}
          >
            <SkipBack />
          </button>
          <button
            className="ball small"
            title={canRestart ? 'Recomeçar a música' : noPerm('recomeçar a música de outra pessoa')}
            aria-label="Recomeçar a música"
            disabled={!canRestart || loading}
            onClick={() => musicControl('restart')}
          >
            <RotateCcw />
          </button>
          <button
            className="ball aqua"
            title={canPause ? (paused ? 'Retomar' : 'Pausar') : noPerm('pausar a música de outra pessoa')}
            aria-label={paused ? 'Retomar' : 'Pausar'}
            disabled={!canPause || loading}
            onClick={() => musicControl(paused ? 'resume' : 'pause')}
          >
            {paused ? <Play /> : <Pause />}
          </button>
          <button
            className="ball small"
            title={canSkip ? 'Pular' : noPerm('pular a música de outra pessoa')}
            aria-label="Pular faixa"
            disabled={!canSkip}
            onClick={() => musicControl('skip')}
          >
            <SkipForward />
          </button>
          <label className="np-volume">
            Volume da música (só você)
            <VolumeSlider label="Volume da música" value={volume} onChange={setMusicVolume} />
          </label>
        </div>
      </div>
    </div>
  );
}

export default function MusicPanel() {
  const voice = useStore((s) => s.voice);
  const guildId = useStore((s) => s.currentGuildId);
  const channels = useStore((s) => s.guildData[s.currentGuildId]?.channels) || [];
  const music = useStore((s) => s.music);
  const adding = useStore((s) => s.musicAdding);
  const library = useStore((s) => s.musicLibrary);
  const { addMusic, musicControl, joinVoice, toggleMusicPanel } = useStore.getState();
  // Permissões de música do servidor (cada controle tem a sua; as próprias músicas sempre dá para tirar).
  const perms = usePerms(useStore, guildId);
  const meId = useStore((s) => s.me?.id);
  const canAdd = perms.musicAdd;
  const currentId = useStore((s) => (voice?.channelId ? s.music[voice.channelId]?.current?.track.id : null));
  // Favoritas e mais tocadas: ao abrir o painel e a cada música nova.
  useEffect(() => {
    if (guildId) useStore.getState().loadMusicLibrary(guildId);
  }, [guildId, currentId]);
  const [dragging, setDragging] = useState(false);
  const [link, setLink] = useState('');

  const channelId = voice && voice.guildId === guildId ? voice.channelId : null;
  const channel = channels.find((c) => c.id === channelId);
  const state = channelId ? music[channelId] : null;
  const elsewhere = Object.values(music).filter((m) => m.guildId === guildId && m.channelId !== channelId && m.current);

  const add = (urls) => {
    if (!canAdd) return useStore.getState().notify('Você não tem permissão para pôr músicas neste servidor');
    if (!urls.length) return useStore.getState().notify('Nenhum link do YouTube ou Spotify encontrado');
    addMusic(urls);
  };

  return (
    <div
      className={`music-panel${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = channelId && canAdd ? 'copy' : 'none';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!channelId) return useStore.getState().notify('Entre em um canal de voz para tocar música');
        add(extractLinks(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')));
      }}
    >
      <div className="side-head music-head">
        <button className="gloss mini" title="Voltar aos canais" aria-label="Voltar aos canais" onClick={toggleMusicPanel}>
          <ArrowLeft size={14} />
        </button>
        <div>
          <div className="side-title">Fila de música</div>
          <div className="side-sub">{channel ? `${channel.name} · todos ouvem juntos` : 'Toca no seu canal de voz'}</div>
        </div>
      </div>

      <div className="music-scroll">
        {!channelId ? (
          <div className="music-empty">
            <Music size={28} />
            <p>Entre em um canal de voz para tocar música. A fila toca para todos que estiverem nele.</p>
            {channels
              .filter((c) => c.type === 'voice')
              .map((c) => (
                <button key={c.id} className="btn secondary block" onClick={() => joinVoice(c.id)}>
                  <Volume2 size={16} /> {c.name}
                </button>
              ))}
          </div>
        ) : (
          <>
            {state?.current ? (
              <NowPlaying state={state} perms={perms} mine={state.current.track.addedBy?.id === meId} />
            ) : (
              <div className="music-idle">
                <Music size={26} />
                {canAdd ? (
                  <>
                    <p>Nada tocando. Arraste links do YouTube ou do Spotify para cá.</p>
                    <small>Vídeos, playlists, faixas e álbuns</small>
                  </>
                ) : (
                  <p>Nada tocando.</p>
                )}
                {perms.musicPrevious && state?.history?.length > 0 && (
                  <button className="gloss small-btn" onClick={() => musicControl('previous')}>
                    <SkipBack size={14} /> Tocar de novo a última
                  </button>
                )}
              </div>
            )}

            {adding > 0 && (
              <div className="music-adding">
                <LoaderCircle size={14} className="spin" /> Buscando {adding > 1 ? `${adding} links` : 'link'}…
              </div>
            )}

            {state?.queue.length > 0 && (
              <>
                <div className="queue-head">
                  <span>A seguir ({state.queue.length})</span>
                  {perms.musicClear && (
                    <button className="gloss tiny danger-text" onClick={() => musicControl('clear')}>
                      Limpar fila
                    </button>
                  )}
                </div>
                <ol className="music-queue">
                  {state.queue.map((t, i) => (
                    <li key={t.id} title={`${t.title}${t.addedBy ? ` · por ${plain(t.addedBy.displayName)}` : ''}`}>
                      <span className="q-n">{i + 1}</span>
                      <div className="mq-text">
                        <span className="mq-title">{t.title}</span>
                        <span className="mq-sub">
                          <Source track={t} />
                          {t.addedBy?.displayName ? <FormattedText text={t.addedBy.displayName} size={13} /> : t.artist}
                          {t.durationMs ? ` · ${fmt(t.durationMs / 1000)}` : ''}
                        </span>
                      </div>
                      <FavStar track={t} />
                      {(perms.musicRemoveOthers || t.addedBy?.id === meId) && (
                        <button
                          className="gloss mini mq-del"
                          title="Remover da fila"
                          aria-label="Remover da fila"
                          onClick={() => musicControl('remove', t.id)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}

            {state?.history?.length > 0 && (
              <TrackSection icon={History} title="Tocadas recentemente" tracks={state.history} canAdd={canAdd} />
            )}
            <TrackSection
              icon={Star}
              title="Favoritas"
              tracks={library.favorites}
              canAdd={canAdd}
              empty="Toque na estrela de uma música para guardá-la aqui."
            />
            <TrackSection
              icon={TrendingUp}
              title="Mais tocadas"
              tracks={library.guildId === guildId ? library.top : []}
              canAdd={canAdd}
              empty="Nada tocou neste servidor nas últimas 2 semanas."
              extra={(t) => ` · ${t.plays}×`}
            />
          </>
        )}

        {elsewhere.length > 0 && (
          <>
            <div className="queue-head">
              <span>Tocando em outros canais</span>
            </div>
            {elsewhere.map((m) => (
              <div className="music-elsewhere" key={m.channelId}>
                <Volume2 size={14} /> {channels.find((c) => c.id === m.channelId)?.name}: {m.current.track.title}
              </div>
            ))}
          </>
        )}
      </div>

      {channelId && !canAdd && (
        <p className="music-drop music-locked">
          <Lock size={14} aria-hidden="true" /> Só quem tem permissão pode pôr músicas neste servidor.
        </p>
      )}
      {channelId && canAdd && (
        <form
          className="music-drop music-add"
          onSubmit={(e) => {
            e.preventDefault();
            add(extractLinks(link));
            setLink('');
          }}
        >
          <label htmlFor="musicLink">YouTube/Spotify</label>
          <div className="music-add-row">
            <input
              id="musicLink"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Cole ou arraste um link do YouTube ou Spotify"
            />
            <button className="go" disabled={!link.trim()}>
              Adicionar
            </button>
          </div>
        </form>
      )}

      {dragging && channelId && canAdd && <div className="drop-overlay">Solte para adicionar à fila</div>}
    </div>
  );
}
