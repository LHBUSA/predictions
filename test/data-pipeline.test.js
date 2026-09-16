import test from 'node:test';
import assert from 'node:assert/strict';
import { PropDataAdapter, normalizePropDataLocation } from '../src/propdata.js';
import { createSourceObservation } from '../src/source-observation.js';
import { createFeatureSnapshot } from '../src/feature-snapshot.js';

test('PropData adapter keeps credentials in header and validates location', async () => {
  let seenUrl;
  let seenOptions;
  const fetchImpl = async (url, options) => {
    seenUrl = String(url);
    seenOptions = options;
    return { ok: true, json: async () => ({ market: { sample: true } }) };
  };
  const adapter = new PropDataAdapter({ apiKey: 'secret-test-key', fetchImpl, baseUrl: 'https://example.test' });
  const result = await adapter.market({ zip: '55104' });
  assert.match(seenUrl, /\/v1\/market\?zip=55104$/);
  assert.doesNotMatch(seenUrl, /secret-test-key/);
  assert.equal(seenOptions.headers['x-api-key'], 'secret-test-key');
  assert.deepEqual(result.location, { zip: '55104' });
  assert.throws(() => normalizePropDataLocation({ zip: '55104', state: 'MN' }), /exactly one/);
  assert.throws(() => normalizePropDataLocation({ zip: '5510' }), /5 digits/);
});

test('feature snapshot aggregates source classes and rejects future-known data', () => {
  const official = createSourceObservation({
    provider: 'FHFA', sourceId: 'HPI', sourceClass: 'official',
    observedAt: '2026-08-01T00:00:00Z', availableAt: '2026-09-01T13:00:00Z', capturedAt: '2026-09-01T13:01:00Z', value: 2.2
  });
  const propdata = createSourceObservation({
    provider: 'PropData', sourceId: 'market:zip:55104', sourceClass: 'propdata',
    observedAt: '2026-09-01T13:02:00Z', availableAt: '2026-09-01T13:02:00Z', capturedAt: '2026-09-01T13:02:00Z', data: { sample: true }
  });
  const snapshot = createFeatureSnapshot({
    id: 'fs-1', eventId: 'housing-1', modelId: 'housing-price-baseline', cutoffAt: '2026-09-01T14:00:00Z',
    features: { propdataPriceYoY: 2.4, fhfaHpiYoY: 2.2 }, observations: [official, propdata]
  });
  assert.deepEqual([...snapshot.sourceClasses].sort(), ['official', 'propdata']);
  assert.equal(snapshot.observations.length, 2);

  assert.throws(() => createFeatureSnapshot({
    id: 'fs-2', eventId: 'housing-1', modelId: 'housing-price-baseline', cutoffAt: '2026-09-01T13:01:30Z',
    features: { propdataPriceYoY: 2.4 }, observations: [propdata]
  }), /forecast cutoff/);
});
