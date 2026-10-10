// Point-in-time max-temp cases from the local IEM MOS / ACIS archive (same construction as scripts/research/wx-temp-nbm.mjs,
// the v1.1 build): CLI station x climate date x lead h before the LST window; a run is usable at runtime + 5 h; NBM <= 24 h old.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseAcisValue } from '../../../src/weather/acis.js';
import { parseMosCsv, latestRunAtOrBefore, maxTempGuidance, nbmMaxTempGuidance } from '../../../src/weather/mos.js';
import { cliWindow } from '../../../src/weather/time.js';
import { leadBucket } from '../../../src/weather/temp-model.js';

export const LEADS = [6, 18, 30, 42];
const H = 3600000;
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export async function buildCases(dir, { from = '2023-01-03', to = '2026-09-30', cliKnownLagH = 6 } = {}) {
  const files = await readdir(join(dir, 'mos'));
  const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.runtime)) m.set(r.runtime, []); m.get(r.runtime).push(r); } return m; };
  const cases = [];
  for (const st of Object.values(CLI_STATIONS)) {
    const acis = JSON.parse(await readFile(join(dir, 'acis', `${st.icao}.json`), 'utf8'));
    const daily = new Map(acis.data.map(([d, , x]) => [d, parseAcisValue(x)]));
    const load = async (prefix) => { const out = []; for (const f of files.filter((n) => n.startsWith(prefix))) out.push(...parseMosCsv(await readFile(join(dir, 'mos', f), 'utf8'))); return group(out); };
    const gfs = await load(`${st.icao}-`); const nbm = await load(`NBS-${st.icao}-`);
    const gR = [...gfs.keys()].sort(); const nR = [...nbm.keys()].sort();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const a = daily.get(d); if (a?.kind !== 'value') continue;
      const win = cliWindow(d, st);
      for (const h of LEADS) {
        const cutoff = new Date(Date.parse(win.start) - h * H).toISOString();
        const gr = latestRunAtOrBefore(gR, cutoff); const nr = latestRunAtOrBefore(nR, cutoff);
        if (!gr || !nr || Date.parse(cutoff) - Date.parse(nr) > 24 * H) continue;
        const g = maxTempGuidance(gfs.get(gr), d); const n = nbmMaxTempGuidance(nbm.get(nr), d);
        if (g === null || !n) continue;
        const runLeadH = (Date.parse(win.start) - Date.parse(gr)) / H;
        cases.push({ s: st.cli, d, h, y: a.value, g, n: n.max, xnd: n.spread, runLeadH, lb: leadBucket(runLeadH),
          cutoffMs: Date.parse(cutoff), knownMs: Date.parse(win.end) + cliKnownLagH * H, month: d.slice(5, 7) });
      }
    }
  }
  return cases;
}
