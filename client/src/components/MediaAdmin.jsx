import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Cpu, KeyRound, Music, Plus, Radio, Server, Trash2 } from 'lucide-react';
import { useStore } from '../store.js';
import './media-admin.css';

// Painel → Mídia: os nós de mídia (SFU das chamadas e token da música) deste servidor. Veja server/src/media.

const ago = (ts, now) => {
  if (!ts) return 'nunca';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
};

const CAP_LABELS = { sfu: 'Chamadas (SFU)', pot: 'Token do YouTube', music: 'Busca da música' };
const RELAY = [
  ['auto', 'Automático (quando o YouTube bloquear este servidor, ou ele estiver sobrecarregado)'],
  ['always', 'Sempre pelo nó'],
  ['off', 'Nunca'],
];

/** O código de pareamento recém-criado, com as instruções (aparece uma vez só). */
function PairingCode({ code, name, onClose }) {
  const st = useStore.getState();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      st.notify('Código copiado.', 'info');
    } catch {
      st.notify('Não deu para copiar: selecione o código e copie.');
    }
  };
  return (
    <div className="ma-code">
      <h4>
        <KeyRound size={15} /> Código do nó “{name}”
      </h4>
      <p className="kv">Ele aparece só agora. Quem tiver o código liga um nó a este servidor: guarde como uma senha.</p>
      <div className="ma-code-row">
        <code className="ma-code-text">{code}</code>
        <button type="button" className="btn secondary" onClick={copy}>
          <Copy size={14} /> Copiar
        </button>
      </div>
      <ul className="ma-steps">
        <li>
          <b>Linux (Docker):</b> copie a pasta <code>deploy/media</code> para a máquina, ponha <code>MEDIA_JOIN=</code> com o código em{' '}
          <code>/etc/padospeak-media/media.env</code> e rode <code>sudo ./setup.sh</code>.
        </li>
        <li>
          <b>Windows:</b> no app do PadoSpeak, abra Hostear → Nó de mídia e cole o código.
        </li>
        <li>
          A porta <b>UDP 3479</b> precisa chegar ao nó. Num roteador de casa, redirecione essa porta para a máquina do nó (quem está na
          mesma rede chega sem isso).
        </li>
      </ul>
      <div className="fp-buttons">
        <button type="button" className="btn" onClick={onClose}>
          Pronto
        </button>
      </div>
    </div>
  );
}

function NodeRow({ node, index, count, ro, onChanged, onCode }) {
  const st = useStore.getState();
  const [name, setName] = useState(node.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      onChanged(await fn());
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const load = node.load || {};
  const sfuMode = node.sfuMode || 'all';
  const state = !node.enabled ? 'desativado' : node.online ? (node.ready ? 'no ar' : 'ligando') : 'fora do ar';
  const tone = !node.enabled ? 'off' : node.online ? (node.ready ? 'on' : 'wait') : 'down';
  return (
    <li className="ma-node">
      <div className="ma-node-head">
        <span className={`ma-dot ${tone}`} aria-hidden="true" />
        {ro ? (
          <b className="ma-node-name">{node.name}</b>
        ) : (
          <input
            className="ma-node-name"
            value={name}
            maxLength={40}
            aria-label="Nome do nó"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== node.name && run(() => st.editMediaNode(node.id, { name }))}
          />
        )}
        <span className="ma-state">{state}</span>
        {!ro && (
          <span className="ma-actions">
            <button type="button" className="icon-btn" title="Subir na prioridade" disabled={busy || index === 0} onClick={() => run(() => st.editMediaNode(node.id, { priority: Math.max(0, node.priority - 1) }))}>
              <ArrowUp size={15} />
            </button>
            <button type="button" className="icon-btn" title="Descer na prioridade" disabled={busy || index === count - 1} onClick={() => run(() => st.editMediaNode(node.id, { priority: node.priority + 1 }))}>
              <ArrowDown size={15} />
            </button>
          </span>
        )}
      </div>
      <p className="kv ma-node-meta">
        {node.online ? (
          <>
            {node.publicIp && <>visto de {node.publicIp} · </>}UDP {node.udpPort || '?'}
            {node.lan?.length ? <> · rede local {node.lan.join(', ')}</> : null}
            {node.version && <> · versão {node.version}</>}
          </>
        ) : (
          <>visto pela última vez {ago(node.lastSeen, Date.now())}</>
        )}
      </p>
      {node.online && (
        <div className="chips ma-chips">
          {(node.caps || []).map((c) => (
            <span className="chip" key={c}>
              {CAP_LABELS[c] || c}
            </span>
          ))}
          <span className="chip">
            {load.rooms ?? 0} {load.rooms === 1 ? 'sala' : 'salas'} · {load.peers ?? 0} {load.peers === 1 ? 'conexão' : 'conexões'} · {load.kbps ?? 0} kbps
          </span>
          {load.pot && <span className="chip">token: {load.pot}</span>}
          {sfuMode !== 'all' && (node.caps || []).includes('sfu') && <span className="chip">{sfuMode === 'voice' ? 'SFU só para a voz' : 'SFU desligado'}</span>}
        </div>
      )}
      {!ro && (
        <div className="ma-node-sfu" role="group" aria-label={`Chamadas pelo nó ${node.name}`}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={sfuMode !== 'off'}
              disabled={busy || !node.enabled}
              onChange={(e) => run(() => st.editMediaNode(node.id, { sfuMode: e.target.checked ? 'all' : 'off' }))}
            />
            <span>
              Usar o SFU
              <small className="check-hint">
                As chamadas dos servidores passam por este nó. Desligado, o nó continua com o token e a música, e as chamadas vão por outro nó ou
                direto entre as pessoas.
                {node.online && !(node.caps || []).includes('sfu') ? ' Este nó foi iniciado sem o SFU (MEDIA_SFU=off).' : ''}
              </small>
            </span>
          </label>
          <label className="checkbox ma-sub">
            <input
              type="checkbox"
              checked={sfuMode === 'voice'}
              disabled={busy || !node.enabled || sfuMode === 'off'}
              onChange={(e) => run(() => st.editMediaNode(node.id, { sfuMode: e.target.checked ? 'voice' : 'all' }))}
            />
            <span>
              Usar o SFU só para a voz
              <small className="check-hint">
                Câmera e tela vão direto entre as pessoas. Bom para um nó com pouca banda de envio: a voz usa uns 50 kbps por pessoa; uma tela em 1080p,
                até 9 Mbps para cada uma.
              </small>
            </span>
          </label>
        </div>
      )}
      {!ro && (
        <div className="ma-node-foot">
          <label className="checkbox">
            <input type="checkbox" checked={node.enabled} disabled={busy} onChange={(e) => run(() => st.editMediaNode(node.id, { enabled: e.target.checked }))} />
            <span>Usar este nó</span>
          </label>
          <span className="fp-buttons">
            <button type="button" className="btn secondary" disabled={busy} onClick={() => onCode(node)}>
              <KeyRound size={14} /> Código novo
            </button>
            {confirming ? (
              <>
                <button type="button" className="btn red" disabled={busy} onClick={() => run(() => st.removeMediaNode(node.id))}>
                  Remover mesmo
                </button>
                <button type="button" className="btn secondary" onClick={() => setConfirming(false)}>
                  Cancelar
                </button>
              </>
            ) : (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirming(true)}>
                <Trash2 size={14} /> Remover
              </button>
            )}
          </span>
        </div>
      )}
    </li>
  );
}

export default function MediaAdmin() {
  const st = useStore.getState();
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState(null); // { code, name }
  const [busy, setBusy] = useState(false);
  const refresh = () => st.adminMedia().then(setData, (e) => st.notify(e.message));
  useEffect(() => {
    refresh();
    // O estado dos nós muda sozinho (ligam, caem, a carga).
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);
  if (!data) return <p className="kv">Carregando…</p>;
  const ro = !data.canEdit;
  const s = data.settings;
  const save = async (patch) => {
    setBusy(true);
    try {
      setData(await st.saveMediaSettings({ ...s, ...patch }));
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    setBusy(true);
    try {
      const res = await st.addMediaNode(name.trim());
      setCode({ code: res.code, name: name.trim() });
      setName('');
      setData(res.view);
    } catch (e) {
      st.notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const newCode = async (node) => {
    try {
      const res = await st.newMediaNodeCode(node.id);
      setCode({ code: res.code, name: node.name });
      refresh();
    } catch (e) {
      st.notify(e.message);
    }
  };
  const load = data.load || {};
  const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);
  const onSfu = (data.rooms || []).length;
  return (
    <div className="fp ma">
      <p className="kv">
        Um nó de mídia é outra máquina (ou esta mesma) que leva as chamadas dos canais de voz (SFU) e o token da música. Se o nó cair, as
        chamadas continuam pela conexão direta entre os aparelhos, sem ninguém perceber. A mídia passa cifrada pelo nó: ele só repassa.
      </p>
      <div className="fp-cols">
        <section className="fp-side">
          <h4>
            <Cpu size={15} /> Este servidor
          </h4>
          <p className="kv fp-sum">
            CPU {pct(load.cpu)} · memória {pct(load.mem)} · música {load.musicKbps ?? 0} kbps
            {load.overloaded && <b className="fp-warn"> · sobrecarregado: o trabalho pesado vai para os nós</b>}
          </p>
          <p className="kv fp-sum">
            {onSfu ? `${onSfu} ${onSfu === 1 ? 'sala' : 'salas'} num nó agora.` : 'Nenhuma sala num nó agora.'}{' '}
            {data.potReady ? 'O token do YouTube está sendo pedido ao nó em cada música.' : 'Sem nó de token: a música busca como antes.'}
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.embeddedSfu}
              disabled={ro || busy || data.locked?.embeddedSfu}
              onChange={(e) => save({ embeddedSfu: e.target.checked })}
            />
            <span>
              SFU neste servidor (a mesma máquina)
              <small className="check-hint">
                {data.locked?.embeddedSfu
                  ? 'Definido pela variável SFU_EMBEDDED.'
                  : data.local?.running
                    ? `Na porta UDP ${data.local.port}: ${data.local.rooms} ${data.local.rooms === 1 ? 'sala' : 'salas'}, ${data.local.peers} ${data.local.peers === 1 ? 'conexão' : 'conexões'}.`
                    : 'Os nós remotos vêm antes dele.'}
              </small>
            </span>
          </label>
        </section>
        <section className="fp-side">
          <h4>
            <Radio size={15} /> Chamadas e música
          </h4>
          <label className="checkbox">
            <input type="checkbox" checked={Boolean(s.sfuAlways)} disabled={ro || busy} onChange={(e) => save({ sfuAlways: e.target.checked })} />
            <span>
              Sempre usar o SFU
              <small className="check-hint">
                Toda chamada passa pelo nó de mídia, mesmo com 1 ou 2 pessoas e nas conversas privadas. Sem isto, a chamada começa com conexão
                direta entre os aparelhos e passa para o SFU a partir do número de pessoas abaixo. Ligando, as chamadas em andamento passam
                para o SFU na hora; desligando, as que já estão nele continuam até esvaziar. Quem não consegue chegar ao nó continua com conexão
                direta com cada um. Só vale com um nó de pé.
              </small>
            </span>
          </label>
          <label className="field" htmlFor="ma-min">
            <span>Canais de voz passam para o SFU a partir de</span>
            <select id="ma-min" value={s.sfuMinPeople} disabled={ro || busy || Boolean(s.sfuAlways)} onChange={(e) => save({ sfuMinPeople: Number(e.target.value) })}>
              {[2, 3, 4, 5, 6, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n} pessoas
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={s.pot} disabled={ro || busy} onChange={(e) => save({ pot: e.target.checked })} />
            <span>
              Pedir ao nó um token do YouTube para cada música
              <small className="check-hint">Diminui os bloqueios do YouTube a este servidor.</small>
            </span>
          </label>
          <label className="field" htmlFor="ma-relay">
            <span>
              <Music size={13} /> Buscar a música pelo nó
            </span>
            <select id="ma-relay" value={s.musicRelay} disabled={ro || busy} onChange={(e) => save({ musicRelay: e.target.value })}>
              {RELAY.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </section>
      </div>
      <h4 className="ma-title">
        <Server size={15} /> Nós de mídia
      </h4>
      {data.nodes.length ? (
        <ul className="ma-nodes">
          {data.nodes.map((n, i) => (
            <NodeRow key={n.id} node={n} index={i} count={data.nodes.length} ro={ro} onChanged={setData} onCode={newCode} />
          ))}
        </ul>
      ) : (
        <p className="kv">Nenhum nó ainda.{ro ? '' : ' Adicione um abaixo e ligue o nó com o código.'}</p>
      )}
      {code && <PairingCode code={code.code} name={code.name} onClose={() => setCode(null)} />}
      {!ro && !code && (
        <form
          className="ma-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add();
          }}
        >
          <input value={name} maxLength={40} placeholder="Nome do nó (ex.: Laptop da sala)" aria-label="Nome do nó novo" onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !name.trim()}>
            <Plus size={14} /> Adicionar nó
          </button>
        </form>
      )}
      {ro && <p className="kv">Só o dono do app muda os nós de mídia.</p>}
    </div>
  );
}
