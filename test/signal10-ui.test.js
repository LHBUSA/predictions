// PBE Signal 10 UI helpers (markets/signal-10/signal10-core.js): formatting, honest live states, polling cadence,
// access gates, ledger shaping and chart geometry (straight segments through data rows only; nulls break the line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../markets/signal-10/signal10-core.js';

const M = '−';
const NOW = Date.parse('2026-10-09T18:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('money: integer cents, true minus sign, optional plus, never invents', () => {
  assert.equal(C.fmtUSD(1877534), '$18,775.34');
  assert.equal(C.fmtUSD(-149876, { sign: true }), `${M}$1,498.76`);
  assert.equal(C.fmtUSD(877534, { sign: true }), '+$8,775.34');
  assert.equal(C.fmtUSD(3070953, { dp: 0 }), '$30,710');
  assert.equal(C.fmtUSD(0, { sign: true }), '$0.00');
  assert.equal(C.fmtUSD(-0.4, { sign: true }), '$0.00', 'rounds to zero -> no sign');
  for (const v of [null, undefined, NaN, '12']) assert.equal(C.fmtUSD(v), '—');
  assert.equal(C.fmtPrice(574.549988), '$574.55');
  assert.equal(C.fmtPrice(0.51234), '$0.5123');
});

test('percent from fractions', () => {
  assert.equal(C.fmtPct(0.0745279785), '+7.5%');
  assert.equal(C.fmtPct(0.0745279785, { dp: 2 }), '+7.45%');
  assert.equal(C.fmtPct(-0.30615988), `${M}30.6%`);
  assert.equal(C.fmtPct(0.8476, { sign: false }), '84.8%');
  assert.equal(C.fmtPct(-0.00001), '0.0%');
  assert.equal(C.fmtPct(null), '—');
  assert.equal(C.signCls(-1), 'neg'); assert.equal(C.signCls(2), 'pos'); assert.equal(C.signCls(0), 'flat'); assert.equal(C.signCls(null), 'flat');
});

test('dates: calendar dates never shift; ET clock; relative ages', () => {
  assert.equal(C.fmtDate('2026-10-08'), 'Oct 8, 2026');
  assert.equal(C.fmtDate('2018-01-02'), 'Jan 2, 2018');
  assert.match(C.etDateTime('2026-10-09T20:00:00Z'), /^Oct 9, 2026, 4:00\s?PM ET$/);
  assert.match(C.etTime('2026-01-09T15:00:00Z'), /^10:00\s?AM ET$/, 'EST in winter');
  assert.equal(C.relTime(iso(NOW - 3 * 60e3), NOW), '3 min ago');
  assert.equal(C.relTime(iso(NOW - 30e3), NOW), '30 s ago');
  assert.equal(C.relTime('nope', NOW), '—');
});

test('freshness + session badge: LIVE pulse only when OPEN and a quote is fresh', () => {
  const fresh = iso(NOW - 2 * 60e3), stale = iso(NOW - 45 * 60e3);
  assert.equal(C.isFresh(fresh, NOW), true);
  assert.equal(C.isFresh(stale, NOW), false);
  assert.equal(C.isFresh(null, NOW), false);
  assert.deepEqual(C.sessionBadge({ state: 'OPEN' }, [fresh], NOW).live, true);
  const s = C.sessionBadge({ state: 'OPEN' }, [stale], NOW);
  assert.equal(s.live, false); assert.match(s.text, /DELAYED/);
  assert.equal(C.sessionBadge({ state: 'CLOSED' }, [fresh], NOW).text, 'MARKET CLOSED');
  assert.equal(C.sessionBadge({ state: 'CLOSED' }, [fresh], NOW).live, false);
  assert.equal(C.sessionBadge({ state: 'CLOSED_WEEKEND' }, [], NOW).live, false);
  assert.match(C.sessionBadge({ state: 'PRE_MARKET' }, [fresh], NOW).text, /^MARKET CLOSED$/);
});

test('polling cadence: 20 s open+visible, 120 s otherwise, paused when hidden', () => {
  assert.equal(C.pollMs('OPEN', true), 20000);
  assert.equal(C.pollMs('CLOSED', true), 120000);
  assert.equal(C.pollMs('PRE_MARKET', true), 120000);
  assert.equal(C.pollMs('OPEN', false), null);
});

test('access: 401 sign-in, 403 upgrade, 503 retry with Retry-After, never a payload guess', () => {
  assert.equal(C.gateFor(200), null);
  assert.equal(C.gateFor(401), 'signin');
  assert.equal(C.gateFor(403), 'upgrade');
  assert.equal(C.gateFor(503), 'retry');
  assert.equal(C.gateFor(500), 'error');
  assert.equal(C.gateFor(0), 'error');
  assert.equal(C.retryAfterMs('5'), 5000);
  assert.equal(C.retryAfterMs(null), 5000);
  assert.equal(C.retryAfterMs('9999'), 300000, 'capped');
});

test('NAV view: complete live NAV, else last EOD NAV is authoritative with PARTIAL coverage', () => {
  const positions = [{ symbol: 'A', fresh: true }, { symbol: 'B', fresh: false }, { symbol: 'C', fresh: true }];
  const full = C.navView({ nav: { cents: 1002000, complete: true }, positions: positions.map((p) => ({ ...p, fresh: true })), lastEod: { d: '2026-10-12', nav_cents: 999000 } });
  assert.deepEqual([full.cents, full.partial, full.basis, full.freshN], [1002000, false, 'live', 3]);
  const part = C.navView({ nav: { cents: 1003000, complete: false }, positions, lastEod: { d: '2026-10-12', nav_cents: 999000 } });
  assert.deepEqual([part.cents, part.partial, part.basis, part.asOf, part.freshN, part.totalN], [999000, true, 'eod', '2026-10-12', 2, 3]);
  const none = C.navView({ nav: { cents: 1000000, complete: false }, positions, lastEod: null });
  assert.equal(none.cents, null);
  assert.equal(C.navView(null), null);
  const pl = C.pnl(1029335, 1000000); assert.equal(pl.cents, 29335); assert.ok(Math.abs(pl.pct - 0.029335) < 1e-12);
  assert.deepEqual(C.pnl(null, 1000000), { cents: null, pct: null });
  assert.equal(C.investedPct(1000000, 250000), 0.75);
  assert.equal(C.windowLabel(3, 10), 'day 3 of initial 10-trading-day window');
  assert.equal(C.windowLabel(11, 10), null);
});

test('position row: unrealized = value - cost, day move vs previous close, weight vs NAV', () => {
  const r = C.positionRow({ symbol: 'PSX', qty: 3, costCents: 83730, valueCents: 85020, price: 283.4, previousClose: 281.6 }, 1002935);
  assert.equal(r.unrealCents, 1290);
  assert.ok(Math.abs(r.unrealPct - 1290 / 83730) < 1e-12);
  assert.ok(Math.abs(r.dayPct - (283.4 / 281.6 - 1)) < 1e-12);
  assert.equal(r.dayCents, 540);
  assert.ok(Math.abs(r.weight - 85020 / 1002935) < 1e-12);
  const missing = C.positionRow({ symbol: 'X', qty: 1, costCents: 100, valueCents: null, price: null, previousClose: null }, 1000);
  assert.equal(missing.unrealCents, null); assert.equal(missing.dayPct, null); assert.equal(missing.weight, null);
});

test('only rows whose quote time changed re-render', () => {
  const prev = new Map([['A', 't1'], ['B', 't2']]);
  const out = C.changedQuotes(prev, [{ symbol: 'A', quoteTime: 't1' }, { symbol: 'B', quoteTime: 't3' }, { symbol: 'C', quoteTime: 't9' }]);
  assert.deepEqual([...out].sort(), ['B', 'C']);
});

test('rank moves', () => {
  assert.deepEqual(C.rankMove(3, 5), { dir: 'up', text: '▲ 2', delta: 2 });
  assert.deepEqual(C.rankMove(10, 8), { dir: 'down', text: '▼ 2', delta: -2 });
  assert.equal(C.rankMove(4, 4).dir, 'same');
  assert.equal(C.rankMove(1, null).dir, 'new');
});

test('ledger: forward payload rows flatten, filter by type/symbol, paginate 100/page', () => {
  const fwd = { seq: 7, type: 'FILL', d: '2026-10-12', payload: { side: 'BUY', symbol: 'PSX', qty: 3 }, hash: 'h7', prev_hash: 'h6', inserted_at: 'x' };
  const f = C.flattenEvent(fwd);
  assert.deepEqual([f.seq, f.type, f.symbol, f.qty, f.hash, f.prev_hash], [7, 'FILL', 'PSX', 3, 'h7', 'h6']);
  assert.equal(f.payload, undefined);
  const replay = { seq: 52, type: 'FILL', d: '2018-01-09', side: 'BUY', symbol: 'DHI', qty: 18 };
  assert.deepEqual(C.flattenEvent(replay), replay);
  const rows = Array.from({ length: 250 }, (_, i) => ({ seq: i + 1, type: i % 2 ? 'FILL' : 'DIVIDEND', symbol: i % 5 ? 'MU' : 'TGT' }));
  assert.equal(C.filterEvents(rows, { type: 'FILL' }).length, 125);
  assert.equal(C.filterEvents(rows, { symbol: ' tgt ' }).length, 50);
  assert.equal(C.filterEvents(rows, { type: 'FILL', symbol: 'TGT' }).length, 25);
  const p = C.paginate(rows, 3, 100);
  assert.deepEqual([p.page, p.pages, p.from, p.to, p.rows.length], [3, 3, 201, 250, 50]);
  assert.equal(C.paginate(rows, 99, 100).page, 3, 'clamped');
  assert.deepEqual(C.paginate([], 1, 100), { rows: [], page: 1, pages: 1, from: 0, to: 0 });
  assert.match(C.eventDetail({ type: 'SPLIT', ratio: 2, qtyBefore: 8, qtyAfter: 16, cashInLieuCents: 0 }), /ratio 2 · 8 → 16 sh/);
  // ledger writer/2 (#69): nested STATE renders the same as a legacy flat one
  const acct = { cashCents: 1000000, positions: { MU: {}, VTRS: {} }, pending: [{}] };
  assert.equal(C.eventDetail({ type: 'STATE', phase: 'OPEN', state: acct }), C.eventDetail({ type: 'STATE', phase: 'OPEN', ...acct }));
  assert.match(C.eventDetail({ type: 'STATE', phase: 'OPEN', state: acct }), /cash \$10,000\.00 · 2 positions · 1 queued orders/);
  assert.equal(C.eventDetail({ type: 'DECISION', action: 'WAIT', reason: 'WAIT: x' }), 'WAIT: x');
});

test('monthly grid keeps every month and counts the negative ones', () => {
  const monthly = [
    { period: '2018-01', returnPct: 0.017 }, { period: '2018-02', returnPct: -0.05 }, { period: '2018-03', returnPct: -0.026 },
    { period: '2019-12', returnPct: 0.023 },
  ];
  const g = C.monthlyGrid(monthly);
  assert.equal(g.negatives, 2); assert.equal(g.total, 4);
  assert.deepEqual(g.years.map((y) => y.year), ['2018', '2019']);
  assert.equal(g.years[0].months[1].returnPct, -0.05);
  assert.equal(g.years[0].months[11], null);
  assert.equal(g.years[1].months[11].period, '2019-12');
  assert.equal(g.worst.period, '2018-02'); assert.equal(g.best.period, '2019-12');
  assert.equal(C.heat(-0.07), 3); assert.equal(C.heat(0.03), 2); assert.equal(C.heat(0.001), 1); assert.equal(C.heat(null), 0);
});

test('verdict compares ending values plainly', () => {
  const v = C.verdict({ endCents: 1877534 }, { SPY: { endCents: 3070953 }, QQQ: { endCents: 4766032 } });
  assert.deepEqual(v.map((x) => [x.key, x.under]), [['SPY', true], ['QQQ', true]]);
});

test('chart path: straight M/L segments through data rows only; null breaks the line', () => {
  const sx = C.scale(0, 3, 0, 300); const sy = C.scale(0, 10, 100, 0);
  const d = C.linePath([0, 1, 2, 3], [0, 5, null, 10], sx, sy);
  assert.equal(d, 'M0.0,100.0L100.0,50.0M300.0,0.0');
  assert.doesNotMatch(d, /[CQSTA]/, 'no curve commands (no smoothing)');
  assert.equal((d.match(/[ML]/g) || []).length, 3, 'one command per drawn data point');
  assert.equal(C.linePath([0, 1], [null, null], sx, sy), '');
});

test('scales, ticks and log ticks', () => {
  const s = C.scale(10, 20, 0, 100);
  assert.equal(s(15), 50);
  const lg = C.scale(1000, 100000, 0, 200, { log: true });
  assert.ok(Math.abs(lg(10000) - 100) < 1e-9);
  assert.deepEqual(C.niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1].map((x) => Math.round(x / 0.2) * 0.2));
  const t = C.niceTicks(-0.3434, 0, 4);
  assert.ok(t[0] <= -0.3434 && t.at(-1) >= 0);
  assert.deepEqual(C.logTicks(700000, 5000000), [1000000, 2000000, 5000000]);
  assert.equal(C.extent([null, 3, -2, NaN, 7]).join(), '-2,7');
  assert.equal(C.extent([null]), null);
});

test('axis labels never repeat on fine steps', () => {
  assert.equal(C.axisUSD(1000000), '$10k');
  assert.equal(C.axisUSD(4766032), '$47.7k');
  assert.equal(C.axisUSD(1002000, 2000), '$10,020');
  const labels = [999000, 1000000, 1001000, 1002000].map((v) => C.axisUSD(v, 1000));
  assert.equal(new Set(labels).size, labels.length);
});

test('drawdowns from running peak with peak/trough indices', () => {
  const r = C.drawdowns([100, 120, 90, 110, 130, 65]);
  assert.equal(r.max, 65 / 130 - 1);
  assert.equal(r.peak, 4); assert.equal(r.trough, 5);
  assert.equal(r.dd[2], 90 / 120 - 1);
  assert.equal(r.dd[0], 0);
  assert.equal(C.drawdowns([null, 10]).dd[0], null);
});

test('nearest index for the crosshair', () => {
  const xs = [0, 10, 20, 30];
  assert.equal(C.nearest(xs, 14), 1);
  assert.equal(C.nearest(xs, 16), 2);
  assert.equal(C.nearest(xs, -5), 0);
  assert.equal(C.nearest(xs, 99), 3);
  assert.equal(C.nearest([], 3), -1);
});

test('escaping', () => {
  assert.equal(C.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
