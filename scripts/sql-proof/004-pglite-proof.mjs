// Local proof of sql/004 on an in-process Postgres (PGlite): 001 -> 002 -> seed live-shaped rows -> PROOF (rolled
// back) -> 004 -> rollback -> 004 again. Evaluates the shared parity table in real Postgres regex semantics.
// Run: cd <dir with @electric-sql/pglite installed> && node <repo>/scripts/sql-proof/004-pglite-proof.mjs  (not part of npm test: needs PGlite)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve PGlite from the CURRENT directory (the repo does not depend on it).
const { PGlite } = await import(pathToFileURL(createRequire(`${process.cwd()}/`).resolve('@electric-sql/pglite')).href);

const root = new URL('../../sql/', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');
const db = new PGlite();
const results = [];
const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); };

await db.exec(read('001_predictions_ledger.sql').replace('create extension if not exists pgcrypto;', ''));
await db.exec(read('002_prediction_engine_v1.sql'));
await db.exec(`insert into pred_events (event_id, canonical_question, category) values ('ev1', 'q', 'weather')`);
const live = [
  { mos_pop_union: 0.3, nbm_pop_union: 0.35, climatology_rate_1991_2020: 0.28, run_lead_hours: 30, mos_window_alignment_offset_h: 0 },
  { nbm_max_temp_guidance_f: 71, nbm_max_temp_spread_f: 2.4, guidance_error_table: { end: 3, pop: [{ p06: 1 }] } },
  { cmt6m_minus_target_mid: -0.11, cmt6m_change_since_last_decision: -0.2, previous_decision_direction: 'cut', horizon_days: 25 },
  { tenor_years: 10, last_published_yield: 4.1, last_published_date: '2026-10-02', ewma_daily_sigma: 0.05, period_running_extreme: 4.2, remaining_business_days: 3 },
];
for (const [i, f] of live.entries()) {
  await db.query(`insert into pred_feature_snapshots (snapshot_id, event_id, model_id, cutoff_at, created_at, features) values ($1,'ev1','m',now(),now(),$2)`, [`s${i}`, JSON.stringify(f)]);
}

// PROOF file: must abort with PROOF_RESULT and leave nothing behind.
let proof = null;
try { await db.exec(read('004_features_market_free_v2_PROOF.sql')); } catch (e) {
  const m = /PROOF_RESULT (\{.*\})/s.exec(e.message);
  proof = m ? JSON.parse(m[1]) : e.message;
}
await db.exec('rollback').catch(() => {});
check('proof raised PROOF_RESULT', proof && typeof proof === 'object', typeof proof === 'string' ? proof : '');
if (proof && typeof proof === 'object') {
  check('existing rows all pass v2', proof.existing_failing === 0 && proof.existing_rows === live.length, JSON.stringify({ n: proof.existing_rows, failing: proof.existing_failing }));
  check('blocked table all rejected (top + nested arrays)', proof.blocked_mismatch.length === 0, `${proof.blocked_total} keys ${JSON.stringify(proof.blocked_mismatch)}`);
  check('allowed table all accepted', proof.allowed_mismatch.length === 0, `${proof.allowed_total} keys ${JSON.stringify(proof.allowed_mismatch)}`);
  check('insert with blocked key rejected by CHECK', proof.insert_blocked === 'rejected', proof.insert_blocked);
  check('insert with live feature names accepted', proof.insert_clean === 'accepted', proof.insert_clean);
}
const left = (await db.query(`select count(*)::int n, obj_description('pred_features_market_free(jsonb)'::regprocedure) c from pred_feature_snapshots`)).rows[0];
check('proof left nothing behind (rows, function comment)', left.n === live.length && left.c === null, JSON.stringify(left));

await db.exec(read('004_features_market_free_v2.sql'));
const v2 = (await db.query(`select pred_features_market_free('{"x":[{"polymarket_midpoint":1}]}') a, pred_features_market_free('{"nbm_max_temp_spread_f":1}') b,
  obj_description('pred_features_market_free(jsonb)'::regprocedure) c`)).rows[0];
check('004 applied: v2 semantics live', v2.a === false && v2.b === true && /v2 GENERATED/.test(v2.c), JSON.stringify(v2));

await db.exec(read('004_features_market_free_v2_ROLLBACK.sql'));
const v1 = (await db.query(`select pred_features_market_free('{"best_bid":1}') a, pred_features_market_free('{"kalshi_mid":1}') b,
  (select count(*)::int from pg_constraint where conname = 'pred_feature_snapshots_market_free') n`)).rows[0];
check('rollback restores v1 (best_bid allowed again, kalshi blocked, CHECK present)', v1.a === true && v1.b === false && v1.n === 1, JSON.stringify(v1));

await db.exec(read('004_features_market_free_v2.sql'));
check('re-apply after rollback', (await db.query(`select pred_features_market_free('{"best_bid":1}') a`)).rows[0].a === false);

for (const r of results) console.log(r.join(' | '));
const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
