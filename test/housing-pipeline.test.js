import test from 'node:test';
import assert from 'node:assert/strict';
import housingPipeline from '../workers/pipeline-housing/src/index.js';

function jsonBinding(handler) {
  return {
    async fetch(url, init) {
      const body = init?.body ? JSON.parse(init.body) : null;
      const result = await handler(new URL(url).pathname, body);
      const status = result?.status || 200;
      return Response.json(result?.payload ?? result, { status });
    }
  };
}

function sourceObservation(provider, sourceId, sourceClass, data) {
  return {
    provider,
    sourceId,
    sourceClass,
    observedAt: '2026-09-16T18:00:00.000Z',
    availableAt: '2026-09-16T18:00:00.000Z',
    capturedAt: '2026-09-16T18:00:00.000Z',
    value: null,
    data,
    units: null,
    geography: { state: 'MN' },
    vintage: '2026-09-16T18:00:00.000Z',
    revision: null,
    provenance: {}
  };
}

test('housing pipeline persists sources, feature snapshot and research forecast', async () => {
  const ledgerCalls = [];
  const env = {
    LEDGER: jsonBinding((path, body) => {
      ledgerCalls.push({ path, body });
      return { ok: true, data: { persisted: true }, meta: {} };
    }),
    SOURCE_PROPDATA: jsonBinding((_path, body) => {
      if (body.mode === 'state_intel') {
        return { ok: true, data: sourceObservation('PropData', 'state-intel:MN', 'propdata', { market: { yoy_appreciation: 3.5 } }), meta: {} };
      }
      return { ok: true, data: sourceObservation('PropData', 'market:state:MN', 'propdata', {
        market: { appreciation: { yoy_appreciation_pct: 2.7, source: 'propdata_hpi_state_quarterly' } },
        macro: { mortgage_rate_30yr: 6.2 },
        rent: { history: [] }
      }), meta: {} };
    }),
    SOURCE_CENSUS: jsonBinding(() => ({
      ok: true,
      data: sourceObservation('PropTechUSA Census Intelligence', 'acs:state:MN', 'official', { demographics: { total_population: 1 } }),
      meta: {}
    })),
    FEATURE_HOUSING: jsonBinding((_path, body) => ({
      ok: true,
      data: {
        id: body.id,
        eventId: body.eventId,
        modelId: 'housing-price-baseline',
        cutoffAt: body.cutoffAt,
        createdAt: body.cutoffAt,
        features: { propdataPriceYoY: 3.5, fhfaHpiYoY: 2.7 },
        sourceClasses: ['propdata', 'official'],
        sourceObservationIds: []
      },
      meta: { context: { sample: true }, quality: { neutralImputations: [] } }
    })),
    MODEL_HOUSING: jsonBinding((_path, body) => ({
      ok: true,
      data: {
        eventId: body.event.id,
        modelId: 'housing-price-baseline',
        modelVersion: '0.1.1',
        probability: 0.61,
        capturedAt: '2026-09-16T18:05:00.000Z',
        featureSnapshotId: body.featureSnapshotId,
        provenance: body.provenance,
        explanation: {},
        metadata: { modelStatus: 'research' }
      },
      meta: {}
    }))
  };

  const request = new Request('https://internal/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: { id: 'housing-mn-2026', question: 'Will Minnesota home prices rise more than 2%?', threshold: 2, direction: 'above' },
      location: { state: 'MN' }
    })
  });

  const response = await housingPipeline.fetch(request, env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.recordType, 'research');
  assert.equal(payload.data.forecast.probability, 0.61);
  assert.equal(payload.data.sourceObservations.length, 3);
  assert.deepEqual(ledgerCalls.map((call) => call.path), ['/event', '/source', '/source', '/source', '/feature', '/forecast']);
  assert.equal(ledgerCalls.at(-1).body.recordType, 'research');
});

test('housing pipeline degrades gracefully when optional Census context is unavailable', async () => {
  const env = {
    LEDGER: jsonBinding(() => ({ ok: true, data: {}, meta: {} })),
    SOURCE_PROPDATA: jsonBinding((_path, body) => ({
      ok: true,
      data: sourceObservation('PropData', body.mode === 'state_intel' ? 'state-intel:MN' : 'market:state:MN', 'propdata',
        body.mode === 'state_intel'
          ? { market: { yoy_appreciation: 3.0 } }
          : { market: { appreciation: { yoy_appreciation_pct: 2.5, source: 'fhfa_live' } }, macro: { mortgage_rate_30yr: 6.1 }, rent: { history: [] } }),
      meta: {}
    })),
    SOURCE_CENSUS: jsonBinding(() => ({ status: 503, payload: { ok: false, error: { message: 'census unavailable' } } })),
    FEATURE_HOUSING: jsonBinding((_path, body) => ({
      ok: true,
      data: { id: body.id, eventId: body.eventId, modelId: 'housing-price-baseline', cutoffAt: body.cutoffAt, createdAt: body.cutoffAt, features: { propdataPriceYoY: 3, fhfaHpiYoY: 2.5 }, sourceClasses: ['propdata'], sourceObservationIds: [] },
      meta: { context: {}, quality: {} }
    })),
    MODEL_HOUSING: jsonBinding((_path, body) => ({
      ok: true,
      data: { eventId: body.event.id, modelId: 'housing-price-baseline', modelVersion: '0.1.1', probability: 0.58, capturedAt: '2026-09-16T18:06:00.000Z', featureSnapshotId: body.featureSnapshotId, provenance: body.provenance, explanation: {}, metadata: { modelStatus: 'research' } },
      meta: {}
    }))
  };

  const response = await housingPipeline.fetch(new Request('https://internal/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: { id: 'housing-mn-2', question: 'Test?', threshold: 2 }, location: { state: 'MN' } })
  }), env);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.sourceObservations.length, 2);
  assert.match(payload.data.warnings[0], /Census context unavailable/);
});
