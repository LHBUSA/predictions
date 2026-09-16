import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabasePredictionsLedger, sourceObservationKey } from '../src/supabase-ledger.js';
import { createSourceObservation } from '../src/source-observation.js';
import { createFeatureSnapshot } from '../src/feature-snapshot.js';

function mockFetch(calls, responseBody = '') {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(responseBody, {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  };
}

test('source observation database key matches feature snapshot source reference', async () => {
  const observation = createSourceObservation({
    provider: 'PropData',
    sourceId: 'market:state:MN',
    sourceClass: 'propdata',
    observedAt: '2026-09-16T18:00:00Z',
    availableAt: '2026-09-16T18:00:00Z',
    capturedAt: '2026-09-16T18:00:00Z',
    data: { sample: true }
  });
  const snapshot = createFeatureSnapshot({
    id: 'fs-1',
    eventId: 'evt-1',
    modelId: 'housing-price-baseline',
    cutoffAt: '2026-09-16T19:00:00Z',
    createdAt: '2026-09-16T18:01:00Z',
    features: { propdataPriceYoY: 3.1 },
    observations: [observation]
  });

  assert.equal(snapshot.sourceObservationIds[0], sourceObservationKey(observation));

  const calls = [];
  const ledger = new SupabasePredictionsLedger({
    url: 'https://example.supabase.co',
    serviceKey: 'service-secret',
    fetchImpl: mockFetch(calls)
  });
  const key = await ledger.insertSourceObservation(observation);
  assert.equal(key, snapshot.sourceObservationIds[0]);
  assert.match(calls[0].url, /pred_source_observations\?on_conflict=observation_key$/);
  assert.equal(calls[0].init.headers.prefer, 'resolution=ignore-duplicates,return=minimal');
  assert.equal(calls[0].init.headers.apikey, 'service-secret');
  assert.doesNotMatch(calls[0].url, /service-secret/);
});

test('feature snapshots and forecasts use append-only conflict handling', async () => {
  const calls = [];
  const ledger = new SupabasePredictionsLedger({
    url: 'https://example.supabase.co',
    serviceKey: 'service-secret',
    fetchImpl: mockFetch(calls)
  });

  await ledger.insertFeatureSnapshot({
    id: 'fs-2',
    eventId: 'evt-2',
    modelId: 'housing-price-baseline',
    cutoffAt: '2026-09-16T19:00:00Z',
    createdAt: '2026-09-16T18:00:00Z',
    features: { fhfaHpiYoY: 2.4 },
    sourceClasses: ['official'],
    sourceObservationIds: ['FHFA:HPI:2026-09-16T18:00:00Z']
  });

  await ledger.insertForecast({
    eventId: 'evt-2',
    modelId: 'housing-price-baseline',
    modelVersion: '0.1.1',
    probability: 0.62,
    capturedAt: '2026-09-16T18:05:00Z',
    featureSnapshotId: 'fs-2',
    provenance: [],
    explanation: {},
    metadata: {}
  }, { recordId: 'PBE-HOUSING-TEST-001', recordType: 'research' });

  assert.match(calls[0].url, /pred_feature_snapshots\?on_conflict=snapshot_id$/);
  assert.equal(calls[0].init.headers.prefer, 'resolution=ignore-duplicates,return=minimal');
  assert.match(calls[1].url, /pred_forecasts\?on_conflict=record_id$/);
  assert.equal(calls[1].init.headers.prefer, 'resolution=ignore-duplicates,return=minimal');
  const forecastRow = JSON.parse(calls[1].init.body);
  assert.equal(forecastRow.record_type, 'research');
  assert.equal(forecastRow.record_id, 'PBE-HOUSING-TEST-001');
});

test('event metadata is the only ledger surface that intentionally merges on conflict', async () => {
  const calls = [];
  const ledger = new SupabasePredictionsLedger({
    url: 'https://example.supabase.co',
    serviceKey: 'service-secret',
    fetchImpl: mockFetch(calls)
  });
  await ledger.upsertEvent({
    eventId: 'evt-3',
    canonicalQuestion: 'Will the test event resolve?',
    category: 'research',
    status: 'open'
  });
  assert.match(calls[0].url, /pred_events\?on_conflict=event_id$/);
  assert.equal(calls[0].init.headers.prefer, 'resolution=merge-duplicates,return=minimal');
});
