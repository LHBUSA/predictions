// Precious-metals instruments + observation contract `metals/1` (issue #63). Pure, Worker-safe, part of the shared
// market-tape layer: one source/rights model for every PropBetEdge surface, no standalone quote vendor.
//
// Two instrument families that NEVER share an id or a price:
//   SPOT  XAU/USD, XAG/USD, XPT/USD (USD per troy ounce) — the reference metal prices. Every spot benchmark we could find
//         (LBMA Gold/Silver Price, LBMA Platinum Price via ICE Benchmark Administration; dealer and futures feeds) needs a
//         paid licence for any use or redistribution; FRED removed the LBMA series on 2022-01-31. Zero-spend rule -> no
//         spot provider: state SOURCE_RIGHTS_HOLD for every audience. Never substituted by an ETF, a future or a crypto token.
//   ETF   GLD, SLV, PPLT — exchange-listed grantor trusts holding physical metal. Investable proxies for the Signal 10
//         Diversified challenger (next-open equity fills from the same daily-bar source as every Signal 10 account).
//         Display prices only from a provider whose rights record permits the audience (market-tape contract.js): today
//         IEX Historical Data (T+1, IEX-venue last sale, credit line), labelled "ETF price, not spot".
// Rights research 2026-10-10: docs/market-tape/METALS.md.

export const METALS_CONTRACT = 'metals/1';

export const SPOT = Object.freeze([
  Object.freeze({ id: 'XAU:USD:SPOT', metal: 'GOLD', code: 'XAU', label: 'Gold', unit: 'USD per troy ounce', kind: 'SPOT' }),
  Object.freeze({ id: 'XAG:USD:SPOT', metal: 'SILVER', code: 'XAG', label: 'Silver', unit: 'USD per troy ounce', kind: 'SPOT' }),
  Object.freeze({ id: 'XPT:USD:SPOT', metal: 'PLATINUM', code: 'XPT', label: 'Platinum', unit: 'USD per troy ounce', kind: 'SPOT' }),
]);

// Identity verified 2026-10-10 against SEC EDGAR company_tickers_exchange.json (ticker -> registrant CIK -> exchange),
// the trusts' FY2025 10-K filings, and the issuer pages for CUSIPs (PPLT CUSIP: secondary source only, so null).
export const METAL_ETFS = Object.freeze([
  Object.freeze({ id: 'GLD:ARCX', symbol: 'GLD', metal: 'GOLD', label: 'SPDR Gold Shares', legal_name: 'SPDR Gold Trust', sponsor: 'World Gold Trust Services, LLC',
    sec_cik: '0001222333', exchange: 'NYSE ARCA', mic: 'ARCX', cusip: '78463V107', listed_on: '2004-11-18', structure: 'Grantor trust holding allocated physical gold (not a 1940 Act fund)',
    expense_ratio: 0.0040, nav_basis: 'LBMA Gold Price PM', splits: [], kind: 'ETF' }),
  Object.freeze({ id: 'SLV:ARCX', symbol: 'SLV', metal: 'SILVER', label: 'iShares Silver Trust', legal_name: 'iShares Silver Trust', sponsor: 'iShares Delaware Trust Sponsor LLC',
    sec_cik: '0001330568', exchange: 'NYSE ARCA', mic: 'ARCX', cusip: '46428Q109', listed_on: '2006-04-21', structure: 'Grantor trust holding physical silver (not a 1940 Act fund)',
    expense_ratio: 0.0050, nav_basis: 'LBMA Silver Price', splits: [{ d: '2008-07-24', ratio: 10 }], kind: 'ETF' }),
  Object.freeze({ id: 'PPLT:ARCX', symbol: 'PPLT', metal: 'PLATINUM', label: 'abrdn Physical Platinum Shares ETF', legal_name: 'abrdn Platinum ETF Trust', sponsor: 'abrdn ETFs Sponsor LLC',
    sec_cik: '0001460235', exchange: 'NYSE ARCA', mic: 'ARCX', cusip: null, listed_on: '2010-01-08', structure: 'Grantor trust holding physical platinum (not a 1940 Act fund)',
    expense_ratio: 0.0060, nav_basis: 'LBMA Platinum Price PM', splits: [], kind: 'ETF' }),
]);
export const METAL_ETF_SYMBOLS = Object.freeze(METAL_ETFS.map((x) => x.symbol));

// Eligibility for the Signal 10 Diversified sleeve (#62). Identity is verified statically (above); history and session
// are verified per decision date from the source series. Any failure -> not verified -> the sleeve holds cash.
//   series: prepared daily series (src/signal10/rank.js prepareSeries) or null; spyCal: Set of SPY session dates.
export function etfEligibility(etf, series, D, { minBars = 253, spyCal = null } = {}) {
  const fail = (hold) => ({ symbol: etf.symbol, verified: false, hold });
  if (!etf.sec_cik || !etf.mic) return fail('identity_unverified');
  if (!series) return fail('no_price_series');
  const i = series.idx.get(D);
  if (i == null) return fail('no_bar_on_decision_date');
  if (i + 1 < minBars) return fail('insufficient_history');
  if (spyCal && !spyCal.has(D)) return fail('not_an_equity_session');
  // a split inside the window must be one the registry knows (unexpected corporate action = hold, never guess)
  const window0 = series.d[Math.max(0, i - minBars + 1)];
  const unknown = (series.splits || []).filter((s) => s.d >= window0 && s.d <= D && !etf.splits.some((k) => k.d === s.d && k.ratio === s.ratio));
  if (unknown.length) return fail(`unregistered_corporate_action:${unknown.map((s) => `${s.d}x${s.ratio}`).join(',')}`);
  return { symbol: etf.symbol, verified: true, hold: null };
}

// ---------- observation contract (nullable everywhere; never our fetch time as an observation time) ----------
// row: { instrument_id, value, unit, currency, observed_at, session_date, source, rights_scope, delay, basis }
export function observation({ instrument, value = null, observed_at = null, session_date = null, source = null, rights = null, delay = null, basis = null }) {
  return { instrument_id: instrument.id, kind: instrument.kind, value: typeof value === 'number' && value > 0 ? value : null,
    unit: instrument.kind === 'SPOT' ? 'USD/ozt' : 'USD/share', currency: 'USD', observed_at, session_date, source, rights_scope: rights, delay, basis };
}

export const SPOT_HOLD = Object.freeze({
  state: 'SOURCE_RIGHTS_HOLD', label: 'QUOTE UNAVAILABLE · SOURCE RIGHTS HOLD',
  note: 'No zero-cost source with written display rights for spot gold, silver or platinum is on file. LBMA benchmark prices (ICE Benchmark Administration) require a paid licence for any use or redistribution, including delayed public display.',
});
