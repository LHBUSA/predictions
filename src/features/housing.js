import { createFeatureSnapshot } from '../feature-snapshot.js';
import { HOUSING_MODEL } from '../models/housing-v0.js';

const DEFAULT_STATE_SIGNAL_MAX_AGE_DAYS = 180;

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

function hpiObservationFor(observations) {
  return observations.find((observation) =>
    observation?.provider === 'Federal Housing Finance Agency' &&
    String(observation?.sourceId || '').startsWith('fhfa-hpi:')
  ) || null;
}

function mortgageObservationFor(observations) {
  return observations.find((observation) =>
    observation?.provider === 'FRED' && observation?.sourceId === 'MORTGAGE30US'
  ) || null;
}

function zoriObservationFor(observations) {
  return observations.find((observation) =>
    observation?.provider === 'Zillow Research' && String(observation?.sourceId || '').startsWith('zori:')
  ) || null;
}

function permitsObservationFor(observations) {
  return observations.find((observation) =>
    observation?.provider === 'U.S. Census Bureau' && String(observation?.sourceId || '').startsWith('census-bps:')
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

function ageDays(asOf, cutoffAt) {
  if (!asOf || !cutoffAt) return null;
  const asOfMs = Date.parse(asOf);
  const cutoffMs = Date.parse(cutoffAt);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(cutoffMs)) return null;
  return Math.max(0, (cutoffMs - asOfMs) / 86400000);
}

function stateSignalStatus(stateIntel, cutoffAt, maxAgeDays) {
  const asOf = stateIntel?.market?.as_of || null;
  const days = ageDays(asOf, cutoffAt);
  const fresh = days !== null && days <= maxAgeDays;
  return Object.freeze({ asOf, ageDays: days, fresh, maxAgeDays });
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

export function assembleHousingFeatures(observations = [], {
  cutoffAt = null,
  stateSignalMaxAgeDays = DEFAULT_STATE_SIGNAL_MAX_AGE_DAYS
} = {}) {
  const marketObservation = observationFor(observations, 'PropData', 'market:');
  const stateObservation = observationFor(observations, 'PropData', 'state-intel:');
  const retainedHpiObservation = hpiObservationFor(observations);
  const retainedMortgageObservation = mortgageObservationFor(observations);
  const retainedZoriObservation = zoriObservationFor(observations);
  const retainedPermitsObservation = permitsObservationFor(observations);
  const censusObservation = observations.find((observation) => observation?.provider === 'PropTechUSA Census Intelligence') || null;

  const market = marketObservation?.data || {};
  const stateIntel = stateObservation?.data || {};
  const retainedHpi = retainedHpiObservation?.data || {};
  const retainedMortgage = retainedMortgageObservation?.data || {};
  const retainedZori = retainedZoriObservation?.data || {};
  const retainedPermits = retainedPermitsObservation?.data || {};
  const census = censusObservation?.data || {};
  const effectiveCutoff = cutoffAt || marketObservation?.capturedAt || stateObservation?.capturedAt || retainedHpiObservation?.capturedAt || retainedMortgageObservation?.capturedAt || retainedZoriObservation?.capturedAt || retainedPermitsObservation?.capturedAt || null;
  const stateSignal = stateSignalStatus(stateIntel, effectiveCutoff, stateSignalMaxAgeDays);

  const rawPropdataPriceYoY = numberOrNull(stateIntel?.market?.yoy_appreciation);
  const propdataPriceYoY = stateSignal.fresh ? rawPropdataPriceYoY : null;

  const retainedHpiYoY = numberOrNull(retainedHpi?.yoyPct);
  const marketFhfaSource = market?.market?.appreciation?.source || market?.data_sources?.fhfa || null;
  const marketFhfaYoY = sourceUsable(marketFhfaSource)
    ? numberOrNull(market?.market?.appreciation?.yoy_appreciation_pct)
    : null;
  const fhfaHpiYoY = retainedHpiYoY ?? marketFhfaYoY;
  const fhfaSource = retainedHpiYoY !== null ? 'retained_hpi_history' : marketFhfaSource;

  const marketMortgageSource = market?.macro?.source || market?.data_sources?.fred || null;
  const rawMarketMortgage30 = numberOrNull(market?.macro?.mortgage_rate_30yr);
  const retainedMortgage30 = numberOrNull(retainedMortgage?.latest?.value ?? retainedMortgageObservation?.value);
  const retainedPriorMortgage30 = numberOrNull(retainedMortgage?.previous?.value);
  const mortgage30 = retainedMortgage30 ?? (sourceUsable(marketMortgageSource) ? rawMarketMortgage30 : null);
  const priorMortgage30 = retainedPriorMortgage30;
  const mortgageSource = retainedMortgage30 !== null ? 'FRED:MORTGAGE30US' : marketMortgageSource;

  const directZoriYoY = numberOrNull(retainedZori?.yoyPct);
  const marketRentYoY = exactCalendarYoY(market?.rent?.history || []);
  const rentYoY = directZoriYoY ?? marketRentYoY;
  const rentSource = directZoriYoY !== null ? 'Zillow Research ZORI' : (market?.rent?.source || null);

  const permitsYoY = numberOrNull(retainedPermits?.yoyPct);

  const features = {
    propdataPriceYoY,
    fhfaHpiYoY,
    permitsYoY,
    startsYoY: null,
    inventoryYoY: null,
    rentYoY,
    mortgage30,
    priorMortgage30
  };

  const neutralImputations = [];
  for (const key of ['permitsYoY', 'startsYoY', 'inventoryYoY']) {
    if (features[key] === null) neutralImputations.push(key);
  }
  if (features.rentYoY === null) neutralImputations.push('rentYoY');
  if (features.mortgage30 === null) neutralImputations.push('mortgage30');
  if (features.priorMortgage30 === null) neutralImputations.push('priorMortgage30');
  if (rawPropdataPriceYoY !== null && !stateSignal.fresh) neutralImputations.push('propdataPriceYoY_stale');
  if (retainedMortgage30 === null && rawMarketMortgage30 !== null && !sourceUsable(marketMortgageSource)) neutralImputations.push('mortgage30_fallback');

  const context = {
    propdataStateSignal: stateIntel?.signal || null,
    propdataStateSignalAsOf: stateSignal.asOf,
    propdataStateSignalAgeDays: stateSignal.ageDays,
    propdataStateSignalFresh: stateSignal.fresh,
    sellerFrictionScore: numberOrNull(stateIntel?.market?.friction_score),
    daysOnMarket: numberOrNull(stateIntel?.market?.days_on_market),
    priceCutsPct: numberOrNull(stateIntel?.market?.price_cuts_pct),
    monthsSupply: numberOrNull(stateIntel?.market?.months_supply),
    saleToListRatio: numberOrNull(stateIntel?.market?.sale_to_list_ratio),
    medianHomeValue: numberOrNull(market?.snapshot?.median_home_value),
    affordabilityScore: numberOrNull(market?.snapshot?.affordability_score),
    retainedHpiVintage: retainedHpiObservation?.vintage || null,
    retainedHpiCapturedAt: retainedHpiObservation?.capturedAt || null,
    retainedHpiReplaySafeBeforeCapture: retainedHpiObservation?.provenance?.pointInTimeReplaySafeBeforeRetrievedAt !== false,
    mortgageSource,
    mortgageRateContext: rawMarketMortgage30,
    retainedMortgageCapturedAt: retainedMortgageObservation?.capturedAt || null,
    retainedMortgageObservedAt: retainedMortgageObservation?.observedAt || null,
    retainedMortgageLatestDate: retainedMortgage?.latest?.date || null,
    retainedMortgagePreviousDate: retainedMortgage?.previous?.date || null,
    rentSource,
    retainedZoriVintage: retainedZoriObservation?.vintage || null,
    retainedZoriCapturedAt: retainedZoriObservation?.capturedAt || null,
    permitsVintage: retainedPermitsObservation?.vintage || null,
    permitsCapturedAt: retainedPermitsObservation?.capturedAt || null,
    permitsCurrent: numberOrNull(retainedPermits?.value ?? retainedPermitsObservation?.value),
    permitsYearAgo: numberOrNull(retainedPermits?.yearAgo),
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
      propdataStateSignalRawAvailable: rawPropdataPriceYoY !== null,
      propdataStateSignalFresh: stateSignal.fresh,
      propdataStateSignalAsOf: stateSignal.asOf,
      propdataStateSignalAgeDays: stateSignal.ageDays,
      propdataStateSignalMaxAgeDays: stateSignal.maxAgeDays,
      fhfaSignalAvailable: fhfaHpiYoY !== null,
      fhfaSource,
      retainedHpiAvailable: retainedHpiYoY !== null,
      retainedHpiPointInTimeReplaySafeBeforeCapture: retainedHpiObservation?.provenance?.pointInTimeReplaySafeBeforeRetrievedAt !== false,
      mortgageSignalAvailable: mortgage30 !== null,
      mortgageMomentumAvailable: mortgage30 !== null && priorMortgage30 !== null,
      mortgageSource,
      retainedMortgageAvailable: retainedMortgage30 !== null,
      mortgageFallbackRejected: retainedMortgage30 === null && rawMarketMortgage30 !== null && !sourceUsable(marketMortgageSource),
      rentSignalAvailable: rentYoY !== null,
      retainedZoriAvailable: directZoriYoY !== null,
      rentSource,
      permitsSignalAvailable: permitsYoY !== null,
      retainedPermitsAvailable: permitsYoY !== null,
      startsSignalAvailable: false,
      censusContextAvailable: Boolean(censusObservation),
      neutralImputations: Object.freeze(neutralImputations),
      note: 'Retained HPI, official FRED mortgage observations, direct Zillow ZORI, and official Census BPS permit observations are preferred over transient fallbacks. Building permits are not treated as housing starts. Missing fast-moving features remain explicit nulls/neutral imputations.'
    })
  });
}

export function createHousingFeatureSnapshot({ id, eventId, cutoffAt, observations = [], createdAt } = {}) {
  const assembled = assembleHousingFeatures(observations, { cutoffAt });
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

export { DEFAULT_STATE_SIGNAL_MAX_AGE_DAYS };
