# prediction-decision-v1: holdout evidence (DRAFT, for owner approval)

> **Owner decision 2026-10-04 — APPROVED WITH ACTIVATION GATE.** Rain candidate frozen as `rain-v1-candidate`
> (`src/engine/decision.js`, status `FROZEN_PROSPECTIVE`, frozen_at 2026-10-04T13:21:00Z, `activated_at: null`):
> pbe-weather-precip, T = 0.70, HIGH only, no YES Jun–Sep, NEAR_CERTAIN ≥ 0.97 = PASS, 12 h freshness, current
> resolution rules. Parameters pinned by hash in `test/decision.test.js`; any change = a new candidate version.
> Public CALL stays OFF (official = false until activation). Valid-but-unvalidated models = `PASS · MODEL_NOT_VALIDATED`;
> HOLD only when PBE cannot evaluate (rules, data, staleness, integrity, domain). Station-skill grade now reads
> training-period skill (`src/weather/artifacts/precip-station-skill-train-v1.json`; golden outputs byte-identical).
> Promotion evidence: one FINAL_PRE_RESOLUTION decision per contract captured after the freeze, decided as of its
> capture time (`/admin/decisions/prospective`). 100 resolved calls = diagnostic only; 300 resolved calls on >= 30
> distinct resolution dates = owner promotion review (date-clustered CIs). Fail = candidate recorded as failed; V2 separate.

Status: research evidence only. Nothing here is deployed, and nothing writes to a DB. Generated 2026-10-04.
Owner rule: **Facts create the PBE probability. Kalshi and Polymarket benchmark it afterward.** No market or venue price, quote, volume or settlement is read anywhere in this evidence. Bucket grids for max-temp are synthetic, and strikes for rates are synthetic. Both are built from facts (guidance / last published yield), never from venue data.

Machine-readable twin: `docs/research/decision-policy-v1-evidence.json`.

---

## 1. Bottom line

| Family | Skill-validated (BSS CI > 0 vs every baseline, n_dates ≥ 180) | CALL justified by decision-level holdout? | Draft decision |
|---|---|---|---|
| `pbe-weather-precip` @1.1.0 (+1.0.0 fallback) | **Yes.** BSS 0.515 [0.493, 0.536] vs climatology; 0.065 [0.052, 0.077] vs raw NWS PoP; 457 dates | **Yes, with limits** | CALL at **T = 0.70**, **HIGH** grade only, **NEAR_CERTAIN ≥ 0.97**. **No YES calls in Jun–Sep** (warm-season YES calls are overconfident by 3–7 pts). |
| `pbe-weather-maxtemp` @1.1.0 | **Yes, for the probabilities.** Event BSS 0.327 [0.319, 0.335] vs climatology; 0.014 [0.012, 0.016] vs Normal-error model | **No** | **No CALLs in v1.** Publish probabilities only. YES calls are badly overconfident. NO calls are calibrated but hit less often than the trivial "every bucket NO" rule (82.5 % vs 83.3 %). |
| `pbe-rates-path` @1.0.0 | **No.** BSS vs named Gaussian baseline 0.019 [−0.003, 0.042]; 105 month clusters | No | PASS: `MODEL_NOT_VALIDATED` |
| `pbe-fed-decision` @1.0.0 (SHADOW) | **No.** BSS vs climatology 0.016 [−0.129, 0.146]; 85 meetings (< 180); top-outcome accuracy 56.5 % vs always-hold 65.9 % | No | PASS: `MODEL_NOT_VALIDATED` |

Read these together with the caveats in §9. In short:
- A calibrated model passes the owner's example criterion at the lowest threshold tried (0.55). That criterion therefore cannot choose T. T = 0.70 comes from the second pre-stated criterion: the weakest calls must be right at least 65 % of the time.
- The two refinements for precip (HIGH floor, warm-season YES exclusion) were written **after** I had looked at the final window. The selection window supports both of them on its own (numbers in §4), but the final check is no longer untouched for those two rules.

---

## 2. Data, splits and point-in-time rules

| Family | Training (artifact fit) | Holdout used here | Selection window (choose T) | Final untouched window | Cases | Dates / clusters |
|---|---|---|---|---|---|---|
| precip | climate dates 2023-01-03 .. 2025-06-30 (`TRAIN_END = 2025-07-01`, `wx-train.mjs`, `wx-train-nbm.mjs`) | 2025-07-01 .. 2026-09-30 | 2025-07-01 .. 2026-06-30 (45,224 cases) | 2026-07-01 .. 2026-09-30 (11,408 cases) | 56,632 (52,896 v1.1 + 3,736 v1.0 fallback) | 457 dates |
| max temp | 2023-01-03 .. 2025-06-30. The v1.1 guidance choice was made on 2025-01..06 validation (`wx-temp-eval.mjs`, `wx-temp-nbm.mjs`) | 2025-07-01 .. 2026-09-30 | same as precip | same as precip | 56,668 events = 340,008 bucket contracts (all v1.1. Every holdout case had a fresh NBM day max.) | 457 dates |
| rates | residuals 1962–2017; λ chosen on 2000–2017 (`rates-train.mjs`) | months 2018-01 .. 2026-09 | 2018-01 .. 2026-06 | 2026-07 .. 2026-09 (only 3 month clusters) | 13,123 | 420 forecast dates / **105 month clusters** |
| fed | meetings 1994–2015 (`fed-train.mjs`) | meetings 2016-01 .. 2026-09-16 | n/a (too small) | n/a | 425 | 85 meetings |

Reproduction check. The regenerated per-case predictions reproduce the committed artifact holdout numbers exactly:
- precip v1.1: Brier 0.0864 / GFS-only 0.0920 / raw NBM 0.0925 / climatology 0.1787 on 52,896 cases.
- max-temp: 56,668 cases.
- rates: Brier 0.1706 vs artifact 0.1704. The small gap comes from using the deployed thinned residuals and 4,000 paths. The Gaussian baseline is 0.1740 vs 0.1741.

Point-in-time rules (identical to the training scripts and the engine):
- Weather forecast cutoffs are 6 / 18 / 30 / 42 h before the CLI window opens.
- A MOS or NBM run is usable only at cycle + 5 h (`latestRunAtOrBefore`).
- NBM is used only if it is ≤ 24 h old at the cutoff. If not, the engine falls back to v1.0, exactly as `forecastWeather` does.
- Climatology uses 1991–2020 only.
- Confidence grades come from the engine's own rules: `gradeQuality` (wx-quality/1) for precip, and the temp rule with its disagreement downgrade.
- `p` is the **published** probability (rounded to a whole percent), which is what the decision layer will see.
- Rates use the deployed artifact (λ = 0.97, thinned 1962–2017 residuals, 4,000 paths, bounds [0.01, 0.99]), synthetic strikes y0 ± {2, 6, 12, 20, 30} bp, and forecast points k = 0/3/8/13 published days. Contracts already decided by the published path are excluded.
- Fed uses the committed artifact params, with features taken from H.15 values dated ≤ cutoff − 2 days.

Uncertainty method:
- **Cluster bootstrap, B = 2000, resampling whole dates.** Weather resamples climate dates. All stations and leads of a day move together. Rates resample contract months, because every forecast in a month shares one realized path. Fed resamples meetings.
- BSS = 1 − Brier_model / Brier_baseline. Log-loss delta = baseline − model, so positive means the model is better.

Holdout leakage found in production grading: the production precip grade (`gradeQuality`) uses per-station skill taken from **precip-v1 holdout** `by_station`. I recomputed the same statistic from the training period only. It produces **identical grades for all 56,632 cases**, because every station has skill ≥ 0.15 and n ≥ 300 either way. The leak therefore has no effect on these results. It should still be fixed (source station skill from training or a rolling window).

Scripts (new, research only, nothing existing was modified). All are under `scripts/research/decision/`:
- `dp-wx-cases.mjs`: weather per-case holdout predictions.
- `dp-rates-cases.mjs`, `dp-fed-cases.mjs`: the same for rates and fed.
- `dp-analyze.mjs`: skill, threshold tables, selection.
- `dp-policy-check.mjs`: scores the draft policy variants.
- `dp-build-evidence.mjs`: writes the JSON.

Per-case outputs are in `D:\Workers\scratch\predictions-decision\` (`*-cases.jsonl`, `analysis.json`, `policy-check.json`, `tables.md`).

---

## 3. Model validation status

Validation rule used: a family is "skill-validated" if the 95 % CI lower bound of BSS is > 0 against **every** listed baseline AND n_dates ≥ 180.
- Weather baselines: climatology AND the strongest naive reference (raw NWS PoP for precip; a Normal error model on the same guidance and tables for temp).
- Rates baselines: the named Gaussian trailing-vol baseline AND training climatology.

"Validated for CALL" also requires the decision-level evidence in §4–§7 to support calls.

| Family | Baseline | Model | Baseline score | BSS [95 % CI] | Log-loss Δ [95 % CI] |
|---|---|---|---|---|---|
| precip | climatology | 0.0877 | 0.1808 | **0.515 [0.493, 0.536]** | 0.259 [0.247, 0.272] |
| precip | raw NWS PoP (NBM if present, else GFS) | 0.0877 | 0.0938 | **0.065 [0.052, 0.077]** | 0.020 [0.016, 0.024] |
| precip | its own v1.0 GFS-only model | 0.0877 | 0.0929 | 0.056 [0.046, 0.067] | 0.017 [0.014, 0.020] |
| precip, final 3 mo | raw PoP | 0.0994 | 0.1038 | 0.042 [0.017, 0.067] | 0.014 [0.006, 0.021] |
| max temp (event, multiclass Brier) | climatology Normal | 0.754 | 1.121 | **0.327 [0.319, 0.335]** | 0.857 [0.825, 0.888] |
| max temp (event) | Normal error model | 0.754 | 0.765 | **0.014 [0.012, 0.016]** | 0.022 [0.019, 0.026] |
| max temp, Kalshi-7 stations | Normal error model | 0.751 | 0.763 | 0.016 [0.013, 0.020] | 0.027 [0.021, 0.033] |
| rates | **Gaussian trailing vol (named)** | 0.1707 | 0.1740 | **0.019 [−0.003, 0.042]**. Fails. | 0.006 [−0.007, 0.019] |
| rates | training climatology (dir × offset × k) | 0.1707 | 0.1766 | 0.034 [0.004, 0.065] | 0.013 [−0.006, 0.030] |
| rates, 2023-01..2026-09 | Gaussian | 0.1773 | 0.1805 | 0.018 [−0.003, 0.038] | 0.008 [−0.004, 0.019] |
| fed | climatology | 0.523 | 0.532 | 0.016 [−0.129, 0.146]. Fails. | 0.200 [0.053, 0.347] |
| fed | persistence | 0.523 | 0.570 | 0.083 [0.030, 0.132] | 0.165 [0.097, 0.235] |

Precip skill by grade and lead (vs raw PoP):
- HIGH: 0.048 [0.037, 0.058]. MEDIUM: 0.132 [0.092, 0.169].
- By lead: 6 h 0.069, 18 h 0.060, 30 h 0.071, 42 h 0.060. All have CI lower bound > 0.

Temp skill vs Normal is positive in every grade and lead slice (full tables in the appendix).

Rates: only 30Y (0.032 [0.010, 0.054]) and k = 3/8 clear the Gaussian baseline. That pattern is not enough to validate the family.

---

## 4. Precipitation: calls

Definitions:
- CALL YES if p ≥ T. CALL NO if p ≤ 1 − T.
- The CALL zone excludes near-certain cases (max(p, 1−p) ≥ 0.97). Those are labeled NEAR_CERTAIN.
- "Weakest band" means calls with T ≤ max(p, 1−p) < T + 0.05.
- Calls/day is per forecast snapshot (31 CLI stations, one lead).
- Hit CIs are date-cluster bootstrap.

**Selection window 2025-07-01..2026-06-30, all grades:**

| T | calls | calls/day/snap | hit % [95% CI] | mean p | gap | YES n · hit/p | NO n · hit/p | weakest band n · hit [CI] | BSS of called vs clim / raw PoP | share of all calls ≥.95 / ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 22313 | 15.3 | 79.9 [78.8, 80.9] | 80.4 | -0.6 | 8374 · 75.7/77.5 | 13939 · 82.4/82.2 | 1565 · 59.4 [56.7, 62.1] | 0.402 / 0.071 | 55.1 / 48.7 |
| 0.60 | 20748 | 14.2 | 81.4 [80.4, 82.5] | 82.2 | -0.8 | 7536 · 77.7/79.8 | 13212 · 83.5/83.6 | 1755 · 63.5 [60.6, 66.4] | 0.423 / 0.068 | 57.1 / 50.5 |
| 0.65 | 18993 | 13.0 | 83.1 [82.0, 84.1] | 84.0 | -1.0 | 6692 · 79.6/82.0 | 12301 · 84.9/85.2 | 1837 · 65.8 [63.2, 68.3] | 0.450 / 0.068 | 59.6 / 52.7 |
| **0.70** | 17156 | 11.8 | 84.9 [83.8, 86.0] | 85.9 | -1.0 | 5827 · 81.8/84.3 | 11329 · 86.5/86.7 | 2067 · 69.2 [66.6, 71.8] | 0.481 / 0.070 | 62.5 / 55.2 |
| 0.75 | 15089 | 10.3 | 87.1 [86.0, 88.1] | 87.8 | -0.7 | 4946 · 84.6/86.5 | 10143 · 88.3/88.4 | 2298 · 76.1 [73.7, 78.6] | 0.527 / 0.072 | 66.0 / 58.4 |
| 0.80 | 12530 | 8.6 | 89.3 [88.2, 90.3] | 89.9 | -0.6 | 3985 · 87.0/88.7 | 8545 · 90.4/90.5 | 2160 · 79.9 [77.8, 82.1] | 0.581 / 0.074 | 71.0 / 62.8 |
| 0.85 | 10370 | 7.1 | 91.2 [90.2, 92.2] | 91.5 | -0.3 | 3009 · 89.5/90.9 | 7361 · 92.0/91.7 | 3179 · 85.8 [84.0, 87.6] | 0.626 / 0.085 | 75.9 / 67.1 |

The HIGH-only and full-holdout versions are in the appendix. HIGH-only is about 0.5 pt better calibrated at every T.

**Threshold selection.** Both criteria were stated before the band statistics were computed.
- **Criterion A** (owner example): smallest T with n_calls ≥ 300 AND hit-rate CI lower bound ≥ mean p − 3 pts. In addition, each side (YES/NO) with ≥ 50 calls must be within 5 pts. → **T = 0.55, ALL grades.** The model is calibrated in aggregate, so A binds at the lowest T. A is a calibration test, not a threshold chooser.
- **Criterion B**: A, plus the weakest band must be right ≥ 65 % at the CI lower bound (band n ≥ 100). → **T = 0.70, ALL grades.** The [0.65, 0.70) band has lower bound 63.2 %. The [0.70, 0.75) band has lower bound 66.6 %.
- Choosing the confidence filter: the most inclusive filter (ALL > HIGH+MEDIUM > HIGH) that has a qualifying T.

**Final untouched check (2026-07-01..09-30) at the mechanical choice (ALL, T = 0.70):**
- 4,866 calls, 13.2 per snapshot-day.
- Hit 84.4 % [82.4, 86.4] vs mean p 85.6 %.
- The CI lower bound misses mean p − 3 pts by 0.3 pt, so **the calibration criterion fails narrowly.**
- Cause: YES calls hit 80.3 % vs 83.5 %. NO calls are fine: 86.3 % vs 86.6 %.

What drives it. These diagnostics come from the selection window alone, at T = 0.70:

| Slice | YES n | YES hit vs mean p | NO hit vs mean p |
|---|---|---|---|
| selection, cool Oct–May | 3,845 | **85.2 vs 85.2** | 86.4 vs 86.8 |
| selection, warm Jun–Sep | 1,982 | **75.3 vs 82.5 (−7.1)** | 86.7 vs 86.6 |
| final, warm Jul–Sep | 1,530 | 80.3 vs 83.5 (−3.3) | 86.3 vs 86.6 |
| grade MEDIUM (selection) | 515 | 71.1 vs 79.4 (−8.3) | overall 76.9 vs 81.5 |
| lead 42 h (selection) | 1,465 | 79.4 vs 83.8 (−4.4) | 86.9 (n 3,509) |

The warm-season (convective) YES overconfidence also appears in the same-season slice of the selection window, Jul–Sep 2025: 69.9 % vs 74.7 % at T = 0.55, and 73.2 % vs 81.9 % at T = 0.70. In other words it is a stable seasonal bias and not just bad luck in the final window.

**Draft-policy variants** (`dp-policy-check.mjs`; calls exclude NEAR_CERTAIN):

| Variant | Selection: calls · hit [CI] / mean p | Final: calls · hit [CI] / mean p | Final meets rule |
|---|---|---|---|
| ALL, T 0.70, YES year-round (mechanical B) | 17,156 · 84.9 [83.9, 86.0] / 85.9 | 4,866 · 84.4 [82.4, 86.4] / 85.6 | no (−0.3 pt) |
| HIGH, T 0.70, YES year-round | 15,335 · 85.9 [84.8, 87.0] / 86.4 | 4,201 · 85.1 [82.9, 87.2] / 86.3. YES 80.8/84.0 | no |
| **DRAFT: HIGH, T 0.70, no YES in Jun–Sep** | 13,502 · 87.2 [86.0, 88.3] / 86.9. YES 86.4/85.7 · NO 87.5/87.3 | 2,803 · 87.2 [85.1, 89.2] / 87.4. NO only (final window is all warm season) | yes |
| sensitivity: same at T 0.75 | 12,168 · 88.9 / 88.5 | 2,532 · 88.6 / 89.0 | yes |

Volume under the draft: about 9.2 calls per snapshot-day across 31 stations in the selection window (cool season has YES and NO; warm season has NO only). Separately, about 45 % of all precip cases are NEAR_CERTAIN (max ≥ 0.97, mostly dry-day NO). Those hit 99.3 % at mean 97.9 %, so they are trivial and correctly not CALLed.

Calibration was stable by month (appendix). The worst month was 2026-08: −3.6 pts at T = 0.55.

---

## 5. Max temperature: calls

Setup:
- Synthetic Kalshi-shape events with 6 exclusive outcomes: ≤L−1, four 2 °F buckets, ≥L+8. L = round(GFS MOS max) − 4. This matches the shape of live KXHIGH events, e.g. Austin 2026-10-04: "79 or below … 88 or above".
- Each bucket is scored as a binary contract.
- Grades: HIGH 24,412 events, MEDIUM 32,256, LOW 0.

**Contract level, selection window, HIGH only.** This is what the mechanical criteria select, because ALL fails the YES-side check.

| T | calls | calls/day/snap | hit % [CI] | mean p | YES n · hit/p | NO n · hit/p | weakest band n · hit [CI] | BSS called vs clim / Normal | share ≥.95 / ≥.97 |
|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 97,488 | 66.8 | 81.6 [81.5, 81.7] | 81.6 | 367 · 55.6/56.0 | 97,121 · 81.7/81.7 | 1,165 · 61.3 [58.2, 64.5] | 0.319 / 0.018 | 24.7 / 15.1 |
| 0.60 | 96,323 | 66.0 | 81.8 | 81.9 | 0 | 96,323 · 81.8/81.9 | 2,957 · 61.7 [59.6, 63.6] | 0.319 / 0.018 | 24.9 / 15.3 |
| 0.65 | 93,366 | 63.9 | 82.5 [82.4, 82.6] | 82.5 | 0 | 93,366 · 82.5/82.5 | 11,938 · 66.4 [65.3, 67.5] | 0.323 / 0.017 | 25.6 / 15.7 |
| 0.70 | 81,428 | 55.8 | 84.8 | 84.7 | 0 | 81,428 · 84.8/84.7 | 13,871 · 70.2 | 0.339 / 0.014 | 28.7 / 17.6 |

Mechanical selection:
- Criterion A → HIGH, T = 0.55. **Its final check fails**: YES calls hit 41.6 % vs 56 % (n = 89).
- Criterion B → HIGH, T = 0.65, which is **NO calls only**. The final check passes in aggregate: 82.5 % vs 82.6 %.

Why I still recommend **no temp CALLs in v1**:
1. **YES is broken.**
   - At HIGH grade no bucket ever reaches p ≥ 0.60.
   - Across all grades, the modal bucket hits 35.1 % (mean modal p 38.0 %).
   - Modal-only CALL YES (the event-level variant), selection window:
     - HIGH, p ≥ 0.40: 43.0 % vs 46.9 %. p ≥ 0.55: 55.6 % vs 56.0 % (n = 367).
     - ALL, p ≥ 0.55: 52.7 % vs 71.3 %. p ≥ 0.70: 60.4 % vs 83.3 %.
   - Final window: HIGH p ≥ 0.40: 38.8 % vs 46.6 %. ALL p ≥ 0.70: 50.7 % vs 81.8 %.
   - High-p YES comes almost entirely from NBM vs GFS disagreement ≥ 4 °F: 4,873 of 5,810 cases with p ≥ 0.55. Those hit **51 % vs 74 %**. v1.1 trusts the NBM error table and ignores GFS. This is the same failure mode as the 2026-10-04 LA diagnostic.
2. **NO adds no hit-rate value.**
   - The trivial rule "CALL NO on every bucket" hits **83.3 %** by construction. PBE NO calls at T = 0.65 hit **82.5 %**.
   - By bucket (HIGH, T = 0.65): the two central buckets are overconfident, b2 75.8 vs 78.8 and b3 70.8 vs 75.4 (beyond the 3-pt tolerance). The tails are underconfident, 90–94 vs 86–90. The aggregate pass comes from these errors cancelling.
3. The probabilities are skilled and should keep being published. A public "CALL" label on a temp bucket would overstate what the evidence shows.

Near-certain bucket contracts (max ≥ 0.97) are 17.5 % of cases and hit 96.9 % at mean 98.2 %. The far-tail p = 0.01 contracts come true about 2 % of the time, so the tails are somewhat overconfident. That is another reason to label them NEAR_CERTAIN rather than CALL.

Fix path, not done here: event-level recalibration that blends GFS and NBM, or widens the error table under disagreement. Then rerun this evidence.

---

## 6. Rates: calls (for completeness; family not validated)

Selection window 2018-01..2026-06, all cases HIGH. In replay, forecasts are made right after publication.

| T | calls | per forecast date | hit % [CI] | mean p | YES n · hit/p | NO n · hit/p | weakest band n · hit [CI] | share ≥.97 |
|---|---|---|---|---|---|---|---|---|
| 0.55 | 10,297 | 25.2 | 75.1 [73.1, 77.0] | 74.7 | 3,818 · 68.0/69.7 | 6,479 · 79.2/77.7 | 1,166 · 57.0 [54.1, 59.7] | 10.4 |
| 0.70 | 6,603 | 16.2 | 82.2 [79.8, 84.7] | 81.8 | 2,021 · 75.1/76.9 | 4,582 · 85.3/83.9 | 1,384 · 71.2 [68.1, 74.2] | 15.4 |
| 0.80 | 3,565 | 8.7 | 87.6 [84.7, 90.5] | 87.6 | 618 · 79.9/81.7 | 2,947 · 89.2/88.9 | 1,275 · 83.1 | 25.2 |

Calls look calibrated in aggregate (criterion B would pick T = 0.70). The family still fails on skill:
- BSS of the called subset vs Gaussian is only about 0.02.
- At k = 0, calls are −2.5 pts and near-strike YES calls (−2 / −6 bp offsets) are about −7 pts.
- The tails are overconfident: max ≥ 0.97 hits 95.3 % vs 98.2 %.
- The final 3 months (3 clusters, statistically uninformative) hit 65.8 % vs 76.2 %.

Verdict: **MODEL_NOT_VALIDATED.**

## 7. Fed (SHADOW)

- Top-outcome accuracy 56.5 % vs always-hold 65.9 %.
- Only 85 meeting clusters.
- When the top outcome has p ≥ 0.6: 287 calls, 74 % hit vs 85 % mean p, i.e. overconfident.

Verdict: **MODEL_NOT_VALIDATED.**

---

## 8. Recommended DRAFT `prediction-decision-v1`

Decision inputs are allowlisted: probability, grade, model id/version/state, data-cutoff time, contract status, and the **climate month of the contract date** (a contract term, not a market field). No venue fields.

Evaluation order (first match wins):

| # | Condition | State · reason |
|---|---|---|
| 1 | contract not NORMALIZED (UNMODELABLE / HOLD_RESOLUTION_AMBIGUOUS / UNSUPPORTED_DOMAIN), or the family's settlement source is not proven (weather: TWC == NWS CLI verified 112/112 + 40/40; a CLI station outside the verified set is held) | HOLD · RESOLUTION_NOT_PROVEN |
| 2 | engine returned no complete forecast (INCOMPLETE_GUIDANCE, NO_PUBLISHED_GUIDANCE, INCOMPLETE_INPUTS) | HOLD · INSUFFICIENT_SOURCE_DATA |
| 3 | evidence older than the family limit (weather: run age > 12 h, the age HIGH requires; rates: Treasury print > 1 business day) | HOLD · STALE_EVIDENCE |
| 4 | family not validated for CALL: maxtemp, rates, fed | PASS · MODEL_NOT_VALIDATED |
| 5 | grade below the family floor (precip floor HIGH; MEDIUM calls are −4.6 pts) | PASS · INSUFFICIENT_CONFIDENCE (or STALE_EVIDENCE if the downgrade came from run age / lead) |
| 6 | max(p, 1−p) ≥ **0.97** | PASS · NEAR_CERTAIN (scored, not called) |
| 7 | 1 − T < p < T, with **T = 0.70** for precip | PASS · WITHIN_UNCERTAINTY_BAND |
| 8 | precip p ≥ T and the contract climate month is in Jun–Sep | PASS · MODEL_NOT_VALIDATED (scope: warm-season YES) |
| 9 | otherwise | CALL YES (p ≥ T) / CALL NO (p ≤ 1 − T) |

Per family (JSON `families.<id>.recommended`):
- **pbe-weather-precip**: `{threshold: 0.70, confidence_floor: "HIGH", near_certain_cutoff: 0.97, scoped_exclusions: [YES in months 06–09]}`. Expected performance:
  - cool season about 86 % YES / 87 % NO hit at about 86–87 % mean p.
  - about 9 calls per snapshot-day across 31 stations (about 7.6 NO-only in summer).
- **pbe-weather-maxtemp**: `{threshold: null, confidence_floor: "HIGH", near_certain_cutoff: 0.97, allow_call: false}`. The mechanical option, if the owner overrides, is HIGH, T = 0.65, NO-only, modal YES forbidden. I do not recommend it (§5).
- **pbe-rates-path**: `{threshold: null}`, MODEL_NOT_VALIDATED. If it is ever validated, the mechanical candidate is T = 0.70.
- **pbe-fed-decision**: `{threshold: null}`, MODEL_NOT_VALIDATED.

Lead time: precip skill and call calibration hold at all tested leads (6–42 h). The HIGH grade already requires run lead ≤ 54 h. No extra lead rule is needed, but 42 h YES calls are the weakest (−4.4).

Implementation notes for `src/engine/decision.js` (in progress in the working tree; I did not touch it):
- It needs a season scope for precip YES, i.e. a contract-month input.
- `max_evidence_age_h: 30` there is looser than the 12 h run age the HIGH grade assumes. Grade and stale-evidence semantics should agree.

---

## 9. Caveats (read before approving)

1. **Zero live resolutions.** Everything here is a historical replay with the deployed code paths. The first natural settlement is 2026-10-05. The live track record must re-confirm the precip numbers before CALL loses DRAFT. Suggested trigger: ≥ 300 resolved CALLs; reassess at 100.
2. **The final check was not perfectly untouched for the precip refinements.** I saw the final-window results before adding the HIGH floor and the warm-season YES exclusion. Both rules are supported by selection-window data alone (MEDIUM −4.6 pts; warm YES −7.1 pts). Because the final window is entirely Jul–Sep, the draft's final check tests **only NO calls**. Cool-season YES has no untouched check at all: its evidence is Oct 2025–May 2026 inside the selection window.
3. **Seasonality.** The holdout covers 15 months: one cool season (Oct 2025–May 2026) and two warm seasons. Every cool-season conclusion therefore rests on a single winter, and the final window (Jul–Sep 2026) cannot test cool-season behaviour at all.
4. **Synthetic contracts.** Temp buckets are anchored on GFS guidance. Real grids are anchored on the venue's expectation, which on the evidence of §5 will likely make the NBM-over-trust problem *worse*, not better. Rates strikes are y0 ± fixed offsets. Live Kalshi strikes differ.
5. **Calls per snapshot.** A live contract is re-forecast every 15 min. The numbers here count one snapshot per lead. The scoring designations (FIRST_PUBLISHED / T−24H / FINAL) will see a different, but correlated, mix.
6. **Within-day correlation.** Weather calls across 31 stations on one day are correlated. Date-cluster CIs account for this, but effective sample sizes are much smaller than the case counts suggest (457 dates; 92 in the final window).
7. **Grade leakage.** The production precip grade reads station skill from the holdout. It had zero effect here (identical grades with training-period skill) but should be fixed.
8. **The calibration criterion cannot choose T.** T = 0.70 rests on the pre-stated "weakest calls ≥ 65 % right" product rule. If the owner wants a different meaning of CALL (e.g. ≥ 75 %), use the band column. T = 0.75 gives the weakest band 76.1 % [73.7, 78.6] for precip.

---

## Appendix: full generated tables (`dp-analyze.mjs` → `tables.md`)

Columns: "calls (CALL zone)" excludes max(p, 1−p) ≥ 0.97; "calls incl. ≥.97" includes them. Gap = hit − mean p. BSS of called = Brier skill on the called subset vs the listed baselines.

## PRECIP (pbe-weather-precip@1.1.0 / 1.0.0 fallback)


#### Skill (holdout 2025-07-01..2026-09-30)

| slice | baseline | n cases | n dates (clusters) | Brier/mcBrier model | baseline | BSS | BSS 95% CI | log-loss delta (base − model) | 95% CI |
|---|---|---|---|---|---|---|---|---|---|
| all / climatology | p_clim | 56632 | 457 | 0.0877 | 0.1808 | 0.5148 | [0.4933, 0.5358] | 0.2592 | [0.2466, 0.2719] |
| all / raw NWS PoP (NBM if available else GFS) | p_guid | 56632 | 457 | 0.0877 | 0.0938 | 0.0647 | [0.0523, 0.0774] | 0.0199 | [0.0164, 0.0235] |
| all / pbe-weather-precip@1.0.0 (GFS-only model) | p_v10 | 56632 | 457 | 0.0877 | 0.0929 | 0.0562 | [0.046, 0.0667] | 0.0171 | [0.0143, 0.0199] |
| grade HIGH / climatology | p_clim | 51953 | 457 | 0.0777 | 0.175 | 0.5561 | [0.5343, 0.5762] | 0.2728 | [0.2601, 0.2846] |
| grade HIGH / raw PoP | p_guid | 51953 | 457 | 0.0777 | 0.0816 | 0.0478 | [0.0372, 0.0581] | 0.0148 | [0.0121, 0.0173] |
| grade MEDIUM / climatology | p_clim | 4679 | 447 | 0.1988 | 0.2444 | 0.1866 | [0.1462, 0.2249] | 0.1083 | [0.082, 0.1347] |
| grade MEDIUM / raw PoP | p_guid | 4679 | 447 | 0.1988 | 0.229 | 0.1317 | [0.0919, 0.1687] | 0.0772 | [0.0528, 0.1009] |
| lead 6h / climatology | p_clim | 14158 | 457 | 0.0784 | 0.1808 | 0.5665 | [0.5459, 0.5861] | 0.2857 | [0.2735, 0.2986] |
| lead 6h / raw PoP | p_guid | 14158 | 457 | 0.0784 | 0.0842 | 0.0691 | [0.0535, 0.0851] | 0.0209 | [0.0169, 0.0249] |
| lead 18h / climatology | p_clim | 14158 | 457 | 0.0849 | 0.1808 | 0.5302 | [0.5077, 0.5517] | 0.2672 | [0.2545, 0.2799] |
| lead 18h / raw PoP | p_guid | 14158 | 457 | 0.0849 | 0.0903 | 0.0596 | [0.0435, 0.0762] | 0.0174 | [0.0132, 0.0217] |
| lead 30h / climatology | p_clim | 14158 | 457 | 0.0899 | 0.1808 | 0.5026 | [0.4789, 0.5253] | 0.2532 | [0.2398, 0.2663] |
| lead 30h / raw PoP | p_guid | 14158 | 457 | 0.0899 | 0.0968 | 0.0713 | [0.0547, 0.0873] | 0.0212 | [0.0166, 0.0258] |
| lead 42h / climatology | p_clim | 14158 | 457 | 0.0976 | 0.1808 | 0.4599 | [0.4364, 0.4827] | 0.2306 | [0.2175, 0.2439] |
| lead 42h / raw PoP | p_guid | 14158 | 457 | 0.0976 | 0.1038 | 0.0595 | [0.0459, 0.0743] | 0.0201 | [0.0163, 0.0246] |
| tier 1.1.0 / climatology | p_clim | 52896 | 457 | 0.0864 | 0.1787 | 0.5166 | [0.4941, 0.5388] | 0.2582 | [0.2456, 0.2713] |
| tier 1.1.0 / raw PoP | p_guid | 52896 | 457 | 0.0864 | 0.0925 | 0.0663 | [0.0529, 0.08] | 0.0199 | [0.0162, 0.0235] |
| tier 1.0.0 / climatology | p_clim | 3736 | 306 | 0.1066 | 0.2101 | 0.4924 | [0.4491, 0.5344] | 0.2731 | [0.2473, 0.2996] |
| tier 1.0.0 / raw PoP | p_guid | 3736 | 306 | 0.1066 | 0.1119 | 0.0467 | [0.0226, 0.0695] | 0.0209 | [0.0133, 0.0277] |
| final 3 mo / climatology | p_clim | 11408 | 92 | 0.0994 | 0.1756 | 0.4337 | [0.3833, 0.4821] | 0.2107 | [0.1856, 0.2358] |
| final 3 mo / raw PoP | p_guid | 11408 | 92 | 0.0994 | 0.1038 | 0.042 | [0.0173, 0.0665] | 0.0135 | [0.0059, 0.0208] |

#### Calls — FULL holdout (pooled over leads 6/18/30/42 h; calls/day is per lead snapshot)


*Confidence filter: HIGH (51,953 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 24634 | 13.48 | 81.0 | [80.0, 82.0] | 81.4 | -0.4 | 0.1391 | p_clim 0.4221; p_guid 0.0469 | 9282 / 76.5 / 78.4 | 15352 / 83.8 / 83.3 | 1511 / 58.9 / [56.1, 61.8] | 50251 | 57.8 | 51.0 | 90.3 |
| 0.60 | 23123 | 12.65 | 82.5 | [81.4, 83.4] | 83.0 | -0.5 | 0.1325 | p_clim 0.4432; p_guid 0.0464 | 8453 / 78.5 / 80.5 | 14670 / 84.7 / 84.5 | 1746 / 62.0 / [59.2, 65.0] | 48740 | 59.6 | 52.6 | 91.3 |
| 0.65 | 21377 | 11.69 | 84.1 | [83.1, 85.1] | 84.7 | -0.6 | 0.1241 | p_clim 0.4714; p_guid 0.0467 | 7598 / 80.7 / 82.5 | 13779 / 86.0 / 85.9 | 1841 / 67.3 / [64.7, 69.8] | 46994 | 61.8 | 54.5 | 92.4 |
| 0.70 | 19536 | 10.69 | 85.7 | [84.7, 86.7] | 86.4 | -0.7 | 0.115 | p_clim 0.4991; p_guid 0.0515 | 6710 / 82.4 / 84.6 | 12826 / 87.4 / 87.3 | 2140 / 69.7 / [67.3, 72.2] | 45153 | 64.3 | 56.7 | 93.4 |
| 0.75 | 17396 | 9.52 | 87.7 | [86.7, 88.6] | 88.1 | -0.5 | 0.1031 | p_clim 0.5423; p_guid 0.0542 | 5767 / 85.0 / 86.6 | 11629 / 89.0 / 88.9 | 2388 / 76.0 / [73.7, 78.3] | 43013 | 67.5 | 59.6 | 94.6 |
| 0.80 | 14725 | 8.06 | 89.8 | [88.8, 90.7] | 90.1 | -0.3 | 0.0888 | p_clim 0.5945; p_guid 0.0584 | 4730 / 87.3 / 88.8 | 9995 / 91.0 / 90.7 | 2419 / 80.6 / [78.4, 82.7] | 40342 | 72.0 | 63.5 | 95.8 |
| 0.85 | 12306 | 6.73 | 91.6 | [90.7, 92.4] | 91.6 | -0.0 | 0.0754 | p_clim 0.636; p_guid 0.0693 | 3592 / 89.4 / 90.9 | 8714 / 92.5 / 91.9 | 3589 / 86.3 / [84.7, 87.8] | 37923 | 76.6 | 67.5 | 96.8 |

*Confidence filter: HIGH_MEDIUM (56,632 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 28722 | 15.71 | 79.7 | [78.8, 80.6] | 80.3 | -0.6 | 0.1471 | p_clim 0.3896; p_guid 0.0637 | 10645 / 74.9 / 77.3 | 18077 / 82.5 / 82.2 | 2022 / 59.2 / [56.7, 61.4] | 54416 | 53.7 | 47.2 | 88.9 |
| 0.60 | 26700 | 14.61 | 81.3 | [80.3, 82.2] | 82.1 | -0.8 | 0.14 | p_clim 0.4112; p_guid 0.0608 | 9561 / 77.0 / 79.6 | 17139 / 83.6 / 83.5 | 2302 / 62.7 / [60.0, 65.2] | 52394 | 55.8 | 49.0 | 90.1 |
| 0.65 | 24398 | 13.35 | 83.0 | [82.1, 84.0] | 84.0 | -1.0 | 0.1311 | p_clim 0.4404; p_guid 0.0605 | 8453 / 79.4 / 81.9 | 15945 / 84.9 / 85.1 | 2376 / 66.5 / [64.1, 68.9] | 50092 | 58.4 | 51.3 | 91.4 |
| 0.70 | 22022 | 12.05 | 84.8 | [83.9, 85.8] | 85.8 | -1.0 | 0.1213 | p_clim 0.4706; p_guid 0.0626 | 7357 / 81.5 / 84.1 | 14665 / 86.5 / 86.7 | 2709 / 69.6 / [67.4, 71.8] | 47716 | 61.3 | 53.8 | 92.6 |
| 0.75 | 19313 | 10.57 | 86.9 | [86.0, 87.8] | 87.8 | -0.8 | 0.1085 | p_clim 0.5166; p_guid 0.0623 | 6214 / 84.3 / 86.3 | 13099 / 88.2 / 88.4 | 2913 / 75.9 / [73.8, 77.9] | 45007 | 64.9 | 57.1 | 94.0 |
| 0.80 | 16058 | 8.78 | 89.2 | [88.3, 90.1] | 89.9 | -0.7 | 0.0935 | p_clim 0.5709; p_guid 0.0653 | 5010 / 86.8 / 88.6 | 11048 / 90.3 / 90.5 | 2837 / 80.0 / [78.1, 82.0] | 41752 | 70.0 | 61.5 | 95.4 |
| 0.85 | 13221 | 7.23 | 91.1 | [90.3, 92.0] | 91.5 | -0.4 | 0.0792 | p_clim 0.6161; p_guid 0.0756 | 3737 / 89.2 / 90.8 | 9484 / 91.9 / 91.8 | 4036 / 85.7 / [84.3, 87.2] | 38915 | 75.1 | 66.0 | 96.5 |

*Confidence filter: ALL (56,632 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 28722 | 15.71 | 79.7 | [78.8, 80.6] | 80.3 | -0.6 | 0.1471 | p_clim 0.3896; p_guid 0.0637 | 10645 / 74.9 / 77.3 | 18077 / 82.5 / 82.2 | 2022 / 59.2 / [56.7, 61.5] | 54416 | 53.7 | 47.2 | 88.9 |
| 0.60 | 26700 | 14.61 | 81.3 | [80.3, 82.1] | 82.1 | -0.8 | 0.14 | p_clim 0.4112; p_guid 0.0608 | 9561 / 77.0 / 79.6 | 17139 / 83.6 / 83.5 | 2302 / 62.7 / [60.3, 65.1] | 52394 | 55.8 | 49.0 | 90.1 |
| 0.65 | 24398 | 13.35 | 83.0 | [82.1, 83.9] | 84.0 | -1.0 | 0.1311 | p_clim 0.4404; p_guid 0.0605 | 8453 / 79.4 / 81.9 | 15945 / 84.9 / 85.1 | 2376 / 66.5 / [64.1, 68.8] | 50092 | 58.4 | 51.3 | 91.4 |
| 0.70 | 22022 | 12.05 | 84.8 | [83.9, 85.7] | 85.8 | -1.0 | 0.1213 | p_clim 0.4706; p_guid 0.0626 | 7357 / 81.5 / 84.1 | 14665 / 86.5 / 86.7 | 2709 / 69.6 / [67.3, 71.8] | 47716 | 61.3 | 53.8 | 92.6 |
| 0.75 | 19313 | 10.57 | 86.9 | [86.0, 87.8] | 87.8 | -0.8 | 0.1085 | p_clim 0.5166; p_guid 0.0623 | 6214 / 84.3 / 86.3 | 13099 / 88.2 / 88.4 | 2913 / 75.9 / [74.0, 78.0] | 45007 | 64.9 | 57.1 | 94.0 |
| 0.80 | 16058 | 8.78 | 89.2 | [88.2, 90.0] | 89.9 | -0.7 | 0.0935 | p_clim 0.5709; p_guid 0.0653 | 5010 / 86.8 / 88.6 | 11048 / 90.3 / 90.5 | 2837 / 80.0 / [78.1, 81.9] | 41752 | 70.0 | 61.5 | 95.4 |
| 0.85 | 13221 | 7.23 | 91.1 | [90.2, 92.0] | 91.5 | -0.4 | 0.0792 | p_clim 0.6161; p_guid 0.0756 | 3737 / 89.2 / 90.8 | 9484 / 91.9 / 91.8 | 4036 / 85.7 / [84.2, 87.1] | 38915 | 75.1 | 66.0 | 96.5 |

#### Calls — SELECTION window 2025-07-01..2026-06-30


*Confidence filter: HIGH (41,751 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 19289 | 13.21 | 81.2 | [80.1, 82.2] | 81.5 | -0.3 | 0.138 | p_clim 0.4338; p_guid 0.0501 | 7317 / 77.2 / 78.5 | 11972 / 83.6 / 83.3 | 1180 / 58.5 / [55.2, 61.5] | 40407 | 58.9 | 52.3 | 90.7 |
| 0.60 | 18109 | 12.40 | 82.6 | [81.6, 83.7] | 83.1 | -0.4 | 0.1312 | p_clim 0.4546; p_guid 0.0504 | 6667 / 79.2 / 80.6 | 11442 / 84.7 / 84.5 | 1348 / 62.5 / [59.2, 65.9] | 39227 | 60.7 | 53.8 | 91.6 |
| 0.65 | 16761 | 11.48 | 84.3 | [83.2, 85.3] | 84.8 | -0.5 | 0.1229 | p_clim 0.481; p_guid 0.0511 | 6006 / 81.1 / 82.7 | 10755 / 86.0 / 85.9 | 1426 / 66.8 / [64.0, 69.7] | 37879 | 62.8 | 55.8 | 92.7 |
| 0.70 | 15335 | 10.50 | 85.9 | [84.8, 87.0] | 86.4 | -0.5 | 0.1138 | p_clim 0.5091; p_guid 0.0564 | 5312 / 82.9 / 84.7 | 10023 / 87.5 / 87.3 | 1653 / 69.5 / [66.6, 72.3] | 36453 | 65.3 | 57.9 | 93.7 |
| 0.75 | 13682 | 9.37 | 87.9 | [86.8, 88.9] | 88.1 | -0.3 | 0.1018 | p_clim 0.5521; p_guid 0.0616 | 4585 / 85.4 / 86.8 | 9097 / 89.1 / 88.8 | 1909 / 76.4 / [73.9, 79.0] | 34800 | 68.4 | 60.7 | 94.8 |
| 0.80 | 11554 | 7.91 | 89.9 | [88.9, 90.9] | 90.1 | -0.2 | 0.0875 | p_clim 0.6037; p_guid 0.0657 | 3755 / 87.5 / 88.9 | 7799 / 91.1 / 90.7 | 1846 / 80.8 / [78.4, 83.2] | 32672 | 72.9 | 64.6 | 96.0 |
| 0.85 | 9708 | 6.65 | 91.7 | [90.7, 92.7] | 91.6 | 0.1 | 0.0746 | p_clim 0.6444; p_guid 0.0758 | 2886 / 89.7 / 91.0 | 6822 / 92.5 / 91.9 | 2851 / 86.3 / [84.6, 87.9] | 30826 | 77.2 | 68.5 | 97.0 |

*Confidence filter: HIGH_MEDIUM (45,224 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 22313 | 15.28 | 79.9 | [78.9, 80.9] | 80.4 | -0.6 | 0.1461 | p_clim 0.4021; p_guid 0.071 | 8374 / 75.7 / 77.5 | 13939 / 82.4 / 82.2 | 1565 / 59.4 / [56.6, 62.0] | 43489 | 55.1 | 48.7 | 89.4 |
| 0.60 | 20748 | 14.21 | 81.4 | [80.4, 82.5] | 82.2 | -0.8 | 0.139 | p_clim 0.4232; p_guid 0.0681 | 7536 / 77.7 / 79.8 | 13212 / 83.5 / 83.6 | 1755 / 63.5 / [60.6, 66.5] | 41924 | 57.1 | 50.5 | 90.5 |
| 0.65 | 18993 | 13.01 | 83.1 | [82.0, 84.2] | 84.0 | -1.0 | 0.1304 | p_clim 0.4496; p_guid 0.068 | 6692 / 79.6 / 82.0 | 12301 / 84.9 / 85.2 | 1837 / 65.8 / [63.2, 68.3] | 40169 | 59.6 | 52.7 | 91.7 |
| 0.70 | 17156 | 11.75 | 84.9 | [83.8, 86.0] | 85.9 | -1.0 | 0.1203 | p_clim 0.4809; p_guid 0.0703 | 5827 / 81.8 / 84.3 | 11329 / 86.5 / 86.7 | 2067 / 69.2 / [66.8, 71.8] | 38332 | 62.5 | 55.2 | 92.9 |
| 0.75 | 15089 | 10.33 | 87.1 | [86.0, 88.1] | 87.8 | -0.7 | 0.1075 | p_clim 0.5265; p_guid 0.0716 | 4946 / 84.6 / 86.5 | 10143 / 88.3 / 88.4 | 2298 / 76.1 / [73.6, 78.5] | 36265 | 66.0 | 58.4 | 94.3 |
| 0.80 | 12530 | 8.58 | 89.3 | [88.2, 90.3] | 89.9 | -0.6 | 0.0924 | p_clim 0.5806; p_guid 0.0741 | 3985 / 87.0 / 88.7 | 8545 / 90.4 / 90.5 | 2160 / 79.9 / [77.7, 82.0] | 33706 | 71.0 | 62.8 | 95.6 |
| 0.85 | 10370 | 7.10 | 91.2 | [90.2, 92.3] | 91.5 | -0.3 | 0.0782 | p_clim 0.6264; p_guid 0.0845 | 3009 / 89.5 / 90.9 | 7361 / 92.0 / 91.7 | 3179 / 85.8 / [84.0, 87.5] | 31546 | 75.9 | 67.1 | 96.7 |

*Confidence filter: ALL (45,224 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 22313 | 15.28 | 79.9 | [78.8, 80.9] | 80.4 | -0.6 | 0.1461 | p_clim 0.4021; p_guid 0.071 | 8374 / 75.7 / 77.5 | 13939 / 82.4 / 82.2 | 1565 / 59.4 / [56.7, 62.1] | 43489 | 55.1 | 48.7 | 89.4 |
| 0.60 | 20748 | 14.21 | 81.4 | [80.4, 82.5] | 82.2 | -0.8 | 0.139 | p_clim 0.4232; p_guid 0.0681 | 7536 / 77.7 / 79.8 | 13212 / 83.5 / 83.6 | 1755 / 63.5 / [60.6, 66.4] | 41924 | 57.1 | 50.5 | 90.5 |
| 0.65 | 18993 | 13.01 | 83.1 | [82.0, 84.1] | 84.0 | -1.0 | 0.1304 | p_clim 0.4496; p_guid 0.068 | 6692 / 79.6 / 82.0 | 12301 / 84.9 / 85.2 | 1837 / 65.8 / [63.2, 68.3] | 40169 | 59.6 | 52.7 | 91.7 |
| 0.70 | 17156 | 11.75 | 84.9 | [83.8, 86.0] | 85.9 | -1.0 | 0.1203 | p_clim 0.4809; p_guid 0.0703 | 5827 / 81.8 / 84.3 | 11329 / 86.5 / 86.7 | 2067 / 69.2 / [66.6, 71.8] | 38332 | 62.5 | 55.2 | 92.9 |
| 0.75 | 15089 | 10.33 | 87.1 | [86.0, 88.1] | 87.8 | -0.7 | 0.1075 | p_clim 0.5265; p_guid 0.0716 | 4946 / 84.6 / 86.5 | 10143 / 88.3 / 88.4 | 2298 / 76.1 / [73.7, 78.6] | 36265 | 66.0 | 58.4 | 94.3 |
| 0.80 | 12530 | 8.58 | 89.3 | [88.2, 90.3] | 89.9 | -0.6 | 0.0924 | p_clim 0.5806; p_guid 0.0741 | 3985 / 87.0 / 88.7 | 8545 / 90.4 / 90.5 | 2160 / 79.9 / [77.8, 82.1] | 33706 | 71.0 | 62.8 | 95.6 |
| 0.85 | 10370 | 7.10 | 91.2 | [90.2, 92.2] | 91.5 | -0.3 | 0.0782 | p_clim 0.6264; p_guid 0.0845 | 3009 / 89.5 / 90.9 | 7361 / 92.0 / 91.7 | 3179 / 85.8 / [84.0, 87.6] | 31546 | 75.9 | 67.1 | 96.7 |

#### By lead — selection window, T=0.7, ALL grades

| lead h | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 | 11306 | 3894 | 10.67 | 86.1 | [84.9, 87.2] | 85.8 | 0.3 | 1416/84.0 | 2478/87.3 | 59.9 |
| 18 | 11306 | 4080 | 11.18 | 84.9 | [83.6, 86.2] | 85.8 | -0.9 | 1468/82.0 | 2612/86.5 | 57.7 |
| 30 | 11306 | 4208 | 11.53 | 84.2 | [82.8, 85.5] | 85.8 | -1.6 | 1478/82.1 | 2730/85.4 | 55.9 |
| 42 | 11306 | 4974 | 13.63 | 84.7 | [83.4, 85.9] | 86.1 | -1.5 | 1465/79.4 | 3509/86.9 | 47.4 |

#### By lead — final 3 months, T=0.7

| lead h | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 | 2852 | 1179 | 12.82 | 85.9 | [83.8, 87.9] | 85.8 | 0.2 | 359/82.7 | 820/87.3 | 49.9 |
| 18 | 2852 | 1186 | 12.89 | 84.9 | [82.6, 87.2] | 85.5 | -0.6 | 387/81.1 | 799/86.7 | 49.5 |
| 30 | 2852 | 1232 | 13.39 | 83.6 | [81.2, 86.1] | 85.8 | -2.2 | 406/78.6 | 826/86.1 | 47.5 |
| 42 | 2852 | 1269 | 13.79 | 83.2 | [80.7, 85.7] | 85.5 | -2.3 | 378/78.8 | 891/85.1 | 45.6 |

#### By grade — selection window, T=0.7

| grade | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| HIGH | 41751 | 15335 | 10.50 | 85.9 | [84.8, 87.0] | 86.4 | -0.5 | 5312/82.9 | 10023/87.5 | 57.9 |
| MEDIUM | 3473 | 1821 | 1.28 | 76.9 | [74.2, 79.6] | 81.5 | -4.6 | 515/71.1 | 1306/79.3 | 3.1 |

#### By month — full holdout, T=0.7

| month | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| 2025-07 | 3840 | 1800 | 14.52 | 80.1 | [76.6, 83.7] | 83.7 | -3.6 | 607/77.1 | 1193/81.6 | 40.0 |
| 2025-08 | 3840 | 1575 | 12.70 | 84.5 | [80.9, 88.0] | 85.5 | -1.0 | 363/62.3 | 1212/91.2 | 47.7 |
| 2025-09 | 3716 | 1484 | 12.37 | 85.7 | [82.1, 89.5] | 86.6 | -0.9 | 420/77.1 | 1064/89.1 | 52.8 |
| 2025-10 | 3836 | 1194 | 9.63 | 88.3 | [84.8, 91.7] | 86.9 | 1.3 | 312/85.9 | 882/89.1 | 65.1 |
| 2025-11 | 3720 | 1199 | 9.99 | 84.7 | [80.0, 88.9] | 86.5 | -1.9 | 534/81.5 | 665/87.2 | 63.3 |
| 2025-12 | 3840 | 1215 | 9.80 | 81.9 | [75.7, 87.2] | 86.3 | -4.4 | 368/85.6 | 847/80.3 | 64.2 |
| 2026-01 | 3844 | 1235 | 9.96 | 86.6 | [82.6, 90.5] | 86.5 | 0.2 | 350/89.4 | 885/85.5 | 62.8 |
| 2026-02 | 3472 | 1120 | 10.00 | 86.9 | [82.8, 90.7] | 86.4 | 0.4 | 305/87.2 | 815/86.8 | 64.0 |
| 2026-03 | 3836 | 1257 | 10.14 | 88.1 | [85.4, 90.8] | 86.1 | 2.0 | 564/86.2 | 693/89.6 | 62.1 |
| 2026-04 | 3720 | 1907 | 15.89 | 87.4 | [85.5, 89.4] | 85.8 | 1.6 | 721/86.4 | 1186/88.0 | 38.6 |
| 2026-05 | 3844 | 1642 | 13.24 | 83.8 | [80.7, 86.5] | 85.8 | -2.0 | 691/82.5 | 951/84.8 | 48.9 |
| 2026-06 | 3716 | 1528 | 12.73 | 83.0 | [79.8, 86.5] | 85.7 | -2.6 | 592/80.2 | 936/84.8 | 49.5 |
| 2026-07 | 3844 | 1581 | 12.75 | 85.0 | [81.8, 88.1] | 85.7 | -0.8 | 529/81.7 | 1052/86.6 | 50.9 |
| 2026-08 | 3844 | 1619 | 13.06 | 81.6 | [77.7, 85.4] | 85.5 | -3.9 | 470/77.2 | 1149/83.4 | 47.4 |
| 2026-09 | 3720 | 1666 | 13.88 | 86.6 | [83.5, 89.4] | 85.7 | 0.8 | 531/81.5 | 1135/88.9 | 46.0 |

#### By season — full holdout, T=0.7

| season | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| cool Oct-May | 30112 | 10769 | 11.08 | 86.0 | [84.6, 87.2] | 86.2 | -0.3 | 3845/85.2 | 6924/86.4 | 58.8 |
| warm Jun-Sep | 26520 | 11253 | 13.15 | 83.7 | [82.3, 85.1] | 85.4 | -1.7 | 3512/77.5 | 7741/86.5 | 47.8 |

#### By window × season — T=0.7 (YES/NO split shows the warm-season YES bias)

| window | season | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| final | warm Jun-Sep | 11408 | 4866 | 13.22 | 84.4 | [82.2, 86.4] | 85.6 | -1.3 | 1530/80.3 | 3336/86.3 | 48.1 |
| selection | cool Oct-May | 30112 | 10769 | 11.08 | 86.0 | [84.6, 87.2] | 86.2 | -0.3 | 3845/85.2 | 6924/86.4 | 58.8 |
| selection | warm Jun-Sep | 15112 | 6387 | 13.09 | 83.2 | [81.3, 85.0] | 85.3 | -2.1 | 1982/75.3 | 4405/86.7 | 47.6 |

Near-certain calibration (precip): [{"band":"0.95-0.97","n":3534,"share_of_cases":0.0624,"mean_conf":0.9554,"hit_rate":0.9567},{"band":"0.97-1","n":25694,"share_of_cases":0.4537,"mean_conf":0.979,"hit_rate":0.9928}]


#### By model tier — full holdout, T=0.7

| tier | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| tier 1.0.0 | 3736 | 2033 | 1.66 | 86.8 | [84.8, 88.6] | 86.7 | 0.1 | 544/81.3 | 1489/88.8 | 31.6 |
| tier 1.1.0 | 52896 | 19989 | 10.93 | 84.6 | [83.7, 85.6] | 85.8 | -1.1 | 6813/81.5 | 13176/86.2 | 55.3 |

## MAX TEMP (pbe-weather-maxtemp@1.1.0; synthetic Kalshi-shape 6-bucket events)


#### Skill (holdout 2025-07-01..2026-09-30)

| slice | baseline | n cases | n dates (clusters) | Brier/mcBrier model | baseline | BSS | BSS 95% CI | log-loss delta (base − model) | 95% CI |
|---|---|---|---|---|---|---|---|---|---|
| events / climatology Normal(1991-2020) | p_clim | 56668 | 457 | 0.754 | 1.1205 | 0.3271 | [0.3185, 0.3354] | 0.857 | [0.8252, 0.8884] |
| events / Normal error model (same guidance+tables) | p_norm | 56668 | 457 | 0.754 | 0.7645 | 0.0137 | [0.0119, 0.0156] | 0.0222 | [0.0187, 0.0259] |
| bucket contracts / climatology | p_clim | 340008 | 457 | 0.1257 | 0.1868 | 0.3271 | [0.3188, 0.3355] | 0.2082 | [0.1998, 0.2169] |
| bucket contracts / Normal | p_norm | 340008 | 457 | 0.1257 | 0.1274 | 0.0137 | [0.0119, 0.0155] | 0.0047 | [0.0039, 0.0054] |
| events grade HIGH / climatology | p_clim | 24412 | 457 | 0.7467 | 1.157 | 0.3547 | [0.3467, 0.3619] | 0.9592 | [0.9254, 0.9908] |
| events grade HIGH / Normal | p_norm | 24412 | 457 | 0.7467 | 0.7598 | 0.0173 | [0.0151, 0.0193] | 0.0288 | [0.0247, 0.0326] |
| events grade MEDIUM / climatology | p_clim | 32256 | 457 | 0.7596 | 1.0929 | 0.305 | [0.2955, 0.3138] | 0.7797 | [0.7465, 0.8098] |
| events grade MEDIUM / Normal | p_norm | 32256 | 457 | 0.7596 | 0.7681 | 0.0111 | [0.0091, 0.013] | 0.0172 | [0.0133, 0.021] |
| events lead 6h / climatology | p_clim | 14167 | 457 | 0.7448 | 1.1474 | 0.3509 | [0.3427, 0.359] | 0.9473 | [0.9167, 0.9788] |
| events lead 6h / Normal | p_norm | 14167 | 457 | 0.7448 | 0.7577 | 0.0171 | [0.0149, 0.0194] | 0.027 | [0.023, 0.031] |
| events lead 18h / climatology | p_clim | 14167 | 457 | 0.7489 | 1.1241 | 0.3337 | [0.3257, 0.3424] | 0.8785 | [0.8488, 0.9126] |
| events lead 18h / Normal | p_norm | 14167 | 457 | 0.7489 | 0.7582 | 0.0122 | [0.01, 0.0145] | 0.0165 | [0.0123, 0.0206] |
| events lead 30h / climatology | p_clim | 14167 | 457 | 0.7581 | 1.1119 | 0.3182 | [0.3098, 0.3271] | 0.8263 | [0.7969, 0.8589] |
| events lead 30h / Normal | p_norm | 14167 | 457 | 0.7581 | 0.7698 | 0.0152 | [0.0132, 0.0173] | 0.0275 | [0.0235, 0.0317] |
| events lead 42h / climatology | p_clim | 14167 | 457 | 0.7642 | 1.0987 | 0.3044 | [0.2955, 0.3138] | 0.7758 | [0.746, 0.8088] |
| events lead 42h / Normal | p_norm | 14167 | 457 | 0.7642 | 0.7723 | 0.0104 | [0.0085, 0.0126] | 0.0177 | [0.0137, 0.022] |
| events Kalshi-7 stations / climatology | p_clim | 12796 | 457 | 0.7508 | 1.0898 | 0.3111 | [0.3006, 0.322] | 0.8031 | [0.7668, 0.8398] |
| events Kalshi-7 stations / Normal | p_norm | 12796 | 457 | 0.7508 | 0.7632 | 0.0163 | [0.013, 0.0196] | 0.027 | [0.0211, 0.0329] |
| events final 3 mo / climatology | p_clim | 11408 | 92 | 0.7584 | 1.0547 | 0.2809 | [0.2659, 0.295] | 0.6874 | [0.6372, 0.7326] |
| events final 3 mo / Normal | p_norm | 11408 | 92 | 0.7584 | 0.7708 | 0.016 | [0.0126, 0.0194] | 0.0272 | [0.0203, 0.034] |

#### Contract-level calls — FULL holdout (each of 6 buckets is a binary contract)


*Confidence filter: HIGH (146,472 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 121507 | 66.47 | 81.5 | [81.4, 81.6] | 81.6 | -0.1 | 0.1389 | p_clim 0.3106; p_norm 0.0181 | 456 / 52.8 / 56.0 | 121051 / 81.7 / 81.7 | 1492 / 60.3 / [57.7, 63.0] | 143157 | 24.7 | 15.1 | 84.0 |
| 0.60 | 120015 | 65.65 | 81.8 | [81.7, 81.9] | 81.9 | -0.1 | 0.1377 | p_clim 0.3112; p_norm 0.0182 | 0 / — / — | 120015 / 81.8 / 81.9 | 3735 / 60.9 / [59.1, 62.8] | 141665 | 25.0 | 15.3 | 84.2 |
| 0.65 | 116280 | 63.61 | 82.5 | [82.4, 82.6] | 82.5 | -0.0 | 0.1345 | p_clim 0.3139; p_norm 0.017 | 0 / — / — | 116280 / 82.5 / 82.5 | 14807 / 66.8 / [65.8, 67.8] | 137930 | 25.6 | 15.7 | 84.8 |
| 0.70 | 101473 | 55.51 | 84.8 | [84.6, 84.9] | 84.7 | 0.1 | 0.1217 | p_clim 0.3306; p_norm 0.0147 | 0 / — / — | 101473 / 84.8 / 84.7 | 17260 / 69.9 / [69.1, 70.8] | 123123 | 28.7 | 17.6 | 87.0 |
| 0.75 | 84213 | 46.07 | 87.8 | [87.5, 88.0] | 87.3 | 0.5 | 0.1035 | p_clim 0.3729; p_norm 0.0142 | 0 / — / — | 84213 / 87.8 / 87.3 | 16600 / 78.7 / [78.0, 79.3] | 105863 | 33.4 | 20.4 | 89.8 |
| 0.80 | 65264 | 35.70 | 90.4 | [90.1, 90.7] | 90.0 | 0.4 | 0.0853 | p_clim 0.4302; p_norm 0.0124 | 0 / — / — | 65264 / 90.4 / 90.0 | 8625 / 82.6 / [81.7, 83.4] | 86914 | 40.7 | 24.9 | 92.2 |
| 0.85 | 56639 | 30.98 | 91.6 | [91.2, 91.9] | 91.1 | 0.5 | 0.0763 | p_clim 0.4712; p_norm 0.0136 | 0 / — / — | 56639 / 91.6 / 91.1 | 19514 / 88.0 / [87.5, 88.5] | 78289 | 45.2 | 27.7 | 93.2 |

*Confidence filter: HIGH_MEDIUM (340,008 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 273994 | 149.89 | 81.0 | [80.8, 81.1] | 81.7 | -0.7 | 0.1436 | p_clim 0.2856; p_norm 0.0147 | 5620 / 49.9 / 70.0 | 268374 / 81.6 / 82.0 | 3972 / 57.3 / [55.4, 59.3] | 333490 | 26.0 | 17.8 | 83.8 |
| 0.60 | 270022 | 147.71 | 81.3 | [81.2, 81.4] | 82.1 | -0.8 | 0.1421 | p_clim 0.2858; p_norm 0.0148 | 4442 / 50.7 / 73.8 | 265580 / 81.8 / 82.2 | 8548 / 62.6 / [61.3, 63.9] | 329518 | 26.3 | 18.1 | 84.1 |
| 0.65 | 261474 | 143.04 | 81.9 | [81.8, 82.0] | 82.7 | -0.8 | 0.1391 | p_clim 0.2871; p_norm 0.0143 | 3333 / 54.3 / 77.5 | 258141 / 82.3 / 82.8 | 26484 / 66.4 / [65.6, 67.2] | 320970 | 27.0 | 18.5 | 84.7 |
| 0.70 | 234990 | 128.55 | 83.7 | [83.5, 83.8] | 84.5 | -0.8 | 0.1296 | p_clim 0.294; p_norm 0.0117 | 2417 / 56.8 / 81.9 | 232573 / 84.0 / 84.5 | 38156 / 70.1 / [69.4, 70.8] | 294486 | 29.5 | 20.2 | 86.4 |
| 0.75 | 196834 | 107.68 | 86.3 | [86.1, 86.5] | 86.8 | -0.5 | 0.1141 | p_clim 0.3218; p_norm 0.0087 | 2042 / 59.6 / 83.5 | 194792 / 86.6 / 86.9 | 38880 / 76.6 / [76.1, 77.0] | 256330 | 33.9 | 23.2 | 88.8 |
| 0.80 | 149013 | 81.52 | 89.3 | [89.0, 89.6] | 89.7 | -0.4 | 0.094 | p_clim 0.3777; p_norm 0.0068 | 1242 / 62.8 / 87.9 | 147771 / 89.5 / 89.7 | 22123 / 82.0 / [81.4, 82.6] | 208509 | 41.6 | 28.5 | 91.5 |
| 0.85 | 126890 | 69.41 | 90.6 | [90.3, 90.9] | 91.0 | -0.4 | 0.0846 | p_clim 0.4084; p_norm 0.0066 | 879 / 64.5 / 90.1 | 126011 / 90.7 / 91.0 | 44593 / 87.0 / [86.6, 87.4] | 186386 | 46.6 | 31.9 | 92.6 |

*Confidence filter: ALL (340,008 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 273994 | 149.89 | 81.0 | [80.8, 81.1] | 81.7 | -0.7 | 0.1436 | p_clim 0.2856; p_norm 0.0147 | 5620 / 49.9 / 70.0 | 268374 / 81.6 / 82.0 | 3972 / 57.3 / [55.5, 59.2] | 333490 | 26.0 | 17.8 | 83.8 |
| 0.60 | 270022 | 147.71 | 81.3 | [81.2, 81.4] | 82.1 | -0.8 | 0.1421 | p_clim 0.2858; p_norm 0.0148 | 4442 / 50.7 / 73.8 | 265580 / 81.8 / 82.2 | 8548 / 62.6 / [61.4, 63.8] | 329518 | 26.3 | 18.1 | 84.1 |
| 0.65 | 261474 | 143.04 | 81.9 | [81.8, 82.0] | 82.7 | -0.8 | 0.1391 | p_clim 0.2871; p_norm 0.0143 | 3333 / 54.3 / 77.5 | 258141 / 82.3 / 82.8 | 26484 / 66.4 / [65.6, 67.2] | 320970 | 27.0 | 18.5 | 84.7 |
| 0.70 | 234990 | 128.55 | 83.7 | [83.5, 83.8] | 84.5 | -0.8 | 0.1296 | p_clim 0.294; p_norm 0.0117 | 2417 / 56.8 / 81.9 | 232573 / 84.0 / 84.5 | 38156 / 70.1 / [69.4, 70.8] | 294486 | 29.5 | 20.2 | 86.4 |
| 0.75 | 196834 | 107.68 | 86.3 | [86.1, 86.5] | 86.8 | -0.5 | 0.1141 | p_clim 0.3218; p_norm 0.0087 | 2042 / 59.6 / 83.5 | 194792 / 86.6 / 86.9 | 38880 / 76.6 / [76.1, 77.1] | 256330 | 33.9 | 23.2 | 88.8 |
| 0.80 | 149013 | 81.52 | 89.3 | [89.0, 89.6] | 89.7 | -0.4 | 0.094 | p_clim 0.3777; p_norm 0.0068 | 1242 / 62.8 / 87.9 | 147771 / 89.5 / 89.7 | 22123 / 82.0 / [81.4, 82.5] | 208509 | 41.6 | 28.5 | 91.5 |
| 0.85 | 126890 | 69.41 | 90.6 | [90.3, 90.9] | 91.0 | -0.4 | 0.0846 | p_clim 0.4084; p_norm 0.0066 | 879 / 64.5 / 90.1 | 126011 / 90.7 / 91.0 | 44593 / 87.0 / [86.5, 87.4] | 186386 | 46.6 | 31.9 | 92.6 |

#### Contract-level calls — SELECTION window


*Confidence filter: HIGH (117,546 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 97488 | 66.77 | 81.6 | [81.5, 81.7] | 81.6 | -0.0 | 0.1388 | p_clim 0.319; p_norm 0.0177 | 367 / 55.6 / 56.0 | 97121 / 81.7 / 81.7 | 1165 / 61.3 / [58.2, 64.5] | 114865 | 24.7 | 15.1 | 84.0 |
| 0.60 | 96323 | 65.97 | 81.8 | [81.7, 81.9] | 81.9 | -0.1 | 0.1376 | p_clim 0.3194; p_norm 0.0176 | 0 / — / — | 96323 / 81.8 / 81.9 | 2957 / 61.7 / [59.6, 63.6] | 113700 | 24.9 | 15.3 | 84.2 |
| 0.65 | 93366 | 63.95 | 82.5 | [82.4, 82.6] | 82.5 | -0.0 | 0.1345 | p_clim 0.3226; p_norm 0.0168 | 0 / — / — | 93366 / 82.5 / 82.5 | 11938 / 66.4 / [65.3, 67.5] | 110743 | 25.6 | 15.7 | 84.8 |
| 0.70 | 81428 | 55.77 | 84.8 | [84.6, 85.0] | 84.7 | 0.1 | 0.1215 | p_clim 0.3392; p_norm 0.0143 | 0 / — / — | 81428 / 84.8 / 84.7 | 13871 / 70.2 / [69.3, 71.2] | 98805 | 28.7 | 17.6 | 87.1 |
| 0.75 | 67557 | 46.27 | 87.8 | [87.5, 88.1] | 87.3 | 0.5 | 0.1035 | p_clim 0.3821; p_norm 0.0141 | 0 / — / — | 67557 / 87.8 / 87.3 | 13237 / 79.0 / [78.3, 79.7] | 84934 | 33.4 | 20.5 | 89.8 |
| 0.80 | 52409 | 35.90 | 90.4 | [90.0, 90.7] | 90.0 | 0.4 | 0.0855 | p_clim 0.4385; p_norm 0.0121 | 0 / — / — | 52409 / 90.4 / 90.0 | 6977 / 82.7 / [81.8, 83.7] | 69786 | 40.6 | 24.9 | 92.1 |
| 0.85 | 45432 | 31.12 | 91.5 | [91.2, 91.9] | 91.1 | 0.5 | 0.0767 | p_clim 0.4785; p_norm 0.013 | 0 / — / — | 45432 / 91.5 / 91.1 | 15647 / 88.0 / [87.4, 88.6] | 62809 | 45.2 | 27.7 | 93.2 |

*Confidence filter: HIGH_MEDIUM (271,560 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 218940 | 149.96 | 81.1 | [81.0, 81.2] | 81.7 | -0.7 | 0.1433 | p_clim 0.2948; p_norm 0.014 | 4474 / 51.5 / 70.2 | 214466 / 81.7 / 82.0 | 3145 / 57.8 / [55.6, 60.0] | 266393 | 25.9 | 17.8 | 83.9 |
| 0.60 | 215795 | 147.80 | 81.4 | [81.3, 81.5] | 82.1 | -0.7 | 0.1418 | p_clim 0.2947; p_norm 0.014 | 3528 / 52.4 / 74.1 | 212267 / 81.9 / 82.2 | 6761 / 63.3 / [61.9, 64.7] | 263248 | 26.3 | 18.0 | 84.2 |
| 0.65 | 209034 | 143.17 | 82.0 | [81.9, 82.1] | 82.7 | -0.7 | 0.1389 | p_clim 0.296; p_norm 0.0135 | 2666 / 55.4 / 77.8 | 206368 / 82.3 / 82.8 | 21124 / 66.3 / [65.4, 67.1] | 256487 | 27.0 | 18.5 | 84.8 |
| 0.70 | 187910 | 128.71 | 83.8 | [83.6, 83.9] | 84.5 | -0.7 | 0.1293 | p_clim 0.303; p_norm 0.011 | 1958 / 58.4 / 82.0 | 185952 / 84.0 / 84.5 | 30473 / 70.6 / [69.8, 71.4] | 235363 | 29.4 | 20.2 | 86.4 |
| 0.75 | 157437 | 107.83 | 86.3 | [86.1, 86.6] | 86.8 | -0.5 | 0.1142 | p_clim 0.3314; p_norm 0.0085 | 1659 / 60.8 / 83.6 | 155778 / 86.6 / 86.9 | 31050 / 76.8 / [76.3, 77.3] | 204890 | 33.7 | 23.2 | 88.8 |
| 0.80 | 119260 | 81.68 | 89.2 | [88.9, 89.6] | 89.7 | -0.5 | 0.0944 | p_clim 0.387; p_norm 0.0066 | 1020 / 64.4 / 88.0 | 118240 / 89.5 / 89.7 | 17928 / 82.1 / [81.4, 82.7] | 166713 | 41.5 | 28.5 | 91.4 |
| 0.85 | 101332 | 69.41 | 90.5 | [90.1, 90.9] | 90.9 | -0.4 | 0.0852 | p_clim 0.4172; p_norm 0.0061 | 731 / 66.5 / 90.1 | 100601 / 90.7 / 91.0 | 35585 / 87.1 / [86.6, 87.5] | 148785 | 46.5 | 31.9 | 92.5 |

*Confidence filter: ALL (271,560 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 218940 | 149.96 | 81.1 | [81.0, 81.2] | 81.7 | -0.7 | 0.1433 | p_clim 0.2948; p_norm 0.014 | 4474 / 51.5 / 70.2 | 214466 / 81.7 / 82.0 | 3145 / 57.8 / [55.7, 59.9] | 266393 | 25.9 | 17.8 | 83.9 |
| 0.60 | 215795 | 147.80 | 81.4 | [81.3, 81.5] | 82.1 | -0.7 | 0.1418 | p_clim 0.2947; p_norm 0.014 | 3528 / 52.4 / 74.1 | 212267 / 81.9 / 82.2 | 6761 / 63.3 / [62.0, 64.7] | 263248 | 26.3 | 18.0 | 84.2 |
| 0.65 | 209034 | 143.17 | 82.0 | [81.9, 82.1] | 82.7 | -0.7 | 0.1389 | p_clim 0.296; p_norm 0.0135 | 2666 / 55.4 / 77.8 | 206368 / 82.3 / 82.8 | 21124 / 66.3 / [65.3, 67.1] | 256487 | 27.0 | 18.5 | 84.8 |
| 0.70 | 187910 | 128.71 | 83.8 | [83.6, 83.9] | 84.5 | -0.7 | 0.1293 | p_clim 0.303; p_norm 0.011 | 1958 / 58.4 / 82.0 | 185952 / 84.0 / 84.5 | 30473 / 70.6 / [69.8, 71.4] | 235363 | 29.4 | 20.2 | 86.4 |
| 0.75 | 157437 | 107.83 | 86.3 | [86.1, 86.6] | 86.8 | -0.5 | 0.1142 | p_clim 0.3314; p_norm 0.0085 | 1659 / 60.8 / 83.6 | 155778 / 86.6 / 86.9 | 31050 / 76.8 / [76.3, 77.3] | 204890 | 33.7 | 23.2 | 88.8 |
| 0.80 | 119260 | 81.68 | 89.2 | [88.9, 89.6] | 89.7 | -0.5 | 0.0944 | p_clim 0.387; p_norm 0.0066 | 1020 / 64.4 / 88.0 | 118240 / 89.5 / 89.7 | 17928 / 82.1 / [81.4, 82.7] | 166713 | 41.5 | 28.5 | 91.4 |
| 0.85 | 101332 | 69.41 | 90.5 | [90.2, 90.9] | 90.9 | -0.4 | 0.0852 | p_clim 0.4172; p_norm 0.0061 | 731 / 66.5 / 90.1 | 100601 / 90.7 / 91.0 | 35585 / 87.1 / [86.6, 87.6] | 148785 | 46.5 | 31.9 | 92.5 |

#### Contract-level calls by bucket position — selection, HIGH, T=0.65

| bucket | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| b1 | 19591 | 15979 | 10.94 | 87.6 | [86.9, 88.3] | 86.1 | 1.5 | 0/— | 15979/87.6 | 17.6 |
| b2 | 19591 | 17289 | 11.84 | 75.8 | [74.9, 76.7] | 78.8 | -3.0 | 0/— | 17289/75.8 | 0.6 |
| b3 | 19591 | 17079 | 11.70 | 70.8 | [69.8, 71.7] | 75.4 | -4.7 | 0/— | 17079/70.8 | 0.0 |
| b4 | 19591 | 17675 | 12.11 | 82.1 | [81.2, 82.9] | 81.6 | 0.5 | 0/— | 17675/82.1 | 6.3 |
| tail_high | 19591 | 12419 | 8.51 | 90.1 | [89.1, 91.0] | 86.3 | 3.8 | 0/— | 12419/90.1 | 32.5 |
| tail_low | 19591 | 12925 | 8.85 | 93.7 | [93.0, 94.4] | 90.0 | 3.8 | 0/— | 12925/93.7 | 34.0 |

#### Contract-level calls by NBM/GFS agreement — full holdout, ALL grades, T=0.65

| guidance | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| agree <4F | 288576 | 236642 | 129.45 | 82.5 | [82.5, 82.6] | 82.7 | -0.1 | 0/— | 236642/82.5 | 13.6 |
| NBM-GFS disagree >=4F | 51432 | 24832 | 13.58 | 76.1 | [75.4, 76.8] | 83.3 | -7.2 | 3333/54.3 | 21499/79.5 | 47.2 |

#### By lead — selection, HIGH, T=0.65

| lead h | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 | 59412 | 47399 | 129.86 | 82.5 | [82.4, 82.7] | 82.5 | 0.0 | 0/— | 47399/82.5 | 15.4 |
| 18 | 58134 | 45967 | 125.94 | 82.4 | [82.3, 82.6] | 82.5 | -0.1 | 0/— | 45967/82.4 | 16.0 |

#### By lead — final 3 months, HIGH, T=0.65

| lead h | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 | 14730 | 11723 | 127.42 | 82.4 | [82.1, 82.7] | 82.6 | -0.1 | 0/— | 11723/82.4 | 15.4 |
| 18 | 14196 | 11191 | 121.64 | 82.6 | [82.3, 82.8] | 82.5 | 0.0 | 0/— | 11191/82.6 | 16.0 |

#### Event-level: modal bucket only

Overall: {"n_events":56668,"modal_hit_rate":0.3514,"mean_modal_p":0.3801,"modal_p_quantiles":[0.27,0.33,0.55,0.91],"modal_index_counts":[5239,3463,16170,18246,4379,9171]}


*full*

| filter | T | events | YES calls | calls/day/snapshot | hit % | hit CI | mean p |
|---|---|---|---|---|---|---|---|
| HIGH | 0.30 | 24412 | 21284 | 11.6433 | 36.1 | [35.3, 36.9] | 36.3 |
| HIGH | 0.35 | 24412 | 9403 | 5.1439 | 40.0 | [38.9, 41.3] | 42.3 |
| HIGH | 0.40 | 24412 | 5215 | 2.8528 | 42.2 | [40.6, 43.8] | 46.9 |
| HIGH | 0.45 | 24412 | 3771 | 2.0629 | 44.0 | [42.0, 45.9] | 48.9 |
| HIGH | 0.50 | 24412 | 1600 | 0.8753 | 47.4 | [44.5, 50.1] | 51.9 |
| HIGH | 0.55 | 24412 | 456 | 0.2495 | 52.8 | [47.6, 58.0] | 56.0 |
| HIGH | 0.60 | 24412 | 0 | 0 | — | — | — |
| HIGH | 0.65 | 24412 | 0 | 0 | — | — | — |
| HIGH | 0.70 | 24412 | 0 | 0 | — | — | — |
| HIGH | 0.75 | 24412 | 0 | 0 | — | — | — |
| HIGH | 0.80 | 24412 | 0 | 0 | — | — | — |
| HIGH | 0.85 | 24412 | 0 | 0 | — | — | — |
| HIGH_MEDIUM | 0.30 | 56668 | 42384 | 23.186 | 36.9 | [36.2, 37.6] | 41.6 |
| HIGH_MEDIUM | 0.35 | 56668 | 24730 | 13.5284 | 39.7 | [38.7, 40.7] | 48.5 |
| HIGH_MEDIUM | 0.40 | 56668 | 15664 | 8.5689 | 43.4 | [42.1, 44.8] | 55.4 |
| HIGH_MEDIUM | 0.45 | 56668 | 12328 | 6.744 | 45.0 | [43.4, 46.6] | 59.0 |
| HIGH_MEDIUM | 0.50 | 56668 | 8263 | 4.5202 | 47.9 | [45.9, 49.9] | 65.0 |
| HIGH_MEDIUM | 0.55 | 56668 | 5810 | 3.1783 | 50.9 | [48.5, 53.4] | 71.0 |
| HIGH_MEDIUM | 0.60 | 56668 | 4632 | 2.5339 | 52.0 | [49.3, 54.7] | 74.8 |
| HIGH_MEDIUM | 0.65 | 56668 | 3523 | 1.9272 | 55.8 | [52.8, 58.7] | 78.6 |
| HIGH_MEDIUM | 0.70 | 56668 | 2607 | 1.4261 | 58.7 | [55.2, 62.2] | 83.0 |
| HIGH_MEDIUM | 0.75 | 56668 | 2232 | 1.221 | 61.5 | [57.9, 65.1] | 84.7 |
| HIGH_MEDIUM | 0.80 | 56668 | 1432 | 0.7834 | 65.4 | [60.8, 69.4] | 89.2 |
| HIGH_MEDIUM | 0.85 | 56668 | 1069 | 0.5848 | 67.6 | [62.6, 72.2] | 91.5 |
| ALL | 0.30 | 56668 | 42384 | 23.186 | 36.9 | [36.2, 37.7] | 41.6 |
| ALL | 0.35 | 56668 | 24730 | 13.5284 | 39.7 | [38.6, 40.7] | 48.5 |
| ALL | 0.40 | 56668 | 15664 | 8.5689 | 43.4 | [42.1, 44.7] | 55.4 |
| ALL | 0.45 | 56668 | 12328 | 6.744 | 45.0 | [43.4, 46.6] | 59.0 |
| ALL | 0.50 | 56668 | 8263 | 4.5202 | 47.9 | [45.9, 49.8] | 65.0 |
| ALL | 0.55 | 56668 | 5810 | 3.1783 | 50.9 | [48.4, 53.3] | 71.0 |
| ALL | 0.60 | 56668 | 4632 | 2.5339 | 52.0 | [49.2, 54.6] | 74.8 |
| ALL | 0.65 | 56668 | 3523 | 1.9272 | 55.8 | [52.7, 58.7] | 78.6 |
| ALL | 0.70 | 56668 | 2607 | 1.4261 | 58.7 | [55.3, 62.1] | 83.0 |
| ALL | 0.75 | 56668 | 2232 | 1.221 | 61.5 | [57.8, 65.0] | 84.7 |
| ALL | 0.80 | 56668 | 1432 | 0.7834 | 65.4 | [60.9, 69.6] | 89.2 |
| ALL | 0.85 | 56668 | 1069 | 0.5848 | 67.6 | [62.5, 72.2] | 91.5 |

*selection*

| filter | T | events | YES calls | calls/day/snapshot | hit % | hit CI | mean p |
|---|---|---|---|---|---|---|---|
| HIGH | 0.30 | 19591 | 17057 | 11.6829 | 36.4 | [35.4, 37.3] | 36.3 |
| HIGH | 0.35 | 19591 | 7535 | 5.161 | 40.1 | [38.7, 41.5] | 42.3 |
| HIGH | 0.40 | 19591 | 4164 | 2.8521 | 43.0 | [41.3, 44.9] | 46.9 |
| HIGH | 0.45 | 19591 | 3048 | 2.0877 | 45.0 | [42.8, 47.1] | 48.9 |
| HIGH | 0.50 | 19591 | 1299 | 0.8897 | 49.5 | [46.3, 52.7] | 51.8 |
| HIGH | 0.55 | 19591 | 367 | 0.2514 | 55.6 | [49.6, 61.9] | 56.0 |
| HIGH | 0.60 | 19591 | 0 | 0 | — | — | — |
| HIGH | 0.65 | 19591 | 0 | 0 | — | — | — |
| HIGH | 0.70 | 19591 | 0 | 0 | — | — | — |
| HIGH | 0.75 | 19591 | 0 | 0 | — | — | — |
| HIGH | 0.80 | 19591 | 0 | 0 | — | — | — |
| HIGH | 0.85 | 19591 | 0 | 0 | — | — | — |
| HIGH_MEDIUM | 0.30 | 45260 | 33740 | 23.1096 | 37.3 | [36.4, 38.1] | 41.6 |
| HIGH_MEDIUM | 0.35 | 45260 | 19660 | 13.4658 | 40.3 | [39.2, 41.5] | 48.6 |
| HIGH_MEDIUM | 0.40 | 45260 | 12439 | 8.5199 | 44.5 | [43.0, 45.9] | 55.6 |
| HIGH_MEDIUM | 0.45 | 45260 | 9811 | 6.7199 | 46.3 | [44.6, 48.0] | 59.2 |
| HIGH_MEDIUM | 0.50 | 45260 | 6573 | 4.5021 | 49.4 | [47.2, 51.5] | 65.3 |
| HIGH_MEDIUM | 0.55 | 45260 | 4644 | 3.1808 | 52.7 | [50.0, 55.5] | 71.3 |
| HIGH_MEDIUM | 0.60 | 45260 | 3698 | 2.5329 | 53.8 | [50.5, 57.0] | 75.2 |
| HIGH_MEDIUM | 0.65 | 45260 | 2836 | 1.9425 | 57.2 | [53.6, 60.6] | 79.0 |
| HIGH_MEDIUM | 0.70 | 45260 | 2128 | 1.4575 | 60.4 | [56.5, 64.1] | 83.3 |
| HIGH_MEDIUM | 0.75 | 45260 | 1829 | 1.2527 | 62.9 | [58.6, 67.1] | 85.0 |
| HIGH_MEDIUM | 0.80 | 45260 | 1190 | 0.8151 | 67.2 | [62.5, 72.0] | 89.5 |
| HIGH_MEDIUM | 0.85 | 45260 | 901 | 0.6171 | 69.8 | [64.3, 74.7] | 91.6 |
| ALL | 0.30 | 45260 | 33740 | 23.1096 | 37.3 | [36.4, 38.0] | 41.6 |
| ALL | 0.35 | 45260 | 19660 | 13.4658 | 40.3 | [39.1, 41.4] | 48.6 |
| ALL | 0.40 | 45260 | 12439 | 8.5199 | 44.5 | [42.9, 46.0] | 55.6 |
| ALL | 0.45 | 45260 | 9811 | 6.7199 | 46.3 | [44.6, 48.1] | 59.2 |
| ALL | 0.50 | 45260 | 6573 | 4.5021 | 49.4 | [47.3, 51.6] | 65.3 |
| ALL | 0.55 | 45260 | 4644 | 3.1808 | 52.7 | [49.9, 55.4] | 71.3 |
| ALL | 0.60 | 45260 | 3698 | 2.5329 | 53.8 | [50.6, 56.9] | 75.2 |
| ALL | 0.65 | 45260 | 2836 | 1.9425 | 57.2 | [53.6, 60.4] | 79.0 |
| ALL | 0.70 | 45260 | 2128 | 1.4575 | 60.4 | [56.4, 64.5] | 83.3 |
| ALL | 0.75 | 45260 | 1829 | 1.2527 | 62.9 | [58.7, 67.1] | 85.0 |
| ALL | 0.80 | 45260 | 1190 | 0.8151 | 67.2 | [62.0, 72.0] | 89.5 |
| ALL | 0.85 | 45260 | 901 | 0.6171 | 69.8 | [64.4, 74.8] | 91.6 |

*final*

| filter | T | events | YES calls | calls/day/snapshot | hit % | hit CI | mean p |
|---|---|---|---|---|---|---|---|
| HIGH | 0.30 | 4821 | 4227 | 11.4864 | 35.1 | [33.3, 36.9] | 36.3 |
| HIGH | 0.35 | 4821 | 1868 | 5.0761 | 39.5 | [36.8, 42.4] | 42.2 |
| HIGH | 0.40 | 4821 | 1051 | 2.856 | 38.8 | [35.4, 42.3] | 46.6 |
| HIGH | 0.45 | 4821 | 723 | 1.9647 | 39.6 | [35.0, 44.1] | 48.9 |
| HIGH | 0.50 | 4821 | 301 | 0.8179 | 38.2 | [32.3, 43.9] | 52.0 |
| HIGH | 0.55 | 4821 | 89 | 0.2418 | 41.6 | [30.4, 53.3] | 56.0 |
| HIGH | 0.60 | 4821 | 0 | 0 | — | — | — |
| HIGH | 0.65 | 4821 | 0 | 0 | — | — | — |
| HIGH | 0.70 | 4821 | 0 | 0 | — | — | — |
| HIGH | 0.75 | 4821 | 0 | 0 | — | — | — |
| HIGH | 0.80 | 4821 | 0 | 0 | — | — | — |
| HIGH | 0.85 | 4821 | 0 | 0 | — | — | — |
| HIGH_MEDIUM | 0.30 | 11408 | 8644 | 23.4891 | 35.7 | [34.1, 37.2] | 41.4 |
| HIGH_MEDIUM | 0.35 | 11408 | 5070 | 13.7772 | 37.3 | [35.2, 39.3] | 48.1 |
| HIGH_MEDIUM | 0.40 | 11408 | 3225 | 8.7636 | 39.3 | [36.5, 41.9] | 54.7 |
| HIGH_MEDIUM | 0.45 | 11408 | 2517 | 6.8397 | 39.8 | [36.5, 43.1] | 58.3 |
| HIGH_MEDIUM | 0.50 | 11408 | 1690 | 4.5924 | 41.9 | [38.1, 45.8] | 63.9 |
| HIGH_MEDIUM | 0.55 | 11408 | 1166 | 3.1685 | 43.7 | [39.0, 48.2] | 69.8 |
| HIGH_MEDIUM | 0.60 | 11408 | 934 | 2.538 | 44.9 | [39.9, 49.9] | 73.2 |
| HIGH_MEDIUM | 0.65 | 11408 | 687 | 1.8668 | 49.9 | [44.5, 55.4] | 77.0 |
| HIGH_MEDIUM | 0.70 | 11408 | 479 | 1.3016 | 50.7 | [44.0, 58.2] | 81.8 |
| HIGH_MEDIUM | 0.75 | 11408 | 403 | 1.0951 | 54.8 | [47.3, 62.8] | 83.4 |
| HIGH_MEDIUM | 0.80 | 11408 | 242 | 0.6576 | 56.2 | [47.6, 64.8] | 88.1 |
| HIGH_MEDIUM | 0.85 | 11408 | 168 | 0.4565 | 56.0 | [45.8, 66.3] | 90.6 |
| ALL | 0.30 | 11408 | 8644 | 23.4891 | 35.7 | [34.2, 37.1] | 41.4 |
| ALL | 0.35 | 11408 | 5070 | 13.7772 | 37.3 | [35.1, 39.4] | 48.1 |
| ALL | 0.40 | 11408 | 3225 | 8.7636 | 39.3 | [36.4, 42.3] | 54.7 |
| ALL | 0.45 | 11408 | 2517 | 6.8397 | 39.8 | [36.7, 43.2] | 58.3 |
| ALL | 0.50 | 11408 | 1690 | 4.5924 | 41.9 | [38.0, 45.9] | 63.9 |
| ALL | 0.55 | 11408 | 1166 | 3.1685 | 43.7 | [39.2, 48.4] | 69.8 |
| ALL | 0.60 | 11408 | 934 | 2.538 | 44.9 | [39.9, 50.0] | 73.2 |
| ALL | 0.65 | 11408 | 687 | 1.8668 | 49.9 | [44.9, 55.3] | 77.0 |
| ALL | 0.70 | 11408 | 479 | 1.3016 | 50.7 | [43.9, 57.4] | 81.8 |
| ALL | 0.75 | 11408 | 403 | 1.0951 | 54.8 | [47.4, 62.2] | 83.4 |
| ALL | 0.80 | 11408 | 242 | 0.6576 | 56.2 | [47.3, 64.8] | 88.1 |
| ALL | 0.85 | 11408 | 168 | 0.4565 | 56.0 | [46.3, 65.4] | 90.6 |

## RATES (pbe-rates-path@1.0.0; synthetic monthly path contracts, 4 tenors)


#### Skill (holdout 2018-01..2026-09; clusters = contract months)

| slice | baseline | n cases | n dates (clusters) | Brier/mcBrier model | baseline | BSS | BSS 95% CI | log-loss delta (base − model) | 95% CI |
|---|---|---|---|---|---|---|---|---|---|
| all / Gaussian trailing-vol (named baseline) | p_gauss | 13123 | 105 | 0.1707 | 0.174 | 0.0192 | [-0.0028, 0.0422] | 0.0063 | [-0.0074, 0.0191] |
| all / training climatology (dir × offset × k) | p_clim | 13123 | 105 | 0.1707 | 0.1766 | 0.0337 | [0.0037, 0.0653] | 0.0127 | [-0.0061, 0.0301] |
| k=0 / Gaussian | p_gauss | 4200 | 105 | 0.2006 | 0.2033 | 0.0133 | [-0.0049, 0.031] | 0.0055 | [-0.0064, 0.0163] |
| k=0 / climatology | p_clim | 4200 | 105 | 0.2006 | 0.2042 | 0.0178 | [-0.0069, 0.0417] | 0.0066 | [-0.0085, 0.0207] |
| k=3 / Gaussian | p_gauss | 3520 | 105 | 0.1822 | 0.1864 | 0.0225 | [0.001, 0.043] | 0.0077 | [-0.0063, 0.0204] |
| k=3 / climatology | p_clim | 3520 | 105 | 0.1822 | 0.1926 | 0.054 | [0.0224, 0.0827] | 0.0253 | [0.0063, 0.0428] |
| k=8 / Gaussian | p_gauss | 2867 | 105 | 0.1561 | 0.1611 | 0.0305 | [0.0015, 0.0622] | 0.0086 | [-0.0082, 0.0253] |
| k=8 / climatology | p_clim | 2867 | 105 | 0.1561 | 0.1643 | 0.0497 | [-0.0013, 0.0989] | 0.0181 | [-0.0082, 0.0433] |
| k=13 / Gaussian | p_gauss | 2536 | 105 | 0.1215 | 0.1229 | 0.0119 | [-0.026, 0.05] | 0.0031 | [-0.0128, 0.0176] |
| k=13 / climatology | p_clim | 2536 | 105 | 0.1215 | 0.1225 | 0.0087 | [-0.0589, 0.0758] | -0.0008 | [-0.0275, 0.0256] |
| 5Y / Gaussian | p_gauss | 3280 | 105 | 0.1737 | 0.1762 | 0.0138 | [-0.0132, 0.044] | 0.0023 | [-0.0157, 0.0198] |
| 5Y / climatology | p_clim | 3280 | 105 | 0.1737 | 0.1802 | 0.0361 | [-0.0017, 0.0759] | 0.0128 | [-0.0127, 0.0363] |
| 7Y / Gaussian | p_gauss | 3259 | 105 | 0.1707 | 0.1748 | 0.0236 | [-0.0005, 0.0484] | 0.0071 | [-0.0087, 0.0216] |
| 7Y / climatology | p_clim | 3259 | 105 | 0.1707 | 0.1776 | 0.0389 | [0.0011, 0.0759] | 0.0148 | [-0.0076, 0.0353] |
| 10Y / Gaussian | p_gauss | 3274 | 105 | 0.1736 | 0.1751 | 0.0083 | [-0.0148, 0.03] | 0.0025 | [-0.0109, 0.0144] |
| 10Y / climatology | p_clim | 3274 | 105 | 0.1736 | 0.1771 | 0.0193 | [-0.0116, 0.0503] | 0.007 | [-0.0106, 0.0246] |
| 30Y / Gaussian | p_gauss | 3310 | 105 | 0.1647 | 0.17 | 0.0315 | [0.0096, 0.0544] | 0.0132 | [0.0024, 0.0243] |
| 30Y / climatology | p_clim | 3310 | 105 | 0.1647 | 0.1716 | 0.0405 | [0.0071, 0.0741] | 0.0161 | [-0.0019, 0.0333] |
| 2023-01..2026-09 / Gaussian | p_gauss | 5465 | 45 | 0.1773 | 0.1805 | 0.0177 | [-0.0029, 0.0384] | 0.0078 | [-0.004, 0.0191] |
| 2023-01..2026-09 / climatology | p_clim | 5465 | 45 | 0.1773 | 0.1808 | 0.0195 | [-0.0116, 0.0493] | 0.0069 | [-0.0103, 0.0236] |

#### Calls — FULL holdout (calls/day = per forecast date, all tenors/strikes; only HIGH grade exists)


*Confidence filter: ALL (13,123 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 10633 | 25.32 | 74.8 | [72.8, 76.6] | 74.8 | -0.0 | 0.176 | p_clim 0.0328; p_gauss 0.0201 | 3933 / 67.7 / 69.7 | 6700 / 79.0 / 77.8 | 1197 / 56.9 / [54.1, 59.4] | 11863 | 14.2 | 10.4 | 76.9 |
| 0.60 | 9436 | 22.47 | 77.0 | [75.0, 79.0] | 77.0 | 0.0 | 0.1672 | p_clim 0.0305; p_gauss 0.0198 | 3261 / 70.2 / 72.3 | 6175 / 80.7 / 79.5 | 1349 / 62.2 / [59.6, 64.8] | 10666 | 15.8 | 11.5 | 79.1 |
| 0.65 | 8087 | 19.25 | 79.5 | [77.2, 81.6] | 79.5 | 0.0 | 0.1559 | p_clim 0.0303; p_gauss 0.0197 | 2617 / 72.9 / 74.8 | 5470 / 82.7 / 81.7 | 1260 / 67.4 / [64.5, 70.2] | 9317 | 18.1 | 13.2 | 81.6 |
| 0.70 | 6827 | 16.25 | 81.8 | [79.2, 84.1] | 81.8 | -0.1 | 0.1442 | p_clim 0.0242; p_gauss 0.022 | 2072 / 74.6 / 76.9 | 4755 / 84.9 / 84.0 | 1412 / 71.0 / [67.9, 74.1] | 8057 | 20.9 | 15.3 | 83.8 |
| 0.75 | 5415 | 12.89 | 84.6 | [81.8, 87.0] | 84.4 | 0.2 | 0.128 | p_clim 0.0338; p_gauss 0.024 | 1431 / 77.6 / 79.1 | 3984 / 87.1 / 86.3 | 1565 / 78.1 / [75.6, 80.5] | 6645 | 25.3 | 18.5 | 86.6 |
| 0.80 | 3691 | 8.79 | 87.3 | [84.3, 90.1] | 87.7 | -0.4 | 0.1099 | p_clim 0.0273; p_gauss 0.0207 | 632 / 79.3 / 81.7 | 3059 / 88.9 / 88.9 | 1309 / 82.7 / [79.7, 85.4] | 4921 | 34.2 | 25.0 | 89.3 |
| 0.85 | 2382 | 5.67 | 89.8 | [86.1, 93.2] | 90.8 | -1.0 | 0.0917 | p_clim 0.0312; p_gauss 0.0287 | 22 / 95.5 / 85.1 | 2360 / 89.8 / 90.8 | 919 / 88.1 / [84.5, 91.4] | 3612 | 46.6 | 34.1 | 91.7 |

#### Calls — SELECTION window 2018-01..2026-06


*Confidence filter: ALL (12,721 cases)*

| T | calls (CALL zone) | calls/day/snapshot | hit % | hit 95% CI | mean p | gap pts | Brier called | BSS of called vs baselines | YES n / hit / p | NO n / hit / p | weakest band n / hit / CI | calls incl. ≥.97 | share ≥.95 | share ≥.97 | hit % incl. ≥.97 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 10297 | 25.24 | 75.1 | [73.1, 77.0] | 74.7 | 0.3 | 0.1743 | p_clim 0.0326; p_gauss 0.02 | 3818 / 68.0 / 69.7 | 6479 / 79.2 / 77.7 | 1166 / 57.0 / [54.1, 59.7] | 11498 | 14.3 | 10.4 | 77.2 |
| 0.60 | 9131 | 22.38 | 77.4 | [75.3, 79.4] | 77.0 | 0.4 | 0.1652 | p_clim 0.0306; p_gauss 0.0196 | 3160 / 70.7 / 72.3 | 5971 / 80.9 / 79.4 | 1307 / 62.2 / [59.7, 64.7] | 10332 | 15.9 | 11.6 | 79.5 |
| 0.65 | 7824 | 19.18 | 79.9 | [77.7, 82.2] | 79.5 | 0.5 | 0.1536 | p_clim 0.0309; p_gauss 0.0197 | 2539 / 73.5 / 74.9 | 5285 / 83.0 / 81.7 | 1221 / 67.7 / [64.8, 70.6] | 9025 | 18.2 | 13.3 | 82.0 |
| 0.70 | 6603 | 16.18 | 82.2 | [79.8, 84.7] | 81.8 | 0.4 | 0.1416 | p_clim 0.0252; p_gauss 0.0219 | 2021 / 75.1 / 76.9 | 4582 / 85.3 / 83.9 | 1384 / 71.2 / [68.1, 74.2] | 7804 | 21.0 | 15.4 | 84.2 |
| 0.75 | 5219 | 12.79 | 85.1 | [82.7, 87.6] | 84.4 | 0.7 | 0.1247 | p_clim 0.0362; p_gauss 0.024 | 1387 / 78.4 / 79.1 | 3832 / 87.5 / 86.3 | 1502 / 78.8 / [76.4, 81.2] | 6420 | 25.6 | 18.7 | 87.0 |
| 0.80 | 3565 | 8.74 | 87.6 | [84.7, 90.5] | 87.6 | -0.0 | 0.1072 | p_clim 0.031; p_gauss 0.0206 | 618 / 79.9 / 81.7 | 2947 / 89.2 / 88.9 | 1275 / 83.1 / [80.1, 85.9] | 4766 | 34.4 | 25.2 | 89.5 |
| 0.85 | 2290 | 5.61 | 90.2 | [86.7, 93.6] | 90.8 | -0.6 | 0.0886 | p_clim 0.0364; p_gauss 0.0279 | 22 / 95.5 / 85.1 | 2268 / 90.1 / 90.8 | 888 / 88.3 / [84.7, 91.9] | 3491 | 47.0 | 34.4 | 91.9 |

#### By forecast point k — selection, T=0.7

| k | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 4080 | 2203 | 21.60 | 77.8 | [74.4, 81.4] | 80.2 | -2.4 | 1127/75.5 | 1076/80.2 | 4.3 |
| 3 | 3410 | 1746 | 17.12 | 82.2 | [78.9, 85.5] | 80.8 | 1.4 | 583/76.8 | 1163/84.9 | 7.5 |
| 8 | 2780 | 1501 | 14.72 | 84.1 | [80.6, 87.4] | 82.7 | 1.4 | 238/71.9 | 1263/86.4 | 16.6 |
| 13 | 2451 | 1153 | 11.30 | 88.0 | [84.2, 91.6] | 85.0 | 3.0 | 73/64.4 | 1080/89.6 | 36.5 |

#### By strike offset — selection, T=0.7

| offset | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| -0.3 | 1546 | 942 | 2.36 | 90.3 | [85.6, 94.4] | 86.6 | 3.7 | 0/— | 942/90.3 | 34.7 |
| -0.2 | 1462 | 905 | 2.38 | 86.5 | [78.8, 92.8] | 83.7 | 2.8 | 0/— | 905/86.5 | 11.5 |
| -0.12 | 1272 | 365 | 1.05 | 75.1 | [63.8, 86.5] | 78.2 | -3.1 | 3/66.7 | 362/75.1 | 0.3 |
| -0.06 | 1009 | 236 | 0.84 | 63.6 | [52.6, 74.2] | 72.9 | -9.4 | 225/63.6 | 11/63.6 | 0.0 |
| -0.02 | 763 | 692 | 3.16 | 70.1 | [62.9, 76.9] | 78.4 | -8.3 | 692/70.1 | 0/— | 0.0 |
| 0.02 | 943 | 848 | 3.14 | 80.2 | [74.9, 85.1] | 77.9 | 2.3 | 848/80.2 | 0/— | 0.0 |
| 0.06 | 1182 | 269 | 0.83 | 81.4 | [71.9, 89.5] | 73.1 | 8.3 | 250/82.4 | 19/68.4 | 0.0 |
| 0.12 | 1410 | 376 | 1.01 | 75.3 | [65.9, 84.5] | 78.5 | -3.2 | 3/33.3 | 373/75.6 | 0.5 |
| 0.2 | 1539 | 963 | 2.44 | 86.0 | [80.3, 91.0] | 83.4 | 2.6 | 0/— | 963/86.0 | 9.6 |
| 0.3 | 1595 | 1007 | 2.50 | 86.7 | [81.3, 91.8] | 86.5 | 0.2 | 0/— | 1007/86.7 | 32.2 |

#### By year — full, T=0.7

| year | cases | calls | calls/day | hit % | hit CI | mean p | gap pts | YES n/hit | NO n/hit | share ≥.97 (of all calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| 2018 | 1627 | 801 | 16.69 | 80.2 | [71.4, 88.1] | 83.3 | -3.1 | 168/72.6 | 633/82.2 | 31.1 |
| 2019 | 1525 | 832 | 17.33 | 82.6 | [74.0, 90.0] | 83.3 | -0.7 | 180/73.9 | 652/85.0 | 17.9 |
| 2020 | 1582 | 814 | 16.96 | 80.2 | [71.3, 87.9] | 82.0 | -1.7 | 239/65.7 | 575/86.3 | 18.2 |
| 2021 | 1567 | 813 | 16.94 | 85.1 | [78.3, 90.3] | 83.9 | 1.2 | 174/72.4 | 639/88.6 | 22.9 |
| 2022 | 1357 | 683 | 14.23 | 81.0 | [75.0, 87.2] | 79.3 | 1.7 | 325/85.2 | 358/77.1 | 2.4 |
| 2023 | 1356 | 642 | 13.38 | 77.6 | [72.6, 83.0] | 78.5 | -0.9 | 329/72.3 | 313/83.1 | 0.8 |
| 2024 | 1398 | 754 | 15.71 | 82.1 | [76.3, 87.5] | 80.2 | 1.9 | 265/75.1 | 489/85.9 | 3.1 |
| 2025 | 1495 | 840 | 17.50 | 88.0 | [82.3, 92.2] | 82.0 | 6.0 | 236/75.8 | 604/92.7 | 8.2 |
| 2026 | 1216 | 648 | 18.00 | 77.0 | [65.6, 87.5] | 82.8 | -5.9 | 156/73.7 | 492/78.0 | 18.2 |

## FED (pbe-fed-decision@1.0.0 SHADOW)


#### Skill (2016-2026 meetings; clusters = meetings)

| slice | baseline | n cases | n dates (clusters) | Brier/mcBrier model | baseline | BSS | BSS 95% CI | log-loss delta (base − model) | 95% CI |
|---|---|---|---|---|---|---|---|---|---|
| all / climatology | p_clim | 425 | 85 | 0.523 | 0.5317 | 0.0163 | [-0.1285, 0.1456] | 0.1997 | [0.0526, 0.3467] |
| all / persistence | p_persist | 425 | 85 | 0.523 | 0.5704 | 0.0831 | [0.0295, 0.132] | 0.1649 | [0.0969, 0.2347] |

Top-outcome accuracy 56.5% vs always-hold 65.9%.

| T (top outcome p ≥ T) | calls | meetings | hit % | mean p |
|---|---|---|---|---|
| 0.5 | 371 | 80 | 61.5 | 77.9 |
| 0.6 | 287 | 62 | 73.9 | 85.1 |
| 0.7 | 277 | 60 | 74.0 | 85.8 |
| 0.8 | 268 | 57 | 74.6 | 86.2 |
