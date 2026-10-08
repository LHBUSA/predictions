#!/usr/bin/env node
// Employment V1 (CLOSED), DESCRIPTIVE ONLY: quote-age and executable-price sensitivity of the committed V1-vs-Kalshi
// comparison. Reads docs/research/employment-v1-kalshi-comparison.json (hash-checked), never refits, never changes it.
// Every number here is a sensitivity of a closed result; nothing here is a gate, a feature or a V2 input.
//   unit       = one Employment Situation release (Kalshi event). Per release, mean over its priced contracts; the bootstrap
//                resamples releases (moving block 3, 2,000 reps, seed 20261008), so correlated strikes in one release
//                count once. Differences are CANDIDATE MINUS MARKET (positive = market better).
//   quote age  = cutoff - end of the hourly candle that supplied bid/ask. FRESH = age <= 2 h (Amendment B0).
//   executable = 1 contract per signal, taker. Buy YES at ask if p - ask - fee(ask) > 0; buy NO at (1 - bid) if
//                (bid - p) - fee(1 - bid) > 0. Kalshi quadratic fee: ceil(100 * 0.07 * P * (1 - P)) / 100 per contract
//                (KXU3/KXPAYROLLS series fee_type quadratic_with_maker_fees, multiplier 1, read 2026-10-08).
//   liquidity  = with <raw-kalshi-dir> (manifest hash must match the comparison): volume of the quoting candle and the
//                summed volume of the 24 h before the cutoff, per contract. Historical order-book depth was never captured.
//   node scripts/research/employment/fresh-quote-sensitivity.mjs [raw-kalshi-dir] [out.json]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockBootstrap } from '../../../src/macro/cpi/scoring.js';

const [dir, out = 'docs/research/employment-v1-kalshi-fresh-quote-sensitivity.json'] = process.argv.slice(2);
const SRC = 'docs/research/employment-v1-kalshi-comparison.json';
const SRC_SHA = '5213b69e';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const rawCmp = readFileSync(SRC, 'utf8');
if (!sha(rawCmp).startsWith(SRC_SHA)) throw new Error(`${SRC} is not the committed comparison (${sha(rawCmp)})`);
const cmp = JSON.parse(rawCmp);
if (dir && sha(readFileSync(join(dir, 'manifest.json'), 'utf8')) !== cmp.generated_from.kalshi_manifest_sha256) throw new Error('raw Kalshi manifest differs from the one the comparison used');

const FLOOR = 1e-4;
const FRESH_S = 7200;
const BOOT = { block: 3, reps: 2000, seed: 20261008 };
const FEE = (P) => (P <= 0 || P >= 1 ? 0 : Math.ceil(100 * 0.07 * P * (1 - P) - 1e-9) / 100);
const clip = (p) => Math.min(1 - FLOOR, Math.max(FLOOR, p));
const ll = (p, o) => -(o ? Math.log(clip(p)) : Math.log(1 - clip(p)));
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r4 = (x) => +x.toFixed(4);
const ci = (b) => ({ mean: r4(b.mean), ci95: b.ci95.map(r4), share_of_reps_market_not_worse: r4(b.probNonNegative) });
const ROLE = { KXU3: { V1_CANDIDATE: 'RIDGE_T_EWMA', BEST_BASELINE: 'CLAIMS_ONLY' }, KXPAYROLLS: { V1_CANDIDATE: 'RIDGE_T_EWMA', BEST_BASELINE: 'ROLLING_MEAN_GAUSS' } };

function liquidity(ticker, cutoffAt, candleEnd) {
  if (!dir) return null;
  const cut = Math.floor(Date.parse(cutoffAt) / 1000);
  const f = join(dir, 'responses', `candles_${ticker}_${cut}.json`.replace(/[^A-Za-z0-9._-]/g, '_'));
  if (!existsSync(f)) return null;
  const c = JSON.parse(readFileSync(f, 'utf8')).candlesticks || [];
  const end = Math.floor(Date.parse(candleEnd) / 1000);
  return { quote_candle_volume: Number(c.find((k) => k.end_period_ts === end)?.volume ?? 0), volume_24h_before_cutoff: c.filter((k) => k.end_period_ts <= cut && k.end_period_ts > cut - 86400).reduce((a, k) => a + Number(k.volume || 0), 0) };
}

// per-release scores over a contract filter; returns releases in month order
function releases(events, keep, sources) {
  return events.filter((e) => e.priced > 0).map((e) => {
    const cs = e.detail.filter((c) => c.status === 'PRICED' && keep(c, e));
    if (!cs.length) return null;
    return { month: e.month, n: cs.length, score: Object.fromEntries(sources.map((k) => [k, { logLoss: avg(cs.map((c) => ll(c.p[k], c.o))), brier: avg(cs.map((c) => (c.p[k] - c.o) ** 2)) }])) };
  }).filter(Boolean).sort((a, b) => a.month.localeCompare(b.month));
}

function summarize(rel, sources) {
  const res = { releases: rel.length, contracts: rel.reduce((a, r) => a + r.n, 0), months: rel.length ? [rel[0].month, rel.at(-1).month] : null, mean_log_loss: {}, mean_brier: {}, candidate_minus_market: {} };
  for (const k of sources) { res.mean_log_loss[k] = r4(avg(rel.map((r) => r.score[k].logLoss))); res.mean_brier[k] = r4(avg(rel.map((r) => r.score[k].brier))); }
  for (const k of sources.filter((s) => s !== 'MARKET')) res.candidate_minus_market[k] = {
    log_loss: ci(blockBootstrap(rel.map((r) => r.score[k].logLoss - r.score.MARKET.logLoss), BOOT)),
    brier: ci(blockBootstrap(rel.map((r) => r.score[k].brier - r.score.MARKET.brier), BOOT)),
  };
  return res;
}

const report = { source: { file: SRC, sha256: sha(rawCmp), raw_kalshi_manifest_sha256: dir ? cmp.generated_from.kalshi_manifest_sha256 : null }, rules: 'see header of scripts/research/employment/fresh-quote-sensitivity.mjs', note: 'V1 is CLOSED (FAIL/FAIL). Sensitivity of a closed descriptive comparison; not a gate, not a V2 result.', series: {} };
for (const [series, s] of Object.entries(cmp.series)) {
  const sources = Object.keys(s.table);
  const age = (c, e) => (Date.parse(e.cutoff_at) - Date.parse(c.candle_end)) / 1000;
  const all = releases(s.events, () => true, sources);
  // guard: the unfiltered recomputation must reproduce the committed table exactly
  for (const k of sources) if (Math.abs(avg(all.map((r) => r.score[k].logLoss)) - s.table[k].logLoss) > 1e-12) throw new Error(`${series} ${k}: recomputation differs from committed table`);
  const priced = s.events.filter((e) => e.priced > 0).flatMap((e) => e.detail.filter((c) => c.status === 'PRICED').map((c) => ({ c, e, age: age(c, e) })));
  const ages = priced.map((x) => x.age / 3600).sort((a, b) => a - b);
  const fresh = releases(s.events, (c, e) => age(c, e) <= FRESH_S, sources);
  // executable P&L on fresh quotes, per release = sum over its signals; bootstrap over releases (zero-signal releases count as 0)
  const exec = {};
  for (const k of sources.filter((x) => x !== 'MARKET')) {
    const per = []; let trades = 0; let wins = 0; let fees = 0; const liq = [];
    for (const e of s.events.filter((ev) => ev.priced > 0).sort((a, b) => a.month.localeCompare(b.month))) {
      const cs = e.detail.filter((c) => c.status === 'PRICED' && age(c, e) <= FRESH_S);
      if (!cs.length) continue;
      let pnl = 0;
      for (const c of cs) {
        const p = c.p[k];
        const yesEdge = p - c.ask - FEE(c.ask); const noEdge = (c.bid - p) - FEE(1 - c.bid);
        if (yesEdge <= 0 && noEdge <= 0) continue;
        const buyYes = yesEdge >= noEdge; const price = buyYes ? c.ask : 1 - c.bid; const f = FEE(price);
        const won = buyYes ? c.o === 1 : c.o === 0;
        pnl += (won ? 1 : 0) - price - f; trades += 1; wins += won ? 1 : 0; fees += f;
        const l = liquidity(c.ticker, e.cutoff_at, c.candle_end); if (l) liq.push(l);
      }
      per.push(pnl);
    }
    const b = blockBootstrap(per, BOOT);
    exec[k] = { releases: per.length, trades, win_rate: trades ? r4(wins / trades) : null, fees_paid: r4(fees), pnl_per_release_dollars: { mean: r4(b.mean), ci95: b.ci95.map(r4), share_of_reps_pnl_non_negative: r4(b.probNonNegative) }, pnl_total_dollars: r4(per.reduce((a, x) => a + x, 0)),
      liquidity_of_traded_contracts: liq.length ? { n: liq.length, quote_candle_volume_zero: liq.filter((l) => l.quote_candle_volume === 0).length, median_volume_24h: liq.map((l) => l.volume_24h_before_cutoff).sort((a, b) => a - b)[Math.floor(liq.length / 2)] } : null };
  }
  const spreads = priced.filter((x) => x.age <= FRESH_S).map((x) => x.c.spread).sort((a, b) => a - b);
  report.series[series] = {
    roles: ROLE[series],
    quote_age_hours: { priced_contracts: priced.length, older_than_2h: priced.filter((x) => x.age > FRESH_S).length, median: r4(ages[Math.floor(ages.length / 2)]), p90: r4(ages[Math.floor(0.9 * ages.length)]), max: r4(ages.at(-1)) },
    full_comparison_as_committed: summarize(all, sources),
    fresh_quotes_le_2h: summarize(fresh, sources),
    stale_quotes_gt_2h_only: summarize(releases(s.events, (c, e) => age(c, e) > FRESH_S, sources), sources),
    fresh_spread: { median: spreads[Math.floor(spreads.length / 2)], p90: spreads[Math.floor(0.9 * spreads.length)] },
    executable_fresh_1_contract_taker: exec,
  };
}
const json = JSON.stringify(report, null, 1) + '\n';
writeFileSync(out, json);
for (const [k, v] of Object.entries(report.series)) {
  const pick = (blk) => Object.fromEntries(Object.entries(blk.candidate_minus_market).map(([m, d]) => [m, `${d.log_loss.mean} [${d.log_loss.ci95.join(', ')}] brier ${d.brier.mean} [${d.brier.ci95.join(', ')}]`]));
  console.log(k, JSON.stringify({ age: v.quote_age_hours, full: [v.full_comparison_as_committed.releases, v.full_comparison_as_committed.contracts, v.full_comparison_as_committed.mean_log_loss.MARKET, pick(v.full_comparison_as_committed)], fresh: [v.fresh_quotes_le_2h.releases, v.fresh_quotes_le_2h.contracts, v.fresh_quotes_le_2h.mean_log_loss, pick(v.fresh_quotes_le_2h)], stale: [v.stale_quotes_gt_2h_only.releases, v.stale_quotes_gt_2h_only.contracts], spread: v.fresh_spread, exec: v.executable_fresh_1_contract_taker }, null, 1));
}
console.log('sha256', sha(json));
