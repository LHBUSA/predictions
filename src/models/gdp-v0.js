import { probabilityAboveNormal, finite } from './probability-utils.js';

export const GDP_MODEL = Object.freeze({
  id: 'gdp-growth-baseline',
  version: '0.1.0',
  status: 'research'
});

export function gdpFeatures(input) {
  const nowcast = finite(input.nowcast ?? input.realGdpAnnualized, 'nowcast');
  const priorNowcast = finite(input.priorNowcast ?? nowcast, 'priorNowcast');
  const payrollMomentum = finite(input.payrollMomentumK ?? 0, 'payrollMomentumK');
  const industrialProductionMomentum = finite(input.industrialProductionMomentum ?? 0, 'industrialProductionMomentum');
  const retailSalesMomentum = finite(input.retailSalesMomentum ?? 0, 'retailSalesMomentum');
  const realIncomeMomentum = finite(input.realIncomeMomentum ?? 0, 'realIncomeMomentum');

  return Object.freeze({
    nowcast,
    priorNowcast,
    nowcastRevision: nowcast - priorNowcast,
    payrollMomentum,
    industrialProductionMomentum,
    retailSalesMomentum,
    realIncomeMomentum
  });
}

export function gdpDistribution(features, config = {}) {
  const f = gdpFeatures(features);
  const mean =
    f.nowcast +
    0.12 * f.nowcastRevision +
    0.0014 * f.payrollMomentum +
    0.22 * f.industrialProductionMomentum +
    0.16 * f.retailSalesMomentum +
    0.14 * f.realIncomeMomentum;
  const sigma = finite(config.sigma ?? 0.85, 'sigma');
  return Object.freeze({ mean, sigma, features: f });
}

export function probabilityGdpAbove(features, threshold, config = {}) {
  const dist = gdpDistribution(features, config);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityAboveNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: Object.freeze({
      threshold: target,
      nowcast: dist.features.nowcast,
      nowcastRevision: dist.features.nowcastRevision,
      note: 'Research baseline; requires point-in-time vintage-safe backtesting before validation.'
    })
  });
}
