// Research data pull for the weather engine calibration (not a product runtime).
//   node scripts/research/wx-fetch.mjs [outDir]
// Writes, per CLI station:
//   acis/<ICAO>.json        official daily pcpn/maxt/mint (NOAA RCC-ACIS, GHCN-D station id) 1991-01-01..yesterday
//   mos/<ICAO>-<YEAR>.csv   archived NWS GFS MOS (MAV) guidance via the IEM archive, every run
// Sequential with a pause between requests (courtesy to public services). Existing files are kept.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../src/weather/stations.js';

const OUT = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const UA = 'PropBetEdgePredictions/0.1 (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
const MOS_YEARS = [2023, 2024, 2025, 2026];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

async function get(url, init = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers || {}) } });
    if (res.ok) return res.text();
    console.error(`  ${res.status} ${url} (attempt ${attempt})`);
    await sleep(5000 * attempt);
  }
  throw new Error(`failed: ${url}`);
}

await mkdir(join(OUT, 'acis'), { recursive: true });
await mkdir(join(OUT, 'mos'), { recursive: true });
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

for (const st of Object.values(CLI_STATIONS)) {
  const acisPath = join(OUT, 'acis', `${st.icao}.json`);
  if (!(await exists(acisPath))) {
    const body = JSON.stringify({ sid: st.ghcn, sdate: '1991-01-01', edate: yesterday, elems: [{ name: 'pcpn' }, { name: 'maxt' }, { name: 'mint' }], meta: ['name', 'sids', 'll'] });
    const text = await get('https://data.rcc-acis.org/StnData', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await writeFile(acisPath, text);
    console.log(`acis ${st.icao} ${text.length}B`);
    await sleep(1500);
  }
  for (const year of MOS_YEARS) {
    const mosPath = join(OUT, 'mos', `${st.icao}-${year}.csv`);
    if (await exists(mosPath)) continue;
    const sts = `${year}-01-01T00:00Z`;
    const ets = year === 2026 ? new Date().toISOString().slice(0, 13) + ':00Z' : `${year + 1}-01-01T00:00Z`;
    const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${st.icao}&model=GFS&sts=${sts}&ets=${ets}&format=csv`;
    const text = await get(url);
    await writeFile(mosPath, text);
    console.log(`mos ${st.icao} ${year} ${text.length}B`);
    await sleep(2000);
  }
}
console.log('done');
