// DB / code leakage-guard parity: the CHECK pred_features_market_free (sql/004) is GENERATED from the same
// MARKET_KEY_PATTERN the engine uses, and both agree on a shared table of blocked / allowed keys.
// Real-Postgres evaluation of the same table: scripts/sql-proof/004-pglite-proof.mjs (PGlite) and
// sql/004_features_market_free_v2_PROOF.sql (production, always rolled back).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MARKET_KEY_PATTERN, findMarketKeys } from '../src/engine/leakage.js';
import { renderMigration, renderProof, sqlPattern, keyTable, MIGRATION_PATH, PROOF_PATH } from '../scripts/db/gen-market-free-sql.mjs';

const file = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('committed sql/004 migration + proof are exactly the generator output (no drift from leakage.js)', () => {
  assert.equal(file(MIGRATION_PATH), renderMigration(), 'regenerate: node scripts/db/gen-market-free-sql.mjs');
  assert.equal(file(PROOF_PATH), renderProof(), 'regenerate: node scripts/db/gen-market-free-sql.mjs');
});

test('the SQL CHECK pattern is the JS MARKET_KEY_PATTERN source, matched case-insensitively', () => {
  const sql = file(MIGRATION_PATH);
  const m = sql.match(/k\.key ~\* '([^']+)'/g);
  assert.equal(m.length, 1, 'exactly one pattern in the function');
  assert.equal(m[0], `k.key ~* '${MARKET_KEY_PATTERN.source}'`);
  assert.equal(MARKET_KEY_PATTERN.flags, 'i');
  assert.equal(sqlPattern(), MARKET_KEY_PATTERN.source);
});

test('generator refuses JS-only regex constructs that Postgres would read differently', () => {
  assert.throws(() => sqlPattern(/(?<=_)bid/i));
  assert.throws(() => sqlPattern(/\bbid\b/i));
  assert.throws(() => sqlPattern(/bid/));
  assert.throws(() => sqlPattern(/bid/gi));
});

test('shared parity table: JS guard blocks every blocked key and allows every allowed key (top level, nested, in arrays)', () => {
  const { blocked, allowed } = keyTable();
  assert.ok(blocked.length >= 90 && allowed.length >= 25);
  for (const k of blocked) {
    assert.equal(MARKET_KEY_PATTERN.test(k), true, `blocked: ${k}`);
    assert.ok(findMarketKeys({ a: { b: [1, { [k]: 1 }] } }).length === 1, `nested blocked: ${k}`);
  }
  for (const k of allowed) {
    assert.equal(MARKET_KEY_PATTERN.test(k), false, `allowed: ${k}`);
    assert.deepEqual(findMarketKeys({ a: [{ [k]: 1 }] }), [], `nested allowed: ${k}`);
  }
});

test('live production feature names are in the allowed table (DB must accept every engine write)', () => {
  const { allowed } = keyTable();
  for (const n of ['nbm_max_temp_spread_f', 'cmt6m_minus_target_mid', 'guidance_error_table', 'mos_pop_union', 'last_published_yield', 'ewma_daily_sigma']) {
    assert.ok(allowed.includes(n), n);
  }
});
