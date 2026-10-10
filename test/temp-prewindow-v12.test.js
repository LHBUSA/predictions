import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import v12 from '../src/weather/artifacts/temp-prewindow-v1.2.json' with { type: 'json' };
import v11 from '../src/weather/artifacts/temp-nbm-v1.1.json' with { type: 'json' };
import { v12Center, v12Probabilities, v12Beta, V12_MODEL } from '../src/weather/temp-prewindow-v12.js';
import { residualTable, bucketProbability } from '../src/weather/temp-model.js';
import { DECISION_POLICY } from '../src/engine/decision.js';

// FROZEN 2026-10-10 (issue #64). Any change to the artifact = a new version, and the forward record restarts.
const FROZEN_SHA256 = 'b1269e941089148a93ba030f973eb8a063cbb828736c7728ad13922f37f83c99';

test('v1.2 artifact is frozen (canonical-JSON sha256 pinned) and labelled SHADOW', () => {
  assert.equal(createHash('sha256').update(JSON.stringify(v12)).digest('hex'), FROZEN_SHA256);
  assert.equal(v12.status, 'SHADOW'); assert.equal(v12.version, '1.2.0'); assert.equal(V12_MODEL.state, 'SHADOW');
  assert.equal(v12.selection.retrospective_screen.passed, true); assert.equal(v12.selection.retrospective_screen.pristine, false);
  assert.deepEqual(v12.probability_bounds, v11.probability_bounds);
});

test('v1.2 model parameters carry no market input (guidance = NBM + GFS MOS only)', () => {
  const params = { guidance: v12.guidance, method: v12.method, beta: v12.beta, bounds: v12.probability_bounds, tables: Object.keys(v12.station_residuals).concat(Object.keys(v12.pooled_residuals)) };
  assert.doesNotMatch(JSON.stringify(params), /kalshi|polymarket|market|bid|\bask\b|venue|price/i);
  assert.equal(v12.guidance, 'nbm+gfs-regression');
});

test('center = NBM + beta (GFS - NBM); beta = 0 reduces to v1.1-style NBM centring; no GFS -> NO_GFS, never a v1.1 substitute', () => {
  const b = v12Beta(v12, 'CLIMDW'); assert.ok(b > 0 && b < 1);
  assert.equal(v12Center(v12, 'CLIMDW', 70, 70), 70);
  assert.ok(Math.abs(v12Center(v12, 'CLIMDW', 70, 76) - (70 + 6 * b)) < 1e-12);
  assert.equal(v12Center(v12, 'CLIMDW', 70, null), null);
  assert.equal(v12Beta(v12, 'CLI_UNKNOWN'), v12.beta.pooled);
  const r = v12Probabilities(v12, { stationCli: 'CLIMDW', runLeadH: 24, nbmF: 70, gfsF: null, contracts: [] });
  assert.equal(r.state, 'NO_GFS'); assert.equal(r.probabilities, null);
});

test('v1.2 bucket probabilities form a near-exhaustive distribution on a Kalshi ladder', () => {
  const ladder = [{ comparator: 'less', high: 70 }, ...[70, 72, 74, 76].map((lo) => ({ comparator: 'between', low: lo, high: lo + 1 })), { comparator: 'greater', low: 77 }];
  const r = v12Probabilities(v12, { stationCli: 'CLIMDW', runLeadH: 24, nbmF: 72, gfsF: 75, contracts: ladder });
  assert.equal(r.state, 'OK'); const s = r.probabilities.reduce((a, b) => a + b, 0);
  assert.ok(s > 0.97 && s < 1.06, String(s));
  assert.ok(r.probabilities.every((p) => p >= 0.01 && p <= 0.99));
  // With GFS warmer than NBM the v1.2 mass shifts warmer than v1.1's on the same inputs.
  const t11 = residualTable(v11, 'CLIMDW', 24); const p11 = ladder.map((c) => bucketProbability(v11, t11, 72, c));
  const ev = (ps) => ps.reduce((a, p, i) => a + p * i, 0) / ps.reduce((a, b) => a + b, 0);
  assert.ok(ev(r.probabilities) > ev(p11));
});

test('v1.2 is research only: no Worker or engine path imports it, and temperature stays unvalidated (no CALL)', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const hits = [...walk('workers'), ...walk('src')].filter((p) => /\.(m?js)$/.test(p) && !p.endsWith('temp-prewindow-v12.js'))
    .filter((p) => /temp-prewindow-v1(2|\.2)/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
  assert.equal(DECISION_POLICY.families['pbe-weather-maxtemp'].validated, false);
  assert.equal(DECISION_POLICY.families['pbe-weather-precip'].validated, true); // rain policy untouched
});
