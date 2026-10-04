// Equivalence harness for core-cycle refactors: runs runCycle on captured fixtures (weather + rates, dry run and
// with a recording store) and prints a canonical JSON of everything written. Run before and after a change and diff.
//   node scripts/ops/cycle-golden.mjs > before.json
import { readFileSync } from 'node:fs';
import { runCycle } from '../../workers/pbe-predictions/src/cycle.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../../test/${p}`, import.meta.url)));
const NOW = '2026-10-03T19:30:00.000Z';
const fx = {
  KXRAIN: read('fixtures/kalshi/KXRAIN-26OCT04.json'), KXHIGHNY: read('fixtures/kalshi/KXHIGHNY-26OCT04.json'),
  KX10YRDIRHM: read('fixtures/kalshi/KX10YRDIRHM-26OCT30H.json'),
};
const markets = () => ({
  requests: 0,
  async series(t) { this.requests += 1; if (!fx[t]) throw new Error(`market service /series/${t} -> 404`); return fx[t].series; },
  async openEvents(t) { this.requests += 1; return { events: [{ ...fx[t].event, markets: fx[t].markets }] }; },
  async marketsByTicker() { return []; },
});
const ok = (body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': type } });
const fetchImpl = async (url) => {
  const u = String(url);
  let m = /mos\.json\?station=([A-Z]{4})/.exec(u);
  if (m) { try { return ok(read(`fixtures/weather/mos-${m[1]}.json`)); } catch { return new Response('{}', { status: 404 }); } }
  if (/api\.weather\.gov\/points\//.test(u)) return ok({ properties: { gridId: 'MFL', gridX: 105, gridY: 51, forecastGridData: 'https://api.weather.gov/gridpoints/MFL/105,51' } });
  if (/gridpoints\/MFL/.test(u)) return ok(read('fixtures/weather/grid-MFL-105-51.json'));
  m = /daily-treasury-rates\.csv\/(\d{4})/.exec(u);
  if (m) return ok(readFileSync(new URL(`../../test/fixtures/treasury/treasury-par-${m[1]}.csv`, import.meta.url), 'utf8'), 'text/csv');
  return new Response('{}', { status: 404 });
};
function recordingStore() {
  const calls = [];
  const rec = (name) => async (...a) => { calls.push([name, ...a.map((x) => (Array.isArray(x) ? x.length : typeof x === 'object' ? Object.keys(x).length : x))]); return []; };
  return { calls, selectIn: rec('selectIn'), select: rec('select'), upsertEventRow: rec('upsertEventRow'), insertContracts: rec('insertContracts'), insertVenueSnapshots: rec('insertVenueSnapshots'),
    insertObservations: rec('insertObservations'), insertFeatureRows: rec('insertFeatureRows'), insertForecastRows: rec('insertForecastRows'), write: rec('write'), insertReturning: rec('insertReturning') };
}
const strip = ({ summary, writes }) => { const { phase_ms, ...s } = summary; return { summary: s, writes }; };
const env = { WEATHER_SERIES: 'KXRAIN,KXHIGHNY', RATES_SERIES: 'KX10YRDIRHM', MONITOR_SERIES: 'KXMISSING' };
const out = {};
out.dry = strip(await runCycle(env, { markets: markets(), fetchImpl, now: NOW, dryRun: true }));
const store = recordingStore();
const r = await runCycle(env, { store, markets: markets(), fetchImpl, now: NOW });
out.stored = { summary: strip({ summary: r.summary, writes: null }).summary, calls: store.calls.map((c) => c.join(':')).sort() };
process.stdout.write(JSON.stringify(out, null, 1));
