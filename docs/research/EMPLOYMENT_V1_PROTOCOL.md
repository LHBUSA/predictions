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

## Change log

- 2026-10-08: protocol written before any fit.
