// CPI V1 contract adapter. Translates venue contract semantics into
// mathematical events on the published one-decimal CPI value, AFTER the model
// distribution exists. The model never sees venue wording or prices.
//
// Kalshi CPI families (verified against series + market rules 2026-10-07):
//   KXCPI         headline CPI-U SA 1-month % change, single-decimal BLS value
//   KXCPICORE     core CPI-U SA 1-month % change, single-decimal BLS value
//   KXCPIYOY      headline CPI-U NSA 12-month % change, one-decimal BLS value
//   KXCPICOREYOY  core CPI-U NSA 12-month % change, one-decimal BLS value
// All listed markets are strike_type "greater": YES iff published value > strike.

export const ADAPTER_VERSION = 'cpi-contract-adapter/1';

export const KALSHI_SERIES_TARGET = Object.freeze({
  KXCPI: 'headline_mom',
  KXCPICORE: 'core_mom',
  KXCPIYOY: 'headline_yoy',
  KXCPICOREYOY: 'core_yoy'
});

const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

function oneDecimal(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  const r = Math.round(v * 10) / 10;
  return Math.abs(r - v) < 1e-9 ? r : null;
}

// KXCPI-26OCT-T0.3 -> { series: KXCPI, referenceMonth: 2026-10 }
export function parseKalshiTicker(ticker) {
  const m = /^(KXCPI|KXCPICORE|KXCPIYOY|KXCPICOREYOY)-(\d{2})([A-Z]{3})-/.exec(String(ticker));
  if (!m || !MON[m[3]]) return null;
  return { series: m[1], referenceMonth: `20${m[2]}-${String(MON[m[3]]).padStart(2, '0')}` };
}

// market: { ticker, strike_type, floor_strike, cap_strike }
// -> { status: 'SUPPORTED', target, referenceMonth, event } | { status: 'UNSUPPORTED', reason }
export function translateKalshiMarket(market) {
  const parsed = parseKalshiTicker(market?.ticker);
  if (!parsed) return { status: 'UNSUPPORTED', reason: 'unknown_series_or_ticker' };
  const target = KALSHI_SERIES_TARGET[parsed.series];
  const type = market.strike_type;
  if (type === 'greater') {
    const t = oneDecimal(market.floor_strike);
    if (t === null) return { status: 'UNSUPPORTED', reason: 'strike_not_on_one_decimal_grid' };
    return { status: 'SUPPORTED', target, referenceMonth: parsed.referenceMonth, event: { kind: 'above', threshold: t } };
  }
  if (type === 'less') {
    const t = oneDecimal(market.cap_strike);
    if (t === null) return { status: 'UNSUPPORTED', reason: 'strike_not_on_one_decimal_grid' };
    return { status: 'SUPPORTED', target, referenceMonth: parsed.referenceMonth, event: { kind: 'below', threshold: t } };
  }
  if (type === 'between') {
    const lo = oneDecimal(market.floor_strike);
    const hi = oneDecimal(market.cap_strike);
    if (lo === null || hi === null || hi < lo) return { status: 'UNSUPPORTED', reason: 'range_not_on_one_decimal_grid' };
    return { status: 'SUPPORTED', target, referenceMonth: parsed.referenceMonth, event: { kind: 'range', lo, hi } };
  }
  return { status: 'UNSUPPORTED', reason: `strike_type_${type ?? 'missing'}` };
}

export function eventProbability(dist, event) {
  switch (event.kind) {
    case 'above': return dist.probAbove(event.threshold);
    case 'below': return dist.probBelow(event.threshold);
    case 'range': return dist.probRange(event.lo, event.hi);
    case 'exact': return dist.probExact(event.value);
    default: throw new Error(`unknown event kind ${event.kind}`);
  }
}
