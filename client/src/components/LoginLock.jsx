// Muitas tentativas de login: o servidor bloqueia por 15 minutos depois de 5 erros seguidos (por usuário e
// endereço). A tela mostra quanto falta, desativa o botão de entrar e avisa quando as tentativas estão
// acabando.
import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';

/** Tempo do bloqueio quando o servidor só diz que acabaram as tentativas (sem `retryAfter`). */
const WINDOW_MS = 15 * 60 * 1000;

const mmss = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * Bloqueio do login de `username`: `locked`, `left` (ms) e `track(err)`, que olha um erro do servidor e
 * devolve `{ locked }` (429, ou a última tentativa gasta: passa a mostrar o aviso) ou `{ hint }` (aviso
 * de que as tentativas estão acabando, para pôr depois da mensagem de erro).
 */
export function useLoginLock(username) {
  const [lock, setLock] = useState(null); // { user, until }
  const [now, setNow] = useState(Date.now());
  const user = username.trim().toLowerCase();
  const active = lock && lock.user === user && lock.until > now;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const track = (err) => {
    const block = (ms) => {
      setNow(Date.now());
      setLock({ user, until: Date.now() + ms });
      return { locked: true, hint: '' };
    };
    if (err?.status === 429) return block(err.retryAfter || WINDOW_MS);
    if (err?.status === 401 && err.attemptsLeft === 0) return block(WINDOW_MS);
    const n = err?.status === 401 ? err.attemptsLeft : null;
    const hint =
      n > 0 && n <= 2 ? ` ${n === 1 ? 'Resta 1 tentativa' : `Restam ${n} tentativas`} antes de o login ficar bloqueado por 15 minutos.` : '';
    return { locked: false, hint };
  };
  return { locked: Boolean(active), left: active ? lock.until - now : 0, track };
}

/** Aviso do bloqueio, com a contagem regressiva. */
export function LoginLock({ left }) {
  return (
    <div className="login-lock" role="alert">
      <Lock size={18} />
      <p>
        <b>Muitas tentativas de login.</b> Por segurança, o login desta conta ficou bloqueado. Tente de novo em{' '}
        <b className="login-lock-time">{mmss(left)}</b>.
        <small>Esqueceu a senha? Peça ao administrador do servidor para redefinir.</small>
      </p>
    </div>
  );
}
