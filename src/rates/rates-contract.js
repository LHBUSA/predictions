// Treasury yield path contracts (KX{5,7,10,30}YRDIR{H,L}{M,W}): YES if the Daily Treasury Par Yield Curve Rate for
// the tenor is above (high series) / below (low series) X% on ANY business day in [period start, period end].
// The first published value for each business day governs; intraday values are not considered.

const RE = /^If the daily published par yield for the (\d+)(?:-year|Y) U\.S\. Treasury is (above|below) (\d+(?:\.\d+)?)% on any business day between ([A-Z][a-z]{2} \d{1,2}, \d{4}) and ([A-Z][a-z]{2} \d{1,2}, \d{4}), then the market resolves to Yes\.?$/;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const iso = (t) => { const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(t); return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` : null; };
export const TENORS = Object.freeze({ 5: 'DGS5', 7: 'DGS7', 10: 'DGS10', 30: 'DGS30' });

export function normalizeRates(ctx) {
  const { market } = ctx;
  if (!/^KX(5|7|10|30)YRDIR[HL][MW]-/.test(market.ticker || '')) return null;
  const fail = (status, reason, extra = {}) => ({ __fail: true, status, reason, extra: { ...extra, category: 'RATES' } });
  const m = RE.exec(String(market.rules_primary || '').trim());
  if (!m) return fail('UNMODELABLE', 'NO_RATES_CONTRACT_TEMPLATE');
  const [, tenorText, dir, levelText, startText, endText] = m;
  const tenor = Number(tenorText);
  if (!TENORS[tenor]) return fail('UNMODELABLE', 'TENOR_NOT_SUPPORTED', { tenor });
  const level = Number(levelText);
  const secondary = String(market.rules_secondary || '');
  if (!/Daily Treasury Par Yield Curve Rate/i.test(secondary) || !/intraday values are not considered/i.test(secondary)) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'RATES_SECONDARY_RULES_CHANGED');
  const isHigh = dir === 'above';
  const seriesSays = /YRDIRH/.test(market.ticker) ? 'above' : 'below';
  if (seriesSays !== dir) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'SERIES_DIRECTION_DISAGREES_WITH_RULES');
  const strikeOk = isHigh ? market.strike_type === 'greater' && Number(market.floor_strike) === level : market.strike_type === 'less' && Number(market.cap_strike) === level;
  if (!strikeOk) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'STRIKE_FIELDS_DISAGREE_WITH_RULES', { strike_type: market.strike_type, floor: market.floor_strike, cap: market.cap_strike, level });
  const start = iso(startText); const end = iso(endText);
  if (!start || !end || start > end) return fail('HOLD_RESOLUTION_AMBIGUOUS', 'PERIOD_UNPARSEABLE');
  const close = market.close_time;
  return {
    normalization_status: 'NORMALIZED',
    status_reason: null,
    event_type: isHigh ? 'YIELD_PATH_MAX' : 'YIELD_PATH_MIN',
    subject: `${tenor}-year Treasury par yield, any business day ${start}..${end}`,
    comparator: isHigh ? '>' : '<',
    threshold_low: isHigh ? level : null,
    threshold_high: isHigh ? null : level,
    units: 'percent',
    location: null,
    station_id: `UST${tenor}Y`,
    station_source: 'U.S. Treasury Daily Par Yield Curve Rates',
    observation_start: `${start}T13:00:00.000Z`, // first business day of the period (published after 3:30 pm ET)
    observation_end: close,
    timezone: 'America/New_York',
    resolution_authority: 'U.S. Department of the Treasury (Daily Treasury Par Yield Curve Rates)',
    resolution_dataset: `Daily Treasury Par Yield Curve Rate, ${tenor}-year tenor, first published value per business day`,
    verification_dataset: `FRED ${TENORS[tenor]} (H.15 constant maturity, same Treasury curve)`,
    measurement_definition: `Daily par yield for the ${tenor}-year tenor on each business day ${start}..${end}; intraday values not considered`,
    rounding_rule: 'Yields as published (two decimals)',
    exceptions: ['The market may expire early once the threshold is met', 'First published value per business day governs unless the Exchange finds a material error'],
    yes_condition: `${tenor}Y par yield ${isHigh ? 'above' : 'below'} ${level}% on any business day ${start}..${end}`,
    no_condition: `never ${isHigh ? 'above' : 'below'} ${level}% in the period`,
    detail: { category: 'RATES', tenor, level, direction: isHigh ? 'high' : 'low', period_start: start, period_end: end, scoring_reference: close, fred_series: TENORS[tenor] },
  };
}
