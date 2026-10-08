// PGlite proof for sql/015_cpi_shadow.sql: applies the ledger chain 001..014, seeds one weather contract + one v2.2 shadow
// row, applies 015, runs 015_PROOF.sql (aborts with PROOF_RESULT), checks nothing persisted, that the weather row is
// untouched, then ROLLBACK (weather NOT NULLs restored, CPI tables gone) and re-apply.
//   node scripts/db/prove-015.mjs [path-to-a-package.json that resolves @electric-sql/pglite]
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const pkg = process.argv[2] || 'D:/Workers/wt/tennis-parity/package.json';
const { PGlite } = await import(pathToFileURL(createRequire(pkg).resolve('@electric-sql/pglite')).href);
const dir = new URL('../../sql/', import.meta.url);
const sql = (f) => readFileSync(new URL(f, dir), 'utf8');
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text, name text);`);
const chain = readdirSync(dir).filter((f) => /^0(0\d|1[0-4])_[a-z0-9_]+\.sql$/.test(f) && !/_(PROOF|ROLLBACK)\.sql$/.test(f)).sort();
for (const f of chain) await db.exec(f.startsWith('001') ? sql(f).replace('create extension if not exists pgcrypto;', '') : sql(f));
console.log('applied', chain.join(' '));
const h = 'a'.repeat(64);
await db.exec(`insert into pred_events (event_id, canonical_question, category) values ('E1', 'q', 'weather');
insert into pred_contracts (contract_id, event_id, venue, market_id, normalizer_version, rules_sha256, normalization_status, domain, event_type, station_id, observation_start, observation_end, detail, normalized_at)
values ('C1', 'E1', 'kalshi', 'KXHIGHNY-26OCT08-B70.5', 'contract-norm/1', '${h}', 'NORMALIZED', 'WEATHER', 'MAX_TEMP_BUCKET', 'CLINYC', '2026-10-08 05:00Z', '2026-10-09 05:00Z', '{"climate_date":"2026-10-08"}', now());
insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, designation_rules, probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256)
values ('wx|1', 'E1', 'C1', 'pbe-weather-maxtemp-intraday', '2.2.0', 'SHADOW', 'shadow', 'designation-intraday-shadow/1', 0.3, '2026-10-08 12:00Z', '2026-10-08 11:00Z', 'CLINYC', '2026-10-08', '2026-10-08 05:00Z', '${h}', '${h}', '{"obs_max_so_far_f": 61}', '${h}');`);
const wx = async () => JSON.stringify((await db.query(`select record_id, probability, station_id, climate_date from pred_forecasts_shadow order by record_id`)).rows);
const before = await wx();
await db.exec(sql('015_cpi_shadow.sql'));
let parsed = null;
try { await db.exec(sql('015_cpi_shadow_PROOF.sql')); } catch (e) { parsed = JSON.parse(String(e.message).replace(/^.*PROOF_RESULT /, '')); }
console.log('015 PROOF_RESULT', JSON.stringify(parsed));
const count = async (t) => (await db.query(`select count(*)::int n from ${t}`)).rows[0].n;
const persisted = (await count('pred_macro_first_seen')) + (await count('pred_cpi_shadow_runs')) + (await count('pred_cpi_shadow_grades')) + (await count('pred_forecasts_shadow')) - 1;
const after = await wx();
console.log('rows persisted after proof:', persisted, '| weather row unchanged:', before === after);
await db.exec(sql('015_cpi_shadow_ROLLBACK.sql'));
const left = (await db.query(`select count(*)::int n from information_schema.tables where table_name in ('pred_macro_first_seen','pred_cpi_shadow_runs','pred_cpi_shadow_grades')`)).rows[0].n;
const notNull = (await db.query(`select string_agg(column_name || '=' || is_nullable, ',' order by column_name) s from information_schema.columns where table_name = 'pred_forecasts_shadow' and column_name in ('station_id','climate_date','observation_start')`)).rows[0].s;
console.log('after rollback: cpi tables', left, '| nullability', notNull, '| weather row unchanged:', (await wx()) === before);
await db.exec(sql('015_cpi_shadow.sql'));
console.log('re-applied 015');
const ok = parsed && Object.keys(parsed).length === 19 && Object.values(parsed).every((v) => v === true);
if (!ok || persisted !== 0 || before !== after || left !== 0 || notNull !== 'climate_date=NO,observation_start=NO,station_id=NO') { console.error('PROOF FAILED'); process.exit(1); }
console.log('PROOF PASSED');
