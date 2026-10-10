// Issue #69: signal10-ledger-writer/2 — a persistence-only repair of the ORIGINAL Signal 10 forward account.
// The legacy STATE is produced by the FROZEN writer/1 code (test/fixtures/signal10-forward-writer1.js = main 2c85084), so
// the fixture has the exact production shape: flat payload, no seq/origin, pending orders. Writer/2 then restarts from it
// (twice and more) through a JSON round-trip store (jsonb semantics). Every economic outcome must equal writer/1's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import './helpers/worker-assets.js';
import * as W2 from '../src/signal10/forward.js';
import * as W1 from './fixtures/signal10-forward-writer1.js';

const T = 'pred_s10_events';
// ---------- JSON round-trip store (PostgREST + jsonb: undefined dropped, NaN -> null) ----------
class JsonStore {
  constructor() { this.t = {}; }
  rows(t) { return (this.t[t] ||= []); }
  async select(table, q = {}, { limit = Infinity, order = null } = {}) {
    let r = this.rows(table).filter((row) => Object.entries(q).every(([k, v]) => {
      if (k === 'select') return true;
      const [op, ...rest] = String(v).split('.'); const val = rest.join('.');
      if (op === 'eq') return String(row[k]) === val;
      if (op === 'gt') return row[k] > Number(val);
      throw new Error('op ' + op);
    }));
    if (order) { const [c, dir] = order.split('.'); r = [...r].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
    return JSON.parse(JSON.stringify(r.slice(0, limit)));
  }
  async write(table, rows, { conflictColumn, returnRepresentation } = {}) {
    const out = [];
    for (const row of [].concat(rows)) {
      if (conflictColumn && this.rows(table).some((x) => x[conflictColumn] === row[conflictColumn])) continue;
      this.rows(table).push(JSON.parse(JSON.stringify(row))); out.push(row);
    }
    return returnRepresentation ? out : null;
  }
  insertMany(table, rows, conflictColumn) { return this.write(table, rows, { conflictColumn }); }
  clone() { const s = new JsonStore(); s.t = JSON.parse(JSON.stringify(this.t)); return s; }
}

// ---------- deterministic source: uptrends with regular pullbacks so the V1 manager really trades ----------
function weekdays(from, n) { const out = []; let t = Date.parse(from + 'T00:00:00Z'); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; }
const CAL = weekdays('2025-01-02', 470);
function h(s) { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return (x >>> 0) / 2 ** 32; }
const px = (sym, i) => { const k = h(sym); return (30 + 150 * k) * Math.exp(i * (0.0008 + 0.0022 * k)) * (1 + 0.045 * Math.sin(i / (2.2 + 2 * k) + 7 * k)); };
function source({ today, at, splits = {} }) {
  const cal = CAL.filter((d) => d <= today);
  return async (url) => {
    const u = String(url);
    if (u.includes('githubusercontent')) return new Response('nope', { status: 503 });
    const sym = decodeURIComponent(u.match(/chart\/([^?]+)/)[1]).replace(/-/g, '.');
    const ts = cal.map((d) => Date.parse(d + 'T13:30:00Z') / 1000);
    // split-adjusted closes like the real source: prices before a split are divided by its ratio
    const sp = splits[sym] || [];
    const adjF = (d) => sp.reduce((f, s) => (d < s.d ? f / s.ratio : f), 1);
    const close = cal.map((d, i) => +(px(sym, i) * adjF(d)).toFixed(4));
    const open = close.map((c, i) => +(i ? close[i - 1] * (1 + 0.002 * Math.sin(i * 1.7 + h(sym))) : c).toFixed(4));
    const ev = {}; for (const s of sp) if (s.d <= today) { const t = Date.parse(s.d + 'T13:30:00Z') / 1000; ev[t] = { date: t, numerator: s.ratio, denominator: 1 }; }
    const body = { chart: { result: [{ meta: { symbol: sym, longName: `${sym} Corp`, gmtoffset: -14400, regularMarketPrice: close.at(-1), regularMarketTime: Math.floor(Date.parse(at) / 1000), chartPreviousClose: close.at(-2) },
      timestamp: ts, events: { splits: ev }, indicators: { quote: [{ open, high: close.map((c) => c * 1.01), low: close.map((c) => c * 0.99), close, volume: close.map(() => 8e6) }], adjclose: [{ adjclose: close }] } }] } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
const START = CAL[430]; // funding day with pending orders (like production: 2 queued buys)
const DAYS = CAL.slice(431, 439);
const eod = (M, store, d, o = {}) => M.runEod({ store, now: `${d}T20:25:00Z`, fetchImpl: source({ today: d, at: `${d}T20:00:00Z`, ...o }), startDate: START });
const open = (M, store, d, o = {}) => M.runOpen({ store, now: `${d}T13:50:00Z`, fetchImpl: source({ today: d, at: `${d}T13:50:00Z`, ...o }) });
const ledger = (store) => store.rows(T).slice().sort((a, b) => a.seq - b.seq);
async function verify(rows) {
  let prev = '0'.repeat(64);
  for (const [i, r] of rows.entries()) {
    assert.equal(r.seq, i + 1, 'contiguous seq'); assert.equal(r.prev_hash, prev, `prev_hash at ${r.seq}`);
    const { account, origin, seq, type, d, payload, model_version, policy_version } = r; // the documented V1 formula, on STORED bytes
    assert.equal(await W2.sha256Hex(prev + W2.canonical({ account, origin, seq, type, d, payload, model_version, policy_version })), r.hash, `hash at ${r.seq} ${type}`);
    prev = r.hash;
  }
}

// funding day by the FROZEN legacy writer = the production starting point (flat STATE, pending orders)
async function legacyFunded() {
  const store = new JsonStore();
  const r = await eod(W1, store, START);
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = ledger(store).find((x) => x.type === 'STATE');
  assert.equal(st.payload.state, undefined, 'legacy flat STATE');
  assert.equal(st.payload.seq, undefined); assert.equal(st.payload.origin, undefined);
  assert.ok(st.payload.pending.length >= 1, 'pending orders like production');
  return store;
}
async function runSessions(M, store, days, { splits = {} } = {}) {
  for (const d of days) { await open(M, store, d, { splits }); await eod(M, store, d, { splits }); }
}

test('reproduction: writer/1 breaks hash verification and order links after a restart (the #69 defect)', async () => {
  const store = await legacyFunded();
  await runSessions(W1, store, DAYS.slice(0, 4));
  const rows = ledger(store);
  await assert.rejects(verify(rows), /hash at/, 'writer/1 rows are not verifiable from stored bytes');
  const fills = rows.filter((r) => r.type === 'FILL' && r.d > DAYS[0]);
  assert.ok(fills.some((f) => f.payload.orderSeq == null), 'post-restart fills lost their order reference');
});

test('writer/2 from the real legacy shape: restart repeatedly, every stored row verifies, seq/prev_hash contiguous', async () => {
  const store = await legacyFunded();
  await runSessions(W2, store, DAYS);
  const rows = ledger(store);
  await verify(rows);
  const up = rows.filter((r) => r.type === 'LEDGER_WRITER_UPGRADE');
  assert.equal(up.length, 1, 'upgrade recorded exactly once');
  assert.equal(up[0].payload.from, 'signal10-ledger-writer/1'); assert.equal(up[0].payload.to, 'signal10-ledger-writer/2');
  assert.ok(up[0].payload.pendingLinks.length >= 1 && up[0].payload.pendingLinks.every((l) => l.link === 'VERIFIED'), JSON.stringify(up[0].payload.pendingLinks));
  const states = rows.filter((r) => r.type === 'STATE');
  assert.ok(states.slice(1).every((s) => s.payload.writer === 'signal10-ledger-writer/2' && s.payload.state && s.payload.state.origin === 'FORWARD_PAPER' && Number.isInteger(s.payload.state.seq)));
  assert.equal(states[0].payload.state, undefined, 'the legacy row is never rewritten');
  // local seq == ledger seq: the last STATE's stored seq equals the seq of the row just before it
  for (const s of states.slice(1)) assert.equal(s.payload.state.seq, s.seq - 1);
});

test('writer/2: every FILL.orderSeq points at the actual ORDER row (same symbol, side, earlier session)', async () => {
  const store = await legacyFunded();
  await runSessions(W2, store, DAYS);
  const rows = ledger(store);
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const fills = rows.filter((r) => r.type === 'FILL');
  assert.ok(fills.length >= 3, `fixture trades (${fills.length} fills)`);
  for (const f of fills) {
    const o = bySeq.get(f.payload.orderSeq);
    assert.ok(o && o.type === 'ORDER', `fill ${f.seq} -> order ${f.payload.orderSeq}`);
    assert.equal(o.payload.symbol, f.payload.symbol); assert.equal(o.payload.side, f.payload.side); assert.ok(o.d < f.d);
  }
});

test('economic parity: writer/1 and writer/2 produce identical cash, positions, orders, fills and decisions', async () => {
  const base = await legacyFunded();
  const a = base.clone(); const b = base.clone();
  await runSessions(W1, a, DAYS); await runSessions(W2, b, DAYS);
  const econ = (store) => {
    const rows = ledger(store);
    const pick = (types, keys) => rows.filter((r) => types.includes(r.type)).map((r) => [r.type, r.d, ...keys.map((k) => JSON.stringify(r.payload[k] ?? null))].join('|'));
    const lastState = rows.filter((r) => r.type === 'STATE').at(-1).payload;
    const st = lastState.state || lastState;
    return {
      orders: pick(['ORDER'], ['side', 'symbol', 'qty', 'targetCents', 'reason', 'rank']),
      fills: pick(['FILL', 'ORDER_EXPIRED', 'ORDER_UNFILLED', 'SPLIT', 'DIVIDEND', 'BENCHMARK_FILL'], ['side', 'symbol', 'qty', 'price', 'notionalCents', 'cashCents']),
      decisions: pick(['DECISION'], ['action', 'symbol', 'reason']),
      marks: pick(['EOD_MARK'], ['navCents', 'cashCents', 'positions', 'benchmarks']),
      cash: st.cashCents, positions: st.positions, realized: st.realizedCents, slippage: st.slippageCents, pending: st.pending.map((o) => [o.side, o.symbol, o.qty, o.targetCents]),
    };
  };
  const ea = econ(a), eb = econ(b);
  assert.ok(ea.fills.length >= 3);
  assert.deepEqual(eb, ea);
});

test('idempotency + concurrency survive the upgrade: reruns skip, two concurrent EODs write once', async () => {
  const store = await legacyFunded();
  const d = DAYS[0];
  await open(W2, store, d);
  const n = store.rows(T).length;
  assert.deepEqual(await open(W2, store, d), { skipped: 'open_done' });
  const [x, y] = await Promise.all([eod(W2, store, d), eod(W2, store, d)]);
  assert.equal([x, y].filter((r) => r.ok).length, 1, JSON.stringify([x, y]));
  assert.deepEqual(await eod(W2, store, d), { skipped: 'eod_done' });
  assert.ok(store.rows(T).length > n);
  await verify(ledger(store));
  assert.equal(ledger(store).filter((r) => r.type === 'LEDGER_WRITER_UPGRADE').length, 1);
});

test('pending orders and a split across a restart: split applied once, chain verifies', async () => {
  const store = await legacyFunded();
  await runSessions(W2, store, DAYS.slice(0, 3));
  const held = Object.keys(W2.restoreState(ledger(store).filter((r) => r.type === 'STATE').at(-1).payload).st.positions);
  assert.ok(held.length, 'fixture holds a position');
  const sym = held[0];
  const splits = { [sym]: [{ d: DAYS[3], ratio: 2 }] };
  const before = W2.restoreState(ledger(store).filter((r) => r.type === 'STATE').at(-1).payload).st.positions[sym].qty;
  await runSessions(W2, store, DAYS.slice(3, 5), { splits });
  const rows = ledger(store);
  const sp = rows.filter((r) => r.type === 'SPLIT' && r.payload.symbol === sym);
  assert.equal(sp.length, 1); assert.equal(sp[0].payload.qtyBefore, before); assert.equal(sp[0].payload.qtyAfter, before * 2);
  await verify(rows);
});

test('restoreState reads legacy flat and writer/2 nested STATE for every caller', async () => {
  const store = await legacyFunded();
  const legacy = ledger(store).find((r) => r.type === 'STATE').payload;
  const l = W2.restoreState(legacy);
  assert.equal(l.legacy, true); assert.ok(Array.isArray(l.st.pending)); assert.ok(l.bench.SPY);
  await runSessions(W2, store, DAYS.slice(0, 1));
  const v2 = ledger(store).filter((r) => r.type === 'STATE').at(-1).payload;
  const n = W2.restoreState(v2);
  assert.equal(n.legacy, false); assert.ok(n.st.positions && n.bench.QQQ && n.st.events.length === 0);
  assert.equal(n.st.origin, 'FORWARD_PAPER');
});

test('only the persistence layer changed: model, policy, ranking and accounting files are byte-identical to main', () => {
  const sha = (p) => createHash('sha256').update(readFileSync(new URL(`../${p}`, import.meta.url))).digest('hex');
  const PINNED = {
    'src/signal10/policy.js': '747adcde9094e6db691da4fe5745aca285e894736cfa385e9bd3764dad9ae232',
    'src/signal10/rank.js': '16d329262a39cdd6c62415919e1b57b099060225480411c658e33c537570a836',
    'src/signal10/portfolio.js': 'bc475f4d41365649d2554af5e54ab8f59296c51b0448ed12ca77432bb97e6c96',
    'src/signal10/data.js': '6969e6a9c94a05a247837e2b501227db04eee810dc45472fadf0b324da1f35c9',
    'src/signal10/universe.js': '82c258da9dd4de2476e13b9315dd69fbd3cbbb3c7bcd4be696e1e0c0027e91ed',
    'src/signal10/aliases.js': '4a23301e8f3deff157d8c10696381df376fc70c90196444bf7bac3390569bee4',
    'src/signal10/members-latest.js': '18747f8aed3c3416964b76ad393d1f77b2c3017e774359ad3da704b510c103d1',
    'sql/016_signal10_forward.sql': '6301cc1a2adb85c8a8a9e5530395762c8e39459e1ca20ecaca493278fa8a3b23',
  };
  for (const [f, h] of Object.entries(PINNED)) assert.equal(sha(f), h, `${f} must not change`);
  assert.equal(W2.LEDGER_WRITER, 'signal10-ledger-writer/2');
});
