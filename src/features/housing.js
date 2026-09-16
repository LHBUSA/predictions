import { createFeatureSnapshot } from '../feature-snapshot.js';
import { HOUSING_MODEL } from '../models/housing-v0.js';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sourceUsable(source) {
  if (!source) return false;
  return !/(fallback|unavailable|error)/i.test(String(source));
}

function observationFor(observations, provider, sourcePrefix) {
  return observations.find((observation) =>
    observation?.provider === provider && String(observation?.sourceId || '').startsWith(sourcePrefix)
  ) || null;
}

function monthKey(value) {
  const match = /^(\d{4})-(\d{2})/.exec(String(value || ''));
  return match ? `${match[1]}-${match[2]}` : null;
}

function previousYearMonth(key) {
  if (!key) return null;
  const [year, month] = key.split('-');
  return `${Number(year) - 1}-${month}`;
}

function rentValue(row) {
  return numberOrNull(row?.rent ?? row?.zori ?? row?.median_rent ?? row?.value);
}

export function exactCalendarYoY(history = []) {
  const rows = Array.isArray(history)
    ? history.map((row) => ({ key: monthKey(row?.date || row?.period || row?.month), value: rentValue(row) }))
      .filter((row) => row.key && row.value !== null)
    : [];
  if (!rows.length) return null;
  rows.sort((a, b) => b.key.localeCompare(a.key));
  const latest = rows[0];
  const prior = rows.find((row) => row.key === previousYearMonth(latest.key));
  if (!prior || prior.value === 0) return null;
  return ((latest.value - prior.value) / prior.value) * 100;
}

export function assembleHousingFeatures(observations = []) {
  const marketObservation = observationFor(observations, 'PropData', 'market:');
  const stateObservation = observationFor(observations, 'PropData', 'state-intel:');
  const censusObservation = observations.find((observation) => observation?.provider === 'PropTechUSA Census Intelligence') || null;

  const market = marketObservation?.data || {};
  const stateIntel = stateObservation?.data || {};
  const census = censusObservation?.data || {};

  const propdataPriceYoY = numberOrNull(stateIntel?.market?.yoy_appreciation);
  const fhfaSource = market?.market?.appreciation?.source || market?.data_sources?.fhfa || null;
  const fhfaHpiYoY = sourceUsable(fhfaSource)
    ? numberOrNull(market?.market?.appreciation?.yoy_appreciation_pct)
    : null;
  const mortgage30 = numberOrNull(market?.macro?.mortgage_rate_30yr);
  const rentYoY = exactCalendarYoY(market?.rent?.history || []);

  const features = {
    propdataPriceYoY,
    fhfaHpiYoY,
    permitsYoY: null,
    startsYoY: null,
    inventoryYoY: null,
    rentYoY,
    mortgage30,
    priorMortgage30: null
  };

  const neutralImputations = [];
  for (const key of ['permitsYoY', 'startsYoY', 'inventoryYoY']) {
    if (features[key] === null) neutralImputations.push(key);
  }
  if (features.rentYoY === null) neutralImputations.push('rentYoY');
  if (features.mortgage30 === null) neutralImputations.push('mortgage30');
  if (features.priorMortgage30 === null) neutralImputations.push('priorMortgage30');

  const context = {
    propdataStateSignal: stateIntel?.signal || null,
    sellerFrictionScore: numberOrNull(stateIntel?.market?.friction_score),
    daysOnMarket: numberOrNull(stateIntel?.market?.days_on_market),
    priceCutsPct: numberOrNull(stateIntel?.market?.price_cuts_pct),
    monthsSupply: numberOrNull(stateIntel?.market?.months_supply),
    saleToListRatio: numberOrNull(stateIntel?.market?.sale_to_list_ratio),
    medianHomeValue: numberOrNull(market?.snapshot?.median_home_value),
    affordabilityScore: numberOrNull(market?.snapshot?.affordability_score),
    censusVacancyRate: numberOrNull(census?.housing?.vacancy_rate_pct ?? census?.housing?.vacancy_rate),
    censusOwnerOccupiedPct: numberOrNull(census?.housing?.owner_occupied_pct),
    censusMedianIncome: numberOrNull(census?.income?.median_household_income),
    censusPopulation: numberOrNull(census?.demographics?.total_population)
  };

  return Object.freeze({
    features: Object.freeze(features),
    context: Object.freeze(context),
    quality: Object.freeze({
      propdataStateSignalAvailable: propdataPriceYoY !== null,
      fhfaSignalAvailable: fhfaHpiYoY !== null,
      fhfaSource,
      censusContextAvailable: Boolean(censusObservation),
      neutralImputations: Object.freeze(neutralImputations),
      note: 'Null fast-moving features are explicitly recorded and may be neutral-imputed by the research baseline. They are not fabricated observations.'
    })
  });
}

export function createHousingFeatureSnapshot({ id, eventId, cutoffAt, observations = [], createdAt } = {}) {
  const assembled = assembleHousingFeatures(observations);
  const snapshot = createFeatureSnapshot({
    id,
    eventId,
    modelId: HOUSING_MODEL.id,
    cutoffAt,
    createdAt,
    features: assembled.features,
    observations
  });
  return Object.freeze({ snapshot, context: assembled.context, quality: assembled.quality });
}
