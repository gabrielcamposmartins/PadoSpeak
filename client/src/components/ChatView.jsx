import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Hash,
  Pencil,
  Trash2,
  Send,
  PenLine,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Smile,
  Vibrate,
  Baseline,
  Sticker,
} from 'lucide-react';
import { useStore, sendSticker } from '../store.js';
import { StickerPicker, StickerView, parseSticker } from './Stickers.jsx';
import { useConn, useConnKey } from './conn.jsx';
import Avatar, { UserName, Orb, usePresence, useUser, colorClass, colorStyle } from './Avatar.jsx';
import { EmojiText, RichText, EmojiPicker, ColorPicker, editField, insertText } from './Emotes.jsx';

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
  else if (dm && n.delivered) text = <>Você chamou a atenção de <EmojiText text={name} />.</>;
  else if (dm) text = <><EmojiText text={name} /> não está aceitando chamar atenção agora.</>;
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
function ComposerTools({ inputRef, text, setText, channelId }) {
  const [open, setOpen] = useState(null); // 'emoji' | 'color'
  const useC = useConn();
  const connKey = useConnKey();
  const colorBtn = useRef(null);
  const emojiBtn = useRef(null);
  const stickerBtn = useRef(null);
  const wrap = (before, after, placeholder) => editField(inputRef.current, text, setText, before, after, placeholder);
  const tools = [
    [Bold, 'Negrito', () => wrap('**', '**', 'negrito')],
    [Italic, 'Itálico', () => wrap('*', '*', 'itálico')],
    [Underline, 'Sublinhado', () => wrap('__', '__', 'sublinhado')],
    [Strikethrough, 'Riscado', () => wrap('~~', '~~', 'riscado')],
  ];
  return (
    <div className="composer-tools" role="toolbar" aria-label="Opções de texto">
      {tools.map(([Icon, label, fn]) => (
        <button key={label} type="button" className="gloss tool-sq" title={label} aria-label={label} onClick={fn}>
          <Icon size={15} />
        </button>
      ))}
      <span className="tool-wrap">
        <button
          ref={colorBtn}
          type="button"
          className={`gloss tool-sq${open === 'color' ? ' pressed' : ''}`}
          title="Cor do texto"
          aria-label="Cor do texto"
          aria-expanded={open === 'color'}
          onClick={() => setOpen(open === 'color' ? null : 'color')}
        >
          <Baseline size={15} className="ico-color" />
        </button>
        {open === 'color' && (
          <ColorPicker
            anchorRef={colorBtn}
            onClose={() => setOpen(null)}
            onPick={(hex) => {
              setOpen(null);
              wrap(`[cor=${hex}]`, '[/cor]', 'texto colorido');
            }}
          />
        )}
      </span>
      <span className="tool-sep" />
      <span className="tool-wrap">
        <button
          ref={emojiBtn}
          type="button"
          className={`gloss tool-sq${open === 'emoji' ? ' pressed' : ''}`}
          title="Emoticons"
          aria-label="Emoticons"
          aria-expanded={open === 'emoji'}
          onClick={() => setOpen(open === 'emoji' ? null : 'emoji')}
        >
          <Smile size={15} className="ico-gold" />
        </button>
        {open === 'emoji' && (
          <EmojiPicker
            anchorRef={emojiBtn}
            onClose={() => setOpen(null)}
            onPick={(code) => {
              setOpen(null);
              insertText(inputRef.current, text, setText, code);
            }}
          />
        )}
      </span>
      <span className="tool-wrap">
        <button
          ref={stickerBtn}
          type="button"
          className={`gloss tool-sq${open === 'sticker' ? ' pressed' : ''}`}
          title="Stickers"
          aria-label="Stickers"
          aria-expanded={open === 'sticker'}
          onClick={() => setOpen(open === 'sticker' ? null : 'sticker')}
        >
          <Sticker size={15} className="ico-purple" />
        </button>
        {open === 'sticker' && (
          <StickerPicker
            anchorRef={stickerBtn}
            onClose={() => setOpen(null)}
            onPick={(st) => {
              setOpen(null);
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
    </div>
  );
}

function Message({ m, head, canEdit: canEditText, canDelete, showAvatar }) {
  const sticker = parseSticker(m.content);
  const canEdit = canEditText && !sticker;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const useC = useConn();
  const openProfile = useOpenProfile();
  const { editMessage, deleteMessage } = useC.getState();
  const { openModal } = useStore.getState();

  const save = () => {
    const c = draft.trim();
    if (c && c !== m.content) editMessage(m.id, c);
    setEditing(false);
  };

  return (
    <div className={`msg${head ? ' head' : ''}${showAvatar ? '' : ' no-avatar'}`}>
      {showAvatar && (
        <div className="msg-pic">
          {head && <Avatar user={m.author} size={30} onClick={() => openProfile(m.author.id)} />}
        </div>
      )}
      <div className="body">
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
            {sticker ? <StickerView sticker={sticker} /> : <RichText text={m.content} />}
            {m.editedAt && <span className="edited">(editado)</span>}
          </p>
        )}
      </div>
      {(canEdit || canDelete) && !editing && (
        <div className="tools">
          {canEdit && (
            <button className="icon-btn" title="Editar" onClick={() => (setDraft(m.content), setEditing(true))}>
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
          <EmojiText text={user.bio} size={14} />
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
  const useC = useConn();
  const messages = useC((s) => s.messages[channel.id]) || EMPTY;
  const loaded = useC((s) => channel.id in s.messages);
  const hasMore = useC((s) => s.hasMore[channel.id]);
  const typing = useC((s) => s.typing[channel.id]);
  const me = useC((s) => s.me) || NOBODY;
  const isOwner = useC((s) => s.guilds.find((g) => g.id === channel.guildId)?.ownerId === s.me?.id);
  const users = useC((s) => s.users);
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const lastTyping = useRef(0);
  const inputRef = useRef(null);
  const dm = variant === 'dm';

  useEffect(() => {
    stickToBottom.current = true;
    setText('');
    inputRef.current?.focus();
  }, [channel.id]);

  // Mantém o fim da conversa visível; ao carregar antigas, preserva a posição de leitura.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else if (prevHeight.current && el.scrollTop < 50) el.scrollTop += el.scrollHeight - prevHeight.current;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

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
    const ok = await useC.getState().sendMessage(channel.id, content);
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
        <b>{typers.map((u) => u.displayName).join(', ')}</b>{' '}
        {typers.length > 1 ? 'estão digitando uma mensagem...' : 'está digitando uma mensagem...'}
      </span>
    </>
  );
  const tools = <ComposerTools inputRef={inputRef} text={text} setText={setText} channelId={channel.id} />;
  const lastReceived = [...messages].reverse().find((m) => !m.notice && m.author.id !== me.id);
  const placeholder = dm ? `Conversar com ${channel.name}` : `Conversar em #${channel.name}`;

  const log = (
    <div className="messages" ref={listRef} onScroll={onScroll}>
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
              head={head}
              showAvatar={!dm}
              canEdit={m.author.id === me.id}
              canDelete={m.author.id === me.id || isOwner}
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
        }
      }}
    />
  );
  const sendBtn = (
    <button className="go send-btn" onClick={send} disabled={!text.trim()}>
      <Send size={16} />
      Enviar
    </button>
  );

  if (dm) {
    return (
      <section className="chat dm">
        <div className="panel log-panel">
          <DmHeader recipient={channel.recipient} />
          {log}
        </div>
        <div className="panel composer">
          <div className="panel-head tools-head">
            {tools}
            <span className="count">
              {text.length} / {MAX}
            </span>
          </div>
          {typers.length > 0 && (
            <div className="typing dm-typing" aria-live="polite">
              {typingLine}
            </div>
          )}
          <div className="compose-row">
            {textarea}
            {sendBtn}
          </div>
          <div className="panel-foot">
            {lastReceived
              ? `Última mensagem recebida ${dayLabel(lastReceived.createdAt) === 'HOJE' ? 'hoje' : `em ${new Date(lastReceived.createdAt).toLocaleDateString('pt-BR')}`} às ${hhmm(lastReceived.createdAt)}.`
              : 'Nenhuma mensagem recebida ainda.'}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="chat">
      {log}
      <div className="composer">
        <div className="typing" aria-live="polite">
          {typingLine}
        </div>
        {tools}
        <div className="compose-row">
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
