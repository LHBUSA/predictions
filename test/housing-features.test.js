import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceObservation } from '../src/source-observation.js';
import { assembleHousingFeatures, createHousingFeatureSnapshot, exactCalendarYoY } from '../src/features/housing.js';
import { probabilityHomePricesAbove } from '../src/models/housing-v0.js';

function observation({ provider, sourceId, sourceClass, data, capturedAt = '2026-09-16T18:00:00Z', geography = null, vintage = null, provenance = {} }) {
  return createSourceObservation({
    provider,
    sourceId,
    sourceClass,
    observedAt: capturedAt,
    availableAt: capturedAt,
    capturedAt,
    data,
    geography,
    vintage,
    provenance
  });
}

test('calendar YoY requires the exact prior-year month', () => {
  const history = [
    { date: '2026-08-01', rent: 1800 },
    { date: '2026-07-01', rent: 1780 },
    { date: '2025-08-01', rent: 1710 }
  ];
  assert.ok(Math.abs(exactCalendarYoY(history) - 5.2631578947) < 1e-8);
  assert.equal(exactCalendarYoY(history.slice(0, 2)), null);
});

test('housing assembler separates fresh PropData state signal from official FHFA signal', () => {
  const observations = [
    observation({
      provider: 'PropData',
      sourceId: 'state-intel:MN',
      sourceClass: 'propdata',
      geography: { state: 'MN' },
      data: {
        signal: 'BUY',
        market: {
          yoy_appreciation: 3.8,
          friction_score: 34,
          days_on_market: 41,
          price_cuts_pct: 17,
          months_supply: 2.7,
          sale_to_list_ratio: 99.2,
          as_of: '2026-08-31'
        }
      }
    }),
    observation({
      provider: 'PropData',
      sourceId: 'market:state:MN',
      sourceClass: 'propdata',
      geography: { state: 'MN' },
      data: {
        snapshot: { median_home_value: 355000, affordability_score: 61 },
        market: { appreciation: { yoy_appreciation_pct: 2.9, source: 'propdata_hpi_state_quarterly' } },
        rent: {
          history: [
            { date: '2026-08-01', rent: 1800 },
            { date: '2025-08-01', rent: 1710 }
          ]
        },
        macro: { mortgage_rate_30yr: 6.22, source: 'fred_live' }
      }
    }),
    observation({
      provider: 'PropTechUSA Census Intelligence',
      sourceId: 'acs:state:MN',
      sourceClass: 'official',
      geography: { state: 'MN' },
      data: {
        housing: { vacancy_rate_pct: 7.1, owner_occupied_pct: 71.4 },
        income: { median_household_income: 85700 },
        demographics: { total_population: 5800000 }
      }
    })
  ];

  const assembled = assembleHousingFeatures(observations);
  assert.equal(assembled.features.propdataPriceYoY, 3.8);
  assert.equal(assembled.features.fhfaHpiYoY, 2.9);
  assert.equal(assembled.features.mortgage30, 6.22);
  assert.ok(assembled.features.rentYoY > 5.2 && assembled.features.rentYoY < 5.3);
  assert.equal(assembled.context.censusVacancyRate, 7.1);
  assert.equal(assembled.quality.propdataStateSignalFresh, true);
  assert.deepEqual(assembled.quality.neutralImputations, ['permitsYoY', 'startsYoY', 'inventoryYoY', 'priorMortgage30']);

  const result = createHousingFeatureSnapshot({
    id: 'housing-fs-1',
    eventId: 'housing-mn-1',
    cutoffAt: '2026-09-16T19:00:00Z',
    observations
  });
  assert.equal(result.snapshot.features.propdataPriceYoY, 3.8);
  assert.deepEqual([...result.snapshot.sourceClasses].sort(), ['official', 'propdata']);

  const forecast = probabilityHomePricesAbove(result.snapshot.features, 2.0);
  assert.ok(forecast.probability >= 0 && forecast.probability <= 1);
  assert.deepEqual(forecast.explanation.neutralImputations, ['permitsYoY', 'startsYoY', 'inventoryYoY', 'priorMortgage30']);
});

test('retained HPI is preferred and stale state-intel price momentum is excluded', () => {
  const observations = [
    observation({
      provider: 'PropData',
      sourceId: 'state-intel:MN',
      sourceClass: 'propdata',
      data: { market: { yoy_appreciation: 9.9, as_of: '2025-11-30' } }
    }),
    observation({
      provider: 'PropData',
      sourceId: 'market:state:MN',
      sourceClass: 'propdata',
      data: {
        market: { appreciation: { yoy_appreciation_pct: 8.8, source: 'propdata_hpi_state_quarterly' } },
        macro: { mortgage_rate_30yr: 6.1, source: 'fred_reference_fallback' },
        rent: { history: [] }
      }
    }),
    observation({
      provider: 'Federal Housing Finance Agency',
      sourceId: 'fhfa-hpi:state:MN',
      sourceClass: 'official',
      capturedAt: '2026-09-16T08:17:01.978Z',
      geography: { level: 'state', state: 'MN' },
      vintage: '2026-Q2',
      provenance: { pointInTimeReplaySafeBeforeRetrievedAt: false },
      data: { yoyPct: 2.42389165412664, qoqPct: 2.56636142343804 }
    })
  ];

  const assembled = assembleHousingFeatures(observations, { cutoffAt: '2026-09-16T19:00:00Z' });
  assert.equal(assembled.features.propdataPriceYoY, null);
  assert.equal(assembled.features.fhfaHpiYoY, 2.42389165412664);
  assert.equal(assembled.features.mortgage30, null);
  assert.equal(assembled.quality.propdataStateSignalRawAvailable, true);
  assert.equal(assembled.quality.propdataStateSignalFresh, false);
  assert.equal(assembled.quality.fhfaSource, 'retained_hpi_history');
  assert.equal(assembled.quality.retainedHpiAvailable, true);
  assert.equal(assembled.quality.mortgageFallbackRejected, true);
  assert.ok(assembled.quality.neutralImputations.includes('propdataPriceYoY_stale'));
  assert.ok(assembled.quality.neutralImputations.includes('mortgage30_fallback'));
});

test('FHFA fallback value is not promoted to an observed official price signal', () => {
  const observations = [
    observation({
      provider: 'PropData',
      sourceId: 'state-intel:MN',
      sourceClass: 'propdata',
      data: { market: { yoy_appreciation: 3.1, as_of: '2026-08-31' } }
    }),
    observation({
      provider: 'PropData',
      sourceId: 'market:state:MN',
      sourceClass: 'propdata',
      data: {
        market: { appreciation: { yoy_appreciation_pct: 2.5, source: 'fhfa_state_reference_fallback' } },
        macro: { mortgage_rate_30yr: 6.1, source: 'fred_reference_fallback' },
        rent: { history: [] }
      }
    })
  ];

  const assembled = assembleHousingFeatures(observations);
  assert.equal(assembled.features.propdataPriceYoY, 3.1);
  assert.equal(assembled.features.fhfaHpiYoY, null);
  assert.equal(assembled.features.mortgage30, null);
  assert.equal(assembled.quality.fhfaSignalAvailable, false);
  assert.equal(assembled.quality.mortgageFallbackRejected, true);
});
