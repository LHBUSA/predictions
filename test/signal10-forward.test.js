// Signal 10 FORWARD_PAPER lane (fake DB + fake source) and the Signal 10 access boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/worker-assets.js';
import { runEod, runOpen, runMark, ACCOUNT, canonical, sha256Hex, restoreState } from '../src/signal10/forward.js';
import { LATEST_MEMBERS } from '../src/signal10/members-latest.js';
import { MANAGER } from '../src/signal10/policy.js';
const { default: worker } = await import('../workers/pbe-predictions/src/index.js');

// ---------- fake PostgREST store (append-only semantics; ignore-duplicates on conflict) ----------
class FakeStore {
  constructor() { this.t = {}; }
  rows(t) { return (this.t[t] ||= []); }
  async select(table, q = {}, { limit = Infinity, order = null } = {}) {
    let r = this.rows(table).filter((row) => Object.entries(q).every(([k, v]) => {
      if (k === 'select') return true;
      const [op, ...rest] = String(v).split('.'); const val = rest.join('.');
      if (op === 'eq') return String(row[k]) === val;
      if (op === 'neq') return String(row[k]) !== val;
      if (op === 'in') return val.slice(1, -1).split(',').includes(String(row[k]));
      throw new Error('op ' + op);
    }));
    if (order) { const [c, dir] = order.split('.'); r = [...r].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
    return structuredClone(r.slice(0, limit));
  }
  async write(table, rows, { conflictColumn, returnRepresentation } = {}) {
    const out = [];
    for (const row of [].concat(rows)) {
      if (conflictColumn && this.rows(table).some((x) => x[conflictColumn] === row[conflictColumn])) continue;
      this.rows(table).push(structuredClone(row)); out.push(row);
    }
    return returnRepresentation ? out : null;
  }
  insertMany(table, rows, conflictColumn) { return this.write(table, rows, { conflictColumn }); }
}

// ---------- fake source: deterministic daily bars for any symbol ----------
function weekdays(from, n) { const out = []; let t = Date.parse(from + 'T00:00:00Z'); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; }
const CAL = weekdays('2025-01-02', 460).filter((d) => d !== '2026-09-07'); // 2026-09-07 = holiday (no SPY bar)
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 2 ** 32; }
function priceAt(sym, i) { const k = hash(sym); return (20 + 200 * k) * Math.exp(i * (0.0015 * k - 0.0003) + 0.02 * Math.sin(i / 4 + k * 10)); }
function fakeSource({ today, at, holiday = false }) {
  const cal = CAL.filter((d) => d <= today && !(holiday && d === today));
  return async (url) => {
    const u = String(url);
    if (u.includes('githubusercontent')) return new Response('nope', { status: 503 }); // forces the bundled member list
    const sym = decodeURIComponent(u.match(/chart\/([^?]+)/)[1]).replace(/-/g, '.');
    const ts = cal.map((d) => Date.parse(d + 'T13:30:00Z') / 1000);
    const close = cal.map((_, i) => +priceAt(sym, i).toFixed(4));
    const open = close.map((c, i) => +(i ? close[i - 1] * (1 + 0.001 * Math.sin(i)) : c).toFixed(4));
    const lastTime = holiday ? Date.parse(cal.at(-1) + 'T20:00:00Z') / 1000 : Math.floor(Date.parse(at) / 1000);
    const body = { chart: { result: [{ meta: { symbol: sym, longName: `${sym} Corp`, gmtoffset: -14400, regularMarketPrice: close.at(-1), regularMarketTime: lastTime, chartPreviousClose: close.at(-2) },
      timestamp: ts, events: {}, indicators: { quote: [{ open, high: close.map((c) => c * 1.01), low: close.map((c) => c * 0.99), close, volume: close.map(() => 5e6) }], adjclose: [{ adjclose: close }] } }] } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
const D0 = '2026-09-03', D1 = '2026-09-04';

async function verifyChain(store) {
  const ev = await store.select('pred_s10_events', { account: `eq.${ACCOUNT}` }, { order: 'seq.asc' });
  let prev = '0'.repeat(64);
  ev.forEach((e, i) => {
    assert.equal(e.seq, i + 1); assert.equal(e.prev_hash, prev); assert.equal(e.origin, 'FORWARD_PAPER'); prev = e.hash;
  });
  for (const e of ev) {
    const { account, origin, seq, type, d, payload, model_version, policy_version } = e;
    assert.equal(await sha256Hex(e.prev_hash + canonical({ account, origin, seq, type, d, payload, model_version, policy_version })), e.hash);
  }
  return ev;
}

test('forward lane: launch EOD funds $10,000 and freezes ranks; reruns are idempotent; next OPEN fills; next EOD decides', async () => {
  const store = new FakeStore();
  const eod0 = await runEod({ store, now: `${D0}T20:25:00Z`, fetchImpl: fakeSource({ today: D0, at: `${D0}T20:00:00Z` }), startDate: D0 });
  assert.equal(eod0.ok, true, JSON.stringify(eod0));
  let ev = await verifyChain(store);
  assert.equal(ev[0].type, 'FUNDING'); assert.equal(ev[0].payload.cashCents, MANAGER.startingCashCents);
  assert.equal(store.rows('pred_s10_snapshots').length, 1);
  assert.equal(store.rows('pred_s10_snapshots')[0].members.source, 'bundled copy');
  assert.equal(store.rows('pred_s10_snapshots')[0].members.count, LATEST_MEMBERS.tickers.length);
  assert.ok(ev.some((e) => e.type === 'RANK_SNAPSHOT'));
  assert.equal(ev.filter((e) => e.type === 'FILL').length, 0, 'no fills on the funding day');
  const n0 = ev.length;
  // rerun the same EOD: no new events
  assert.deepEqual(await runEod({ store, now: `${D0}T20:27:00Z`, fetchImpl: fakeSource({ today: D0, at: `${D0}T20:00:00Z` }), startDate: D0 }), { skipped: 'eod_done' });
  assert.equal(store.rows('pred_s10_events').length, n0);
  // OPEN on D1: fills only at D1's open; benchmarks bought at the same open
  const open1 = await runOpen({ store, now: `${D1}T13:50:00Z`, fetchImpl: fakeSource({ today: D1, at: `${D1}T13:50:00Z` }) });
  assert.equal(open1.ok, true, JSON.stringify(open1));
  ev = await verifyChain(store);
  const fills = ev.filter((e) => e.type === 'FILL');
  for (const f of fills) assert.equal(f.d, D1);
  assert.ok(fills.length <= MANAGER.maxNewBuysPerSession, 'staged entry cap');
  assert.equal(ev.filter((e) => e.type === 'BENCHMARK_FILL').length, 2);
  const state = restoreState(ev.filter((e) => e.type === 'STATE').at(-1).payload).st;
  assert.equal(state.fillSessions, 1);
  assert.ok(state.cashCents >= 0);
  assert.deepEqual(await runOpen({ store, now: `${D1}T14:10:00Z`, fetchImpl: fakeSource({ today: D1, at: `${D1}T14:10:00Z` }) }), { skipped: 'open_done' });
  // a duplicate EOD claim (another isolate got there first) never writes
  store.rows('pred_s10_runs').push({ run_key: `EOD:${D1}` });
  assert.deepEqual(await runEod({ store, now: `${D1}T20:25:00Z`, fetchImpl: fakeSource({ today: D1, at: `${D1}T20:00:00Z` }), startDate: D0 }), { skipped: 'claimed' });
  store.t.pred_s10_runs = store.rows('pred_s10_runs').filter((r) => r.run_key !== `EOD:${D1}`);
  const eod1 = await runEod({ store, now: `${D1}T20:25:00Z`, fetchImpl: fakeSource({ today: D1, at: `${D1}T20:00:00Z` }), startDate: D0 });
  assert.equal(eod1.ok, true);
  ev = await verifyChain(store);
  assert.equal(store.rows('pred_s10_snapshots').length, 2);
  assert.equal(store.rows('pred_s10_marks').filter((m) => m.kind === 'EOD_CLOSE').length, 2);
  // intraday mark: persisted with coverage
  const mk = await runMark({ store, now: `${D1}T19:00:00Z`, fetchImpl: fakeSource({ today: D1, at: `${D1}T18:59:00Z` }) });
  assert.equal(mk.ok, true); assert.equal(mk.coverage, 1);
});

test('forward lane: holidays, unfinished closes and pre-start dates never write', async () => {
  const store = new FakeStore();
  assert.deepEqual(await runEod({ store, now: '2026-09-07T20:25:00Z', fetchImpl: fakeSource({ today: '2026-09-07', at: '2026-09-04T20:00:00Z', holiday: true }), startDate: '2026-09-01' }), { skipped: 'no_session_today' });
  assert.deepEqual(await runEod({ store, now: `${D0}T20:25:00Z`, fetchImpl: fakeSource({ today: D0, at: `${D0}T19:59:00Z` }), startDate: D0 }), { skipped: 'close_not_final' });
  assert.deepEqual(await runEod({ store, now: `${D0}T20:25:00Z`, fetchImpl: fakeSource({ today: D0, at: `${D0}T20:00:00Z` }), startDate: '2026-09-10' }), { skipped: 'before_start' });
  assert.deepEqual(await runOpen({ store, now: `${D1}T13:50:00Z`, fetchImpl: fakeSource({ today: D1, at: `${D1}T13:50:00Z` }) }), { skipped: 'not_funded' });
  assert.equal(Object.values(store.t).flat().length, 0);
});

// ---------- access boundary ----------
const req = (path, cookie) => new Request(`https://pbe-predictions.example${path}`, { headers: cookie ? { cookie } : {} });
const verdict = (state, reason = state) => ({ authenticated: state !== 'anon', reason, membership: { product: 'predictions', sport: null, state: state === 'anon' ? 'free' : state, label: 'x', entitled: state === 'all_access' || state === 'owner', email: null } });
const auth = (answer) => ({ fetch: async () => new Response(JSON.stringify(answer), { status: 200 }) });
const GATED = ['/v1/signal10/today', '/v1/signal10/live', '/v1/signal10/backtest', '/v1/signal10/backtest/ranks', '/v1/signal10/ledger?origin=HISTORICAL_REPLAY', '/v1/signal10/ledger?origin=FORWARD_PAPER'];
async function call(path, cookie, a) {
  const realFetch = globalThis.fetch; let db = 0;
  globalThis.fetch = async () => { db += 1; throw new Error('db/source reached'); };
  try { const r = await worker.fetch(req(path, cookie), { AUTH: a, SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_KEY: 'x' }, { waitUntil() {} }); return { r, db, body: await r.text() }; } finally { globalThis.fetch = realFetch; }
}
const LEAK = /18775|1877534|DELL|PERSISTENCE_ENTRY|"nav"|ledger_sha|final_holdings/;
test('Signal 10 member routes: anonymous 401, signed-in without All Access 403, authority down 503 - no payload, no DB/source read', async () => {
  for (const p of GATED) {
    const a = await call(p, null, auth(verdict('all_access')));
    assert.equal(a.r.status, 401, p); assert.equal(a.db, 0); assert.doesNotMatch(a.body, LEAK);
    const b = await call(p, 'pbe_session=aaaa.bbbb.cccc', auth(verdict('free', 'no_all_access')));
    assert.equal(b.r.status, 403, p); assert.doesNotMatch(b.body, LEAK);
    const c = await call(p, 'pbe_session=aaaa.bbbb.cccc', auth(verdict('free', 'entitlement_unavailable')));
    assert.equal(c.r.status, 503, p); assert.doesNotMatch(c.body, LEAK);
    assert.match(a.r.headers.get('cache-control'), /private|no-store/);
  }
});
test('Signal 10 admin trigger requires the admin token', async () => {
  const r = await worker.fetch(new Request('https://x/admin/signal10/run?kind=EOD', { method: 'POST' }), { ADMIN_TOKEN: 'secret', SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_KEY: 'x' }, { waitUntil() {} });
  assert.equal(r.status, 401);
});
test('public proof route carries hashes and the labelled hypothetical headline only - never rankings or holdings', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200 });
  try {
    const r = await worker.fetch(req('/v1/signal10/proof'), { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_KEY: 'x' }, { waitUntil() {} });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.backtest.origin, 'HISTORICAL_REPLAY');
    assert.match(body.disclosure, /HYPOTHETICAL/);
    assert.doesNotMatch(JSON.stringify(body), /DELL|final_holdings|"ranks"|PERSISTENCE/);
    assert.equal(body.forward.status, 'NOT_STARTED');
  } finally { globalThis.fetch = realFetch; }
});
