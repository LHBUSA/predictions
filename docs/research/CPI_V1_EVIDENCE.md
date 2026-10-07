# CPI V1: evidence packet (Phase 3)

Status: **research complete. Artifact frozen. NOT deployed, NOT published.**
Branch `cpi-v1`. Weather v2.1 / v2.2, BTC, rates, Fed v1, CALL policy and market comparison were not touched.

## 1. Data: what exists and where it came from

| Source | What | Point-in-time basis |
|---|---|---|
| BLS CPI news-release archive (`www.bls.gov/news.release/archives/cpi_MMDDYYYY.htm`) | 223 releases, reference months 2008-01 .. 2026-08 | Each release's own Table A is the vintage that existed at its embargo time. Nothing is backfilled from later releases. |
| BLS archive PDF `cpi_06162016.pdf` | 2016-05 release only: BLS serves a 0-byte HTML for it | Table 1 of the archived PDF: 3 SA months + the 12-month change. The PDF carries an erratum note but its numbers are as published. |
| EIA weekly retail gasoline `EMM_EPM0_PTE_NUS_DPG` | 1993-04-05 .. 2026-10-05, 1,749 weeks | A week is visible only from its date + 1 day 17:00 ET (EIA publishes Monday ~5 pm, Tuesday after a holiday). |

ALFRED/FRED vintages were the planned source. `fred.stlouisfed.org` and `alfred.stlouisfed.org` are unreachable from this workstation, and the FRED API key lives only as a Cloudflare secret. The BLS release archive is the primary source anyway: it holds exactly the one-decimal values Kalshi settles on.

**Coverage.** 223 releases. 2025-10 was never published (shutdown). 2025-11 was published with a 12-month change but **no** seasonally adjusted 1-month change.

**Release timestamps.** 203 come from the release's own embargo line. 20 use the archive filename date + 08:30 ET (the BLS standard). Those are 2008-01..2009-07, whose header layout the regex does not read, plus the 2016-05 PDF. All are DST-correct.

**Parser integrity.** Two independent guards run on every build and fail the parse:

- **Release text.** The Table A headline SA change must equal the number stated in the release's first sentence. 202 releases match. 20 are not checkable, because the 2008-2009 releases (and 2024-05) lead with the unadjusted change. 1 is not checkable because 2025-11 published no SA change.
- **Re-prints.** Release M+1 must re-print month M identically, except on January-data releases, when BLS revises seasonal factors. Result: 0 violations, and all 16 disagreements are on January-data releases.

**Bug found and fixed.** The first build had a one-column shift in 91 releases (2009-08..2017-05). Prose after the table contained the words "compound annual rate", so the parser dropped a column. Commit `81f3ac8` fixes it, and the two guards above now catch it. All numbers in this packet come from the corrected data.

## 2. Usable observations

Two forecast cutoffs per release. **T-1D** = 20:00 ET the day before the release; this is the primary horizon. **MONTH_END** = 23:59 ET on the last day of the reference month.

| Target | Kalshi series | Usable | Evaluated (walk-forward) | Window |
|---|---|---|---|---|
| headline CPI SA m/m | KXCPI | 218 | 182 | 2011-02 .. 2026-08 |
| core CPI SA m/m | KXCPICORE | 214 | 178 | 2011-02 .. 2026-08 |
| headline CPI NSA y/y | KXCPIYOY | 207 | 171 | 2012-01 .. 2026-08 |
| core CPI NSA y/y | KXCPICOREYOY | 207 | 171 | 2012-01 .. 2026-08 |

The first 36 usable observations of each target are training-only.

**Exclusions.** Every one is a missing input; nothing is imputed.

- 2008-01: first ledger month, so there is no earlier vintage.
- 2008-02..2008-12, y/y targets only: the base-month first print (M-12) predates the ledger.
- 2016-06, core m/m: C_AVG6 needs 6 months, and the 2016-05 PDF vintage has 3.
- 2025-11: SA m/m was not published, so the m/m target does not exist. For y/y, the M-1 inputs (Oct 2025) do not exist.
- 2025-12: the M-1 m/m (Nov 2025) was not published.
- 2026-01, 2026-02: the 3-month averages span the Oct/Nov 2025 gap.
- 2026-03..2026-05, core m/m: the 6-month average spans the gap.

**Forward consequence for SHADOW.** The y/y models need the M-12 first print. For reference months **2026-10 and 2026-11** that input is Oct 2025 (never published) or Nov 2025 SA (never published). CPI V1 therefore **cannot produce** KXCPIYOY / KXCPICOREYOY forecasts for the Oct and Nov 2026 releases. They resume with Dec 2026. M/m targets are unaffected.

## 3. Feature inventory (`cpi-features/1`)

| Feature | Definition | Source / as-of rule |
|---|---|---|
| H_L1, C_L1, F_L1, E_L1 | headline / core / food / energy SA m/m for M-1 | latest BLS release visible at cutoff (its Table A) |
| H_AVG3, C_AVG3 | mean SA m/m M-3..M-1 | same vintage only; never mixes vintages |
| C_AVG6 | mean core SA m/m M-6..M-1 | same vintage only |
| GAS_SA | 100 x log change of EIA monthly-average retail gasoline, M vs M-1, minus the mean same-calendar-month change of the previous 10 years | weeks visible at cutoff only; the seasonal norm uses only past years |
| H_YOY_L1, C_YOY_L1 | 12-month change for M-1 as first published (the y/y anchor) | release M-1 |
| H_BASE, C_BASE | SA m/m first print for M-12 (the month leaving the 12-month window) | release M-12 |

**Not used.** PPI and labor data were not added in V1: PPI is often released after CPI, and they were not needed to pass the gate. Shelter and gasoline CPI components were also left out: Table A lacks them before 2010, they were not needed, and they are documented for V2. Market prices are not a feature and are structurally absent.

**Leakage audit.**

- `asOfView()` drops every record published after the cutoff *before* feature code runs.
- `buildFeatures()` re-checks every input timestamp and throws `LEAK` on violation.
- It refuses any cutoff at or after the target release.
- Each observation stores per-input provenance: series, month, vintage release id, publishedAt. For EIA it stores the week range and the last availability stamp.

**Fake-feature quarantine.** `inflation-v0` (energyMoM ?? 0, shelterYoY ?? coreYoY) and `inflation-replay-features.js` (`energyMoM: 0`, `shelterYoY: coreYoY`) are marked QUARANTINED. Their math is unchanged so they remain an honest baseline. Nothing deployed imports them: `workers/model-inflation` and `workers/replay-macro` are undeployed stubs.

**Provenance caveat (the one open item).** EIA keeps no public vintage archive for the weekly retail gasoline survey. V1 uses the current EIA history, and the survey is published as final; corrections are rare and small. This is the only input not reconstructed from a dated vintage. The SHADOW runtime should store EIA weeks as first-seen rows, which makes the forward record fully vintage-true. The ablation without GAS_SA is reported below.

## 4. Model

One predictive distribution per release per target; no per-threshold models.

- **Location:** ridge regression on standardized features. The y/y targets model the change from the published M-1 rate.
- **Shape:** Student-t (nu = 5), with the scale taken from an EWMA (half-life 24 months) of training residuals.
- **Discretization:** mass on the published 0.1 grid, P(published = k) = F(k + .05) - F(k - .05).
- **Contracts:** every above / below / range / exact probability is a sum over that one mass vector, so all of them are coherent and monotonic by construction (tested).

Hyperparameters were declared before validation and **not tuned**: lambda = 2, nu = 5, half-life 24, minimum training 36. The one-at-a-time sensitivity check below moves Brier by at most 0.0010.

**Contract adapter** (`src/macro/cpi/contracts.js`, `cpi-contract-adapter/1`) is separate from the model.

- It maps KXCPI, KXCPICORE, KXCPIYOY and KXCPICOREYOY to their targets. All listed Kalshi CPI markets are `strike_type: greater` on the BLS one-decimal value (rules verified 2026-10-07).
- **No CPI contracts are ingested in Predictions today.** `pred_contracts` / `pred_events` have zero CPI rows, so the adapter was built from Kalshi's public series and market definitions.

## 5. Validation design

- Expanding window, refit at every release.
- Training rows = observations whose CPI release was published at or before the forecast row's cutoff. A fold guard throws on any violation.
- Threshold events:
  - m/m: "published > t" for t = -0.3..0.8.
  - y/y: t = anchor ± 0.5, where the anchor is known at the cutoff.
- Scores: Brier, binary log loss (common 1e-4 floor), RPS over the full grid, exact-bucket log score, MAE/RMSE of the median, predictive SD (sharpness), ECE, randomized PIT, and 80% interval coverage.
- Uncertainty: moving-block bootstrap (block 12, 2,000 reps, fixed seed) of the per-release score difference.

## 6. Results (T-1D; positive difference = candidate better; 95% CI)

### Headline m/m (KXCPI): candidate RIDGE_T_EWMA

| Model | Brier | Log loss | RPS | MAE | ECE |
|---|---|---|---|---|---|
| Climatology | .1282 | .4098 | .1660 | .223 | .039 |
| Persistence + Gaussian error | .1301 | .4239 | .1728 | .237 | .032 |
| Persistence + rolling empirical error | .1301 | .4275 | .1732 | .237 | .027 |
| Rolling-mean + Gaussian error | .1228 | .3879 | .1582 | .216 | .021 |
| **RIDGE_T_EWMA** | **.0690** | **.2267** | **.0874** | **.119** | **.011** |
| ablation: no gasoline | .1220 | .3923 | .1589 | .218 | .025 |

Brier gain vs the best baseline (rolling mean): +.0537 [.0378, .0655]. Log loss gain: +.161 [.109, .197].

### Core m/m (KXCPICORE): **gate FAIL**

| Model | Brier | Log loss | MAE | ECE |
|---|---|---|---|---|
| Climatology | .0714 | .2554 | .113 | .055 |
| Persistence + Gaussian | .0623 | .2168 | .101 | .008 |
| Rolling-mean + Gaussian | .0573 | .2182 | .102 | .022 |
| **RIDGE_T_EWMA** | **.0535** | **.1849** | **.092** | .025 |

- It beats climatology and both persistence baselines (CIs exclude 0).
- It does **not** reliably beat the 12-month rolling mean: Brier +.0038 [-.0023, .0109], log loss +.033 [-.006, .092].
- In 8 of 16 years it is worse than the best baseline, by up to 1.22x.

### Headline y/y (KXCPIYOY)

| Model | Brier | Log loss | RPS | MAE |
|---|---|---|---|---|
| Climatology | .2630 | .8894 | 1.040 | 1.333 |
| Persistence + Gaussian | .1613 | .4947 | .2093 | .287 |
| Rolling-mean + Gaussian | .1676 | .5082 | .2164 | .303 |
| inflation-v0 (quarantined) | .2434 | .8941 | - | - |
| **RIDGE_T_EWMA** | **.0708** | **.2292** | **.0912** | **.120** |
| ablation: no gasoline | .1295 | .4078 | .1662 | .220 |

- vs persistence: Brier +.0905 [.0765, .1024], log loss +.266 [.228, .295].
- vs inflation-v0: Brier +.173 [.120, .245].

### Core y/y (KXCPICOREYOY)

| Model | Brier | Log loss | MAE |
|---|---|---|---|
| Persistence + Gaussian | .0854 | .2978 | .134 |
| Rolling-mean + Gaussian | .0887 | .3058 | .140 |
| **RIDGE_T_EWMA** | **.0629** | **.2087** | **.106** |

vs persistence: Brier +.0225 [.0067, .0451], log loss +.089 [.026, .186].

**Other model families tested:**

- **RIDGE_GAUSS and RIDGE_EMPIRICAL:** same location as the candidate, with a different error shape. They are statistically tied with RIDGE_T_EWMA on Brier; the t/EWMA shape is consistently best on log loss and ECE.
- **MONTH_END horizon:** within 0.0008 Brier of T-1D on every target. All CPI inputs are already known at month end, and the gasoline month is at most a few days short.

## 7. Calibration

| Target | ECE (threshold events) | 80% interval coverage | PIT |
|---|---|---|---|
| headline m/m | .011 | .86 | flat (0.08-0.12 per decile) |
| core m/m | .025 | .91 | tilts high (0.05 -> 0.14): core prints above the median more often than predicted |
| headline y/y | .009 | .85 | flat |
| core y/y | .019 | .88 | mild high tilt |

Intervals are slightly wide, which is conservative. The core high-tilt is a known bias to watch in SHADOW.

## 8. Failure / regime analysis

Periods (headline m/m Brier, candidate vs best baseline):

| Period | Candidate | Best baseline |
|---|---|---|
| 2012-2020 calm | .061 | .108 |
| COVID 2020-03..2021-03 | .071 | .125 |
| surge 2021-04..2023-06 | .116 | .162 |
| 2023-07+ | .047 | .107 |

Inflation regime, by the trailing y/y known at the cutoff: the candidate beats the best baseline in low, moderate and high for headline m/m, headline y/y and core y/y.

Weak spots:

- **2021.** Headline m/m is 1.30x worse than the best baseline in calendar 2021. The worst misses were 2021-04 (0.8 actual vs 0.2 median), 2021-06 and 2021-10: the reopening surge, when a trend-following core input lagged the regime change.
- **Core m/m.** Slightly worse than the best baseline in the surge (1.05x) and in the high regime (1.04x). Not catastrophic, but no edge.
- **Core y/y.** Worse than the best baseline in 2017 (1.20x), when there was a one-off wireless-plan price drop.

No slice breaches the gate's 1.15x limit for period or regime slices with n >= 10.

**Controls:**

- **Random labels.** With training labels permuted (5 seeds), candidate Brier rises to .133 (headline m/m), .071 (core m/m), .229 (headline y/y) and .185 (core y/y), i.e. back to or worse than climatology or persistence. The skill comes from the real labels.
- **Sensitivity.** Lambda 0.5 / 8, half-life 12 / 48, nu 4 / 10: Brier moves by at most 0.0010 on any target.

## 9. SHADOW gate (declared in `validate.mjs`, applied per target on T-1D)

Criteria:

1. Brier and log-loss 95% CI lower bound > 0 vs every baseline.
2. ECE <= 0.05.
3. 80% coverage within 0.72-0.95.
4. No period or regime slice (n >= 10) above 1.15x the best baseline's Brier.

| Target | Gate |
|---|---|
| headline m/m (KXCPI) | **PASS** |
| headline y/y (KXCPIYOY) | **PASS** (not producible for the Oct and Nov 2026 releases; see section 2) |
| core y/y (KXCPICOREYOY) | **PASS** |
| core m/m (KXCPICORE) | **FAIL**: no reliable edge over the 12-month rolling mean |

## 10. Frozen artifact

`src/macro/artifacts/cpi-v1.json`

| Field | Value |
|---|---|
| model | `pbe-cpi-distribution`, `cpi-v1/1.0.0`, family RIDGE_T_EWMA, status `FROZEN_CANDIDATE_NOT_DEPLOYED` |
| feature version | `cpi-features/1` |
| contract adapter | `cpi-contract-adapter/1` |
| dataset | `cpi-v1-dataset/1`, sha256 `bcec5e6de6ca84bd559af0527f6e98c15bc579b7433310268f86cf05ff71e6d8` |
| release ledger | `data/cpi/bls-cpi-releases-v1.json`, sha256 `bef950b012f1c74c8988ad8492279460f300fd34cc00ed872f019285d5138f56` (parser `bls-cpi-table-a/1`) |
| EIA weeks | `data/cpi/eia-gasoline-weekly-v1.json`, sha256 `6749ab1f2acfdd6efb28ba7218bdf756e73d60267a8160edd1bfcc1780e569ae` |
| evidence | `docs/research/cpi-v1-evidence.json`, sha256 `77ac120548f6eb3355175334e00171e15723f2243ac267ddb30220fcf76309ef` |
| code SHA at freeze | `81f3ac8f3e21d77a6782ad3ad89d227341ec21f7` (clean) |
| training window | m/m 2008-02..2026-08 (n = 218 / 214); y/y 2009-01..2026-08 (n = 207) |
| market inputs | NONE |

Fitted coefficients (per 1 unit of feature):

- **headline m/m:** C_AVG3 +0.47, F_L1 +0.18, GAS_SA +0.045 per log-point, H_AVG3 -0.02, E_L1 +0.01; sigma 0.141.
- **headline y/y change:** H_BASE -0.88, C_AVG3 +0.46, F_L1 +0.18, GAS_SA +0.045; sigma 0.152.
- **core y/y change:** C_BASE -0.85, C_L1 +0.73, C_AVG3 -0.21; sigma 0.157.

The signs match the arithmetic of the 12-month window and the energy pass-through.

`predictFromArtifact()` reproduces a refit on the same rows to 1e-9 (tested).

**Freeze semantics.** Coefficients and scale are fixed. The validated procedure refit monthly, and a new artifact version is needed to absorb new releases. That is an owner decision.

## 11. Reproduce

```
node scripts/research/cpi/parse-bls-releases.mjs <raw-release-dir> data/cpi/bls-cpi-releases-v1.json <pdf-text-dir>
node scripts/research/cpi/parse-eia-gasoline.mjs <eia LeafHandler.html> data/cpi/eia-gasoline-weekly-v1.json
node scripts/research/cpi/build-dataset.mjs
node scripts/research/cpi/validate.mjs        # deterministic: identical evidence sha on rerun
node scripts/research/cpi/freeze-artifact.mjs
node --test test/cpi-v1.test.js
```

Raw downloads, kept outside git: `D:\Workers\scratch\predictions-cpi\raw\`. They hold 223 HTML files, 1 PDF + pdftotext output, and the EIA page. The sha256 of each is recorded in the ledger.

## 12. Recommendation

**READY FOR SHADOW** for KXCPI (headline m/m), KXCPIYOY (headline y/y) and KXCPICOREYOY (core y/y).
**CONTINUE RESEARCH** for KXCPICORE (core m/m).

Before a SHADOW runtime (owner approval required):

1. Capture EIA weekly prices as first-seen rows.
2. Ingest CPI events/contracts into `pred_*`. There are none today.
3. Write SHADOW rows to `pred_forecasts_shadow` only.
4. Declare that the y/y lanes are dark for the Oct and Nov 2026 releases.
5. Compare against Kalshi only later, as a timestamp-compatible external benchmark.
