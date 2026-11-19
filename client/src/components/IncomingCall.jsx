import { useRef, useState } from 'react';
import { Phone, PhoneOff, MessageCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore } from '../store.js';
import Avatar, { Orb, useUser } from './Avatar.jsx';
import { FormattedText } from './Emotes.jsx';
import { plain } from '../lib/text.js';
import { ConnProvider, useConn } from './conn.jsx';
import { useLayout } from '../lib/layout.js';

/** "com Ana e Bia": quem já está na chamada para a qual você foi chamado (sem quem chamou). */
function groupText(call, short = false) {
  const names = (call.members || []).filter((m) => m.id !== call.from?.id).map((m) => plain(m.displayName));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0];
  if (short) return list ? `Chamada com ${list}` : 'Chamada em grupo';
  return list ? `chamou você para uma chamada com ${list}` : 'chamou você para uma chamada';
}

/** A partir de quanto do caminho soltar o botão atende ou recusa. */
const SWIPE_DONE = 0.6;

/**
 * Celular: arrastar o botão do meio para a direita atende e para a esquerda recusa (como nas outras ligações).
 * Os botões escondidos continuam para leitores de tela.
 */
function SwipeCall({ onAnswer, onDecline }) {
  const track = useRef(null);
  const drag = useRef(null);
  const [x, setX] = useState(0);
  const [moving, setMoving] = useState(false);
  const max = () => {
    const t = track.current;
    return t ? t.clientWidth / 2 - 36 : 120;
  };
  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { start: e.clientX - x };
    setMoving(true);
  };
  const move = (e) => {
    if (!drag.current) return;
    const m = max();
    setX(Math.max(-m, Math.min(m, e.clientX - drag.current.start)));
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    setMoving(false);
    const m = max();
    if (x > m * SWIPE_DONE) {
      setX(m);
      onAnswer();
    } else if (x < -m * SWIPE_DONE) {
      setX(-m);
      onDecline();
    } else {
      setX(0);
    }
  };
  const side = x > 8 ? 'answer' : x < -8 ? 'decline' : '';
  return (
    <div className={`if-swipe${side ? ` to-${side}` : ''}`} ref={track}>
      <span className="if-swipe-end decline" aria-hidden="true">
        <PhoneOff size={20} />
        Recusar
      </span>
      <span className="if-swipe-hint" aria-hidden="true">
        <ChevronLeft size={16} />
        arraste
        <ChevronRight size={16} />
      </span>
      <span className="if-swipe-end answer" aria-hidden="true">
        Atender
        <Phone size={20} />
      </span>
      <span
        className={`if-swipe-knob${moving ? ' moving' : ''}`}
        style={{ transform: `translateX(${x}px)` }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-hidden="true"
      >
        {side === 'decline' ? <PhoneOff /> : <Phone />}
      </span>
      <button type="button" className="sr-only" onClick={onAnswer}>
        Atender
      </button>
      <button type="button" className="sr-only" onClick={onDecline}>
        Recusar
      </button>
    </div>
  );
}

/** Janela de chamada recebida numa conexão (o toque e a vibração são controlados pelo store). */
function IncomingCall() {
  const useC = useConn();
  const call = useC((s) => s.incomingCall);
  const from = useUser(call?.from);
  const phone = useLayout() === 'phone';
  if (!call) return null;
  const { answerCall, declineCall, selectDm } = useC.getState();

  // Celular: tela cheia, com o botão de atender grande e pulsando.
  if (phone) {
    return (
      <div className="incoming-full" role="alertdialog" aria-label={`Chamada recebida de ${plain(from.displayName)}`} data-sysbar="--call-top" data-sysbar-bottom="--call-bottom">
        <span className="if-kind">Chamada de voz{from.lan ? ' · rede local' : ''}</span>
        <div className="cs-rings big">
          <span />
          <span />
          <span />
          <Avatar user={from} size={120} />
        </div>
        <div className="if-who">
          <b>
            <FormattedText text={from.displayName} />
          </b>
          <span>{call.group ? groupText(call) : 'está chamando você…'}</span>
        </div>
        <div className="if-actions">
          <SwipeCall onAnswer={() => answerCall()} onDecline={() => declineCall()} />
        </div>
        {!call.group && <button
          type="button"
          className="if-reply"
          onClick={() => {
            const dmId = call.dmId;
            declineCall();
            selectDm(dmId);
          }}
        >
          <MessageCircle size={15} /> Responder com mensagem
        </button>}
      </div>
    );
  }

  return (
    <div className="incoming-call window" role="alertdialog" aria-label={`Chamada recebida de ${plain(from.displayName)}`}>
      <div className="titlebar small">
        <Orb status="on" size={9} />
        <span className="tb-title">Chamada recebida{from.lan ? ' · rede local' : ''}</span>
      </div>
      <div className="incoming-body">
        <div className="incoming-rings">
          <span />
          <span />
          <Avatar user={from} size={64} />
        </div>
        <b>
          <FormattedText text={from.displayName} /> {call.group ? 'chamou você para uma chamada' : 'está chamando você'}
        </b>
        <span>{call.group ? groupText(call, true) : 'Chamada 1 a 1'}</span>
        <div className="incoming-actions">
          <button className="go" title="Atender" onClick={() => answerCall()}>
            <Phone size={16} /> Aceitar
          </button>
          <button className="stop" title="Recusar" onClick={() => declineCall()}>
            <PhoneOff size={16} /> Recusar
          </button>
        </div>
      </div>
    </div>
  );
}

/** Chamadas recebidas em qualquer conexão (servidor, perfil local ou PC da rede). */
export default function IncomingCalls() {
  const keys = useStore((s) => s.connKeys);
  return keys.map((k) => (
    <ConnProvider key={k} conn={k}>
      <IncomingCall />
    </ConnProvider>
  ));
}
