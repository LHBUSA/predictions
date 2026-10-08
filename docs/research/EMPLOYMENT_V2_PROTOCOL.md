# Employment V2 — pre-registered protocol (FROZEN 2026-10-08; status HOLD)

Frozen on the owner's direction of 2026-10-08. It supersedes `EMPLOYMENT_V2_PROTOCOL_PROPOSAL.md`, which is kept as
the design record. Changes after this commit only as dated, reasoned amendments, and never to a gate after any V2
forecast exists.

**Status: HOLD.** No V2 model is fit, captured or deployed. Prospective capture (section 5) starts only on a separate,
explicit owner GO, and that date is recorded here as Amendment B1. Until then the only approved V2 work is the
point-in-time ledger extension (section 3), research-only. KXU3 and KXPAYROLLS remain MARKET MONITORING: no published
forecast, no edge claim, no premium pick, whatever any gate says, until the owner approves a product change.
Employment V1 is CLOSED (KXU3 FAIL, KXPAYROLLS FAIL); V1 is never retuned.
Dated amendments in the change log (B0, B2) govern where they differ from the sections below.

Objective (owner): a model that adds genuine intelligence beyond the market, not one that only passes internal tests.
So V2 has **two separate gates**. The statistical gate decides whether a model is sound. The commercial gate decides
whether it adds anything beyond the market. Passing the first never implies the second.

## 1. Why the historical record cannot pass V2

V2's hypotheses were derived from V1's 2011-2026 results and from the V1-vs-Kalshi comparison. Any V2 score on that
history is in-sample with respect to the design. The historical walk-forward is therefore **blocking only** (section 6.3).
Every PASS must come from releases published after prospective capture starts.

## 2. Targets and semantics (unchanged from V1)

KXU3 is primary. KXPAYROLLS is secondary, and is evaluated only if the owner separately approves continuing it (default:
not captured). YES iff the first print is strictly above the strike. Probabilities are P(value > strike) on integer grid
indices, so the exact strike is NO. Truth = BLS first print (V1 ledger rules). A month BLS never publishes is
INPUT_UNAVAILABLE for the model. Contract settlement under a terms fallback ("last available month") is recorded
separately as a settlement rule and never becomes an observation, a target or a feature.

## 3. Inputs (V1 frozen ledgers + this approved extension; nothing else)

V1 inputs as frozen in `data/employment/LEDGER_FREEZE.json`, plus:
- **BLS Table A first-print levels** (seasonally adjusted, thousands): `civilian_labor_force` and `unemployed` for the
  reference month, from the reference month's own Employment Situation release. Guard: round(100 * unemployed /
  civilian_labor_force, 1) must equal the published one-decimal U-3 in the same release, or the month is refused.
  Available at the release embargo time.
- **DOL advance insured unemployment rate** (SA, percent), from the weekly release, for the same week as the advance
  continuing claims in that release. Guard: its week must equal that release's `continuing_week_ending`.
  Available at the release embargo time.
Both get parser versions, sha256 per document, a 10-case manual proof against the archived documents, and their own
freeze file. Missing means INPUT_UNAVAILABLE, never imputed. No ADP, Conference Board, Challenger or other proprietary
source, and no market-derived input of any kind.

Derived features (definitions frozen now):
- `U3_UNROUNDED_GAP` = 100 * unemployed / civilian_labor_force - published U-3, for month M-1, using the levels as
  latest published at the cutoff.
- `IUR_CHG_REF` = advance IUR for the reference week of M minus advance IUR for the reference week of M-1. The reference
  week is the Sunday-Saturday week containing the 12th, as in V1. Each value is the advance figure from the release
  published for that week.

## 4. Frozen candidate families

| ID | Target | Specification |
|---|---|---|
| U3-C1 | KXU3 | RIDGE_T_EWMA on `CC_LOGCHG_REF`, `IC4_LOGCHG_REF`, `U3_UNROUNDED_GAP` |
| U3-C2 | KXU3 | RIDGE_T_EWMA on `IUR_CHG_REF`, `U3_UNROUNDED_GAP` |
| PAY-C1 | KXPAYROLLS (only if approved) | V1 payroll features; Huber loss (k = 1.345, MAD scale); Student-t errors with a robust EWMA scale |

Hyperparameters are V1's (ridge lambda 2, Student-t nu 5, EWMA half-life 24, minimum 36 training months, 0.1 grid,
A2 grid ranges), never tuned. Expanding training window, refit at every origin, V1 fold guard. Holm correction across
U3-C1 and U3-C2.

Baselines, on identical origins and grid: V1 persistence, 12-month rolling mean, claims-only (the U-3 incumbent), the
frozen V1 candidate artifact, and the quarantined employment-v0 (U-3, as V1).

## 5. Prospective capture (starts only on owner GO)

For every Employment Situation release after capture starts, at the T-1D cutoff (20:00 America/New_York the day before
the release):
1. Compute every candidate and baseline on the frozen ledgers as extended through the cutoff.
2. Snapshot every listed Kalshi contract: ticker, rules, strike, and the mid of the last hourly candle ending at or
   before the cutoff with both quotes. This is read-only, for scoring, and is never an input.
3. Write one JSON per release (forecasts, market snapshot, input hashes, code sha) and commit + push it **before** the
   08:30 ET release. The commit time is the proof that it was made first. A file committed after its release is void
   and is never repaired.
Research capture only: no production table, cron lane or Worker path without a separate owner approval.

## 6. Gates (fixed now)

### 6.1 Statistical model gate (per candidate, vs the best baseline)
- n >= 24 prospective releases. An interim look at n = 12 is descriptive only.
- Mean per-release ladder log-loss gain (V1 A1 ladder, floor 1e-4) > 0, with the one-sided 95% moving-block bootstrap
  lower bound (block 3, 2,000 reps, seed 20261008) > 0. Holm-adjusted across the U-3 candidates.
- 80% central-interval coverage in [0.72, 0.88]. PIT uniformity chi-square (10 bins) p > 0.01. ECE <= 0.05.

### 6.2 Commercial market-outperformance gate (separate; required before any edge claim or paid product)
- The same prospective releases, scored on the Kalshi contracts actually listed and priced at the cutoff (V1 comparison
  rules: fail-closed terms, mid of the last two-sided candle, NO_PRICE excluded for every source).
- Pass needs: mean per-release log-loss (candidate minus market) < 0 with the one-sided 95% block-bootstrap upper bound
  < 0, AND Brier (candidate minus market) <= 0, AND at least 18 releases with priced contracts.
- A statistical-gate PASS with a commercial-gate FAIL means "sound model, no edge". The series stays MARKET MONITORING.

### 6.3 Historical blocking check (cannot pass anything)
On the 2011-2026 walk-forward with the frozen ledgers: a candidate whose mean log loss is worse than the best baseline by
more than 0.005, or whose 80% coverage is outside [0.72, 0.88], is dropped before prospective scoring counts.

### 6.4 Reporting, always
2020-03..2021-12 split, reliability table, PIT histogram, sharpness, and April 2020 excluded vs included (provenance
limitation). Settlement validation (ledger vs Kalshi outcomes) is reported separately from predictive scores.

## 7. Auditability

Raw documents hashed; ledgers rebuildable byte-for-byte; `validate.mjs`-style refusal of changed ledgers; code sha in
every capture file; the leakage, no-market-feature, DST and strict-">" tests carried over; one evidence JSON per gate
with sha256 recorded in this file's amendments.

## Change log
- 2026-10-08: frozen from the proposal on the owner's direction. Added the separate commercial gate (6.2) and the
  settlement-vs-observation rule (2). Status HOLD.
- 2026-10-08 15:39Z: section 3 ledger extension built and frozen (`data/employment/LEDGER_FREEZE_V2_EXTENSION.json`),
  with no fit and no feature/target analysis. BLS levels: 224/224 releases parsed. In every release,
  round(100 * unemployed / civilian labor force, 1) reproduced the published U-3 (0 refusals). October 2025 levels are
  null, as printed. DOL advance SA IUR: 1,021 of 1,022 frozen claims releases parsed. One document (2021-10-28) prints the
  SA rate only in its table, with no narrative sentence. It is refused (week 2021-10-16 = INPUT_UNAVAILABLE) and not
  read by another extraction path. Manual proof 20/20 (`employment-v2-extension-manual-proof.json`). V1 ledgers and V1
  freeze unchanged. Status remains HOLD.
- 2026-10-08 (Amendment B0, before any V2 forecast exists; tightens section 6.2 only): the commercial gate's market
  price must be FRESH. Use the mid of the last hourly candle with both quotes that ends at or before the cutoff AND no
  earlier than cutoff - 2 h. Otherwise the contract is NO_PRICE for every source. Reason: commit b2ae835 found that the V1
  comparison had no quote-age cap (U-3: 106/316 priced contracts older than 2 h, maximum 71 h). Also required alongside
  the gate, never in place of it: an executable sensitivity (YES at ask, NO at 1 - bid, after Kalshi fees), quote-age
  distribution, spread and volume per event. A model that beats the mid but not the executable price has no tradable
  edge. The V1 comparison and its JSON are not changed (V1 is closed).
- 2026-10-08 (**Amendment B2**, before any V2 forecast exists; owner direction 2026-10-08 "final protocol checks").
  B1 stays reserved for the capture-start date. B2 governs wherever it conflicts with sections 5-6 or B0. Status
  remains HOLD.

  **B2.1 Unit of evaluation: the monthly release.**
  - One Employment Situation publication for reference month M is one release. Every `n` in section 6 counts
    releases.
  - Statistical gate: one ladder log loss per release per model (V1 A1 ladder).
  - Commercial gate, probability part: per release, the mean over that release's eligible contracts. Each release
    gets equal weight however many strikes it lists.
  - Commercial gate, executable part: per release, the summed P&L of its signals. A release with eligible contracts
    but no signal scores 0 and still counts.
  - Intervals: a moving-block bootstrap over releases in time order (block 3, 2,000 reps, seed 20261008).
    "One-sided 95% bound" means the 5th (lower) or 95th (upper) percentile of the 2,000 bootstrap means.
  - No contract-level standard error, pooled contract count or contract-level test may appear in a gate or a headline
    figure. Contract counts are descriptive only.
  - KXU3 and KXPAYROLLS share releases. They are separate gates and are never pooled.

  **B2.2 Releases excluded from both gates.** These are listed in the evidence and never count toward n:
  - BLS does not publish the reference month (INPUT_UNAVAILABLE).
  - Kalshi settles by anything other than the first print: a terms fallback such as the October 2025 "last available
    month" rule, a Market Outcome Review, or a source change.

  Settlement and published data stay separate. A settlement value is never an observation, target or feature.
  Truth is the BLS first print; settlement agreement is reported as data validation only. Each capture archives the
  contract terms PDF and the series record with sha256, so the rules in force are proven at the time. Section D of the
  V1 evidence shows the original 2021/2022 filings lack the fallback, so terms can change between capture and expiry.

  **B2.3 Commercial gate, restated in full (replaces 6.2 and B0).**
  - *Snapshot (prospective, read-only, never an input):* fetched between 19:50 and 20:00 ET on the cutoff evening,
    with each response's fetch time recorded. For every listed contract: the order book (`/markets/{ticker}/orderbook`),
    the market record, the series record (`fee_type`, `fee_multiplier`) and the terms PDF hash. YES bid = best YES
    bid; YES ask = 1 - best NO bid; mid = (bid + ask) / 2.
  - *Freshness:* a snapshot no more than 10 minutes old is live. If the live snapshot is missing, the probability part
    may use the B0 candle rule: mid of the last two-sided hourly candle ending within [cutoff - 2 h, cutoff].
    Otherwise the contract is NO_PRICE for every source. The executable part uses live snapshots only, with no candle
    fallback.
  - *Eligibility:* the terms pass `employmentTerms` (fail closed), both sides are quoted, and the strike is on the model
    grid.
  - *(a) Probability:* mean per-release log loss (candidate minus market mid) < 0, with its one-sided 95% upper bound
    < 0, AND mean per-release Brier difference <= 0.
  - *(b) Executable:* the rule frozen in V1 evidence section C.
    - Buy YES at the ask if p - ask - fee(ask) > 0; buy NO at 1 - bid if (bid - p) - fee(1 - bid) > 0. At most one
      side per contract.
    - Size is 1 contract at the displayed best level. No fill better than displayed, no fill after the cutoff, and
      no maker rebate.
    - Fee: the taker fee for the captured series `fee_type`. Quadratic: ceil(100 * 0.07 * multiplier * C * P(1 - P))
      / 100 per order of C contracts. A fee type that is missing or unrecognised makes that contract NO_PRICE for (b).
    - P&L uses the actual Kalshi settlement. Releases where settlement differs from the first print are already
      excluded by B2.2.
    - Pass needs mean per-release P&L > 0 with its one-sided 95% lower bound > 0, AND total P&L still > 0 after
      dropping the single best release (concentration guard: V1 payroll P&L was mostly two releases).
  - *Liquidity sensitivity (reported, never gating, never in place of (b)):* sizes of 10 and 100 contracts, walking
    the captured book and filling only the displayed size. Also quote age, spread, top-of-book size, 24 h volume and
    open interest per release.
  - *Pass* = (a) AND (b) AND at least 18 releases with at least one eligible contract live-priced. Anything else means
    "no demonstrated edge", and the series stays MARKET MONITORING.

  **B2.4 Calendar.** n >= 24 releases means about 24 months, i.e. about two years. The next release is 2026-11-06
  (October 2026 data); its cutoff is 2026-11-05 20:00 EST = 2026-11-06 01:00Z, and Kalshi's KXU3-26OCT and
  KXPAYROLLS-26OCT close at 13:29Z.
  - If capture starts before that cutoff, the interim look (n = 12, descriptive only) comes about October 2027 and the
    24th scoreable release about October 2028.
  - Every cancelled or fallback-settled month adds a month; so does every month of delay to the GO.
  - Commercial (b) also needs at least 18 live snapshots. A missed snapshot cannot be repaired later.

  **B2.5 Ownership and capture validity.** The rules in `EMPLOYMENT_BRANCH_AUDIT_b2ae835.md` apply:
  - One owning session per branch.
  - Foreign commits are audited and are never decisions or evidence.
  - Capture files count only if written by the single scheduled collector and pushed before 08:30 ET on release
    day, as shown by the GitHub push record, not the git commit date.

  **B2.6 CPI isolation.** Employment research and capture never run in, import into, deploy, or schedule on the
  pbe-predictions Worker. They never write to tkmln and never touch CPI SHADOW code, tables or crons. The CPI forecast
  freeze of 2026-10-14 00:09Z is unaffected.

