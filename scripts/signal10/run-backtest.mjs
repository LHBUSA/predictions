// Signal 10 historical replay (origin=HISTORICAL_REPLAY). Deterministic: same dataset hash -> same ledger hash.
// node scripts/signal10/run-backtest.mjs --cutoff 2026-10-08 [--start 2018-01-02] [--out data/signal10]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadComponents } from '../../src/signal10/universe.js';
import { rankUniverse } from '../../src/signal10/rank.js';
import { prepareMarket, runAccount, runBenchmark, metrics, periodReturns, regimeAt } from '../../src/signal10/backtest.js';
import { mark } from '../../src/signal10/portfolio.js';
import { MODEL_VERSION, POLICY_VERSION, RANK, MANAGER, DISCLOSURE } from '../../src/signal10/policy.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', process.env.SIGNAL10_CACHE || 'E:/Workers/cache/signal10');
const CUTOFF = arg('--cutoff');
const START = arg('--start', '2018-01-02');
const OUT = arg('--out', 'data/signal10');
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

const t0 = Date.now();
const datasetRaw = fs.readFileSync(path.join(CACHE, `dataset-${CUTOFF}.json`), 'utf8');
const dataset = JSON.parse(datasetRaw);
const coverage = JSON.parse(fs.readFileSync(path.join(CACHE, `coverage-${CUTOFF}.json`), 'utf8'));
const components = loadComponents(fs.readFileSync(path.join(CACHE, 'raw/universe/components.csv'), 'utf8'));
const mkt = prepareMarket(dataset, components);
const days = mkt.calendar.filter((d) => d >= START && d <= CUTOFF);
const snapshots = new Map();
for (const d of days) snapshots.set(d, rankUniverse(d, mkt.universeOn(d), mkt.prepared));
const t1 = Date.now();

const run = (opts) => runAccount(mkt, { start: START, end: CUTOFF, snapshots, ...opts });
const primary = run({});
const comparator = run({ origin: 'COMPARATOR_IMMEDIATE_TOP10', mode: 'IMMEDIATE' });
const spy = runBenchmark(mkt, 'SPY', { start: START, end: CUTOFF });
const qqq = runBenchmark(mkt, 'QQQ', { start: START, end: CUTOFF });
const sensitivity = [0, 10, 25, 50].map((bps) => ({ slippageBps: bps, ...metrics(run({ slippageBps: bps }).nav) }));
// inception cohorts: same rules, funded on the first session of each year
const cohorts = [];
for (let y = Number(START.slice(0, 4)); y <= Number(CUTOFF.slice(0, 4)); y++) {
  const s = days.find((d) => d.startsWith(String(y))); if (!s) continue;
  const a = runAccount(mkt, { start: s, end: CUTOFF, snapshots });
  const b = runBenchmark(mkt, 'SPY', { start: s, end: CUTOFF }), c = runBenchmark(mkt, 'QQQ', { start: s, end: CUTOFF });
  cohorts.push({ inception: s, strategy: metrics(a.nav), spy: metrics(b.nav), qqq: metrics(c.nav) });
}
const t2 = Date.now();

// ---- contributions per symbol (realized + unrealized + dividends) ----
const st = primary.state;
const last = mark(st, CUTOFF, mkt.prepared);
const contrib = {};
const add = (s, k, v) => { contrib[s] ||= { symbol: s, realizedCents: 0, unrealizedCents: 0, dividendsCents: 0, buys: 0, sells: 0 }; contrib[s][k] += v; };
for (const e of st.events) {
  if (e.type === 'FILL' && e.side === 'SELL') { add(e.symbol, 'realizedCents', e.realizedCents); add(e.symbol, 'sells', 1); }
  if (e.type === 'FILL' && e.side === 'BUY') add(e.symbol, 'buys', 1);
  if (e.type === 'DIVIDEND') add(e.symbol, 'dividendsCents', e.cashCents);
  if (e.type === 'DELIST_LIQUIDATION') add(e.symbol, 'realizedCents', e.realizedCents);
}
for (const p of last.positions) add(p.symbol, 'unrealizedCents', p.valueCents - p.costCents);
const contribList = Object.values(contrib).map((c) => ({ ...c, name: mkt.prepared.get(c.symbol)?.name, totalCents: c.realizedCents + c.unrealizedCents + c.dividendsCents })).sort((a, b) => b.totalCents - a.totalCents);

// ---- independent reconciliation: replay the cash ledger from events only ----
let cash = 0; const qty = {};
for (const e of st.events) {
  if (e.type === 'FUNDING') cash += e.cashCents;
  if (e.type === 'FILL') { cash += e.side === 'BUY' ? -e.notionalCents : e.notionalCents; qty[e.symbol] = (qty[e.symbol] || 0) + (e.side === 'BUY' ? e.qty : -e.qty); }
  if (e.type === 'DIVIDEND') cash += e.cashCents;
  if (e.type === 'SPLIT') { cash += e.cashInLieuCents; qty[e.symbol] = e.qtyAfter; }
  if (e.type === 'DELIST_LIQUIDATION') { cash += e.proceedsCents; qty[e.symbol] = 0; }
}
const replayNav = cash + Object.entries(qty).filter(([, q]) => q).reduce((s, [sym, q]) => s + last.positions.find((p) => p.symbol === sym).valueCents, 0);
const reconciliation = { engineNavCents: last.navCents, ledgerReplayNavCents: replayNav, cashMatches: cash === st.cashCents, navMatches: replayNav === last.navCents,
  qtyMatches: Object.entries(qty).filter(([, q]) => q).every(([s, q]) => st.positions[s]?.qty === q) };
if (!reconciliation.navMatches || !reconciliation.cashMatches || !reconciliation.qtyMatches) throw new Error('RECONCILIATION FAILED ' + JSON.stringify(reconciliation));

// ---- artifacts ----
const ledger = st.events.filter((e) => e.type !== 'DECISION');
const decisions = st.events.filter((e) => e.type === 'DECISION');
const navSeries = primary.nav.map((x, i) => ({ d: x.d, nav: x.nav, cash: x.cash, n: x.n, spy: spy.nav[i].nav, qqq: qqq.nav[i].nav, cmp: comparator.nav[i].nav }));
const rankHistory = days.map((d) => [d, snapshots.get(d).eligible, snapshots.get(d).ranks.slice(0, 10).map((r) => [r.symbol, r.score])]);
const fillsCount = ledger.filter((e) => e.type === 'FILL').length;
const yearsAvgNav = navSeries.reduce((s, x) => s + x.nav, 0) / navSeries.length;
const summary = {
  schema: 'signal10-backtest/1', origin: 'HISTORICAL_REPLAY', label: 'BACKTEST · HYPOTHETICAL · RECONSTRUCTED HISTORY', disclosure: DISCLOSURE,
  model: MODEL_VERSION, policy: POLICY_VERSION, rank_params: RANK, manager_params: MANAGER,
  generated_at: new Date().toISOString(), data_cutoff: CUTOFF, start: START,
  dataset_sha256: sha(datasetRaw), ledger_sha256: sha(ledger), nav_sha256: sha(navSeries),
  coverage: { by_year: coverage.by_year, symbols_with_data: coverage.symbols_with_data, universe_tickers: coverage.universe_tickers_2016,
    uncovered_top: coverage.uncovered_member_days.slice(0, 60), universe_last_row: dataset.universe_source.last_row },
  strategy: { ...metrics(primary.nav), dividendsCents: st.dividendsCents, slippageCents: st.slippageCents, realizedCents: st.realizedCents,
    unrealizedCents: last.positions.reduce((s, p) => s + p.valueCents - p.costCents, 0), cashCents: st.cashCents, fills: fillsCount,
    turnoverPerYear: (st.tradedCents / 2) / yearsAvgNav / Math.max(1, metrics(primary.nav).years),
    avgInvestedPct: navSeries.reduce((s, x) => s + (1 - x.cash / x.nav), 0) / navSeries.length },
  benchmarks: { SPY: { ...metrics(spy.nav), basis: 'whole shares bought at the first fill-session open (+10 bps), dividends to cash', firstFill: spy.state.events.find((e) => e.type === 'FILL') },
    QQQ: { ...metrics(qqq.nav), basis: 'same convention as SPY', firstFill: qqq.state.events.find((e) => e.type === 'FILL') } },
  comparator: { ...metrics(comparator.nav), label: 'IMMEDIATELY INVESTED STATIC TOP-10 (same ranks, buys top 10 at once, exits only on rank > 30 / ineligible, no timing, no regime, no stops)' },
  monthly: periodReturns(primary.nav, 7).map((m, i) => ({ ...m, spy: periodReturns(spy.nav, 7)[i].returnPct, qqq: periodReturns(qqq.nav, 7)[i].returnPct })),
  annual: periodReturns(primary.nav, 4).map((m, i) => ({ ...m, spy: periodReturns(spy.nav, 4)[i].returnPct, qqq: periodReturns(qqq.nav, 4)[i].returnPct, cmp: periodReturns(comparator.nav, 4)[i].returnPct })),
  cohorts, sensitivity, contributions: contribList, reconciliation,
  final_holdings: last.positions.map((p) => ({ ...p, name: mkt.prepared.get(p.symbol).name, entryDate: st.positions[p.symbol].entryDate })),
  final_pending: st.pending,
  timings_ms: { rank_all_days: t1 - t0, runs: t2 - t1 }
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'backtest-summary.json'), JSON.stringify(summary));
fs.writeFileSync(path.join(OUT, 'backtest-nav.json'), JSON.stringify({ origin: 'HISTORICAL_REPLAY', fields: ['d', 'nav', 'cash', 'n', 'spy', 'qqq', 'cmp'], rows: navSeries.map((x) => [x.d, x.nav, x.cash, x.n, x.spy, x.qqq, x.cmp]) }));
fs.writeFileSync(path.join(OUT, 'backtest-ledger.json'), JSON.stringify({ origin: 'HISTORICAL_REPLAY', ledger_sha256: summary.ledger_sha256, events: ledger }));
fs.writeFileSync(path.join(OUT, 'backtest-ranks.json'), JSON.stringify({ origin: 'HISTORICAL_REPLAY', model: MODEL_VERSION, rows: rankHistory }));
fs.writeFileSync(path.join(CACHE, `backtest-decisions-${CUTOFF}.json`), JSON.stringify(decisions));
const pct = (x) => x == null ? null : Math.round(x * 10000) / 100;
console.log(JSON.stringify({
  secs: [(t1 - t0) / 1000, (t2 - t1) / 1000], ledger_sha256: summary.ledger_sha256, fills: fillsCount,
  strategy: { end: summary.strategy.endCents / 100, total: pct(summary.strategy.totalReturn), cagr: pct(summary.strategy.cagr), mdd: pct(summary.strategy.maxDrawdown), invested: pct(summary.strategy.avgInvestedPct), turnover: summary.strategy.turnoverPerYear.toFixed(2) },
  spy: { end: summary.benchmarks.SPY.endCents / 100, cagr: pct(summary.benchmarks.SPY.cagr), mdd: pct(summary.benchmarks.SPY.maxDrawdown) },
  qqq: { end: summary.benchmarks.QQQ.endCents / 100, cagr: pct(summary.benchmarks.QQQ.cagr), mdd: pct(summary.benchmarks.QQQ.maxDrawdown) },
  cmp: { end: summary.comparator.endCents / 100, cagr: pct(summary.comparator.cagr), mdd: pct(summary.comparator.maxDrawdown) },
  annual: summary.annual.map((a) => `${a.period}: ${pct(a.returnPct)} spy ${pct(a.spy)} qqq ${pct(a.qqq)} cmp ${pct(a.cmp)}`),
  sensitivity: sensitivity.map((s) => `${s.slippageBps}bps cagr ${pct(s.cagr)}`),
  cohorts: cohorts.map((c) => `${c.inception}: ${pct(c.strategy.totalReturn)} vs spy ${pct(c.spy.totalReturn)} qqq ${pct(c.qqq.totalReturn)}`),
  negMonths: summary.monthly.filter((m) => m.returnPct < 0).length, months: summary.monthly.length,
  holdings: summary.final_holdings.map((h) => h.symbol), reconciliation
}, null, 1));
