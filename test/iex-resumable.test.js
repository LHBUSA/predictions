// Resumable IEX HIST collector (issue #56, sql/017): the pure-JS DEFLATE decoder (byte-identical to zlib across
// stored / fixed / dynamic blocks, with checkpoint + resume at block boundaries), parser state round-trip, and the step
// lane end to end on a SYNTHETIC capture: many tiny steps produce exactly the single-pass rows; lease contention; failures
// escalate to FAILED after repeated attempts; nothing is written before the final block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createInflater, parseGzipHeader } from '../src/market-tape/inflate.js';
import { createTopsParser } from '../src/market-tape/iex-hist.js';
import { iexHistStep, collectSession, iexDue } from '../workers/pbe-predictions/src/iex-hist-lane.js';

function inflateAll(gz, { stepOut = Infinity, chunk = 4096 } = {}) {
  const parts = []; let byte = parseGzipHeader(gz), bit = 0, window = null, steps = 0;
  for (;;) {
    let out = 0;
    const d = createInflater({ window, bitOffset: bit, onOutput: (c) => { parts.push(Buffer.from(c)); out += c.length; if (out >= stepOut) d.requestStop(); } });
    let fed = byte, paused = false;
    while (fed < gz.length) { d.push(gz.subarray(fed, Math.min(gz.length, fed + chunk))); fed = Math.min(gz.length, fed + chunk); if (d.done) break; if (out >= stepOut && d.atBoundary) { paused = true; break; } }
    steps++;
    if (d.done) return { data: Buffer.concat(parts), steps };
    if (!paused) throw new Error('ran out of input');
    const abs = byte * 8 + d.consumedBits(); byte = Math.floor(abs / 8); bit = abs % 8; window = d.window();
  }
}
const corpora = () => {
  const rnd = Buffer.alloc(300000); let x = 7; for (let i = 0; i < rnd.length; i++) { x = (x * 1103515245 + 12345) >>> 0; rnd[i] = x >>> 24; }
  const text = Buffer.from('IEX TOPS synthetic trade report SPCX 162.56 '.repeat(20000));
  const mixed = Buffer.concat(Array.from({ length: 12 }, (_, k) => Buffer.concat([text.subarray(k, 60000 + k), rnd.subarray(k * 9000, k * 9000 + 20000)])));
  return { rnd, text, mixed, tiny: Buffer.from('a') , empty: Buffer.alloc(0) };
};

test('inflate: byte-identical to zlib for stored (level 0), fixed (tiny) and dynamic blocks', () => {
  for (const [name, data] of Object.entries(corpora())) {
    for (const [level, memLevel] of [[0, 8], [1, 8], [6, 8], [9, 9], [6, 1]]) {
      const gz = zlib.gzipSync(data, { level, memLevel });
      const { data: out } = inflateAll(gz);
      assert.ok(out.equals(data), `${name} level ${level} memLevel ${memLevel}`);
    }
  }
});

test('inflate: checkpoint + resume at block boundaries in many steps equals one pass (incl. bit-unaligned resumes)', () => {
  const { mixed, text } = corpora();
  for (const data of [mixed, text]) {
    const gz = zlib.gzipSync(data, { level: 6, memLevel: 1 }); // memLevel 1 = tiny literal buffer -> many deflate blocks
    for (const stepOut of [1, 5000, 40000]) {
      const r = inflateAll(gz, { stepOut, chunk: 777 });
      assert.ok(r.data.equals(data), `stepOut ${stepOut}`);
      if (stepOut === 1) assert.ok(r.steps > 1, `actually resumed (${r.steps} steps)`);
    }
  }
});

test('inflate: corrupt input fails loudly', () => {
  assert.throws(() => parseGzipHeader(new Uint8Array([1, 2, 3])), /not a gzip/);
  const gz = zlib.gzipSync(Buffer.from('hello world '.repeat(1000)));
  const bad = Buffer.from(gz); bad[12] ^= 0xff; bad[13] ^= 0xff;
  assert.throws(() => inflateAll(bad));
});

// ---------- synthetic capture (same builder as test/iex-hist.test.js, kept local) ----------
const ns = (iso) => BigInt(Date.parse(iso)) * 1000000n;
let ID = 1n;
function trade(sym, iso, price, size, flags = 0) {
  const m = new Uint8Array(38); const dv = new DataView(m.buffer);
  m[0] = 0x54; m[1] = flags; dv.setBigUint64(2, ns(iso), true);
  const s = sym.padEnd(8, ' '); for (let i = 0; i < 8; i++) m[10 + i] = s.charCodeAt(i);
  dv.setUint32(18, size, true); dv.setBigInt64(22, BigInt(Math.round(price * 10000)), true); dv.setBigUint64(30, ID++, true);
  return m;
}
const quote = () => { const m = new Uint8Array(42); m[0] = 0x51; return m; };
function packet(messages) {
  const body = messages.reduce((n, m) => n + 2 + m.length, 0);
  const p = new Uint8Array(82 + body); const dv = new DataView(p.buffer);
  p[14] = 0x45; dv.setUint16(54, body, true); dv.setUint16(56, messages.length, true);
  let o = 82; for (const m of messages) { dv.setUint16(o, m.length, true); p.set(m, o + 2); o += 2 + m.length; }
  return p;
}
function block(type, payload) {
  const len = 12 + payload.length + ((4 - (payload.length % 4)) % 4);
  const b = new Uint8Array(len); const dv = new DataView(b.buffer);
  dv.setUint32(0, type, true); dv.setUint32(4, len, true); b.set(payload, 8); dv.setUint32(len - 4, len, true);
  return b;
}
function capture() {
  const shb = new Uint8Array(16); new DataView(shb.buffer).setUint32(0, 0x1a2b3c4d, true);
  const parts = [block(0x0a0d0d0a, shb), block(1, new Uint8Array(8))];
  const D = '2026-10-09';
  for (let i = 0; i < 4000; i++) { // many packets so the stream spans many deflate blocks
    const t = new Date(Date.parse(`${D}T13:30:00Z`) + i * 1600).toISOString();
    const pk = packet([quote(), trade(i % 2 ? 'SPCX' : 'NVDA', t, 150 + (i % 97) / 10, 100 + (i % 7)), quote()]);
    const h = new Uint8Array(20 + pk.length); const dv = new DataView(h.buffer); dv.setUint32(12, pk.length, true); dv.setUint32(16, pk.length, true); h.set(pk, 20);
    parts.push(block(6, h));
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

test('parser: exportState/restore mid-stream gives the same result as one parser', () => {
  const cap = capture();
  const opts = { sessionCloseNs: Date.parse('2026-10-09T20:00:00Z') * 1e6, sessionOpenNs: Date.parse('2026-10-09T13:30:00Z') * 1e6 };
  const one = createTopsParser(['SPCX', 'NVDA'], opts); one.feed(cap);
  let p = createTopsParser(['SPCX', 'NVDA'], opts);
  for (let i = 0; i < cap.length; i += 9973) { p.feed(cap.subarray(i, i + 9973)); p = createTopsParser(['SPCX', 'NVDA'], { ...opts, state: JSON.parse(JSON.stringify(p.exportState())) }); }
  assert.deepEqual(p.finish(), one.finish());
});

// ---------- step lane against an in-memory PostgREST ----------
function fakeStore(seedJobs = []) {
  const tables = { pred_source_observations: [], pred_market_tape_jobs: [...seedJobs], pred_s10_snapshots: [], pred_s10_events: [] };
  const store = {
    url: 'https://db.test', serviceKey: 'k', tables,
    async select(t, q) {
      let rows = tables[t] || [];
      if (q?.observation_key?.startsWith('like.')) { const pre = q.observation_key.slice(5, -1); rows = rows.filter((r) => r.observation_key.startsWith(pre)); }
      if (q?.session_date?.startsWith('eq.')) rows = rows.filter((r) => r.session_date === q.session_date.slice(3));
      return rows.map((r) => ({ ...r }));
    },
    async write(t, rows) { for (const r of rows) if (!tables[t].some((x) => (x.observation_key ?? x.session_date) === (r.observation_key ?? r.session_date))) tables[t].push(t === 'pred_market_tape_jobs' ? { steps: 0, attempts: 0, byte_offset: 0, bit_offset: 0, decompressed_bytes: 0, lease_until: null, window_b64: null, parser_state: null, ...r } : { ...r }); return null; },
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/rpc/pred_market_tape_claim')) {
        const { p_session, p_holder, p_ttl_seconds } = JSON.parse(init.body);
        const j = tables.pred_market_tape_jobs.find((x) => x.session_date === p_session && x.status === 'RUNNING' && (!x.lease_until || Date.parse(x.lease_until) < Date.now()));
        if (!j) return new Response('[]', { status: 200 });
        Object.assign(j, { lease_holder: p_holder, lease_until: new Date(Date.now() + p_ttl_seconds * 1000).toISOString() });
        return new Response(JSON.stringify([{ ...j }]), { status: 200 });
      }
      if (init?.method === 'PATCH') {
        const s = u.searchParams.get('session_date').slice(3);
        Object.assign(tables.pred_market_tape_jobs.find((x) => x.session_date === s), JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    },
  };
  return store;
}
function vendor(gz, { published = true, failFile = false } = {}) {
  let fileReads = 0;
  const f = async (url, init) => {
    if (url.includes('/api/1.0/hist')) return new Response(JSON.stringify(published ? [{ feed: 'TOPS', protocol: 'IEXTP1', version: '1.6', size: gz.length, link: 'https://storage.test/x?generation=1' }] : []), { status: 200 });
    fileReads++;
    if (failFile) return new Response('nope', { status: 500 });
    const m = /bytes=(\d+)-/.exec(init?.headers?.range || '');
    const from = m ? Number(m[1]) : 0;
    // deliver in small chunks to exercise reassembly
    const body = new ReadableStream({ start(c) { for (let i = from; i < gz.length; i += 1500) c.enqueue(new Uint8Array(gz.subarray(i, Math.min(gz.length, i + 1500)))); c.close(); } });
    return new Response(body, { status: from ? 206 : 200 });
  };
  f.reads = () => fileReads;
  return f;
}
const NOW = '2026-10-10T05:00:00Z';

test('step lane: tiny steps checkpoint and resume to exactly the single-pass observations; nothing written before the end', async () => {
  const gz = zlib.gzipSync(capture(), { level: 6, memLevel: 1 });
  // reference: single pass
  const ref = { rows: [], async write(t, rows) { this.rows.push(...rows); }, async select() { return []; } };
  await collectSession({ store: ref, session: '2026-10-09', symbols: ['SPCX', 'NVDA', 'SPY', 'QQQ', 'NVDA'], fetchImpl: vendor(gz), now: () => 'T' });
  const st = fakeStore();
  const v = vendor(gz);
  let r, n = 0;
  do {
    r = await iexHistStep({ store: st, nowIso: NOW, fetchImpl: v, stepOut: 20000, now: () => 'T' });
    n++;
    if (r.status === 'STEP') assert.equal(st.tables.pred_source_observations.length, 0, 'no rows before the final block');
  } while (r.status === 'STEP' && n < 500);
  assert.equal(r.status, 'DONE'); assert.ok(r.steps > 5, `resumed ${r.steps} steps`);
  const job = st.tables.pred_market_tape_jobs[0];
  assert.equal(job.status, 'DONE'); assert.equal(job.window_b64, null); assert.equal(job.parser_state, null);
  const strip = (rows) => rows.map(({ provenance, ...x }) => x).sort((a, b) => a.observation_key.localeCompare(b.observation_key));
  const got = strip(st.tables.pred_source_observations).filter((x) => ['SPCX', 'NVDA'].includes(x.source_id.split(':')[2]));
  assert.deepEqual(got, strip(ref.rows), 'identical observations');
  assert.ok(got.length === 2);
  // next run: up to date for 10-09 (newer session first), older sessions not published in this fake -> UP_TO_DATE
  const after = await iexHistStep({ store: st, nowIso: NOW, fetchImpl: vendor(gz, { published: false }) });
  assert.equal(after.status, 'UP_TO_DATE');
});

test('step lane: a held lease is respected; repeated failures mark the job FAILED; unpublished files create nothing', async () => {
  const gz = zlib.gzipSync(capture(), { level: 6, memLevel: 1 });
  const st = fakeStore();
  const v = vendor(gz);
  await iexHistStep({ store: st, nowIso: NOW, fetchImpl: v, stepOut: 20000 });
  st.tables.pred_market_tape_jobs[0].lease_until = new Date(Date.now() + 60000).toISOString();
  const held = await iexHistStep({ store: st, nowIso: NOW, fetchImpl: v, stepOut: 20000 });
  assert.equal(held.status, 'LEASE_HELD');
  st.tables.pred_market_tape_jobs[0].lease_until = null;
  const bad = vendor(gz, { failFile: true });
  for (let i = 0; i < 6; i++) await assert.rejects(iexHistStep({ store: st, nowIso: NOW, fetchImpl: bad, stepOut: 20000 }));
  assert.equal(st.tables.pred_market_tape_jobs[0].status, 'FAILED');
  assert.match(st.tables.pred_market_tape_jobs[0].last_error, /HTTP 500/);
  const st2 = fakeStore();
  const np = await iexHistStep({ store: st2, nowIso: NOW, fetchImpl: vendor(gz, { published: false }) });
  assert.equal(np.status, 'UP_TO_DATE'); assert.equal(st2.tables.pred_market_tape_jobs.length, 0);
});

test('schedule: every minute 03:30-13:29 UTC only', () => {
  assert.equal(iexDue('2026-10-13T03:29:00Z'), false);
  assert.equal(iexDue('2026-10-13T03:30:00Z'), true);
  assert.equal(iexDue('2026-10-13T09:41:00Z'), true);
  assert.equal(iexDue('2026-10-13T13:29:00Z'), true);
  assert.equal(iexDue('2026-10-13T13:30:00Z'), false);
});
