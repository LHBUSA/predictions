// PGlite proof for sql/009_crypto_shadow.sql (+ ROLLBACK): builds the two prerequisite functions from sql/001 and
// sql/004, applies 009, runs 009_PROOF.sql (which aborts with PROOF_RESULT), then applies the ROLLBACK.
//   node scripts/db/prove-009.mjs [path-to-@electric-sql/pglite package dir]
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
await db.exec(fn(sql('004_features_market_free_v2.sql'), 'pred_features_market_free(doc jsonb)'));
await db.exec(sql('009_crypto_shadow.sql'));
let result = null;
try { await db.exec(sql('009_crypto_shadow_PROOF.sql')); } catch (e) { result = String(e.message).replace(/^.*PROOF_RESULT /, ''); }
console.log('PROOF_RESULT', result);
const parsed = JSON.parse(result);
const ok = Object.values(parsed).every((v) => v === true);
const trunc = await db.exec('truncate pred_crypto_scores').then(() => 'ALLOWED', (e) => `rejected: ${e.message.slice(0, 80)}`);
console.log('truncate:', trunc);
await db.exec(sql('009_crypto_shadow_ROLLBACK.sql'));
const left = (await db.query(`select count(*)::int n from information_schema.tables where table_name like 'pred_crypto_%'`)).rows[0].n;
console.log('after rollback, pred_crypto_* tables:', left);
if (!ok || !/rejected/.test(trunc) || left !== 0) { console.error('PROOF FAILED'); process.exit(1); }
console.log('PROOF PASSED');
