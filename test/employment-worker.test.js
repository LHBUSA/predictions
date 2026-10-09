// pbe-employment-collector (Cloudflare Worker port of the Employment Tier A collector): integrity rules under fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tick } from '../workers/pbe-employment-collector/src/collector.js';
import { makeGet } from '../workers/pbe-employment-collector/src/http.js';
import { MemoryState } from '../workers/pbe-employment-collector/src/state.js';
import { EvidenceStore } from '../workers/pbe-employment-collector/src/store.js';
import { verifyChain } from '../workers/pbe-employment-collector/src/ledger.js';
import { sha256 } from '../workers/pbe-employment-collector/src/util.js';
import { verify } from '../workers/pbe-employment-collector/src/verify.js';

const KB = 'https://api.elections.kalshi.com/trade-api/v2';
// fake release: T-1D slot = 2026-10-10T00:00Z (Fri 20:00 EDT), window from 23:45Z
const REL = { reference_month: '2026-10', release_date: '2026-10-10', release_time_et: '08:30', release_at: '2026-10-10T12:30:00.000Z' };
const SLOT = Date.parse('2026-10-10T00:00:00Z');

class FakeBucket {
  constructor() { this.m = new Map(); }
  async head(k) { const o = this.m.get(k); return o ? { customMetadata: o.meta } : null; }
  async put(k, bytes, opts) { this.m.set(k, { bytes: new Uint8Array(bytes), meta: opts.customMetadata, uploaded: new Date(clockNow + 500) }); }
  async get(k) { const o = this.m.get(k); return o ? { arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) } : null; }
  async list({ prefix }) { return { objects: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: this.m.get(k).bytes.length, customMetadata: this.m.get(k).meta, uploaded: this.m.get(k).uploaded })), truncated: false }; }
}
const body = (o) => new TextEncoder().encode(JSON.stringify(o));
function kalshiFetch(calls) {
  return async (url, init) => {
    calls.push({ url, signed: Boolean(init?.headers?.['KALSHI-ACCESS-SIGNATURE']) });
    const u = new URL(url); const p = u.pathname.replace('/trade-api/v2', '');
    const res = (o, status = 200) => new Response(o instanceof Uint8Array ? o : body(o), { status, headers: { date: new Date(clockNow).toUTCString() } });
    if (url.startsWith('https://assets.kalshi.com/')) return res(new TextEncoder().encode('%PDF terms'));
    if (/^\/series\//.test(p)) return res({ series: { ticker: p.split('/')[2], fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1, contract_terms_url: 'https://assets.kalshi.com/contract_terms/X.pdf' } });
    if (/^\/events\//.test(p)) return res({ event: { event_ticker: p.split('/')[2] } });
    if (p === '/markets') { const ev = u.searchParams.get('event_ticker'); return res({ markets: [1, 2].map((i) => ({ ticker: `${ev}-T${i}`, status: 'active', close_time: '2026-10-10T12:25:00Z', rules_primary: 'r' })), cursor: '' }); }
    if (/\/orderbook$/.test(p)) return res({ orderbook_fp: { yes_dollars: [['0.40', '10'], ['0.45', '5']], no_dollars: [['0.50', '7'], ['0.52', '3']] } });
    return res({ error: 'nf' }, 404);
  };
}
let clockNow = 0;
async function ctx({ bucket = new FakeBucket(), state = new MemoryState(), signer = async () => ({ 'KALSHI-ACCESS-SIGNATURE': 'sig' }), calls = [], mode = 'shadow' } = {}) {
  const fetchImpl = kalshiFetch(calls);
  return { mode, ns: mode === 'authoritative' ? 'auth' : 'shadow', store: new EvidenceStore(bucket, mode === 'authoritative' ? '' : 'shadow/'), state, get: makeGet({ fetchImpl, signer, kalshiBase: KB, now: () => clockNow, sleep: async () => {} }), kalshiBase: KB, now: () => clockNow, sleep: async () => { clockNow += 120; }, code: { version: 'test' }, host: 'test', calendarOverride: [REL], onlyKalshi: true, deliver: async () => ({ external: 'test' }) };
}

test('evidence is write-once: identical bytes are idempotent, different bytes are refused', async () => {
  const s = new EvidenceStore(new FakeBucket(), 'shadow/');
  await s.put('a/x.json', '{"a":1}');
  assert.equal((await s.put('a/x.json', '{"a":1}')).existed, true);
  await assert.rejects(s.put('a/x.json', '{"a":2}'), /IMMUTABLE_VIOLATION/);
});

test('in-window tick captures a complete signed snapshot that counts for the slot', async () => {
  const calls = []; const bucket = new FakeBucket(); const state = new MemoryState();
  clockNow = SLOT - 15 * 60000 + 2000; // first tick of the window (cron ~:45)
  const r = await tick(await ctx({ bucket, state, calls }));
  assert.match(r.did, /2026-10-10\/T-1D OK/);
  assert.ok(calls.filter((x) => x.url.startsWith(KB)).every((x) => x.signed), 'every Kalshi trade-API request is signed');
  const snapKey = [...bucket.m.keys()].find((k) => k.endsWith('/snapshot.json'));
  assert.match(snapKey, /^shadow\/kalshi\/2026-10-10\/T-1D\/\d{8}T\d{6}Z\/snapshot\.json$/);
  const snap = JSON.parse(new TextDecoder().decode(bucket.m.get(snapKey).bytes));
  assert.equal(snap.status, 'OK'); assert.equal(snap.completed_before_slot, true);
  assert.equal(snap.series.KXU3.contracts[0].book.best_yes_bid, 0.45);
  assert.equal(snap.series.KXU3.contracts[0].book.best_yes_ask, 0.48); // 1 - best NO bid 0.52
  assert.equal(snap.series.KXU3.contracts[0].taker_fee_1_contract.buy_yes_at_ask, 0.02);
  for (const f of snap.files) assert.equal(f.sha256, await sha256(bucket.m.get(`${snapKey.replace(/snapshot\.json$/, '')}${f.file}`).bytes));
  assert.ok(bucket.m.has(`shadow/kalshi/terms/${await sha256(new TextEncoder().encode('%PDF terms'))}.pdf`));
  // after the slot: satisfied, so no MISSED and no further snapshot
  clockNow = SLOT + 60000;
  const after = await tick(await ctx({ bucket, state, calls }));
  assert.doesNotMatch(after.did, /MISSED|T-1D OK/);
});

test('no backfill: a window with no on-time snapshot becomes MISSED, and a late capture never counts', async () => {
  const bucket = new FakeBucket(); const state = new MemoryState();
  clockNow = SLOT - 20 * 60000; await tick(await ctx({ bucket, state })); // before the window: nothing
  clockNow = SLOT + 5 * 60000; // the window closed with no tick inside it
  const r = await tick(await ctx({ bucket, state }));
  assert.match(r.did, /2026-10-10\/T-1D MISSED/);
  assert.ok(bucket.m.has('shadow/kalshi/2026-10-10/T-1D/MISSED.json'));
  assert.equal([...bucket.m.keys()].filter((k) => k.endsWith('snapshot.json')).length, 0, 'nothing captured after the cutoff');
  clockNow = SLOT + 10 * 60000;
  assert.doesNotMatch((await tick(await ctx({ bucket, state }))).did, /MISSED|OK/, 'MISSED is written once');
  // a snapshot that STARTS in the window but finishes after the cutoff is kept as evidence, never as an on-time observation
  const b2 = new FakeBucket(); const s2 = new MemoryState();
  clockNow = SLOT - 20 * 60000; await tick(await ctx({ bucket: b2, state: s2 })); // enabled before the window opens
  clockNow = SLOT - 30; // 30 ms before the slot: the requests complete after it
  const late = await tick(await ctx({ bucket: b2, state: s2 }));
  const snap = JSON.parse(new TextDecoder().decode(b2.m.get([...b2.m.keys()].find((k) => k.endsWith('snapshot.json'))).bytes));
  assert.equal(snap.completed_before_slot, false); assert.match(late.did, /T-1D OK/);
  clockNow = SLOT + 5 * 60000;
  assert.match((await tick(await ctx({ bucket: b2, state: s2 }))).did, /T-1D MISSED/);
});

test('without a Kalshi key no trade-API request is sent (fail closed); the snapshot is INCOMPLETE and alerted', async () => {
  const calls = []; const bucket = new FakeBucket();
  clockNow = SLOT - 10 * 60000;
  const c = await ctx({ bucket, calls, signer: null });
  const r = await tick(c);
  assert.equal(calls.filter((x) => x.url.startsWith(KB)).length, 0);
  assert.match(r.did, /T-1D INCOMPLETE/);
  assert.ok(r.alerts.includes('SNAPSHOT_INCOMPLETE'));
});

test('the lease stops overlapping ticks', async () => {
  const state = new MemoryState(); clockNow = SLOT - 3600000;
  assert.equal(await state.acquire('shadow', 'other', 600000, clockNow), true);
  assert.deepEqual(await tick(await ctx({ state })), { skipped: 'locked' });
});

const lines = (bucket, prefix) => [...bucket.m.keys()].filter((k) => k.startsWith(`${prefix}ledger-ticks/`)).sort().flatMap((k) => new TextDecoder().decode(bucket.m.get(k).bytes).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l)));

test('audit ledger: every tick is hash-chained and seals the sha256 of every evidence file it wrote', async () => {
  const bucket = new FakeBucket(); const state = new MemoryState();
  clockNow = SLOT - 14 * 60000; await tick(await ctx({ bucket, state }));
  clockNow += 5 * 60000; await tick(await ctx({ bucket, state }));
  const all = lines(bucket, 'shadow/');
  const v = await verifyChain(all);
  assert.equal(v.ok, true); assert.equal(v.seq, all.length);
  assert.deepEqual((await state.getState('shadow')).chain, { seq: v.seq, head: v.head }, 'Durable Object head = R2 chain head');
  const seal = all.find((x) => x.type === 'TICK_SEAL' && x.files.some((f) => f.path.endsWith('snapshot.json')));
  for (const f of seal.files) assert.equal(f.sha256, bucket.m.get(`shadow/${f.path}`).meta.sha256);
  // tampering with, dropping or reordering any entry breaks the chain
  const edited = all.map((x, i) => (i === 2 ? { ...x, message: 'edited' } : x));
  assert.equal((await verifyChain(edited)).ok, false);
  assert.equal((await verifyChain(all.filter((_, i) => i !== 1))).ok, false);
  assert.equal((await verifyChain([all[1], all[0], ...all.slice(2)])).ok, false);
});

test('verify: hashes, books, chain and R2 upload-time proof pass; a changed evidence byte is detected', async () => {
  const bucket = new FakeBucket(); const state = new MemoryState();
  clockNow = SLOT - 14 * 60000; await tick(await ctx({ bucket, state }));
  const store = new EvidenceStore(bucket, 'shadow/');
  const st = await state.getState('shadow');
  const ok = await verify({ store, state, ns: 'shadow', chain: st.chain });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.ledger_chain.status, 'OK'); assert.equal(ok.ledger_chain.matches_durable_object, true);
  assert.equal(ok.order_books_rederived, 4);
  const t = ok.timestamp_proof.find((x) => x.kind === 'KALSHI_SNAPSHOT');
  assert.equal(t.uploaded_before_slot, true);
  const k = [...bucket.m.keys()].find((x) => x.includes('orderbook_KXU3'));
  bucket.m.get(k).bytes = new TextEncoder().encode('{"orderbook_fp":{"yes_dollars":[["0.99","1"]],"no_dollars":[]}}');
  const bad = await verify({ store, state, ns: 'shadow', chain: st.chain });
  assert.equal(bad.ok, false); assert.ok(bad.problems.some((x) => x.startsWith('r2-sha')) && bad.problems.some((x) => x.startsWith('hash ')));
});

test('a failed ledger write never advances the chain and carries the entries to the next tick', async () => {
  const bucket = new FakeBucket(); const state = new MemoryState();
  clockNow = SLOT - 3 * 3600000;
  const realPut = bucket.put.bind(bucket); let failLedger = true;
  bucket.put = async (k, b, o) => { if (failLedger && k.includes('ledger-ticks/')) throw new Error('r2 503'); return realPut(k, b, o); };
  const r1 = await tick(await ctx({ bucket, state }));
  assert.match(r1.error, /ledger write failed/);
  assert.equal((await state.getState('shadow')).chain, undefined);
  const carried = (await state.getState('shadow')).unsealed.length; assert.ok(carried > 0);
  failLedger = false; clockNow += 5 * 60000;
  await tick(await ctx({ bucket, state }));
  const all = lines(bucket, 'shadow/');
  assert.equal((await verifyChain(all)).ok, true);
  assert.ok(all.some((x) => x.type === 'INIT'), 'the entries from the failed tick were sealed, not lost');
});

test('one tick per 5-minute bucket: a second trigger (alarm + cron + manual) in the same bucket never double-captures', async () => {
  const bucket = new FakeBucket(); const state = new MemoryState();
  clockNow = SLOT - 14 * 60000; // inside the T-1D window
  const first = await tick({ ...(await ctx({ bucket, state })), trigger: 'alarm' });
  assert.match(first.did, /T-1D OK/); assert.equal(first.trigger, 'alarm');
  clockNow += 20000; // a cron firing 20 s later, same bucket
  const second = await tick({ ...(await ctx({ bucket, state })), trigger: 'cron' });
  assert.equal(second.skipped, 'bucket_already_ticked');
  assert.equal([...bucket.m.keys()].filter((k) => k.endsWith('snapshot.json')).length, 1);
});

test('RFC 3161 anchor: the request is a valid TimeStampReq; tick stores the token and verify checks it echoes the chain head', async () => {
  const { timeStampRequest } = await import('../workers/pbe-employment-collector/src/tsa.js');
  const req = timeStampRequest('ab'.repeat(32));
  assert.equal(req.length, 59); assert.deepEqual([...req.subarray(0, 5)], [0x30, 0x39, 0x02, 0x01, 0x01]);
  const fakeToken = (hashHex, gen) => Uint8Array.from([0x30, 0x82, 0, 0, 0x30, 0x03, 0x02, 0x01, 0x00, ...hashHex.match(/../g).map((x) => parseInt(x, 16)), 0x18, gen.length, ...new TextEncoder().encode(gen)]);
  const bucket = new FakeBucket(); const state = new MemoryState();
  clockNow = SLOT - 14 * 60000;
  const c = await ctx({ bucket, state });
  c.anchor = async (h) => ({ ok: true, tsa: 'test-tsa', bytes: fakeToken(h, '20261010000000Z'), gen_time_utc: '2026-10-10T00:00:00Z' });
  const r = await tick(c);
  assert.equal(r.ledger.anchor.tsa, 'test-tsa');
  const st = await state.getState('shadow');
  const store = new EvidenceStore(bucket, 'shadow/');
  const v = await verify({ store, state, ns: 'shadow', chain: st.chain });
  assert.equal(v.ok, true, JSON.stringify(v.problems)); assert.equal(v.ledger_chain.anchors_ok, 1);
  // a token over a different hash is rejected
  const k = [...bucket.m.keys()].find((x) => x.includes('ledger-anchors/'));
  bucket.m.get(k).bytes = fakeToken('cd'.repeat(32), '20261010000000Z');
  assert.ok((await verify({ store, state, ns: 'shadow', chain: st.chain })).problems.some((p) => p.startsWith('anchor invalid')));
});
