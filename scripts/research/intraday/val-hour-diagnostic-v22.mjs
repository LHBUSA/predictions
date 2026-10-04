// Validation-split diagnostic (no holdout rows are read): selected 2.2 structure vs the v2.1 structure (even hours, TXN gap),
// both fit on 2023-01..2024-12 and scored on 2025-01..06, by hour bucket and by gap source. Answers whether the holdout's
// early-morning weakness of 2.2 was visible on validation. Exact-degree log loss and 2-degree-bucket Brier.
//   node --max-old-space-size=3000 scripts/research/intraday/val-hour-diagnostic-v22.mjs [intradayDir]
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tempFinalDistribution, rangeProbability, tableHour, tempCellKeys22, gapGuidance22 } from '../../../src/weather/intraday/models.js';
import art22 from '../../../src/weather/artifacts/temp-intraday-v2.2.json' with { type: 'json' };

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-intraday';
const SUPPORT = [-10, 45];
const rows = [];
{
  const rl = createInterface({ input: createReadStream(join(DIR, 'cases-v22.csv')) }); let I = null;
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  for await (const line of rl) {
    if (!I) { I = Object.fromEntries(line.split(',').map((h, i) => [h, i])); continue; }
    const c = line.split(','); if (c[I.split] === 'test') continue;
    const om = num(c[I.obs_max]); const m6 = num(c[I.max6]);
    const r = { station: c[I.station], split: c[I.split], hh: +c[I.h], M: Math.round(m6 !== null ? Math.max(om, m6) : om), D: Math.round(num(c[I.cur])), txn: num(c[I.g]), sky_rank: num(c[I.sky_rank]), ceil: num(c[I.ceil]), wx: c[I.wx_regime], resid: num(c[I.resid]), rem_peak: num(c[I.rem_peak]), y_max: num(c[I.y_max]), pre_g: num(c[I.pre_g]) };
    if (r.rem_peak === null || r.resid === null) continue;
    rows.push(r);
  }
}
const fit = rows.filter((r) => r.split === 'fit'); const val = rows.filter((r) => r.split === 'val');
const sel = art22.selection_validation;
const ref = sel.find((s) => s.name === 'even|txn');
const models = {
  v21_structure: { res: 'even', gap: 'txn', levels: ref.levels, alphas: ref.alphas },
  v22_rg_only: { res: art22.calibration_resolution, gap: art22.gap_source, levels: sel.find((s) => s.name === `${art22.calibration_resolution}|${art22.gap_source}`).levels, alphas: sel.find((s) => s.name === `${art22.calibration_resolution}|${art22.gap_source}`).alphas },
  v22_selected: { res: art22.calibration_resolution, gap: art22.gap_source, levels: art22.levels, alphas: art22.alphas },
  hourly_txn: (() => { const s = sel.find((x) => x.name === 'hourly|txn'); return { res: 'hourly', gap: 'txn', levels: s.levels, alphas: s.alphas }; })(),
};
const bucket = (h) => (h <= 6 ? 'h01-06' : h <= 12 ? 'h07-12' : h <= 16 ? 'h13-16' : 'h17-23');
const out = {};
for (const [name, m] of Object.entries(models)) {
  const setX = (r) => ({ ...r, h: m.res === 'hourly' ? r.hh : tableHour(r.hh), g: gapGuidance22(m.gap, r) });
  const tables = Object.fromEntries(m.levels.map((l) => [l, {}]));
  for (const r0 of fit) { const r = setX(r0); const k = tempCellKeys22(r, m.levels); const e = Math.max(SUPPORT[0], Math.min(SUPPORT[1], r.y_max - Math.max(r.M, Math.round(r.g)))); for (const l of m.levels) { const cell = (tables[l][k[l]] ||= { n: 0, c: {} }); cell.n += 1; cell.c[e] = (cell.c[e] || 0) + 1; } }
  const art = { support: SUPPORT, anchor: 'max_obs_guidance', levels: m.levels, alphas: m.alphas, tables };
  const acc = {};
  for (const r0 of val) {
    const r = setX(r0); const d = tempFinalDistribution(art, r, tempCellKeys22(r, m.levels));
    const c = Math.round(r.pre_g); const bk = [[-Infinity, c - 6], [c - 5, c - 4], [c - 3, c - 2], [c - 1, c], [c + 1, c + 2], [c + 3, c + 4], [c + 5, Infinity]];
    let br = 0; for (const [lo, hi] of bk) { const p = Math.min(0.99, Math.max(0.01, rangeProbability(d, lo, hi))); const o = r.y_max >= lo && r.y_max <= hi ? 1 : 0; br += (p - o) ** 2; }
    const i = r.y_max - d.lo; const ll = -Math.log(Math.min(0.999, Math.max(0.001, i >= 0 && i < d.p.length ? d.p[i] : 0)));
    for (const g of ['ALL', bucket(r.hh)]) { const a = (acc[g] ||= { n: 0, br: 0, ll: 0 }); a.n += 1; a.br += br / bk.length; a.ll += ll; }
  }
  out[name] = Object.fromEntries(Object.entries(acc).map(([g, a]) => [g, { n: a.n, brier: +(a.br / a.n).toFixed(5), exact_ll: +(a.ll / a.n).toFixed(4) }]));
}
console.log(JSON.stringify(out, null, 1));
