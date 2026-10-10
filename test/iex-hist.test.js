// PBE Market Tape first-party collector (issue #56): IEX HIST TOPS parser on a SYNTHETIC pcapng capture (built here byte
// by byte; no network, no real data), the T+1 session-close contract states, the collector lane (schedule, sessions,
// idempotent keys, attribution, not-yet-published) and the market-tape/1 read path (public display permitted + credit line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopsParser, topsEntry, IEX_ATTRIBUTION } from '../src/market-tape/iex-hist.js';
import { sessionCloseFields, PROVIDERS, quoteProvider } from '../src/market-tape/contract.js';
import { marketSession } from '../src/market-tape/core.js';
import { iexDue, recentSessions, collectSession, iexHistTick } from '../workers/pbe-predictions/src/iex-hist-lane.js';
import { marketTape, _tapeReset } from '../workers/pbe-predictions/src/market-tape-api.js';

// ---------- synthetic capture builder ----------
const ns = (iso) => BigInt(Date.parse(iso)) * 1000000n;
function trade(sym, iso, price, size, flags = 0, type = 0x54) {
  const m = new Uint8Array(38); const dv = new DataView(m.buffer);
  m[0] = type; m[1] = flags; dv.setBigUint64(2, ns(iso), true);
  const s = sym.padEnd(8, ' '); for (let i = 0; i < 8; i++) m[10 + i] = s.charCodeAt(i);
  dv.setUint32(18, size, true); dv.setBigInt64(22, BigInt(Math.round(price * 10000)), true); dv.setBigUint64(30, 1n, true);
  return m;
}
const quote = () => { const m = new Uint8Array(42); m[0] = 0x51; return m; };
function packet(messages) {
  const body = messages.reduce((n, m) => n + 2 + m.length, 0);
  const p = new Uint8Array(42 + 40 + body); const dv = new DataView(p.buffer);
  p[14] = 0x45; // IPv4, IHL 5
  dv.setUint16(42 + 12, body, true); dv.setUint16(42 + 14, messages.length, true);
  let o = 82; for (const m of messages) { dv.setUint16(o, m.length, true); p.set(m, o + 2); o += 2 + m.length; }
  return p;
}
function block(type, payload) {
  const len = 12 + payload.length + ((4 - (payload.length % 4)) % 4);
  const b = new Uint8Array(len); const dv = new DataView(b.buffer);
  dv.setUint32(0, type, true); dv.setUint32(4, len, true); b.set(payload, 8); dv.setUint32(len - 4, len, true);
  return b;
}
function pcapng(packets) {
  const shb = new Uint8Array(16); const sv = new DataView(shb.buffer); sv.setUint32(0, 0x1a2b3c4d, true); sv.setUint16(4, 1, true); sv.setBigInt64(8, -1n, true);
  const parts = [block(0x0a0d0d0a, shb), block(1, new Uint8Array(8))];
  for (const p of packets) { const h = new Uint8Array(20 + p.length); const dv = new DataView(h.buffer); dv.setUint32(12, p.length, true); dv.setUint32(16, p.length, true); h.set(p, 20); parts.push(block(6, h)); }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
const DAY = '2026-10-09';
const CAPTURE = pcapng([
  packet([quote(), trade('SPCX', `${DAY}T12:00:00Z`, 150.00, 100, 0x40)]),          // pre-market (extended hours)
  packet([trade('SPCX', `${DAY}T13:30:01Z`, 160.10, 100), quote()]),                 // open
  packet([trade('SPCX', `${DAY}T19:59:58Z`, 162.55, 200), trade('NVDA', `${DAY}T19:59:59Z`, 229.30, 100)]),
  packet([trade('SPCX', `${DAY}T19:59:59.500Z`, 162.99, 7, 0x20)]),                 // odd lot: never last sale
  packet([trade('SPCX', `${DAY}T20:00:00Z`, 162.57, 5000, 0x08)]),                  // closing cross (single-price cross)
  packet([trade('SPCX', `${DAY}T20:05:00Z`, 163.00, 100, 0x40)]),                   // after hours
  packet([trade('XYZ', `${DAY}T15:00:00Z`, 10, 1)]),                                // not in the universe
  packet([trade('NVDA', `${DAY}T16:00:00Z`, 1, 1, 0, 0x42)]),                       // trade break
]);
const closeNs = Date.parse(`${DAY}T20:00:00Z`) * 1e6, openNs = Date.parse(`${DAY}T13:30:00Z`) * 1e6;

test('TOPS parser: last regular-session last-sale-eligible trade with its exchange timestamp; odd lots / extended hours excluded', () => {
  const p = createTopsParser(['SPCX', 'NVDA', 'AAPL'], { sessionCloseNs: closeNs, sessionOpenNs: openNs });
  // feed in awkward chunk sizes to prove block reassembly
  for (let i = 0; i < CAPTURE.length; i += 37) p.feed(CAPTURE.subarray(i, i + 37));
  const by = Object.fromEntries(p.finish().map((a) => [a.symbol, a]));
  assert.equal(by.SPCX.last_regular_price, 162.57);
  assert.equal(by.SPCX.last_regular_at, '2026-10-09T20:00:00.000Z');
  assert.equal(by.SPCX.high, 162.57); assert.equal(by.SPCX.low, 160.1);
  assert.equal(by.SPCX.trades, 6); assert.equal(by.SPCX.volume, 5507);
  assert.equal(by.SPCX.last_trade_at, '2026-10-09T20:05:00.000Z', 'after-hours trade is recorded but never the regular last sale');
  assert.equal(by.NVDA.last_regular_price, 229.3); assert.equal(by.NVDA.breaks, 1);
  assert.equal(by.AAPL, undefined, 'no trades -> no row, never a zero');
  assert.equal(p.stats.matched, 8);
  assert.throws(() => createTopsParser(['SPCX']).feed(new Uint8Array(64)), /not a pcapng/);
});

test('HIST index: picks the TOPS IEXTP1 file (newest version)', () => {
  const e = topsEntry([{ feed: 'DEEP', protocol: 'IEXTP1', version: '1.0', link: 'd' }, { feed: 'TOPS', protocol: 'IEXTP1', version: '1.5', link: 'a' }, { feed: 'TOPS', protocol: 'IEXTP1', version: '1.6', link: 'b', size: 9 }]);
  assert.equal(e.link, 'b');
  assert.equal(topsEntry([]), null); assert.equal(topsEntry({ error: 1 }), null);
});

test('rights: iex-hist is display-permitted for public and paid; yahoo-chart still is not', () => {
  assert.deepEqual({ ...PROVIDERS['iex-hist'].rights }, { public: true, paid: true });
  assert.equal(PROVIDERS['iex-hist'].attribution, IEX_ATTRIBUTION);
  assert.equal(quoteProvider({ MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, 'public').id, 'iex-hist');
  assert.equal(quoteProvider({ MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, 'public'), null);
  assert.equal(quoteProvider({ MARKET_TAPE_QUOTES: 'off', MARKET_TAPE_PROVIDER: 'iex-hist' }, 'public'), null);
});

const P = { ...PROVIDERS['iex-hist'], scope: 'PUBLIC' };
const Q = (d, px, prevD = null, prev = null) => ({ session_date: d, last_price: px, observed_at: `${d}T20:00:00.000Z`, retrieved_at: '2026-10-10T05:07:00Z', previous_close: prev, previous_session_date: prevD });
test('T+1 states: weekend LAST_CLOSE, open/pre-market PRIOR_SESSION, one-older PRIOR_SESSION, older STALE (no price)', () => {
  const sat = marketSession('2026-10-10T16:00:00Z');
  const a = sessionCloseFields(Q('2026-10-09', 162.57, '2026-10-08', 160.57), sat, P);
  assert.equal(a.state, 'LAST_CLOSE'); assert.equal(a.last_price, 162.57); assert.equal(a.previous_regular_close, 160.57);
  assert.equal(a.change_pct, Math.round(((162.57 - 160.57) / 160.57) * 1e6) / 1e6); assert.equal(a.price_session_date, '2026-10-09');
  assert.equal(a.venue_scope, 'IEX_ONLY'); assert.equal(a.price_basis, 'IEX_LAST_SALE'); assert.equal(a.attribution, IEX_ATTRIBUTION);
  const mon = marketSession('2026-10-12T15:00:00Z'); // Columbus Day: NYSE open
  assert.equal(mon.state, 'OPEN');
  assert.equal(sessionCloseFields(Q('2026-10-09', 162.57), mon, P).state, 'PRIOR_SESSION');
  assert.equal(sessionCloseFields(Q('2026-10-09', 162.57), marketSession('2026-10-12T12:00:00Z'), P).state, 'PRIOR_SESSION');
  // Monday evening, before Monday's file is published: Friday's price is one session older -> still PRIOR_SESSION
  assert.equal(sessionCloseFields(Q('2026-10-09', 162.57), marketSession('2026-10-12T22:00:00Z'), P).state, 'PRIOR_SESSION');
  const old = sessionCloseFields(Q('2026-10-07', 150), sat, P);
  assert.equal(old.state, 'STALE'); assert.equal(old.last_price, null);
  // previous close only from the immediately preceding session
  assert.equal(sessionCloseFields(Q('2026-10-09', 162.57, '2026-10-07', 150), sat, P).previous_regular_close, null);
  assert.equal(sessionCloseFields(null, sat, P).state, 'SOURCE_UNAVAILABLE');
});

test('collector schedule: :07 in UTC 04-13 only; latest three completed sessions (holidays skipped)', () => {
  assert.equal(iexDue('2026-10-10T05:07:00Z'), true);
  assert.equal(iexDue('2026-10-10T05:08:00Z'), false);
  assert.equal(iexDue('2026-10-10T14:07:00Z'), false);
  assert.deepEqual(recentSessions('2026-10-10T05:07:00Z'), ['2026-10-09', '2026-10-08', '2026-10-07']);
  assert.deepEqual(recentSessions('2026-11-27T05:07:00Z'), ['2026-11-25', '2026-11-24', '2026-11-23'], 'Thanksgiving skipped');
  assert.deepEqual(recentSessions('2026-10-13T05:07:00Z')[0], '2026-10-12', 'Columbus Day is a trading session');
});

async function gz(bytes) { return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); }
function memStore(seed = []) {
  const rows = [...seed]; const writes = [];
  return { rows, writes, async select(t, q) {
    if (t === 'pred_source_observations') {
      if (q.observation_key?.startsWith('like.')) { const pre = q.observation_key.slice(5, -1); return rows.filter((r) => r.observation_key.startsWith(pre)); }
      return rows.filter((r) => r.provider === 'iex');
    }
    return [];
  }, async write(t, batch) { writes.push(batch); for (const r of batch) if (!rows.some((x) => x.observation_key === r.observation_key)) rows.push(r); return null; } };
}
const fetchFor = (body, { published = true } = {}) => async (url) => {
  if (url.includes('/api/1.0/hist')) return new Response(JSON.stringify(published ? [{ feed: 'TOPS', protocol: 'IEXTP1', version: '1.6', size: 123, link: 'https://www.googleapis.com/download/storage/v1/b/iex/o/x?generation=1' }] : []), { status: 200 });
  return new Response(body, { status: 200 });
};

test('collector: one immutable observation per symbol (key, exchange time, IEX credit, provenance); idempotent; not-yet-published writes nothing', async () => {
  const body = await gz(CAPTURE);
  const st = memStore();
  const r = await collectSession({ store: st, session: DAY, symbols: ['SPCX', 'NVDA', 'AAPL'], fetchImpl: fetchFor(body), now: () => '2026-10-10T05:07:30.000Z' });
  assert.equal(r.status, 'WRITTEN'); assert.equal(r.rows, 2);
  const spcx = st.rows.find((x) => x.observation_key === 'iex:TOPS:20261009:SPCX');
  assert.equal(spcx.value, 162.57); assert.equal(spcx.observed_at, '2026-10-09T20:00:00.000Z'); assert.equal(spcx.source_class, 'official');
  assert.equal(spcx.data.attribution, IEX_ATTRIBUTION); assert.equal(spcx.data.scope, 'IEX venue only; next-day (T+1)'); assert.equal(spcx.provenance.parser, 'iex-hist-tops/1');
  assert.ok(spcx.available_at <= spcx.captured_at);
  // tick: newest missing session first; a session with rows is never re-processed
  const st2 = memStore(st.rows);
  const t = await iexHistTick({ store: st2, nowIso: '2026-10-10T06:07:00Z', fetchImpl: fetchFor(body) });
  assert.equal(t.session, '2026-10-08', 'already have 10-09 -> next missing (synthetic capture has 10-09 trades, so 10-08 window yields no rows)');
  const st3 = memStore();
  const np = await iexHistTick({ store: st3, nowIso: '2026-10-10T04:07:00Z', fetchImpl: fetchFor(body, { published: false }) });
  assert.equal(np.status, 'NOT_PUBLISHED'); assert.equal(st3.writes.length, 0);
});

test('collector: a truncated/corrupt stream throws and writes nothing', async () => {
  const body = await gz(CAPTURE);
  const st = memStore();
  const broken = async (url) => (url.includes('/api/1.0/hist') ? fetchFor(body)(url) : new Response(new Uint8Array(body).slice(0, 40), { status: 200 }));
  await assert.rejects(collectSession({ store: st, session: DAY, symbols: ['SPCX'], fetchImpl: broken }));
  assert.equal(st.writes.length, 0);
});

test('market-tape/1 with iex-hist: PUBLIC display of our own snapshot (no vendor call per request), credit line, never LIVE', async () => {
  _tapeReset();
  const st = memStore([
    { observation_key: 'iex:TOPS:20261009:SPCX', provider: 'iex', source_id: 'iex:TOPS:SPCX', observed_at: '2026-10-09T20:00:00.000Z', captured_at: '2026-10-10T05:08:00Z', value: 162.57, data: { session_date: '2026-10-09' } },
    { observation_key: 'iex:TOPS:20261008:SPCX', provider: 'iex', source_id: 'iex:TOPS:SPCX', observed_at: '2026-10-08T20:00:00.000Z', captured_at: '2026-10-09T05:08:00Z', value: 160.57, data: { session_date: '2026-10-08' } },
  ]);
  let calls = 0;
  const d = await marketTape({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, store: st, member: false, now: '2026-10-10T16:00:00Z', fetchImpl: async () => { calls++; return new Response('{}'); } });
  assert.equal(calls, 0);
  assert.equal(d.rights.state, 'CLEARED'); assert.equal(d.rights.scope, 'PUBLIC');
  const s = d.lists[0].securities[0];
  assert.equal(s.symbol, 'SPCX'); assert.equal(s.state, 'LAST_CLOSE'); assert.equal(s.last_price, 162.57); assert.equal(s.previous_regular_close, 160.57);
  assert.equal(s.attribution, IEX_ATTRIBUTION); assert.equal(s.price_session_date, '2026-10-09'); assert.equal(s.observed_at, '2026-10-09T20:00:00.000Z');
  const spy = d.lists[0].securities.find((x) => x.symbol === 'SPY');
  assert.equal(spy.state, 'SOURCE_UNAVAILABLE'); assert.equal(spy.last_price, null, 'no observation -> no price, never invented');
  assert.ok(d.lists.flatMap((l) => l.securities).every((x) => x.state !== 'LIVE_QUOTES'));
  assert.equal(d.diagnostics.refresh_hint_seconds, null);
});
