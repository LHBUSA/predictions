// Issue #64 Stage 1: forensic audit of every settled MAX_TEMP_BUCKET event, read-only.
//   node scripts/research/temp-audit/audit-cohort.mjs <export-dir> [--json out.json]
// <export-dir> holds the JSON row exports made by export.ps1 (SELECT-only, READ ONLY transaction): ct rs ds fc vs ids sh fall.
// Nothing here writes to any database or changes a forecast, settlement or score.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderBuckets, bucketIndexOf, eventScores, temperatureSkillSummary, clusterBootstrap, marketDistribution, hitTail } from '../../../src/weather/temp-skill.js';
import { residualTable, bucketProbability } from '../../../src/weather/temp-model.js';
import { shadowEvaluationReport } from '../../../src/weather/intraday/shadow.js';
import tempV1 from '../../../src/weather/artifacts/temp-v1.json' with { type: 'json' };
import tempV11 from '../../../src/weather/artifacts/temp-nbm-v1.1.json' with { type: 'json' };

const DIR = process.argv[2];
if (!DIR) { console.error('usage: audit-cohort.mjs <export-dir> [--json out.json]'); process.exit(2); }
const L = (n) => JSON.parse(readFileSync(join(DIR, `${n}.json`), 'utf8').replace(/^﻿/, ''));
const [ct, rs, ds, fc, vs, ids, sh, fall] = ['ct', 'rs', 'ds', 'fc', 'vs', 'ids', 'sh', 'fall'].map(L);
const H = 3600000; const T = (x) => Date.parse(x);
const group = (arr, k) => { const m = new Map(); for (const x of arr) { const key = k(x); if (!m.has(key)) m.set(key, []); m.get(key).push(x); } return m; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (x, d = 3) => (x === null || x === undefined ? null : +Number(x).toFixed(d));
const evid = (f, label) => f.explanation?.evidence?.find((e) => String(e.label).startsWith(label)) || null;

const fcById = new Map(fc.map((f) => [f.forecast_id, f]));
const resBy = new Map(rs.map((r) => [r.contract_id, r]));
const finBy = new Map(ds.filter((d) => d.designation === 'FINAL_PRE_RESOLUTION').map((d) => [d.contract_id, d]));
const scoreBy = group(L('sc'), (s) => `${s.contract_id}|${s.designation}|${s.scoring_method}`);
const vsBy = group(vs, (v) => v.contract_id); for (const a of vsBy.values()) a.sort((x, y) => T(x.captured_at) - T(y.captured_at));
const quoteAt = (cid, t) => { const a = vsBy.get(cid) || []; let q = null; for (const v of a) { if (T(v.captured_at) <= t) q = v; else break; } return q; };

// ---------- 1. cohort + identity checks ----------
const events = []; const excluded = [];
for (const [eventId, cs] of group(ct, (c) => c.event_id)) {
  const ob = orderBuckets(cs);
  const res = cs.map((c) => resBy.get(c.contract_id));
  if (res.every((r) => !r)) { excluded.push({ event_id: eventId, reason: 'NOT_SETTLED', date: cs[0].detail?.climate_date }); continue; }
  const checks = [];
  if (!ob.ok) checks.push(ob.reason);
  const buckets = ob.buckets; const ranges = ob.ranges || [];
  const r = buckets.map((c) => resBy.get(c.contract_id));
  if (r.some((x) => !x)) checks.push('INCOMPLETE_SETTLEMENT');
  const winners = r.filter((x) => x?.venue_result === 'yes').length;
  if (winners !== 1) checks.push('NOT_ONE_WINNER');
  const vals = [...new Set(r.filter(Boolean).map((x) => Number(x.official_value)))];
  if (vals.length !== 1) checks.push('OFFICIAL_VALUE_DIFFERS');
  if (r.some((x) => x && (x.sources_agree !== true || x.correction_of || x.venue_result !== String(x.official_outcome).toLowerCase()))) checks.push('SOURCE_DISAGREEMENT_OR_CORRECTION');
  const win = r.findIndex((x) => x?.venue_result === 'yes');
  if (vals.length === 1 && win >= 0 && bucketIndexOf(ranges, vals[0]) !== win) checks.push('WINNER_NOT_CONTAINING_OFFICIAL_VALUE');
  const d = buckets.map((c) => finBy.get(c.contract_id));
  if (d.some((x) => !x)) checks.push('INCOMPLETE_FINAL_DESIGNATIONS');
  const f = d.map((x) => (x ? fcById.get(x.forecast_id) : null));
  if (f.some((x) => !x)) checks.push('DESIGNATED_FORECAST_MISSING');
  const c0 = buckets[0]; const start = T(c0.observation_start);
  if (f.every(Boolean)) {
    if (new Set(f.map((x) => x.captured_at)).size !== 1) checks.push('MIXED_CAPTURE_TIMES');
    if (f.some((x, i) => x.contract_id !== buckets[i].contract_id)) checks.push('FORECAST_CONTRACT_MISMATCH');
    if (f.some((x) => !(T(x.captured_at) < start))) checks.push('FORECAST_NOT_PRE_WINDOW');
    if (f.some((x) => !(T(x.data_cutoff_at) <= T(x.captured_at)))) checks.push('CUTOFF_AFTER_CAPTURE');
    if (f.some((x) => x.model_state === 'SHADOW')) checks.push('SHADOW_FORECAST');
    if (d.some((x) => T(x.reference_time) !== start)) checks.push('REFERENCE_NOT_WINDOW_START');
    // The latest pre-window forecast must be the designated one (no retrospective substitution).
    for (const [i, c] of buckets.entries()) {
      const later = fall.filter((x) => x.contract_id === c.contract_id && x.model_id === 'pbe-weather-maxtemp' && T(x.captured_at) < start && T(x.captured_at) > T(f[i].captured_at));
      if (later.length) { checks.push('NEWER_PRE_WINDOW_FORECAST_EXISTS'); break; }
    }
    // Scores restate the designated forecast and the settled outcome.
    for (const [i, c] of buckets.entries()) {
      const s = (scoreBy.get(`${c.contract_id}|FINAL_PRE_RESOLUTION|brier`) || [])[0];
      if (!s || s.forecast_id !== f[i].forecast_id || Number(s.outcome) !== (i === win ? 1 : 0)) { checks.push('SCORE_ROW_MISMATCH'); break; }
    }
  }
  if (new Set(buckets.map((c) => c.station_id)).size !== 1 || new Set(buckets.map((c) => c.observation_start)).size !== 1) checks.push('MIXED_STATION_OR_WINDOW');
  const off = c0.detail?.lst_offset_hours; const date = c0.detail?.climate_date;
  if (!(Number.isFinite(off) && T(c0.observation_start) === T(`${date}T00:00:00Z`) - off * H && T(c0.observation_end) - start === 24 * H)) checks.push('WINDOW_NOT_LOCAL_STANDARD_DAY');
  if (checks.length) { excluded.push({ event_id: eventId, reason: [...new Set(checks)].join(','), date }); continue; }

  const probs = f.map((x) => Number(x.probability));
  const e0 = f[0];
  const cap = T(e0.captured_at);
  const q = buckets.map((c, i) => { const v = quoteAt(c.contract_id, cap); const stored = f[i].market_probability === null ? null : Number(f[i].market_probability);
    return { mid: stored, bid: v?.bid ?? null, ask: v?.ask ?? null, status: v?.market_status ?? null, at: v?.captured_at ?? null }; });
  const strictMarket = q.every((x) => x.mid !== null) ? q.map((x) => x.mid) : null;
  const md = q.every((x) => x.status === 'active') ? marketDistribution(q) : null;
  const tbl = e0.explanation?.error_table || {};
  const nbm = evid(e0, 'National Blend')?.value ?? null; const gfs = evid(e0, 'GFS MOS')?.value ?? null; const nws = evid(e0, 'Official NWS')?.value ?? null;
  const normal = evid(e0, 'Normal high'); const spread = Number(String(normal?.detail || '').match(/±([\d.]+)/)?.[1]);
  const y = vals[0];
  events.push({
    event_id: eventId, station: c0.station_id, date, city: c0.detail?.city_label, timezone: c0.timezone, lst_offset_hours: off,
    observation_start: c0.observation_start, settlement: { authority: c0.resolution_authority, official_value: y, official_source: r[win].official_source, rounding: c0.rounding_rule },
    forecast: { captured_at: e0.captured_at, data_cutoff_at: e0.data_cutoff_at, model_version: e0.model_version, model_tier: e0.explanation?.model_tier,
      lead_h_capture: r2((start - cap) / H, 2), lead_h_cutoff: r2((start - T(e0.data_cutoff_at)) / H, 2), run_age_h: e0.explanation?.run_age_h,
      confidence: e0.confidence, guidance_disagreement: e0.explanation?.guidance_disagreement, nbm, gfs, nws, error_table: tbl,
      nbm_detail: evid(e0, 'National Blend')?.detail || null },
    buckets: buckets.map((c, i) => ({ label: c.outcome_label, range: ranges[i].map((v) => (Number.isFinite(v) ? v : null)), pbe: probs[i], pbe_raw: e0.explanation ? Number(f[i].explanation?.raw_probability) : null, market_mid: q[i].mid, bid: q[i].bid, ask: q[i].ask, won: i === win })),
    win, ranges, probs, strictMarket, market: md, normal: normal?.value ?? null, spread: Number.isFinite(spread) ? spread : null, y,
  });
}
events.sort((a, b) => a.date.localeCompare(b.date) || a.station.localeCompare(b.station));

// ---------- 2. PBE vs market (event level) ----------
const scored = events.map((e) => ({ date: e.date, station: e.station, pbe: eventScores(e.probs, e.win),
  market: e.market ? eventScores(e.market.probs, e.win) : null, marketStrict: e.strictMarket ? eventScores(e.strictMarket, e.win) : null }));
const summary = temperatureSkillSummary(scored);
const strictSummary = temperatureSkillSummary(scored.map((s) => ({ ...s, market: s.marketStrict })));

// ---------- 3. baselines on the same 42 events and the same cutoff inputs ----------
const discrete = (dist, ranges) => ranges.map(([lo, hi]) => { let p = 0; for (const [v, w] of dist) if (v >= lo && v <= hi) p += w; return p; });
const normalDist = (mu, sd) => { const out = []; const pdf = (x) => Math.exp(-0.5 * ((x - mu) / sd) ** 2); let s = 0; for (let v = Math.floor(mu - 8 * sd); v <= Math.ceil(mu + 8 * sd); v += 1) { const w = pdf(v); out.push([v, w]); s += w; } return out.map(([v, w]) => [v, w / s]); };
const empirical = (artifact, station, leadH, g, ranges) => { const t = residualTable(artifact, station, leadH); return ranges.map(([lo, hi]) => bucketProbability(artifact, t, g, { comparator: 'between', low: lo === -Infinity ? -999 : lo, high: hi === Infinity ? 999 : hi })); };
const leadOf = (e) => ({ le30h: 24, le54h: 48, gt54h: 60 })[e.forecast.error_table.bucket] ?? 24; // the bucket the published row used
const point = (g, ranges) => ranges.map(([lo, hi]) => (Math.round(g) >= lo && Math.round(g) <= hi ? 1 : 0));
const baselines = {
  'pbe v1.1 (published)': (e) => e.probs,
  'v1.1 recomputed from stored inputs': (e) => empirical(tempV11, e.station, leadOf(e), e.forecast.nbm, e.ranges),
  'v1.0 GFS MOS empirical (temp-v1)': (e) => (e.forecast.gfs === null ? null : empirical(tempV1, e.station, leadOf(e), e.forecast.gfs, e.ranges)),
  'normal error on NBM (table mean/sd)': (e) => discrete(normalDist(e.forecast.nbm + (e.forecast.error_table.mean ?? 0), e.forecast.error_table.sd ?? 3), e.ranges),
  'climatology 1991-2020 normal': (e) => (e.normal === null || !e.spread ? null : discrete(normalDist(e.normal, e.spread), e.ranges)),
};
const baselineRows = {};
for (const [name, fn] of Object.entries(baselines)) {
  const rows = events.map((e) => { const p = fn(e); return p ? { date: e.date, station: e.station, s: eventScores(p, e.win), base: eventScores(e.probs, e.win) } : null; }).filter(Boolean);
  const ps = rows.map((x) => x.s.p_modal); const hits = rows.reduce((a, x) => a + x.s.hit, 0);
  baselineRows[name] = { events: rows.length, hits, expected: r2(ps.reduce((a, b) => a + b, 0), 2), log_loss: r2(mean(rows.map((x) => x.s.log_loss))), brier: r2(mean(rows.map((x) => x.s.brier))), rps: r2(mean(rows.map((x) => x.s.rps))),
    pbe_minus_this_log_loss: clusterBootstrap(rows.map((x) => ({ cluster: x.date, a: x.base.log_loss, b: x.s.log_loss }))) };
}
const pointHits = Object.fromEntries(['nbm', 'gfs', 'nws'].map((k) => [k, events.filter((e) => e.forecast[k] !== null).reduce((a, e) => a + (point(e.forecast[k], e.ranges)[e.win] ? 1 : 0), 0)]));
pointHits.nbm_gfs_mean = events.reduce((a, e) => a + (point((e.forecast.nbm + e.forecast.gfs) / 2, e.ranges)[e.win] ? 1 : 0), 0);

// ---------- 4. error diagnostics ----------
const err = (e, k) => (e.forecast[k] === null ? null : e.y - e.forecast[k]);
const errStats = (list, k) => { const v = list.map((e) => err(e, k)).filter((x) => x !== null); return { n: v.length, mean_signed: r2(mean(v), 2), mae: r2(mean(v.map(Math.abs)), 2), rmse: r2(Math.sqrt(mean(v.map((x) => x * x))), 2) }; };
const zOf = (e) => (err(e, 'nbm') - (e.forecast.error_table.mean ?? 0)) / (e.forecast.error_table.sd || 1);
const byStation = {};
for (const [st, list] of group(events, (e) => e.station)) {
  const sc = list.map((e) => eventScores(e.probs, e.win));
  byStation[st] = { city: list[0].city, events: list.length, hits: sc.reduce((a, s) => a + s.hit, 0), expected: r2(sc.reduce((a, s) => a + s.p_modal, 0), 2),
    nbm: errStats(list, 'nbm'), gfs: errStats(list, 'gfs'), nws: errStats(list, 'nws'),
    table_mean: list[0].forecast.error_table.mean, table_sd: list[0].forecast.error_table.sd, table_n: list[0].forecast.error_table.n,
    z_rms: r2(Math.sqrt(mean(list.map((e) => zOf(e) ** 2))), 2),
    errors_nbm: list.map((e) => `${e.date.slice(5)}:${err(e, 'nbm') >= 0 ? '+' : ''}${err(e, 'nbm')}`).join(' ') };
}
const byDate = {};
for (const [d, list] of group(events, (e) => e.date)) { const sc = list.map((e) => eventScores(e.probs, e.win)); byDate[d] = { events: list.length, hits: sc.reduce((a, s) => a + s.hit, 0), expected: r2(sc.reduce((a, s) => a + s.p_modal, 0), 2), nbm: errStats(list, 'nbm') }; }
// Station-mean bias test: is the station's mean NBM error outside what its own training table implies for n days?
for (const s of Object.values(byStation)) { const se = s.table_sd / Math.sqrt(s.nbm.n); s.bias_vs_table_t = r2((s.nbm.mean_signed - s.table_mean) / se, 2); }
// Calibration: PIT of the official value within the PBE bucket distribution; modal-probability bins.
const calib = []; for (const [lo, hi] of [[0, 0.3], [0.3, 0.35], [0.35, 0.45], [0.45, 1.01]]) { const sel = scored.filter((s) => s.pbe.p_modal >= lo && s.pbe.p_modal < hi); calib.push({ bin: `${lo}-${Math.min(1, hi)}`, events: sel.length, hits: sel.reduce((a, s) => a + s.pbe.hit, 0), expected: r2(sel.reduce((a, s) => a + s.pbe.p_modal, 0), 2) }); }
const bucketDistance = events.map((e) => Math.abs(bucketIndexOf(e.ranges, e.y) - eventScores(e.probs, e.win).modal));
const distanceHist = bucketDistance.reduce((m, d) => ((m[d] = (m[d] || 0) + 1), m), {});
// Bin-edge exposure: where the NBM guidance sits inside its own bucket (edge = within 0.5 °F of a boundary).
const edge = events.map((e) => { const i = bucketIndexOf(e.ranges, Math.round(e.forecast.nbm)); return { e, edge: i > 0 && i < e.ranges.length - 1, hit: eventScores(e.probs, e.win).hit }; });
const z = events.map(zOf);
const dispersion = { z_mean: r2(mean(z), 2), z_rms: r2(Math.sqrt(mean(z.map((x) => x * x))), 2), within_1sd: z.filter((x) => Math.abs(x) <= 1).length, beyond_2sd: z.filter((x) => Math.abs(x) > 2).length, n: z.length,
  note: 'z = (official - NBM - table mean) / table sd. A calibrated table gives z_rms ~1, ~68% within 1 sd, ~5% beyond 2 sd.' };
const byLead = {}; for (const [k, list] of group(events, (e) => (e.forecast.lead_h_cutoff >= 5 ? 'cutoff >=5 h before window (18Z run, eastern stations)' : 'cutoff <5 h before window (00Z run)'))) { const sc = list.map((e) => eventScores(e.probs, e.win)); byLead[k] = { events: list.length, stations: [...new Set(list.map((e) => e.station))].join(' '), hits: sc.reduce((a, s) => a + s.hit, 0), expected: r2(sc.reduce((a, s) => a + s.p_modal, 0), 2), log_loss: r2(mean(sc.map((s) => s.log_loss))), nbm: errStats(list, 'nbm') }; }
const byConf = {}; for (const [k, list] of group(events, (e) => e.forecast.confidence)) { const sc = list.map((e) => eventScores(e.probs, e.win)); byConf[k] = { events: list.length, hits: sc.reduce((a, s) => a + s.hit, 0), expected: r2(sc.reduce((a, s) => a + s.p_modal, 0), 2) }; }

// ---------- 5. pre-window lead curve: standing v1.x forecast at fixed hours before the window ----------
const preRows = group(fall.filter((x) => x.model_id === 'pbe-weather-maxtemp'), (x) => x.contract_id);
for (const a of preRows.values()) a.sort((x, y) => T(x.captured_at) - T(y.captured_at));
const leadCurve = {};
for (const h of [36, 24, 12, 6, 0]) {
  const rows = [];
  for (const e of events) {
    const cs = ct.filter((c) => c.event_id === e.event_id); const ob = orderBuckets(cs); const t = T(e.observation_start) - h * H;
    const p = ob.buckets.map((c) => { let last = null; for (const x of preRows.get(c.contract_id) || []) { if (T(x.captured_at) < t || (h > 0 && T(x.captured_at) <= t)) last = x; else break; } return last ? Number(last.probability) : null; });
    if (p.some((x) => x === null)) continue;
    rows.push({ date: e.date, s: eventScores(p, e.win) });
  }
  leadCurve[`T-${h}h`] = { events: rows.length, hits: rows.reduce((a, x) => a + x.s.hit, 0), expected: r2(rows.reduce((a, x) => a + x.s.p_modal, 0), 2), log_loss: r2(mean(rows.map((x) => x.s.log_loss))), brier: r2(mean(rows.map((x) => x.s.brier))) };
}

// ---------- 6. intraday v2.1 (designation-intraday/1), event level, plus same-time market where VALID ----------
const intraday = {};
const outcomeOf = new Map(events.map((e) => [e.event_id, e]));
const ctBy = new Map(ct.map((c) => [c.contract_id, c]));
for (const [desig, list] of group(ids.filter((s) => s.scoring_method === 'brier' && s.model_version === '2.1.0'), (s) => s.designation)) {
  const rows = []; let paired = 0; const pairedRows = [];
  for (const [eid, sl] of group(list, (s) => ctBy.get(s.contract_id)?.event_id)) {
    const e = outcomeOf.get(eid); if (!e) continue;
    const ob = orderBuckets(ct.filter((c) => c.event_id === eid));
    const p = ob.buckets.map((c) => sl.find((s) => s.contract_id === c.contract_id)?.pbe_probability ?? null).map((x) => (x === null ? null : Number(x)));
    if (p.some((x) => x === null)) continue;
    const s = eventScores(p, e.win); rows.push({ date: e.date, s });
    const m = ob.buckets.map((c) => { const r = sl.find((x) => x.contract_id === c.contract_id); return r?.benchmark_state === 'VALID' ? Number(r.market_probability) : null; });
    if (m.every((x) => x !== null)) { paired += 1; pairedRows.push({ date: e.date, pbe: s, market: eventScores(m, e.win) }); }
  }
  intraday[desig] = { events: rows.length, dates: new Set(rows.map((x) => x.date)).size, hits: rows.reduce((a, x) => a + x.s.hit, 0), expected: r2(rows.reduce((a, x) => a + x.s.p_modal, 0), 2),
    log_loss: r2(mean(rows.map((x) => x.s.log_loss))), brier: r2(mean(rows.map((x) => x.s.brier))),
    market_paired_events: paired, market_paired: paired ? { pbe_hits: pairedRows.reduce((a, x) => a + x.pbe.hit, 0), market_hits: pairedRows.reduce((a, x) => a + x.market.hit, 0),
      pbe_minus_market_log_loss: clusterBootstrap(pairedRows.map((x) => ({ cluster: x.date, a: x.pbe.log_loss, b: x.market.log_loss }))) } : null };
}

// ---------- 7. v2.2 SHADOW vs v2.1 on the frozen hourly grid (contract level, as pre-registered) ----------
const outcomes = Object.fromEntries(events.map((e) => [`${e.station}|${e.date}`, e.y]));
const shRows = [...fall.filter((x) => x.model_id === 'pbe-weather-maxtemp-intraday' && x.model_version === '2.1.0'), ...sh].map((x) => { const c = ctBy.get(x.contract_id);
  return { contract_id: x.contract_id, model_version: x.model_version, captured_at: x.captured_at, raw_probability: x.raw_probability ?? x.explanation?.raw_probability ?? null, probability: Number(x.probability),
    station_id: c.station_id, climate_date: c.detail?.climate_date, observation_start: c.observation_start, comparator: c.comparator, threshold_low: c.threshold_low === null ? null : Number(c.threshold_low), threshold_high: c.threshold_high === null ? null : Number(c.threshold_high) }; });
const v22 = shadowEvaluationReport(shRows, outcomes);
const v22Dates = [...new Set(sh.map((x) => x.climate_date))].sort();

// ---------- 8. measurement: CLI official max vs the ASOS max PBE saw before the window closed ----------
const asos = [];
for (const e of events) {
  const cs = new Set(ct.filter((c) => c.event_id === e.event_id).map((c) => c.contract_id)); const end = T(e.observation_start) + 24 * H;
  const last = fall.filter((x) => cs.has(x.contract_id) && x.model_id === 'pbe-weather-maxtemp-intraday' && T(x.captured_at) < end).sort((a, b) => T(b.captured_at) - T(a.captured_at))[0];
  const o = last ? evid(last, 'Observed high so far') : null;
  if (o) asos.push({ station: e.station, date: e.date, cli: e.y, asos_max: o.value, diff: e.y - o.value, captured_at: last.captured_at });
}
const asosDiff = asos.reduce((m, x) => ((m[x.diff] = (m[x.diff] || 0) + 1), m), {});

const report = {
  issue: 'LHBUSA/predictions#64', generated_at: new Date().toISOString(), source: 'tkmln pred_* tables, SELECT-only export in a READ ONLY transaction',
  cohort: { settled_events: events.length, excluded, dates: [...new Set(events.map((e) => e.date))], stations: [...new Set(events.map((e) => e.station))] },
  summary, market_strict_stored_mid_only: strictSummary.market_paired, baselines: baselineRows, point_guidance_hits: pointHits,
  by_station: byStation, by_date: byDate, by_lead: byLead, by_confidence: byConf, calibration_modal_bins: calib, bucket_distance_of_miss: distanceHist,
  bin_edge: { edge_events: edge.filter((x) => x.edge).length, edge_hits: edge.filter((x) => x.edge && x.hit).length, interior_events: edge.filter((x) => !x.edge).length, interior_hits: edge.filter((x) => !x.edge && x.hit).length },
  dispersion, pooled_errors: { nbm: errStats(events, 'nbm'), gfs: errStats(events, 'gfs'), nws: errStats(events, 'nws') },
  lead_curve: leadCurve, intraday_v21: intraday, v22_shadow_vs_v21: { ...v22, shadow_climate_dates: v22Dates },
  cli_vs_asos: { events: asos.length, diff_hist: asosDiff, rows: asos.filter((x) => x.diff !== 0) },
  events: events.map(({ ranges, probs, strictMarket, market, ...e }) => ({ ...e, market_distribution: market?.probs ?? null, market_tails_approximated: market?.approximated_tails ?? null, scores: eventScores(probs, e.win), market_scores: market ? eventScores(market.probs, e.win) : null })),
};
const ji = process.argv.indexOf('--json');
if (ji > 0) writeFileSync(process.argv[ji + 1], JSON.stringify(report, null, 1) + '\n');
const { events: _omit, ...head } = report;
console.log(JSON.stringify(head, null, 1));
