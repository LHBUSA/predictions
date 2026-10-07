// Prospective intraday score report (designation-intraday/1) from the production admin route.
//   node scripts/ops/intraday-score-report.mjs [--run] [--json]
//   node scripts/ops/intraday-score-report.mjs --rows scores.json   (rows exported from pred_intraday_scores; no token)
// Token: env PBE_ADMIN_TOKEN or D:\Workers\secrets\pbe-predictions-admin-token. --run first POSTs the lane (writes).
import { readFileSync } from 'node:fs';
import { intradayScoreReport } from '../../src/engine/intraday-designations.js';
const BASE = process.env.PBE_PREDICTIONS_ORIGIN || 'https://pbe-predictions.sales-fd3.workers.dev';
const ri = process.argv.indexOf('--rows');
let rep;
if (ri > 0) rep = intradayScoreReport(JSON.parse(readFileSync(process.argv[ri + 1], 'utf8')));
else {
  const token = (process.env.PBE_ADMIN_TOKEN || readFileSync('D:/Workers/secrets/pbe-predictions-admin-token', 'utf8')).trim();
  const h = { authorization: `Bearer ${token}` };
  if (process.argv.includes('--run')) {
    const r = await fetch(`${BASE}/admin/intraday/scores?dry_run=0`, { method: 'POST', headers: h });
    console.log('run:', JSON.stringify(await r.json()));
  }
  const res = await fetch(`${BASE}/admin/intraday/scores`, { headers: h });
  if (!res.ok) { console.error(res.status, await res.text()); process.exit(1); }
  rep = await res.json();
}
if (process.argv.includes('--json')) { console.log(JSON.stringify(rep, null, 2)); process.exit(0); }
const f = (x, d = 4) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const line = (r) => `| ${r.key} | ${r.n} | ${r.contracts} | ${r.climate_days} | ${r.stations} | ${f(r.mean_p, 3)} | ${f(r.yes_rate, 3)} | ${f(r.pbe_brier)} | ${f(r.pbe_log_loss)} | ${r.benchmark_n} | ${r.paired ? `${f(r.paired.pbe_brier)} / ${f(r.paired.market_brier)}` : '—'} | ${r.paired ? `${f(r.paired.pbe_log_loss)} / ${f(r.paired.market_log_loss)}` : '—'} |`;
console.log(`# Intraday prospective scores (${rep.rules})\n\nscored designations: ${rep.scored_designations}; coverage: ${JSON.stringify(rep.coverage)}\n\n${rep.note}`);
for (const [dim, rows] of Object.entries(rep.by)) {
  console.log(`\n## by ${dim}\n\n| key | n | contracts | days | stations | mean p | yes rate | PBE Brier | PBE log loss | bench n | paired Brier PBE / mkt | paired LL PBE / mkt |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const r of rows) console.log(line(r));
}
