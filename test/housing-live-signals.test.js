import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceObservation } from '../src/source-observation.js';
import { assembleHousingFeatures } from '../src/features/housing.js';

function observation({ provider, sourceId, sourceClass, capturedAt, data, value = null, vintage = null }) {
  return createSourceObservation({
    provider,
    sourceId,
    sourceClass,
    observedAt: capturedAt,
    availableAt: capturedAt,
    capturedAt,
    data,
    value,
    vintage
  });
}

test('housing features prefer direct ZORI and Census BPS observations', () => {
  const observations = [
    observation({
      provider: 'PropData',
      sourceId: 'market:state:MN',
      sourceClass: 'propdata',
      capturedAt: '2026-09-16T20:00:00Z',
      data: {
        rent: {
          source: 'state_reference_fallback',
          history: [{ date: null, rent: 1450 }]
        },
        macro: { mortgage_rate_30yr: 6.75, source: 'fred_reference_fallback' }
      }
    }),
    observation({
      provider: 'Zillow Research',
      sourceId: 'zori:state:9',
      sourceClass: 'research',
      capturedAt: '2026-09-16T20:01:00Z',
      vintage: '2026-08',
      value: 1550,
      data: { period: '2026-08', value: 1550, yearAgo: 1500, yoyPct: 3.333333333333333, momPct: 0.5 }
    }),
    observation({
      provider: 'U.S. Census Bureau',
      sourceId: 'census-bps:state:MN',
      sourceClass: 'official',
      capturedAt: '2026-09-16T20:02:00Z',
      vintage: '2026-07',
      value: 2500,
      data: { period: '2026-07', value: 2500, yearAgoPeriod: '2025-07', yearAgo: 2300, yoyPct: 8.695652173913043 }
    })
  ];

  const assembled = assembleHousingFeatures(observations, { cutoffAt: '2026-09-16T21:00:00Z' });
  assert.equal(assembled.features.rentYoY, 3.333333333333333);
  assert.equal(assembled.features.permitsYoY, 8.695652173913043);
  assert.equal(assembled.features.startsYoY, null);
  assert.equal(assembled.quality.retainedZoriAvailable, true);
  assert.equal(assembled.quality.retainedPermitsAvailable, true);
  assert.equal(assembled.quality.rentSource, 'Zillow Research ZORI');
  assert.ok(!assembled.quality.neutralImputations.includes('rentYoY'));
  assert.ok(!assembled.quality.neutralImputations.includes('permitsYoY'));
  assert.ok(assembled.quality.neutralImputations.includes('startsYoY'));
});
