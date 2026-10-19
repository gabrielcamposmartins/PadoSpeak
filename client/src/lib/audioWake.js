// O sistema pode suspender um AudioContext no meio da chamada (uma ligação no celular, a tela que
// apagou, o aparelho de som que mudou). Parado, o do RNNoise manda silêncio no lugar do microfone e o do
// volume acima de 100% emudece a pessoa: estes contextos voltam sozinhos.

/** Religa `ctx` quando ele for suspenso (ou na volta para a tela, ou no próximo toque). Devolve o desligar. */
export function keepAwake(ctx) {
  const wake = () => {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {});
  };
  ctx.addEventListener('statechange', wake);
  document.addEventListener('visibilitychange', wake);
  // Sem gesto da pessoa o navegador pode recusar; o próximo clique ou tecla resolve.
  window.addEventListener('click', wake, true);
  window.addEventListener('keydown', wake, true);
  return () => {
    ctx.removeEventListener('statechange', wake);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('click', wake, true);
    window.removeEventListener('keydown', wake, true);
  };
}
