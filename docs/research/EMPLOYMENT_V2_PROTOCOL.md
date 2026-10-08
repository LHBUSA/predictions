# Employment V2 — pre-registered protocol (FROZEN 2026-10-08; status HOLD)

Frozen on the owner's direction of 2026-10-08. It supersedes `EMPLOYMENT_V2_PROTOCOL_PROPOSAL.md`, which is kept as
the design record. Changes after this commit only as dated, reasoned amendments, and never to a gate after any V2
forecast exists.

**Status: HOLD.** No V2 model is fit, captured or deployed. Prospective capture (section 5) starts only on a separate,
explicit owner GO, and that date is recorded here as Amendment B1. Until then the only approved V2 work is the
point-in-time ledger extension (section 3), research-only. KXU3 and KXPAYROLLS remain MARKET MONITORING: no published
forecast, no edge claim, no premium pick, whatever any gate says, until the owner approves a product change.
Employment V1 is CLOSED (KXU3 FAIL, KXPAYROLLS FAIL); V1 is never retuned.

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

