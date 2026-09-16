import { probabilityAboveNormal, probabilityBelowNormal, finite } from './probability-utils.js';

export const HOUSING_MODEL = Object.freeze({
  id: 'housing-price-baseline',
  version: '0.1.0',
  status: 'research'
});

function optional(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return finite(value, field);
}

function weighted(values) {
  const present = values.filter(x => x.value !== null);
  if (!present.length) throw new TypeError('at least one home-price signal is required');
  const weight = present.reduce((sum, x) => sum + x.weight, 0);
  return present.reduce((sum, x) => sum + x.value * x.weight, 0) / weight;
}

export function housingFeatures(input) {
  const propdataPriceYoY = optional(input.propdataPriceYoY, 'propdataPriceYoY');
  const fhfaHpiYoY = optional(input.fhfaHpiYoY, 'fhfaHpiYoY');
  const permitsYoY = finite(input.permitsYoY ?? 0, 'permitsYoY');
  const startsYoY = finite(input.startsYoY ?? 0, 'startsYoY');
  const inventoryYoY = finite(input.inventoryYoY ?? 0, 'inventoryYoY');
  const rentYoY = finite(input.rentYoY ?? 0, 'rentYoY');
  const mortgage30 = finite(input.mortgage30 ?? 6.5, 'mortgage30');
  const priorMortgage30 = finite(input.priorMortgage30 ?? mortgage30, 'priorMortgage30');
  const basePriceYoY = weighted([
    { value: propdataPriceYoY, weight: 0.58 },
    { value: fhfaHpiYoY, weight: 0.42 }
  ]);

  return Object.freeze({
    propdataPriceYoY,
    fhfaHpiYoY,
    basePriceYoY,
    permitsYoY,
    startsYoY,
    inventoryYoY,
    rentYoY,
    mortgage30,
    priorMortgage30,
    mortgageMomentum: mortgage30 - priorMortgage30,
    sourceParticipation: Object.freeze({
      propdata: propdataPriceYoY !== null,
      fhfa: fhfaHpiYoY !== null
    })
  });
}

export function housingPriceDistribution(features, config = {}) {
  const f = housingFeatures(features);
  const mean =
    f.basePriceYoY +
    0.035 * f.rentYoY -
    0.025 * f.inventoryYoY -
    0.012 * f.permitsYoY -
    0.008 * f.startsYoY -
    0.85 * f.mortgageMomentum;
  const sigma = finite(config.sigma ?? (f.sourceParticipation.propdata && f.sourceParticipation.fhfa ? 1.35 : 1.75), 'sigma');
  return Object.freeze({ mean, sigma, features: f });
}

export function probabilityHomePricesAbove(features, threshold, config = {}) {
  const dist = housingPriceDistribution(features, config);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityAboveNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: Object.freeze({
      threshold: target,
      basePriceYoY: dist.features.basePriceYoY,
      propdataUsed: dist.features.sourceParticipation.propdata,
      fhfaUsed: dist.features.sourceParticipation.fhfa,
      inventoryYoY: dist.features.inventoryYoY,
      mortgageMomentum: dist.features.mortgageMomentum,
      note: 'Research baseline. PropData contributes only when an explicit PropData-derived feature is supplied and disclosed in provenance.'
    })
  });
}

export function probabilityHomePricesBelow(features, threshold, config = {}) {
  const dist = housingPriceDistribution(features, config);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityBelowNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: Object.freeze({
      threshold: target,
      basePriceYoY: dist.features.basePriceYoY,
      propdataUsed: dist.features.sourceParticipation.propdata,
      fhfaUsed: dist.features.sourceParticipation.fhfa,
      inventoryYoY: dist.features.inventoryYoY,
      mortgageMomentum: dist.features.mortgageMomentum,
      note: 'Research baseline. PropData contributes only when an explicit PropData-derived feature is supplied and disclosed in provenance.'
    })
  });
}
