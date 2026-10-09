// PBE Signal 10 engine, manager, accounting and forward-lane acceptance tests (issue #52). Deterministic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSeries, rankUniverse, features, percentiles } from '../src/signal10/rank.js';
import { newAccount, corporateActions, execute, mark, decide, delistings } from '../src/signal10/portfolio.js';
import { runAccount, runBenchmark, metrics, periodReturns } from '../src/signal10/backtest.js';
import { parseYahooChart } from '../src/signal10/data.js';
import { resolveSymbol, BLOCKED_SYMBOLS } from '../src/signal10/aliases.js';
import { membersOn, loadComponents } from '../src/signal10/universe.js';
import { nyClock, due, navFromQuotes, canonical, sha256Hex, quoteFromChart } from '../src/signal10/forward.js';
import { MANAGER, RANK } from '../src/signal10/policy.js';

// ---------- synthetic market ----------
function calendar(n, start = '2020-01-01') {
  const out = []; let t = Date.parse(start + 'T00:00:00Z');
  while (out.length < n) { const d = new Date(t); const w = d.getUTCDay(); if (w && w !== 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; }
  return out;
}
// price path: drift per bar, optional overrides { idx: price }
function series(sym, cal, { p0 = 50, drift = 0.001, wiggle = 0.004, vol = 2e6, overrides = {}, splits = [], dividends = [], dropFrom = null, phase = 0 } = {}) {
  const bars = []; let p = p0;
  cal.forEach((d, i) => {
    if (dropFrom != null && i >= dropFrom) return;
    p = overrides[i] ?? p * (1 + drift + wiggle * Math.sin(i / 3 + phase));
    bars.push({ d, o: +(p * 0.999).toFixed(6), h: +(p * 1.01).toFixed(6), l: +(p * 0.99).toFixed(6), c: +p.toFixed(6), adj: +p.toFixed(6), v: vol });
  });
  return { symbol: sym, name: sym + ' Inc', bars, splits, dividends };
}
function market(seriesList, cal) {
  const calIndex = new Map(cal.map((d, i) => [d, i]));
  const prepared = new Map(seriesList.map((s) => [s.symbol, prepareSeries(s, calIndex)]));
  return { calendar: cal, calIndex, prepared, universeOn: () => seriesList.filter((s) => s.symbol !== 'SPY' && s.symbol !== 'QQQ').map((s) => ({ ticker: s.symbol, symbol: s.symbol })) };
}
const CAL = calendar(420);
const names = Array.from({ length: 30 }, (_, k) => series(`S${String(k).padStart(2, '0')}`, CAL, { drift: 0.0002 + k * 0.00005, phase: k }));
const BASE = [series('SPY', CAL, { p0: 300, drift: 0.0005 }), series('QQQ', CAL, { p0: 250, drift: 0.0006 }), ...names];

test('percentiles: ties share the average rank; single value = 1', () => {
  assert.deepEqual(percentiles([3, 1, 3, 2]), [5 / 6, 0, 5 / 6, 1 / 3]);
  assert.deepEqual(percentiles([7]), [1]);
});

test('future bars never change a past rank snapshot (no look-ahead)', () => {
  const D = CAL[300];
  const full = market(BASE, CAL);
  const cut = market(BASE.map((s) => ({ ...s, bars: s.bars.filter((b) => b.d <= D) })), CAL.filter((d) => d <= D));
  const a = rankUniverse(D, full.universeOn(D), full.prepared), b = rankUniverse(D, cut.universeOn(D), cut.prepared);
  assert.deepEqual(a.ranks.map((r) => [r.symbol, r.score]), b.ranks.map((r) => [r.symbol, r.score]));
  // a future crash in the full series must not move the D snapshot either
  const crashed = market(BASE.map((s) => s.symbol === 'S29' ? series('S29', CAL, { drift: 0.0002 + 29 * 0.00005, phase: 29, overrides: { 350: 1 } }) : s), CAL);
  assert.deepEqual(rankUniverse(D, crashed.universeOn(D), crashed.prepared).ranks.map((r) => r.symbol), a.ranks.map((r) => r.symbol));
});

test('eligibility: insufficient history, price < $5 and illiquid names are excluded with reasons', () => {
  const cal = CAL;
  const young = series('YOUNG', cal, { dropFrom: null }); young.bars = young.bars.slice(-100);
  const penny = series('PENNY', cal, { p0: 2, drift: 0 });
  const thin = series('THIN', cal, { vol: 10 });
  const mk = market([BASE[0], young, penny, thin, names[0]], cal);
  const s = rankUniverse(cal[400], mk.universeOn(), mk.prepared);
  assert.equal(s.excluded.insufficient_history, 1);
  assert.equal(s.excluded.price_below_5, 1);
  assert.equal(s.excluded.illiquid, 1);
  assert.deepEqual(s.ranks.map((r) => r.symbol), ['S00']);
  assert.equal(features(mk.prepared.get('S00'), 100).reason, 'insufficient_history');
});

test('rank ties break deterministically by symbol', () => {
  const a = series('AAA', CAL), b = series('BBB', CAL); b.symbol = 'BBB';
  const mk = market([BASE[0], b, a], CAL);
  const s = rankUniverse(CAL[400], mk.universeOn(), mk.prepared);
  assert.deepEqual(s.ranks.map((r) => r.symbol), ['AAA', 'BBB']);
});

test('replay: deterministic, cash never negative, whole shares, every fill on a later session open, NAV reconciles', () => {
  const mk = market(BASE, CAL);
  const run = () => runAccount(mk, { start: CAL[260], end: CAL[419] });
  const a = run(), b = run();
  assert.equal(JSON.stringify(a.state.events), JSON.stringify(b.state.events));
  let cash = 0;
  const orderD = new Map();
  for (const e of a.state.events) {
    if (e.type === 'ORDER') orderD.set(e.seq, e.d);
    if (e.type === 'FUNDING') cash += e.cashCents;
    if (e.type === 'FILL') {
      assert.ok(Number.isInteger(e.qty) && e.qty > 0);
      assert.ok(e.d > orderD.get(e.orderSeq), 'fills strictly after the decision close');
      const p = mk.prepared.get(e.symbol); assert.equal(e.open, p.o[p.idx.get(e.d)], 'fill at that session OPEN');
      assert.equal(e.price, Math.round(e.open * (1 + (e.side === 'BUY' ? 1 : -1) * MANAGER.slippageBps / 1e4) * 1e4) / 1e4);
      cash += e.side === 'BUY' ? -e.notionalCents : e.notionalCents;
      assert.ok(cash >= 0);
    }
    if (e.type === 'DIVIDEND') cash += e.cashCents;
  }
  assert.equal(cash, a.state.cashCents);
  const m = mark(a.state, CAL[419], mk.prepared);
  assert.equal(m.navCents, a.nav.at(-1).nav);
  assert.ok(Object.keys(a.state.positions).length <= MANAGER.maxPositions);
});

test('staged entry: never more than 3 new names per session and no forced buy at the end of the 10-session window', () => {
  const mk = market(BASE, CAL);
  const a = runAccount(mk, { start: CAL[260], end: CAL[300] });
  const perDay = {};
  for (const e of a.state.events) if (e.type === 'FILL' && e.side === 'BUY' && /^BUY /.test(e.reason)) perDay[e.d] = (perDay[e.d] || 0) + 1;
  assert.ok(Object.values(perDay).every((n) => n <= MANAGER.maxNewBuysPerSession));
  // a market where nothing is in an uptrend: the account must stay 100% cash through and after the window
  const down = [series('SPY', CAL, { p0: 300, drift: 0.0005 }), ...Array.from({ length: 12 }, (_, k) => series(`D${k}`, CAL, { drift: -0.002 - k * 0.0001, phase: k }))];
  const mkd = market(down, CAL);
  const r = runAccount(mkd, { start: CAL[260], end: CAL[300] });
  assert.equal(r.state.events.filter((e) => e.type === 'FILL').length, 0);
  assert.equal(r.state.cashCents, MANAGER.startingCashCents);
  assert.ok(r.state.events.some((e) => e.type === 'DECISION' && e.action === 'WAIT' && /uptrend/.test(e.reason)));
  assert.ok(r.state.fillSessions > MANAGER.initialWindowSessions);
});

test('risk-off regime: no new names while SPY is below its 200-day average', () => {
  const spyDown = series('SPY', CAL, { p0: 300, drift: -0.001 });
  const mk = market([spyDown, ...names], CAL);
  const r = runAccount(mk, { start: CAL[260], end: CAL[300] });
  assert.equal(r.state.events.filter((e) => e.type === 'FILL' && e.side === 'BUY').length, 0);
  assert.ok(r.state.events.some((e) => e.type === 'DECISION' && /risk-off/.test(e.reason)));
});

test('missing open on the execution session: the order EXPIRES (no fill at any other price)', () => {
  const mk = market(BASE, CAL);
  const st = newAccount({ origin: 'HISTORICAL_REPLAY', inception: CAL[300] });
  st.pending = [{ seq: 99, side: 'BUY', symbol: 'GHOST', ticker: 'GHOST', targetCents: 100000, reason: 'test' }];
  execute(st, CAL[301], mk.prepared);
  assert.equal(st.events.at(-1).type, 'ORDER_EXPIRED');
  assert.equal(st.cashCents, MANAGER.startingCashCents);
});

test('insufficient cash for one whole share: ORDER_UNFILLED, cash untouched', () => {
  const big = series('BIG', CAL, { p0: 20000, drift: 0 });
  const mk = market([BASE[0], big], CAL);
  const st = newAccount({ origin: 'HISTORICAL_REPLAY', inception: CAL[300] });
  st.pending = [{ seq: 5, side: 'BUY', symbol: 'BIG', ticker: 'BIG', targetCents: 100000, reason: 'test' }];
  execute(st, CAL[301], mk.prepared);
  assert.equal(st.events.at(-1).type, 'ORDER_UNFILLED');
  assert.equal(st.cashCents, MANAGER.startingCashCents);
});

test('sell-before-buy: proceeds from a sale fund a buy in the same session', () => {
  const mk = market(BASE, CAL);
  const st = newAccount({ origin: 'HISTORICAL_REPLAY', inception: CAL[300] });
  st.pending = [{ seq: 1, side: 'BUY', symbol: 'S00', ticker: 'S00', targetCents: 990000, reason: 'seed' }];
  execute(st, CAL[301], mk.prepared);
  const cashAfterSeed = st.cashCents;
  assert.ok(cashAfterSeed < 50000);
  st.pending = [{ seq: 3, side: 'BUY', symbol: 'S01', ticker: 'S01', targetCents: 500000, reason: 'rotate in' }, { seq: 2, side: 'SELL', symbol: 'S00', ticker: 'S00', qty: st.positions.S00.qty, reason: 'rotate out' }];
  execute(st, CAL[302], mk.prepared);
  const fills = st.events.filter((e) => e.type === 'FILL' && e.d === CAL[302]);
  assert.deepEqual(fills.map((f) => f.side), ['SELL', 'BUY']);
  assert.ok(st.positions.S01.qty > 0 && !st.positions.S00);
});

test('split + dividend: share count follows the split, dividend paid once on the ex-date, NAV continuous (no double count)', () => {
  const cal = CAL.slice(0, 60);
  const raw = series('SPL', cal, { p0: 100, drift: 0, wiggle: 0 });
  // 2-for-1 split effective cal[30]: unadjusted price halves from that session on
  raw.bars = raw.bars.map((b, i) => (i >= 30 ? { ...b, o: b.o / 2, h: b.h / 2, l: b.l / 2, c: b.c / 2 } : b));
  raw.splits = [{ d: cal[30], ratio: 2 }];
  raw.dividends = [{ d: cal[40], amount: 0.5 }];
  const mk = market([series('SPY', cal), raw], cal);
  const st = newAccount({ origin: 'HISTORICAL_REPLAY', inception: cal[10] });
  st.pending = [{ seq: 1, side: 'BUY', symbol: 'SPL', ticker: 'SPL', targetCents: 100000, reason: 't' }];
  execute(st, cal[11], mk.prepared);
  const q0 = st.positions.SPL.qty, cost = st.positions.SPL.costCents;
  const before = mark(st, cal[29], mk.prepared).navCents;
  corporateActions(st, cal[30], mk.prepared);
  assert.equal(mark(st, cal[30], mk.prepared).navCents, before, 'NAV unchanged across the split');
  for (let i = 31; i <= 45; i++) corporateActions(st, cal[i], mk.prepared);
  assert.equal(st.positions.SPL.qty, q0 * 2);
  assert.equal(st.positions.SPL.costCents, cost, 'split does not change cost basis');
  const divs = st.events.filter((e) => e.type === 'DIVIDEND');
  assert.equal(divs.length, 1);
  assert.equal(divs[0].cashCents, Math.round(q0 * 2 * 0.5 * 100));
  assert.equal(mark(st, cal[45], mk.prepared).navCents, before + divs[0].cashCents, 'dividend counted exactly once');
});

test('reverse split leaving a fraction pays cash in lieu at the open', () => {
  const cal = CAL.slice(0, 40);
  const r = series('REV', cal, { p0: 10, drift: 0, wiggle: 0 });
  r.bars = r.bars.map((b, i) => (i >= 20 ? { ...b, o: b.o * 3, c: b.c * 3, h: b.h * 3, l: b.l * 3 } : b));
  r.splits = [{ d: cal[20], ratio: 1 / 3 }];
  const mk = market([series('SPY', cal), r], cal);
  const st = newAccount({ origin: 'HISTORICAL_REPLAY', inception: cal[5] });
  st.positions.REV = { qty: 100, costCents: 100000, entryDate: cal[5], peakAdj: 10 };
  corporateActions(st, cal[20], mk.prepared);
  assert.equal(st.positions.REV.qty, 33);
  const ev = st.events.find((e) => e.type === 'SPLIT');
  assert.equal(ev.cashInLieuCents, Math.round((100 / 3 - 33) * mk.prepared.get('REV').o[20] * 100));
});

test('delisted holding: liquidated at the last observed close, flagged as an estimate', () => {
  const gone = series('GONE', CAL, { dropFrom: 305 });
  const mk = market([BASE[0], gone], CAL);
  const st = newAccount({ origin: 'HISTORICAL_REPLAY', inception: CAL[290] });
  st.positions.GONE = { qty: 10, costCents: 50000, entryDate: CAL[291], peakAdj: 1 };
  delistings(st, CAL[306], mk.calIndex, mk.prepared); assert.ok(st.positions.GONE, 'not before N missing sessions');
  delistings(st, CAL[308], mk.calIndex, mk.prepared);
  const ev = st.events.find((e) => e.type === 'DELIST_LIQUIDATION');
  assert.equal(ev.price, mk.prepared.get('GONE').c.at(-1));
  assert.match(ev.flag, /ESTIMATE/);
  assert.ok(!st.positions.GONE);
});

test('benchmark: whole shares at the first fill-session open, residual cash kept, same slippage', () => {
  const mk = market(BASE, CAL);
  const b = runBenchmark(mk, 'SPY', { start: CAL[260], end: CAL[280] });
  const f = b.state.events.find((e) => e.type === 'FILL');
  assert.equal(f.d, CAL[261]);
  assert.equal(f.qty, Math.floor(1_000_000 / (f.price * 100)));
  assert.equal(b.state.cashCents, 1_000_000 - f.notionalCents);
});

test('metrics: monthly returns compound to the total; drawdown and bad months are kept', () => {
  const nav = [{ d: '2024-01-31', nav: 1_100_000 }, { d: '2024-02-29', nav: 990_000 }, { d: '2024-03-28', nav: 1_089_000 }];
  const m = periodReturns(nav, 7);
  assert.equal(m.length, 3);
  assert.ok(Math.abs(m.reduce((a, x) => a * (1 + x.returnPct), 1) - 1.089) < 1e-12);
  assert.equal(m.filter((x) => x.returnPct < 0).length, 1);
  const k = metrics(nav);
  assert.ok(Math.abs(k.maxDrawdown - (990000 / 1100000 - 1)) < 1e-12);
  assert.equal(k.cagr, null, 'no annualized figure under one year');
});

test('price source: unadjusted prices rebuilt from split-adjusted bars; dividends scaled; identity traps blocked', () => {
  const ts = (d) => Date.parse(d + 'T13:30:00Z') / 1000;
  const json = { chart: { result: [{ meta: { symbol: 'X', gmtoffset: -14400 }, timestamp: [ts('2024-06-06'), ts('2024-06-07'), ts('2024-06-10')],
    events: { splits: { a: { date: ts('2024-06-10'), numerator: 10, denominator: 1 } }, dividends: { b: { date: ts('2024-06-06'), amount: 0.01 } } },
    indicators: { quote: [{ open: [120, 121, 122], high: [121, 122, 123], low: [119, 120, 121], close: [120.5, 121.5, 122.5], volume: [1e7, 1e7, 1e7] }], adjclose: [{ adjclose: [120.4, 121.5, 122.5] }] } }] } };
  const s = parseYahooChart(json);
  assert.deepEqual(s.bars.map((b) => b.c), [1205, 1215, 122.5]);
  assert.deepEqual(s.bars.map((b) => b.v), [1e6, 1e6, 1e7]);
  assert.equal(s.dividends[0].amount, 0.1);
  assert.equal(resolveSymbol('FB', '2020-01-02'), 'META');
  assert.equal(resolveSymbol('IR', '2019-06-03'), 'TT');
  assert.equal(resolveSymbol('IR', '2021-06-03'), 'IR');
  assert.equal(resolveSymbol('PARA', '2023-01-03'), null);
  assert.ok(BLOCKED_SYMBOLS.has('PARA'));
});

test('point-in-time universe uses the latest membership row on or before D', () => {
  const comps = loadComponents('date,tickers\n2020-01-02,"A,B"\n2020-06-01,"A,C"\n');
  assert.deepEqual(membersOn(comps, '2020-05-29').tickers, ['A', 'B']);
  assert.deepEqual(membersOn(comps, '2020-06-01').tickers, ['A', 'C']);
  assert.equal(membersOn(comps, '2019-12-31'), null);
});

test('forward clock: New York time is DST-correct and jobs are time-gated', () => {
  assert.deepEqual(nyClock('2026-10-09T20:25:00Z'), { date: '2026-10-09', minutes: 16 * 60 + 25, weekday: 'Fri' });
  assert.equal(nyClock('2026-12-01T14:30:00Z').minutes, 9 * 60 + 30); // EST
  assert.equal(due('2026-10-09T20:25:00Z').eod, true);
  assert.equal(due('2026-10-09T13:50:00Z').open, true);
  assert.equal(due('2026-10-10T20:25:00Z').eod, false, 'Saturday');
  assert.equal(due('2026-10-09T13:31:00Z').mark, false, 'marks every 5 minutes only');
  assert.equal(due('2026-10-09T13:35:00Z').mark, true);
});

test('live NAV: a stale or missing held quote during the session makes the NAV PARTIAL (never a false complete value)', () => {
  const st = { cashCents: 100000, positions: { AAA: { qty: 10, costCents: 100000 }, BBB: { qty: 5, costCents: 50000 } } };
  const now = '2026-10-09T15:00:00Z'; // 11:00 ET, session open
  const fresh = { symbol: 'AAA', price: 110, quoteTime: '2026-10-09T14:59:30Z' };
  const stale = { symbol: 'BBB', price: 90, quoteTime: '2026-10-09T13:40:00Z' };
  const a = navFromQuotes(st, [fresh, stale], now);
  assert.equal(a.complete, false); assert.equal(a.coverage, 0.5);
  const b = navFromQuotes(st, [fresh, { ...stale, quoteTime: '2026-10-09T14:58:00Z' }], now);
  assert.equal(b.complete, true); assert.equal(b.navCents, 100000 + 110000 + 45000);
  // after the close, the last close is a valid mark however old the trade timestamp is
  assert.equal(navFromQuotes(st, [fresh, stale], '2026-10-09T22:00:00Z').complete, true);
  assert.equal(navFromQuotes(st, [fresh], now).complete, false, 'missing quote');
});

test('quotes carry the SOURCE trade timestamp, not the fetch time', () => {
  const q = quoteFromChart({ symbol: 'AAA', retrieved_at: '2026-10-09T15:00:00Z', sha256: 'x', json: { chart: { result: [{ meta: { regularMarketPrice: 10, regularMarketTime: 1791567000 } }] } } });
  assert.equal(q.quoteTime, new Date(1791567000 * 1000).toISOString());
  assert.equal(quoteFromChart({ json: { chart: { result: [{ meta: { regularMarketPrice: 0 } }] } } }), null);
});

test('ledger hash chain: canonical JSON is key-order independent and any tamper changes the hash', async () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const h1 = await sha256Hex('0'.repeat(64) + canonical({ seq: 1, type: 'FILL', payload: { qty: 10 } }));
  const h2 = await sha256Hex('0'.repeat(64) + canonical({ seq: 1, type: 'FILL', payload: { qty: 11 } }));
  assert.notEqual(h1, h2);
});

test('origins are pinned: replay/forward/benchmark accounts cannot be created under a wrong origin', () => {
  assert.throws(() => newAccount({ origin: 'LIVE_TRADING', inception: '2026-10-09' }));
  assert.equal(newAccount({ origin: 'FORWARD_PAPER', inception: '2026-10-09' }).events[0].origin, 'FORWARD_PAPER');
});

test('policy constants are the pre-registered values', () => {
  assert.equal(MANAGER.startingCashCents, 1_000_000);
  assert.equal(MANAGER.initialWindowSessions, 10);
  assert.equal(MANAGER.maxPositions, 10);
  assert.equal(RANK.topN, 10);
  assert.equal(Object.values(RANK.weights).reduce((a, b) => a + b, 0).toFixed(10), (1).toFixed(10));
});
