// Core-cycle I/O fan-out (2-minute cadence work): bounded concurrency, order-preserving results, and the
// designate/resolve/score phase still writing the same rows when its reads and writes run concurrently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, EngineStore } from '../src/engine/store.js';
import { designateResolveScore } from '../workers/pbe-predictions/src/cycle.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pool: never more than `limit` in flight; results keep input order', async () => {
  let inFlight = 0; let peak = 0;
  const out = await pool([5, 1, 4, 2, 3, 0, 6], 3, async (x, i) => { inFlight += 1; peak = Math.max(peak, inFlight); await sleep(x * 3); inFlight -= 1; return `${i}:${x}`; });
  assert.deepEqual(out, ['0:5', '1:1', '2:4', '3:2', '4:3', '5:0', '6:6']);
  assert.equal(peak, 3);
  assert.deepEqual(await pool([], 4, async () => 1), []);
});

test('pool: a rejection propagates (callers that tolerate errors catch inside fn)', async () => {
  await assert.rejects(pool([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x; }), /boom/);
});

test('selectIn: chunks read concurrently (bounded), concatenated in chunk order', async () => {
  let inFlight = 0; let peak = 0;
  const store = Object.create(EngineStore.prototype);
  store.select = async (table, q) => { inFlight += 1; peak = Math.max(peak, inFlight); const ids = q.id.slice(4, -1).split(',').map((s) => s.replace(/"/g, '')); await sleep(ids.length % 2 ? 6 : 1); inFlight -= 1; return ids.map((id) => ({ id })); };
  const ids = Array.from({ length: 95 }, (_, i) => `c${String(i).padStart(3, '0')}`);
  const rows = await store.selectIn('pred_contracts', {}, 'id', ids, { chunkSize: 10 });
  assert.deepEqual(rows.map((r) => r.id), ids);
  assert.ok(peak > 1 && peak <= 4, `peak ${peak}`);
});

test('designate/resolve/score: concurrent reads + writes produce each designation exactly once', async () => {
  const now = '2026-10-04T18:00:00.000Z';
  const contract = { contract_id: 'C1', event_id: 'E1', market_id: 'M1', normalization_status: 'NORMALIZED', observation_start: '2026-10-05T05:00:00.000Z', observation_end: '2026-10-06T05:00:00.000Z', event_type: 'RAIN_ANY', detail: { climate_date: '2026-10-05' } };
  const forecasts = [{ forecast_id: 'f1', contract_id: 'C1', model_id: 'pbe-weather-rain', probability: 0.4, market_probability: 0.5, captured_at: '2026-10-04T12:00:00.000Z' }];
  const written = [];
  const store = {
    async select(t) { return t === 'pred_contracts' ? [contract] : []; },
    async selectIn(t) { await sleep(2); return t === 'pred_forecasts' ? forecasts : []; },
    async write(t, row) { await sleep(1); written.push([t, row.designation]); },
    async insertReturning() { return []; },
  };
  const out = await designateResolveScore({}, { store, mkt: { marketsByTicker: async () => [] }, fetchImpl: null, now });
  assert.equal(out.designations, written.length);
  assert.ok(out.designations >= 1, JSON.stringify(out));
  assert.equal(new Set(written.map((w) => w.join('|'))).size, written.length);
});
