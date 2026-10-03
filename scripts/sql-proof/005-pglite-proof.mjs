// Local proof of sql/005 on PGlite: 001 -> 002 -> 003 -> 004 (features v2) -> a production-shaped published story -> 004 -> proofs -> rollback.
// Run from a directory with @electric-sql/pglite installed:  node <repo>/scripts/sql-proof/005-pglite-proof.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = process.env.PRED_SQL_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');
const read = (f) => readFileSync(join(root, f), 'utf8');
const db = new PGlite();
const results = [];
const check = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);
const rejects = async (sql, re) => { try { await db.exec(sql); return false; } catch (e) { try { await db.exec('rollback'); } catch { /* no open transaction */ } return re.test(e.message) || e.message; } };
const story = (id) => `insert into pred_newsroom_stories (story_id, story_class, trigger_key, slug, event_ids, story_cutoff, evidence, rules_version) values ('${id}','FORECAST_MOVER','t|${id}','${id}','{}', now(), '{}', 'newsroom/1')`;
const t = (id, s) => `insert into pred_newsroom_transitions (story_id, state) values ('${id}','${s}')`;

await db.exec(read('001_predictions_ledger.sql').replace('create extension if not exists pgcrypto;', ''));
await db.exec(read('002_prediction_engine_v1.sql'));
await db.exec(read('003_newsroom_v1.sql'));
await db.exec(read('004_features_market_free_v2.sql'));
// production shape: Boston published as five separate transactions
await db.exec(story('boston'));
// explicit, increasing timestamps: PGlite's clock is coarse enough that separate transactions can tie on now(),
// which reproduces the very 003 defect this migration fixes (production rows were written with real gaps)
let k = 0;
for (const s of ['CANDIDATE', 'EVIDENCE_READY', 'GENERATED', 'VALIDATED', 'PUBLISHED']) { k += 1; await db.exec(`insert into pred_newsroom_transitions (story_id, state, at) values ('boston','${s}', now() + interval '${k} milliseconds')`); }
// and the defect itself, on 003, before 004 is applied:
await db.exec(story('tie')); await db.exec(t('tie', 'CANDIDATE')); await db.exec(t('tie', 'EVIDENCE_READY')); await db.exec(t('tie', 'GENERATED'));
// root cause of the 003 defect, deterministically: rows written in one transaction tie on `at`, so 003's
// (at, uuid) ordering is decided by a random uuid (production proof saw a false rejection; it can also go the other way)
const ties = await db.transaction(async (tx) => {
  await tx.exec(`${t('tie', 'VALIDATED')}; ${t('tie', 'HELD')}`);
  const r = (await tx.query(`select count(distinct at)::int n from pred_newsroom_transitions where story_id='tie' and state in ('VALIDATED','HELD')`)).rows[0].n;
  await tx.rollback();
  return r;
});
check('003 root cause reproduced: same-transaction transitions tie on at', ties === 1, `distinct at = ${ties}`);

await db.exec(read('005_newsroom_transition_graph.sql'));
const seqs = (await db.query(`select state, seq from pred_newsroom_transitions where story_id='boston' order by seq`)).rows;
check('backfill keeps recorded order', seqs.map((r) => r.state).join('>') === 'CANDIDATE>EVIDENCE_READY>GENERATED>VALIDATED>PUBLISHED', seqs.map((r) => `${r.state}:${r.seq}`).join(' '));
check('published story still published', (await db.query(`select count(*)::int n from pred_newsroom_transitions where story_id='boston' and state='PUBLISHED'`)).rows[0].n === 1);
check('PUBLISHED is terminal', await rejects(t('boston', 'HELD'), /cannot move from PUBLISHED/) === true);

await db.exec(story('s2'));
check('first state must be CANDIDATE', await rejects(t('s2', 'VALIDATED'), /cannot move from none/) === true);
await db.exec(t('s2', 'CANDIDATE'));
check('skipping EVIDENCE_READY rejected', await rejects(t('s2', 'GENERATED'), /cannot move from CANDIDATE to GENERATED/) === true);
check('PUBLISHED from CANDIDATE rejected', await rejects(t('s2', 'PUBLISHED'), /cannot move/) === true);
check('same-transaction chain to PUBLISHED accepted (the 003 defect)', (await rejects(`begin; ${t('s2', 'EVIDENCE_READY')}; ${t('s2', 'GENERATED')}; ${t('s2', 'VALIDATED')}; ${t('s2', 'PUBLISHED')}; commit;`, /x/)) === false);
await db.exec(story('s3')); await db.exec(t('s3', 'CANDIDATE')); await db.exec(t('s3', 'EVIDENCE_READY')); await db.exec(t('s3', 'GENERATED'));
check('same-transaction VALIDATED then HELD blocks publication', await rejects(`begin; ${t('s3', 'VALIDATED')}; ${t('s3', 'HELD')}; commit; ${t('s3', 'PUBLISHED')}`, /cannot move from HELD to PUBLISHED/) === true);
check('HELD may only restart at CANDIDATE', (await rejects(t('s3', 'CANDIDATE'), /x/)) === false);
check('transitions still append-only', await rejects(`delete from pred_newsroom_transitions where story_id='s2'`, /append-only/) === true);

await db.exec(read('005_newsroom_transition_graph_ROLLBACK.sql'));
await db.exec(story('s4')); await db.exec(t('s4', 'CANDIDATE'));
check('rollback restores publish-only guard', await rejects(t('s4', 'PUBLISHED'), /cannot be PUBLISHED/) === true);

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} FAILED` : `ALL ${results.length} PASS`);
process.exit(failed ? 1 : 0);
