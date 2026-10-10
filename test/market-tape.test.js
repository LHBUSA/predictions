// PBE Market Tape `market-tape/1` (issue #56): source-independent contract, rights gate (env cannot widen rights; members
// fail closed), security identity (SPCX 2026 IPO), PBE Signal 10 research overlay from frozen snapshots only, lists kept
// apart (EDITORIAL / MODEL_RESEARCH / SIMULATED_PAPER), the legacy /v1/signal10/tape view, and bounded upstream load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as MT from '../src/market-tape/contract.js';
import { marketTape, handleMarketTape, TAPE_BUDGET, _tapeReset } from '../workers/pbe-predictions/src/market-tape-api.js';
import { tape } from '../workers/pbe-predictions/src/signal10-api.js';

const NOW_OPEN = '2026-10-13T15:00:00Z';
const NOW_SAT = '2026-10-10T16:00:00Z';
const PRICE_FIELDS = ['last_price', 'previous_regular_close', 'change_abs', 'change_pct', 'observed_at', 'retrieved_at'];

const bars = (symbol, price, timeIso, days) => ({ chart: { result: [{ meta: { symbol, regularMarketPrice: price, regularMarketTime: Date.parse(timeIso) / 1000 },
  timestamp: days.map(([d]) => Date.parse(`${d}T13:30:00Z`) / 1000), indicators: { quote: [{ close: days.map(([, c]) => c) }] } }] } });
function vendor() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, cf: init?.cf });
    const sym = decodeURIComponent(/chart\/([^?]+)/.exec(url)[1]);
    return new Response(JSON.stringify(bars(sym, 110, '2026-10-13T14:59:40Z', [['2026-10-12', 100], ['2026-10-13', 110]])), { status: 200 });
  };
  return { calls, fetchImpl };
}
const SNAP = (d, syms) => ({ d, model_version: 'signal10-rank/1.0.0', frozen_at: `${d}T21:00:00Z`, eligible: 499, content_sha256: 'abc', ranks: syms.map((s, i) => ({ rank: i + 1, symbol: s, name: s, score: 99 - i })) });
function store({ snaps = [], state = null } = {}) {
  return { async select(t) { if (t === 'pred_s10_snapshots') return snaps; if (t === 'pred_s10_events') return state ? [{ seq: 1, d: '2026-10-12', payload: state }] : []; return []; } };
}
// cleared test provider: reuses the yahoo adapter id, but with an explicit rights record (only tests construct this)
const CLEARED = { 'yahoo-chart': { ...MT.PROVIDERS['yahoo-chart'], rights: { public: true, paid: true }, attribution: 'TEST', quote_delay_known: true } };

test('rights: env cannot widen rights — the real provider record has none, so every audience fails closed', () => {
  for (const env of [{}, { MARKET_TAPE_QUOTES: 'off' }, { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'nope' }]) {
    for (const aud of ['public', 'paid']) {
      assert.equal(MT.quoteProvider(env, aud), null, JSON.stringify(env) + aud);
      assert.equal(MT.rightsState(env, aud).state, 'SOURCE_RIGHTS_HOLD');
      assert.equal(MT.rightsState(env, aud).scope, 'NONE');
    }
  }
  assert.equal(MT.PROVIDERS['yahoo-chart'].rights.paid, false, 'a paywall is not redistribution permission');
  assert.equal(MT.quoteProvider({ MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, 'paid', CLEARED).id, 'yahoo-chart');
  assert.equal(MT.quoteProvider({ MARKET_TAPE_QUOTES: 'off', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, 'paid', CLEARED), null, 'operator switch still required');
});

test('identity: SPCX carries its 2026 listing (no reuse of an earlier SPCX), every featured symbol has exchange + MIC', () => {
  assert.equal(MT.securityId('SPCX'), 'SPCX:XNAS:2026-06-12');
  assert.equal(MT.IDENTITY.SPCX.cusip, '84615Q103');
  assert.equal(MT.securityId('SPY'), 'SPY:ARCX');
  assert.equal(MT.securityId('ZZZ'), 'ZZZ:US');
  for (const it of MT.featuredList().items) assert.ok(MT.IDENTITY[it.symbol]?.mic, it.symbol);
});

test('payload shape: market-tape/1, every security has the full field set, SPCX first, nulls without rights', async () => {
  _tapeReset();
  const v = vendor();
  const d = await marketTape({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, store: store(), member: true, now: NOW_OPEN, fetchImpl: v.fetchImpl });
  assert.equal(d.contract, 'market-tape/1');
  assert.equal(v.calls.length, 0, 'no rights -> no vendor call, even for members with the switch on');
  assert.equal(d.rights.state, 'SOURCE_RIGHTS_HOLD');
  const sec = d.lists[0].securities;
  assert.equal(sec[0].symbol, 'SPCX'); assert.equal(sec[0].pinned, true);
  for (const s of sec) {
    for (const k of ['symbol', 'name', 'security_id', 'exchange', 'mic', 'robinhood_url', 'market_session', 'session_open_at', 'session_close_at', 'next_open_at', 'source', 'observed_at', 'retrieved_at', 'quote_delay_known', 'state', ...PRICE_FIELDS, 'attribution', 'rights_scope']) assert.ok(k in s, `${s.symbol}.${k}`);
    for (const k of PRICE_FIELDS) assert.equal(s[k], null, `${s.symbol}.${k}`);
    assert.equal(s.state, 'SOURCE_RIGHTS_HOLD'); assert.equal(s.rights_scope, 'NONE'); assert.equal(s.market_session, 'OPEN');
  }
  assert.equal(d.session.state, 'OPEN');
  assert.equal(d.diagnostics.priced, 0);
});

test('public payload: featured only, no research, no rankings, no holdings', async () => {
  const st = { v: 1 };
  const d = await marketTape({ env: {}, store: store({ snaps: [SNAP('2026-10-09', ['PSX', 'NVDA'])] }), member: false, now: NOW_SAT });
  assert.deepEqual(d.lists.map((l) => l.key), ['FEATURED']);
  assert.equal(d.research_snapshot, null);
  assert.ok(d.lists[0].securities.every((s) => !('research' in s)));
  assert.ok(!JSON.stringify(d).includes('PSX'));
  void st;
});

test('member research: genuine frozen-snapshot ranks, moves and paper flags; SPCX marked outside the model universe', async () => {
  const cur = SNAP('2026-10-09', ['PSX', 'VLO', 'NVDA', 'MU']);
  const prev = SNAP('2026-10-08', ['NVDA', 'PSX', 'AAPL']);
  const idx = MT.researchIndex(cur, prev, ['MU'], new Set(['PSX', 'VLO', 'NVDA', 'MU', 'AAPL', 'MSFT']));
  assert.deepEqual({ ...idx.of('NVDA') }, { label: 'PBE SIGNAL 10 RESEARCH', snapshot_d: '2026-10-09', in_universe: true, rank: 3, prev_rank: 1, move: 'DOWN', score: 97, paper_held: false, paper_label: null });
  assert.equal(idx.of('PSX').move, 'UP');
  assert.equal(idx.of('VLO').move, 'NEW');
  assert.equal(idx.of('MU').paper_held, true); assert.equal(idx.of('MU').paper_label, 'SIMULATED PAPER POSITION');
  const sp = idx.of('SPCX');
  assert.equal(sp.in_universe, false); assert.equal(sp.rank, null, 'never a rank for a symbol outside the model universe');
  assert.equal(idx.of('MSFT').in_universe, true); assert.equal(idx.of('MSFT').rank, null);
  assert.equal(MT.researchIndex(null, null), null);
  assert.equal(MT.researchIndex(cur, null).of('PSX').move, null, 'first snapshot: no move, not NEW');
});

test('member lists: EDITORIAL vs MODEL_RESEARCH vs SIMULATED_PAPER, labelled, built from the ledger only', async () => {
  const d = await marketTape({ env: {}, store: store({ snaps: [SNAP('2026-10-09', ['PSX', 'VLO', 'MPC', 'EXPD', 'MRNA', 'MU', 'STT', 'DELL', 'TGT', 'VTRS', 'NVDA'])] }), member: true, now: NOW_SAT });
  assert.deepEqual(d.lists.map((l) => [l.key, l.kind]), [['FEATURED', 'EDITORIAL'], ['SIGNAL10_TOP10', 'MODEL_RESEARCH']]);
  const top = d.lists[1];
  assert.equal(top.securities.length, 10); assert.equal(top.label, 'Top 10 · as of Oct 9 close');
  assert.equal(top.securities[0].research.rank, 1);
  assert.equal(d.lists[0].securities.find((s) => s.symbol === 'NVDA').research.rank, 11, 'featured symbols carry their genuine rank');
  assert.equal(d.research_snapshot.d, '2026-10-09');
  assert.equal(d.research_snapshot.model, 'signal10-rank/1.0.0');
});

test('research outage never breaks the tape: featured still renders without research', async () => {
  const broken = { async select() { throw new Error('db down'); } };
  const d = await marketTape({ env: {}, store: broken, member: true, now: NOW_SAT });
  assert.deepEqual(d.lists.map((l) => l.key), ['FEATURED']);
  assert.equal(d.lists[0].securities.length, 11);
});

test('cleared provider (test-only rights): source time kept, LIVE_QUOTES/LAST_CLOSE states, attribution + scope, 2xx-only edge cache', async () => {
  _tapeReset();
  const v = vendor();
  const d = await marketTape({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, store: store(), member: false, now: NOW_OPEN, fetchImpl: v.fetchImpl, providers: CLEARED });
  const s = d.lists[0].securities[0];
  assert.equal(s.state, 'LIVE_QUOTES'); assert.equal(s.last_price, 110); assert.equal(s.previous_regular_close, 100); assert.equal(s.change_pct, 0.1);
  assert.equal(s.observed_at, '2026-10-13T14:59:40.000Z'); assert.ok(s.retrieved_at && s.retrieved_at !== s.observed_at);
  assert.equal(s.attribution, 'TEST'); assert.equal(s.rights_scope, 'PUBLIC'); assert.equal(s.source, 'yahoo-chart');
  assert.deepEqual(v.calls[0].cf.cacheTtlByStatus, { '200-299': 45, '300-599': 0 });
  assert.equal(d.rights.state, 'CLEARED');
});

test('load: 1 / 100 / 1000 concurrent viewers — zero upstream calls without rights; bounded by symbols (and budget) with rights', async () => {
  for (const n of [1, 100, 1000]) {
    _tapeReset();
    const v = vendor();
    await Promise.all(Array.from({ length: n }, () => marketTape({ env: {}, store: store(), member: n % 2 === 0, now: NOW_OPEN, fetchImpl: v.fetchImpl })));
    assert.equal(v.calls.length, 0, `${n} viewers, no rights`);
  }
  for (const n of [1, 100, 1000]) {
    _tapeReset();
    const v = vendor();
    // warm one request, then n concurrent viewers in the same isolate: served from the memo
    await marketTape({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, store: store(), member: false, now: NOW_OPEN, fetchImpl: v.fetchImpl, providers: CLEARED });
    await Promise.all(Array.from({ length: n }, () => marketTape({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, store: store(), member: false, now: NOW_OPEN, fetchImpl: v.fetchImpl, providers: CLEARED })));
    assert.equal(v.calls.length, 11, `${n} viewers -> 11 upstream calls (one per symbol)`);
  }
  // cold stampede: the per-isolate budget caps upstream even when every viewer misses at once
  _tapeReset();
  const v = vendor();
  await Promise.all(Array.from({ length: 1000 }, () => marketTape({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, store: store(), member: false, now: NOW_OPEN, fetchImpl: v.fetchImpl, providers: CLEARED })));
  assert.ok(v.calls.length <= TAPE_BUDGET.perMinute, `cold stampede capped at ${TAPE_BUDGET.perMinute} (got ${v.calls.length})`);
});

test('payload stays small: public featured payload under 12 kB', async () => {
  const d = await marketTape({ env: {}, store: store(), member: false, now: NOW_SAT });
  assert.ok(JSON.stringify(d).length < 12000, String(JSON.stringify(d).length));
});

// ---------- HTTP: /v1/market-tape + /admin/market-tape + legacy /v1/signal10/tape ----------
const privateJson = (d, status = 200, extra = {}) => new Response(JSON.stringify(d), { status, headers: { 'cache-control': 'private, no-store, max-age=0', vary: 'Cookie', ...extra } });
const json = (d, status = 200) => new Response(JSON.stringify(d), { status });
const tokenMatches = async (req, t) => !!t && req.headers.get('authorization') === `Bearer ${t}`;

test('HTTP /v1/market-tape: private/no-store/Vary, contract header, soft entitlement (unverifiable -> public), GET only', async () => {
  const call = (ok, method = 'GET') => handleMarketTape({ req: new Request('https://x/v1/market-tape', { method }), env: {}, p: '/v1/market-tape', store: store({ snaps: [SNAP('2026-10-09', ['PSX'])] }),
    requireAllAccess: async () => (ok === 'throw' ? Promise.reject(new Error('auth down')) : ok ? { ok: true, m: { membership: { state: 'all_access' } } } : { ok: false }), privateJson, json, tokenMatches });
  const r = await call(false);
  assert.match(r.headers.get('cache-control'), /private, no-store/); assert.equal(r.headers.get('vary'), 'Cookie'); assert.equal(r.headers.get('x-pbe-contract'), 'market-tape/1');
  assert.equal((await r.json()).audience, 'public');
  assert.equal((await (await call('throw')).json()).audience, 'public');
  assert.equal((await (await call(true)).json()).audience, 'paid');
  assert.equal((await call(true, 'POST')).status, 405);
});

test('HTTP /admin/market-tape: token required (admin or read-only diagnostics)', async () => {
  const env = { ADMIN_TOKEN: 'a'.repeat(8), DIAGNOSTICS_TOKEN: 'd'.repeat(8) };
  const call = (auth) => handleMarketTape({ req: new Request('https://x/admin/market-tape', { headers: auth ? { authorization: `Bearer ${auth}` } : {} }), env, p: '/admin/market-tape', store: store(), requireAllAccess: async () => ({ ok: false }), privateJson, json, tokenMatches });
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('wrong')).status, 401);
  assert.equal((await (await call(env.DIAGNOSTICS_TOKEN)).json()).audience, 'paid');
  assert.equal((await call(env.ADMIN_TOKEN)).status, 200);
});

test('legacy /v1/signal10/tape maps market-tape/1 (rights hold -> SOURCE_RIGHTS_HOLD, no prices, member groups kept)', async () => {
  _tapeReset();
  const v = vendor();
  const r = await tape({ req: new Request('https://x/'), env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, ctx: { waitUntil() {} }, store: store({ snaps: [SNAP('2026-10-09', ['PSX', 'VLO'])] }),
    requireAllAccess: async () => ({ ok: true, m: { membership: { state: 'all_access' } } }), privateJson, now: NOW_SAT, fetchImpl: v.fetchImpl });
  const d = await r.json();
  assert.equal(v.calls.length, 0);
  assert.deepEqual(d.quotes, { mode: 'OFF', shown: false, withheld: 'SOURCE_RIGHTS_HOLD' });
  assert.deepEqual(d.groups.map((g) => g.key), ['FEATURED', 'TOP10']);
  assert.equal(d.groups[0].rows[0].symbol, 'SPCX');
  assert.equal(d.groups[1].rows[0].rank, 1);
  assert.ok(d.groups.flatMap((g) => g.rows).every((x) => x.price === null && x.status === 'SOURCE_RIGHTS_HOLD'));
  assert.equal(d.session.state, 'CLOSED_WEEKEND'); assert.equal(d.session.last_close_at, '2026-10-09T20:00:00.000Z');
  const pub = await (await tape({ req: new Request('https://x/'), env: {}, ctx: { waitUntil() {} }, store: store({ snaps: [SNAP('2026-10-09', ['PSX'])] }), requireAllAccess: async () => ({ ok: false }), privateJson, now: NOW_SAT })).json();
  assert.deepEqual(pub.groups.map((g) => g.key), ['FEATURED']);
  assert.ok(!JSON.stringify(pub).includes('PSX'));
});
