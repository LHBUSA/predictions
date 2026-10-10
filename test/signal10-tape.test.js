// PBE Signal 10 U.S. stock tape (issue #54): NYSE calendar (holidays, early closes, DST, federal-holiday trading days),
// quote rows from source fields only (fail closed), Robinhood handoff links, SPCX pinned first and kept out of the model,
// cadence (90 s open, paused hidden, no polling while closed), the /v1/signal10/tape access split and the static pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../src/signal10/tape.js';
import * as C from '../markets/signal-10/signal10-core.js';
import { LATEST_MEMBERS } from '../src/signal10/members-latest.js';
import { TAPE_REFRESH_S } from '../workers/pbe-predictions/src/signal10-api.js';

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

