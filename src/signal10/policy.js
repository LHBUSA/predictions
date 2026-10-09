// PBE Signal 10 — PRE-REGISTERED model + portfolio-manager policy.
// Written 2026-10-09 BEFORE any backtest result was computed. Weights/thresholds are textbook cross-sectional
// momentum / trend / low-volatility conventions chosen a priori, NOT fitted. Any change = new version string, and the
// old version's records stay as they are. The author knows broad market history (e.g. the 2020 crash, 2022 bear market,
// the 2023-25 AI rally), so the backtest is "untuned but not blind": it is labelled as such everywhere.

export const MODEL_VERSION = 'signal10-rank/1.0.0';
export const POLICY_VERSION = 'signal10-manager/1.0.0';

export const RANK = Object.freeze({
  // eligibility (all knowable at the close of D)
  minHistory: 253,            // >= 253 bars (12-month lookback + 1); also excludes new listings/IPOs for their first year
  minPrice: 5,                // unadjusted close >= $5
  minMedianDollarVolume: 25e6, // 63-session median of unadjusted close x volume
  maxCalendarGap: 5,          // no more than 5 missing market sessions inside the 253-bar window (halts/suspensions)
  // composite = weighted mean of cross-sectional percentile ranks among eligible names
  weights: Object.freeze({ mom12_1: 0.35, mom6: 0.20, riskAdjMom: 0.20, trend200: 0.15, lowVol63: 0.10 }),
  topN: 10
});

export const MANAGER = Object.freeze({
  startingCashCents: 1_000_000,  // $10,000.00 simulated
  maxPositions: 10,
  targetWeight: 0.10,           // size of a new entry, % of NAV at the decision close
  maxNewBuysPerSession: 3,      // staged deployment: never more than 3 new names per session
  initialWindowSessions: 10,    // owner rule: first 10 trading sessions to begin deploying; NO forced buy at the end
  minTradeCents: 10_000,        // $100 minimum order notional
  wholeShares: true,            // no fractional shares; leftover stays cash
  cashInterest: 0,              // idle cash earns 0%
  // entry (a top-10 candidate is only BOUGHT when a setup qualifies; otherwise WAIT)
  entryMaxRank: 10,
  uptrend: 'adj > SMA50 && SMA50 > SMA200',
  brokenDayDrop: -0.08,         // a >= 8% one-day drop is NOT a dip-buy (possible broken thesis/adverse news) -> WAIT
  dipFrom10dHigh: -0.03,        // DIP ENTRY: close >= 3% below its 10-session high while still in uptrend
  persistenceSessions: 5,       // PERSISTENCE ENTRY: in the top 10 for >= 5 consecutive closes and still in uptrend
  regime: 'SPY adj >= SPY SMA200 for any NEW buy (risk-off: hold/exit only, no new names)',
  // add / trim
  addBelowWeight: 0.06,         // ADD to a top-10 holding whose weight drifted below 6% when a DIP ENTRY triggers
  trimAboveWeight: 0.20,        // TRIM a holding above 20% of NAV back to 15%
  trimToWeight: 0.15,
  // exits
  exitRank: 30,                 // SELL when rank falls below 30 (hysteresis vs the top-10 entry band)
  trailingStop: -0.20,          // SELL when adj close is 20% below the highest adj close since entry
  stopLoss: -0.15,              // SELL when down 15% from cost AND below SMA50
  // rotation (only when all slots are full)
  rotateCandidateMaxRank: 3,
  rotateWeakestMinRank: 15,
  rotateMinScoreGap: 15,
  maxRotationsPerSession: 1,
  // execution
  fill: 'next regular-session OPEN after the decision close (D+1); no bar for the symbol that session = order EXPIRES',
  slippageBps: 10,              // per side, applied to the open price (buy higher, sell lower); $0 commission
  delistAfterMissingSessions: 3 // a held symbol whose source series ends: liquidate at last observed close (flagged estimate)
});

export const DISCLOSURE = 'HYPOTHETICAL / SIMULATED PAPER RESULTS. Not actual trading. Not investment advice.';
