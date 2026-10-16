import { Phone, PhoneOff, MessageCircle } from 'lucide-react';
import { useStore } from '../store.js';
import Avatar, { Orb, useUser } from './Avatar.jsx';
import { FormattedText } from './Emotes.jsx';
import { plain } from '../lib/text.js';
import { ConnProvider, useConn } from './conn.jsx';
import { useLayout } from '../lib/layout.js';

/** Janela de chamada 1 a 1 recebida numa conexão (o toque e a vibração são controlados pelo store). */
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
          <span>está chamando você…</span>
        </div>
        <div className="if-actions">
          <button type="button" className="if-btn decline" onClick={() => declineCall()}>
            <span className="b">
              <PhoneOff />
            </span>
            Recusar
          </button>
          <button type="button" className="if-btn answer" onClick={() => answerCall()}>
            <span className="b">
              <Phone />
            </span>
            Atender
          </button>
        </div>
        <button
          type="button"
          className="if-reply"
          onClick={() => {
            const dmId = call.dmId;
            declineCall();
            selectDm(dmId);
          }}
        >
          <MessageCircle size={15} /> Responder com mensagem
        </button>
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
          <FormattedText text={from.displayName} /> está chamando você
        </b>
        <span>Chamada 1 a 1</span>
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
