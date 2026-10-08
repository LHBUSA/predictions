#!/usr/bin/env node
// Employment V1, DESCRIPTIVE ONLY: frozen V1 walk-forward forecasts vs Kalshi prices at the same T-1D cutoff, plus an
// independent check of our first-print truth against Kalshi's own settlement. Not a gate, never a feature: Kalshi data is
// read here after every V1 forecast is fixed, and no model is fit on it. V1 verdicts (FAIL/FAIL) are final.
// Rules fixed before any market number was looked at:
//   price      = mid of the last hourly candle ending at or before the cutoff with both yes_bid and yes_ask closes;
//                no such candle -> that contract is NO_PRICE (excluded for every source, never imputed)
//   contracts  = every market whose terms pass employmentTerms (fail closed) for a month that is a scored V1 origin
//   scores     = per event, mean Brier and log loss (floor 1e-4) over its priced contracts; paired event differences;
//                moving-block bootstrap (block 3, 2,000 reps, seed 20261008) for a descriptive 95% CI
//   truth      = our ledger's first print; Kalshi `result` and `expiration_value` are compared with it, never used
//   node scripts/research/employment/compare-kalshi.mjs <raw-kalshi-dir> [out.json]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { blockBootstrap, scoreThresholds } from '../../../src/macro/cpi/scoring.js';
import { buildDataset } from '../../../src/macro/employment/features.js';
import { employmentTerms, yesOutcome } from '../../../src/macro/employment/employment-contract.js';
import { HYPER, PAY_FAMILIES, payLadder, toPayUnits, U3_FAMILIES, u3Ladder } from '../../../src/macro/employment/models.js';

const [dir, out = 'docs/research/employment-v1-kalshi-comparison.json'] = process.argv.slice(2);
const read = (p) => readFileSync(p, 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const files = { releases: 'data/employment/bls-empsit-releases-v1.json', firstPrints: 'data/employment/bls-empsit-first-prints-v1.json', claims: 'data/employment/dol-claims-releases-v1.json' };
const raw = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, read(p)]));
const freeze = JSON.parse(read('data/employment/LEDGER_FREEZE.json'));
for (const [k, p] of Object.entries(files)) if (freeze.files[p]?.sha256 !== sha(raw[k])) throw new Error(`ledger ${p} differs from LEDGER_FREEZE.json`);
const rows = buildDataset({ releases: JSON.parse(raw.releases).releases, claims: JSON.parse(raw.claims).records, firstPrints: JSON.parse(raw.firstPrints).months }).sort((a, b) => a.month.localeCompare(b.month));
const firstPrints = new Map(JSON.parse(raw.firstPrints).months.map((m) => [m.reference_month, m]));

const FLOOR = 1e-4;
const clip = (p) => Math.min(1 - FLOOR, Math.max(FLOOR, p));
const TARGETS = {
  KXU3: { families: U3_FAMILIES, status: (r) => r.u3, y: (r) => r.target.u3, releaseAt: (r) => r.target.u3_release_at, toModel: (strike) => strike, ladder: (r) => u3Ladder(r.anchor_u3), evidence: 'docs/research/employment-v1-u3-evidence.json', best: 'CLAIMS_ONLY', fp: (m) => m.u3 },
  KXPAYROLLS: { families: PAY_FAMILIES, status: (r) => r.payroll, y: (r) => (r.target.payroll_change_k === null ? null : toPayUnits(r.target.payroll_change_k)), releaseAt: (r) => r.target.payroll_release_at, toModel: (strike) => Math.round(strike / 1000) / 10, ladder: () => payLadder(), evidence: 'docs/research/employment-v1-payrolls-evidence.json', best: 'ROLLING_MEAN_GAUSS', fp: (m) => m.payroll_change_k },
};
const resp = (key) => { const f = join(dir, 'responses', `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`); return existsSync(f) ? JSON.parse(read(f)) : null; };
const summary = JSON.parse(read(join(dir, 'summary.json')));
const kalshiManifestSha = sha(read(join(dir, 'manifest.json')));

const report = { generated_from: { ledger_freeze_sha256: sha(read('data/employment/LEDGER_FREEZE.json')), kalshi_manifest_sha256: kalshiManifestSha }, rules: 'see header of scripts/research/employment/compare-kalshi.mjs', series: {} };
for (const [series, T] of Object.entries(TARGETS)) {
  const ev = JSON.parse(read(T.evidence));
  const evByMonth = new Map(ev.per_origin.map((o) => [o.month, o]));
  const usable = rows.filter((r) => T.status(r).status === 'OK' && T.y(r) !== null);
  // quarantined employment-v0 is not compared with the market (it can return null; it lost to every V1 baseline already)
  const models = Object.keys(T.families).filter((m) => m !== 'EMPLOYMENT_V0');
  const events = []; const truthChecks = []; const refused = []; let reproduced = 0;
  for (const s of summary.filter((x) => x.series === series)) {
    const markets = (resp(`hist_markets_${s.event}`)?.markets?.length ? resp(`hist_markets_${s.event}`) : resp(`live_markets_${s.event}`))?.markets || [];
    const fpm = firstPrints.get(s.month);
    // 1) truth agreement, for every finalized market (including months we do not forecast)
    for (const mk of markets) {
      const terms = employmentTerms(mk, {});
      if (!terms.ok) { refused.push({ ticker: mk.ticker, reason: terms.reason }); continue; }
      const f = fpm ? T.fp(fpm) : null;
      const ours = f?.status === 'OK' ? yesOutcome(terms, f.value) : null;
      truthChecks.push({ ticker: mk.ticker, kalshi_result: mk.result ?? null, kalshi_expiration_value: mk.expiration_value ?? null, our_first_print: f?.status === 'OK' ? f.value : `${f?.status ?? 'NO_LEDGER_ROW'}`, our_outcome: ours === null ? null : ours ? 'yes' : 'no', agree: ours === null ? null : (ours ? 'yes' : 'no') === mk.result });
    }
    // 2) forecast comparison at the cutoff, scored origins only
    const origin = usable.find((r) => r.month === s.month);
    const evo = evByMonth.get(s.month);
    if (!origin || !evo) continue;
    const train = usable.filter((r) => r.month < origin.month && T.releaseAt(r) <= origin.cutoff_at);
    if (train.length !== evo.n_train || train.length < HYPER.minTrain) throw new Error(`train set differs from V1 evidence for ${s.month}`);
    const preds = Object.fromEntries(models.map((m) => [m, T.families[m].fit(train)(origin)]));
    // the refit must reproduce the committed V1 forecast for this origin exactly (5 dp of the ladder log loss)
    for (const m of models) {
      if (!preds[m] || !evo[m]) continue;
      const ll = scoreThresholds((t) => preds[m].probAbove(t), T.y(origin), T.ladder(origin)).logLoss;
      if (Math.abs(+ll.toFixed(5) - evo[m].logLoss) > 1e-9) throw new Error(`${series} ${s.month} ${m}: refit ${ll} != V1 evidence ${evo[m].logLoss}`);
    }
    const cut = Math.floor(Date.parse(origin.cutoff_at) / 1000);
    const y = T.y(origin);
    const contracts = [];
    for (const mk of markets) {
      const terms = employmentTerms(mk, {});
      if (!terms.ok) continue;
      const c = resp(`candles_${mk.ticker}_${cut}`)?.candlesticks || [];
      const last = c.filter((k) => k.end_period_ts <= cut && k.yes_bid?.close != null && k.yes_ask?.close != null).at(-1);
      if (!last) { contracts.push({ ticker: mk.ticker, strike: terms.strike, status: 'NO_PRICE' }); continue; }
      const bid = Number(last.yes_bid.close); const ask = Number(last.yes_ask.close);
      const o = yesOutcome(terms, series === 'KXU3' ? origin.target.u3 : origin.target.payroll_change_k) ? 1 : 0;
      const t = T.toModel(terms.strike);
      const p = { MARKET: (bid + ask) / 2, ...Object.fromEntries(models.map((m) => [m, preds[m].probAbove(t)])) };
      contracts.push({ ticker: mk.ticker, strike: terms.strike, status: 'PRICED', candle_end: new Date(last.end_period_ts * 1000).toISOString(), bid, ask, spread: +(ask - bid).toFixed(4), o, p });
    }
    const priced = contracts.filter((c) => c.status === 'PRICED');
    if (!priced.length) { events.push({ event: s.event, month: s.month, priced: 0, contracts: contracts.length }); continue; }
    const src = ['MARKET', ...models];
    const score = Object.fromEntries(src.map((k) => [k, { brier: priced.reduce((a, c) => a + (c.p[k] - c.o) ** 2, 0) / priced.length, logLoss: priced.reduce((a, c) => a - (c.o ? Math.log(clip(c.p[k])) : Math.log(1 - clip(c.p[k]))), 0) / priced.length }]));
    reproduced += 1;
    events.push({ event: s.event, month: s.month, cutoff_at: origin.cutoff_at, y, priced: priced.length, contracts: contracts.length, median_spread: priced.map((c) => c.spread).sort((a, b) => a - b)[Math.floor(priced.length / 2)], score, detail: contracts });
  }
  const scored = events.filter((e) => e.priced > 0).sort((a, b) => a.month.localeCompare(b.month));
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sources = scored.length ? Object.keys(scored[0].score) : [];
  const table = Object.fromEntries(sources.map((k) => [k, { brier: avg(scored.map((e) => e.score[k].brier)), logLoss: avg(scored.map((e) => e.score[k].logLoss)) }]));
  const vsMarket = Object.fromEntries(sources.filter((k) => k !== 'MARKET').map((k) => [k, {
    logLoss: blockBootstrap(scored.map((e) => e.score.MARKET.logLoss - e.score[k].logLoss), { block: 3, reps: 2000, seed: 20261008 }),
    brier: blockBootstrap(scored.map((e) => e.score.MARKET.brier - e.score[k].brier), { block: 3, reps: 2000, seed: 20261008 }),
  }]));
  const disagree = truthChecks.filter((c) => c.agree === false);
  report.series[series] = {
    events_listed: summary.filter((x) => x.series === series).length, events_scored: scored.length, months: scored.length ? [scored[0].month, scored.at(-1).month] : null,
    contracts_priced: scored.reduce((a, e) => a + e.priced, 0), contracts_no_price: events.reduce((a, e) => a + (e.contracts - e.priced), 0), terms_refused: refused,
    truth_agreement: { checked: truthChecks.filter((c) => c.agree !== null).length, agree: truthChecks.filter((c) => c.agree === true).length, disagree, not_checkable: truthChecks.filter((c) => c.agree === null).map((c) => `${c.ticker}:${c.our_first_print}:${c.kalshi_result}`) },
    table, vs_market_gain_positive_means_model_better: vsMarket, best_v1_baseline: T.best, events,
  };
  console.log(JSON.stringify({ series, events_scored: scored.length, months: report.series[series].months, contracts_priced: report.series[series].contracts_priced, refused: refused.length, truth: { checked: report.series[series].truth_agreement.checked, agree: report.series[series].truth_agreement.agree, disagree: disagree.length },
    table: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { brier: +v.brier.toFixed(4), logLoss: +v.logLoss.toFixed(4) }])),
    vs_market_logloss: Object.fromEntries(Object.entries(vsMarket).map(([k, v]) => [k, { gain: +v.logLoss.mean.toFixed(4), ci95: v.logLoss.ci95.map((x) => +x.toFixed(4)) }])) }, null, 1));
}
const json = JSON.stringify(report, null, 1);
writeFileSync(out, json);
console.log('comparison sha256', sha(json));
