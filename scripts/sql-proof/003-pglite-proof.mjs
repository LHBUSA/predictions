// Local proof of sql/003 on an in-process Postgres (PGlite): 001 -> 002 -> 003 -> proofs -> rollback -> re-apply.
// Run from a directory with @electric-sql/pglite installed:  node <repo>/scripts/sql-proof/003-pglite-proof.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');
const read = (f) => readFileSync(join(root, f), 'utf8');
const db = new PGlite();
const results = [];
const check = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);
const rejects = async (sql, re) => { try { await db.exec(sql); return false; } catch (e) { return re.test(e.message) || e.message; } };

await db.exec(read('001_predictions_ledger.sql').replace('create extension if not exists pgcrypto;', ''));
await db.exec(read('002_prediction_engine_v1.sql'));
const tablesBefore = (await db.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)).rows[0].n;
await db.exec(read('003_newsroom_v1.sql'));
const tablesAfter = (await db.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)).rows[0].n;
check('003 adds exactly three tables', tablesAfter - tablesBefore === 3, `${tablesBefore} -> ${tablesAfter}`);

const story = (id, trigger, slug) => `insert into pred_newsroom_stories (story_id, story_class, trigger_key, slug, event_ids, story_cutoff, evidence, rules_version)
  values ('${id}','FORECAST_MOVER','${trigger}','${slug}','{E1}', now(), '{"claims":[]}', 'newsroom/1')`;
await db.exec(story('s1', 'MOVER|M|a|b', 'slug-1'));
check('duplicate trigger rejected (dedupe)', await rejects(story('s2', 'MOVER|M|a|b', 'slug-2'), /unique|duplicate/) === true);
check('duplicate slug rejected', await rejects(story('s3', 'MOVER|M|a|c', 'slug-1'), /unique|duplicate/) === true);
check('story row immutable', await rejects(`update pred_newsroom_stories set slug='x' where story_id='s1'`, /append-only/) === true);
const t = (id, state) => `insert into pred_newsroom_transitions (story_id, state) values ('${id}','${state}')`;
await db.exec(t('s1', 'CANDIDATE'));
check('PUBLISHED without VALIDATED rejected', await rejects(t('s1', 'PUBLISHED'), /cannot be PUBLISHED/) === true);
await db.exec(t('s1', 'EVIDENCE_READY')); await db.exec(t('s1', 'GENERATED')); await db.exec(t('s1', 'HELD'));
check('PUBLISHED after HELD rejected', await rejects(t('s1', 'PUBLISHED'), /cannot be PUBLISHED/) === true);
await db.exec(t('s1', 'VALIDATED'));
check('PUBLISHED after VALIDATED accepted', (await rejects(t('s1', 'PUBLISHED'), /x/)) === false);
check('second PUBLISHED rejected', await rejects(`${t('s1', 'VALIDATED')}; ${t('s1', 'PUBLISHED')}`, /unique|duplicate/) === true);
check('transitions append-only', await rejects(`delete from pred_newsroom_transitions where story_id='s1'`, /append-only/) === true);
await db.exec(`insert into pred_cycle_diagnostics (cycle_at, kind, scope, reason, contracts) values (now(), 'FORECAST_SKIP', 'station:CLILAX', 'SOURCE_ERROR', 6)`);
check('diagnostics append-only', await rejects(`update pred_cycle_diagnostics set reason='x'`, /append-only/) === true);
check('unknown state rejected', await rejects(t('s1', 'DRAFT'), /check/) === true);

await db.exec(read('003_newsroom_v1_ROLLBACK.sql'));
const tablesRb = (await db.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)).rows[0].n;
check('rollback restores 002 shape', tablesRb === tablesBefore, `${tablesRb}`);
await db.exec(read('003_newsroom_v1.sql'));
check('re-apply after rollback', true);

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} FAILED` : `ALL ${results.length} PASS`);
process.exit(failed ? 1 : 0);
