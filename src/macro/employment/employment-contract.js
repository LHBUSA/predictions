// Kalshi employment contract terms (RESEARCH ONLY: not registered with the engine normalizer; no production path).
// Terms only: series, reference month, strike, comparator. Prices never pass through here. Fails closed whenever the
// rules text, the ticker and the structured strike fields disagree.
//
// Verified rules wording 2026-10-08 (test/fixtures/employment/kalshi-employment-events-2026-10-08.json), strike_type
// "greater" for both: YES iff the first published value is STRICTLY ABOVE the strike.
//   KXU3        "If the seasonally adjusted unemployment rate (U-3) reported by the Bureau of Labor Statistics in the
//                Employment Situation Report is above X% in <Month YYYY>, then the market resolves to Yes."
//   KXPAYROLLS  "If the increase in total non-farm payroll employment is above X as reported by the Bureau of Labor
//                Statistics Monthly Employment Situation Report for the month of <Month YYYY>, then the market resolves to Yes."
// KXPAYROLLS series metadata names https://www.bls.gov/news.release/ppi.nr0.htm (the PPI release) as its settlement
// source. The rules name the Employment Situation. The rules are the contract; the conflict is recorded on every
// normalized term so the evidence travels with it. A rules text that does not name the Employment Situation and total
// nonfarm payroll employment for the ticker month is refused.
export const EMPLOYMENT_ADAPTER_VERSION = 'employment-contract-adapter/1';

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const FULL = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const MONTH_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})\b/;
const mkey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const fail = (reason, extra = {}) => ({ ok: false, status: 'HOLD_RESOLUTION_AMBIGUOUS', reason, ...extra });

export function parseEmploymentTicker(ticker) {
  // legacy pre-2024 tickers (U3-24MAY-T4.0, PROLLS-23SEP-T...) belong to the same series; the rules checks below are unchanged
  const m = /^(KXU3|U3|KXPAYROLLS|PROLLS|PAYROLLS)-(\d{2})([A-Z]{3})-T(-?\d+(?:\.\d+)?)$/.exec(String(ticker || ''));
  if (!m || !MONTHS[m[3]]) return null;
  const series = m[1].endsWith('U3') ? 'KXU3' : 'KXPAYROLLS';
  return { series, ticker_prefix: m[1], reference_month: mkey(2000 + Number(m[2]), MONTHS[m[3]]), ticker_strike: Number(m[4]) };
}

const FAMILY = {
  KXU3: {
    target: 'u3', units: 'pct', strike_re: /\bis above (-?\d+(?:\.\d+)?)%/,
    subject: (r) => /seasonally adjusted unemployment rate \(U-3\)/i.test(r) && /Employment Situation/i.test(r),
    grid: (s) => Math.abs(s * 10 - Math.round(s * 10)) < 1e-9,
  },
  KXPAYROLLS: {
    target: 'payroll_change', units: 'persons', strike_re: /\bis above (-?[\d,]+)\b/,
    subject: (r) => /total non-?farm payroll employment/i.test(r) && /Employment Situation/i.test(r),
    grid: (s) => Number.isInteger(s / 1000),
  },
};

export function employmentTerms(market, { seriesMeta = null } = {}) {
  const p = parseEmploymentTicker(market?.ticker);
  if (!p) return fail('NOT_AN_EMPLOYMENT_TICKER', { ticker: market?.ticker ?? null });
  const fam = FAMILY[p.series];
  const rules = String(market.rules_primary || '').trim();
  if (!/then the market resolves to Yes\.?$/.test(rules)) return fail('NO_CONTRACT_TEMPLATE');
  if (!fam.subject(rules)) return fail('RULES_DISAGREE_WITH_SERIES', { series: p.series });
  const mm = MONTH_RE.exec(rules);
  const ruleMonth = mm ? mkey(Number(mm[2]), FULL[mm[1]]) : null;
  if (ruleMonth !== p.reference_month) return fail('RULES_MONTH_DISAGREES_WITH_TICKER', { rules_month: ruleMonth, ticker_month: p.reference_month });
  const sm = fam.strike_re.exec(rules);
  if (!sm) return fail('RULES_STRIKE_UNPARSEABLE');
  const strike = Number(sm[1].replace(/,/g, ''));
  if (market.strike_type !== 'greater') return fail('STRIKE_TYPE_NOT_GREATER', { strike_type: market.strike_type ?? null });
  if (Number(market.floor_strike) !== strike || p.ticker_strike !== strike) return fail('STRIKE_FIELDS_DISAGREE_WITH_RULES', { rules_strike: strike, floor_strike: market.floor_strike ?? null, ticker_strike: p.ticker_strike });
  if (market.cap_strike !== undefined && market.cap_strike !== null) return fail('UNEXPECTED_CAP_STRIKE', { cap_strike: market.cap_strike });
  if (!fam.grid(strike)) return fail('STRIKE_OFF_GRID', { strike });
  const sources = (seriesMeta?.settlement_sources || []).map((s) => s.url);
  const metadata_conflicts = sources.filter((u) => !/empsit|employment/i.test(u)).map((u) => ({ settlement_source_url: u, note: 'series metadata names a non-Employment-Situation page; rules govern' }));
  return {
    ok: true, adapter_version: EMPLOYMENT_ADAPTER_VERSION,
    series: p.series, target: fam.target, reference_month: p.reference_month, units: fam.units,
    comparator: 'greater', strike,
    yes_condition: `first published value > ${strike}`, no_condition: `first published value <= ${strike}`,
    rules_primary: rules, metadata_conflicts,
  };
}

// The YES outcome for a first-published value. Payroll value is in thousands (BLS), strike in persons.
export function yesOutcome(terms, firstPrint) {
  if (firstPrint === null || firstPrint === undefined || Number.isNaN(firstPrint)) return null;
  if (terms.target === 'u3') return Math.round(firstPrint * 10) > Math.round(terms.strike * 10);
  return Math.round(firstPrint * 1000) > terms.strike;
}

// P(YES) from a discrete distribution { lo, step, mass[] } over the target's published grid (U-3 in 0.1 pct points,
// payrolls in thousands). Strictly above: the strike's own grid point counts as NO.
export function probabilityAbove(dist, terms) {
  const s = terms.target === 'u3' ? terms.strike : terms.strike / 1000;
  const ks = Math.round(s / dist.step); // compare integer grid indices, never floats
  let p = 0;
  for (let i = 0; i < dist.mass.length; i++) if (Math.round(dist.lo / dist.step) + i > ks) p += dist.mass[i];
  return p;
}
