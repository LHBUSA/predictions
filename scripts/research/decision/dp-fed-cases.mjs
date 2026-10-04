// decision-policy-v1 evidence: per-case HOLDOUT predictions for pbe-fed-decision@1.0.0 (SHADOW).
//   node scripts/research/decision/dp-fed-cases.mjs [dataDir] [outDir]
// Same case construction and point-in-time rule as scripts/research/fed-train.mjs (features from H.15 values dated
// <= cutoff - 2 days), scored with the COMMITTED artifact params (trained on 1994-2015 meetings). Holdout: 2016+ meetings.
// Baselines: training climatology and previous-decision persistence (training-era frequencies). No market data.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FED_OUTCOMES, outcomeOfChange, fedFeatureVector, orderedProbabilities, parseFredCsv, valueAsOf, targetMidAsOf } from '../../../src/macro/fed-model.js';
import art from '../../../src/macro/artifacts/fed-v1.json' with { type: 'json' };

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const OUT = process.argv[3] || 'D:/Workers/scratch/predictions-decision';
const HORIZONS = [1, 7, 14, 21, 28];
const csv = async (id) => parseFredCsv(await readFile(join(DIR, `fred-${id}.csv`), 'utf8'));
const [cmt6, legacy, upper, lower] = await Promise.all(['DGS6MO', 'DFEDTAR', 'DFEDTARU', 'DFEDTARL'].map(csv));
const reg = JSON.parse(await readFile(new URL('../../../data/fomc/scheduled-decisions.json', import.meta.url), 'utf8')).meetings;
const decided = reg.filter((m) => m.changeBps !== null);
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const cases = [];
for (let i = 1; i < decided.length; i += 1) {
  const m = decided[i]; const prev = Math.sign(decided[i - 1].changeBps);
  for (const h of HORIZONS) {
    const asOf = shift(m.meetingDate, -h - 2); const base = shift(decided[i - 1].meetingDate, 2);
    if (base > asOf) continue;
    const spreadAt = (d) => { const b = valueAsOf(cmt6, d); const mid = targetMidAsOf({ legacy, upper, lower }, d); return b && mid ? b.value - mid.value : null; };
    const c6 = spreadAt(asOf); const b6 = spreadAt(base);
    if (c6 === null || b6 === null) continue;
    cases.push({ d: m.meetingDate, h, d6: c6 - b6, c6, prev, horizonDays: h, y: FED_OUTCOMES.indexOf(outcomeOfChange(m.changeBps)), split: m.meetingDate < '2016-01-01' ? 'train' : 'test' });
  }
}
const train = cases.filter((c) => c.split === 'train'); const test = cases.filter((c) => c.split === 'test');
const clim = FED_OUTCOMES.map((_, k) => (train.filter((c) => c.y === k).length + 0.5) / (train.length + 2.5));
const persist = {}; for (const p of [-1, 0, 1]) { const rows = train.filter((c) => c.prev === p); persist[p] = FED_OUTCOMES.map((_, k) => (rows.filter((c) => c.y === k).length + 0.5) / (rows.length + 2.5)); }
const [lo, hi] = art.probability_bounds;
const out = test.map((c) => ({ d: c.d, h: c.h, y: c.y, p: orderedProbabilities(art.params, fedFeatureVector(c)).map((v) => Math.min(hi, Math.max(lo, v))), p_clim: clim, p_persist: persist[c.prev] }));
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'fed-cases.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log('fed holdout cases', out.length, 'meetings', new Set(out.map((r) => r.d)).size);
