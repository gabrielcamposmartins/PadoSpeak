import { useEffect, useMemo, useRef, useState } from 'react';

// Paleta categórica (passos para fundo escuro), validada contra a superfície azul-marinho #0b2a4a
// (a mesma nos temas claro e escuro): todos os critérios obrigatórios passam; o verde (slot 6) fica
// abaixo de 3:1, por isso a tabela abaixo do gráfico sempre mostra os valores (alívio exigido).
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
/** A partir do 9º participante não inventamos cores: os excedentes ficam em cinza. */
const OVERFLOW = '#80848e';
const colorOf = (slot) => SERIES[slot] ?? OVERFLOW;

const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 44 };

/** Eixo Y a partir de zero com 4 intervalos de passo "redondo" (5, 10, 25, 50, 100…). */
const STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
function niceScale(max) {
  const step = STEPS.find((s) => s * 4 >= (max || 0) * 1.1) ?? Math.ceil(max / 4000) * 1000;
  return { yMax: step * 4, ticks: [0, 1, 2, 3, 4].map((k) => k * step) };
}

const fmtMs = (v) => (v == null ? '—' : `${Math.round(v)} ms`);

function summarize(values) {
  const nums = values.filter((v) => v != null);
  if (!nums.length) return { current: null, avg: null, max: null };
  return {
    current: values.at(-1),
    avg: nums.reduce((a, b) => a + b, 0) / nums.length,
    max: Math.max(...nums),
  };
}

/**
 * Latência ao longo da chamada: ping até o servidor + RTT da conexão WebRTC com cada pessoa.
 * @param {{ samples: {t:number, server:number|null, peers:Record<string, number|null>}[], series: {id:string,label:string,slot:number}[] }} props.data
 */
export default function LatencyChart({ data }) {
  const wrap = useRef(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { samples, series } = data;
  const valueOf = (sample, id) => (id === 'server' ? sample.server : (sample.peers[id] ?? null));

  const model = useMemo(() => {
    const values = series.map((s) => samples.map((p) => valueOf(p, s.id)));
    const all = values.flat().filter((v) => v != null);
    const { yMax, ticks } = niceScale(all.length ? Math.max(...all) : 0);
    const t1 = samples.at(-1)?.t ?? Date.now();
    const t0 = Math.min(samples[0]?.t ?? t1, t1 - 60_000); // pelo menos 1 minuto de janela
    return { values, yMax, ticks, t0, t1 };
  }, [samples, series]);

  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t) => PAD.left + ((t - model.t0) / Math.max(1, model.t1 - model.t0)) * plotW;
  const y = (v) => PAD.top + plotH - (v / model.yMax) * plotH;

  // Linha quebrada nos buracos (amostra sem valor).
  const path = (vals) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) return (pen = false);
      d += `${pen ? 'L' : 'M'}${x(samples[i].t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const { ticks } = model;
  const span = (model.t1 - model.t0) / 1000;
  const xTicks = [0, 1, 2, 3].map((k) => model.t1 - k * 60_000).filter((t) => t >= model.t0 - 1);

  function onMove(e) {
    if (!samples.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    samples.forEach((s, i) => {
      if (Math.abs(x(s.t) - px) < Math.abs(x(samples[best].t) - px)) best = i;
    });
    setHover(best);
  }

  const hs = hover != null ? samples[hover] : null;
  const tipLeft = hs ? x(hs.t) : 0;

  return (
    <div className="latency-chart" ref={wrap}>
      <div className="lc-title">
        <b>Latência</b>
        <span>ida e volta, últimos {Math.max(1, Math.round(span / 60))} min · atualiza a cada 2 s</span>
      </div>
      {samples.length < 2 ? (
        <div className="lc-empty">Coletando amostras…</div>
      ) : (
        <div className="lc-plot">
          <svg
            width={width}
            height={H}
            role="img"
            aria-label="Gráfico de latência em milissegundos ao longo do tempo"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className="lc-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="lc-axis" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            <text className="lc-axis" x={4} y={PAD.top + 4}>
              ms
            </text>
            {xTicks.map((t) => (
              <text key={t} className="lc-axis" x={x(t)} y={H - 6} textAnchor={t === model.t1 ? 'end' : 'middle'}>
                {t === model.t1 ? 'agora' : `-${Math.round((model.t1 - t) / 60_000)} min`}
              </text>
            ))}
            {series.map((s, i) => (
              <path
                key={s.id}
                d={path(model.values[i])}
                fill="none"
                stroke={colorOf(s.slot)}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {hs && (
              <g>
                <line className="lc-cross" x1={tipLeft} x2={tipLeft} y1={PAD.top} y2={PAD.top + plotH} />
                {series.map((s, i) => {
                  const v = model.values[i][hover];
                  return v == null ? null : (
                    <circle
                      key={s.id}
                      cx={tipLeft}
                      cy={y(v)}
                      r="4"
                      fill={colorOf(s.slot)}
                      stroke="var(--lc-surface)"
                      strokeWidth="2"
                    />
                  );
                })}
              </g>
            )}
          </svg>
          {hs && (
            <div
              className="lc-tip"
              style={{ left: Math.min(Math.max(tipLeft, 90), width - 90) }}
              role="status"
              aria-live="polite"
            >
              <div className="lc-tip-time">{new Date(hs.t).toLocaleTimeString()}</div>
              {series.map((s, i) => (
                <div key={s.id} className="lc-tip-row">
                  <span className="lc-key" style={{ background: colorOf(s.slot) }} />
                  <b>{fmtMs(model.values[i][hover])}</b>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <table className="lc-table">
        <thead>
          <tr>
            <th>Conexão</th>
            <th>Agora</th>
            <th>Média</th>
            <th>Pior</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s, i) => {
            const st = summarize(model.values[i]);
            return (
              <tr key={s.id}>
                <td>
                  <span className="lc-key" style={{ background: colorOf(s.slot) }} />
                  {s.label}
                </td>
                <td>{fmtMs(st.current)}</td>
                <td>{fmtMs(st.avg)}</td>
                <td>{fmtMs(st.max)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
