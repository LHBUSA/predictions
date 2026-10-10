// Strategy Arena + metals API (issues #62/#63): access boundary (owner / active / free / lapsed / anonymous / authority
// down), public payloads carry no holdings or NAV, head-to-head assembly (Original indexed at T0, never reset), metals
// rights states (spot always held; ETF prices only from a rights-cleared provider, never invented).
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/worker-assets.js';
import { FakeStore, fakeSource } from './helpers/s10-fakes.js';
import { LATEST_MEMBERS } from '../src/signal10/members-latest.js';
import { runArenaEod, runArenaOpen } from '../src/signal10/arena/forward.js';
import { arenaPayload, arenaProof, metalsPayload } from '../workers/pbe-predictions/src/arena-api.js';
import { indexSeries, seriesMetrics, SHARPE_MIN_OBS } from '../src/signal10/arena/metrics.js';
const { default: worker } = await import('../workers/pbe-predictions/src/index.js');

const req = (path, cookie) => new Request(`https://pbe-predictions.example${path}`, { headers: cookie ? { cookie } : {} });
const verdict = (state, reason = state) => ({ authenticated: state !== 'anon', reason, membership: { product: 'predictions', sport: null, state: state === 'anon' ? 'free' : state, label: 'x', entitled: state === 'all_access' || state === 'owner', email: null } });
const auth = (answer) => ({ fetch: async () => new Response(JSON.stringify(answer), { status: 200 }) });
async function call(path, cookie, a, dbAnswer = null) {
  const realFetch = globalThis.fetch; let db = 0;
  globalThis.fetch = async () => { db += 1; if (dbAnswer) return new Response(dbAnswer, { status: 200 }); throw new Error('db/source reached'); };
  try { const r = await worker.fetch(req(path, cookie), { AUTH: a, SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_KEY: 'x', MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, { waitUntil() {} }); return { r, db, body: await r.text() }; } finally { globalThis.fetch = realFetch; }
}
const GATED = ['/v1/signal10/arena', '/v1/signal10/arena/ledger?account=S10-ARENA-TECH-1'];
const SESSION = 'pbe_session=aaaa.bbbb.cccc';

test('Arena member routes: anonymous 401, free / lapsed 403, authority down 503 — private, no payload, no DB read', async () => {
  for (const p of GATED) {
    const a = await call(p, null, auth(verdict('all_access')));
    assert.equal(a.r.status, 401, p); assert.equal(a.db, 0); assert.match(a.r.headers.get('cache-control'), /private|no-store/);
    for (const [state, reason] of [['free', 'no_all_access'], ['lapsed', 'no_all_access']]) {
      const b = await call(p, SESSION, auth(verdict(state, reason)));
      assert.equal(b.r.status, 403, `${p} ${state}`); assert.equal(b.db, 0); assert.doesNotMatch(b.body, /holdings|series|nav/);
    }
    const c = await call(p, SESSION, auth(verdict('free', 'entitlement_unavailable')));
    assert.equal(c.r.status, 503, p); assert.equal(c.db, 0);
  }
});

test('Arena member routes: All Access and owner get a private 200; ledger rejects unknown and control accounts', async () => {
  for (const state of ['all_access', 'owner']) {
    const r = await call('/v1/signal10/arena', SESSION, auth(verdict(state)), '[]');
    assert.equal(r.r.status, 200, state); assert.match(r.r.headers.get('cache-control'), /private/);
    const body = JSON.parse(r.body);
    assert.equal(body.status, 'AWAITING_T0'); assert.equal(body.access.tier, state);
    assert.deepEqual(body.strategies.map((s) => s.key), ['ORIGINAL', 'TECH', 'DIVERSIFIED']);
  }
  for (const acct of ['S10-FWD-1', 'nope', '']) {
    const r = await call(`/v1/signal10/arena/ledger?account=${acct}`, SESSION, auth(verdict('all_access')), '[]');
    assert.equal(r.r.status, 400, acct);
  }
});

test('public Arena proof: hashes and status only — no NAV, holdings, ranks or decisions', async () => {
  const r = await call('/v1/signal10/arena/proof', null, null, '[]');
  assert.equal(r.r.status, 200); assert.match(r.r.headers.get('cache-control'), /public/);
  const body = JSON.parse(r.body);
  assert.equal(body.strategies.length, 3);
  assert.deepEqual(body.strategies.map((s) => s.account), ['S10-ARENA-ORIG-1', 'S10-ARENA-TECH-1', 'S10-ARENA-DIV-1']);
  for (const s of body.strategies) { assert.match(s.policy_sha256, /^[0-9a-f]{64}$/); assert.equal(s.status, 'AWAITING_T0'); }
  assert.doesNotMatch(r.body, /"holdings"|"series"|"nav|"ranks"|"decisions"|positions/);
  assert.match(body.disclosure, /HYPOTHETICAL/);
});

test('public metals: spot is SOURCE_RIGHTS_HOLD with null values; ETFs await an observation; no member sleeve', async () => {
  const r = await call('/v1/metals', null, auth(verdict('all_access')), '[]');
  assert.equal(r.r.status, 200); assert.match(r.r.headers.get('cache-control'), /public/);
  const b = JSON.parse(r.body);
  assert.equal(b.contract, 'metals/1');
  assert.deepEqual(b.spot.map((x) => x.code), ['XAU', 'XAG', 'XPT']);
  for (const x of b.spot) { assert.equal(x.quote.state, 'SOURCE_RIGHTS_HOLD'); assert.equal(x.quote.value, null); assert.equal(x.unit, 'USD per troy ounce'); }
  for (const x of b.etfs) { assert.equal(x.quote.state, 'AWAITING_FIRST_OBSERVATION'); assert.equal(x.quote.value, null); }
  assert.equal(b.diversified_sleeve, undefined);
});

test('metals: ETF prices only from the rights-cleared IEX snapshot (T+1, labelled), quotes switched off = held for everyone', async () => {
  const store = new FakeStore();
  const row = (sym, d, v) => ({ source_id: `iex:TOPS:${d}:${sym}`, provider: 'iex', observed_at: `${d}T20:00:00Z`, captured_at: `${d}T23:00:00Z`, value: v, data: { session_date: d } });
  const now = new Date().toISOString(); const d1 = now.slice(0, 10); const d0 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  store.rows('pred_source_observations').push(row('GLD', d1, 250), row('GLD', d0, 245), row('AAPL', d1, 999));
  const on = await metalsPayload({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, store, member: false, now });
  const gld = on.etfs.find((x) => x.symbol === 'GLD');
  assert.equal(gld.quote.value, 250); assert.equal(gld.quote.state, 'NEXT_DAY'); assert.match(gld.quote.basis, /not spot/); assert.match(gld.quote.delay, /T\+1/);
  assert.ok(Math.abs(gld.quote.change_pct - (250 / 245 - 1)) < 1e-12);
  assert.ok(on.attribution);
  assert.equal(on.spot[0].quote.value, null, 'an ETF price never becomes a spot price');
  const off = await metalsPayload({ env: { MARKET_TAPE_QUOTES: 'off', MARKET_TAPE_PROVIDER: 'iex-hist' }, store, member: true, now });
  assert.ok(off.etfs.every((x) => x.quote.value === null && x.quote.state === 'SOURCE_RIGHTS_HOLD'));
  const yahoo = await metalsPayload({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'yahoo-chart' }, store, member: true, now });
  assert.ok(yahoo.etfs.every((x) => x.quote.value === null), 'a provider without rights never shows a price, even to members');
  assert.ok('diversified_sleeve' in yahoo);
});

// ---------------- head-to-head assembly ----------------
const S11 = ['COMMUNICATION', 'CONSUMER_DISCRETIONARY', 'CONSUMER_STAPLES', 'ENERGY', 'FINANCIALS', 'HEALTH_CARE', 'INDUSTRIALS', 'MATERIALS', 'REAL_ESTATE', 'UTILITIES'];
const CLS = { effective_from: '2025-01-01', content_sha256: 'f'.repeat(64), rows: Object.fromEntries(LATEST_MEMBERS.tickers.map((t, i) => [t, { sector: i % 4 === 0 ? 'TECHNOLOGY' : S11[i % 10], tech: i % 4 === 0 }])) };
const BULL = { QQQ: { from: 400, factor: 1.3 } };
test('head-to-head: three brand-new accounts, same T0, same $10,000, zero positions; legacy V1 data never read', async () => {
  const store = new FakeStore();
  // legacy V1 rows exist (historical research) and must not influence or appear in the Arena
  store.rows('pred_s10_events').push({ account: 'S10-FWD-1', seq: 1, type: 'FUNDING', d: '2026-09-01', payload: {} });
  store.rows('pred_s10_marks').push({ account: 'S10-FWD-1', kind: 'EOD_CLOSE', d: '2026-09-02', nav_cents: 1_234_567, cash_cents: 1000, positions: [{ symbol: 'LEGACY', valueCents: 1 }], benchmarks: {} });
  const reads = []; const sel = store.select.bind(store); store.select = (t, ...r) => { reads.push(t); return sel(t, ...r); };
  await runArenaEod({ store, now: '2026-09-03T20:35:00Z', fetchImpl: fakeSource({ today: '2026-09-03', at: '2026-09-03T20:00:00Z', shock: BULL }), t0: '2026-09-03', classification: CLS });
  await runArenaOpen({ store, now: '2026-09-04T13:50:00Z', fetchImpl: fakeSource({ today: '2026-09-04', at: '2026-09-04T13:50:00Z', shock: BULL }), t0: '2026-09-03' });
  await runArenaEod({ store, now: '2026-09-04T20:35:00Z', fetchImpl: fakeSource({ today: '2026-09-04', at: '2026-09-04T20:00:00Z', shock: BULL }), t0: '2026-09-03', classification: CLS });
  reads.length = 0;
  const a = await arenaPayload(store);
  assert.ok(!reads.some((t) => /^pred_s10_(events|marks|snapshots|runs)$/.test(t)), `legacy tables read: ${reads.join(',')}`);
  assert.equal(a.t0, '2026-09-03'); assert.equal(a.status, 'RUNNING'); assert.equal(a.common_start, true);
  assert.deepEqual(a.strategies.map((s) => s.key), ['ORIGINAL', 'TECH', 'DIVERSIFIED']);
  for (const s of a.strategies) {
    assert.equal(s.inception, '2026-09-03', s.key); assert.equal(s.series[0].indexed, 10000, s.key); assert.equal(s.series.length, 2);
    assert.ok(s.holdings.every((h) => h.weight == null || (h.weight > 0 && h.weight <= 0.2)));
    assert.match(s.policy_sha256, /^[0-9a-f]{64}$/);
    assert.equal(s.index_base, undefined); assert.equal(s.lifetime, undefined);
  }
  assert.doesNotMatch(JSON.stringify(a), /LEGACY|1234567/);
  assert.ok(a.strategies.find((s) => s.key === 'DIVERSIFIED').holdings.every((h) => h.weight == null || h.weight <= 0.11));
  assert.equal(a.comparators.SPY[0].indexed, 10000);
  assert.equal(a.strategies[1].metrics.sharpe, null, `no Sharpe before ${SHARPE_MIN_OBS} observations`);
  // re-review N2/N3: member payloads never carry a source price or a share-count/value pair
  assert.doesNotMatch(JSON.stringify(a.strategies.map((s) => [s.holdings, s.pending, s.decisions])), /"qty"|"value_cents"|"cost_cents"|"close"|"price"/);
  const mm = await metalsPayload({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, store, member: true });
  assert.equal(mm.diversified_sleeve.candidates.length, 3);
  assert.doesNotMatch(JSON.stringify(mm.diversified_sleeve), /"adj"|"sma200"|"close"|"f":/);
  const proof = await arenaProof(store);
  assert.equal(proof.t0, '2026-09-03');
  assert.ok(proof.strategies.every((s) => s.status === 'RUNNING' && /^[0-9a-f]{64}$/.test(s.ledger_head_hash)));
  assert.doesNotMatch(JSON.stringify(proof), /"holdings"|"nav|"positions"/);
});

test('metrics: gaps never interpolated; drawdown, vol and Sharpe gating', () => {
  const pts = [{ d: '1', nav: 100 }, { d: '2', nav: 110 }, { d: '3', nav: null }, { d: '4', nav: 99 }, { d: '5', nav: 105 }];
  const m = seriesMetrics(pts);
  assert.equal(m.observations, 4); assert.ok(Math.abs(m.total_return - 0.05) < 1e-12);
  assert.ok(Math.abs(m.max_drawdown - (99 / 110 - 1)) < 1e-12); assert.equal(m.max_drawdown_from, '2'); assert.equal(m.max_drawdown_to, '4');
  assert.equal(m.sharpe, null);
  assert.deepEqual(indexSeries(pts).map((p) => p.indexed), [10000, 11000, null, 9900, 10500]);
  const long = Array.from({ length: SHARPE_MIN_OBS + 1 }, (_, i) => ({ d: String(i), nav: 100 * (1 + 0.001 * i + 0.01 * Math.sin(i)) }));
  assert.equal(typeof seriesMetrics(long).sharpe, 'number');
});

test('admin arena run: admin token required; kill switch off = no run', async () => {
  const env = { ADMIN_TOKEN: 'secret', SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_KEY: 'x', SIGNAL10_ARENA: 'false' };
  const r1 = await worker.fetch(new Request('https://x/admin/signal10/arena/run?kind=EOD', { method: 'POST' }), env, { waitUntil() {} });
  assert.equal(r1.status, 401);
  const r2 = await worker.fetch(new Request('https://x/admin/signal10/arena/run?kind=EOD', { method: 'POST', headers: { authorization: 'Bearer secret' } }), env, { waitUntil() {} });
  assert.deepEqual(await r2.json(), { skipped: 'kill_switch_off' });
});
