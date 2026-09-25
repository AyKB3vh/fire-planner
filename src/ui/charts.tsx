/** SVG chart primitives (no external libraries). */

import { useState, type ReactElement } from 'react';

export interface Series {
  name: string;
  color: string;
  points: { x: number; y: number }[];
}

interface LineChartProps {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  /** Horizontal reference line (e.g. reserve level). */
  reference?: { y: number; label: string; color: string };
  className?: string;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

export function LineChart(props: LineChartProps): ReactElement {
  const { series, height = 260, yFormat, reference, className } = props;
  const width = 860;
  const pad = { l: 64, r: 14, t: 12, b: 30 };
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) {
    return <div className="muted">No data.</div>;
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  let yMin = Math.min(...ys, reference ? reference.y : 0);
  let yMax = Math.max(...ys, reference ? reference.y : 0);
  if (xMin === xMax) xMax = xMin + 1;
  const yPad = (yMax - yMin) * 0.06 || 1;
  yMin -= yPad;
  yMax += yPad;

  const sx = (x: number): number =>
    pad.l + ((x - xMin) / (xMax - xMin)) * (width - pad.l - pad.r);
  const sy = (y: number): number =>
    height - pad.b - ((y - yMin) / (yMax - yMin)) * (height - pad.t - pad.b);

  const yTicks = niceTicks(yMin, yMax, 5);
  const xTicks = niceTicks(xMin, xMax, 7);
  const fmt = yFormat ?? ((v: number) => v.toLocaleString('en-EE', { maximumFractionDigits: 0 }));

  return (
    <div className={className}>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: 'block' }}>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={pad.l}
                x2={width - pad.r}
                y1={sy(t)}
                y2={sy(t)}
                stroke="#2a3644"
                strokeDasharray="3 4"
              />
              <text x={pad.l - 8} y={sy(t) + 4} textAnchor="end" fontSize="11" fill="#93a3b5">
                {fmt(t)}
              </text>
            </g>
          ))}
          {xTicks
            .filter((t) => t >= xMin && t <= xMax)
            .map((t) => (
              <text
                key={`x${t}`}
                x={sx(t)}
                y={height - 8}
                textAnchor="middle"
                fontSize="11"
                fill="#93a3b5"
              >
                {t}
              </text>
            ))}
          {reference ? (
            <g>
              <line
                x1={pad.l}
                x2={width - pad.r}
                y1={sy(reference.y)}
                y2={sy(reference.y)}
                stroke={reference.color}
                strokeDasharray="6 4"
              />
              <text
                x={width - pad.r - 4}
                y={sy(reference.y) - 5}
                textAnchor="end"
                fontSize="10"
                fill={reference.color}
              >
                {reference.label}
              </text>
            </g>
          ) : null}
          {series.map((s) => (
            <polyline
              key={s.name}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
            />
          ))}
        </svg>
      </div>
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <span className="dot" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

interface BarsProps {
  data: { label: string; value: number; color?: string }[];
  format?: (v: number) => string;
}

export function BarList({ data, format }: BarsProps): ReactElement {
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const fmt = format ?? ((v: number) => v.toLocaleString('en-EE', { maximumFractionDigits: 0 }));
  return (
    <div>
      {data.map((d) => (
        <div
          key={d.label}
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}
        >
          <span style={{ width: 150, fontSize: 12, color: '#93a3b5' }}>{d.label}</span>
          <div style={{ flex: 1, background: '#1d2632', borderRadius: 4, height: 14, position: 'relative' }}>
            <div
              style={{
                width: `${(Math.abs(d.value) / max) * 100}%`,
                background: d.color ?? '#4da3ff',
                height: '100%',
                borderRadius: 4,
              }}
            />
          </div>
          <span className="num" style={{ width: 110, textAlign: 'right', fontSize: 12 }}>
            {fmt(d.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Grouped bars for quantile triples (p5 / median / p95). */
export function QuantileBars({
  rows,
  format,
}: {
  rows: { label: string; p5: number; median: number; p95: number }[];
  format?: (v: number) => string;
}): ReactElement {
  const fmt = format ?? ((v: number) => v.toLocaleString('en-EE', { maximumFractionDigits: 0 }));
  return (
    <table>
      <thead>
        <tr>
          <th>Measure</th>
          <th className="num">p5</th>
          <th className="num">Median</th>
          <th className="num">p95</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="num">{fmt(r.p5)}</td>
            <td className="num">
              <b>{fmt(r.median)}</b>
            </td>
            <td className="num">{fmt(r.p95)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Stacked bars over years (funding-source composition). */
export function StackedBars({
  years,
  series,
  height = 240,
  format,
}: {
  years: number[];
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  format?: (v: number) => string;
}): ReactElement {
  const width = 860;
  const pad = { l: 64, r: 12, t: 10, b: 26 };
  const totals = years.map((_, i) => series.reduce((acc, s) => acc + Math.max(0, s.values[i] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const bw = (width - pad.l - pad.r) / years.length;
  const fmt = format ?? ((v: number) => `${Math.round(v / 1000)}k`);
  const ticks = [0, max / 2, max];
  return (
    <div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: 'block' }}>
          {ticks.map((t) => {
            const y = height - pad.b - (t / max) * (height - pad.t - pad.b);
            return (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke="#2a3644" strokeDasharray="3 4" />
                <text x={pad.l - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#93a3b5">
                  {fmt(t)}
                </text>
              </g>
            );
          })}
          {years.map((yr, i) => {
            let acc = 0;
            const x = pad.l + i * bw;
            return (
              <g key={yr}>
                {series.map((s) => {
                  const v = Math.max(0, s.values[i] ?? 0);
                  const h = (v / max) * (height - pad.t - pad.b);
                  const rect = (
                    <rect
                      key={s.name}
                      x={x + 1}
                      y={height - pad.b - acc - h}
                      width={Math.max(1, bw - 2)}
                      height={h}
                      fill={s.color}
                    />
                  );
                  acc += h;
                  return rect;
                })}
                {i % Math.ceil(years.length / 12) === 0 ? (
                  <text x={x + bw / 2} y={height - 8} textAnchor="middle" fontSize="10" fill="#93a3b5">
                    {yr}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <span className="dot" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
