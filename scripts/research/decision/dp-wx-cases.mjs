// decision-policy-v1 evidence: regenerate per-case strict point-in-time HOLDOUT predictions for the weather families
// using the exact production code paths (src/weather/*) and committed artifacts (fit on 2023-01-03..2025-06-30 only).
//   node scripts/research/decision/dp-wx-cases.mjs [dataDir] [outDir]
// Point-in-time: a forecast at cutoff C (= CLI window start - leadH) uses only MOS/NBM runs with runtime + 5 h <= C
// (latestRunAtOrBefore), NBM only if <= 24 h old at C (engine rule). Holdout = climate dates 2025-07-01..2026-09-30.
// Market/venue data is never read. Outputs (JSONL): precip-cases.jsonl, temp-cases.jsonl.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseAcisValue } from '../../../src/weather/acis.js';
import { parseMosCsv, latestRunAtOrBefore, windowPrecipFeatures, maxTempGuidance, nbmMaxTempGuidance } from '../../../src/weather/mos.js';
import { cliWindow } from '../../../src/weather/time.js';
import { predictPrecip } from '../../../src/weather/precip-model.js';
import { residualTable, bucketProbability } from '../../../src/weather/temp-model.js';
import { gradeQuality, publishable } from '../../../src/weather/engine.js';
import { normalCdf } from '../../../src/models/probability-utils.js';
import precipV1 from '../../../src/weather/artifacts/precip-v1.json' with { type: 'json' };
import precipV11 from '../../../src/weather/artifacts/precip-nbm-v1.1.json' with { type: 'json' };
import tempV1 from '../../../src/weather/artifacts/temp-v1.json' with { type: 'json' };
import tempV11 from '../../../src/weather/artifacts/temp-nbm-v1.1.json' with { type: 'json' };
import climatology from '../../../src/weather/artifacts/climatology-v1.json' with { type: 'json' };

const DATA = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const OUT = process.argv[3] || 'D:/Workers/scratch/predictions-decision';
const TRAIN_END = '2025-07-01';
const HOLD_FROM = '2025-07-01'; const HOLD_TO = '2026-09-30';
const LEADS = [6, 18, 30, 42];
const KALSHI_HIGH = new Set(['CLINYC', 'CLIMIA', 'CLIMDW', 'CLILAX', 'CLIAUS', 'CLIDEN', 'CLIPHL']);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const files = await readdir(join(DATA, 'mos'));
const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.runtime)) m.set(r.runtime, []); m.get(r.runtime).push(r); } return m; };
const clampP = (p) => Math.min(0.98, Math.max(0.02, p));
await mkdir(OUT, { recursive: true });

// Production wx-quality/1 precip grade uses station skill from precip-v1 HOLDOUT by_station (leaks holdout into the grade).
const prodSkill = (cli) => { const s = precipV1.holdout.by_station?.[cli]; return s ? { skill: 1 - s.p_model.brier / s.p_clim.brier, n: s.n } : { skill: null, n: 0 }; };
const trainSkillAcc = {}; // point-in-time alternative: same statistic from the TRAINING period (precip-v1 in-sample)

const precip = []; const temp = [];
for (const st of Object.values(CLI_STATIONS)) {
  const acis = JSON.parse(await readFile(join(DATA, 'acis', `${st.icao}.json`), 'utf8'));
  const daily = new Map(acis.data.map(([d, p, x]) => [d, { pcpn: parseAcisValue(p), maxt: parseAcisValue(x) }]));
  const load = async (prefix) => { const out = []; for (const f of files.filter((n) => n.startsWith(prefix))) out.push(...parseMosCsv(await readFile(join(DATA, 'mos', f), 'utf8'))); return group(out); };
  const gfs = await load(`${st.icao}-`); const nbm = await load(`NBS-${st.icao}-`);
  const gR = [...gfs.keys()].sort(); const nR = [...nbm.keys()].sort();
  const acc = (trainSkillAcc[st.cli] = { n: 0, bm: 0, bc: 0 });
  for (let d = '2023-01-03'; d <= HOLD_TO; d = addDays(d, 1)) {
    const obs = daily.get(d); if (!obs) continue;
    const isHold = d >= HOLD_FROM;
    const win = cliWindow(d, st);
    const climRow = climatology.stations[st.cli].by_month_day[d.slice(5)];
    for (const h of LEADS) {
      const cutoffMs = Date.parse(win.start) - h * 3600000; const cutoff = new Date(cutoffMs).toISOString();
      const gr = latestRunAtOrBefore(gR, cutoff); if (!gr) continue;
      const nrRaw = latestRunAtOrBefore(nR, cutoff);
      const nr = nrRaw && cutoffMs - Date.parse(nrRaw) <= 24 * 3600000 ? nrRaw : null; // engine freshness rule
      const runLeadH = (Date.parse(win.start) - Date.parse(gr)) / 3600000;
      const runAgeH = (cutoffMs - Date.parse(gr)) / 3600000;
      // ---------------- precip
      if (obs.pcpn.kind !== 'missing' && climRow?.[0] != null) {
        const f = windowPrecipFeatures(gfs.get(gr), win);
        if (f) {
          const y = obs.pcpn.kind === 'value' && obs.pcpn.value > 0 ? 1 : 0;
          const clim = climRow[0];
          const pv10 = predictPrecip(precipV1, { pop_union: f.pop_union, pop_max: f.pop_max, clim, runLeadH }).probability;
          if (!isHold) { if (d < TRAIN_END) { acc.n += 1; acc.bm += (pv10 - y) ** 2; acc.bc += (clim - y) ** 2; } }
          else {
            const n = nr ? windowPrecipFeatures(nbm.get(nr), win) : null;
            const raw = n ? predictPrecip(precipV11, { pop_union: f.pop_union, pop_max: f.pop_max, nbm_pop_union: n.pop_union, nbm_pop_max: n.pop_max, clim, runLeadH }).probability : pv10;
            const disagree = Boolean(n) && Math.abs(n.pop_union - f.pop_union) >= 0.25;
            const ps = prodSkill(st.cli);
            let conf = gradeQuality({ complete: true, runAgeH, runLeadH, stationSkill: ps.skill, stationN: ps.n });
            if (disagree && conf === 'HIGH') conf = 'MEDIUM';
            precip.push({ st: st.cli, d, h, y, p: publishable(raw), praw: +raw.toFixed(5), tier: n ? '1.1.0' : '1.0.0', conf, disagree, runLeadH: +runLeadH.toFixed(2), runAgeH: +runAgeH.toFixed(2),
              p_clim: clim, p_guid: +clampP(n ? n.pop_union : f.pop_union).toFixed(4), p_gfs_union: +clampP(f.pop_union).toFixed(4), p_v10: +pv10.toFixed(5) });
          }
        }
      }
      // ---------------- max temp (holdout only)
      if (isHold && obs.maxt.kind === 'value') {
        const gMax = maxTempGuidance(gfs.get(gr), d); if (gMax === null) continue;
        const nMax = nr ? nbmMaxTempGuidance(nbm.get(nr), d) : null;
        const art = nMax ? tempV11 : tempV1; const g = nMax ? nMax.max : gMax;
        const table = residualTable(art, st.cli, runLeadH);
        const disagree = Boolean(nMax) && Math.abs(nMax.max - gMax) >= 4;
        const base = table.source === 'station' && table.n >= 300 && runAgeH <= 12 && runLeadH <= 30 ? 'HIGH' : runAgeH <= 24 ? 'MEDIUM' : 'LOW';
        const conf = disagree && base === 'HIGH' ? 'MEDIUM' : base;
        // Kalshi KXHIGH grid shape (6 exclusive outcomes): <=L-1, [L,L+1], [L+2,L+3], [L+4,L+5], [L+6,L+7], >=L+8.
        // Venue grids are centred on the venue's own forecast; here L is anchored on the GFS MOS guidance (a fact, no price).
        const L = Math.round(gMax) - 4;
        const buckets = [{ comparator: 'less', high: L }, { comparator: 'between', low: L, high: L + 1 }, { comparator: 'between', low: L + 2, high: L + 3 }, { comparator: 'between', low: L + 4, high: L + 5 }, { comparator: 'between', low: L + 6, high: L + 7 }, { comparator: 'greater', low: L + 7 }];
        const range = (b) => (b.comparator === 'less' ? [-Infinity, b.high - 1] : b.comparator === 'greater' ? [b.low + 1, Infinity] : [b.low, b.high]);
        const nrm = (mu, sd, [lo, hi]) => (hi === Infinity ? 1 : normalCdf(hi + 0.5, mu, sd)) - (lo === -Infinity ? 0 : normalCdf(lo - 0.5, mu, sd));
        const cm = climRow?.[3]; const cs = climRow?.[4];
        const yv = obs.maxt.value;
        temp.push({ st: st.cli, d, h, k7: KALSHI_HIGH.has(st.cli), yv, gfs: gMax, nbm: nMax ? nMax.max : null, tier: art.version, conf, disagree, tsrc: table.source, tn: table.n, runLeadH: +runLeadH.toFixed(2), runAgeH: +runAgeH.toFixed(2), L,
          b: buckets.map((bk) => { const r = range(bk); const p = bucketProbability(art, table, g, { comparator: bk.comparator, low: bk.low ?? null, high: bk.high ?? null });
            return { p: publishable(p), praw: +p.toFixed(5), y: yv >= r[0] && yv <= r[1] ? 1 : 0,
              p_norm: +Math.min(0.99, Math.max(0.01, nrm(g + table.mean, table.sd, r))).toFixed(5),
              p_clim: cm != null ? +Math.min(0.99, Math.max(0.01, nrm(cm, cs, r))).toFixed(5) : null }; }) });
      }
    }
  }
  console.log(st.cli, 'precip', precip.length, 'temp', temp.length);
}
const trainSkill = Object.fromEntries(Object.entries(trainSkillAcc).map(([k, a]) => [k, { n: a.n, skill: a.n ? 1 - a.bm / a.bc : null }]));
for (const r of precip) { // point-in-time grade variant (station skill measured on the training period only)
  const ts = trainSkill[r.st];
  let c = gradeQuality({ complete: true, runAgeH: r.runAgeH, runLeadH: r.runLeadH, stationSkill: ts.skill, stationN: ts.n });
  if (r.disagree && c === 'HIGH') c = 'MEDIUM';
  r.conf_pit = c;
}
await writeFile(join(OUT, 'precip-cases.jsonl'), precip.map((r) => JSON.stringify(r)).join('\n') + '\n');
await writeFile(join(OUT, 'temp-cases.jsonl'), temp.map((r) => JSON.stringify(r)).join('\n') + '\n');
await writeFile(join(OUT, 'precip-station-skill.json'), JSON.stringify({ production_holdout_derived: Object.fromEntries(Object.keys(CLI_STATIONS).map((k) => [k, prodSkill(k)])), point_in_time_training: trainSkill }, null, 1));
console.log('done', precip.length, temp.length);
