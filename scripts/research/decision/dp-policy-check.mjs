// decision-policy-v1 evidence: score the DRAFT policy variants on the selection window and the untouched final window.
//   node scripts/research/decision/dp-policy-check.mjs [caseDir]   -> <caseDir>/policy-check.json
// Same cluster bootstrap (by date, B = 2000) as dp-analyze.mjs. No market data.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mulberry32 } from '../../../src/rates/rates-model.js';

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-decision';
const B = 2000; const FINAL = '2026-07-01';
const jl = async (f) => (await readFile(join(DIR, f), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const r4 = (x) => (x == null || Number.isNaN(x) ? null : +x.toFixed(4));
const warm = (d) => ['06', '07', '08', '09'].includes(d.slice(5, 7));
function boot(calls, seed) {
  const ids = [...new Set(calls.map((c) => c.d))]; const ix = new Map(ids.map((d, i) => [d, i]));
  const n = new Float64Array(ids.length); const h = new Float64Array(ids.length);
  for (const c of calls) { n[ix.get(c.d)] += 1; h[ix.get(c.d)] += c.hit; }
  const rand = mulberry32(seed); const v = [];
  for (let b = 0; b < B; b += 1) { let sn = 0; let sh = 0; for (let k = 0; k < ids.length; k += 1) { const j = Math.floor(rand() * ids.length); sn += n[j]; sh += h[j]; } if (sn) v.push(sh / sn); }
  v.sort((a, b) => a - b); return [r4(v[Math.floor(0.025 * (v.length - 1))]), r4(v[Math.floor(0.975 * (v.length - 1))])];
}
function score(cases, decide, label, nSnap = 4) {
  const out = {};
  for (const [w, sub] of [['selection', cases.filter((c) => c.d < FINAL)], ['final', cases.filter((c) => c.d >= FINAL)]]) {
    const calls = []; const reasons = {};
    for (const c of sub) { const r = decide(c); if (r === 'YES' || r === 'NO') calls.push({ d: c.d, side: r, conf: r === 'YES' ? c.p : 1 - c.p, hit: (r === 'YES' ? 1 : 0) === c.y ? 1 : 0 }); else reasons[r] = (reasons[r] || 0) + 1; }
    const side = (s) => { const a = calls.filter((c) => c.side === s); return { n: a.length, hit: a.length ? r4(a.reduce((t, c) => t + c.hit, 0) / a.length) : null, mean_p: a.length ? r4(a.reduce((t, c) => t + c.conf, 0) / a.length) : null }; };
    const nd = new Set(sub.map((c) => c.d)).size;
    out[w] = { cases: sub.length, calls: calls.length, calls_per_day_per_snapshot: r4(calls.length / nd / nSnap), call_share: r4(calls.length / sub.length), hit: calls.length ? r4(calls.reduce((t, c) => t + c.hit, 0) / calls.length) : null, hit_ci: calls.length ? boot(calls, 7 + calls.length) : null, mean_p: calls.length ? r4(calls.reduce((t, c) => t + c.conf, 0) / calls.length) : null, yes: side('YES'), no: side('NO'), pass_hold_reasons: reasons };
    out[w].gap = out[w].hit != null ? r4(out[w].hit - out[w].mean_p) : null;
    out[w].meets_calibration_rule = out[w].hit_ci ? out[w].hit_ci[0] >= out[w].mean_p - 0.03 : null;
  }
  return { label, ...out };
}
const res = {};
// ---- precip
const P = await jl('precip-cases.jsonl');
const precipPolicy = ({ T = 0.70, floor = 'HIGH', nc = 0.97, warmYes = false }) => (c) => {
  if (floor === 'HIGH' && c.conf !== 'HIGH') return c.runAgeH > 12 || c.runLeadH > 54 ? 'STALE_EVIDENCE' : 'WITHIN_UNCERTAINTY_BAND';
  if (Math.max(c.p, 1 - c.p) >= nc) return 'NEAR_CERTAIN';
  if (c.p >= T) return !warmYes && warm(c.d) ? 'MODEL_NOT_VALIDATED' : 'YES';
  if (c.p <= 1 - T) return 'NO';
  return 'WITHIN_UNCERTAINTY_BAND';
};
res.precip = [
  score(P, precipPolicy({ floor: 'ALL', warmYes: true }), 'mechanical criterion B: ALL grades, T=0.70, NC 0.97, YES year-round'),
  score(P, precipPolicy({ floor: 'HIGH', warmYes: true }), 'HIGH only, T=0.70, NC 0.97, YES year-round'),
  score(P, precipPolicy({ floor: 'HIGH', warmYes: false }), 'DRAFT: HIGH only, T=0.70, NC 0.97, no YES calls Jun-Sep'),
  score(P, precipPolicy({ floor: 'HIGH', warmYes: false, T: 0.75 }), 'sensitivity: HIGH only, T=0.75, NC 0.97, no YES calls Jun-Sep'),
];
// ---- max temp (bucket contracts)
const E = await jl('temp-cases.jsonl');
const TC = E.flatMap((e) => e.b.map((x, i) => ({ d: e.d, conf: e.conf, bi: i, p: x.p, y: x.y })));
const tempPolicy = ({ T = 0.65, floor = 'HIGH', nc = 0.97, yes = false }) => (c) => {
  if (floor === 'HIGH' && c.conf !== 'HIGH') return 'WITHIN_UNCERTAINTY_BAND';
  if (Math.max(c.p, 1 - c.p) >= nc) return 'NEAR_CERTAIN';
  if (c.p >= T) return yes ? 'YES' : 'MODEL_NOT_VALIDATED';
  if (c.p <= 1 - T) return 'NO';
  return 'WITHIN_UNCERTAINTY_BAND';
};
res.temp = [score(TC, tempPolicy({}), 'mechanical criterion B: HIGH, T=0.65, NC 0.97 (NO calls only; YES never reaches 0.65 at HIGH)', 4)];
res.temp_trivial_reference = { label: 'naive: CALL NO on every bucket of every event', selection_hit: r4(TC.filter((c) => c.d < FINAL).reduce((t, c) => t + (1 - c.y), 0) / TC.filter((c) => c.d < FINAL).length), final_hit: r4(TC.filter((c) => c.d >= FINAL).reduce((t, c) => t + (1 - c.y), 0) / TC.filter((c) => c.d >= FINAL).length) };
await writeFile(join(DIR, 'policy-check.json'), JSON.stringify(res, null, 1) + '\n');
for (const fam of ['precip', 'temp']) for (const r of res[fam]) console.log(fam, r.label, '\n  sel', JSON.stringify({ calls: r.selection.calls, cpd: r.selection.calls_per_day_per_snapshot, hit: r.selection.hit, ci: r.selection.hit_ci, p: r.selection.mean_p, yes: r.selection.yes, no: r.selection.no, ok: r.selection.meets_calibration_rule }), '\n  fin', JSON.stringify({ calls: r.final.calls, cpd: r.final.calls_per_day_per_snapshot, hit: r.final.hit, ci: r.final.hit_ci, p: r.final.mean_p, yes: r.final.yes, no: r.final.no, ok: r.final.meets_calibration_rule, reasons: r.final.pass_hold_reasons }));
console.log(JSON.stringify(res.temp_trivial_reference));
