// pbe-employment-collector (Cloudflare Worker port of the Employment Tier A collector): integrity rules under fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tick } from '../workers/pbe-employment-collector/src/collector.js';
import { GitHubMirror } from '../workers/pbe-employment-collector/src/github.js';
import { makeGet } from '../workers/pbe-employment-collector/src/http.js';
import { MemoryState } from '../workers/pbe-employment-collector/src/state.js';
import { EvidenceStore } from '../workers/pbe-employment-collector/src/store.js';
import { gitBlobSha, sha256 } from '../workers/pbe-employment-collector/src/util.js';

const KB = 'https://api.elections.kalshi.com/trade-api/v2';
// fake release: T-1D slot = 2026-10-10T00:00Z (Fri 20:00 EDT), window from 23:45Z
const REL = { reference_month: '2026-10', release_date: '2026-10-10', release_time_et: '08:30', release_at: '2026-10-10T12:30:00.000Z' };
const SLOT = Date.parse('2026-10-10T00:00:00Z');

class FakeBucket {
  constructor() { this.m = new Map(); }
  async head(k) { const o = this.m.get(k); return o ? { customMetadata: o.meta } : null; }
  async put(k, bytes, opts) { this.m.set(k, { bytes: new Uint8Array(bytes), meta: opts.customMetadata }); }
  async get(k) { const o = this.m.get(k); return o ? { arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) } : null; }
  async list({ prefix }) { return { objects: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: this.m.get(k).bytes.length, customMetadata: this.m.get(k).meta })), truncated: false }; }
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
async function ctx({ bucket = new FakeBucket(), state = new MemoryState(), signer = async () => ({ 'KALSHI-ACCESS-SIGNATURE': 'sig' }), calls = [], mirror = null, mode = 'shadow' } = {}) {
  const fetchImpl = kalshiFetch(calls);
  return { mode, ns: mode === 'authoritative' ? 'auth' : 'shadow', store: new EvidenceStore(bucket, mode === 'authoritative' ? '' : 'shadow/'), state, get: makeGet({ fetchImpl, signer, kalshiBase: KB, now: () => clockNow, sleep: async () => {} }), kalshiBase: KB, now: () => clockNow, sleep: async () => { clockNow += 120; }, code: { version: 'test' }, host: 'test', calendarOverride: [REL], onlyKalshi: true, mirror, deliver: async () => ({ external: 'test' }) };
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

test('authoritative mirror: failures queue in order and are retried; shadow never touches GitHub', async () => {
  const state = new MemoryState(); const bucket = new FakeBucket(); let fail = true; const commits = [];
  const mirror = { repo: 'x/y', remoteHistory: async () => ({ status: 'OK' }), commit: async (files, ledger, msg) => { if (fail) throw new Error('github 503'); commits.push({ files: files.map((f) => f.path), ledger, msg }); return `c${commits.length}`; } };
  clockNow = SLOT - 14 * 60000;
  const r1 = await tick(await ctx({ bucket, state, mirror, mode: 'authoritative' }));
  assert.equal(r1.mirror.ok, false); assert.equal((await state.pendingMirror('auth')).length, 1);
  fail = false; clockNow += 5 * 60000;
  const r2 = await tick(await ctx({ bucket, state, mirror, mode: 'authoritative' }));
  assert.equal(r2.mirror.ok, true); assert.equal((await state.pendingMirror('auth')).length, 0);
  assert.ok(commits[0].files.some((p) => p.endsWith('snapshot.json')), 'the queued snapshot was mirrored first');
  assert.equal((await state.getState('auth')).last_pushed_head, 'c2');
  assert.ok(![...bucket.m.keys()].some((k) => k.startsWith('shadow/')), 'authoritative writes the R2 root only');
});

test('GitHub mirror checks every blob id against the bytes and never forces the ref', async () => {
  const seen = [];
  const api = async (url, init) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/o/r', ''); seen.push(`${init.method} ${p}`);
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (p === '/git/ref/heads/main') return J({ object: { sha: 'head1' } });
    if (p === '/git/commits/head1') return J({ tree: { sha: 'tree1' } });
    if (p === '/git/blobs') { const b = JSON.parse(init.body); return J({ sha: await gitBlobSha(Uint8Array.from(atob(b.content), (ch) => ch.charCodeAt(0))) }); }
    if (p.startsWith('/contents/')) return new Response('{"old":1}\n', { status: 200 });
    if (p === '/git/trees') return J({ sha: 'tree2' });
    if (p === '/git/commits') return J({ sha: 'commit2' });
    if (p === '/git/refs/heads/main') { assert.equal(JSON.parse(init.body).force, false); return J({}); }
    return J({}, 404);
  };
  const m = new GitHubMirror({ token: 't', repo: 'o/r', fetchImpl: api });
  assert.equal(await m.commit([{ path: 'kalshi/a.json', bytes: new TextEncoder().encode('{"x":1}') }], { path: 'ledger/2026-10.jsonl', text: '{"new":1}\n' }, 'capture: test'), 'commit2');
  assert.ok(seen.includes('PATCH /git/refs/heads/main'));
});
