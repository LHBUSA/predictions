// Predictions chart system (server-rendered SVG/HTML). Every chart is drawn only from stored values passed in by a
// story's evidence packet, states its units and as-of time, and carries a data-table fallback. Callers must not
// invoke a chart without the evidence it needs (see packet.js requirements); these functions return '' on thin data.
import { esc } from '../pages.js';

const C = { pbe: '#1f63b5', pbe2: '#7aa7dc', mkt: '#8a9db1', pos: '#13804b', neg: '#c2410c', grid: '#e9eff6', axis: '#5d7288', thr: '#0f2033' };
export const COLORS = C;
const fmtT = (ms) => { const d = new Date(ms); return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`; };
export const fmtUtc = (iso) => (iso ? fmtT(Date.parse(iso)) : '—');
const n1 = (v) => Number(v).toFixed(1).replace(/\.0$/, '');

export function figure({ id, kicker, title, subtitle = '', asOf, units, source, body, table = '', note = '', wide = false, scroll = false }) {
  if (!body) return '';
  return `<figure class="ix-fig${wide ? ' ix-wide' : ''}"${id ? ` id="${esc(id)}"` : ''}>
<figcaption>${kicker ? `<span class="ix-kicker">${esc(kicker)}</span>` : ''}<b>${esc(title)}</b>${subtitle ? `<span>${esc(subtitle)}</span>` : ''}</figcaption>
<div class="${scroll ? 'ix-scroll' : 'ix-plot'}">${body}</div>
<div class="ix-figmeta">${units ? `<span>Units: ${esc(units)}</span>` : ''}${asOf ? `<span>As of ${esc(fmtUtc(asOf))}</span>` : ''}${source ? `<span>Source: ${esc(source)}</span>` : ''}</div>
${note ? `<p class="ix-fignote">${note}</p>` : ''}
${table ? `<details class="ix-table"><summary>Data table</summary><div class="tbl-wrap">${table}</div></details>` : ''}
</figure>`;
}

export function dataTable(head, rows) {
  return `<table class="tbl"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td class="num">${esc(c ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// Time series of probabilities (step lines: a stored value holds until the next stored value).
// series: [{ name, color, dash?, points: [[ms, value]], dots?: (point) => color|null }]
export function timeSeries({ series, annotations = [], yMin = 0, yMax = 100, yStep = 25, yFmt = (v) => `${v}%`, label, tEnd = null, width = 720, height = 280 }) {
  const live = series.filter((s) => s.points.length);
  const ts = live.flatMap((s) => s.points.map((p) => p[0]));
  if (ts.length < 2) return '';
  const t0 = Math.min(...ts); const t1 = Math.max(tEnd ?? 0, ...ts);
  const L = 46; const R = 18; const T = 14; const B = 34;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (width - L - R);
  const y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (height - T - B);
  let grid = '';
  for (let v = yMin; v <= yMax + 1e-9; v += yStep) grid += `<line x1="${L}" x2="${width - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${C.grid}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="12" fill="${C.axis}" text-anchor="end">${esc(yFmt(v))}</text>`;
  const ticks = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text x="${x(t).toFixed(1)}" y="${height - 10}" font-size="12" fill="${C.axis}" text-anchor="${['start', 'middle', 'end'][i]}">${esc(fmtT(t))}</text>`).join('');
  const lines = live.map((s) => {
    const pts = [...s.points].sort((a, b) => a[0] - b[0]);
    const ext = [...pts, [t1, pts.at(-1)[1]]];
    const d = ext.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}${i < ext.length - 1 ? ` H${x(ext[i + 1][0]).toFixed(1)}` : ''}`).join(' ');
    const dots = s.dots ? pts.map((p) => { const col = s.dots(p); return col ? `<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="5" fill="${col}" stroke="#fff" stroke-width="1.5"><title>${esc(s.name)} ${esc(yFmt(p[1]))} · ${esc(fmtT(p[0]))}</title></circle>` : ''; }).join('') : '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 2 : 2.8}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>${dots}`;
  }).join('');
  const ann = annotations.filter((a) => a.t >= t0 && a.t <= t1).map((a, i) => `<line x1="${x(a.t).toFixed(1)}" x2="${x(a.t).toFixed(1)}" y1="${T}" y2="${height - B}" stroke="#b9c8d9" stroke-dasharray="3 3"/><text x="${(x(a.t) + 5).toFixed(1)}" y="${T + 12 + (i % 2) * 15}" font-size="11.5" font-weight="700" fill="#334a63">${esc(a.label)}</text>`).join('');
  const legend = `<div class="legend">${live.map((s) => `<span><i style="background:${s.color}${s.dash ? ';opacity:.8' : ''}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" class="ix-svg">${grid}${ticks}${ann}${lines}</svg>${legend}`;
}

// Model minus market (percentage points) at each stored forecast, where the market value was captured with it.
export function divergenceBars({ points, label, nonNegative = false, width = 720, height = 220 }) {
  if (points.length < 1) return '';
  const max = Math.max(10, ...points.map((p) => Math.abs(p.v)));
  const lim = Math.ceil(max / 10) * 10;
  const L = 46; const R = 18; const T = 14; const B = 34;
  const lo = nonNegative ? 0 : -lim;
  const y = (v) => T + (1 - (v - lo) / (lim - lo)) * (height - T - B);
  const bw = Math.min(56, (width - L - R) / points.length - 14);
  const step = (width - L - R) / points.length;
  const grid = (nonNegative ? [0, lim / 2, lim] : [-lim, -lim / 2, 0, lim / 2, lim]).map((v) => `<line x1="${L}" x2="${width - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${v === 0 ? '#9fb3c9' : C.grid}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="12" fill="${C.axis}" text-anchor="end">${v > 0 ? '+' : ''}${v}</text>`).join('');
  const bars = points.map((p, i) => {
    const cx = L + step * i + step / 2;
    const top = Math.min(y(0), y(p.v)); const h = Math.abs(y(p.v) - y(0));
    const inside = h > 24;
    const ly = inside ? (p.v >= 0 ? top + 17 : top + h - 8) : (p.v >= 0 ? top - 6 : top + h + 15);
    return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${p.v >= 0 ? C.pos : C.neg}" fill-opacity=".85"/><text x="${cx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="12.5" font-weight="800" fill="${inside ? '#fff' : '#0f2033'}" text-anchor="middle">${p.v > 0 ? '+' : ''}${p.v}</text><text x="${cx.toFixed(1)}" y="${height - 10}" font-size="11.5" fill="${C.axis}" text-anchor="middle">${esc(p.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" class="ix-svg">${grid}${bars}</svg>`;
}

// Outcome distribution as responsive HTML bars (no axis to clip on mobile). rows: [{ label, series: [{ name, v, cls }] }]
export function distributionBars({ rows, series }) {
  if (!rows.length) return '';
  const legend = `<div class="legend">${series.map((s) => `<span><i class="${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  return `${legend}<div class="ix-dist">${rows.map((r) => `<div class="ix-drow${r.highlight ? ' hl' : ''}"><div class="ix-dlabel">${esc(r.label)}</div><div class="ix-dbars">${r.values.map((v, i) => `<div class="ix-dbar ${series[i].cls}"><i style="width:${v === null ? 0 : Math.max(0.5, v)}%"></i><span>${v === null ? 'no two-sided quote' : `${n1(v)}%`}</span></div>`).join('')}</div></div>`).join('')}</div>`;
}

// Threshold curve: one nested contract per strike. PBE as a line; market as bid–ask ranges with mids where two-sided.
export function thresholdCurve({ points, xFmt, label, ref = [], width = 720, height = 300 }) {
  const pts = points.filter((p) => p.pbe !== null);
  if (pts.length < 3) return '';
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs, ...ref.map((r) => r.x)); const x1 = Math.max(...xs, ...ref.map((r) => r.x));
  const L = 46; const R = 18; const T = 16; const B = 40;
  const X = (v) => L + ((v - x0) / Math.max(1e-9, x1 - x0)) * (width - L - R);
  const Y = (v) => T + (1 - v / 100) * (height - T - B);
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${width - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}"/><text x="${L - 8}" y="${Y(v) + 4}" font-size="12" fill="${C.axis}" text-anchor="end">${v}%</text>`).join('');
  const span = x1 - x0; const stepX = span > 0.5 ? 0.1 : 0.05;
  let ticks = '';
  for (let v = Math.ceil(x0 / stepX) * stepX; v <= x1 + 1e-9; v += stepX) ticks += `<line x1="${X(v)}" x2="${X(v)}" y1="${height - B}" y2="${height - B + 5}" stroke="${C.axis}"/><text x="${X(v)}" y="${height - B + 19}" font-size="12" fill="${C.axis}" text-anchor="middle">${esc(xFmt(v))}</text>`;
  const refs = ref.map((r) => `<line x1="${X(r.x)}" x2="${X(r.x)}" y1="${T}" y2="${height - B}" stroke="${C.thr}" stroke-dasharray="4 4"/><text x="${X(r.x) + (r.anchor === 'end' ? -6 : 6)}" y="${T + 12 + (r.row || 0) * 15}" font-size="11.5" font-weight="700" fill="${C.thr}" text-anchor="${r.anchor || 'start'}">${esc(r.label)}</text>`).join('');
  const mk = points.filter((p) => p.bid !== null && p.ask !== null).map((p) => `<line x1="${X(p.x)}" x2="${X(p.x)}" y1="${Y(p.ask)}" y2="${Y(p.bid)}" stroke="${C.mkt}" stroke-width="5" stroke-linecap="round" stroke-opacity=".55"><title>market bid ${p.bid}% / ask ${p.ask}%</title></line>${p.mid !== null ? `<circle cx="${X(p.x)}" cy="${Y(p.mid)}" r="5" fill="#fff" stroke="#4b5f73" stroke-width="2.2"><title>market mid ${p.mid}%</title></circle>` : ''}`).join('');
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.pbe).toFixed(1)}`).join(' ');
  const dots = pts.map((p) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.pbe).toFixed(1)}" r="3.4" fill="${C.pbe}"><title>PBE ${p.pbe}% at ${esc(xFmt(p.x))}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" class="ix-svg">${grid}${ticks}${refs}${mk}<path d="${line}" fill="none" stroke="${C.pbe}" stroke-width="2.8"/>${dots}</svg>
<div class="legend"><span><i style="background:${C.pbe}"></i>PBE probability (each dot a stored forecast)</span><span><i style="background:${C.mkt}"></i>Market bid–ask range</span><span><i class="ix-ring"></i>Market mid (two-sided quotes only)</span></div>`;
}

// Number-line of guidance values (e.g. forecast highs) against contract buckets and the threshold.
// marks: [{ v, label, color, sd? }]; buckets: [{ lo, hi, label, pbe, market }]
export function guidanceLadder({ marks, buckets = [], threshold = null, min, max, unit = '°F', label, width = 720, height = 250 }) {
  if (marks.length < 2) return '';
  const L = 24; const R = 24; const axisY = 150;
  const X = (v) => L + ((v - min) / (max - min)) * (width - L - R);
  let ticks = '';
  for (let v = Math.ceil(min / 2) * 2; v <= max; v += 2) ticks += `<line x1="${X(v)}" x2="${X(v)}" y1="${axisY}" y2="${axisY + 6}" stroke="${C.axis}"/><text x="${X(v)}" y="${axisY + 22}" font-size="12" fill="${C.axis}" text-anchor="middle">${v}${v % 4 === 0 ? unit.replace('F', '') : ''}</text>`;
  const bands = buckets.map((b, i) => {
    const lo = Math.max(min, b.lo ?? min); const hi = Math.min(max, b.hi ?? max);
    return `<rect x="${X(lo)}" y="${axisY + 34}" width="${Math.max(0, X(hi) - X(lo) - 2)}" height="44" rx="5" fill="${i % 2 ? '#eef3f9' : '#e3ecf7'}"/><text x="${(X(lo) + X(hi)) / 2}" y="${axisY + 52}" font-size="11.5" font-weight="800" fill="${C.pbe}" text-anchor="middle">${b.pbe !== null ? `${b.pbe}%` : ''}</text><text x="${(X(lo) + X(hi)) / 2}" y="${axisY + 69}" font-size="11.5" font-weight="700" fill="#4b5f73" text-anchor="middle">${b.market !== null && b.market !== undefined ? `${b.market}%` : '—'}</text>`;
  }).join('');
  const pins = [...marks].sort((a, b) => a.v - b.v).map((m, i) => {
    const row = i % 3; const yTop = 26 + row * 36;
    return `${m.sd ? `<rect x="${X(m.v - m.sd)}" y="${axisY - 8}" width="${X(m.v + m.sd) - X(m.v - m.sd)}" height="8" rx="4" fill="${m.color}" fill-opacity=".22"/>` : ''}<line x1="${X(m.v)}" x2="${X(m.v)}" y1="${yTop + 6}" y2="${axisY}" stroke="${m.color}" stroke-width="2"/><circle cx="${X(m.v)}" cy="${axisY}" r="5" fill="${m.color}"/><text x="${X(m.v)}" y="${yTop}" font-size="12.5" font-weight="800" fill="${m.color}" text-anchor="middle">${esc(m.label)} ${m.v}${unit}</text>`;
  }).join('');
  const thr = threshold !== null ? `<line x1="${X(threshold)}" x2="${X(threshold)}" y1="10" y2="${axisY + 80}" stroke="${C.thr}" stroke-width="2" stroke-dasharray="5 4"/><text x="${X(threshold) - 6}" y="${axisY + 94}" font-size="12" font-weight="800" fill="${C.thr}" text-anchor="end">contract threshold ${threshold}${unit}</text>` : '';
  return `<svg viewBox="0 0 ${width} ${height + 10}" role="img" aria-label="${esc(label)}" class="ix-svg"><line x1="${L}" x2="${width - R}" y1="${axisY}" y2="${axisY}" stroke="#9fb3c9" stroke-width="2"/>${ticks}${bands}${thr}${pins}${buckets.length ? `<text x="${L}" y="${axisY + 52}" font-size="10.5" font-weight="800" fill="${C.pbe}">PBE</text><text x="${L}" y="${axisY + 69}" font-size="10.5" font-weight="800" fill="#4b5f73">MKT</text>` : ''}</svg>`;
}

// Calibration (reliability) table/chart — rendered only when the scored sample reaches the publication minimum.
export function calibration({ bins, n, minN }) {
  if (!n || n < minN || !bins?.length) return '';
  const rows = bins.filter((b) => b.n > 0);
  return `<div class="ix-calib">${rows.map((b) => `<div class="ix-cbin"><span>${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%</span><div class="ix-dbar pbe"><i style="width:${(b.mean_p * 100).toFixed(1)}%"></i><span>forecast ${(b.mean_p * 100).toFixed(0)}%</span></div><div class="ix-dbar obs"><i style="width:${(b.freq * 100).toFixed(1)}%"></i><span>observed ${(b.freq * 100).toFixed(0)}% · n=${b.n}</span></div></div>`).join('')}<p class="ix-fignote">n = ${n.toLocaleString('en-US')} scored forecasts.</p></div>`;
}
