import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Hash,
  Pencil,
  Trash2,
  Send,
  PenLine,
  Vibrate,
  Sticker,
  CornerUpLeft,
  Paperclip,
  X,
  SmilePlus,
  Camera,
  Mic,
  Check,
  CheckCheck,
  Eye,
  EyeOff,
  ClipboardPaste,
} from 'lucide-react';
import { useStore, sendSticker, sendFile, sendVoice, usePerms } from '../store.js';
import { FileView, UploadList, parseFile, parseVoice, isBlockedFile, VoiceNote, ExpiresTag } from './Files.jsx';
import { StickerPicker, MessageSticker, parseSticker } from './Stickers.jsx';
import FormatTools, { formatKey } from './FormatTools.jsx';
import { AttachTray, oversized, CAPTION_MAX, CameraCapture, VoiceRecorder, requestMic, fromPhoneCamera } from './Compose.jsx';
import AttachSheet from './AttachSheet.jsx';
import { addRecent } from '../lib/recent.js';
import { useConn, useConnKey } from './conn.jsx';
import Avatar, { UserName, Orb, usePresence, useUser, colorClass, colorStyle } from './Avatar.jsx';
import { RichText, FormattedText, plain, EmojiText, EmojiPicker, Floating, insertText, EMOTES, mentionsUser } from './Emotes.jsx';
import { useLayout, isTouch } from '../lib/layout.js';

/** Abre o perfil de alguém desta conexão (servidor ou PC da rede). */
function useOpenProfile() {
  const conn = useConnKey();
  return (userId) => useStore.getState().openModal({ type: 'profile', userId, conn });
}

const GROUP_MS = 5 * 60 * 1000;
const EMPTY = [];
const NOBODY = { id: null };
const MAX = 4000;

const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Rótulo do separador de dia: HOJE, ONTEM ou a data. */
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'HOJE';
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'ONTEM';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}

/** Aviso local na conversa: "Fulano chamou a sua atenção!" */
function Notice({ n, dm, name }) {
  let text;
  if (n.kind === 'nudge-in') text = <><UserName user={n.author} className="author" /> chamou a sua atenção!</>;
  else if (dm && n.delivered) text = <>Você chamou a atenção de <FormattedText text={name} />.</>;
  else if (dm) text = <><FormattedText text={name} /> não está aceitando chamar atenção agora.</>;
  else if (n.delivered) text = `Você chamou a atenção de ${n.delivered} ${n.delivered === 1 ? 'pessoa' : 'pessoas'} aqui.`;
  else text = 'Você chamou a atenção, mas ninguém aqui está recebendo agora.';
  return (
    <div className="chat-notice nudge" role="status">
      <Vibrate size={14} />
      <span>{text}</span>
      <span className="time">{hhmm(n.createdAt)}</span>
    </div>
  );
}

/** Extensão do arquivo para uma imagem colada. */
const pastedExt = (type) => ({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[type] || 'png';

/**
 * Cola o que estiver copiado (botão do celular, onde não há Ctrl+V): imagens viram anexos e texto entra
 * na caixa, onde estiver o cursor. O navegador pode pedir permissão (ou mostrar "Colar" para tocar).
 */
async function pasteFromClipboard({ inputRef, text, setText, onFiles }) {
  const notify = useStore.getState().notify;
  const clip = navigator.clipboard;
  try {
    if (clip?.read) {
      const files = [];
      let pasted = '';
      for (const item of await clip.read()) {
        const image = item.types.find((t) => t.startsWith('image/'));
        if (image) {
          const blob = await item.getType(image);
          const n = files.length + 1;
          files.push(new File([blob], `colado-${Date.now()}${n > 1 ? `-${n}` : ''}.${pastedExt(image)}`, { type: image }));
        } else if (item.types.includes('text/plain')) pasted += await (await item.getType('text/plain')).text();
      }
      if (files.length) {
        onFiles(files);
        addRecent(files, 'colado');
      }
      if (pasted) insertText(inputRef.current, text, setText, pasted);
      if (!files.length && !pasted) notify('Não há nada copiado para colar.', 'info');
      return;
    }
    if (!clip?.readText) throw new Error('sem acesso');
    const pasted = await clip.readText();
    if (pasted) insertText(inputRef.current, text, setText, pasted);
    else notify('Não há nada copiado para colar.', 'info');
  } catch {
    notify('O navegador não deixou colar daqui. Toque e segure na caixa de texto e escolha “Colar”.', 'info');
  }
}

/** Reações rápidas: as 3 que eu mais uso (contadas neste aparelho); sem histórico, coração, risada e surpresa. */
const QUICK_DEFAULT = ['(L)', ':D', ':O'];
function quickReactions(use = {}) {
  const top = Object.entries(use)
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code);
  return [...new Set([...top, ...QUICK_DEFAULT])].slice(0, 3);
}
const emoteName = (code) => EMOTES.find((e) => e.code === code)?.name || code;
/** Conta uma reação minha (guarda as 20 mais usadas). */
function countReaction(code) {
  const st = useStore.getState();
  const use = { ...(st.prefs.reactionUse || {}) };
  use[code] = (use[code] || 0) + 1;
  st.setAppearance({ reactionUse: Object.fromEntries(Object.entries(use).sort((a, b) => b[1] - a[1]).slice(0, 20)) });
}

/** Barra acima da caixa de texto: formatação, cor, emoticons, colar (celular) e chamar atenção. */
function ComposerTools({ inputRef, text, setText, channelId, target, onFiles, onSticker, onCamera }) {
  const phone = useLayout() === 'phone';
  const [sheet, setSheet] = useState(false); // celular: menu rápido do clipe (recentes, galeria, câmera, arquivos)
  // Celular: o "Chamar atenção" ocupa o resto da linha; o nome encolhe conforme o espaço.
  const nudgeRef = useRef(null);
  const [nudgeFit, setNudgeFit] = useState('full'); // full | short | icon
  useLayoutEffect(() => {
    const el = nudgeRef.current;
    if (!phone || !el || typeof ResizeObserver === 'undefined') return setNudgeFit('full');
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setNudgeFit(w >= 116 ? 'full' : w >= 72 ? 'short' : 'icon');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone]);
  const [open, setOpen] = useState(false);
  const useC = useConn();
  const stickerBtn = useRef(null);
  const fileInput = useRef(null);
  return (
    <FormatTools inputRef={inputRef} text={text} setText={setText} maxRaw={MAX}>
      <button
        type="button"
        className="gloss tool-sq"
        title="Enviar arquivo (imagem, vídeo, texto, .zip…)"
        aria-label="Enviar arquivo"
        aria-haspopup={phone ? 'dialog' : undefined}
        onClick={() => (phone ? setSheet(true) : fileInput.current?.click())}
      >
        <Paperclip size={15} className="ico-blue" />
      </button>
      {sheet && <AttachSheet target={target} onFiles={onFiles} onCamera={onCamera} onClose={() => setSheet(false)} />}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
      <span className="tool-wrap">
        <button
          ref={stickerBtn}
          type="button"
          className={`gloss tool-sq${open ? ' pressed' : ''}`}
          title="Stickers"
          aria-label="Stickers"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Sticker size={15} className="ico-purple" />
        </button>
        {open && (
          <StickerPicker
            anchorRef={stickerBtn}
            onClose={() => setOpen(false)}
            onPick={(st) => {
              setOpen(false);
              onSticker(st);
            }}
          />
        )}
      </span>
      {phone && (
        <button
          type="button"
          className="gloss tool-sq"
          title="Colar o que foi copiado"
          aria-label="Colar"
          onClick={() => pasteFromClipboard({ inputRef, text, setText, onFiles })}
        >
          <ClipboardPaste size={15} className="ico-blue" />
        </button>
      )}
      <button
        ref={nudgeRef}
        type="button"
        className="gloss tool-nudge"
        data-fit={nudgeFit}
        title="Chamar atenção: faz a janela de quem está aqui tremer (até 3 vezes por minuto)"
        aria-label="Chamar atenção"
        onClick={() => useC.getState().sendNudge(channelId)}
      >
        <Vibrate size={15} />
        {nudgeFit !== 'icon' && <span className="tool-label">{nudgeFit === 'short' ? 'Atenção' : 'Chamar atenção'}</span>}
      </button>
    </FormatTools>
  );
}

/** Trecho da mensagem respondida, acima da resposta; clicar leva até ela. */
function ReplyQuote({ m }) {
  if (!m.reply)
    return (
      <div className="reply-quote gone">
        <CornerUpLeft size={13} /> Mensagem original apagada
      </div>
    );
  const jump = () => {
    const el = document.getElementById(`msg-${m.reply.id}`);
    if (!el) return useStore.getState().notify('A mensagem original é mais antiga: carregue as anteriores para vê-la.', 'info');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  };
  return (
    <button type="button" className="reply-quote" onClick={jump} title="Ir para a mensagem respondida">
      <CornerUpLeft size={13} />
      <b>{m.reply.authorName}</b>
      <span>{m.reply.preview}</span>
    </button>
  );
}

/** Reações embaixo da mensagem: clicar numa soma/tira a sua; o "+" escolhe outra. */
function Reactions({ m, me, onPick }) {
  const useC = useConn();
  const users = useC((s) => s.users);
  const friends = useC((s) => s.friends);
  const members = useC((s) => s.guildData[s.currentGuildId]?.members);
  const addBtn = useRef(null);
  const [open, setOpen] = useState(false);
  if (!m.reactions?.length) return null;
  const nameOf = (id) => {
    if (id === me.id) return 'Você';
    const u = users[id] || friends[id]?.user || members?.find((x) => x.id === id) || (m.author.id === id ? m.author : null);
    return u ? plain(u.displayName) || u.username : 'alguém';
  };
  return (
    <div className="reactions">
      {m.reactions.map((r) => {
        const mine = r.users.includes(me.id);
        return (
          <button
            key={r.emoji}
            type="button"
            className={`reaction${mine ? ' mine' : ''}`}
            aria-pressed={mine}
            title={`${r.users.map(nameOf).join(', ')} reagiu com ${r.emoji}`}
            onClick={() => {
              if (!mine) countReaction(r.emoji);
              useC.getState().reactMessage(m.id, r.emoji, !mine);
            }}
          >
            <EmojiText text={r.emoji} size={16} />
            <span>{r.users.length}</span>
          </button>
        );
      })}
      <button ref={addBtn} type="button" className="reaction add" title="Reagir" aria-label="Reagir" onClick={() => setOpen(!open)}>
        <SmilePlus size={14} />
      </button>
      {open && (
        <EmojiPicker
          anchorRef={addBtn}
          onClose={() => setOpen(false)}
          onPick={(code) => {
            setOpen(false);
            onPick(code);
          }}
        />
      )}
    </div>
  );
}

/**
 * Vistos das minhas mensagens: ✓ enviada, ✓✓ recebida, olho quando alguém viu. Num canal de
 * servidor, clicar no olho mostra quem viu.
 */
function Receipt({ state, viewers, guild }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  if (state === 'read')
    return (
      <span className="tool-wrap receipt-wrap">
        <button
          ref={ref}
          type="button"
          className="receipt read"
          title={guild ? 'Ver quem visualizou' : 'Visualizada'}
          aria-label={guild ? `Visualizada por ${viewers.length}` : 'Visualizada'}
          onClick={(e) => {
            e.stopPropagation();
            if (guild) setOpen(!open);
          }}
        >
          <Eye size={13} />
          {guild && viewers.length > 1 && <small>{viewers.length}</small>}
        </button>
        {open && (
          <Floating anchorRef={ref} onClose={() => setOpen(false)} align="right" className="seen-pop" role="dialog" aria-label="Quem visualizou">
            <div className="popover-title">Visualizada por</div>
            {viewers.map((v) => (
              <div className="seen-row" key={v.user.id}>
                <Avatar user={v.user} size={22} frame={false} />
                <UserName user={v.user} />
                <small>{hhmm(v.at)}</small>
              </div>
            ))}
          </Floating>
        )}
      </span>
    );
  return (
    <span className={`receipt ${state}`} title={state === 'delivered' ? 'Recebida' : 'Enviada'} aria-label={state === 'delivered' ? 'Recebida' : 'Enviada'}>
      {state === 'delivered' ? <CheckCheck size={13} /> : <Check size={13} />}
    </span>
  );
}

/** Cor padrão das mensagens: a da pessoa e/ou a do servidor, conforme o servidor escolheu. */
function messageColor(author, guild) {
  const mine = /^#[0-9a-f]{6}$/i.test(author?.messageColor || '') ? author.messageColor : null;
  if (!guild) return mine;
  const server = /^#[0-9a-f]{6}$/i.test(guild.msgColor || '') ? guild.msgColor : null;
  if (guild.msgColorMode === 'server') return server || mine;
  if (guild.msgColorMode === 'user_first') return mine || server;
  return mine;
}

function Message({ m, head, canEdit: canEditText, canDelete, onReply, me, receipt, color, guildId }) {
  const sticker = parseSticker(m.content);
  const parsedFile = !sticker && parseFile(m.content);
  const voice = !sticker && !parsedFile && parseVoice(m.content);
  const caption = sticker?.caption || parsedFile?.caption || '';
  const canEdit = canEditText && !sticker && !parsedFile && !voice;
  // Mensagem de outra pessoa que fala comigo (@meu_usuario ou @everyone): fica destacada.
  const mentionsMe = m.author?.id !== me?.id && mentionsUser(plain(m.content), me?.username);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const useC = useConn();
  const openProfile = useOpenProfile();
  const { editMessage, deleteMessage, setMark } = useC.getState();
  // Foto/vídeo que eu marquei como NSFW (só para mim) aparece borrado como os marcados por quem enviou.
  const nsfwMine = useC((s) => Boolean(s.marks.nsfw[m.id]));
  const file = parsedFile && (nsfwMine && !parsedFile.nsfw ? { ...parsedFile, nsfw: true } : parsedFile);
  const canMarkNsfw = parsedFile && !parsedFile.nsfw && /^(image|video)\//.test(parsedFile.mime);
  const mine = m.author.id === me.id;
  const { openModal } = useStore.getState();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const reactBtn = useRef(null);
  const reactionUse = useStore((s) => s.prefs.reactionUse);
  const quick = quickReactions(reactionUse);
  const reacted = (code) => Boolean(m.reactions?.find((r) => r.emoji === code)?.users.includes(me.id));
  const react = (code) => {
    const mine = reacted(code);
    if (!mine) countReaction(code);
    useC.getState().reactMessage(m.id, code, !mine);
  };
  const rowRef = useRef(null);
  const press = useRef(null);
  const hasTools = true; // responder vale para todas as mensagens
  // Toque: segurar a mensagem mostra "editar" e "excluir"; tocar fora esconde.
  useEffect(() => {
    if (!toolsOpen) return;
    const close = (e) => !rowRef.current?.contains(e.target) && setToolsOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [toolsOpen]);
  const longPress =
    isTouch && hasTools
      ? {
          onTouchStart: () => {
            press.current = setTimeout(() => {
              setToolsOpen(true);
              navigator.vibrate?.(12);
            }, 450);
          },
          onTouchEnd: () => clearTimeout(press.current),
          onTouchMove: () => clearTimeout(press.current),
          onContextMenu: (e) => e.preventDefault(),
        }
      : {};

  const save = () => {
    const c = draft.trim();
    if (c && c !== m.content) editMessage(m.id, c);
    setEditing(false);
  };

  return (
    <div
      ref={rowRef}
      id={`msg-${m.id}`}
      className={`msg${head ? ' head' : ''}${toolsOpen ? ' tools-open' : ''}${mentionsMe ? ' mentioned' : ''}`}
      {...longPress}
    >
      {/* A fotinha de quem escreveu, nos canais e nas conversas privadas. */}
      <div className="msg-pic">
        {head && <Avatar user={m.author} size={30} guildId={guildId} onClick={() => openProfile(m.author.id)} />}
      </div>
      <div className="body">
        {m.replyTo && <ReplyQuote m={m} />}
        {head && (
          <div className="meta">
            <span className="say">
              <UserName user={m.author} className="author" onClick={() => openProfile(m.author.id)} /> diz:
            </span>
            <span className="time">{hhmm(m.createdAt)}</span>
          </div>
        )}
        {editing ? (
          <div className="edit-box">
            <textarea
              autoFocus
              rows={Math.min(8, draft.split('\n').length)}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (formatKey(e, e.currentTarget, draft, setDraft, MAX)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  save();
                } else if (e.key === 'Escape') setEditing(false);
              }}
            />
            <small>Esc para cancelar · Enter para salvar</small>
          </div>
        ) : (
          <div className="content" title={head ? undefined : hhmm(m.createdAt)}>
            {sticker ? (
              <MessageSticker sticker={sticker} />
            ) : file ? (
              <FileView file={file} />
            ) : voice ? (
              <VoiceNote voice={voice} />
            ) : color ? (
              <span className="tc msg-color" style={{ '--tc': color }}>
                <RichText text={m.content} me={me?.username} />
              </span>
            ) : (
              <RichText text={m.content} me={me?.username} />
            )}
            {caption && (
              <div className={`caption${color ? ' tc msg-color' : ''}`} style={color ? { '--tc': color } : undefined}>
                <RichText text={caption} me={me?.username} />
              </div>
            )}
            {m.editedAt && <span className="edited">(editado)</span>}
            {m.expiresAt && <ExpiresTag at={m.expiresAt} />}
            {receipt && <Receipt {...receipt} />}
          </div>
        )}
        <Reactions m={m} me={me} onPick={react} />
      </div>
      {!editing && (
        <div className="tools">
          {quick.map((code) => (
            <button
              key={code}
              type="button"
              className={`icon-btn quick-react${reacted(code) ? ' on' : ''}`}
              title={reacted(code) ? `Tirar a reação ${emoteName(code)}` : `Reagir com ${emoteName(code)}`}
              aria-label={reacted(code) ? `Tirar a reação ${emoteName(code)}` : `Reagir com ${emoteName(code)}`}
              aria-pressed={reacted(code)}
              onClick={() => {
                setToolsOpen(false);
                react(code);
              }}
            >
              <EmojiText text={code} size={17} />
            </button>
          ))}
          <span className="tools-sep" aria-hidden="true" />
          <button
            ref={reactBtn}
            className="icon-btn"
            title="Reagir"
            aria-label="Reagir"
            onClick={() => setPicking((v) => !v)}
          >
            <SmilePlus size={14} />
          </button>
          {picking && (
            <EmojiPicker
              anchorRef={reactBtn}
              align="right"
              onClose={() => setPicking(false)}
              onPick={(code) => {
                setPicking(false);
                setToolsOpen(false);
                react(code);
              }}
            />
          )}
          <button
            className="icon-btn"
            title="Responder"
            aria-label="Responder"
            onClick={() => {
              setToolsOpen(false);
              onReply(m);
            }}
          >
            <CornerUpLeft size={14} />
          </button>
          {canEdit && (
            <button
              className="icon-btn"
              title="Editar"
              onClick={() => (setDraft(m.content), setEditing(true), setToolsOpen(false))}
            >
              <Pencil size={14} />
            </button>
          )}
          {canMarkNsfw && (
            <button
              className={`icon-btn nsfw-mark${nsfwMine ? ' on' : ''}`}
              title={nsfwMine ? 'Tirar a marca NSFW (só para você)' : 'Marcar como NSFW: fica borrado só para você'}
              aria-label={nsfwMine ? 'Tirar a marca NSFW' : 'Marcar como NSFW para mim'}
              aria-pressed={nsfwMine}
              onClick={() => {
                setToolsOpen(false);
                setMark('nsfw', m.id, !nsfwMine);
              }}
            >
              NSFW
            </button>
          )}
          {!mine && (
            <button
              className="icon-btn"
              title="Excluir para mim"
              aria-label="Excluir para mim"
              onClick={(e) => {
                setToolsOpen(false);
                if (e.shiftKey) return setMark('hidden', m.id, true);
                openModal({
                  type: 'confirm',
                  title: 'Excluir para você?',
                  text: 'A mensagem some só para você, em todos os seus aparelhos; as outras pessoas continuam vendo. Dica: segure Shift ao clicar para excluir sem confirmar.',
                  action: () => setMark('hidden', m.id, true),
                });
              }}
            >
              <EyeOff size={14} />
            </button>
          )}
          {canDelete && (
            <button
              className="icon-btn danger"
              title={mine ? 'Excluir' : 'Excluir para todos'}
              onClick={(e) =>
                e.shiftKey
                  ? deleteMessage(m.id)
                  : openModal({
                      type: 'confirm',
                      title: mine ? 'Excluir mensagem?' : 'Excluir para todos?',
                      text: 'Dica: segure Shift ao clicar para excluir sem confirmar.',
                      action: () => deleteMessage(m.id),
                    })
              }
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DmHeader({ recipient }) {
  const user = useUser(recipient);
  const status = usePresence(user.id);
  const openProfile = useOpenProfile();
  return (
    <div className="panel-head to-line">
      <span className="to-label">Para:</span>
      <button className="to-name" onClick={() => openProfile(user.id)}>
        <UserName user={user} />
      </button>
      <Orb status={status} />
      {user.lan && <span className="lan-tag">LAN</span>}
      {user.bio && (
        <span className={colorClass(user.bioColor, 'pm')} style={colorStyle(user.bioColor)}>
          <FormattedText text={user.bio} size={14} />
        </span>
      )}
    </div>
  );
}

/**
 * Conversa de um canal de texto ou de uma DM.
 * `variant="dm"`: painéis separados (mensagens / escrita), sem fotos nas mensagens, como a janela do Messenger.
 */
export default function ChatView({ channel, variant = 'channel' }) {
  const phone = useLayout() === 'phone';
  const [fmtOpen, setFmtOpen] = useState(false);
  const aaBtn = phone && (
    <button
      type="button"
      className={`gloss aa-btn${fmtOpen ? ' pressed' : ''}`}
      aria-label="Formatação, emoticons e stickers"
      aria-expanded={fmtOpen}
      onClick={() => setFmtOpen((v) => !v)}
    >
      Aa
    </button>
  );
  const showTools = !phone || fmtOpen;
  const useC = useConn();
  const allMessages = useC((s) => s.messages[channel.id]) || EMPTY;
  const hiddenForMe = useC((s) => s.marks.hidden);
  const messages = useMemo(() => allMessages.filter((m) => !hiddenForMe[m.id]), [allMessages, hiddenForMe]);
  const loaded = useC((s) => channel.id in s.messages);
  const hasMore = useC((s) => s.hasMore[channel.id]);
  const typing = useC((s) => s.typing[channel.id]);
  const me = useC((s) => s.me) || NOBODY;
  const isAdmin = usePerms(useC, channel.guildId).admin;
  const users = useC((s) => s.users);
  const reads = useC((s) => s.reads[channel.id]);
  const guild = useC((s) => (channel.guildId ? s.guilds.find((g) => g.id === channel.guildId) : null));
  const members = useC((s) => (channel.guildId ? s.guildData[channel.guildId]?.members : null));
  const receiptPrefs = useStore((s) => s.prefs.receipts) || {};
  const showReceipts = receiptPrefs.show !== false;
  // Quem não manda confirmação de leitura também não vê a dos outros (como no WhatsApp).
  const seeReads = receiptPrefs.sendRead !== false;
  /** Estado de uma mensagem minha: sent | delivered | read (com quem viu). */
  const receiptOf = (m) => {
    if (!showReceipts || m.author.id !== me.id) return null;
    const others = Object.entries(reads || {}).filter(([id]) => id !== me.id);
    const viewers = seeReads
      ? others
          .filter(([, r]) => r.readAt >= m.createdAt)
          .map(([id, r]) => ({
            at: r.readAt,
            user: users[id] || members?.find((x) => x.id === id) || (channel.recipient?.id === id ? channel.recipient : { id, displayName: 'alguém', username: '' }),
          }))
      : [];
    if (viewers.length) return { state: 'read', viewers, guild: Boolean(channel.guildId) };
    if (others.some(([, r]) => r.deliveredAt >= m.createdAt)) return { state: 'delivered' };
    return { state: 'sent' };
  };
  const [text, setText] = useState('');
  const [reply, setReply] = useState(null); // mensagem sendo respondida
  const [uploads, setUploads] = useState([]); // arquivos sendo enviados
  const [dragging, setDragging] = useState(false);
  const [attach, setAttach] = useState([]); // anexos esperando o envio (arquivos e sticker), acima da caixa
  // Marca (ou desmarca) um anexo como NSFW antes de enviar: chega borrado para todos, no privado e nos canais.
  const toggleNsfw = (i) => setAttach((a) => a.map((it, j) => (j === i ? { ...it, nsfw: !it.nsfw } : it)));
  const [camera, setCamera] = useState(false);
  const cameraInput = useRef(null);
  // No celular e no tablet a câmera é a do próprio aparelho (com o zoom, o flash e a tela cheia dele);
  // no computador, a câmera do PadoSpeak.
  const openCamera = () => (isTouch ? cameraInput.current?.click() : setCamera(true));
  const [recording, setRecording] = useState(false);
  const connKey = useConnKey();
  const listRef = useRef(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const lastId = useRef(null);
  const firstId = useRef(null);
  const lastTyping = useRef(0);
  const inputRef = useRef(null);
  const dm = variant === 'dm';

  useEffect(() => {
    stickToBottom.current = true;
    setText('');
    setAttach([]);
    setReply(null);
    inputRef.current?.focus();
  }, [channel.id]);

  // Li o que está na tela (só com a janela em foco e visível).
  useEffect(() => {
    const read = () => document.visibilityState === 'visible' && document.hasFocus() && useC.getState().markRead(channel.id);
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [channel.id, messages]);

  // Compartilhado pelo celular para esta conversa: arquivos vão para a prévia; só texto/link, para a caixa.
  const shareTarget = useStore((s) => s.sharePending?.target);
  useEffect(() => {
    if (!shareTarget || shareTarget !== channel.id) return;
    const shared = useStore.getState().sharePending;
    useStore.setState({ sharePending: null });
    if (shared.files.length) {
      sendFiles(shared.files);
      addRecent(shared.files, 'compartilhado');
    }
    setText(shared.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareTarget, channel.id]);

  /** Põe anexos acima da caixa de mensagem (um sticker novo troca o anterior). */
  const addAttach = (items) => {
    const keyed = items.map((it) => ({ ...it, key: `${Date.now()}-${Math.random()}` }));
    setAttach((a) => [...(keyed.some((i) => i.kind === 'sticker') ? a.filter((i) => i.kind !== 'sticker') : a), ...keyed]);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** Arquivos escolhidos (botão, arrastar, colar ou câmera): ficam acima da caixa até enviar. */
  function sendFiles(files) {
    const ok = files.filter((file) => {
      if (!isBlockedFile(file.name)) return true;
      useStore.getState().notify(`"${file.name}" é um programa: coloque dentro de um .zip para enviar.`);
      return false;
    });
    if (ok.length) addAttach(ok.map((file) => ({ kind: 'file', file })));
  }

  /** Envia os anexos (um de cada vez; o texto vai junto com o primeiro). */
  async function sendAttachments(items, caption) {
    const replyTo = reply?.id;
    setReply(null);
    stickToBottom.current = true;
    let text = caption;
    for (const it of items) {
      if (it.kind === 'sticker') {
        await sendSticker(connKey, channel.id, it.sticker, { caption: text, replyTo });
        text = '';
        continue;
      }
      const { file } = it;
      const key = `${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        await sendFile(connKey, channel.id, file, {
          replyTo,
          caption: text,
          nsfw: it.nsfw,
          onProgress: (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
        });
        text = '';
      } catch (e) {
        useStore.getState().notify(`${file.name}: ${e.message}`);
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    }
  }

  /** Mensagem de voz gravada: sobe e manda. */
  async function sendRecording(blob, ms) {
    setRecording(false);
    const key = `${Date.now()}-${Math.random()}`;
    const replyTo = reply?.id;
    setReply(null);
    stickToBottom.current = true;
    setUploads((u) => [...u, { key, name: 'Mensagem de voz', progress: 0 }]);
    try {
      await sendVoice(connKey, channel.id, blob, ms, {
        replyTo,
        onProgress: (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
      });
    } catch (e) {
      useStore.getState().notify(`Mensagem de voz: ${e.message}`);
    } finally {
      setUploads((u) => u.filter((x) => x.key !== key));
    }
  }

  const startReply = (m) => {
    setReply(m);
    inputRef.current?.focus();
  };

  // Mantém o fim da conversa visível; ao carregar antigas, preserva a posição de leitura.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Mensagem (ou sticker) nova que eu mesmo mandei: leva ao fim. Reação, edição ou visto numa
    // mensagem que já estava ali não mexe na posição.
    const last = messages[messages.length - 1];
    if (last?.id !== lastId.current && last?.author?.id === me?.id) stickToBottom.current = true;
    lastId.current = last?.id ?? null;
    const olderLoaded = messages[0]?.id !== firstId.current;
    firstId.current = messages[0]?.id ?? null;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else if (olderLoaded && prevHeight.current && el.scrollTop < 50) el.scrollTop += el.scrollHeight - prevHeight.current;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

  // Stickers e imagens terminam de carregar depois e aumentam a conversa: continua no fim.
  const onMediaLoad = () => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    if (el) prevHeight.current = el.scrollHeight;
  };

  const onScroll = () => {
    const el = listRef.current;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    prevHeight.current = el.scrollHeight;
  };

  async function send() {
    const content = text.trim();
    if (attach.length) {
      const big = oversized(attach, useC.getState().config);
      if (big.length) return useStore.getState().notify(`${big.map((f) => f.name).join(', ')} é grande demais para enviar.`);
      if (content.length > CAPTION_MAX)
        return useStore.getState().notify(`O texto junto com um anexo pode ter até ${CAPTION_MAX} caracteres.`);
      const items = attach;
      setAttach([]);
      setText('');
      return sendAttachments(items, content);
    }
    if (!content) return;
    setText('');
    stickToBottom.current = true;
    const replyTo = reply?.id;
    setReply(null);
    const ok = await useC.getState().sendMessage(channel.id, content, replyTo);
    if (!ok) setText(content);
  }

  // Menção: "@" seguido do começo do nome, logo antes do cursor, abre a lista de membros.
  const [mention, setMention] = useState(null); // { start, query, index }
  const mentionItems = useMemo(() => {
    if (!mention || !members) return [];
    const q = mention.query.toLowerCase();
    const list = members
      .filter((u) => u.id !== me.id)
      .filter((u) => !q || u.username.toLowerCase().startsWith(q) || plain(u.displayName).toLowerCase().includes(q))
      .sort((a, b) => a.username.localeCompare(b.username))
      .slice(0, 7)
      .map((u) => ({ key: u.id, username: u.username, user: u }));
    if ('everyone'.startsWith(q)) list.unshift({ key: 'everyone', username: 'everyone' });
    return list;
  }, [mention, members, me.id]);
  const findMention = (value, caret) => {
    if (!members) return setMention(null);
    const m = /(^|[^\w.@])@([A-Za-z0-9_.]{0,32})$/.exec(value.slice(0, caret));
    setMention(m ? { start: caret - m[2].length - 1, query: m[2], index: 0 } : null);
  };
  const pickMention = (item) => {
    const el = inputRef.current;
    if (!el || !mention || !item) return;
    const caret = el.selectionStart;
    const next = `${text.slice(0, mention.start)}@${item.username} ${text.slice(caret)}`.slice(0, MAX);
    const pos = Math.min(next.length, mention.start + item.username.length + 2);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };
  /** Teclas da lista de menções: setas escolhem, Enter/Tab colocam, Esc fecha. */
  const mentionKey = (e) => {
    if (!mention || !mentionItems.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setMention((m) => ({ ...m, index: (m.index + d + mentionItems.length) % mentionItems.length }));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(mentionItems[mention.index] || mentionItems[0]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setMention(null);
      return true;
    }
    return false;
  };

  function onChange(e) {
    setText(e.target.value);
    findMention(e.target.value, e.target.selectionStart);
    const now = Date.now();
    if (now - lastTyping.current > 3000 && e.target.value) {
      lastTyping.current = now;
      useC.getState().sendTyping(channel.id);
    }
  }

  // Nome atual (o evento de digitação pode trazer o nome de quando a pessoa conectou).
  const typers = Object.values(typing || {})
    .filter((u) => u.id !== me.id)
    .map((u) => users[u.id] || u);
  const typingLine = typers.length > 0 && (
    <>
      <PenLine size={13} className="typing-ico" />
      <span>
        <b>{typers.map((u) => plain(u.displayName)).join(', ')}</b>{' '}
        {typers.length > 1 ? 'estão digitando uma mensagem...' : 'está digitando uma mensagem...'}
      </span>
    </>
  );
  const tools = (
    <ComposerTools
      inputRef={inputRef}
      text={text}
      setText={setText}
      channelId={channel.id}
      target={dm ? channel.name : `#${channel.name}`}
      onFiles={sendFiles}
      onCamera={openCamera}
      onSticker={(sticker) => addAttach([{ kind: 'sticker', sticker }])}
    />
  );
  const lastReceived = [...messages].reverse().find((m) => !m.notice && m.author.id !== me.id);
  const placeholder = dm ? `Conversar com ${channel.name}` : `Conversar em #${channel.name}`;

  const log = (
    <div className="messages" ref={listRef} onScroll={onScroll} onLoadCapture={onMediaLoad}>
      {hasMore ? (
        <button className="btn secondary load-more" onClick={() => useC.getState().loadMessages(channel.id, true)}>
          Carregar mensagens anteriores
        </button>
      ) : (
        loaded && (
          <div className="welcome">
            {dm ? (
              <p>
                Este é o começo da sua conversa com <b>{channel.name}</b> (@{channel.recipient.username}).
              </p>
            ) : (
              <>
                <span className="welcome-ico" aria-hidden="true">
                  <Hash size={22} />
                </span>
                <div>
                  <b>Bem-vindo(a) a #{channel.name}!</b>
                  <p>Este é o começo do canal #{channel.name}.</p>
                </div>
              </>
            )}
          </div>
        )
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
        if (m.notice)
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="day-sep" role="separator">
                  <span>{dayLabel(m.createdAt)}</span>
                </div>
              )}
              <Notice n={m} dm={dm} name={channel.name} />
            </Fragment>
          );
        const head =
          newDay || prev.notice || prev.author.id !== m.author.id || m.createdAt - prev.createdAt > GROUP_MS;
        return (
          <Fragment key={m.id}>
            {newDay && (
              <div className="day-sep" role="separator">
                <span>{dayLabel(m.createdAt)}</span>
              </div>
            )}
            <Message
              m={m}
              head={head || Boolean(m.replyTo)}
              canEdit={m.author.id === me.id}
              canDelete={m.author.id === me.id || isAdmin}
              onReply={startReply}
              me={me}
              receipt={receiptOf(m)}
              color={messageColor(users[m.author.id] || m.author, guild)}
              guildId={guild?.id}
            />
          </Fragment>
        );
      })}
    </div>
  );

  const textarea = (
    <textarea
      ref={inputRef}
      rows={dm ? 3 : 2}
      aria-label={dm ? `Mensagem para ${channel.name}` : `Mensagem para #${channel.name}`}
      placeholder={placeholder}
      value={text}
      maxLength={MAX}
      onChange={onChange}
      onKeyDown={(e) => {
        if (mentionKey(e)) return;
        if (formatKey(e, inputRef.current, text, setText, MAX)) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          send();
        } else if (e.key === 'Escape' && reply) setReply(null);
      }}
      onClick={(e) => findMention(e.currentTarget.value, e.currentTarget.selectionStart)}
      onBlur={() => setTimeout(() => setMention(null), 150)}
      onPaste={(e) => {
        // Colar uma imagem (print) ou arquivos copiados envia como arquivo.
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) {
          e.preventDefault();
          sendFiles(files);
        }
      }}
    />
  );
  // Respondendo: o trecho da mensagem acima da caixa (Esc ou × cancela).
  const replyBar = reply && (
    <div className="reply-bar">
      <CornerUpLeft size={14} />
      <span>
        Respondendo a <b>{plain(reply.author.displayName) || reply.author.username}</b>
      </span>
      <span className="reply-bar-text">
        {parseFile(reply.content)?.name ||
          (parseVoice(reply.content) && 'Mensagem de voz') ||
          (parseSticker(reply.content) && 'Sticker') ||
          plain(reply.content).slice(0, 120)}
      </span>
      <button className="gloss mini" onClick={() => setReply(null)} title="Cancelar resposta" aria-label="Cancelar resposta">
        <X size={13} />
      </button>
    </div>
  );
  // Arrastar arquivos para a conversa envia.
  const dropProps = {
    onDragOver: (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
    },
    onDrop: (e) => {
      if (!e.dataTransfer.files?.length) return;
      e.preventDefault();
      setDragging(false);
      sendFiles([...e.dataTransfer.files]);
    },
  };
  const dropHint = dragging && <div className="drop-overlay">Solte para enviar à conversa</div>;
  const sendBtn = (
    <>
      <button
        type="button"
        className="gloss compose-ico"
        title="Câmera: tirar foto ou gravar vídeo"
        aria-label="Câmera"
        onClick={openCamera}
      >
        <Camera size={17} className="ico-blue" />
      </button>
      <button
        type="button"
        className="gloss compose-ico"
        title="Gravar mensagem de voz"
        aria-label="Gravar mensagem de voz"
        onClick={() => {
          requestMic();
          setRecording(true);
        }}
      >
        <Mic size={17} className="ico-green" />
      </button>
      <button className="go send-btn" onClick={send} disabled={!text.trim() && !attach.length}>
        <Send size={16} />
        Enviar
      </button>
    </>
  );
  // Gravando áudio: o gravador fica no lugar da caixa de texto.
  const composeRow = recording ? (
    <div className="compose-row">
      <VoiceRecorder onSend={sendRecording} onCancel={() => setRecording(false)} />
    </div>
  ) : (
    <div className="compose-row">
      {mention && mentionItems.length > 0 && (
        <div className="mention-pick" role="listbox" aria-label="Mencionar">
          <div className="mention-pick-head">Mencionar</div>
          {mentionItems.map((it, i) => (
            <button
              key={it.key}
              type="button"
              role="option"
              aria-selected={i === mention.index}
              className={i === mention.index ? 'on' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setMention((m) => ({ ...m, index: i }))}
              onClick={() => pickMention(it)}
            >
              {it.user ? (
                <>
                  <Avatar user={it.user} size={22} frame={false} />
                  <span className="mp-name">
                    <UserName user={it.user} />
                  </span>
                  <small>@{it.username}</small>
                </>
              ) : (
                <>
                  <span className="mp-all" aria-hidden="true">
                    @
                  </span>
                  <span className="mp-name">@everyone</span>
                  <small>avisa todos que veem este canal</small>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {aaBtn}
      {textarea}
      {sendBtn}
    </div>
  );
  const sheets = (
    <>
      {camera && (
        <CameraCapture
          onClose={() => setCamera(false)}
          onDone={(file) => {
            setCamera(false);
            addAttach([{ kind: 'file', file }]);
            addRecent([file], 'câmera');
          }}
        />
      )}
      {isTouch && (
        <input
          ref={cameraInput}
          type="file"
          accept="image/*,video/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const files = [...(e.target.files || [])].map(fromPhoneCamera);
            e.target.value = '';
            if (!files.length) return;
            addAttach(files.map((file) => ({ kind: 'file', file })));
            addRecent(files, 'câmera');
          }}
        />
      )}
    </>
  );

  if (dm) {
    return (
      <section className="chat dm" {...dropProps}>
        <div className="panel log-panel">
          <DmHeader recipient={channel.recipient} />
          {log}
          {dropHint}
        </div>
        <div className="panel composer">
          <UploadList uploads={uploads} />
          {replyBar}
          <AttachTray
            items={attach}
            onRemove={(i) => setAttach((a) => a.filter((_, j) => j !== i))}
            onClear={() => setAttach([])}
            onNsfw={toggleNsfw}
          />
          {showTools && (
            <div className="panel-head tools-head">
              {tools}
              <span className="count">
                {text.length} / {MAX}
              </span>
            </div>
          )}
          {composeRow}
          <div className={`panel-foot${typers.length ? ' typing-foot' : ''}`} aria-live="polite">
            {typers.length
              ? typingLine
              : lastReceived
                ? `Última mensagem recebida ${dayLabel(lastReceived.createdAt) === 'HOJE' ? 'hoje' : `em ${new Date(lastReceived.createdAt).toLocaleDateString('pt-BR')}`} às ${hhmm(lastReceived.createdAt)}.`
                : 'Nenhuma mensagem recebida ainda.'}
          </div>
        </div>
        {sheets}
      </section>
    );
  }

  return (
    <section className="chat" {...dropProps}>
      {log}
      {dropHint}
      <div className="composer">
        <div className="typing" aria-live="polite">
          {typingLine}
        </div>
        <UploadList uploads={uploads} />
        {replyBar}
        <AttachTray
          items={attach}
          onRemove={(i) => setAttach((a) => a.filter((_, j) => j !== i))}
          onClear={() => setAttach([])}
          onNsfw={toggleNsfw}
        />
        {showTools && tools}
        {composeRow}
        <div className="count">
          {text.length} / {MAX}
        </div>
      </div>
      {sheets}
    </section>
  );
}
