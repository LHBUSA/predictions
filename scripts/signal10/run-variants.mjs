// Signal 10 RESEARCH VARIANTS (post-hoc, IN-SAMPLE). These were defined AFTER the v1.0.0 result was seen, on the same
// 2018-2026 history, so none of them is out-of-sample evidence and none replaces the pre-registered v1.0.0 account.
// They exist to show which parts of the design cost or added return (owner: "show failed variants").
// node scripts/signal10/run-variants.mjs --cutoff 2026-10-08
import fs from 'node:fs';
import path from 'node:path';
import { loadComponents } from '../../src/signal10/universe.js';
import { rankUniverse } from '../../src/signal10/rank.js';
import { prepareMarket, runAccount, metrics } from '../../src/signal10/backtest.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', 'E:/Workers/cache/signal10');
const CUTOFF = arg('--cutoff'); const START = arg('--start', '2018-01-02');
const dataset = JSON.parse(fs.readFileSync(path.join(CACHE, `dataset-${CUTOFF}.json`), 'utf8'));
const comps = loadComponents(fs.readFileSync(path.join(CACHE, 'raw/universe/components.csv'), 'utf8'));
const mkt = prepareMarket(dataset, comps);
const days = mkt.calendar.filter((d) => d >= START && d <= CUTOFF);
const snapsFor = (w) => new Map(days.map((d) => [d, rankUniverse(d, mkt.universeOn(d), mkt.prepared, w)]));
const base = snapsFor(undefined);
const mom = snapsFor({ mom12_1: 1 });
const run = (name, desc, snapshots, opts) => { const r = runAccount(mkt, { start: START, end: CUTOFF, snapshots, ...opts }); const m = metrics(r.nav); return { name, desc, ...m, fills: r.state.events.filter((e) => e.type === 'FILL').length }; };
const variants = [
  run('v1.0.0 (official)', 'Pre-registered rank model + manager. The only record presented as the Signal 10 backtest.', base, {}),
  run('no stops', 'v1.0.0 without the trailing stop and stop-loss exits.', base, { variant: { noStops: true } }),
  run('no regime filter', 'v1.0.0 allowed to open new names while SPY is below its 200-day average.', base, { variant: { noRegime: true } }),
  run('no stops, no regime', 'Both removed; entry timing (dip/persistence) kept.', base, { variant: { noStops: true, noRegime: true } }),
  run('immediate top-10 comparator', 'Same ranks; buy the top 10 at once, exit only on rank > 30 / ineligible.', base, { mode: 'IMMEDIATE' }),
  run('pure 12-1 momentum, immediate', 'Rank on 12-1 month momentum only (no trend/vol/risk terms), immediate entry.', mom, { mode: 'IMMEDIATE' })
];
const out = { schema: 'signal10-variants/1', label: 'RESEARCH VARIANTS · POST-HOC · IN-SAMPLE (defined after the v1.0.0 result; not out-of-sample evidence)', data_cutoff: CUTOFF, start: START, generated_at: new Date().toISOString(), variants };
fs.writeFileSync('data/signal10/research-variants.json', JSON.stringify(out, null, 1));
for (const v of variants) console.log(v.name.padEnd(32), (v.endCents / 100).toFixed(2).padStart(10), 'cagr', (v.cagr * 100).toFixed(2), 'mdd', (v.maxDrawdown * 100).toFixed(1), 'fills', v.fills);
