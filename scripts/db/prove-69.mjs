// Production-equivalent proof for issue #69 (ledger writer/2). NEVER commit the input: production ledger rows are member
// data and this repo is public.
//   node scripts/db/prove-69.mjs <rows.json> [path-to-a-package.json that resolves @electric-sql/pglite]
// <rows.json>: the real pred_s10_events rows for S10-FWD-1 (read-only SELECT incl. event_key, d::text, payload, hashes).
// Loads them into PGlite (sql chain 001..017, real jsonb), verifies them, runs writer/2 OPEN + EOD for 2026-10-12 and
// 2026-10-13 against a deterministic synthetic market source through a PGlite-backed store, then re-reads every row from
// jsonb and verifies the whole chain (legacy + new), the upgrade event and every FILL -> ORDER reference.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import '../../test/helpers/worker-assets.js';
import { runOpen, runEod, sha256Hex, canonical, ACCOUNT } from '../../src/signal10/forward.js';

const [rowsPath, pkg = 'D:/Workers/wt/tennis-parity/package.json'] = process.argv.slice(2);
if (!rowsPath) { console.error('usage: prove-69.mjs <rows.json> [pglite package.json]'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(createRequire(pkg).resolve('@electric-sql/pglite')).href);
const find = (v) => (Array.isArray(v) && v.length && v[0]?.seq !== undefined ? v : Array.isArray(v) ? v.map(find).find(Boolean)
  : v && typeof v === 'object' ? Object.values(v).map((x) => (typeof x === 'string' && x.startsWith('[') ? find(JSON.parse(x)) : find(x))).find(Boolean) : null);
const real = find(JSON.parse(readFileSync(rowsPath, 'utf8').replace(/^\uFEFF/, '')));
if (!real?.length) { console.error('no rows found in input'); process.exit(2); }

const db = new PGlite();
const dir = new URL('../../sql/', import.meta.url);
await db.exec(`create role anon; create role authenticated; create role service_role; create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text, name text);`);
for (const f of readdirSync(dir).filter((x) => /^0(0\d|1[0-7])_[a-z0-9_]+\.sql$/.test(x) && !/_(PROOF|ROLLBACK)\.sql$/.test(x)).sort()) {
  const s = readFileSync(new URL(f, dir), 'utf8'); await db.exec(f.startsWith('001') ? s.replace('create extension if not exists pgcrypto;', '') : s);
}

// PGlite-backed store with the subset of the PostgREST semantics the lane uses
const norm = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? (k === 'd' ? v.toISOString().slice(0, 10) : v.toISOString()) : typeof v === 'bigint' ? Number(v) : v]));
const store = {
  async select(table, q = {}, { limit = null, order = null } = {}) {
    const where = []; const args = [];
    for (const [k, v] of Object.entries(q)) {
      if (k === 'select') continue;
      const [op, ...rest] = String(v).split('.'); const val = rest.join('.');
      const sqlOp = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]; if (!sqlOp) throw new Error(`op ${op}`);
      args.push(val); where.push(`${k}::text ${sqlOp} $${args.length}`);
    }
    const ord = order ? ` order by ${order.split('.')[0]} ${order.endsWith('.desc') ? 'desc' : 'asc'}` : '';
    const r = await db.query(`select * from ${table}${where.length ? ` where ${where.join(' and ')}` : ''}${ord}${limit ? ` limit ${limit}` : ''}`, args);
    return r.rows.map(norm);
  },
  async write(table, rows, { conflictColumn, returnRepresentation } = {}) {
    const out = [];
    for (const row of [].concat(rows)) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]));
      const r = await db.query(`insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})${conflictColumn ? ` on conflict (${conflictColumn}) do nothing` : ''} returning *`, vals);
      out.push(...r.rows.map(norm));
    }
    return returnRepresentation ? out : null;
  },
  insertMany(table, rows, conflictColumn) { return this.write(table, rows, { conflictColumn }); },
};

// 1) load the real rows exactly as stored
for (const r of real) await store.write('pred_s10_events', [{ event_key: r.event_key, account: r.account, origin: r.origin, seq: r.seq, type: r.type, d: r.d, payload: r.payload, model_version: r.model_version, policy_version: r.policy_version, prev_hash: r.prev_hash, hash: r.hash }]);
async function verifyAll(label) {
  const rows = await store.select('pred_s10_events', { account: `eq.${ACCOUNT}` }, { order: 'seq.asc' });
  let prev = '0'.repeat(64); const bad = [];
  for (const [i, r] of rows.entries()) {
    const { account, origin, seq, type, d, payload, model_version, policy_version } = r;
    if (r.seq !== i + 1 || r.prev_hash !== prev || (await sha256Hex(prev + canonical({ account, origin, seq, type, d, payload, model_version, policy_version }))) !== r.hash) bad.push(`${r.seq}:${r.type}`);
    prev = r.hash;
  }
  console.log(`${label}: ${rows.length} rows from jsonb, ${bad.length} failing${bad.length ? ` (${bad.slice(0, 5).join(', ')})` : ''}, head ${prev.slice(0, 16)}…`);
  return { rows, bad };
}
const legacy = await verifyAll('legacy production rows');
const lastState = legacy.rows.filter((r) => r.type === 'STATE').at(-1);
console.log(`legacy STATE seq ${lastState.seq} d ${lastState.d}: flat=${lastState.payload.state === undefined} seq=${'seq' in lastState.payload} origin=${'origin' in lastState.payload} pending=${lastState.payload.pending.length} (${lastState.payload.pending.map((o) => `${o.side} ${o.symbol} seq ${o.seq}`).join('; ')})`);

// 2) deterministic synthetic market (calendar through 2026-10-13; any symbol)
function weekdays(from, n) { const out = []; let t = Date.parse(from + 'T00:00:00Z'); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; }
const CAL = weekdays('2024-10-01', 545);
const hh = (s) => { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return (x >>> 0) / 2 ** 32; };
const px = (sym, i) => { const k = hh(sym); return (30 + 150 * k) * Math.exp(i * (0.0008 + 0.0022 * k)) * (1 + 0.045 * Math.sin(i / (2.2 + 2 * k) + 7 * k)); };
const source = (today, at) => async (url) => {
  const u = String(url);
  if (u.includes('githubusercontent')) return new Response('nope', { status: 503 });
  const sym = decodeURIComponent(u.match(/chart\/([^?]+)/)[1]).replace(/-/g, '.');
  const cal = CAL.filter((d) => d <= today);
  const close = cal.map((d, i) => +px(sym, i).toFixed(4));
  const open = close.map((c, i) => +(i ? close[i - 1] * (1 + 0.002 * Math.sin(i * 1.7)) : c).toFixed(4));
  return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol: sym, gmtoffset: -14400, regularMarketPrice: close.at(-1), regularMarketTime: Math.floor(Date.parse(at) / 1000) },
    timestamp: cal.map((d) => Date.parse(d + 'T13:30:00Z') / 1000), events: {}, indicators: { quote: [{ open, high: close, low: close, close, volume: close.map(() => 8e6) }], adjclose: [{ adjclose: close }] } }] } }), { status: 200 });
};
const out = [];
for (const d of ['2026-10-12', '2026-10-13']) {
  out.push([d, 'OPEN', await runOpen({ store, now: `${d}T13:50:00Z`, fetchImpl: source(d, `${d}T13:50:00Z`) })]);
  out.push([d, 'EOD', await runEod({ store, now: `${d}T20:25:00Z`, fetchImpl: source(d, `${d}T20:00:00Z`), startDate: '2026-10-09' })]);
}
for (const [d, k, r] of out) console.log(`${d} ${k}: ${JSON.stringify(r).slice(0, 160)}`);

// 3) re-read everything from jsonb and verify
const after = await verifyAll('after writer/2 (legacy + new)');
const up = after.rows.filter((r) => r.type === 'LEDGER_WRITER_UPGRADE');
console.log(`LEDGER_WRITER_UPGRADE events: ${up.length}; pending links: ${JSON.stringify(up[0]?.payload.pendingLinks)}`);
const bySeq = new Map(after.rows.map((r) => [r.seq, r]));
const fills = after.rows.filter((r) => r.type === 'FILL');
const badLinks = fills.filter((f) => { const o = bySeq.get(f.payload.orderSeq); return !(o && o.type === 'ORDER' && o.payload.symbol === f.payload.symbol && o.payload.side === f.payload.side); });
console.log(`FILLs: ${fills.length}, FILL->ORDER links failing: ${badLinks.length}`);
const legacyUnchanged = legacy.rows.every((r, i) => after.rows[i].hash === r.hash && JSON.stringify(after.rows[i].payload) === JSON.stringify(r.payload));
console.log(`legacy rows byte-for-byte unchanged: ${legacyUnchanged}`);
const ok = legacy.bad.length === 0 && after.bad.length === 0 && up.length === 1 && badLinks.length === 0 && legacyUnchanged && after.rows.length > legacy.rows.length;
if (!ok) { console.error('PROOF FAILED'); process.exit(1); }
console.log('PROOF PASSED');
