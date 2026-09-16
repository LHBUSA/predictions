import test from 'node:test';
import assert from 'node:assert/strict';
import { PropDataHousingHistoryAdapter, summarizeHousingHistory } from '../src/propdata-history.js';
import { housingHistoryToObservation } from '../workers/source-housing-history/src/index.js';
import { captureStates } from '../workers/collector-housing-history/src/index.js';

test('housing history summary computes exact prior-quarter and year-ago changes', () => {
  const summary = summarizeHousingHistory([
    { year: 2026, quarter: 2, index_nsa: 110, fetched_at: '2026-09-16T08:17:00Z' },
    { year: 2026, quarter: 1, index_nsa: 108, fetched_at: '2026-09-16T08:17:00Z' },
    { year: 2025, quarter: 2, index_nsa: 100, fetched_at: '2026-09-16T08:17:00Z' }
  ], 'index_nsa');
  assert.equal(summary.latest.value, 110);
  assert.equal(summary.previousQuarter.value, 108);
  assert.equal(summary.yearAgo.value, 100);
  assert.ok(Math.abs(summary.qoqPct - 1.8518518518518603) < 1e-12);
  assert.ok(Math.abs(summary.yoyPct - 10) < 1e-12);
});

test('PropData history adapter queries state HPI with secret-safe Supabase headers', async () => {
  let seenUrl = null;
  let seenOptions = null;
  const fetchImpl = async (url, options) => {
    seenUrl = String(url);
    seenOptions = options;
    return new Response(JSON.stringify([
      { state_code: 'MN', year: 2026, quarter: 2, index_nsa: 442.42, index_sa: 435.22, source_dataset: 'Purchase-Only State HPI', source_frequency: 'quarterly', fetched_at: '2026-09-16T08:17:01.978Z' },
      { state_code: 'MN', year: 2026, quarter: 1, index_nsa: 431.35, index_sa: 434.17, source_dataset: 'Purchase-Only State HPI', source_frequency: 'quarterly', fetched_at: '2026-09-16T08:17:01.978Z' },
      { state_code: 'MN', year: 2025, quarter: 2, index_nsa: 431.95, index_sa: 424.55, source_dataset: 'Purchase-Only State HPI', source_frequency: 'quarterly', fetched_at: '2026-09-16T08:17:01.978Z' }
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const adapter = new PropDataHousingHistoryAdapter({ url: 'https://propdata.supabase.test', serviceKey: 'server-secret', fetchImpl });
  const result = await adapter.stateHpi('mn', { limit: 8 });
  assert.match(seenUrl, /propdata_hpi_state_quarterly/);
  assert.doesNotMatch(seenUrl, /server-secret/);
  assert.equal(seenOptions.headers.apikey, 'server-secret');
  assert.equal(result.geography.state, 'MN');
  assert.ok(Math.abs(result.yoyPct - 2.423891654126642) < 1e-12);
  assert.equal(result.pointInTimeReplaySafeBeforeRetrievedAt, false);
});

test('housing history observation pins capturedAt to upstream retrieval for idempotency', () => {
  const payload = {
    provider: 'Federal Housing Finance Agency',
    normalizationLayer: 'PropData',
    sourceId: 'fhfa-hpi:state:MN',
    geography: { level: 'state', state: 'MN' },
    dataset: 'Purchase-Only State HPI',
    frequency: 'quarterly',
    retrievedByPropDataAt: '2026-09-16T08:17:01.978Z',
    availabilitySemantics: 'current_retrieval_of_historical_series',
    pointInTimeReplaySafeBeforeRetrievedAt: false,
    latest: { year: 2026, quarter: 2, periodEnd: '2026-06-30T23:59:59.999Z', value: 442.42 },
    previousQuarter: null,
    yearAgo: null,
    qoqPct: null,
    yoyPct: null,
    history: []
  };
  const observation = housingHistoryToObservation(payload, '2026-09-16T19:00:00Z');
  assert.equal(observation.capturedAt, '2026-09-16T08:17:01.978Z');
  assert.equal(observation.availableAt, '2026-09-16T08:17:01.978Z');
  assert.equal(observation.provenance.predictionsIngestedAt, '2026-09-16T19:00:00Z');
});

test('collector persists every returned state observation through ledger binding', async () => {
  const persisted = [];
  const env = {
    HOUSING_HISTORY: {
      async fetch(url, options) {
        const body = JSON.parse(options.body);
        const state = body.geography.state;
        return Response.json({ ok: true, data: {
          provider: 'Federal Housing Finance Agency', sourceId: `fhfa-hpi:state:${state}`, sourceClass: 'official',
          observedAt: '2026-06-30T23:59:59.999Z', availableAt: '2026-09-16T08:17:00.000Z', capturedAt: '2026-09-16T08:17:00.000Z',
          value: 100, data: {}, units: 'hpi_index', geography: { level: 'state', state }, vintage: '2026-Q2', revision: null, provenance: {}
        } });
      }
    },
    LEDGER: {
      async fetch(url, options) {
        const body = JSON.parse(options.body);
        persisted.push(body.sourceId);
        return Response.json({ ok: true, data: { observationKey: `${body.provider}:${body.sourceId}:${body.capturedAt}` } });
      }
    }
  };
  const result = await captureStates(env, ['MN', 'FL']);
  assert.equal(result.captured, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(persisted.sort(), ['fhfa-hpi:state:FL', 'fhfa-hpi:state:MN']);
});
