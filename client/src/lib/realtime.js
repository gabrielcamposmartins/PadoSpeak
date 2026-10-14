// Cliente WebSocket do PadoSpeak: eventos, requisições com resposta e reconexão automática.
// Protocolo: envia { op, d, id? }; recebe { re, d } (respostas) ou { ev, d } (eventos).
export class Realtime {
  constructor(urlFactory) {
    this.urlFactory = urlFactory;
    this.handlers = new Map();
    this.pending = new Map();
    this.seq = 0;
    this.attempt = 0;
    this.closed = false;
    this.status = 'connecting';
    this.peerId = null;
    this.connect();
  }

  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev).add(fn);
    return () => this.handlers.get(ev)?.delete(fn);
  }

  emit(ev, d) {
    this.handlers.get(ev)?.forEach((fn) => {
      try {
        fn(d);
      } catch (e) {
        console.error(`[rt] handler ${ev}`, e);
      }
    });
  }

  setStatus(s) {
    this.status = s;
    this.emit('status', s);
  }

  connect() {
    this.setStatus('connecting');
    const ws = new WebSocket(this.urlFactory());
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.re != null) {
        const p = this.pending.get(msg.re);
        if (p) {
          this.pending.delete(msg.re);
          clearTimeout(p.timer);
          p.resolve(msg.d);
        }
      } else if (msg.ev) {
        if (msg.ev === 'ready') {
          this.peerId = msg.d.peerId;
          this.setStatus('connected');
        }
        this.emit(msg.ev, msg.d);
      }
    };
    ws.onclose = (e) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ error: 'Conexão perdida' });
      }
      this.pending.clear();
      if (this.ws !== ws) return;
      const wasConnected = this.status === 'connected';
      this.peerId = null;
      if (wasConnected) this.emit('disconnected');
      if (this.closed) return this.setStatus('closed');
      // Upgrade recusado (token inválido) costuma chegar como 1006 logo de cara; a UI decide pelo /api/me.
      this.setStatus('reconnecting');
      const delay = Math.min(1000 * 2 ** this.attempt++, 15000);
      this.retryTimer = setTimeout(() => this.connect(), delay);
      this.emit('retry', { code: e.code, delay });
    };
  }

  send(op, d = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  request(op, d = {}, timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return resolve({ error: 'Sem conexão com o servidor' });
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: 'Tempo esgotado' });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify({ op, d, id }));
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
