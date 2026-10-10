// PBE Signal 10 U.S. stock tape (issue #54): NYSE calendar (holidays, early closes, DST, federal-holiday trading days),
// quote rows from source fields only (fail closed), Robinhood handoff links, SPCX pinned first and kept out of the model,
// cadence (90 s open, paused hidden, no polling while closed), the /v1/signal10/tape access split and the static pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../src/signal10/tape.js';
import * as C from '../markets/signal-10/signal10-core.js';
import { LATEST_MEMBERS } from '../src/signal10/members-latest.js';
import { tape, TAPE_REFRESH_S, TAPE_BUDGET, _tapeReset } from '../workers/pbe-predictions/src/signal10-api.js';

const S = (iso) => T.marketSession(iso);

test('calendar: regular open, pre-market, after close (EDT)', () => {
  const s = S('2026-10-13T14:00:00Z'); // Tue 10:00 EDT
  assert.equal(s.state, 'OPEN');
  assert.equal(s.opens_at, '2026-10-13T13:30:00.000Z');
  assert.equal(s.closes_at, '2026-10-13T20:00:00.000Z');
  assert.equal(s.last_session, '2026-10-12');
  assert.equal(S('2026-10-13T13:29:00Z').state, 'PRE_MARKET');
  assert.equal(S('2026-10-13T13:30:00Z').state, 'OPEN');
  const a = S('2026-10-13T20:00:00Z');
  assert.equal(a.state, 'AFTER_CLOSE');
  assert.equal(a.last_session, '2026-10-13');
  assert.equal(a.next_open_at, '2026-10-14T13:30:00.000Z');
});

test('calendar: weekend shows Friday close and Monday open; Columbus Day 2026-10-12 is a trading day', () => {
  const s = S('2026-10-10T16:00:00Z'); // Saturday
  assert.equal(s.state, 'CLOSED_WEEKEND');
  assert.equal(s.last_session, '2026-10-09');
  assert.equal(s.last_close_at, '2026-10-09T20:00:00.000Z');
  assert.equal(s.next_open_at, '2026-10-12T13:30:00.000Z');
  assert.equal(S('2026-10-12T15:00:00Z').state, 'OPEN', 'federal holiday, NYSE open');
  assert.equal(S('2026-11-11T15:00:00Z').state, 'OPEN', 'Veterans Day, NYSE open');
});

test('calendar: NYSE holidays (Thanksgiving, Good Friday, observed Christmas 2027)', () => {
  const t = S('2026-11-26T16:00:00Z');
  assert.equal(t.state, 'CLOSED_HOLIDAY');
  assert.equal(t.last_session, '2026-11-25');
  assert.equal(t.next_open_at, '2026-11-27T14:30:00.000Z');
  assert.equal(S('2026-04-03T15:00:00Z').state, 'CLOSED_HOLIDAY');
  assert.equal(S('2027-12-24T15:00:00Z').state, 'CLOSED_HOLIDAY');
  // Monday after a Friday holiday: last session is the Thursday
  assert.equal(S('2027-03-29T12:00:00Z').last_session, '2027-03-25');
});

test('calendar: 1:00 p.m. early closes', () => {
  const o = S('2026-11-27T17:30:00Z'); // 12:30 EST
  assert.equal(o.state, 'OPEN');
  assert.equal(o.early_close, true);
  assert.equal(o.closes_at, '2026-11-27T18:00:00.000Z');
  const c = S('2026-11-27T18:30:00Z');
  assert.equal(c.state, 'AFTER_CLOSE');
  assert.equal(c.last_close_at, '2026-11-27T18:00:00.000Z');
  assert.equal(S('2026-12-24T18:01:00Z').state, 'AFTER_CLOSE');
  assert.equal(S('2028-07-03T16:59:00Z').state, 'OPEN');
  assert.equal(S('2028-07-03T17:00:00Z').state, 'AFTER_CLOSE');
});

test('calendar: DST transitions move the UTC open', () => {
  assert.equal(S('2026-03-06T15:00:00Z').opens_at, '2026-03-06T14:30:00.000Z'); // EST
  assert.equal(S('2026-03-09T15:00:00Z').opens_at, '2026-03-09T13:30:00.000Z'); // EDT
  assert.equal(S('2026-10-30T15:00:00Z').opens_at, '2026-10-30T13:30:00.000Z'); // EDT
  assert.equal(S('2026-11-02T15:00:00Z').opens_at, '2026-11-02T14:30:00.000Z'); // EST
  assert.equal(S('2026-11-02T14:29:00Z').state, 'PRE_MARKET');
  // Friday before the November change: next open is Monday 09:30 EST
  assert.equal(S('2026-10-30T21:00:00Z').next_open_at, '2026-11-02T14:30:00.000Z');
});

test('calendar: outside the published calendar fails closed', () => {
  const s = S('2029-01-03T15:00:00Z');
  assert.equal(s.state, 'CALENDAR_UNKNOWN');
  assert.equal(s.last_session, null);
  // last covered trading day: the next open would be beyond the calendar -> null, never a guessed date
  const e = S('2028-12-29T22:00:00Z');
  assert.equal(e.state, 'AFTER_CLOSE');
  assert.equal(e.next_open_at, null);
});

// ---------- quotes ----------
const bars = (symbol, price, timeIso, days) => ({ chart: { result: [{ meta: { symbol, regularMarketPrice: price, regularMarketTime: Date.parse(timeIso) / 1000, fullExchangeName: 'NasdaqGS', longName: 'Space Exploration Technologies Corp.', firstTradeDate: 1781271000 },
  timestamp: days.map(([d]) => Date.parse(`${d}T13:30:00Z`) / 1000), indicators: { quote: [{ close: days.map(([, c]) => c) }] } }] } });

test('quoteFromBars: previous REGULAR close from the bar before the trade session; source time kept', () => {
  const j = bars('SPCX', 162.57, '2026-10-09T20:00:00Z', [['2026-10-05', 150], ['2026-10-06', 155], ['2026-10-07', null], ['2026-10-08', 160.57], ['2026-10-09', 162.57]]);
  const q = T.quoteFromBars('SPCX', j);
  assert.equal(q.price, 162.57);
  assert.equal(q.price_observed_at, '2026-10-09T20:00:00.000Z');
  assert.equal(q.session_date, '2026-10-09');
  assert.equal(q.previous_close, 160.57);
  assert.equal(q.previous_close_date, '2026-10-08');
  assert.equal(q.first_trade_at, '2026-06-12T13:30:00.000Z');
  // pre-market Monday: the regular trade is still Friday's close -> previous close is Thursday's
  const q2 = T.quoteFromBars('SPCX', bars('SPCX', 162.57, '2026-10-09T20:00:00Z', [['2026-10-08', 160.57], ['2026-10-09', 162.57]]));
  assert.equal(q2.previous_close, 160.57);
});

test('quoteFromBars: malformed, empty, wrong symbol and zero prices are rejected', () => {
  assert.equal(T.quoteFromBars('SPCX', null), null);
  assert.equal(T.quoteFromBars('SPCX', { chart: { result: [] } }), null);
  assert.equal(T.quoteFromBars('SPCX', bars('SPCE', 5, '2026-10-09T20:00:00Z', [])), null, 'never another security');
  assert.equal(T.quoteFromBars('SPCX', bars('SPCX', 0, '2026-10-09T20:00:00Z', [])), null);
  assert.equal(T.quoteFromBars('BRK.B', bars('BRK-B', 480, '2026-10-09T20:00:00Z', [['2026-10-08', 470]])).previous_close, 470);
  const q = T.quoteFromBars('SPCX', bars('SPCX', 10, '2026-10-09T20:00:00Z', [['2026-10-09', 10]]));
  assert.equal(q.previous_close, null, 'no earlier bar -> no invented previous close');
  // the previous session's bar is missing (null close): never fall back to an older close
  const gap = T.quoteFromBars('SPCX', bars('SPCX', 10, '2026-10-09T20:00:00Z', [['2026-10-07', 9], ['2026-10-08', null], ['2026-10-09', 10]]));
  assert.equal(gap.previous_close, null);
  // across a holiday the previous trading session is the right one (Thanksgiving -> Wednesday)
  assert.equal(T.quoteFromBars('SPCX', bars('SPCX', 10, '2026-11-27T18:00:00Z', [['2026-11-25', 9.5], ['2026-11-27', 10]])).previous_close, 9.5);
});

const META = { symbol: 'SPCX', name: 'SpaceX', pinned: true };
const q = (price, at, prev = 100, session_date = at.slice(0, 10)) => ({ price, price_observed_at: at, previous_close: prev, session_date });

test('tapeRow: open session math, CURRENT vs DELAYED vs STALE (source time, not fetch time)', () => {
  const s = S('2026-10-13T15:00:00Z');
  const r = T.tapeRow(META, q(103.5, '2026-10-13T14:59:30Z'), s, '2026-10-13T15:00:00Z');
  assert.equal(r.status, 'CURRENT');
  assert.equal(r.change_abs, 3.5);
  assert.equal(r.change_pct, 0.035);
  assert.equal(r.robinhood_url, 'https://robinhood.com/us/en/stocks/SPCX/');
  assert.equal(r.pinned, true);
  assert.equal(T.tapeRow(META, q(103.5, '2026-10-13T14:50:00Z'), s, '2026-10-13T15:00:00Z').status, 'DELAYED');
  const st = T.tapeRow(META, q(103.5, '2026-10-13T14:30:00Z'), s, '2026-10-13T15:00:00Z');
  assert.equal(st.status, 'STALE');
  assert.equal(st.price, null, 'stale fails closed');
  assert.equal(st.change_pct, null);
  // yesterday's close during today's session is stale, never "live"
  assert.equal(T.tapeRow(META, q(103.5, '2026-10-12T20:00:00Z'), s, '2026-10-13T15:00:00Z').status, 'STALE');
  // a source time in the future is rejected
  assert.equal(T.tapeRow(META, q(103.5, '2026-10-13T15:10:00Z'), s, '2026-10-13T15:00:00Z').status, 'STALE');
  // unchanged price: zero change, not missing
  const z = T.tapeRow(META, q(100, '2026-10-13T14:59:30Z'), s, '2026-10-13T15:00:00Z');
  assert.equal(z.change_abs, 0); assert.equal(z.change_pct, 0);
});

test('tapeRow: weekends and holidays freeze the last close; anything else is stale; missing = SOURCE_UNAVAILABLE', () => {
  const sat = S('2026-10-10T16:00:00Z');
  const r = T.tapeRow(META, q(162.57, '2026-10-09T20:00:00Z', 160.57), sat, '2026-10-10T16:00:00Z');
  assert.equal(r.status, 'LAST_CLOSE');
  assert.equal(r.price, 162.57);
  assert.equal(r.change_pct, Math.round(((162.57 - 160.57) / 160.57) * 1e6) / 1e6);
  assert.equal(T.tapeRow(META, q(160.57, '2026-10-08T20:00:00Z'), sat, '2026-10-10T16:00:00Z').status, 'STALE');
  const thx = S('2026-11-26T16:00:00Z');
  assert.equal(T.tapeRow(META, q(1, '2026-11-25T21:00:00Z'), thx, '2026-11-26T16:00:00Z').status, 'LAST_CLOSE');
  for (const bad of [null, undefined, { price: 0, price_observed_at: '2026-10-09T20:00:00Z' }, { price: 5 }]) {
    const u = T.tapeRow(META, bad, sat, '2026-10-10T16:00:00Z');
    assert.equal(u.status, 'SOURCE_UNAVAILABLE'); assert.equal(u.price, null);
  }
  const np = T.tapeRow(META, { ...q(5, '2026-10-09T20:00:00Z'), previous_close: null }, sat, '2026-10-10T16:00:00Z');
  assert.equal(np.price, 5); assert.equal(np.change_pct, null, 'no previous close -> no change shown');
});

test('Robinhood links: exact stock page, share classes kept, anything else refused', () => {
  assert.equal(T.robinhoodUrl('SPCX'), 'https://robinhood.com/us/en/stocks/SPCX/');
  assert.equal(T.robinhoodUrl('brk.b'), 'https://robinhood.com/us/en/stocks/BRK.B/');
  for (const bad of ['', null, '../x', 'TOOLONGX', 'A B', 'SPCX/orders', 'BRK-B', '^GSPC']) assert.equal(T.robinhoodUrl(bad), null, String(bad));
});

test('SPCX is pinned first, featured symbols are all linkable, and featured never enters the model universe', () => {
  assert.equal(T.FEATURED[0].symbol, 'SPCX');
  assert.equal(T.FEATURED[0].pinned, true);
  assert.equal(T.FEATURED.filter((f) => f.pinned).length, 1);
  assert.deepEqual(T.FEATURED.map((f) => f.symbol), ['SPCX', 'SPY', 'QQQ', 'NVDA', 'MSFT', 'AAPL', 'AMZN', 'GOOGL', 'META', 'TSLA', 'HOOD']);
  for (const f of T.FEATURED) assert.ok(T.robinhoodUrl(f.symbol), f.symbol);
  assert.ok(!LATEST_MEMBERS.tickers.includes('SPCX'), 'SPCX is not an S&P 500 model member');
  for (const f of ['src/signal10/rank.js', 'src/signal10/portfolio.js', 'src/signal10/forward.js', 'src/signal10/policy.js', 'src/signal10/universe.js']) {
    assert.ok(!/tape\.js|FEATURED/.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')), `${f} must not read the tape`);
  }
});

test('cache TTL: 45 s open, 60 s in the 10 min after the bell, otherwise expires exactly at the next open (max 6 h)', () => {
  assert.equal(T.quoteTtlSeconds(S('2026-10-13T15:00:00Z'), '2026-10-13T15:00:00Z'), 45);
  assert.equal(T.quoteTtlSeconds(S('2026-10-13T20:05:00Z'), '2026-10-13T20:05:00Z'), 60);
  assert.equal(T.quoteTtlSeconds(S('2026-10-13T20:30:00Z'), '2026-10-13T20:30:00Z'), 6 * 3600);
  assert.equal(T.quoteTtlSeconds(S('2026-10-10T16:00:00Z'), '2026-10-10T16:00:00Z'), 6 * 3600);
  assert.equal(T.quoteTtlSeconds(S('2026-10-13T13:20:00Z'), '2026-10-13T13:20:00Z'), 600, 'pre-market: expires at 09:30');
  // browser wakes at open + 60 s, after the closed-market cache has expired -> first in-session read is a new quote
  const pre = S('2026-10-13T13:20:00Z'), nowMs = Date.parse('2026-10-13T13:20:00Z');
  assert.ok(nowMs + C.tapePollMs(pre, true, nowMs) > nowMs + T.quoteTtlSeconds(pre, '2026-10-13T13:20:00Z') * 1000);
});

test('browser cadence: 90 s while open, paused when hidden, no polling while closed until the next open', () => {
  const now = Date.parse('2026-10-13T15:00:00Z');
  assert.equal(C.tapePollMs(S('2026-10-13T15:00:00Z'), true, now), 90000);
  assert.ok(C.tapePollMs(S('2026-10-13T15:00:00Z'), true, now) >= 90000 && C.tapePollMs(S('2026-10-13T15:00:00Z'), true, now) <= 120000);
  assert.equal(C.tapePollMs(S('2026-10-13T15:00:00Z'), false, now), null);
  const pre = Date.parse('2026-10-13T13:25:00Z');
  assert.equal(C.tapePollMs(S('2026-10-13T13:25:00Z'), true, pre), 5 * 60000 + 60000);
  // after the bell: exactly one read at close + 5 min, then nothing until the next open
  assert.equal(C.tapePollMs(S('2026-10-13T20:01:00Z'), true, Date.parse('2026-10-13T20:01:00Z')), 4 * 60000);
  assert.equal(C.tapePollMs(S('2026-10-13T20:04:30Z'), true, Date.parse('2026-10-13T20:04:30Z')), 60000);
  const after = Date.parse('2026-10-13T20:05:30Z');
  assert.equal(C.tapePollMs(S('2026-10-13T20:05:30Z'), true, after), 6 * 3600000, 'next open is 17 h away: one capped wake-up');
  const fri = Date.parse('2026-10-14T09:00:00Z');
  assert.equal(C.tapePollMs(S('2026-10-14T09:00:00Z'), true, fri), Date.parse('2026-10-14T13:30:00Z') - fri + 60000);
  const late = Date.parse('2026-10-13T23:00:00Z');
  assert.equal(C.tapePollMs(S('2026-10-13T23:00:00Z'), true, late), 6 * 3600000);
  assert.equal(C.tapePollMs({ state: 'CALENDAR_UNKNOWN' }, true, late), 15 * 60000);
  assert.equal(TAPE_REFRESH_S, 90);
});

test('head status: LIVE only with a CURRENT quote in an open session; closed never pulses', () => {
  const open = S('2026-10-13T15:00:00Z');
  assert.deepEqual(C.tapeStatus(open, [{ status: 'CURRENT' }]).live, true);
  assert.equal(C.tapeStatus(open, [{ status: 'DELAYED' }]).text, 'MARKET OPEN · QUOTES DELAYED');
  assert.equal(C.tapeStatus(open, [{ status: 'STALE' }]).text, 'MARKET OPEN · SOURCE UNAVAILABLE');
  assert.equal(C.tapeStatus(open, [{ status: 'MEMBERS_ONLY' }]).live, false);
  const sat = C.tapeStatus(S('2026-10-10T16:00:00Z'), [{ status: 'LAST_CLOSE' }]);
  assert.equal(sat.live, false); assert.equal(sat.text, 'MARKET CLOSED · WEEKEND');
  assert.equal(C.tapeStatus(S('2026-11-26T16:00:00Z'), []).text, 'MARKET CLOSED · EXCHANGE HOLIDAY');
  assert.equal(C.etShort('2026-10-09T20:00:00Z'), 'Fri, Oct 9, 4:00 PM ET');
  assert.deepEqual(C.quoteSpan([{ price: 1, price_observed_at: '2026-10-13T14:59:00Z' }, { price: 2, price_observed_at: '2026-10-13T15:00:00Z' }, { price: null, price_observed_at: '2026-10-13T10:00:00Z' }]),
    { min: '2026-10-13T14:59:00.000Z', max: '2026-10-13T15:00:00.000Z' });
});

// ---------- /v1/signal10/tape ----------
function harness(opts = {}) {
  _tapeReset();
  const { member = false, now = '2026-10-13T15:00:00Z', state = null, snap = null } = opts;
  const env = 'mode' in opts ? (opts.mode === undefined ? {} : { SIGNAL10_TAPE_QUOTES: opts.mode }) : { SIGNAL10_TAPE_QUOTES: 'members' };
  return harnessWith({ member, env, now, state, snap });
}
function harnessWith({ member, env, now, state, snap }) {
  const calls = [];
  const store = new Map();
  globalThis.caches = { default: { async match(k) { const v = store.get(k.url); return v ? new Response(v) : undefined; }, async put(k, r) { store.set(k.url, await r.text()); } } };
  const fetchImpl = async (url) => {
    calls.push(url);
    const sym = decodeURIComponent(/chart\/([^?]+)/.exec(url)[1]);
    return new Response(JSON.stringify(bars(sym, 110, '2026-10-13T14:59:40Z', [['2026-10-12', 100], ['2026-10-13', 110]])), { status: 200 });
  };
  const db = { async select(table) {
    if (table === 'pred_s10_events') return state ? [{ seq: 9, d: '2026-10-12', payload: state, hash: 'h', inserted_at: now }] : [];
    if (table === 'pred_s10_snapshots') return snap ? [snap] : [];
    return [];
  } };
  const requireAllAccess = async () => (member ? { ok: true, m: { membership: { state: 'all_access' } } } : { ok: false, res: null });
  const privateJson = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'cache-control': 'private, no-store' } });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const run = async () => { const r = await tape({ req: new Request('https://x/v1/signal10/tape'), env, ctx, store: db, requireAllAccess, privateJson, now, fetchImpl }); await Promise.all(pending); return { r, d: await r.json() }; };
  return { run, calls };
}

test('tape API: public visitors get symbols, session and Robinhood links — no prices, no vendor call, no premium groups', async () => {
  const h = harness({ member: false, state: { st: 1 }, snap: { d: '2026-10-12', ranks: [{ rank: 1, symbol: 'PSX', name: 'Phillips 66' }] } });
  const { r, d } = await h.run();
  assert.equal(h.calls.length, 0);
  assert.match(r.headers.get('cache-control'), /private/);
  assert.equal(d.quotes.shown, false); assert.equal(d.quotes.withheld, 'MEMBERS_ONLY');
  assert.equal(d.source, null);
  assert.deepEqual(d.groups.map((g) => g.key), ['FEATURED']);
  assert.equal(d.groups[0].rows[0].symbol, 'SPCX');
  for (const row of d.groups[0].rows) { assert.equal(row.price, null); assert.equal(row.status, 'MEMBERS_ONLY'); assert.match(row.robinhood_url, /^https:\/\/robinhood\.com\/us\/en\/stocks\/[A-Z.]+\/$/); }
  assert.ok(!JSON.stringify(d).includes('PSX'), 'no ranking leaks to the public');
});

test('tape API: members get source-timestamped prices + separate holdings/Top 10 groups; one vendor call per symbol, cached', async () => {
  const st = { v: 1 };
  const h = harness({ member: true, snap: { d: '2026-10-12', ranks: Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, symbol: i === 0 ? 'SPY' : `S${i}`, ticker: `S${i}`, name: `N${i}` })) } });
  const { d } = await h.run();
  assert.equal(d.quotes.shown, true);
  assert.equal(d.source.rights, 'UNLICENSED_FOR_PUBLIC_REDISTRIBUTION');
  assert.deepEqual(d.groups.map((g) => g.key), ['FEATURED', 'TOP10']);
  const top = d.groups[1];
  assert.equal(top.rows.length, 10); assert.equal(top.rows[0].rank, 1);
  const spcx = d.groups[0].rows[0];
  assert.equal(spcx.symbol, 'SPCX'); assert.equal(spcx.price, 110); assert.equal(spcx.previous_close, 100); assert.equal(spcx.change_pct, 0.1);
  assert.equal(spcx.price_observed_at, '2026-10-13T14:59:40.000Z'); assert.equal(spcx.status, 'CURRENT');
  assert.ok(spcx.fetched_at, 'our fetch time is reported separately');
  const uniq = new Set([...d.groups.flatMap((g) => g.rows.map((r) => r.symbol))]);
  assert.equal(h.calls.length, uniq.size, 'SPY in both groups is fetched once');
  await h.run();
  assert.equal(h.calls.length, uniq.size, 'second viewer is served from the shared cache');
  void st;
});

test('tape API: SIGNAL10_TAPE_QUOTES off (or unset) shows no prices to anyone and never calls the source', async () => {
  for (const mode of ['off', undefined, 'yes']) {
    const h = harness({ member: true, mode });
    const { d } = await h.run();
    assert.equal(h.calls.length, 0); assert.equal(d.quotes.shown, false); assert.equal(d.quotes.withheld, 'SOURCE_RIGHTS_HOLD');
  }
  const pub = harness({ member: false, mode: 'public' });
  const { d } = await pub.run();
  assert.equal(d.quotes.shown, true, 'public mode is an explicit, separate switch');
});

test('tape API OFF (deployed): every price/time/fetch field null for members AND public; members keep research groups, public gets FEATURED only', async () => {
  const snap = { d: '2026-10-09', ranks: [{ rank: 1, symbol: 'PSX', name: 'Phillips 66' }, { rank: 2, symbol: 'VLO', name: 'Valero' }] };
  for (const member of [true, false]) {
    const h = harness({ member, mode: 'off', snap });
    const { d } = await h.run();
    assert.equal(h.calls.length, 0, 'zero vendor calls');
    assert.equal(d.source, null);
    assert.deepEqual(d.quotes, { mode: 'OFF', shown: false, withheld: 'SOURCE_RIGHTS_HOLD' });
    assert.deepEqual(d.groups.map((g) => g.key), member ? ['FEATURED', 'TOP10'] : ['FEATURED']);
    for (const row of d.groups.flatMap((g) => g.rows)) {
      for (const k of ['price', 'previous_close', 'change_abs', 'change_pct', 'price_observed_at', 'session_date']) assert.equal(row[k], null, `${row.symbol}.${k}`);
      assert.ok(!('fetched_at' in row) || row.fetched_at === null);
      assert.equal(row.status, 'SOURCE_RIGHTS_HOLD');
    }
    if (!member) assert.ok(!JSON.stringify(d).includes('PSX'), 'no ranking in the public view');
  }
});

test('static pages: the featured tape (SPCX first) is server-rendered on all five Signal 10 pages with safe new-tab links', () => {
  for (const p of ['', 'live/', 'backtest/', 'ledger/', 'methodology/']) {
    const html = readFileSync(new URL(`../markets/signal-10/${p}index.html`, import.meta.url), 'utf8');
    const links = [...html.matchAll(/<a class="s10-tq[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.equal(links.length, T.FEATURED.length, p);
    assert.match(links[0], /data-sym="SPCX" href="https:\/\/robinhood\.com\/us\/en\/stocks\/SPCX\/"/);
    for (const a of links) { assert.match(a, /target="_blank"/); assert.match(a, /rel="noopener noreferrer external"/); }
    assert.match(html, /View SPCX on Robinhood \(opens in a new tab\)/);
    assert.match(html, /<script src="\/markets\/signal-10\/tape\.js\?v=[^"]+" defer><\/script>/);
    assert.ok(html.indexOf('id="s10-tape"') < html.indexOf('class="wrap s10-body"'), 'tape sits above the page body');
    assert.match(html, /not Signal 10 picks/);
    assert.match(html, /not affiliated with Robinhood/);
  }
});

test('tape API: with a no-op edge cache (*.workers.dev) the isolate memo still serves repeat viewers without new vendor calls', async () => {
  const h = harness({ member: true });
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  await h.run();
  const n = h.calls.length;
  assert.equal(n, 11);
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  await h.run();
  assert.equal(h.calls.length, n, 'memo hit: no second fetch inside the TTL');
});

test('tape API: a hard per-isolate vendor budget; over budget a symbol fails closed instead of piling on', async () => {
  const h = harness({ member: true, snap: { d: '2026-10-12', ranks: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, symbol: `Z${i}`, name: `Z${i}` })) } });
  const prev = TAPE_BUDGET.perMinute;
  TAPE_BUDGET.perMinute = 15;
  try {
    const { d } = await h.run();
    assert.equal(h.calls.length, 15);
    const rows = d.groups.flatMap((g) => g.rows);
    assert.equal(rows.filter((r) => r.status === 'SOURCE_UNAVAILABLE').length, rows.length - 15);
  } finally { TAPE_BUDGET.perMinute = prev; }
});

test('tape API: vendor subrequests ask the edge to cache 2xx only', async () => {
  const seen = [];
  _tapeReset();
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  const fetchImpl = async (url, init) => { seen.push(init?.cf); return new Response('{}', { status: 500 }); };
  const r = await tape({ req: new Request('https://x/'), env: { SIGNAL10_TAPE_QUOTES: 'public' }, ctx: { waitUntil() {} }, store: { async select() { return []; } },
    requireAllAccess: async () => ({ ok: false }), privateJson: (d) => new Response(JSON.stringify(d)), now: '2026-10-13T15:00:00Z', fetchImpl });
  const d = await r.json();
  assert.equal(seen.length, 11);
  assert.deepEqual(seen[0].cacheTtlByStatus, { '200-299': 45, '300-599': 0 });
  assert.ok(d.groups[0].rows.every((x) => x.status === 'SOURCE_UNAVAILABLE' && x.price === null), 'vendor 500 -> no price');
});
