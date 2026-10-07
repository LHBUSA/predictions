// v2.1 production parity replay (Phase 2 gate): re-run the CURRENT intradayForStation (shadow lane OFF and ON) on the
// stored source state behind real production maxtemp-intraday 2.1.0 rows and compare probability, raw probability and
// input hash with what production stored. Guidance runs are re-fetched from the IEM archive by the runtime named in the
// row's provenance (NBM) and the GFS MOS run usable at capture.
//   node scripts/research/intraday/v21-parity-replay.mjs parity-input.json
// parity-input.json = { forecasts: [...v2.1 rows + provenance], contracts: [...pred_contracts rows], obs: [...pred_source_observations asos rows] }
import { readFileSync } from 'node:fs';
import { intradayForStation } from '../../../workers/pbe-predictions/src/intraday-live.js';
import { fetchMosRun, fetchUsableRun } from '../../../src/weather/mos.js';
import { CLI_STATIONS } from '../../../src/weather/stations.js';

const UA = 'PropBetEdgePredictions/1.0 (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
let doc = JSON.parse(readFileSync(process.argv[2], 'utf8')); if (typeof doc === 'string') doc = JSON.parse(doc);
// production reads contracts through PostgREST, which renders timestamptz in UTC as 'YYYY-MM-DDTHH:MM:SS+00:00'; a SQL
// export renders them in the session zone. The window bounds enter the input hash verbatim, so restore PostgREST's form.
const pgrst = (v) => (v ? new Date(v).toISOString().replace(/\.000Z$/, '+00:00') : v);
const TS = ['observation_start', 'observation_end', 'close_time', 'expected_settlement_time', 'normalized_at'];
const cBy = new Map(doc.contracts.map((c) => [c.contract_id, { ...c, ...Object.fromEntries(TS.map((k) => [k, pgrst(c[k])])) }]));
const runCache = new Map();
const cached = (k, fn) => { if (!runCache.has(k)) runCache.set(k, fn()); return runCache.get(k); };
const iso = (t) => new Date(t).toISOString();

const results = []; const shadowStatus = [];
for (const f of doc.forecasts) {
  const c = cBy.get(f.contract_id); const st = CLI_STATIONS[c.station_id];
  const nbmRt = f.provenance.find((p) => p.run && /NBS|Blend/i.test(`${p.url} ${p.source}`))?.run;
  const now = iso(f.captured_at);
  const nbm = nbmRt ? await cached(`NBS|${st.icao}|${nbmRt}`, () => fetchMosRun({ icao: st.icao, model: 'NBS', runtime: iso(nbmRt) }, { userAgent: UA })) : null;
  const mos = await cached(`GFS|${st.icao}|${now.slice(0, 13)}`, () => fetchUsableRun({ icao: st.icao, now }, { userAgent: UA }));
  const obsRows = doc.obs.filter((o) => o.source_id.startsWith(`asos:${st.icao}:`) && Date.parse(o.observed_at) >= Date.parse(c.observation_start));
  const outs = {};
  for (const shadow of [false, true]) {
    const written = [];
    const store = {
      selectIn: async (t, q, col, ids) => (t === 'pred_contracts' ? [c].filter((x) => ids.includes(x.contract_id)) : []),
      select: async () => obsRows,
      insertFeatureRows: async () => {}, insertForecastRows: async (r) => written.push(...r), insertMany: async () => {},
    };
    const fetchImpl = (u, i) => fetch(u, i);
    const res = await intradayForStation(store, { icao: st.icao, cli: st.cli, start: c.observation_start, end: c.observation_end, contracts: [c] }, { now, sources: { nbm, mos }, shadow, fetchImpl });
    if (shadow) shadowStatus.push(res.shadow?.written ? 'OK' : Object.keys(res.shadow?.skipped || {})[0] || (res.shadow?.error ? `ERROR ${res.shadow.error}` : 'UNKNOWN'));
    outs[shadow ? 'on' : 'off'] = written.find((w) => w.contract_id === c.contract_id) || null;
  }
  const r = outs.off;
  results.push({ forecast_id: f.forecast_id, station: c.station_id, date: f.d, captured_at: now,
    prod: { p: Number(f.probability), raw: f.raw_probability, hash: f.input_hash },
    replay: r ? { p: r.probability, raw: r.explanation.raw_probability, hash: r.explanation.input_hash } : null,
    on_equals_off: JSON.stringify(outs.on) === JSON.stringify(outs.off) });
}
const match = (x) => x.replay && x.replay.p === x.prod.p && x.replay.hash === x.prod.hash && Math.abs(x.replay.raw - x.prod.raw) < 1e-12;
const bad = results.filter((x) => !match(x));
console.log(JSON.stringify({ rows: results.length, stations: new Set(results.map((x) => x.station)).size, climate_days: new Set(results.map((x) => x.date)).size,
  exact_match: results.length - bad.length, mismatches: bad.length, shadow_on_equals_off: results.filter((x) => x.on_equals_off).length,
  shadow_v22_status: shadowStatus.reduce((a, k) => ({ ...a, [k]: (a[k] || 0) + 1 }), {}), mismatch_detail: bad.slice(0, 10) }, null, 1));
process.exit(bad.length || results.some((x) => !x.on_equals_off) ? 1 : 0);
