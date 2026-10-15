import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import { useStore, sendSticker, sendFile, usePerms } from '../store.js';
import { FileView, UploadList, parseFile, isBlockedFile } from './Files.jsx';
import { StickerPicker, StickerView, parseSticker } from './Stickers.jsx';
import FormatTools from './FormatTools.jsx';
import { useConn, useConnKey } from './conn.jsx';
import Avatar, { UserName, Orb, usePresence, useUser, colorClass, colorStyle } from './Avatar.jsx';
import { RichText, FormattedText, plain, EmojiText, EmojiPicker } from './Emotes.jsx';
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

/** Barra acima da caixa de texto: formatação, cor, emoticons e chamar atenção. */
function ComposerTools({ inputRef, text, setText, channelId, onFiles }) {
  const [open, setOpen] = useState(false);
  const useC = useConn();
  const connKey = useConnKey();
  const stickerBtn = useRef(null);
  const fileInput = useRef(null);
  return (
    <FormatTools inputRef={inputRef} text={text} setText={setText} maxRaw={MAX}>
      <button
        type="button"
        className="gloss tool-sq"
        title="Enviar arquivo (imagem, vídeo, texto, .zip…)"
        aria-label="Enviar arquivo"
        onClick={() => fileInput.current?.click()}
      >
        <Paperclip size={15} className="ico-blue" />
      </button>
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
              sendSticker(connKey, channelId, st);
            }}
          />
        )}
      </span>
      <button
        type="button"
        className="gloss tool-nudge"
        title="Chamar atenção: faz a janela de quem está aqui tremer (até 3 vezes por minuto)"
        onClick={() => useC.getState().sendNudge(channelId)}
      >
        <Vibrate size={15} />
        Chamar atenção
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
            onClick={() => useC.getState().reactMessage(m.id, r.emoji, !mine)}
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

function Message({ m, head, canEdit: canEditText, canDelete, onReply, me }) {
  const sticker = parseSticker(m.content);
  const file = !sticker && parseFile(m.content);
  const canEdit = canEditText && !sticker && !file;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const useC = useConn();
  const openProfile = useOpenProfile();
  const { editMessage, deleteMessage } = useC.getState();
  const { openModal } = useStore.getState();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const reactBtn = useRef(null);
  const react = (code) => {
    const mine = m.reactions?.find((r) => r.emoji === code)?.users.includes(me.id);
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
      className={`msg${head ? ' head' : ''}${toolsOpen ? ' tools-open' : ''}`}
      {...longPress}
    >
      {/* A fotinha de quem escreveu, nos canais e nas conversas privadas. */}
      <div className="msg-pic">
        {head && <Avatar user={m.author} size={30} onClick={() => openProfile(m.author.id)} />}
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
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  save();
                } else if (e.key === 'Escape') setEditing(false);
              }}
            />
            <small>Esc para cancelar · Enter para salvar</small>
          </div>
        ) : (
          <p className="content" title={head ? undefined : hhmm(m.createdAt)}>
            {sticker ? <StickerView sticker={sticker} /> : file ? <FileView file={file} /> : <RichText text={m.content} />}
            {m.editedAt && <span className="edited">(editado)</span>}
          </p>
        )}
        <Reactions m={m} me={me} onPick={react} />
      </div>
      {!editing && (
        <div className="tools">
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
          {canDelete && (
            <button
              className="icon-btn danger"
              title="Excluir"
              onClick={(e) =>
                e.shiftKey
                  ? deleteMessage(m.id)
                  : openModal({
                      type: 'confirm',
                      title: 'Excluir mensagem?',
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
  const messages = useC((s) => s.messages[channel.id]) || EMPTY;
  const loaded = useC((s) => channel.id in s.messages);
  const hasMore = useC((s) => s.hasMore[channel.id]);
  const typing = useC((s) => s.typing[channel.id]);
  const me = useC((s) => s.me) || NOBODY;
  const isAdmin = usePerms(useC, channel.guildId).admin;
  const users = useC((s) => s.users);
  const [text, setText] = useState('');
  const [reply, setReply] = useState(null); // mensagem sendo respondida
  const [uploads, setUploads] = useState([]); // arquivos sendo enviados
  const [dragging, setDragging] = useState(false);
  const connKey = useConnKey();
  const listRef = useRef(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const lastTyping = useRef(0);
  const inputRef = useRef(null);
  const dm = variant === 'dm';

  useEffect(() => {
    stickToBottom.current = true;
    setText('');
    setReply(null);
    inputRef.current?.focus();
  }, [channel.id]);

  /** Envia arquivos (botão, arrastar ou colar), um de cada vez, com o progresso acima da caixa. */
  async function sendFiles(files) {
    for (const file of files) {
      if (isBlockedFile(file.name)) {
        useStore.getState().notify(`"${file.name}" é um programa: coloque dentro de um .zip para enviar.`);
        continue;
      }
      const key = `${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      stickToBottom.current = true;
      try {
        await sendFile(connKey, channel.id, file, {
          replyTo: reply?.id,
          onProgress: (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
        });
        setReply(null);
      } catch (e) {
        useStore.getState().notify(`${file.name}: ${e.message}`);
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
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
    // Mensagem (ou sticker) que eu mesmo mandei: sempre leva ao fim.
    if (messages[messages.length - 1]?.author?.id === me?.id) stickToBottom.current = true;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else if (prevHeight.current && el.scrollTop < 50) el.scrollTop += el.scrollHeight - prevHeight.current;
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
    if (!content) return;
    setText('');
    stickToBottom.current = true;
    const replyTo = reply?.id;
    setReply(null);
    const ok = await useC.getState().sendMessage(channel.id, content, replyTo);
    if (!ok) setText(content);
  }

  function onChange(e) {
    setText(e.target.value);
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
  const tools = <ComposerTools inputRef={inputRef} text={text} setText={setText} channelId={channel.id} onFiles={sendFiles} />;
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
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          send();
        } else if (e.key === 'Escape' && reply) setReply(null);
      }}
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
      <span className="reply-bar-text">{parseFile(reply.content)?.name || plain(reply.content).slice(0, 120)}</span>
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
    <button className="go send-btn" onClick={send} disabled={!text.trim()}>
      <Send size={16} />
      Enviar
    </button>
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
          {showTools && (
            <div className="panel-head tools-head">
              {tools}
              <span className="count">
                {text.length} / {MAX}
              </span>
            </div>
          )}
          <div className="compose-row">
            {aaBtn}
            {textarea}
            {sendBtn}
          </div>
          <div className={`panel-foot${typers.length ? ' typing-foot' : ''}`} aria-live="polite">
            {typers.length
              ? typingLine
              : lastReceived
                ? `Última mensagem recebida ${dayLabel(lastReceived.createdAt) === 'HOJE' ? 'hoje' : `em ${new Date(lastReceived.createdAt).toLocaleDateString('pt-BR')}`} às ${hhmm(lastReceived.createdAt)}.`
                : 'Nenhuma mensagem recebida ainda.'}
          </div>
        </div>
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
        {showTools && tools}
        <div className="compose-row">
          {aaBtn}
          {textarea}
          {sendBtn}
        </div>
        <div className="count">
          {text.length} / {MAX}
        </div>
      </div>
    </section>
  );
}
