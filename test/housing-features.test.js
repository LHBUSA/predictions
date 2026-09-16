import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceObservation } from '../src/source-observation.js';
import { assembleHousingFeatures, createHousingFeatureSnapshot, exactCalendarYoY } from '../src/features/housing.js';
import { probabilityHomePricesAbove } from '../src/models/housing-v0.js';

function observation({ provider, sourceId, sourceClass, data, capturedAt = '2026-09-16T18:00:00Z', geography = null }) {
  return createSourceObservation({
    provider,
    sourceId,
    sourceClass,
    observedAt: capturedAt,
    availableAt: capturedAt,
    capturedAt,
    data,
    geography
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

test('housing assembler separates PropData state signal from official FHFA signal', () => {
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
          sale_to_list_ratio: 99.2
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
        macro: { mortgage_rate_30yr: 6.22 }
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

test('FHFA fallback value is not promoted to an observed official price signal', () => {
  const observations = [
    observation({
      provider: 'PropData',
      sourceId: 'state-intel:MN',
      sourceClass: 'propdata',
      data: { market: { yoy_appreciation: 3.1 } }
    }),
    observation({
      provider: 'PropData',
      sourceId: 'market:state:MN',
      sourceClass: 'propdata',
      data: {
        market: { appreciation: { yoy_appreciation_pct: 2.5, source: 'fhfa_state_reference_fallback' } },
        macro: { mortgage_rate_30yr: 6.1 },
        rent: { history: [] }
      }
    })
  ];

  const assembled = assembleHousingFeatures(observations);
  assert.equal(assembled.features.propdataPriceYoY, 3.1);
  assert.equal(assembled.features.fhfaHpiYoY, null);
  assert.equal(assembled.quality.fhfaSignalAvailable, false);
});
