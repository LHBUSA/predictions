import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceObservation } from '../src/source-observation.js';
import { assembleHousingFeatures } from '../src/features/housing.js';

function observation(input) {
  return createSourceObservation({
    observedAt: input.observedAt || input.capturedAt,
    availableAt: input.availableAt || input.capturedAt,
    capturedAt: input.capturedAt,
    value: input.value ?? null,
    data: input.data ?? null,
    geography: input.geography ?? null,
    vintage: input.vintage ?? null,
    provenance: input.provenance || {},
    provider: input.provider,
    sourceId: input.sourceId,
    sourceClass: input.sourceClass
  });
}

test('housing features prefer retained official FRED mortgage history over PropData fallback', () => {
  const observations = [
    observation({
      provider: 'PropData',
      sourceId: 'market:state:MN',
      sourceClass: 'propdata',
      capturedAt: '2026-09-16T19:00:00Z',
      data: {
        market: { appreciation: { yoy_appreciation_pct: 2.4, source: 'fhfa_live' } },
        macro: { mortgage_rate_30yr: 6.75, source: 'fred_reference_fallback' },
        rent: { history: [] }
      }
    }),
    observation({
      provider: 'FRED',
      sourceId: 'MORTGAGE30US',
      sourceClass: 'official',
      capturedAt: '2026-09-16T19:01:00Z',
      observedAt: '2026-09-10T00:00:00Z',
      availableAt: '2026-09-10T23:59:59.999Z',
      value: 6.76,
      vintage: '2026-09-10',
      provenance: { seriesKey: 'mortgage30', availabilityBasis: 'observation-date' },
      data: {
        latest: { date: '2026-09-10', value: 6.76 },
        previous: { date: '2026-09-03', value: 6.71 },
        history: [
          { date: '2026-09-10', value: 6.76 },
          { date: '2026-09-03', value: 6.71 }
        ]
      }
    })
  ];

  const assembled = assembleHousingFeatures(observations, { cutoffAt: '2026-09-16T20:00:00Z' });
  assert.equal(assembled.features.mortgage30, 6.76);
  assert.equal(assembled.features.priorMortgage30, 6.71);
  assert.equal(assembled.quality.mortgageSource, 'FRED:MORTGAGE30US');
  assert.equal(assembled.quality.retainedMortgageAvailable, true);
  assert.equal(assembled.quality.mortgageMomentumAvailable, true);
  assert.equal(assembled.quality.mortgageFallbackRejected, false);
  assert.ok(!assembled.quality.neutralImputations.includes('mortgage30'));
  assert.ok(!assembled.quality.neutralImputations.includes('priorMortgage30'));
});
