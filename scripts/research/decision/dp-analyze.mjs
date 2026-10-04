// decision-policy-v1 evidence: analysis of the regenerated holdout cases (dp-wx-cases / dp-rates-cases / dp-fed-cases).
//   node scripts/research/decision/dp-analyze.mjs [caseDir]
// Writes <caseDir>/analysis.json and <caseDir>/tables.md. Read-only w.r.t. the repo. Never reads market data.
// Uncertainty: cluster bootstrap (B = 2000) resampling whole DATES (weather: climate date; rates: contract month,
// since every forecast in a month shares one realized path; fed: meeting), never individual cases.
// Threshold selection uses ONLY the selection window; the final 3 months are scored once with the chosen settings.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mulberry32 } from '../../../src/rates/rates-model.js';

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-decision';
const B = 2000;
const TS = [0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85];
const NC = 0.97; // NEAR_CERTAIN cutoff evaluated for the CALL zone (pre-stated)
const FILTERS = { HIGH: (c) => c.conf === 'HIGH', HIGH_MEDIUM: (c) => c.conf === 'HIGH' || c.conf === 'MEDIUM', ALL: () => true };
const CRIT = { calib_tol: 0.03, min_calls: 300, side_min: 50, side_tol: 0.05, band_width: 0.05, band_floor: 0.65, band_min: 100 };
// Criterion A (owner example): smallest T with n_calls >= 300 and hit-rate CI lower bound >= mean p of calls - 3 pts (+ each side with >= 50 calls within 5 pts).
// Criterion B (product meaning, stated before any band statistic was computed): A AND the weakest calls made — the band
// T <= max(p,1-p) < T+0.05 — must themselves be right >= 65% of the time at the 95% CI lower bound (band n >= 100).
const WX_FINAL_FROM = '2026-07-01'; const RATES_FINAL_FROM = '2026-07';
const jl = async (f) => (await readFile(join(DIR, f), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : +x.toFixed(4));
const q = (arr, p) => { const s = Float64Array.from(arr).sort(); const i = (s.length - 1) * p; const a = Math.floor(i); return s[a] + (s[Math.min(a + 1, s.length - 1)] - s[a]) * (i - a); };

// --- bootstrap weights over clusters (deterministic seed per label)
function weights(nClusters, seedText) {
  let h = 2166136261; for (const ch of seedText) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rand = mulberry32(h >>> 0); const W = [];
  for (let b = 0; b < B; b += 1) { const w = new Uint16Array(nClusters); for (let i = 0; i < nClusters; i += 1) w[Math.floor(rand() * nClusters)] += 1; W.push(w); }
  return W;
}
// aggregate: cases -> per-cluster sums of named quantities; returns {clusters, sums: {name: Float64Array}}
function aggregate(cases, clusterOf, fields) {
  const ids = [...new Set(cases.map(clusterOf))].sort(); const ix = new Map(ids.map((d, i) => [d, i]));
  const sums = Object.fromEntries(Object.keys(fields).map((k) => [k, new Float64Array(ids.length)]));
  for (const c of cases) { const i = ix.get(clusterOf(c)); for (const [k, fn] of Object.entries(fields)) sums[k][i] += fn(c); }
  return { ids, sums };
}
const dot = (w, a) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += w[i] * a[i]; return s; };
const tot = (a) => a.reduce((x, y) => x + y, 0);
function ci(statFn, agg, W) { const v = []; for (const w of W) { const s = statFn((k) => dot(w, agg.sums[k])); if (Number.isFinite(s)) v.push(s); } return v.length ? [r4(q(v, 0.025)), r4(q(v, 0.975))] : [null, null]; }

// --- skill block: Brier skill score + log-loss delta vs a baseline, CI by cluster bootstrap
const EPS = 1e-4; const cl = (p) => Math.min(1 - EPS, Math.max(EPS, p));
const llb = (p, y) => -(y ? Math.log(cl(p)) : Math.log(1 - cl(p)));
function skillBinary(cases, clusterOf, baseKey, W) {
  const agg = aggregate(cases, clusterOf, { n: () => 1, bm: (c) => (c.p - c.y) ** 2, bb: (c) => (c[baseKey] - c.y) ** 2, lm: (c) => llb(c.p, c.y), lb: (c) => llb(c[baseKey], c.y) });
  const S = (k) => tot(agg.sums[k]);
  const bss = (g) => 1 - g('bm') / g('bb'); const dll = (g) => (g('lb') - g('lm')) / g('n');
  const Wc = W || weights(agg.ids.length, `skill|${baseKey}|${cases.length}`);
  return { baseline: baseKey, n_cases: cases.length, n_clusters: agg.ids.length, brier_model: r4(S('bm') / S('n')), brier_baseline: r4(S('bb') / S('n')), bss: r4(bss(S)), bss_ci: ci(bss, agg, Wc), logloss_model: r4(S('lm') / S('n')), logloss_baseline: r4(S('lb') / S('n')), logloss_delta: r4(dll(S)), logloss_delta_ci: ci(dll, agg, Wc) };
}
function skillEvent(events, clusterOf, baseKey) { // mutually exclusive buckets: multiclass Brier + log loss of realized bucket
  const mb = (e, k) => e.b.reduce((s, x) => s + (x[k] - x.y) ** 2, 0); const ml = (e, k) => -Math.log(cl(e.b.find((x) => x.y === 1)[k]));
  const agg = aggregate(events, clusterOf, { n: () => 1, bm: (e) => mb(e, 'p'), bb: (e) => mb(e, baseKey), lm: (e) => ml(e, 'p'), lb: (e) => ml(e, baseKey) });
  const S = (k) => tot(agg.sums[k]); const W = weights(agg.ids.length, `ev|${baseKey}|${events.length}`);
  const bss = (g) => 1 - g('bm') / g('bb'); const dll = (g) => (g('lb') - g('lm')) / g('n');
  return { baseline: baseKey, n_events: events.length, n_clusters: agg.ids.length, mc_brier_model: r4(S('bm') / S('n')), mc_brier_baseline: r4(S('bb') / S('n')), bss: r4(bss(S)), bss_ci: ci(bss, agg, W), logloss_model: r4(S('lm') / S('n')), logloss_baseline: r4(S('lb') / S('n')), logloss_delta: r4(dll(S)), logloss_delta_ci: ci(dll, agg, W) };
}

// --- call table for a set of binary cases (p = published probability)
function callStats(cases, clusterOf, T, W, nDates, nSnap, baseKeys = []) {
  const conf = (c) => Math.max(c.p, 1 - c.p);
  const isCall = (c) => c.p >= T || c.p <= 1 - T;
  const zone = (c) => isCall(c) && conf(c) < NC;
  const hit = (c) => ((c.p >= T ? 1 : 0) === c.y ? 1 : 0);
  const F = {
    all: (c) => (isCall(c) ? 1 : 0), all_hit: (c) => (isCall(c) ? hit(c) : 0), ge95: (c) => (isCall(c) && conf(c) >= 0.95 ? 1 : 0), ge97: (c) => (isCall(c) && conf(c) >= 0.97 ? 1 : 0),
    n: (c) => (zone(c) ? 1 : 0), h: (c) => (zone(c) ? hit(c) : 0), e: (c) => (zone(c) ? conf(c) : 0), br: (c) => (zone(c) ? (c.p - c.y) ** 2 : 0),
    yn: (c) => (zone(c) && c.p >= T ? 1 : 0), yh: (c) => (zone(c) && c.p >= T ? hit(c) : 0), ye: (c) => (zone(c) && c.p >= T ? c.p : 0),
    nn: (c) => (zone(c) && c.p <= 1 - T ? 1 : 0), nh: (c) => (zone(c) && c.p <= 1 - T ? hit(c) : 0), ne: (c) => (zone(c) && c.p <= 1 - T ? 1 - c.p : 0),
    bn: (c) => (zone(c) && conf(c) < T + CRIT.band_width - 1e-9 ? 1 : 0), bh: (c) => (zone(c) && conf(c) < T + CRIT.band_width - 1e-9 ? hit(c) : 0),
  };
  for (const k of baseKeys) F[`base_${k}`] = (c) => (zone(c) ? (c[k] - c.y) ** 2 : 0);
  const agg = aggregate(cases, clusterOf, F); const S = (k) => tot(agg.sums[k]);
  const Wc = W && W.length && W[0].length === agg.ids.length ? W : weights(agg.ids.length, `calls|${cases.length}`);
  const n = S('n');
  return {
    T, n_calls_incl_near_certain: S('all'), hit_rate_incl_near_certain: S('all') ? r4(S('all_hit') / S('all')) : null,
    share_ge95: S('all') ? r4(S('ge95') / S('all')) : null, share_ge97: S('all') ? r4(S('ge97') / S('all')) : null,
    n_calls: n, calls_per_day: r4(n / nDates / nSnap), hit_rate: n ? r4(S('h') / n) : null, hit_ci: n ? ci((g) => g('h') / g('n'), agg, Wc) : [null, null],
    mean_p_called: n ? r4(S('e') / n) : null, calib_gap: n ? r4(S('h') / n - S('e') / n) : null, brier_called: n ? r4(S('br') / n) : null,
    yes: { n: S('yn'), hit: S('yn') ? r4(S('yh') / S('yn')) : null, mean_p: S('yn') ? r4(S('ye') / S('yn')) : null },
    no: { n: S('nn'), hit: S('nn') ? r4(S('nh') / S('nn')) : null, mean_p: S('nn') ? r4(S('ne') / S('nn')) : null },
    band: { from: T, to: r4(T + CRIT.band_width), n: S('bn'), hit: S('bn') ? r4(S('bh') / S('bn')) : null, hit_ci: S('bn') ? ci((g) => g('bh') / g('bn'), agg, Wc) : [null, null] },
    called_bss: Object.fromEntries(baseKeys.map((k) => [k, n ? r4(1 - S('br') / S(`base_${k}`)) : null])),
  };
}
function passes(row, withFloor) {
  if (row.n_calls < CRIT.min_calls || row.hit_ci[0] === null) return false;
  if (row.hit_ci[0] < row.mean_p_called - CRIT.calib_tol) return false;
  if (withFloor && (row.band.n < CRIT.band_min || row.band.hit_ci[0] === null || row.band.hit_ci[0] < CRIT.band_floor)) return false;
  for (const s of [row.yes, row.no]) if (s.n >= CRIT.side_min && s.hit < s.mean_p - CRIT.side_tol) return false;
  return true;
}
function tableFor(cases, clusterOf, nSnap, baseKeys = []) {
  const nDates = new Set(cases.map((c) => c.d)).size; const out = [];
  for (const [fname, f] of Object.entries(FILTERS)) {
    const sub = cases.filter(f); if (!sub.length) { out.push({ filter: fname, rows: [], n_cases: 0 }); continue; }
    const W = weights(new Set(sub.map(clusterOf)).size, `t|${fname}|${sub.length}`);
    out.push({ filter: fname, n_cases: sub.length, rows: TS.map((T) => callStats(sub, clusterOf, T, W, nDates, nSnap, baseKeys)) });
  }
  return out;
}
function select(tables, withFloor) { // most inclusive filter (ALL > HIGH_MEDIUM > HIGH) that has a qualifying T; smallest such T
  for (const fname of ['ALL', 'HIGH_MEDIUM', 'HIGH']) {
    const t = tables.find((x) => x.filter === fname); if (!t?.rows.length) continue;
    const row = t.rows.find((r) => passes(r, withFloor)); if (row) return { filter: fname, T: row.T, selection_row: row };
  }
  return null;
}
function perGroup(cases, clusterOf, keyFn, T, nSnapFn, baseKeys = []) {
  const groups = [...new Set(cases.map(keyFn))].sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));
  return groups.map((g) => { const sub = cases.filter((c) => keyFn(c) === g); return { group: g, n_cases: sub.length, ...callStats(sub, clusterOf, T, null, new Set(sub.map((c) => c.d)).size, nSnapFn(sub), baseKeys) }; });
}

function nearCertain(cases) { // calibration of the would-be NEAR_CERTAIN group (not CALLs under the draft policy)
  const conf = (c) => Math.max(c.p, 1 - c.p); const hit = (c) => ((c.p >= 0.5 ? 1 : 0) === c.y ? 1 : 0);
  return [[0.95, 0.97], [0.97, 1.01]].map(([a, b]) => { const s = cases.filter((c) => conf(c) >= a && conf(c) < b); return { band: `${a}-${b > 1 ? 1 : b}`, n: s.length, share_of_cases: r4(s.length / cases.length), mean_conf: s.length ? r4(s.reduce((t, c) => t + conf(c), 0) / s.length) : null, hit_rate: s.length ? r4(s.reduce((t, c) => t + hit(c), 0) / s.length) : null }; });
}
// ---------------- markdown helpers
const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1));
const ciS = (c) => (c?.[0] === null || !c ? '—' : `[${pct(c[0])}, ${pct(c[1])}]`);
const md = [];
function mdCallTable(title, tables) {
  md.push(`\n#### ${title}\n`);
  for (const t of tables) {
    if (!t.rows.length) { md.push(`*${t.filter}: no cases*\n`); continue; }
    md.push(`\n*Confidence filter: ${t.filter} (${t.n_cases.toLocaleString()} cases)*\n`);
    md.push('| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |');
    md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of t.rows) md.push(`| ${r.T.toFixed(2)} | ${r.n_calls} | ${r.calls_per_day?.toFixed(2)} | ${pct(r.hit_rate)} | ${ciS(r.hit_ci)} | ${pct(r.mean_p_called)} | ${r.calib_gap === null ? '—' : (r.calib_gap * 100).toFixed(1)} | ${r.brier_called ?? '—'} | ${Object.entries(r.called_bss).map(([k, v]) => `${k} ${v}`).join('; ') || '—'} | ${r.yes.n} / ${pct(r.yes.hit)} / ${pct(r.yes.mean_p)} | ${r.no.n} / ${pct(r.no.hit)} / ${pct(r.no.mean_p)} | ${r.band.n} / ${pct(r.band.hit)} / ${ciS(r.band.hit_ci)} | ${r.n_calls_incl_near_certain} | ${pct(r.share_ge95)} | ${pct(r.share_ge97)} | ${pct(r.hit_rate_incl_near_certain)} |`);
  }
}
function mdSkill(title, rows) {
  md.push(`\n#### ${title}\n`);
  md.push('| slice | baseline | n cases | n dates (clusters) | Brier/mcBrier model | baseline | BSS | BSS 95% CI | log-loss delta (base − model) | 95% CI |');
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const [slice, s] of rows) md.push(`| ${slice} | ${s.baseline} | ${s.n_cases ?? s.n_events} | ${s.n_clusters} | ${s.brier_model ?? s.mc_brier_model} | ${s.brier_baseline ?? s.mc_brier_baseline} | ${s.bss} | [${s.bss_ci.join(', ')}] | ${s.logloss_delta} | [${s.logloss_delta_ci.join(', ')}] |`);
}
function mdGroup(title, rows, label) {
  md.push(`\n#### ${title}\n`);
  md.push(`| ${label} | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |`);
  md.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) md.push(`| ${r.group} | ${r.n_cases} | ${r.n_calls} | ${r.calls_per_day?.toFixed(2)} | ${pct(r.hit_rate)} | ${ciS(r.hit_ci)} | ${pct(r.mean_p_called)} | ${r.calib_gap === null ? '—' : (r.calib_gap * 100).toFixed(1)} | ${r.yes.n}/${pct(r.yes.hit)} | ${r.no.n}/${pct(r.no.hit)} | ${pct(r.share_ge97)} |`);
}
function validated(skills, nDates) { return skills.every((s) => s.bss_ci[0] > 0) && nDates >= 180; }

const result = { generated_at: new Date().toISOString(), method: { bootstrap: `cluster bootstrap B=${B} by date (weather), month (rates), meeting (fed)`, thresholds: TS, near_certain_cutoff_evaluated: NC, criterion: CRIT, filters: Object.keys(FILTERS) }, families: {} };
const byDate = (c) => c.d;

// =============== PRECIP
{
  const cases = await jl('precip-cases.jsonl');
  const gradeMismatch = cases.filter((c) => c.conf !== c.conf_pit).length;
  const nDates = new Set(cases.map(byDate)).size;
  const sel = cases.filter((c) => c.d < WX_FINAL_FROM); const fin = cases.filter((c) => c.d >= WX_FINAL_FROM);
  const sk = { clim: skillBinary(cases, byDate, 'p_clim'), guid: skillBinary(cases, byDate, 'p_guid'), gfs_only_v10: skillBinary(cases, byDate, 'p_v10') };
  const slices = [['all / climatology', sk.clim], ['all / raw NWS PoP (NBM if available else GFS)', sk.guid], ['all / pbe-weather-precip@1.0.0 (GFS-only model)', sk.gfs_only_v10]];
  for (const g of ['HIGH', 'MEDIUM']) { const s = cases.filter((c) => c.conf === g); slices.push([`grade ${g} / climatology`, skillBinary(s, byDate, 'p_clim')], [`grade ${g} / raw PoP`, skillBinary(s, byDate, 'p_guid')]); }
  for (const h of [6, 18, 30, 42]) { const s = cases.filter((c) => c.h === h); slices.push([`lead ${h}h / climatology`, skillBinary(s, byDate, 'p_clim')], [`lead ${h}h / raw PoP`, skillBinary(s, byDate, 'p_guid')]); }
  for (const t of ['1.1.0', '1.0.0']) { const s = cases.filter((c) => c.tier === t); slices.push([`tier ${t} / climatology`, skillBinary(s, byDate, 'p_clim')], [`tier ${t} / raw PoP`, skillBinary(s, byDate, 'p_guid')]); }
  slices.push(['final 3 mo / climatology', skillBinary(fin, byDate, 'p_clim')], ['final 3 mo / raw PoP', skillBinary(fin, byDate, 'p_guid')]);
  const PB = ['p_clim', 'p_guid'];
  const tFull = tableFor(cases, byDate, 4, PB); const tSel = tableFor(sel, byDate, 4, PB);
  const choiceA = select(tSel, false); const choiceB = select(tSel, true);
  const evalFinal = (ch) => ch && { ...ch, final: callStats(fin.filter(FILTERS[ch.filter]), byDate, ch.T, null, new Set(fin.map(byDate)).size, 4, PB), same_season_2025: callStats(sel.filter((c) => c.d >= '2025-07-01' && c.d < '2025-10-01').filter(FILTERS[ch.filter]), byDate, ch.T, null, 92, 4, PB) };
  const A = evalFinal(choiceA); const Bc = evalFinal(choiceB);
  if (A) A.final.passes = passes(A.final, false); if (Bc) Bc.final.passes = passes(Bc.final, true);
  const pickT = Bc?.T ?? A?.T ?? 0.7;
  const leadSel = perGroup(sel, byDate, (c) => c.h, pickT, () => 1, PB); const leadFin = perGroup(fin, byDate, (c) => c.h, pickT, () => 1, PB);
  const gradeSel = perGroup(sel, byDate, (c) => c.conf, pickT, () => 4, PB);
  const monthAll = perGroup(cases, byDate, (c) => c.d.slice(0, 7), pickT, () => 4, PB);
  const seasonAll = perGroup(cases, byDate, (c) => (['06', '07', '08', '09'].includes(c.d.slice(5, 7)) ? 'warm Jun-Sep' : 'cool Oct-May'), pickT, () => 4, PB);
  const tierAll = perGroup(cases, byDate, (c) => `tier ${c.tier}`, pickT, () => 4, PB);
  const seasonWindow = perGroup(cases, byDate, (c) => `${c.d >= WX_FINAL_FROM ? 'final' : 'selection'} | ${['06', '07', '08', '09'].includes(c.d.slice(5, 7)) ? 'warm Jun-Sep' : 'cool Oct-May'}`, pickT, () => 4, PB);
  const nc = nearCertain(cases);
  result.families['pbe-weather-precip'] = {
    versions: ['1.1.0', '1.0.0 fallback'], validated: validated([sk.clim, sk.guid], nDates), skill: sk.clim.bss, skill_ci: sk.clim.bss_ci, skill_baseline: 'climatology (1991-2020 station rate)',
    skill_vs_raw_guidance: sk.guid.bss, skill_vs_raw_guidance_ci: sk.guid.bss_ci, n_cases: cases.length, n_dates: nDates,
    holdout: { from: '2025-07-01', to: '2026-09-30', selection_window: ['2025-07-01', '2026-06-30'], final_window: ['2026-07-01', '2026-09-30'], selection_cases: sel.length, final_cases: fin.length },
    grade_distribution: Object.fromEntries(['HIGH', 'MEDIUM', 'LOW'].map((g) => [g, cases.filter((c) => c.conf === g).length])), grade_production_vs_point_in_time_mismatches: gradeMismatch,
    tier_distribution: { '1.1.0': cases.filter((c) => c.tier === '1.1.0').length, '1.0.0': cases.filter((c) => c.tier === '1.0.0').length },
    skill_slices: slices.map(([k, v]) => ({ slice: k, ...v })), selection: { criterion_A_calibration_only: A, criterion_B_with_abs_floor: Bc },
    tables: [{ name: 'full_holdout', tables: tFull }, { name: 'selection_window', tables: tSel }], by_lead_selection: leadSel, by_lead_final: leadFin, by_grade_selection: gradeSel, by_month_full: monthAll, by_season_full: seasonAll, by_tier_full: tierAll, by_window_season: seasonWindow, near_certain_calibration: nc,
  };
  md.push('\n## PRECIP (pbe-weather-precip@1.1.0 / 1.0.0 fallback)\n');
  mdSkill('Skill (holdout 2025-07-01..2026-09-30)', slices);
  mdCallTable('Calls — FULL holdout (pooled over leads 6/18/30/42 h; calls/day is per lead snapshot)', tFull);
  mdCallTable('Calls — SELECTION window 2025-07-01..2026-06-30', tSel);
  mdGroup(`By lead — selection window, T=${pickT}, ALL grades`, leadSel, 'lead h'); mdGroup(`By lead — final 3 months, T=${pickT}`, leadFin, 'lead h');
  mdGroup(`By grade — selection window, T=${pickT}`, gradeSel, 'grade'); mdGroup(`By month — full holdout, T=${pickT}`, monthAll, 'month');
  mdGroup(`By season — full holdout, T=${pickT}`, seasonAll, 'season'); mdGroup(`By window × season — T=${pickT} (YES/NO split shows the warm-season YES bias)`, seasonWindow, 'window | season');
  md.push(`
Near-certain calibration (precip): ${JSON.stringify(nc)}
`); mdGroup(`By model tier — full holdout, T=${pickT}`, tierAll, 'tier');
}

// =============== MAX TEMP
{
  const events = await jl('temp-cases.jsonl');
  const nDates = new Set(events.map(byDate)).size;
  const flat = (evs) => evs.flatMap((e) => e.b.map((x, i) => ({ d: e.d, h: e.h, st: e.st, conf: e.conf, k7: e.k7, dis: e.disagree, bi: i, p: x.p, y: x.y, p_norm: x.p_norm, p_clim: x.p_clim })));
  const TB = ['p_clim', 'p_norm'];
  const all = flat(events).filter((c) => c.p_clim !== null);
  const sel = all.filter((c) => c.d < WX_FINAL_FROM); const fin = all.filter((c) => c.d >= WX_FINAL_FROM);
  const evAll = events.filter((e) => e.b.every((x) => x.p_clim !== null));
  const ske = { clim: skillEvent(evAll, byDate, 'p_clim'), norm: skillEvent(evAll, byDate, 'p_norm') };
  const skb = { clim: skillBinary(all, byDate, 'p_clim'), norm: skillBinary(all, byDate, 'p_norm') };
  const slices = [['events / climatology Normal(1991-2020)', ske.clim], ['events / Normal error model (same guidance+tables)', ske.norm], ['bucket contracts / climatology', skb.clim], ['bucket contracts / Normal', skb.norm]];
  for (const g of ['HIGH', 'MEDIUM']) { const s = evAll.filter((e) => e.conf === g); slices.push([`events grade ${g} / climatology`, skillEvent(s, byDate, 'p_clim')], [`events grade ${g} / Normal`, skillEvent(s, byDate, 'p_norm')]); }
  for (const h of [6, 18, 30, 42]) { const s = evAll.filter((e) => e.h === h); slices.push([`events lead ${h}h / climatology`, skillEvent(s, byDate, 'p_clim')], [`events lead ${h}h / Normal`, skillEvent(s, byDate, 'p_norm')]); }
  const k7 = evAll.filter((e) => e.k7); slices.push(['events Kalshi-7 stations / climatology', skillEvent(k7, byDate, 'p_clim')], ['events Kalshi-7 stations / Normal', skillEvent(k7, byDate, 'p_norm')]);
  const finEv = evAll.filter((e) => e.d >= WX_FINAL_FROM); slices.push(['events final 3 mo / climatology', skillEvent(finEv, byDate, 'p_clim')], ['events final 3 mo / Normal', skillEvent(finEv, byDate, 'p_norm')]);
  // contract-level call tables (6 bucket contracts per event; calls/day per lead snapshot per station-day ×6)
  const tFull = tableFor(all, byDate, 4, TB); const tSel = tableFor(sel, byDate, 4, TB);
  const choiceA = select(tSel, false); const choiceB = select(tSel, true);
  const evalFinal = (ch) => ch && { ...ch, final: callStats(fin.filter(FILTERS[ch.filter]), byDate, ch.T, null, new Set(fin.map(byDate)).size, 4, TB) };
  const A = evalFinal(choiceA); const Bc = evalFinal(choiceB);
  if (A) A.final.passes = passes(A.final, false); if (Bc) Bc.final.passes = passes(Bc.final, true);
  // bucket-type breakdown of contract-level calls at T
  const pickT = Bc?.T ?? A?.T ?? 0.7;
  const pickF = Bc?.filter ?? A?.filter ?? 'ALL';
  const byBucket = perGroup(sel.filter(FILTERS[pickF]), byDate, (c) => ['tail_low', 'b1', 'b2', 'b3', 'b4', 'tail_high'][c.bi], pickT, () => 4, TB);
  const byDisagree = perGroup(all, byDate, (c) => (c.dis ? 'NBM-GFS disagree >=4F' : 'agree <4F'), pickT, () => 4, TB);
  // event-level: only the modal bucket may be CALLED YES
  const modal = (evs) => evs.map((e) => { let m = 0; e.b.forEach((x, i) => { if (x.p > e.b[m].p) m = i; }); return { d: e.d, h: e.h, conf: e.conf, k7: e.k7, p: e.b[m].p, y: e.b[m].y, mi: m }; });
  const mAll = modal(evAll); const mSel = mAll.filter((c) => c.d < WX_FINAL_FROM); const mFin = mAll.filter((c) => c.d >= WX_FINAL_FROM);
  const modalOverall = { n_events: mAll.length, modal_hit_rate: r4(mAll.reduce((s, c) => s + c.y, 0) / mAll.length), mean_modal_p: r4(mAll.reduce((s, c) => s + c.p, 0) / mAll.length), modal_p_quantiles: [0.1, 0.5, 0.9, 0.99].map((x) => r4(q(mAll.map((c) => c.p), x))), modal_index_counts: [0, 1, 2, 3, 4, 5].map((i) => mAll.filter((c) => c.mi === i).length) };
  const modalYes = (cs, T, filt) => { const sub = cs.filter(FILTERS[filt]); const calls = sub.filter((c) => c.p >= T); const agg = aggregate(calls.length ? calls : [{ d: 'x', y: 0, p: 0 }], byDate, { n: () => 1, h: (c) => c.y, e: (c) => c.p }); const W = weights(agg.ids.length, `modal|${T}|${filt}|${calls.length}`); return { T, filter: filt, n_events: sub.length, n_calls: calls.length, calls_per_day: r4(calls.length / new Set(sub.map(byDate)).size / 4), hit_rate: calls.length ? r4(calls.reduce((s, c) => s + c.y, 0) / calls.length) : null, hit_ci: calls.length ? ci((g) => g('h') / g('n'), agg, W) : [null, null], mean_p: calls.length ? r4(calls.reduce((s, c) => s + c.p, 0) / calls.length) : null }; };
  const modalT = [0.30, 0.35, 0.40, 0.45, 0.50, ...TS];
  const modalTables = { full: Object.keys(FILTERS).flatMap((f) => modalT.map((T) => modalYes(mAll, T, f))), selection: Object.keys(FILTERS).flatMap((f) => modalT.map((T) => modalYes(mSel, T, f))), final: Object.keys(FILTERS).flatMap((f) => modalT.map((T) => modalYes(mFin, T, f))) };
  const leadSel = perGroup(sel.filter(FILTERS[pickF]), byDate, (c) => c.h, pickT, () => 1, TB); const leadFin = perGroup(fin.filter(FILTERS[pickF]), byDate, (c) => c.h, pickT, () => 1, TB);
  result.families['pbe-weather-maxtemp'] = {
    versions: ['1.1.0 (NBM; every holdout case had a fresh NBM day max)', '1.0.0 fallback'], validated: validated([ske.clim, ske.norm], nDates), skill: ske.clim.bss, skill_ci: ske.clim.bss_ci, skill_baseline: 'climatology Normal(1991-2020 mean, sd) — event multiclass Brier',
    skill_vs_normal_error_model: ske.norm.bss, skill_vs_normal_error_model_ci: ske.norm.bss_ci, n_cases: evAll.length, n_bucket_contracts: all.length, n_dates: nDates,
    holdout: { from: '2025-07-01', to: '2026-09-30', selection_window: ['2025-07-01', '2026-06-30'], final_window: ['2026-07-01', '2026-09-30'] },
    grade_distribution: Object.fromEntries(['HIGH', 'MEDIUM', 'LOW'].map((g) => [g, evAll.filter((c) => c.conf === g).length])),
    skill_slices: slices.map(([k, v]) => ({ slice: k, ...v })), selection: { criterion_A_calibration_only: A, criterion_B_with_abs_floor: Bc },
    tables: [{ name: 'contract_level_full', tables: tFull }, { name: 'contract_level_selection', tables: tSel }], by_bucket_selection: byBucket, by_disagreement_full: byDisagree, near_certain_calibration: nearCertain(all), by_lead_selection: leadSel, by_lead_final: leadFin,
    event_level_modal: { overall: modalOverall, tables: modalTables },
  };
  md.push('\n## MAX TEMP (pbe-weather-maxtemp@1.1.0; synthetic Kalshi-shape 6-bucket events)\n');
  mdSkill('Skill (holdout 2025-07-01..2026-09-30)', slices);
  mdCallTable('Contract-level calls — FULL holdout (each of 6 buckets is a binary contract)', tFull);
  mdCallTable('Contract-level calls — SELECTION window', tSel);
  mdGroup(`Contract-level calls by bucket position — selection, ${pickF}, T=${pickT}`, byBucket, 'bucket'); mdGroup(`Contract-level calls by NBM/GFS agreement — full holdout, ALL grades, T=${pickT}`, byDisagree, 'guidance');
  mdGroup(`By lead — selection, ${pickF}, T=${pickT}`, leadSel, 'lead h'); mdGroup(`By lead — final 3 months, ${pickF}, T=${pickT}`, leadFin, 'lead h');
  md.push(`\n#### Event-level: modal bucket only\n\nOverall: ${JSON.stringify(modalOverall)}\n`);
  for (const [nm, rows] of Object.entries(modalTables)) {
    md.push(`\n*${nm}*\n\n| filter | T | events | YES calls | calls/day/snapshot | hit % | hit CI | mean p |\n|---|---|---|---|---|---|---|---|`);
    for (const r of rows) md.push(`| ${r.filter} | ${r.T.toFixed(2)} | ${r.n_events} | ${r.n_calls} | ${r.calls_per_day} | ${pct(r.hit_rate)} | ${ciS(r.hit_ci)} | ${pct(r.mean_p)} |`);
  }
}

// =============== RATES
{
  const cases = await jl('rates-cases.jsonl');
  const byMonth = (c) => c.month;
  const nDates = new Set(cases.map(byDate)).size; const nMonths = new Set(cases.map(byMonth)).size;
  const sel = cases.filter((c) => c.month < RATES_FINAL_FROM); const fin = cases.filter((c) => c.month >= RATES_FINAL_FROM);
  const sk = { gauss: skillBinary(cases, byMonth, 'p_gauss'), clim: skillBinary(cases, byMonth, 'p_clim') };
  const slices = [['all / Gaussian trailing-vol (named baseline)', sk.gauss], ['all / training climatology (dir × offset × k)', sk.clim]];
  for (const k of [0, 3, 8, 13]) { const s = cases.filter((c) => c.k === k); slices.push([`k=${k} / Gaussian`, skillBinary(s, byMonth, 'p_gauss')], [`k=${k} / climatology`, skillBinary(s, byMonth, 'p_clim')]); }
  for (const t of [5, 7, 10, 30]) { const s = cases.filter((c) => c.tenor === t); slices.push([`${t}Y / Gaussian`, skillBinary(s, byMonth, 'p_gauss')], [`${t}Y / climatology`, skillBinary(s, byMonth, 'p_clim')]); }
  slices.push(['2023-01..2026-09 / Gaussian', skillBinary(cases.filter((c) => c.month >= '2023-01'), byMonth, 'p_gauss')], ['2023-01..2026-09 / climatology', skillBinary(cases.filter((c) => c.month >= '2023-01'), byMonth, 'p_clim')]);
  // calls/day: forecast snapshots are 4 per month per contract set -> report per forecast date (cases / distinct forecast dates)
  const RB = ['p_clim', 'p_gauss'];
  const tFull = tableFor(cases, byMonth, 1, RB).map((t) => ({ ...t, note: 'calls_per_day here = calls per forecast date (all tenors and strikes)' }));
  const tSel = tableFor(sel, byMonth, 1, RB);
  const choiceA = select(tSel, false); const choiceB = select(tSel, true);
  const evalFinal = (ch) => ch && { ...ch, final: callStats(fin, byMonth, ch.T, null, new Set(fin.map(byDate)).size, 1, RB) };
  const A = evalFinal(choiceA); const Bc = evalFinal(choiceB);
  if (A) A.final.passes = passes(A.final, false); if (Bc) Bc.final.passes = passes(Bc.final, true);
  const pickT = Bc?.T ?? A?.T ?? 0.7;
  const kSel = perGroup(sel, byMonth, (c) => c.k, pickT, () => 1, RB); const offSel = perGroup(sel, byMonth, (c) => c.off, pickT, () => 1, RB);
  const yearAll = perGroup(cases, byMonth, (c) => c.month.slice(0, 4), pickT, () => 1, RB);
  result.families['pbe-rates-path'] = {
    versions: ['1.0.0'], validated: validated([sk.gauss, sk.clim], nDates), skill: sk.gauss.bss, skill_ci: sk.gauss.bss_ci, skill_baseline: 'Gaussian trailing-250-day volatility (artifact baseline)',
    skill_vs_climatology: sk.clim.bss, skill_vs_climatology_ci: sk.clim.bss_ci, n_cases: cases.length, n_dates: nDates, n_months_clusters: nMonths,
    holdout: { from: '2018-01', to: '2026-09', selection_window: ['2018-01', '2026-06'], final_window: ['2026-07', '2026-09'], note: 'final window = 3 month-clusters only; not statistically informative' },
    grade_distribution: { HIGH: cases.length, note: 'rates-quality/1 is staleness only; replay forecasts are made right after publication so every case is HIGH' },
    skill_slices: slices.map(([k, v]) => ({ slice: k, ...v })), selection: { criterion_A_calibration_only: A, criterion_B_with_abs_floor: Bc },
    tables: [{ name: 'full_holdout', tables: tFull }, { name: 'selection_window', tables: tSel }], by_k_selection: kSel, near_certain_calibration: nearCertain(cases), by_offset_selection: offSel, by_year_full: yearAll,
  };
  md.push('\n## RATES (pbe-rates-path@1.0.0; synthetic monthly path contracts, 4 tenors)\n');
  mdSkill('Skill (holdout 2018-01..2026-09; clusters = contract months)', slices);
  mdCallTable('Calls — FULL holdout (calls/day = per forecast date, all tenors/strikes; only HIGH grade exists)', tFull.filter((t) => t.filter === 'ALL'));
  mdCallTable('Calls — SELECTION window 2018-01..2026-06', tSel.filter((t) => t.filter === 'ALL'));
  mdGroup(`By forecast point k — selection, T=${pickT}`, kSel, 'k'); mdGroup(`By strike offset — selection, T=${pickT}`, offSel, 'offset'); mdGroup(`By year — full, T=${pickT}`, yearAll, 'year');
}

// =============== FED (SHADOW)
{
  const cases = await jl('fed-cases.jsonl');
  const mb = (c, k) => c[k].reduce((s, v, i) => s + (v - (i === c.y ? 1 : 0)) ** 2, 0); const ml = (c, k) => -Math.log(Math.max(1e-6, c[k][c.y]));
  const res = {};
  for (const base of ['p_clim', 'p_persist']) {
    const agg = aggregate(cases, byDate, { n: () => 1, bm: (c) => mb(c, 'p'), bb: (c) => mb(c, base), lm: (c) => ml(c, 'p'), lb: (c) => ml(c, base) });
    const S = (k) => tot(agg.sums[k]); const W = weights(agg.ids.length, `fed|${base}`);
    const bss = (g) => 1 - g('bm') / g('bb'); const dll = (g) => (g('lb') - g('lm')) / g('n');
    res[base] = { baseline: base, n_cases: cases.length, n_clusters: agg.ids.length, mc_brier_model: r4(S('bm') / S('n')), mc_brier_baseline: r4(S('bb') / S('n')), bss: r4(bss(S)), bss_ci: ci(bss, agg, W), logloss_model: r4(S('lm') / S('n')), logloss_baseline: r4(S('lb') / S('n')), logloss_delta: r4(dll(S)), logloss_delta_ci: ci(dll, agg, W) };
  }
  const top = cases.map((c) => { const m = c.p.indexOf(Math.max(...c.p)); return { d: c.d, p: c.p[m], y: m === c.y ? 1 : 0 }; });
  const hold = cases.filter((c) => c.y === 2).length / cases.length;
  const calls = [0.5, 0.6, 0.7, 0.8].map((T) => { const s = top.filter((c) => c.p >= T); return { T, n_calls: s.length, meetings: new Set(s.map((c) => c.d)).size, hit_rate: s.length ? r4(s.reduce((a, c) => a + c.y, 0) / s.length) : null, mean_p: s.length ? r4(s.reduce((a, c) => a + c.p, 0) / s.length) : null }; });
  const nDates = new Set(cases.map(byDate)).size;
  result.families['pbe-fed-decision'] = {
    versions: ['1.0.0 SHADOW'], validated: false, validated_reason: 'n_dates (meetings) < 180 and top-outcome accuracy below always-hold; MODEL_NOT_VALIDATED',
    skill: res.p_clim.bss, skill_ci: res.p_clim.bss_ci, skill_baseline: 'training climatology (multiclass Brier)', skill_vs_persistence: res.p_persist.bss, skill_vs_persistence_ci: res.p_persist.bss_ci,
    n_cases: cases.length, n_dates: nDates, top_outcome_accuracy: r4(top.reduce((a, c) => a + c.y, 0) / top.length), always_hold_accuracy: r4(hold),
    recommended: { threshold: null, confidence_floor: null, near_certain_cutoff: null, state: 'PASS:MODEL_NOT_VALIDATED' }, tables: [{ name: 'top_outcome_calls_full_holdout', rows: calls }],
  };
  md.push('\n## FED (pbe-fed-decision@1.0.0 SHADOW)\n');
  mdSkill('Skill (2016-2026 meetings; clusters = meetings)', [['all / climatology', res.p_clim], ['all / persistence', res.p_persist]]);
  md.push(`\nTop-outcome accuracy ${pct(result.families['pbe-fed-decision'].top_outcome_accuracy)}% vs always-hold ${pct(hold)}%.\n\n| T (top outcome p ≥ T) | calls | meetings | hit % | mean p |\n|---|---|---|---|---|`);
  for (const r of calls) md.push(`| ${r.T} | ${r.n_calls} | ${r.meetings} | ${pct(r.hit_rate)} | ${pct(r.mean_p)} |`);
}

await writeFile(join(DIR, 'analysis.json'), JSON.stringify(result, null, 1) + '\n');
await writeFile(join(DIR, 'tables.md'), md.join('\n') + '\n');
for (const [id, f] of Object.entries(result.families)) console.log(id, 'validated', f.validated, 'skill', f.skill, f.skill_ci, 'n', f.n_cases, 'dates', f.n_dates, 'A', f.selection?.criterion_A_calibration_only ? [f.selection.criterion_A_calibration_only.filter, f.selection.criterion_A_calibration_only.T] : null, 'B', f.selection?.criterion_B_with_abs_floor ? [f.selection.criterion_B_with_abs_floor.filter, f.selection.criterion_B_with_abs_floor.T] : null);
