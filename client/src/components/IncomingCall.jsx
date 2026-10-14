import { Phone, PhoneOff } from 'lucide-react';
import { useStore } from '../store.js';
import Avatar, { Orb, useUser } from './Avatar.jsx';
import { EmojiText } from './Emotes.jsx';
import { ConnProvider, useConn } from './conn.jsx';

/** Janela de chamada 1 a 1 recebida numa conexão (o toque é controlado pelo store). */
function IncomingCall() {
  const useC = useConn();
  const call = useC((s) => s.incomingCall);
  const from = useUser(call?.from);
  if (!call) return null;
  const { answerCall, declineCall } = useC.getState();
  return (
    <div className="incoming-call window" role="alertdialog" aria-label={`Chamada recebida de ${from.displayName}`}>
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
          <EmojiText text={from.displayName} /> está chamando você
        </b>
        <span>Chamada 1 a 1</span>
        <div className="incoming-actions">
          <button className="go" title="Atender" onClick={answerCall}>
            <Phone size={16} /> Aceitar
          </button>
          <button className="stop" title="Recusar" onClick={declineCall}>
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
