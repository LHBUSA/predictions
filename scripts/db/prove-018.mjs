// PGlite proof for sql/018_signal10_arena.sql: applies the ledger chain 001..017, seeds one CONTROL (pred_s10_*) event,
// applies 018, runs 018_PROOF.sql (aborts with PROOF_RESULT 15 of 15), checks nothing persisted and the control row is
// byte-identical, then ROLLBACK (arena tables gone, control untouched) and re-apply.
//   node scripts/db/prove-018.mjs [path-to-a-package.json that resolves @electric-sql/pglite]
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const pkg = process.argv[2] || 'D:/Workers/wt/tennis-parity/package.json';
const { PGlite } = await import(pathToFileURL(createRequire(pkg).resolve('@electric-sql/pglite')).href);
const dir = new URL('../../sql/', import.meta.url);
const sql = (f) => readFileSync(new URL(f, dir), 'utf8');
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text, name text);`);
const chain = readdirSync(dir).filter((f) => /^0(0\d|1[0-7])_[a-z0-9_]+\.sql$/.test(f) && !/_(PROOF|ROLLBACK)\.sql$/.test(f)).sort();
for (const f of chain) await db.exec(f.startsWith('001') ? sql(f).replace('create extension if not exists pgcrypto;', '') : sql(f));
console.log('applied', chain.length, 'migrations through', chain.at(-1));
const h = 'c'.repeat(64);
await db.exec(`insert into pred_s10_events(event_key, account, origin, seq, type, d, payload, model_version, policy_version, prev_hash, hash)
  values ('S10-FWD-1:1', 'S10-FWD-1', 'FORWARD_PAPER', 1, 'FUNDING', '2026-10-09', '{"cashCents":1000000}', 'signal10-rank/1.0.0', 'signal10-manager/1.0.0', '${'0'.repeat(64)}', '${h}');`);
const control = async () => JSON.stringify((await db.query(`select event_key, account, origin, seq, type, d, payload, prev_hash, hash from pred_s10_events order by seq`)).rows);
const controlSchema = async () => JSON.stringify((await db.query(`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_name like 'pred\\_s10\\_%' order by 1, 2`)).rows);
const before = await control(); const schemaBefore = await controlSchema();
await db.exec(sql('018_signal10_arena.sql'));
let result = null;
try { await db.exec(sql('018_signal10_arena_PROOF.sql')); } catch (e) { result = String(e.message).match(/PROOF_RESULT (\d+) of (\d+)/); }
console.log('018 PROOF_RESULT', result ? `${result[1]} of ${result[2]}` : 'missing');
const count = async (t) => (await db.query(`select count(*)::int n from ${t}`)).rows[0].n;
let persisted = 0; for (const t of ['pred_s10a_runs', 'pred_s10a_events', 'pred_s10a_snapshots', 'pred_s10a_marks']) persisted += await count(t);
const rls = (await db.query(`select string_agg(relname || '=' || relrowsecurity, ',' order by relname) s from pg_class where relname like 'pred_s10a_%' and relkind = 'r'`)).rows[0].s;
const after = await control(); const schemaAfter = await controlSchema();
console.log('persisted after proof:', persisted, '| RLS', rls, '| control row unchanged:', before === after, '| control schema unchanged:', schemaBefore === schemaAfter);
await db.exec(sql('018_signal10_arena_ROLLBACK.sql'));
const left = (await db.query(`select count(*)::int n from information_schema.tables where table_name like 'pred_s10a_%'`)).rows[0].n;
console.log('after rollback: arena tables', left, '| control unchanged:', (await control()) === before);
await db.exec(sql('018_signal10_arena.sql'));
console.log('re-applied 018');
// End to end: the rows the real arena lane writes (fake store + deterministic fake source, two sessions) must satisfy
// every 018 constraint. Inserted in a transaction that is rolled back.
const { FakeStore, fakeSource } = await import('../../test/helpers/s10-fakes.js');
const { LATEST_MEMBERS } = await import('../../src/signal10/members-latest.js');
const { runArenaEod, runArenaOpen, T } = await import('../../src/signal10/arena/forward.js');
const S11 = ['COMMUNICATION', 'CONSUMER_DISCRETIONARY', 'CONSUMER_STAPLES', 'ENERGY', 'FINANCIALS', 'HEALTH_CARE', 'INDUSTRIALS', 'MATERIALS', 'REAL_ESTATE', 'UTILITIES'];
const cls = { effective_from: '2025-01-01', content_sha256: 'f'.repeat(64), rows: Object.fromEntries(LATEST_MEMBERS.tickers.map((t, i) => [t, { sector: i % 4 === 0 ? 'TECHNOLOGY' : S11[i % 10], tech: i % 4 === 0 }])) };
const store = new FakeStore(); const BULL = { QQQ: { from: 400, factor: 1.3 } };
await runArenaEod({ store, now: '2026-09-03T20:35:00Z', fetchImpl: fakeSource({ today: '2026-09-03', at: '2026-09-03T20:00:00Z', shock: BULL }), t0: '2026-09-03', classification: cls });
await runArenaOpen({ store, now: '2026-09-04T13:50:00Z', fetchImpl: fakeSource({ today: '2026-09-04', at: '2026-09-04T13:50:00Z', shock: BULL }) });
await runArenaEod({ store, now: '2026-09-04T20:35:00Z', fetchImpl: fakeSource({ today: '2026-09-04', at: '2026-09-04T20:00:00Z', shock: BULL }), t0: '2026-09-03', classification: cls });
let realRows = 0;
await db.exec('begin');
for (const t of Object.values(T)) for (const row of store.rows(t)) {
  const cols = Object.keys(row);
  await db.query(`insert into ${t} (${cols.join(',')}) values (${cols.map((_, k) => `$${k + 1}`).join(',')})`, cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
  realRows++;
}
await db.exec('rollback');
console.log('real lane rows accepted by 018 constraints:', realRows);
const ok = realRows > 50 && result && result[1] === '15' && result[2] === '15' && persisted === 0 && before === after && schemaBefore === schemaAfter && left === 0
  && rls === 'pred_s10a_events=true,pred_s10a_marks=true,pred_s10a_runs=true,pred_s10a_snapshots=true';
if (!ok) { console.error('PROOF FAILED'); process.exit(1); }
console.log('PROOF PASSED');
