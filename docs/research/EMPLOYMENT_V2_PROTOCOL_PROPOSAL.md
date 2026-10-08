# Employment V2 — protocol PROPOSAL (2026-10-08, design only)

Status: **PROPOSAL, not pre-registered.** It becomes the V2 protocol only on the owner's approval, and is then frozen and
committed before any V2 code is fit. No V2 model has been fit. Employment V1 is closed: KXU3 FAIL and KXPAYROLLS FAIL are
final (`EMPLOYMENT_V1_EVIDENCE.md`). V1 is not retuned, its gate is unchanged, and it is not deployed.

## 0. The constraint everything below is built around

V1's 2011-2026 walk-forward results are now known, and V2's hypotheses are derived from them. **Any V2 score on that same
history is therefore in-sample with respect to the design,** however chronologically it is computed. So:
- the **primary V2 gate is prospective**: releases published after the V2 freeze, never seen when V2 was designed;
- the 2011-2026 walk-forward is a **secondary sanity gate** (V2 must not be worse than V1's best baseline there). It can
  only block a V2 candidate, never pass one.

## 1. Why claims-only ties the U-3 candidate (from V1's committed outputs; no new fit)

- The V1 candidate = CLAIMS_ONLY + one term (last month's U-3 change, DU_L1). DU_L1's final coefficient is about -0.03 in
  standardized units: it carries almost no signal. Continuing and initial claims are 0.90 correlated, so the claims block
  is effectively one factor.
- By period, candidate minus claims-only (log-loss gain, share of origins won): 2011-14 +0.0021 (60%), 2015-19 +0.0023
  (67%), 2022-26 +0.0026 (50%), **2020-21 -0.0302 (36%)**. A tiny, consistent edge outside the pandemic, erased by 22
  pandemic months. DU_L1 is not a defensible addition on that evidence.
- What the V1 feature set lacks is information about where the published one-decimal rate sits inside its rounding
  bucket. That is the dominant source of uncertainty for a 0.1-grid target. Of the 193 usable ex-2020 months
  (2008-2026), 51 were unchanged and 80 moved +/-0.1.

**Defensible U-3 additions (a-priori, point-in-time available, free, BLS/DOL only):**
1. `U3_UNROUNDED_GAP`: the prior month's unrounded rate (Unemployed / Civilian labor force, first-print SA levels from the
   Employment Situation summary table A) minus the published one-decimal rate. Its availability was checked in all three
   archive eras (2008 text tables, 2015 and 2026 HTML). Its predictive value has **not** been examined.
2. `IUR_CHG_REF`: the change in the advance insured unemployment rate (DOL release, same document as continuing claims).
   This is the claims signal as a rate, so it is robust to labor-force growth.
3. Nothing proprietary (no ADP, Conference Board, Challenger), and nothing market-derived.

## 2. Payroll sensitivity to the pandemic (hypotheses only; no refit)

- Before 2020 the V1 payroll candidate **beat** the 12-month rolling mean (log-loss gain +0.095 in 2011-14, winning 88% of
  origins; +0.021 in 2015-19, winning 79%). From 2022 it lost badly: median absolute error 227k vs 74k.
- Mechanism: the expanding training window keeps -20.5M / +4.8M (2020) forever. The final ridge fit has residual sigma
  about 378k and sign-flipped, implausible coefficients. Persistence and rolling-mean baselines forget 2020 after 12-60
  months; the ridge never does.
- Robust candidates to pre-register (choose ONE before fitting, see 4.2): Huber loss with a MAD scale; a fixed exclusion
  window 2020-03..2021-12 for TRAINING ONLY (the scoring origins are never removed); or a rolling 60-month window.
- **Caveat that drives the recommendation:** the pre-2020 edge and the post-2022 collapse are both V1 results. A V2 robust
  payroll model will look good on 2022-2026 almost by construction. Only the prospective gate can say whether it is real.

## 3. Data (reuses the frozen V1 ledgers; additions are additive)

- Reuse `LEDGER_FREEZE.json` (BLS 224 releases, DOL 1,022 releases). Add the Table A levels (unemployed, civilian labor
  force) with the same parse guards: the narrative cross-check, and M+1 re-print consistency outside the January SA
  revision. Add the advance IUR from the DOL release. Both get their own hash, parser version and manual proof (10 cases),
  and the extended ledger is frozen before any fit.
- DOL reconciliation (complete): 1,028 archived files = 1,022 releases + 2 identical duplicates (the same release listed
  under two years: 2013-01-03 and 2013-08-01) + 4 refused defective documents. Missing weeks: 2011-11-19, 2012-03-10,
  2019-10-12, and 7 shutdown weeks (2025-09-27 .. 11-08). Nothing is imputed. No other category exists.
- Provenance limitation, carried into V2 unchanged: the April 2020 payroll first print (-20,500k) is restored from the
  correction note inside the archived (corrected) BLS file. No independent copy of the original was retrievable
  (Wayback 429). Every V2 payroll result is also reported with April 2020 excluded from scoring.

## 4. Frozen candidate families (exactly these; nothing added after the freeze)

### 4.1 U-3 (primary target)
| ID | Specification |
|---|---|
| U3-C1 | RIDGE_T_EWMA on `CC_LOGCHG_REF`, `IC4_LOGCHG_REF`, `U3_UNROUNDED_GAP` |
| U3-C2 | RIDGE_T_EWMA on `IUR_CHG_REF`, `U3_UNROUNDED_GAP` |
Hyperparameters are V1's (ridge 2, Student-t nu 5, EWMA 24, min 36), never tuned. The response, grid, ladder and strict
`>` semantics are V1's. Holm correction across the 2 candidates.

### 4.2 Payrolls (secondary; only if the owner approves continuing payrolls)
| ID | Specification |
|---|---|
| PAY-C1 | V1 payroll features, Huber loss (k = 1.345, MAD scale), Student-t errors with a robust EWMA scale |
One candidate only, so no tuning surface.

### 4.3 Baselines (identical origins and grid)
V1's four baselines (persistence, 12-month rolling mean, claims-only, and quarantined employment-v0 for U-3), **plus the
V1 candidate itself (frozen artifact)** and **V1 CLAIMS_ONLY as the incumbent to beat for U-3**.
Kalshi is reported as a separate descriptive column: the T-1D mid, scored on listed strikes, never a feature and never a
pass condition.

## 5. Gates (decided now; unchangeable after the freeze)

**Primary (prospective).** Every Employment Situation release after the V2 freeze. Each forecast is frozen at
T-1D 20:00 ET, its sha recorded before the release, and scored on the first print. This is research capture only, not a
production SHADOW lane.
- Minimum n = 24 releases. At about 12 a year, the earliest verdict is around October 2028. An interim look at n = 12 is
  descriptive only.
- PASS: mean ladder log-loss gain vs the best baseline > 0 with a one-sided 95% block-bootstrap bound (block 3) > 0,
  Holm-adjusted for U-3; 80% coverage in [0.72, 0.88]; PIT chi-square p > 0.01.

**Secondary (historical, blocking only).** 2011-2026 walk-forward on the frozen ledgers. The candidate's mean log loss
must be no worse than the best baseline + 0.005, and coverage must be in [0.72, 0.88].

**Calibration.** Reliability table (10 bins), ECE <= 0.05, PIT histogram, sharpness reported. The 2020-03..2021-12 split
is always reported, never excluded from scoring.

## 6. Independently auditable evidence

- Frozen inputs: ledger hashes and raw-document listing hashes (as V1). An auditor rebuilds the ledgers from the raw
  archive and gets identical hashes. V1 already reproduces byte-for-byte: both ledgers and both evidence files rebuilt
  identically on 2026-10-08.
- Frozen code: the git sha of the protocol commit, the candidate code and the evidence. `validate.mjs` refuses changed
  ledgers.
- Prospective forecasts: one JSON per release with the forecast sha, committed before the release time (the git commit
  time is the proof of before-release). A forecast committed after its release is void, never repaired.
- Tests: leakage (later release / revision / DOL revision), no market feature, DST by named zone, strict `>` at exact
  strikes. All V1 tests carry over.

## 7. What V2 explicitly does not do

No production table, cron lane, Worker path, SHADOW row or public output before a PASS and a separate owner approval. No
ADP. No Kalshi feature. No change to V1. No change to the pbe-predictions cron architecture. CPI SHADOW and its
2026-10-14 00:09Z freeze are untouched.

## 8. Market context (V1, descriptive; `employment-v1-kalshi-comparison.json`)

At the T-1D cutoff the Kalshi mid beats every V1 model: U-3 by about 0.10 log loss (39 events), payrolls by about 0.24-0.27
(31 events), with CIs excluding zero. The market at 20:00 ET the day before already prices ADP, ISM, JOLTS, the
Conference Board and the full claims path. The V2 additions in section 1 are small-signal refinements of the same
claims information. A V2 pass against baselines would be a research result. It would not close a 0.10 log-loss gap to
the market.

## 9. Recommendation: **HOLD**

- **U-3 V2: HOLD.** The design is ready to approve as written if the owner wants it on file. But V1's best model trails the
  market by 0.10, the defensible additions are marginal, and an honest verdict needs 24 prospective releases (around
  October 2028). Expected value is low. Cheapest option if the owner wants optionality: approve only the additive ledger
  extension (Table A levels + advance IUR, frozen, with manual proof). That is data work, no fitting, and it keeps the door
  open.
- **Payrolls V2: HOLD.** The only compelling hypothesis (robust estimation) comes from looking at V1's post-2020 collapse,
  so its historical test is contaminated. The market gap is about 0.25. No compelling reason to continue.
- **Product implication (owner decision):** under the house rule (no model -> MARKET MONITORING), the right public
  treatment for KXU3/KXPAYROLLS today is market monitoring with the verified settlement semantics, not a model. Note the
  October 2025 U-3 settlement at 4.4 on a month BLS never published.

