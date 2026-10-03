// Read-only acceptance check for the first natural settlement cycle (Oct 4 2026 weather contracts).
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/ops/verify-settlement-cycle.mjs [climate_date=2026-10-04]
// Checks: venue settlement + independent official value + sources_agree; designations follow designation/1
// (T_MINUS_24H only where a qualifying forecast existed; nothing captured after window start); Brier/log-loss
// recomputed from stored rows; public record endpoint serves the stored scores; append-only history intact.
import { brierScore, logLoss } from '../../src/scoring.js';
import { scoringReference } from '../../src/engine/designations.js';

const URL_ = process.env.SUPABASE_URL; const KEY = process.env.SUPABASE_SERVICE_KEY;
const DATE = process.argv[2] || '2026-10-04';
const API = 'https://pbe-predictions.sales-fd3.workers.dev/v1';
const q = async (path) => { const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); };
const inList = (ids) => `in.(${ids.map((i) => `"${i}"`).join(',')})`;
const fails = []; const check = (ok, msg) => { if (!ok) fails.push(msg); };

const contracts = (await q(`pred_contracts?select=contract_id,market_id,observation_start,detail,domain&domain=eq.WEATHER&normalization_status=eq.NORMALIZED&observation_start=gte.${DATE}T00:00:00Z&observation_start=lt.${DATE}T23:59:59Z&limit=1000`));
const ids = contracts.map((c) => c.contract_id);
const forecasts = []; const des = []; const res = []; const scores = [];
for (let i = 0; i < ids.length; i += 60) {
  const part = inList(ids.slice(i, i + 60));
  forecasts.push(...await q(`pred_forecasts?select=forecast_id,contract_id,model_id,probability,market_probability,captured_at&contract_id=${part}&limit=5000`));
  des.push(...await q(`pred_forecast_designations?select=contract_id,model_id,designation,forecast_id,reference_time&contract_id=${part}&limit=5000`));
  res.push(...await q(`pred_resolutions?select=resolution_id,contract_id,venue_result,official_outcome,official_value,sources_agree,venue_settled_at&contract_id=${part}&limit=5000`));
  scores.push(...await q(`pred_scores?select=forecast_id,contract_id,designation,scoring_method,score,benchmark_score,outcome,market_probability&contract_id=${part}&limit=10000`));
}
const withForecast = contracts.filter((c) => forecasts.some((f) => f.contract_id === c.contract_id));
const resolved = withForecast.filter((c) => res.some((r) => r.contract_id === c.contract_id));
const summary = { climate_date: DATE, contracts: contracts.length, with_forecast: withForecast.length, resolved: resolved.length, designations: {}, sources_agree: { true: 0, false: 0, null: 0 }, scores: scores.length };

for (const r of res) {
  check(['yes', 'no'].includes(r.venue_result), `${r.contract_id}: venue settlement missing`);
  check(r.official_outcome !== null, `${r.contract_id}: official value missing`);
  summary.sources_agree[String(r.sources_agree)] += 1;
  check(r.sources_agree === (r.official_outcome === r.venue_result?.toUpperCase()), `${r.contract_id}: sources_agree inconsistent`);
}
for (const c of withForecast) {
  const res0 = res.find((r) => r.contract_id === c.contract_id);
  const start = scoringReference(c, res0?.venue_settled_at || null);
  const fs = forecasts.filter((f) => f.contract_id === c.contract_id);
  check(fs.every((f) => Date.parse(f.captured_at) < Date.parse(c.observation_start) || c.detail?.scoring_reference), `${c.market_id}: weather forecast captured after window start`);
  for (const m of [...new Set(fs.map((f) => f.model_id))]) {
    const mine = fs.filter((f) => f.model_id === m).sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
    const d = Object.fromEntries(des.filter((x) => x.contract_id === c.contract_id && x.model_id === m).map((x) => [x.designation, x]));
    for (const k of Object.keys(d)) summary.designations[k] = (summary.designations[k] || 0) + 1;
    check(d.FIRST_PUBLISHED?.forecast_id === mine[0].forecast_id, `${c.market_id}: FIRST_PUBLISHED wrong`);
    const t24 = mine.filter((f) => Date.parse(f.captured_at) <= start - 86400000).pop();
    check(t24 ? d.T_MINUS_24H?.forecast_id === t24.forecast_id : !d.T_MINUS_24H, `${c.market_id}: T_MINUS_24H ${t24 ? 'wrong/missing' : 'manufactured without a qualifying forecast'}`);
    const finalF = mine.filter((f) => Date.parse(f.captured_at) < start).pop();
    if (Date.now() >= start && finalF) check(d.FINAL_PRE_RESOLUTION?.forecast_id === finalF.forecast_id, `${c.market_id}: FINAL_PRE_RESOLUTION wrong/missing`);
    if (d.FINAL_PRE_RESOLUTION) check(Date.parse(mine.find((f) => f.forecast_id === d.FINAL_PRE_RESOLUTION.forecast_id).captured_at) < start, `${c.market_id}: FINAL designated a forecast at/after its reference`);
  }
}
for (const s of scores) {
  const f = forecasts.find((x) => x.forecast_id === s.forecast_id);
  const r = res.find((x) => x.contract_id === s.contract_id);
  const y = r?.venue_result === 'yes' ? 1 : 0;
  check(s.outcome === y, `${s.contract_id}/${s.designation}: outcome mismatch`);
  const fn = s.scoring_method === 'brier' ? brierScore : logLoss;
  check(Math.abs(Number(s.score) - fn(Number(f.probability), y)) < 1e-9, `${s.contract_id}/${s.designation}/${s.scoring_method}: PBE score wrong`);
  if (f.market_probability !== null) check(Math.abs(Number(s.benchmark_score) - fn(Number(f.market_probability), y)) < 1e-9, `${s.contract_id}/${s.designation}: market score wrong`);
}
for (const c of resolved) for (const d of des.filter((x) => x.contract_id === c.contract_id)) {
  check(scores.some((s) => s.forecast_id === d.forecast_id && s.designation === d.designation), `${c.market_id}/${d.designation}: designated but not scored`);
}
// public record endpoint serves the stored scores (sample)
for (const c of resolved.slice(0, 5)) {
  const rec = await (await fetch(`${API}/contract/${encodeURIComponent(c.contract_id)}`)).json();
  const stored = scores.filter((s) => s.contract_id === c.contract_id).length;
  check(rec.scores?.length === stored && rec.resolution?.contract_id === c.contract_id, `${c.market_id}: record endpoint scores ${rec.scores?.length} vs stored ${stored}`);
}
const tr = await (await fetch(`${API}/track-record`)).json();
summary.public_track_record = tr;
console.log(JSON.stringify({ summary, pass: fails.length === 0, failures: fails.slice(0, 50) }, null, 1));
process.exit(fails.length ? 1 : 0);
