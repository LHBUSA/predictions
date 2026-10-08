// Contract normalization: model the CONTRACT, not the headline. Every venue market becomes either a
// NORMALIZED contract (exact station, window, authority, comparator, threshold) or a fail-closed record
// with a machine-readable reason. Nothing is guessed: any disagreement between the rules text and the
// venue's structured fields is HOLD_RESOLUTION_AMBIGUOUS.
import { categorizeContract, commercialSettlementSource } from './classify.js';
import { normalizeRates } from '../rates/rates-contract.js';
import { cliStation } from '../weather/stations.js';
import { cliWindow } from '../weather/time.js';
import { normalizeFed } from '../macro/fed-contract.js';
import { normalizeCpi } from '../macro/cpi/cpi-contract.js';

export const NORMALIZER_VERSION = 'contract-norm/1';

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const TICKER_MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseRulesDate(text) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(String(text).trim());
  if (!m || !MONTHS[m[1]]) return null;
  return `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`;
}

// KXRAIN-26OCT04 / KXHIGHNY-26OCT04-B63.5 -> 2026-10-04
export function parseEventTickerDate(eventTicker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})(?:-|$)/.exec(String(eventTicker));
  if (!m || !TICKER_MONTHS[m[2]]) return null;
  return `20${m[1]}-${TICKER_MONTHS[m[2]]}-${m[3]}`;
}

function base({ series, event, market, domain, normalizedAt }) {
  return {
    venue: 'kalshi',
    market_id: market.ticker,
    venue_event_id: market.event_ticker || event?.event_ticker || null,
    venue_series_id: series?.ticker || event?.series_ticker || null,
    normalizer_version: NORMALIZER_VERSION,
    rules_primary: market.rules_primary ?? null,
    rules_secondary: market.rules_secondary ?? null,
    domain,
    outcome_label: market.yes_sub_title ?? null,
    close_time: market.close_time ?? null,
    expected_settlement_time: market.expected_expiration_time ?? null,
    normalized_at: normalizedAt,
  };
}

function fail(status, reason, ctx, extra = {}) {
  return { ...base(ctx), normalization_status: status, status_reason: reason, exceptions: [], detail: extra };
}

const TWC_AUTHORITY = 'The Weather Company (weather.com/kalshi)';

function stationLocation(st) {
  return { name: st.name, icao: st.icao, wfo: st.wfo, lat: st.lat, lon: st.lon, ghcn: st.ghcn, elevation_m: st.elevationM };
}

// ---------------------------------------------------------------------------------- weather: rain
const RAIN_RE = /^If the total precipitation at (CLI[A-Z]{3}) in (.+?) in ([A-Z][a-z]{2} \d{1,2}, \d{4}) is strictly greater than 0 inches, then the market resolves to Yes\.$/;

function normalizeRain(ctx) {
  const { market } = ctx;
  const m = RAIN_RE.exec(String(market.rules_primary || '').trim());
  if (!m) return null;
  const [, cli, cityName, dateText] = m;
  const secondary = String(market.rules_secondary || '');
  if (!/Weather Company/i.test(secondary) || !/Trace.{0,3} amounts \(T\) and missing daily precipitation values are counted as 0 inches/i.test(secondary)) {
    return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RAIN_SECONDARY_RULES_CHANGED', ctx, { cli });
  }
  if (market.strike_type !== 'greater' || Number(market.floor_strike) !== 0) {
    return fail('HOLD_RESOLUTION_AMBIGUOUS', 'STRIKE_FIELDS_DISAGREE_WITH_RULES', ctx, { cli, strike_type: market.strike_type, floor: market.floor_strike });
  }
  const date = parseRulesDate(dateText);
  if (!date || date !== parseEventTickerDate(market.event_ticker)) {
    return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_DATE_DISAGREES_WITH_TICKER', ctx, { cli, rules_date: date, ticker: market.event_ticker });
  }
  const st = cliStation(cli);
  if (!st) return fail('UNMODELABLE', 'STATION_NOT_IN_CLI_REGISTRY', ctx, { cli });
  const win = cliWindow(date, st);
  return {
    ...base(ctx),
    normalization_status: 'NORMALIZED',
    status_reason: null,
    event_type: 'PRECIP_ANY',
    subject: `Daily precipitation at ${cli} (${cityName})`,
    comparator: '>',
    threshold_low: 0,
    threshold_high: null,
    units: 'in',
    location: stationLocation(st),
    station_id: cli,
    station_source: 'IEM NWSCLI registry (NWS climate site)',
    observation_start: win.start,
    observation_end: win.end,
    timezone: st.tz,
    resolution_authority: TWC_AUTHORITY,
    resolution_dataset: `The Weather Company daily precipitation for ${cli} (weather.com/kalshi)`,
    verification_dataset: `NWS Daily Climate Report ${cli} (WFO ${st.wfo}); NOAA RCC-ACIS ${st.ghcn}`,
    measurement_definition: `Total liquid-equivalent precipitation for the climate day ${date}, ${win.definition}`,
    rounding_rule: 'Hundredths of an inch; trace (T) counts as 0.00',
    exceptions: [
      'Missing daily precipitation value counts as 0 inches (resolves NO)',
      'Preliminary data may be revised; the exchange may hold expiration until a non-erroneous revision, else last fair price',
      `Venue event strike_date (${ctx.event?.strike_date || 'n/a'}) is not the climate-day boundary; the reported daily value governs`,
    ],
    yes_condition: `Reported ${date} total precipitation at ${cli} > 0.00 in`,
    no_condition: `Reported total = 0.00 in, trace, or missing`,
    detail: { city_label: cityName, climate_date: date, window_definition: win.definition, lst_offset_hours: st.lstOffsetHours },
  };
}

// ---------------------------------------------------------------------------------- weather: daily high
const HIGH_RE = /^If the maximum temperature recorded at (.+?) \((CLI[A-Z]{3})\) for ([A-Z][a-z]{2} \d{1,2}, \d{4}), is (less than (\d+)|greater than (\d+)|between (\d+)-(\d+))° fahrenheit according to The Weather Company, then the market resolves to Yes\.?$/;

function normalizeHigh(ctx) {
  const { market } = ctx;
  const m = HIGH_RE.exec(String(market.rules_primary || '').trim());
  if (!m) return null;
  const [, cityName, cli, dateText, , lessC, greaterF, betweenF, betweenC] = m;
  let comparator; let low = null; let high = null;
  if (lessC) { comparator = 'less'; high = Number(lessC); }
  else if (greaterF) { comparator = 'greater'; low = Number(greaterF); }
  else { comparator = 'between'; low = Number(betweenF); high = Number(betweenC); }
  const strikeOk = market.strike_type === comparator
    && (comparator === 'less' ? Number(market.cap_strike) === high
      : comparator === 'greater' ? Number(market.floor_strike) === low
        : Number(market.floor_strike) === low && Number(market.cap_strike) === high);
  if (!strikeOk) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'STRIKE_FIELDS_DISAGREE_WITH_RULES', ctx, { cli, comparator, low, high, strike_type: market.strike_type, floor: market.floor_strike, cap: market.cap_strike });
  if (!/Weather Company/i.test(String(market.rules_secondary || ''))) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'HIGH_SECONDARY_RULES_CHANGED', ctx, { cli });
  const date = parseRulesDate(dateText);
  if (!date || date !== parseEventTickerDate(market.event_ticker)) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_DATE_DISAGREES_WITH_TICKER', ctx, { cli, rules_date: date });
  const st = cliStation(cli);
  if (!st) return fail('UNMODELABLE', 'STATION_NOT_IN_CLI_REGISTRY', ctx, { cli });
  const win = cliWindow(date, st);
  const yes = comparator === 'less' ? `reported max <= ${high - 1}°F` : comparator === 'greater' ? `reported max >= ${low + 1}°F` : `${low}°F <= reported max <= ${high}°F`;
  return {
    ...base(ctx),
    normalization_status: 'NORMALIZED',
    status_reason: null,
    event_type: 'MAX_TEMP_BUCKET',
    subject: `Daily maximum temperature at ${cli} (${cityName})`,
    comparator,
    threshold_low: low,
    threshold_high: high,
    units: 'degF',
    location: stationLocation(st),
    station_id: cli,
    station_source: 'IEM NWSCLI registry (NWS climate site)',
    observation_start: win.start,
    observation_end: win.end,
    timezone: st.tz,
    resolution_authority: TWC_AUTHORITY,
    resolution_dataset: `The Weather Company daily maximum temperature for ${cli} (weather.com/kalshi)`,
    verification_dataset: `NWS Daily Climate Report ${cli} (WFO ${st.wfo}); NOAA RCC-ACIS ${st.ghcn}`,
    measurement_definition: `Maximum temperature for the climate day ${date}, ${win.definition}`,
    rounding_rule: 'Whole degrees Fahrenheit as reported; preliminary values may differ by rounding/conversion',
    exceptions: ['Preliminary data may be revised; the exchange may hold expiration until a non-erroneous revision, else last fair price'],
    yes_condition: yes,
    no_condition: `otherwise`,
    detail: { city_label: cityName, climate_date: date, window_definition: win.definition, lst_offset_hours: st.lstOffsetHours },
  };
}

const WEATHER_NORMALIZERS = [normalizeRain, normalizeHigh];

function macroFed(ctx) {
  const r = normalizeFed(ctx);
  if (!r) return null;
  if (r.__fail) return fail(r.status, r.reason, ctx, r.extra);
  return { ...base(ctx), ...r };
}

// CPI V1 (KXCPI / KXCPIYOY / KXCPICOREYOY; KXCPICORE monitoring): normalized by the CPI SHADOW lane only.
function macroCpi(ctx) {
  const r = normalizeCpi(ctx);
  if (!r) return null;
  if (r.__fail) return fail(r.status, r.reason, ctx, r.extra);
  return { ...base(ctx), ...r };
}

function ratesPath(ctx) {
  const r = normalizeRates(ctx);
  if (!r) return null;
  if (r.__fail) return fail(r.status, r.reason, ctx, r.extra);
  return { ...base(ctx), ...r };
}

// Normalizers by product category. Each returns null when its template does not match.
const CATEGORY_NORMALIZERS = { WEATHER: WEATHER_NORMALIZERS, MACRO: [macroFed, macroCpi], RATES: [ratesPath] };

export function registerNormalizer(category, fn) {
  if (!CATEGORY_NORMALIZERS[category]) CATEGORY_NORMALIZERS[category] = [];
  CATEGORY_NORMALIZERS[category].push(fn);
}

export async function normalizeContract({ series = null, event = null, market }, { now = new Date().toISOString() } = {}) {
  if (!market?.ticker) throw new TypeError('market.ticker is required');
  const { domain, category } = categorizeContract({ series: series || {}, event: event || {}, market });
  const ctx = { series, event, market, domain, category, normalizedAt: now };
  let out = null;
  const commercial = commercialSettlementSource(series);
  if (commercial) {
    out = fail('UNMODELABLE', 'COMMERCIAL_SETTLEMENT_SOURCE', ctx, { settlement_source: commercial, category });
  } else if (!CATEGORY_NORMALIZERS[category]?.length) {
    out = fail('UNSUPPORTED_DOMAIN', 'MODEL_NOT_YET_ENABLED', ctx, { category });
  } else {
    for (const fn of CATEGORY_NORMALIZERS[category]) {
      out = fn(ctx);
      if (out) break;
    }
    if (!out) out = fail('UNMODELABLE', `NO_${domain}_CONTRACT_TEMPLATE`, ctx, { category });
  }
  const rulesSha = await sha256Hex(`${market.rules_primary || ''}\n---\n${market.rules_secondary || ''}`);
  return Object.freeze({ ...out, category, rules_sha256: rulesSha, contract_id: `kalshi:${market.ticker}:${NORMALIZER_VERSION}:${rulesSha.slice(0, 12)}` });
}
