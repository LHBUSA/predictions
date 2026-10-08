# Employment V1 — research protocol (pre-registered 2026-10-08)

Status: RESEARCH. Nothing here is deployed, public, SHADOW, or CALL. Promotion of any kind needs the owner.
Standards are the CPI V1 standards: point-in-time / vintage-safe inputs, market-free features, chronological
walk-forward validation, baselines, leakage tests, a frozen artifact, a SHADOW gate, and no promotion without the owner.

This file is written before any model is fit. Changes after the first fit are recorded below with a date and reason.

## 1. Targets (Kalshi, terms captured 2026-10-08 in `test/fixtures/employment/kalshi-employment-events-2026-10-08.json`)

| Series | Event | Contract semantics (rules_primary) | Grid |
|---|---|---|---|
| KXPAYROLLS | Jobs numbers, month M | YES iff the change in total nonfarm payroll employment for M, as first reported in the BLS Employment Situation for M, is **above** the strike (`strike_type: greater`) | -25,000 … 125,000 (10k steps to 100k, then 125k) |
| KXU3 | Unemployment, month M | YES iff the seasonally adjusted U-3 rate for M in the Employment Situation is **above** the strike (`greater`) | 3.7 … 5.0 (0.1) |
| KXADP | ADP employment change, month M | YES iff the ADP employment change for M is above the strike | -25,000 … 125,000 (25k) |

Notes captured with the terms:
- KXPAYROLLS series metadata lists `https://www.bls.gov/news.release/ppi.nr0.htm` as its settlement source while the rules
  name the Employment Situation. The rules govern; the normalizer must fail closed on any rules text that does not name
  total nonfarm payroll employment and the Employment Situation for the ticker month.
- KXADP settles on a proprietary private dataset (ADP). It is **out of scope for V1** unless the owner approves the source
  (data policy: collect ourselves; no paid or proprietary feeds). It is listed only so it is not confused with KXPAYROLLS.
- KXJOBLESSCLAIMS / KXCONTCLAIMS exist with no open events on 2026-10-08. Weekly claims are a V1 *input*, not a V1 target.
- Primary target order: KXU3 first (one-decimal official value, same discretized-distribution shape as CPI), KXPAYROLLS
  second (integer thousands; heavier tails; large revisions).

## 2. Ground truth and the as-published ledger

- Truth = the **first print** in the BLS Employment Situation news release for month M (the value Kalshi settles on), not
  the current FRED/ALFRED vintage. `employment-v0` uses latest-vintage FRED and defaulted inputs (initial claims 230k,
  continuing 1.85M, prior = current); it is to be QUARANTINED exactly like `inflation-v0` and kept only as a baseline.
- Ledger source: the archived Employment Situation releases (`bls.gov/news.release/archives/empsit_MMDDYYYY.htm`), parsed
  with the same guards as the CPI ledger (release-date embargo check, narrative-vs-table agreement, M+1 re-print
  consistency for the household rate, which is not revised except at annual SA updates).
- Known gaps from the 2025 federal shutdown must be established from the archive, not assumed: the October 2025 household
  survey (U-3) was not collected; October 2025 payrolls were published late with November. Any target or feature that needs
  a missing first print is NO_FORECAST / INPUT_UNAVAILABLE. Never 0, never imputed, never a fallback.

## 3. Inputs (each with its own availability rule; feature availability = max(rule, PBE first-seen))

| Input | Source | Availability rule |
|---|---|---|
| Prior first prints of U-3, payrolls, revisions | BLS Employment Situation archive | release time 08:30 ET |
| Initial + continuing claims (advance figures) | DOL ETA weekly claims news release archive (as published, not revised) | Thursday 08:30 ET |
| CPI-style seasonal/calendar terms | derived from the reference month | always |

No market price, no venue mid, no Kalshi-derived feature enters the model graph. A `pred_features_market_free` style CHECK
and the CPI leakage tests are carried over.

## 4. Horizon and cutoff

T-1D, identical to CPI: cutoff 20:00 ET the day before the 08:30 ET release. Release dates from the BLS schedule only.

## 5. Validation

- Chronological walk-forward over as-published history; no shuffled CV; hyper-parameters chosen inside each training
  window only.
- Baselines: last first print (persistence), 12-month rolling mean of changes, claims-only regression, and the quarantined
  `employment-v0`.
- Scores: Brier and log loss on the Kalshi ladder, RPS on the full grid, interval coverage, PIT, by regime (incl. 2020).
- Gate per target, decided before fitting: PASS only if the candidate beats the best baseline on mean log loss with a
  block-bootstrap 95% CI excluding zero and 80% interval coverage within [0.72, 0.88]. A target that fails stays RESEARCH.

## 6. Freeze and handoff

A passing target gets a frozen artifact (code sha, dataset sha, evidence sha) and an evidence packet. SHADOW needs the
owner's approval, as CPI did.

## Amendment A1 (2026-10-08, before any model fit)

Reason: section 5 names "mean log loss" without defining it, and the model specification was not fixed. Both are fixed
here before any fit, from the CPI V1 definitions, so nothing below is chosen on Employment validation scores. Only the
ledgers' integrity has been inspected so far (parse guards, gaps); no model, baseline or score has been computed.

1. **Gate metric.** Per forecast origin, the mean binary log loss over the threshold ladder (item 2), with the common
   1e-4 probability floor (as CPI V1). The gate compares the candidate with the best baseline on the mean of that
   per-origin score. 95% CI: moving-block bootstrap of the per-origin score difference, block 12, 2,000 replicates, seed
   20261008. PASS needs: CI lower bound > 0 against the best baseline, AND 80% central-interval coverage within
   [0.72, 0.88]. Brier, RPS over the full grid, exact-bucket log score, PIT, ECE and the 2020 split are reported but
   do not change the verdict.
2. **Ladders** (strictly-above events, matching Kalshi `greater`):
   - U-3: t = A - 0.6 ... A + 0.6 in 0.1 steps (13 events), A = the anchor in item 4 (Kalshi lists about A +/- 0.7).
   - Payrolls: t = -100,000 ... +300,000 in 25,000 steps (17 events; covers Kalshi's -25,000 ... 125,000 grid).
3. **Hyperparameters**: the CPI V1 values, unchanged and never tuned here: ridge lambda 2, Student-t nu 5, EWMA
   half-life 24 months, empirical window 60, rolling-mean window 12, minimum 36 training months.
4. **U-3 candidate `RIDGE_T_EWMA`**. Response: dU = U3(M) - A, where A = U3(M-1) as latest published at the cutoff.
   Features, each from first-published values available at the cutoff:
   - `CC_LOGCHG_REF`: log change in advance SA continuing claims, reference week of M vs reference week of M-1.
   - `IC4_LOGCHG_REF`: log change in the 4-week average of advance SA initial claims ending at the reference week,
     M vs M-1.
   - `DU_L1`: A - U3(M-2), both as latest published at the cutoff.
   The reference week is the Sunday-Saturday week containing the 12th (BLS survey reference week), named by its Saturday.
   A weekly value is the advance figure in the release for that week; its `available_at` is that release's embargo time.
   Distribution: discretized Student-t on the 0.1 published grid, as CPI V1.
5. **Payroll candidate `RIDGE_T_EWMA`** (fit only after U-3 is decided). Response: the first-print change (thousands).
   Features: `PAY_L1` (latest published change for M-1), `PAY_AVG3` (mean of the latest published changes for M-1..M-3),
   `IC4_LOGCHG_REF`, `CC_LOGCHG_REF`. Grid: 1,000 persons.
6. **Baselines** (identical origins, identical grid):
   - `PERSISTENCE_EMPIRICAL`: U-3 unchanged from A / payrolls = `PAY_L1`, with the 60-month empirical error kernel.
   - `ROLLING_MEAN_GAUSS`: 12-month rolling mean of the response.
   - `CLAIMS_ONLY`: `RIDGE_GAUSS` on `CC_LOGCHG_REF` and `IC4_LOGCHG_REF` only.
   - `employment-v0` (quarantined), U-3 only: fed every input explicitly from the as-published ledgers; an origin where
     any v0 input is missing is not scored for v0, and its fabricated defaults can never be reached. Scored on the
     ladder (Brier, log loss) only; eligible as "best baseline".
7. **Origins and folds.** Every Employment Situation reference month whose release is in the ledger, from the first
   month with 36 trainable prior months. Expanding window, refit at every origin. A training row is usable only if its
   own target release is at or before the origin's cutoff (fold guard throws otherwise).
8. **NO_FORECAST.** An origin where the anchor or any candidate feature is unavailable at the cutoff is excluded for
   every model and listed with its reason (shutdown months included). Nothing is imputed.
9. **Regime split.** 2020-03 .. 2021-12 vs all other origins, reported for every model.

## Amendment A2 (2026-10-08 14:45Z, ledgers frozen, before any model fit)

Reason: A1 does not state grid ranges or the payroll computation unit. Both are fixed here before any fit, and no score
of any model has been computed. Nothing in A1 changes.

1. **Grids.** U-3: 2.0 ... 16.0 on the 0.1 grid. Payrolls: -25,000,000 ... +5,000,000 persons on the 1,000-person grid
   (covers every first print since 2008, incl. April 2020). Tail mass folds into the end buckets, as in CPI V1.
2. **Payroll unit.** Payrolls are computed in units of 10,000 persons, so the CPI V1 0.1 grid step is exactly the A1
   1,000-person grid. This is a representation only: +50,000 persons = 5.0, strike 50,000 = 5.0, and "above" is decided
   on integer grid indices (the exact strike is NO).
3. **Frozen ledgers** (`data/employment/LEDGER_FREEZE.json`, hashes of the three ledgers and of every raw document).
   BLS: 224 releases 2008-01 .. 2026-09, 0 parse failures, 0 U-3 reprint mismatches (5 year-end SA revisions listed).
   DOL: 1,022 weekly releases (weeks ending 2006-12-30 .. 2026-10-03). Four archived documents are refused because of
   defects in the documents themselves, and nothing is inferred from them: 2011-11-23 (prints Thursday on a Wednesday),
   2012/010312 (a misfiled copy of the 2013-01-03 release with the year misprinted; the real copy parses), 2012-03-15
   ("Mach 3"), 2014/031514 (DOL placeholder file). Missing weeks: 2011-11-19, 2012-03-10, 2019-10-12 (absent from the
   DOL listing), and 2025-09-27 .. 2025-11-08 (federal shutdown: no releases in the archive).
4. **Reissued BLS releases** (archive keeps the reissued file). Each reissue note says the targets are unaffected:
   2008-06 (rounding of household levels; "no published rates were affected"; establishment data unaffected),
   2015-01 (table C only), 2019-11/2019-12 (veterans table A-5), 2020-01 .. 2020-08 (occupation tables A-8/A-9/A-13/A-14;
   "the official unemployment rate" not affected), 2025-04 (April 2025 household sample errors; "the unemployment rate"
   unaffected; release not updated). April 2020 payrolls: the archived file carries the May 11, 2020 correction; the
   first print is restored from the note in the file itself ("37,000 lower than initially reported"): -20,500k.
5. **2025 shutdown, from the archive.** September 2025 data released 2025-11-20 (not October). No October 2025 release.
   The November release (2025-12-16) prints October U-3 as not available (INPUT_UNAVAILABLE, never imputed) and the first
   October payroll change, -105k (later revised to -173k; the revision never replaces the first print). January 2026 data
   released 2026-02-11. Origins whose inputs fall in the gap are NO_FORECAST with the missing input named.

## Change log

- 2026-10-08: protocol written before any fit.
- 2026-10-08: Amendment A1 (metric definition, ladders, model and baseline specification), before any fit.
- 2026-10-08 14:45Z: Amendment A2 (grid ranges, payroll unit, frozen-ledger record), before any fit.
