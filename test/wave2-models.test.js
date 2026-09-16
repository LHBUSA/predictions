import test from 'node:test';
import assert from 'node:assert/strict';
import { probabilityGdpAbove } from '../src/models/gdp-v0.js';
import { probabilityMortgageAbove } from '../src/models/mortgage-v0.js';
import { probabilityHomePricesAbove, housingFeatures } from '../src/models/housing-v0.js';
import { assertAvailableBefore, createSourceObservation } from '../src/source-observation.js';

test('GDP probability rises with a stronger nowcast', () => {
  const weak = probabilityGdpAbove({ nowcast: 0.8, priorNowcast: 1.0, payrollMomentumK: -40 }, 2.0);
  const strong = probabilityGdpAbove({ nowcast: 3.1, priorNowcast: 2.7, payrollMomentumK: 55 }, 2.0);
  assert.ok(strong.probability > weak.probability);
});

test('mortgage probability above a threshold rises with Treasury and spread pressure', () => {
  const easing = probabilityMortgageAbove({ mortgage30: 6.2, priorMortgage30: 6.35, treasury10: 3.9, priorTreasury10: 4.1, mortgageTreasurySpread: 2.3, priorMortgageTreasurySpread: 2.25 }, 6.5);
  const pressure = probabilityMortgageAbove({ mortgage30: 6.55, priorMortgage30: 6.35, treasury10: 4.25, priorTreasury10: 4.0, mortgageTreasurySpread: 2.3, priorMortgageTreasurySpread: 2.15 }, 6.5);
  assert.ok(pressure.probability > easing.probability);
});

test('housing model discloses PropData participation and responds to stronger price signals', () => {
  const officialOnly = housingFeatures({ fhfaHpiYoY: 2.1, inventoryYoY: 8, mortgage30: 6.5, priorMortgage30: 6.4 });
  assert.equal(officialOnly.sourceParticipation.propdata, false);
  assert.equal(officialOnly.sourceParticipation.fhfa, true);

  const softer = probabilityHomePricesAbove({ propdataPriceYoY: 1.5, fhfaHpiYoY: 1.8, inventoryYoY: 12, mortgage30: 6.7, priorMortgage30: 6.4 }, 2.0);
  const stronger = probabilityHomePricesAbove({ propdataPriceYoY: 4.5, fhfaHpiYoY: 3.4, inventoryYoY: 2, mortgage30: 6.2, priorMortgage30: 6.4 }, 2.0);
  assert.equal(stronger.features.sourceParticipation.propdata, true);
  assert.ok(stronger.probability > softer.probability);
});

test('source observations fail when the data was unavailable at forecast cutoff', () => {
  const observation = createSourceObservation({
    provider: 'BLS',
    sourceId: 'CPI-release',
    sourceClass: 'official',
    observedAt: '2026-09-01T00:00:00Z',
    availableAt: '2026-09-10T12:30:00Z',
    capturedAt: '2026-09-10T12:31:00Z',
    value: 3.1,
    units: 'percent'
  });
  assert.throws(() => assertAvailableBefore(observation, '2026-09-10T12:00:00Z'), /forecast cutoff/);
  assert.equal(assertAvailableBefore(observation, '2026-09-10T13:00:00Z'), observation);
});
