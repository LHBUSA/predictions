import test from 'node:test';
import assert from 'node:assert/strict';
import { probabilityAboveInflationThreshold } from '../src/models/inflation-v0.js';
import { probabilityPayrollsAbove, probabilityUnemploymentAbove } from '../src/models/employment-v0.js';

test('inflation model probability rises when headline/core inflation are further above threshold', () => {
  const lower = probabilityAboveInflationThreshold({
    headlineYoY: 2.8, coreYoY: 3.0, headlineMoM: 0.2, coreMoM: 0.2, priorHeadlineYoY: 2.8
  }, 3.0);
  const higher = probabilityAboveInflationThreshold({
    headlineYoY: 3.3, coreYoY: 3.5, headlineMoM: 0.4, coreMoM: 0.4, priorHeadlineYoY: 3.1
  }, 3.0);
  assert.ok(higher.probability > lower.probability);
});

test('unemployment-above probability rises with unemployment and claims pressure', () => {
  const cooler = probabilityUnemploymentAbove({
    unemploymentRate: 4.1, priorUnemploymentRate: 4.1, payrollChangeK: 180, priorPayrollChangeK: 175, initialClaimsK: 220, continuingClaimsM: 1.8
  }, 4.3);
  const weaker = probabilityUnemploymentAbove({
    unemploymentRate: 4.4, priorUnemploymentRate: 4.2, payrollChangeK: 95, priorPayrollChangeK: 180, initialClaimsK: 255, continuingClaimsM: 1.95
  }, 4.3);
  assert.ok(weaker.probability > cooler.probability);
});

test('payrolls-above probability rises with stronger payroll inputs', () => {
  const weak = probabilityPayrollsAbove({
    unemploymentRate: 4.4, priorUnemploymentRate: 4.2, payrollChangeK: 80, priorPayrollChangeK: 160, initialClaimsK: 255, continuingClaimsM: 1.95
  }, 150);
  const strong = probabilityPayrollsAbove({
    unemploymentRate: 4.1, priorUnemploymentRate: 4.1, payrollChangeK: 220, priorPayrollChangeK: 180, initialClaimsK: 215, continuingClaimsM: 1.78
  }, 150);
  assert.ok(strong.probability > weak.probability);
});
