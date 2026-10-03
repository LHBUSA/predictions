// Fed v1 feature selection — uses ONLY training-era meetings (round 2: fit 1994-2004, validate 2005-2015,
// a window with hikes, cuts and the zero bound; round 1 used 2008-2015, which was nearly all holds).
// The 2016+ holdout is not read here.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FED_OUTCOMES, outcomeOfChange, fitOrderedLogit, orderedProbabilities, parseFredCsv, valueAsOf, targetMidAsOf } from '../../src/macro/fed-model.js';

const DIR = 'D:/Workers/scratch/predictions-wx';
const csv = async (id) => parseFredCsv(await readFile(join(DIR, `fred-${id}.csv`), 'utf8'));
const S = Object.fromEntries(await Promise.all(['DTB3', 'DTB6', 'DGS3MO', 'DGS6MO', 'DGS1', 'DFEDTAR', 'DFEDTARU', 'DFEDTARL'].map(async (id) => [id, await csv(id)])));
const tgt = { legacy: S.DFEDTAR, upper: S.DFEDTARU, lower: S.DFEDTARL };
const reg = JSON.parse(await readFile(new URL('../../data/fomc/scheduled-decisions.json', import.meta.url), 'utf8')).meetings.filter((m) => m.changeBps !== null && m.meetingDate < '2016-01-01');
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const spread = (id, d) => { const b = valueAsOf(S[id], d); const m = targetMidAsOf(tgt, d); return b && m ? b.value - m.value : null; };

const cases = [];
for (let i = 1; i < reg.length; i += 1) {
  const m = reg[i]; const prevM = reg[i - 1];
  for (const h of [1, 7, 14, 21, 28]) {
    const asOf = shift(m.meetingDate, -h - 2);
    const base = shift(prevM.meetingDate, 2); // first day after the previous decision is public
    const r = { s3: spread('DTB3', asOf), s6: spread('DTB6', asOf), c3: spread('DGS3MO', asOf), c6: spread('DGS6MO', asOf), c12: spread('DGS1', asOf), d3: null, d6: null, prev: Math.sign(prevM.changeBps), h };
    const b3 = spread('DGS3MO', base); const b6 = spread('DGS6MO', base);
    if (r.c3 !== null && b3 !== null && base <= asOf) r.d3 = r.c3 - b3;
    if (r.c6 !== null && b6 !== null && base <= asOf) r.d6 = r.c6 - b6;
    if (Object.values(r).some((v) => v === null)) continue;
    cases.push({ ...r, y: FED_OUTCOMES.indexOf(outcomeOfChange(m.changeBps)), date: m.meetingDate });
  }
}
const sets = {
  A_bill_levels: (c) => [c.s3, c.s6, c.prev, c.h / 30],
  B_cmt_levels: (c) => [c.c3, c.c6, c.prev, c.h / 30],
  C_change_since_last: (c) => [c.d3, c.d6, c.prev, c.h / 30],
  D_change_plus_slope: (c) => [c.d3, c.c6 - c.c3, c.prev, c.h / 30],
  E_cmt_6m_12m: (c) => [c.c6, c.c12, c.prev, c.h / 30],
  F_change_and_level: (c) => [c.d6, c.c6, c.prev, c.h / 30],
  I_3m_change_and_level: (c) => [c.d3, c.c3, c.prev, c.h / 30],
  J_3m_6m_changes: (c) => [c.d3, c.d6, c.prev, c.h / 30],
};
const fit = cases.filter((c) => c.date < '2005-01-01');
const val = cases.filter((c) => c.date >= '2005-01-01');
for (const [name, fx] of Object.entries(sets)) {
  const p = fitOrderedLogit(fit.map(fx), fit.map((c) => c.y));
  let ll = 0; let br = 0; let acc = 0;
  for (const c of val) { const q = orderedProbabilities(p, fx(c)); ll -= Math.log(q[c.y]); br += q.reduce((s, v, k) => s + (v - (k === c.y ? 1 : 0)) ** 2, 0); acc += q.indexOf(Math.max(...q)) === c.y ? 1 : 0; }
  console.log(name.padEnd(22), 'val log_loss', (ll / val.length).toFixed(4), 'brier', (br / val.length).toFixed(4), 'acc', (acc / val.length).toFixed(3));
}
const clim = FED_OUTCOMES.map((_, k) => (fit.filter((c) => c.y === k).length + 0.5) / (fit.length + 2.5));
let ll = 0; for (const c of val) ll -= Math.log(clim[c.y]);
console.log('climatology'.padEnd(22), 'val log_loss', (ll / val.length).toFixed(4), `fit ${fit.length} val ${val.length}`);
