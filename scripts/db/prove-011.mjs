// PGlite proof for sql/011_engine_runs.sql (+ ROLLBACK): builds pred_reject_mutation() from sql/001, applies 011, runs
// 011_PROOF.sql (aborts with PROOF_RESULT), checks TRUNCATE is rejected, then applies the ROLLBACK.
//   node scripts/db/prove-011.mjs [path-to-a-package.json that resolves @electric-sql/pglite]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const pkg = process.argv[2] || 'D:/Workers/wt/tennis-mv/package.json';
const { PGlite } = await import(pathToFileURL(createRequire(pkg).resolve('@electric-sql/pglite')).href);
const sql = (f) => readFileSync(new URL(`../../sql/${f}`, import.meta.url), 'utf8');
const db = new PGlite();
const fn = (src, name) => { const s = src.indexOf(`create or replace function ${name}`); return src.slice(s, src.indexOf('$$;', s) + 3); };
await db.exec(`create role anon; create role authenticated; create role service_role; create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text, name text);`);
await db.exec(fn(sql('001_predictions_ledger.sql'), 'pred_reject_mutation()'));
await db.exec(sql('011_engine_runs.sql'));
let parsed = null;
try { await db.exec(sql('011_engine_runs_PROOF.sql')); } catch (e) { parsed = JSON.parse(String(e.message).replace(/^.*PROOF_RESULT /, '')); }
console.log('011 PROOF_RESULT', JSON.stringify(parsed));
const persisted = (await db.query('select count(*)::int n from pred_engine_runs')).rows[0].n + (await db.query('select count(*)::int n from pred_engine_lease')).rows[0].n;
const trunc = await db.exec('truncate pred_engine_runs').then(() => 'ALLOWED', (e) => `rejected: ${e.message.slice(0, 80)}`);
console.log('rows persisted after proof:', persisted, '| truncate:', trunc);
await db.exec(sql('011_engine_runs_ROLLBACK.sql'));
const left = (await db.query(`select count(*)::int n from information_schema.tables where table_name like 'pred_engine_%'`)).rows[0].n;
console.log('after rollback, pred_engine_* tables:', left);
const ok = parsed && Object.keys(parsed).length === 12 && Object.values(parsed).every((v) => v === true);
if (!ok || persisted !== 0 || !/rejected/.test(trunc) || left !== 0) { console.error('PROOF FAILED'); process.exit(1); }
console.log('PROOF PASSED');
