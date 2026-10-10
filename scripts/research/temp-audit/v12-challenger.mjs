// Issue #64 Stage 2: pre-window maxtemp v1.2 challenger, exactly as pre-registered in
// docs/research/TEMP_PREWINDOW_V12_PREREG.md (committed eaa9f41 before this script was run).
//   node scripts/research/temp-audit/v12-challenger.mjs [archive-dir] [--json out.json]
// Reads only the local IEM/ACIS archive. No DB, no market data, no network.
import { writeFile } from 'node:fs/promises';
import { buildCases } from './cases.mjs';
import { clusterBootstrap, modalIndex } from '../../../src/weather/temp-skill.js';

const DATA = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'D:/Workers/scratch/predictions-wx';
const H = 3600000; const DAY = 86400000;
const FIT_END = '2025-01-01'; const VAL_END = '2025-07-01'; const TEST_SPLIT = '2026-01-01';
const BOUNDS = [0.01, 0.99];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// ---------- cases (shared builder: same construction as scripts/research/wx-temp-nbm.mjs, plus xnd and window times) ----------
const cases = await buildCases(DATA);
console.error('cases', cases.length);

// ---------- point-in-time recent bias (EWMA of the station's past NBM residuals at the same lead) ----------
const byKey = new Map(); for (const c of cases) { const k = `${c.s}|${c.h}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }
for (const list of byKey.values()) list.sort((a, b) => a.d.localeCompare(b.d));
function attachBias(H_DAYS) {
  const key = `bias${H_DAYS}`;
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i]; let w = 0; let s = 0; let k = 0; const tD = Date.parse(c.d);
      for (let j = i - 1; j >= 0; j -= 1) {
        const p = list[j]; const age = (tD - Date.parse(p.d)) / DAY; if (age > 6 * H_DAYS) break;
        if (p.knownMs > c.cutoffMs) continue; // not yet known at this cutoff
        const wt = 0.5 ** (age / H_DAYS); w += wt; s += wt * (p.y - p.n); k += 1;
      }
      c[key] = k >= 5 ? s / w : 0;
    }
  }
  return key;
}
for (const Hd of [7, 14, 30]) attachBias(Hd);

// ---------- generic empirical-table forecaster ----------
// spec: { center(c, model) -> real guidance, scale(c, model) -> residual multiplier, fit(train) -> model }
function build(spec, train) {
  const model = spec.fit ? spec.fit(train) : {};
  const t = new Map(); const pooled = new Map();
  for (const r of train) { const e = r.y - spec.center(r, model); const k = `${r.s}|${r.lb}`; if (!t.has(k)) t.set(k, []); t.get(k).push(e); if (!pooled.has(r.lb)) pooled.set(r.lb, []); pooled.get(r.lb).push(e); }
  pooled.set('all', [...pooled.values()].flat());
  return { model, t, pooled };
}
function predictor(spec, built) {
  return (r) => {
    const v = built.t.get(`${r.s}|${r.lb}`)?.length >= 60 ? built.t.get(`${r.s}|${r.lb}`) : (built.pooled.get(r.lb) || built.pooled.get('all'));
    const c = spec.center(r, built.model); const k = spec.scale ? spec.scale(r, built.model) : 1;
    const vals = v.map((e) => Math.round(c + k * e));
    return (lo, hi) => { let n = 0; for (const x of vals) if (x >= lo && x <= hi) n += 1; return Math.min(BOUNDS[1], Math.max(BOUNDS[0], (n + 0.5) / (v.length + 1))); };
  };
}
// Bucket ladder used for the 2 °F Brier and modal checks: always around round(NBM) (the same partition for every
// candidate): low tail, five 2 °F buckets, high tail.
const ladder = (r) => { const c0 = Math.round(r.n); const lows = [c0 - 5, c0 - 3, c0 - 1, c0 + 1, c0 + 3]; return [[-Infinity, c0 - 6], ...lows.map((lo) => [lo, lo + 1]), [c0 + 5, Infinity]]; };
function scoreCase(P, r) {
  const ll = -Math.log(P(r.y, r.y));
  const lad = ladder(r).map(([lo, hi]) => P(lo === -Infinity ? -999 : lo, hi === Infinity ? 999 : hi));
  const win = ladder(r).findIndex(([lo, hi]) => r.y >= lo && r.y <= hi);
  const inner = lad.slice(1, 6); let br = 0; for (let i = 1; i < 6; i += 1) br += (lad[i] - (i === win ? 1 : 0)) ** 2; br /= 5;
  const s = lad.reduce((a, b) => a + b, 0); const q = lad.map((p) => p / s); const k = modalIndex(q);
  return { ll, br, hit: k === win ? 1 : 0, pm: q[k], pit: lad.slice(0, win).reduce((a, b) => a + b, 0) / s + 0.5 * q[win], inner };
}

// ---------- candidates ----------
const A = { id: 'A', name: 'v1.1 reproduction', center: (r) => r.n };
const B = (lambda, Hd) => ({ id: 'B', name: `recent bias lambda=${lambda} H=${Hd}d`, lambda, Hd, center: (r) => r.n + lambda * r[`bias${Hd}`] });
const C = { id: 'C', name: 'NBM-spread conditioned', center: (r) => r.n,
  fit(train) {
    const xs = train.map((r) => r.xnd).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    const cuts = [xs[Math.floor(xs.length / 3)], xs[Math.floor((2 * xs.length) / 3)]];
    const ter = (x) => (x === null || x === undefined ? 1 : x <= cuts[0] ? 0 : x <= cuts[1] ? 1 : 2);
    const res = [[], [], []]; for (const r of train) res[ter(r.xnd)].push(r.y - r.n);
    const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
    const all = sd(res.flat()); return { cuts, ter, s: res.map((a) => sd(a) / all) };
  },
  scale: (r, m) => m.s[m.ter(r.xnd)] };
const D = { id: 'D', name: 'GFS-NBM regression (station beta, shrunk k=200)',
  fit(train) {
    const beta = (rs) => { const xs = rs.map((r) => r.g - r.n); const ys = rs.map((r) => r.y - r.n); const mx = mean(xs); const my = mean(ys); let sxy = 0; let sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; }); return sxx ? sxy / sxx : 0; };
    const pool = beta(train); const by = new Map(); for (const r of train) { if (!by.has(r.s)) by.set(r.s, []); by.get(r.s).push(r); }
    const b = {}; for (const [s, rs] of by) b[s] = (rs.length * beta(rs) + 200 * pool) / (rs.length + 200);
    return { pool, b };
  },
  center: (r, m) => r.n + (m.b?.[r.s] ?? m.pool ?? 0) * (r.g - r.n) };
const combine = (parts) => ({ id: 'E', name: `B+C+D (${parts[0].name})`, fit: (train) => ({ c: C.fit(train), d: D.fit(train) }),
  center: (r, m) => D.center(r, m.d) + parts[0].lambda * r[`bias${parts[0].Hd}`], scale: (r, m) => C.scale(r, m.c) });

function evaluate(spec, train, test) {
  const P = predictor(spec, build(spec, train));
  return test.map((r) => ({ r, ...scoreCase(P(r), r) }));
}
const agg = (rows) => ({ n: rows.length, log_loss: +mean(rows.map((x) => x.ll)).toFixed(4), brier_2f: +mean(rows.map((x) => x.br)).toFixed(5), hits: rows.reduce((a, x) => a + x.hit, 0), expected: +rows.reduce((a, x) => a + x.pm, 0).toFixed(1) });
const paired = (a, b, f) => clusterBootstrap(a.map((x, i) => ({ cluster: x.r.d, a: f(x), b: f(b[i]) })));

// ---------- validation (selection) ----------
const fit = cases.filter((r) => r.d < FIT_END); const val = cases.filter((r) => r.d >= FIT_END && r.d < VAL_END);
const vA = evaluate(A, fit, val);
const valRes = { A: agg(vA) };
const bGrid = []; for (const l of [0.5, 1]) for (const Hd of [7, 14, 30]) { const s = B(l, Hd); const e = evaluate(s, fit, val); bGrid.push({ s, e, a: agg(e) }); valRes[s.name] = agg(e); }
const bestB = bGrid.sort((x, y) => x.a.log_loss - y.a.log_loss)[0];
const vC = evaluate(C, fit, val); valRes[C.name] = agg(vC);
const vD = evaluate(D, fit, val); valRes[D.name] = agg(vD);
const beats = (a) => a.log_loss < valRes.A.log_loss;
const cands = [{ s: bestB.s, a: bestB.a }, { s: C, a: valRes[C.name] }, { s: D, a: valRes[D.name] }];
if (cands.every((c) => beats(c.a))) { const E = combine([bestB.s]); const vE = evaluate(E, fit, val); valRes[E.name] = agg(vE); cands.push({ s: E, a: valRes[E.name] }); }
const winners = cands.filter((c) => beats(c.a)).sort((x, y) => x.a.log_loss - y.a.log_loss);
const selected = winners[0]?.s || null;

// ---------- retrospective test, read once ----------
const train = cases.filter((r) => r.d < VAL_END); const test = cases.filter((r) => r.d >= VAL_END);
const tA = evaluate(A, train, test);
const report = { generated_at: new Date().toISOString(), prereg: 'docs/research/TEMP_PREWINDOW_V12_PREREG.md (eaa9f41)', cases: cases.length, fit: fit.length, validation: val.length, test: test.length,
  validation: valRes, selected: selected ? selected.name : null, screen: null };
const all = {};
for (const c of cands) { const e = evaluate(c.s, train, test); all[c.s.name] = { agg: agg(e), ll_A_minus: paired(tA, e, (x) => x.ll), br_A_minus: paired(tA, e, (x) => x.br) }; if (c.s === selected) report._sel = e; }
report.test_all_candidates = { A: agg(tA), ...Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { ...v.agg, ll_A_minus_cand: v.ll_A_minus, brier_A_minus_cand: v.br_A_minus }])) };
if (selected) {
  if (selected.fit) report.selected_fit_on_train = selected.fit(train);
  const e = report._sel; delete report._sel;
  const halves = [['2025H2', (r) => r.d < TEST_SPLIT], ['2026', (r) => r.d >= TEST_SPLIT]].map(([k, f]) => { const ia = tA.filter((x) => f(x.r)); const ib = e.filter((x) => f(x.r)); return [k, { A: agg(ia), cand: agg(ib) }]; });
  const slice = (key) => { const m = new Map(); tA.forEach((x, i) => { const k = x.r[key]; if (!m.has(k)) m.set(k, { a: [], b: [] }); m.get(k).a.push(x); m.get(k).b.push(e[i]); }); return Object.fromEntries([...m].sort().map(([k, v]) => [k, { n: v.a.length, A: +mean(v.a.map((x) => x.ll)).toFixed(4), cand: +mean(v.b.map((x) => x.ll)).toFixed(4), worse_by: +(mean(v.b.map((x) => x.ll)) - mean(v.a.map((x) => x.ll))).toFixed(4) }])); };
  const st = slice('s'); const mo = slice('month');
  const ll = paired(tA, e, (x) => x.ll); const br = paired(tA, e, (x) => x.br); const ca = agg(e);
  const checks = {
    ci_log_loss_above_0: ll.ci[0] > 0, ci_brier_above_0: br.ci[0] > 0,
    each_half_both_metrics: halves.every(([, v]) => v.cand.log_loss < v.A.log_loss && v.cand.brier_2f < v.A.brier_2f),
    no_station_worse_0_05: Object.values(st).every((v) => v.worse_by <= 0.05), no_month_worse_0_03: Object.values(mo).every((v) => v.worse_by <= 0.03),
    modal_calibration_5pct: Math.abs(ca.hits - ca.expected) / ca.expected <= 0.05,
  };
  report.screen = { candidate: selected.name, passed: Object.values(checks).every(Boolean), checks, log_loss: ll, brier_2f: br, halves: Object.fromEntries(halves), by_station: st, by_month: mo,
    kalshi7: Object.fromEntries(['CLINYC', 'CLIMDW', 'CLIAUS', 'CLIMIA', 'CLIDEN', 'CLIPHL', 'CLILAX'].map((s) => [s, st[s]])) };
}
const ji = process.argv.indexOf('--json');
if (ji > 0) await writeFile(process.argv[ji + 1], JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report, null, 1));
