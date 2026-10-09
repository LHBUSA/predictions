// Signal 10 historical replay + benchmarks + metrics (pure, deterministic).
// Timeline per session d: corporate actions (pre-open) -> delistings -> fills of orders decided at the previous close
// (at d's OPEN) -> close: rank the point-in-time universe, mark NAV, decide orders for the next open.
import { prepareSeries, rankUniverse } from './rank.js';
import { newAccount, corporateActions, delistings, execute, mark, decide, emit } from './portfolio.js';
import { membersOn } from './universe.js';
import { resolveSymbol } from './aliases.js';
import { MANAGER } from './policy.js';

export function prepareMarket(dataset, components) {
  const calIndex = new Map(dataset.calendar.map((d, i) => [d, i]));
  const prepared = new Map();
  for (const [sym, s] of Object.entries(dataset.series)) prepared.set(sym, prepareSeries(s, calIndex));
  const universeOn = (d) => {
    const row = membersOn(components, d);
    return row ? row.tickers.map((t) => ({ ticker: t, symbol: resolveSymbol(t, d) })) : [];
  };
  return { calendar: dataset.calendar, calIndex, prepared, universeOn };
}

export function regimeAt(mkt, d) {
  const p = mkt.prepared.get('SPY'); const i = p.idx.get(d);
  if (i == null || i < 199) return { riskOn: false, reason: 'no SPY data' };
  const s200 = (p.ps[i + 1] - p.ps[i - 199]) / 200;
  return { riskOn: p.adj[i] >= s200, spyAdj: p.adj[i], spySma200: s200 };
}

// Run one account from decision date `start` (funding at its close) through `end`.
export function runAccount(mkt, { start, end, origin = 'HISTORICAL_REPLAY', mode = 'MANAGER', snapshots, slippageBps }) {
  const st = newAccount({ origin, inception: start, slippageBps });
  const nav = [];
  const cal = mkt.calendar.filter((d) => d >= start && d <= end);
  for (const d of cal) {
    if (d !== start) {
      corporateActions(st, d, mkt.prepared);
      delistings(st, d, mkt.calIndex, mkt.prepared);
      execute(st, d, mkt.prepared);
      st.fillSessions += 1; // session N after funding (N <= 10 = initial deployment window)
    }
    const snap = snapshots ? snapshots.get(d) : rankUniverse(d, mkt.universeOn(d), mkt.prepared);
    const m = mark(st, d, mkt.prepared);
    decide(st, d, snap, regimeAt(mkt, d), m, mkt.prepared, { mode });
    nav.push({ d, nav: m.navCents, cash: m.cashCents, mv: m.marketValueCents, n: m.positions.length, stale: m.stale.length, window: Math.min(st.fillSessions, MANAGER.initialWindowSessions + 1) });
  }
  return { state: st, nav };
}

// Buy-and-hold benchmark: whole shares with the full $10,000 at the first fill session OPEN (same slippage), dividends
// to cash (not reinvested), same convention as the strategy.
export function runBenchmark(mkt, symbol, { start, end, slippageBps }) {
  const st = newAccount({ origin: `BENCHMARK_${symbol}`, inception: start, slippageBps });
  const cal = mkt.calendar.filter((d) => d >= start && d <= end);
  const nav = [];
  st.pending = [emit(st, { type: 'ORDER', d: start, side: 'BUY', symbol, ticker: symbol, targetCents: st.cashCents, reason: 'BENCHMARK buy-and-hold' })];
  for (const d of cal) {
    if (d !== start) { corporateActions(st, d, mkt.prepared); execute(st, d, mkt.prepared); }
    const m = mark(st, d, mkt.prepared);
    nav.push({ d, nav: m.navCents, cash: m.cashCents });
  }
  return { state: st, nav };
}

// --- metrics ----------------------------------------------------------------------------------------------------
export function metrics(nav, start = MANAGER.startingCashCents) {
  const last = nav.at(-1);
  let peak = start, peakD = nav[0].d, mdd = 0, mddPeak = null, mddTrough = null;
  const rets = [];
  let prev = start;
  for (const x of nav) {
    rets.push(x.nav / prev - 1); prev = x.nav;
    if (x.nav > peak) { peak = x.nav; peakD = x.d; }
    const dd = x.nav / peak - 1;
    if (dd < mdd) { mdd = dd; mddPeak = peakD; mddTrough = x.d; }
  }
  const days = (Date.parse(last.d) - Date.parse(nav[0].d)) / 864e5;
  const years = days / 365.25;
  const total = last.nav / start - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return {
    start: nav[0].d, end: last.d, startCents: start, endCents: last.nav, gainCents: last.nav - start,
    totalReturn: total, years: Math.round(years * 100) / 100, cagr: years >= 1 ? (1 + total) ** (1 / years) - 1 : null,
    maxDrawdown: mdd, maxDrawdownPeak: mddPeak, maxDrawdownTrough: mddTrough,
    volAnnual: sd * Math.sqrt(252), sharpe0: sd > 0 ? (mean / sd) * Math.sqrt(252) : null
  };
}

// Month-end (and year-end) compounded returns from daily NAV; the first period starts from the $10,000 funding.
export function periodReturns(nav, keyLen, start = MANAGER.startingCashCents) {
  const out = []; let prevEnd = start; let cur = null;
  for (const x of nav) {
    const k = x.d.slice(0, keyLen);
    if (!cur || cur.period !== k) { if (cur) { out.push(cur); prevEnd = cur.endCents; } cur = { period: k, startCents: prevEnd, endCents: x.nav, endDate: x.d }; }
    else { cur.endCents = x.nav; cur.endDate = x.d; }
  }
  if (cur) out.push(cur);
  for (const p of out) { p.returnPct = p.endCents / p.startCents - 1; p.gainCents = p.endCents - p.startCents; }
  return out;
}
