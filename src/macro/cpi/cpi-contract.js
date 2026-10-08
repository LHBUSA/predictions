// Kalshi CPI contract normalizer (engine contract-norm/1 MACRO template). Terms only: series, reference month,
// strike, comparator, authority. Fails closed (HOLD_RESOLUTION_AMBIGUOUS) whenever the rules text, the ticker and the
// structured strike fields disagree. Prices never pass through here.
//
// Verified rules wording 2026-10-07 (all four families are strike_type "greater": YES iff published value > strike):
//   KXCPI         "...Consumer Price Index (CPI) increases by more than X% (single-decimal) in <Month YYYY>..."
//   KXCPIYOY      "...Consumer Price Index (CPI) increases by more than X% in the twelve months ending <Month YYYY>..."
//   KXCPICOREYOY  "...All Items less Food and Energy increases by more than X% in the twelve months ending <Month YYYY>..."
//   KXCPICORE     "...seasonally adjusted ... All Items less Food and Energy for <Month YYYY> ... increases by above X%..."
import { KALSHI_SERIES_TARGET, parseKalshiTicker, translateKalshiMarket } from './contracts.js';
import { releaseFor } from './calendar.js';
import { etToUtcIso } from './timeline.js';

export const CPI_EVENT_TYPE = 'CPI_PRINT_THRESHOLD';

const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const MONTH_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})\b/;
const STRIKE_RE = /increases by (?:more than|above) (-?\d+(?:\.\d+)?)%/;

const FAMILY = Object.freeze({
  KXCPI: { core: false, yoy: false, subject: 'CPI-U all items, seasonally adjusted 1-month % change', field: 'Table A, All items, seasonally adjusted change from the previous month' },
  KXCPICORE: { core: true, yoy: false, subject: 'CPI-U all items less food and energy, seasonally adjusted 1-month % change', field: 'Table A, All items less food and energy, seasonally adjusted change from the previous month' },
  KXCPIYOY: { core: false, yoy: true, subject: 'CPI-U all items, unadjusted 12-month % change', field: 'Table A, All items, unadjusted 12-month change' },
  KXCPICOREYOY: { core: true, yoy: true, subject: 'CPI-U all items less food and energy, unadjusted 12-month % change', field: 'Table A, All items less food and energy, unadjusted 12-month change' }
});

const fail = (status, reason, extra = {}) => ({ __fail: true, status, reason, extra });

export function normalizeCpi(ctx) {
  const { market } = ctx;
  const parsed = parseKalshiTicker(market?.ticker);
  if (!parsed) return null;
  const fam = FAMILY[parsed.series];
  const rules = String(market.rules_primary || '').trim();
  const secondary = String(market.rules_secondary || '');
  if (!/then the market resolves to Yes\.?$/.test(rules)) return fail('UNMODELABLE', 'NO_CPI_CONTRACT_TEMPLATE', { series: parsed.series });
  const isCore = /less Food and Energy/i.test(rules);
  const isYoy = /twelve months ending/i.test(rules);
  if (isCore !== fam.core || isYoy !== fam.yoy) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_DISAGREE_WITH_SERIES', { series: parsed.series, core: isCore, yoy: isYoy });
  if (parsed.series === 'KXCPICORE' && !/seasonally adjusted/i.test(rules)) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_MISSING_SEASONAL_ADJUSTMENT', { series: parsed.series });
  const mm = MONTH_RE.exec(rules);
  const ruleMonth = mm ? `${mm[2]}-${String(MONTHS[mm[1]]).padStart(2, '0')}` : null;
  if (ruleMonth !== parsed.referenceMonth) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_MONTH_DISAGREES_WITH_TICKER', { rules_month: ruleMonth, ticker_month: parsed.referenceMonth });
  const sm = STRIKE_RE.exec(rules);
  if (!sm) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_STRIKE_UNPARSEABLE', { series: parsed.series });
  if (market.strike_type !== 'greater') return fail('HOLD_RESOLUTION_AMBIGUOUS', 'STRIKE_TYPE_NOT_GREATER', { strike_type: market.strike_type ?? null });
  const strike = Number(sm[1]);
  if (Number(market.floor_strike) !== strike) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'STRIKE_FIELDS_DISAGREE_WITH_RULES', { rules_strike: strike, floor_strike: market.floor_strike ?? null });
  const t = translateKalshiMarket(market);
  if (t.status !== 'SUPPORTED' || t.event.kind !== 'above' || t.event.threshold !== strike) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'STRIKE_NOT_ON_ONE_DECIMAL_GRID', { strike });
  const release = releaseFor(parsed.referenceMonth);
  const [y, m] = parsed.referenceMonth.split('-');
  const start = etToUtcIso(`${y}-${m}-01`, 0, 0);
  const end = release ? release.releaseAt : (market.close_time ? new Date(Date.parse(market.close_time) + 5 * 60000).toISOString() : null);
  const exceptions = ['Kalshi closes the market shortly before the scheduled 08:30 ET release'];
  if (/shutdown/i.test(secondary)) exceptions.push('A data delay from a federal government shutdown extends expiration to the sooner of the release or six months after the shutdown ends');
  if (!release) exceptions.push('Reference month not in the CPI V1 calendar: observation_end is the market close + 5 min until the BLS schedule is added');
  return {
    normalization_status: 'NORMALIZED',
    status_reason: null,
    event_type: CPI_EVENT_TYPE,
    subject: `${fam.subject}, ${parsed.referenceMonth} (BLS, one decimal)`,
    comparator: 'greater',
    threshold_low: strike,
    threshold_high: null,
    units: 'pct',
    location: { country: 'US' },
    station_id: null,
    station_source: null,
    observation_start: start,
    observation_end: end,
    timezone: 'America/New_York',
    resolution_authority: 'U.S. Bureau of Labor Statistics (CPI news release)',
    resolution_dataset: `BLS CPI news release for ${parsed.referenceMonth}: ${fam.field}`,
    verification_dataset: 'BLS release first paragraph (headline); Kalshi expiration value',
    measurement_definition: `${fam.subject} for ${parsed.referenceMonth} as first published by BLS`,
    rounding_rule: 'One decimal place as published by BLS',
    exceptions,
    yes_condition: `published value > ${strike.toFixed(1)}%`,
    no_condition: `published value <= ${strike.toFixed(1)}%`,
    detail: { reference_month: parsed.referenceMonth, cpi_target: KALSHI_SERIES_TARGET[parsed.series], kalshi_series: parsed.series, strike, release_date: release?.releaseDate ?? null }
  };
}
