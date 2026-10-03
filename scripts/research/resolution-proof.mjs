// Resolution-layer proof: for settled Kalshi weather markets, compare the venue settlement with the official
// NWS CLI value at the contract's exact station (independently fetched). Reads Kalshi only through the
// canonical propsports-markets service. No forecasts are created or scored here.
//   node scripts/research/resolution-proof.mjs <markets-admin-token-file> [days...]
import { readFile } from 'node:fs/promises';
import { normalizeContract } from '../../src/engine/contracts.js';
import { cliStation } from '../../src/weather/stations.js';
import { cliDay, fetchCliYear, officialOutcome } from '../../src/weather/cli.js';

const token = (await readFile(process.argv[2], 'utf8')).trim();
const days = process.argv.slice(3).length ? process.argv.slice(3) : ['26OCT01', '26OCT02'];
const H = 'https://propsports-markets.sales-fd3.workers.dev';
const UA = 'PropBetEdgePredictions/1.0 (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
const SERIES = ['KXRAIN', 'KXHIGHNY', 'KXHIGHMIA', 'KXHIGHCHI', 'KXHIGHLAX', 'KXHIGHAUS', 'KXHIGHDEN', 'KXHIGHPHIL'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function kalshi(path) {
  const r = await fetch(`${H}/admin/kalshi?path=${encodeURIComponent(path)}&with_nested_markets=true`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json(); if (j.status !== 200) throw new Error(`${path} ${j.status}`); return j.body;
}
const cli = new Map();
let n = 0; let agree = 0; const diffs = []; const stations = new Set();
for (const s of SERIES) {
  const series = (await kalshi(`/series/${s}`)).series;
  for (const d of days) {
    let ev;
    try { ev = (await kalshi(`/events/${s}-${d}`)).event; } catch { continue; }
    await sleep(300);
    for (const m of ev.markets) {
      if (!['yes', 'no'].includes(m.result)) continue;
      const c = await normalizeContract({ series, event: ev, market: m });
      if (c.normalization_status !== 'NORMALIZED') { diffs.push({ market: m.ticker, issue: c.status_reason }); continue; }
      const st = cliStation(c.station_id);
      const year = c.detail.climate_date.slice(0, 4);
      if (!cli.has(st.icao)) { cli.set(st.icao, (await fetchCliYear({ icao: st.icao, year }, { userAgent: UA })).rows); await sleep(400); }
      const o = officialOutcome(c, cliDay(cli.get(st.icao), c.detail.climate_date));
      if (!o) { diffs.push({ market: m.ticker, issue: 'CLI_NOT_AVAILABLE' }); continue; }
      n += 1; stations.add(c.station_id);
      if (o.outcome === m.result.toUpperCase()) agree += 1; else diffs.push({ market: m.ticker, station: c.station_id, cli: o.value, venue: m.result, expiration_value: m.expiration_value });
    }
  }
}
console.log(JSON.stringify({ days, settled_contracts_checked: n, official_matches_venue: agree, stations: [...stations].sort(), disagreements_or_gaps: diffs }, null, 1));
