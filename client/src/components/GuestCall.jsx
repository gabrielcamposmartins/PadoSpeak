// Chamada de uma conversa privada para a qual você foi chamado sem ser dela (`call:invite`): só a chamada,
// sem as mensagens da conversa.
import { Phone } from 'lucide-react';
import { useStore } from '../store.js';
import { useLayout } from '../lib/layout.js';
import { plain } from '../lib/text.js';
import { MobileBack } from './Mobile.jsx';
import VoiceView from './VoiceView.jsx';
import { InviteButton, PendingInvites } from './CallInvite.jsx';

export default function GuestCall({ channelId }) {
  const voice = useStore((s) => (s.voice?.channelId === channelId ? s.voice : null));
  const phone = useLayout() === 'phone';
  const names = (voice?.peers || []).map((p) => plain(p.user?.displayName || '')).filter(Boolean);
  const title = names.length ? `Chamada com ${names.join(', ')}` : 'Chamada';
  const channel = { id: channelId, name: title, guildId: null, dm: true };
  return (
    <main className="main glass dm-window guest-call">
      <div className="dm-actions">
        {phone && <MobileBack />}
        <span className="guest-call-title">
          <Phone size={16} className="ico-green" /> <b>{title}</b>
        </span>
        {voice && <InviteButton className="gloss tool" label />}
      </div>
      {voice ? (
        <div className="dm-call guest-call-stage">
          <VoiceView channel={channel} />
          <PendingInvites />
        </div>
      ) : (
        <div className="empty">A chamada acabou.</div>
      )}
    </main>
  );
}
