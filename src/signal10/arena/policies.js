// PBE Signal 10 STRATEGY ARENA — PRE-REGISTERED challenger policies (issue #62). Written 2026-10-10 BEFORE any
// challenger decision, backtest or forward result exists. Parameters are a-priori textbook conventions, NOT fitted to any
// observed return. Any change = a new version string; records made under an old version keep that version forever.
// ORIGINAL (owner correction 2026-10-10): a BRAND-NEW arena account running the unchanged V1 investment algorithm —
// its rank + manager parameters are IMPORTED from src/signal10/policy.js (signal10-rank/1.0.0, signal10-manager/1.0.0),
// never copied, so they cannot drift. The legacy V1 paper account is separate historical research and is
// not a competitor. TECH and DIVERSIFIED are independent algorithms, not relabelled copies.
//
// Shared execution conventions (identical to the control so the head-to-head is fair):
//   fills at the NEXT regular-session OPEN after the decision close (daily-bar open, unadjusted); no bar = order EXPIRES;
//   10 bps slippage per side; $0 commission; whole shares; $100 minimum order; idle cash earns 0%; no margin, shorting,
//   options or futures; dividends credited on the ex-date; splits with cash-in-lieu; a series that ends is liquidated at
//   its last observed close (flagged ESTIMATE). SIMULATED PAPER ONLY: no brokerage connection, no orders anywhere.

import { RANK as V1_RANK, MANAGER as V1_MANAGER, MODEL_VERSION as V1_MODEL, POLICY_VERSION as V1_POLICY } from '../policy.js';

export const ARENA_VERSION = 'signal10-arena/1.1.0';
export const STARTING_CASH_CENTS = 1_000_000;

// ---------------- ORIGINAL (V1 rules, new account) ----------------
export const ORIGINAL = Object.freeze({
  strategy: 'ORIGINAL', label: 'Original', account: 'S10-ARENA-ORIG-1',
  model: V1_MODEL, policy: V1_POLICY,
  universe: Object.freeze({
    base: 'S&P 500 point-in-time members (fja05680/sp500, read at each EOD) — the V1 universe',
    filter: 'none beyond V1 eligibility (src/signal10/rank.js features())',
    excludes: 'nothing added; no taxonomy, no metals (V1 has neither)',
  }),
  rank: V1_RANK,
  manager: V1_MANAGER,
  regime: 'SPY adj >= SPY SMA200 (V1 rule; fewer than 200 bars = risk-off, exactly as V1)',
});

// ---------------- TECH / TECHNOLOGY CONVICTION ----------------
// Thesis: concentrated, momentum-led conviction in technology leaders. Deliberately the opposite of the control's
// low-volatility tilt: no volatility penalty, buys strength (no dip requirement), a technology-specific regime filter,
// wider stops plus a re-entry cooldown (the control's documented stop/re-buy whipsaw).
export const TECH = Object.freeze({
  strategy: 'TECH', label: 'Tech Conviction', account: 'S10-ARENA-TECH-1',
  model: 'signal10-tech-rank/1.0.0', policy: 'signal10-tech-manager/1.0.0',
  universe: Object.freeze({
    base: 'S&P 500 point-in-time members (fja05680/sp500, read at each EOD; same source as the control)',
    filter: 'classification.tech === true (SEC SIC code in TECH_SIC_RANGES, pbe-sic-sectors/1.0.0, dated snapshot effective <= D)',
    excludes: 'every non-technology SIC; ETFs; precious metals and commodity proxies (never eligible)',
  }),
  rank: Object.freeze({
    minHistory: 253, minPrice: 5, minMedianDollarVolume: 50e6, maxCalendarGap: 5,
    // composite = weighted mean of cross-sectional percentile ranks among eligible technology names
    weights: Object.freeze({ mom12_1: 0.30, mom6: 0.30, mom3: 0.20, trend50: 0.10, high252: 0.10 }),
  }),
  manager: Object.freeze({
    maxPositions: 8, targetWeight: 0.125, maxNewBuysPerSession: 4,
    entryMaxRank: 8,                // BUY a top-8 name that is in a short-term uptrend (no dip needed: buys strength)
    entryRule: 'adj > SMA50 and the one-day return > -8%',
    brokenDayDrop: -0.08,
    regimeSymbol: 'QQQ',            // new buys only while QQQ adj >= QQQ SMA200
    deriskAfterRiskOffCloses: 10,   // QQQ below SMA200 for >= 10 consecutive closes: SELL holdings below their own SMA200
    exitRank: 20,                   // SELL when rank falls below 20
    trailingStop: -0.25,            // SELL when adj close is 25% below its highest adj close since entry
    cooldownSessions: 10,           // a name sold by TRAILING_STOP or DERISK cannot be re-bought for 10 sessions
    trimAboveWeight: 0.20, trimToWeight: 0.15,
    rotateCandidateMaxRank: 2, rotateWeakestMinRank: 12, maxRotationsPerSession: 1,
    minTradeCents: 10_000, slippageBps: 10,
  }),
});

// ---------------- DIVERSIFIED / RISK DISCIPLINE ----------------
// Thesis: risk-aware cross-sector quality-of-trend selection with inverse-volatility sizing, hard concentration limits and
// an optional precious-metals ETF sleeve. May hold cash; there is no mandate to fill every slot.
export const DIVERSIFIED = Object.freeze({
  strategy: 'DIVERSIFIED', label: 'Diversified Risk Discipline', account: 'S10-ARENA-DIV-1',
  model: 'signal10-div-rank/1.0.0', policy: 'signal10-div-manager/1.0.0',
  universe: Object.freeze({
    base: 'S&P 500 point-in-time members (fja05680/sp500, read at each EOD; same source as the control)',
    filter: 'classified sector != UNCLASSIFIED (pbe-sic-sectors/1.0.0, dated snapshot effective <= D)',
    metals: 'GLD, SLV, PPLT listed ETFs only when METAL_ETF_REGISTRY marks the instrument VERIFIED (identity, history, session); never spot quotes',
  }),
  rank: Object.freeze({
    minHistory: 253, minPrice: 5, minMedianDollarVolume: 25e6, maxCalendarGap: 5,
    weights: Object.freeze({ riskAdjMom: 0.35, lowVol63: 0.20, resilience252: 0.15, trend200: 0.15, mom6: 0.15 }),
  }),
  manager: Object.freeze({
    maxEquityPositions: 12, maxNamesPerSector: 2, maxNewBuysPerSession: 4,
    entryMaxRank: 25, entryRule: 'adj > SMA200 and the one-day return > -8%', brokenDayDrop: -0.08,
    // inverse-volatility sizing: weight = min(maxHoldingWeight, volBudget / annualized 63-day volatility)
    volBudget: 0.015,
    maxHoldingWeight: 0.10,         // HARD: <= 10% of NAV per holding
    maxSectorWeight: 0.25,          // HARD: <= 25% of NAV per equity sector
    maxMetalsWeight: 0.20,          // HARD: <= 20% of NAV in aggregate precious-metal ETFs
    // post-drift enforcement at every EOD (sold at the next open): holding > 10% -> trim to 9%; sector > 25% -> trim the
    // largest holdings in it until the sector is <= 24%; metals > 20% -> trim each metal ETF pro rata to 19% aggregate.
    trimHoldingTo: 0.09, trimSectorTo: 0.24, trimMetalsTo: 0.19,
    regimeSymbol: 'SPY',            // new EQUITY buys only while SPY adj >= SPY SMA200 (metals sleeve may still enter)
    metalEntryRule: 'ETF adj > its SMA200 and 6-month momentum > 0',
    exitRank: 60, exitBelowSma200: true, trailingStop: -0.15, cooldownSessions: 15,
    minTradeCents: 10_000, slippageBps: 10,
  }),
});

// The three Arena accounts (all brand-new, all funded at the same T0). Name kept for compatibility.
export const CHALLENGERS = Object.freeze([ORIGINAL, TECH, DIVERSIFIED]);
export const ARENA_ACCOUNTS = CHALLENGERS;
export const DISCLOSURE = 'HYPOTHETICAL / SIMULATED PAPER RESULTS. Not actual trading. Not investment advice.';
