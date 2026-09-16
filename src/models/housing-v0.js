import { probabilityAboveNormal, probabilityBelowNormal, finite } from './probability-utils.js';

export const HOUSING_MODEL = Object.freeze({
  id: 'housing-price-baseline',
  version: '0.1.1',
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

function neutral(value, field, fallback, imputations) {
  if (value === undefined || value === null || value === '') {
    imputations.push(field);
    return fallback;
  }
  return finite(value, field);
}

export function housingFeatures(input) {
  const neutralImputations = [];
  const propdataPriceYoY = optional(input.propdataPriceYoY, 'propdataPriceYoY');
  const fhfaHpiYoY = optional(input.fhfaHpiYoY, 'fhfaHpiYoY');
  const permitsYoY = neutral(input.permitsYoY, 'permitsYoY', 0, neutralImputations);
  const startsYoY = neutral(input.startsYoY, 'startsYoY', 0, neutralImputations);
  const inventoryYoY = neutral(input.inventoryYoY, 'inventoryYoY', 0, neutralImputations);
  const rentYoY = neutral(input.rentYoY, 'rentYoY', 0, neutralImputations);
  const mortgage30 = neutral(input.mortgage30, 'mortgage30', 6.5, neutralImputations);
  const priorMortgage30 = neutral(input.priorMortgage30, 'priorMortgage30', mortgage30, neutralImputations);
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
    neutralImputations: Object.freeze(neutralImputations),
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

function explanationFor(dist, threshold) {
  return Object.freeze({
    threshold,
    basePriceYoY: dist.features.basePriceYoY,
    propdataUsed: dist.features.sourceParticipation.propdata,
    fhfaUsed: dist.features.sourceParticipation.fhfa,
    inventoryYoY: dist.features.inventoryYoY,
    mortgageMomentum: dist.features.mortgageMomentum,
    neutralImputations: dist.features.neutralImputations,
    note: dist.features.neutralImputations.length
      ? 'Research baseline. Missing secondary signals were neutral-imputed and are disclosed explicitly; no observation was fabricated.'
      : 'Research baseline. All configured secondary signals were supplied.'
  });
}

export function probabilityHomePricesAbove(features, threshold, config = {}) {
  const dist = housingPriceDistribution(features, config);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityAboveNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: explanationFor(dist, target)
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
    explanation: explanationFor(dist, target)
  });
}
