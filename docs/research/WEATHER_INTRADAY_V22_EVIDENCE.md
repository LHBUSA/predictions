# maxtemp-intraday 2.2.0: candidate live-weather features (evidence)

Generated 2026-10-04.

| Model | Artifact | State | `research_gate_passed` |
|---|---|---|---|
| `pbe-weather-maxtemp-intraday@2.2.0` | `src/weather/artifacts/temp-intraday-v2.2.json` | **SHADOW** | **true**, on the non-pristine holdout (see below) |

**SHADOW is the owner's instruction.** v2.2 does not replace v2.1 in live production, so the state is `SHADOW` whatever
the gate says. `research_gate_passed` is recorded separately, in the artifact and in every 2.2 result's
`explanation.research_gate_passed`.

**The holdout is not pristine.** The 2025-07..2026-09 holdout was already inspected during v2.0 and v2.1. Here it was
scored once, after selection, for **comparative research only**. A win on it is **not** validation. The only clean
test available is the prospective forward lane in `WEATHER_INTRADAY_V22_SHADOW_PLAN.md`.

**Data rules:**

- **No market data.** Kalshi and Polymarket prices are not inputs, were not used for selection and do not appear in
  scoring.
- **Philadelphia 2026-10-04 is a diagnostic only.** It is not in the training data and played no part in selection.

## Bottom line (blunt)

- **Overall, v2.2 beats v2.1, but only slightly.**
  - 2°F-bucket Brier: 0.0710 vs 0.0721, Δ +0.0011 [0.0007, 0.0015].
  - Bucket log loss: Δ +0.0035 [0.0022, 0.0048].
- **The aggregate gain comes from the odd cutoff hours.**
  - At **even hours**, v2.2 ties v2.1: Brier Δ −0.0001 [−0.0004, 0.0003].
  - At **odd hours** it wins by +0.0022 [0.0019, 0.0027]. That is where v2.1 is still using the previous even-hour
    table, so the gain is mostly the finer calibration resolution.
- **v2.2 helps most under cloud or rain:**
  - raining now: +0.0064 [0.0052, 0.0076]
  - overcast: +0.0045 [0.0037, 0.0053]
  - midday-afternoon: 13-16 LST +0.0052
- **v2.2 is worse in some slices.**
  - Early morning, 01-06 LST: Brier −0.0032 [−0.0038, −0.0027] against v2.1.
  - Desert/mountain stations: −0.0030 overall.
  - Gulf/Texas stations: −0.0009 overall.
  - Clear-sky early mornings, and desert/gulf early mornings, are worse even than the frozen pre-window v1.1.
  - Validation did **not** show the morning weakness: 01-06 LST validation Brier was 0.10532 against 0.10530 for the
    v2.1 structure. The weakness is either a seasonal shift (validation covers Jan-Jun, the holdout Jul-Sep) or overfit.
- **This is not a replacement for v2.1.** It is a reasonable SHADOW candidate whose forward record should be read by
  hour bucket and by station group.

## Data sources and point-in-time rules

| Input | Source | Archive used for research | Availability rule |
|---|---|---|---|
| Hourly/special temperature, current temp, observed max | NWS/FAA ASOS METARs (routine + special), exact CLI station | IEM `asos.py` `tmpf` (`asos/`, unchanged from v2.0) | valid inside the LST window and `available_at = valid + 10 min ≤ now` |
| Official 6-h maximum | METAR remarks `1snTTT` | IEM raw METAR (`asos-max6/`, unchanged from v2.1) | the whole 6-h period lies inside the window, and valid + 10 min ≤ now |
| **Present weather** (`-RA`, `RA`, `SN`, `TS`, `FG`, `BR`, `HZ`, …) | METAR present-weather group | IEM `asos.py` `wxcodes`, routine + special, 2023-01-01..2026-10-01 (`asos-wx/`, new, 31 stations, `fetch-asos-wx-v22.mjs`) | the **newest usable** report (same rule as temperature) |
| **Sky cover + ceiling** (CLR/FEW/SCT/BKN/OVC/VV, base ft) | METAR sky condition group | IEM `asos.py` `skyc1-4`, `skyl1-4` (same pull) | newest usable report |
| NBM day max (TXN) | NWS National Blend, station text (NBS) | IEM MOS archive `NBS` (unchanged) | run usable at cycle + 5 h, ≤ 24 h old (the v1 rule) |
| **NBM temperature path** | NBS `TMP`, every **3 h** | IEM MOS archive `NBS` (same runs) | same run rule; for each hour, the **newest usable run whose TMP points bracket it**; linear interpolation, never across a gap > 6 h |

**Why the path is 3-hourly.** The hourly NBM text product (NBH) is **not** archived by IEM: `api/1/mos.json` and
`mos.py` accept only AVN, GFS, ETA, NAM, NBS, NBE, ECM, LAV and MEX. So the official point-in-time hourly NBM
trajectory cannot be reconstructed for 2023-2026. The research and the engine both use the 3-hourly NBS TMP,
interpolated with the same code (`trajectoryFeatures` in `features.js`).

GFS-LAMP (LAV) is hourly, but it is not NBM, and pulling 24 runs a day for 31 stations was out of scope. It is a
candidate for later.

**Run times.** The IEM NBS archive carries 01/07/13/19Z runs through 2025 and 00/06/12/18Z runs in 2026. The live
caller fetches 00/06/12/18Z. The cycle + 5 h rule is the same for both, and it is conservative: NBS is actually out
about 1 h after cycle.

**Cases.** `build-cases-v22.mjs` streams one station at a time:

- every station-day from 2023-01-03 to 2026-09-29
- **every whole hour h = 1..23** after the LST window opens (v2.x used h = 2, 4, …, 22)
- 935,553 rows in about 2 minutes

At even hours, the v2.0/v2.1 inputs (obs max, current, TXN, 6-h max, target) are identical to `cases-v21.csv`: for
CLIPHL, 15,023 of 15,023 rows matched. Seven rows had no NBM TMP path at the cutoff and were dropped for **every**
method.

| Split | Dates | Cases |
|---|---|---:|
| Fit | 2023-01-03..2024-12-31 | 499,584 |
| Validation | 2025-01-01..2025-06-30 | 123,853 |
| Holdout (non-pristine) | 2025-07-01..2026-09-29 | 312,109 |

## Model

The structure is v2.1's hierarchical empirical E-tables, with the anchor `max(M, round(g))` kept fixed. Three kinds of
candidate were added, and each one had to earn its place on **validation exact-degree log loss**: at least 0.002 nats,
fit on 2023-01..2024-12 and scored on 2025-01..06.

1. **Calibration resolution:** 2-hourly (v2.x) or hourly table hours.
2. **Gap guidance g:**
   - `txn`: the NBS day max, as in v2.x
   - `proj`: remaining path peak + residual
   - `proj_half`: remaining path peak + ½ residual
3. **One extra table level** keyed by a live-weather bucket. The buckets were fixed before fitting (`FEATURE_BUCKETS`
   in `models.js`). Selection was greedy, at most **two** levels, each tried mid-chain or last.

**Selected:**

- hourly calibration hours
- gap guidance `proj_half` = (max of the NBM path over [now, window end)) + ½ × (current temp − path at the current
  report's time)
- levels `hour → hour_gap → hour_gap_drop → hour_gap_drop+sky → station_hour_gap → station_hour_gap_drop → hour_gap_drop+sky+resid`
- all added alphas 160
- no pooled below-max block, because validation preferred none (1.52307 against 1.52311 at α = 20)

## Feature matrix (selection on validation only)

Validation exact-degree log loss. The v2.1 structure refit on the same cases (even hours, TXN) scores **1.60665**.

| Candidate feature | Source / availability | Validation LL when added | Kept? | Why |
|---|---|---|---|---|
| Current reported temp, observed max so far (hourly), official 6-h max | ASOS METAR, newest usable | (base, as v2.1) | kept | v2.0 / v2.1 inputs |
| Finer calibration resolution (hourly) | clock → LST hour of the cutoff | 1.59662 (−0.0100 vs 2-hourly) | **kept** | clears 0.002 |
| Projected remaining-day peak (NBM path max over the rest of the window) + **obs-vs-path residual** (as gap guidance, ½ weight) | NBS TMP path, usable runs; residual uses the current report | 1.53644 (−0.0602) | **kept** | largest single gain. Full-weight residual (`proj`) was worse than TXN (1.61694). |
| Sky cover (clr ≤ SCT / BKN / OVC-VV) | METAR sky group, newest usable report | 1.52824 (−0.0082) | **kept** (level 1) | best first level |
| Obs-vs-path residual bucket (≤−3.5, −1.5, ±1.5, 3.5, >3.5 °F) | NBS path + current report | 1.52307 (−0.0052, placed last) | **kept** (level 2) | clears 0.002 |
| Present-weather regime (precip / overcast / broken / clear / unknown) | METAR wx + sky | 1.52963 first; 1.52717 after sky (−0.0011) | dropped | redundant with sky once sky is in |
| Precipitating now (y/n) | METAR wx group (VC excluded) | 1.53523; 1.52717 after sky | dropped | small and redundant |
| Ceiling (< 1k, < 3k, < 10k ft, none) | METAR sky group | 1.53122; 1.52698 after sky | dropped | below threshold after sky |
| Fog/mist/haze without precip | METAR wx group | 1.53602; 1.52695 | dropped | ≈ no gain |
| Remaining expected warming (path peak − current) | NBS path + current report | 1.53476; 1.52648 | dropped | below threshold (largely inside the gap guidance) |
| Forecast peak hour (hours to the path peak) | NBS path | 1.53534; 1.52657 | dropped | below threshold |
| Trajectory slope, next 1 h | NBS path | 1.53504; 1.52676 | dropped | below threshold |
| Trajectory slope, next 3 h | NBS path | 1.53547; 1.52681 | dropped | below threshold |
| Trajectory slope, next 2 h | NBS path | not tried as a level (between 1 h and 3 h, neither kept) | dropped | — |
| Latest-run vs prior-run path change (mean over remaining hours) | two newest usable NBS runs | 1.53568; 1.52736 | dropped | below threshold |

All candidates, placements and alphas are in the artifact under `selection_validation`.

## Leakage audit

Every feature, its source, and the timestamp rule that makes it available at `now`:

| Feature (engine name) | Source class / provider | Availability rule | Market-derived? |
|---|---|---|---|
| `obs_max_so_far_f`, `obs_max_hourly_f`, `obs_max_so_far_int_f`, `current_temp_f`, `obs_count`, `drop_from_max_f` | official, NWS/FAA ASOS (METAR) | valid ∈ [window start, window end) and `available_at` ≤ now. Live: first-seen, never earlier than valid + 10 min. | no |
| `obs_max6_so_far_f`, `obs_max6_groups` | official, METAR `1snTTT` | as above, plus valid − 6 h ≥ window start | no |
| `present_weather_regime`, `present_weather_obscuration`, `sky_cover_rank`, `ceiling_ft` | official, METAR wx/sky groups | newest report with `available_at` ≤ now | no |
| `hours_into_window_lst`, `calibration_hour_lst` | contract window terms + now | deterministic | no |
| `guidance_max_temp_f`, `guidance_kind` | official, NWS NBM (NBS) via IEM | runtime + 5 h ≤ now, and age ≤ 24 h | no |
| `nbm_path_at_current_report_f`, `obs_minus_nbm_path_f`, `nbm_remaining_peak_f`, `nbm_remaining_peak_lead_h`, `nbm_remaining_warming_f`, `nbm_slope_1h/2h/3h_f`, `nbm_run_change_f`, `gap_guidance_f`, `guidance_gap_f` | official, NBS TMP path via IEM | same run rule. Forecast valid times after now are legitimate forecasts issued ≥ 5 h earlier. | no |
| `intraday_table` | research, PBE calibration artifact (ASOS + NBM vs ACIS/CLI 2023-01..2025-06) | frozen artifact | no |

Enforcement:

- `assertModelInput` runs on every observation row and on the model input `x`.
- `buildFeatureVector` enforces source classes, and `assertContractTermsOnly` checks the contract.
- No feature or level name matches `MARKET_KEY_PATTERN`. This is checked in `test/weather-intraday-v22.test.js`, along
  with `MarketLeakageError` on an injected `kalshi_yes_bid`.
- Grep over every `*v22*` script and `shadow.js`: the only market words are comments and the nulled
  `market_probability` / `market_snapshot_key` / `market_observed_at` on shadow rows.
- Kalshi and Polymarket were not used as inputs, for selection, or for the PHL diagnostic.

## Holdout (2025-07..2026-09, non-pristine, comparative only)

312,109 cases, 95% date-cluster bootstrap with 1,000 draws. Δ = baseline − v2.2, so positive means v2.2 is better.

How each method is scored:

- **v2.1 and v2.0:** their frozen artifacts, on the live engine's even-hour floor table at odd hours. This is exactly
  what production does.
- **Buckets:** seven per case, centred on the pre-window guidance, scored at whole-percent precision within [0.01, 0.99].

| Metric | v2.2 | v2.1 | v2.0 | v1.1 pre-window | Persistence | Climatology-of-remaining |
|---|---:|---:|---:|---:|---:|---:|
| 2°F-bucket Brier | **0.0710** | 0.0721 (Δ +0.0011 [0.0007, 0.0015]) | 0.0810 (+0.0099 [0.0095, 0.0104]) | 0.1071 (+0.0361 [0.0354, 0.0369]) | 0.1729 (+0.1019 [0.1005, 0.1032]) | 0.1295 (+0.0585 [0.0569, 0.0602]) |
| Bucket log loss | **0.2312** | 0.2347 (+0.0035 [0.0022, 0.0048]) | 0.2592 (+0.0280 [0.0266, 0.0294]) | 0.3486 (+0.1174 [0.1149, 0.1202]) | 0.8204 (+0.5891 [0.5822, 0.5954]) | 0.4297 (+0.1985 [0.1924, 0.2050]) |
| Exact-degree log loss | **1.516** | 1.543 (+0.027 [0.018, 0.035]) | 1.718 | 2.276 | 3.187 | 2.627 |

The gate rule is the existing one: the CI must be above 0 for Brier **and** bucket log loss against v2.1, v2.0, v1.1,
persistence and climatology. It passes on all five, so `research_gate_passed: true`. **That is on a non-pristine
holdout.**

The v2.2 model without its two weather levels (hourly + `proj_half` only) scores Brier 0.0712. So the two live-weather
levels add +0.0002 [0.0001, 0.0003] Brier on top of the gap source and the resolution.

### Slices against v2.1 (Brier; bucket log loss in the last column)

| Slice | n | v2.2 | v2.1 | Δ Brier (CI) | Δ bucket LL (CI) | v1.1 | Δ vs v1.1 |
|---|---:|---:|---:|---|---|---:|---|
| **Even hours** | 155,355 | 0.0730 | 0.0729 | −0.0001 [−0.0004, 0.0003] | +0.0001 [−0.0012, 0.0014] | 0.1071 | +0.0341 |
| **Odd hours** | 156,754 | 0.0691 | 0.0713 | +0.0022 [0.0019, 0.0027] | +0.0069 [0.0056, 0.0082] | 0.1072 | +0.0381 |
| 01-06 LST | 71,974 | 0.1064 | 0.1032 | **−0.0032 [−0.0038, −0.0027]** | −0.0111 [−0.0132, −0.0090] | 0.1072 | +0.0008 [−0.0001, 0.0018] |
| 07-12 LST | 84,812 | 0.1002 | 0.1012 | +0.0010 [0.0004, 0.0016] | +0.0049 | 0.1071 | +0.0069 |
| 13-16 LST | 56,544 | 0.0703 | 0.0755 | +0.0052 [0.0046, 0.0057] | +0.0158 | 0.1071 | +0.0368 |
| 17-23 LST | 98,779 | 0.0206 | 0.0226 | +0.0020 [0.0018, 0.0023] | +0.0059 | 0.1071 | +0.0865 |
| northeast | 70,527 | 0.0706 | 0.0732 | +0.0027 [0.0019, 0.0035] | +0.0086 | 0.1104 | +0.0399 |
| midwest_plains | 60,437 | 0.0702 | 0.0740 | +0.0037 [0.0030, 0.0044] | +0.0127 | 0.1113 | +0.0411 |
| pacific_coast | 30,266 | 0.0686 | 0.0712 | +0.0027 [0.0019, 0.0034] | +0.0068 | 0.1092 | +0.0406 |
| interior_east | 40,269 | 0.0728 | 0.0736 | +0.0007 [−0.0002, 0.0016] | +0.0032 | 0.1094 | +0.0365 |
| gulf_texas | 70,476 | 0.0701 | 0.0693 | **−0.0009 [−0.0016, −0.0001]** | −0.0029 | 0.1025 | +0.0323 |
| desert_mountain | 40,134 | 0.0747 | 0.0717 | **−0.0030 [−0.0040, −0.0021]** | −0.0104 | 0.0996 | +0.0249 |

**Station group × hour bucket (24 cells) against v2.1:** 12 better, 7 not significant, 5 worse.

| Worse cell | Δ Brier vs v2.1 | Δ vs v1.1 |
|---|---|---|
| desert_mountain 01-06 | −0.0089 [−0.0104, −0.0073] | **worse than v1.1**: −0.0077 |
| gulf_texas 01-06 | −0.0070 [−0.0082, −0.0058] | **worse than v1.1**: −0.0039 |
| desert_mountain 07-12 | −0.0039 [−0.0054, −0.0024] | — |
| gulf_texas 07-12 | −0.0034 [−0.0047, −0.0021] | — |
| interior_east 01-06 | −0.0027 [−0.0040, −0.0014] | — |

### Weather-regime slices (regime of the newest usable report at the cutoff)

| Regime | n | v2.2 | v2.1 | Δ Brier (CI) | Δ bucket LL (CI) | v1.1 | Persistence |
|---|---:|---:|---:|---|---|---:|---:|
| **Raining / precip now** | 20,428 | 0.0687 | 0.0751 | **+0.0064 [0.0052, 0.0076]** | +0.0213 [0.0171, 0.0254] | 0.1173 | 0.1300 |
| **Overcast** | 48,734 | 0.0795 | 0.0840 | **+0.0045 [0.0037, 0.0053]** | +0.0160 [0.0130, 0.0190] | 0.1164 | 0.1727 |
| Broken | 81,681 | 0.0703 | 0.0704 | +0.0001 [−0.0004, 0.0005] | +0.0001 | 0.1076 | 0.1683 |
| Clear (≤ SCT) | 160,940 | 0.0691 | 0.0690 | −0.0001 [−0.0005, 0.0004] | −0.0008 | 0.1028 | 0.1808 |
| Unknown (no wx/sky) | 326 | 0.0688 | 0.0679 | −0.0009 [−0.0097, 0.0084] | — | 0.1045 | 0.1787 |

Regime × hour against v2.1:

| Cell | Δ Brier vs v2.1 | Note |
|---|---|---|
| precip 13-16 | +0.0164 [0.0140, 0.0189] | strongest win |
| overcast 13-16 | +0.0130 [0.0114, 0.0147] | — |
| precip 07-12 | +0.0081 | — |
| overcast 07-12 | +0.0047 | — |
| clear 01-06 | −0.0043 [−0.0050, −0.0036] | also worse than v1.1: −0.0018 [−0.0027, −0.0010] |
| broken 01-06 | −0.0043 [−0.0052, −0.0034] | — |

### Validation (fit 2023-01..2024-12 → 2025-01..06), same slices

From `val-hour-diagnostic-v22.mjs`. This reads no holdout rows. Each cell is Brier / exact-degree LL.

| Model (fit on fit split) | ALL | 01-06 | 07-12 | 13-16 | 17-23 |
|---|---|---|---|---|---|
| v2.1 structure (even, TXN) | 0.07337 / 1.607 | 0.10530 / 2.285 | 0.10369 / 2.225 | 0.07725 / 1.624 | 0.02171 / 0.569 |
| hourly + `proj_half` only | 0.07055 / 1.536 | 0.10658 / 2.316 | 0.09949 / 2.124 | 0.07010 / 1.488 | 0.01954 / 0.489 |
| **v2.2 selected** | 0.07008 / 1.523 | 0.10532 / 2.281 | 0.09841 / 2.095 | 0.06943 / 1.472 | 0.02030 / 0.506 |
| hourly + TXN | 0.07297 / 1.597 | 0.10529 / 2.277 | 0.10372 / 2.223 | 0.07607 / 1.603 | 0.02111 / 0.556 |

On validation, v2.2 tied the v2.1 structure at 01-06 LST and gained from 07 LST on. The holdout morning loss did not
show up there.

The sky and residual levels make 17-23 LST slightly **worse** than the gap-source-only model, both on validation
(0.0203 vs 0.0195) and on the holdout (0.0206 vs 0.0196). The greedy aggregate selection accepted that trade.

No hour-gated or station-gated variant was fitted afterwards. Doing so would be selection on the holdout.

### Calibration (holdout buckets)

| Bin | n | v2.2 mean p / observed | v2.1 mean p / observed |
|---|---:|---|---|
| 0-10% | 1,422,187 | 0.022 / 0.019 | 0.024 / 0.019 |
| 10-20% | 202,632 | 0.148 / 0.151 | 0.142 / 0.138 |
| 20-30% | 167,459 | 0.251 / 0.251 | 0.249 / 0.245 |
| 30-40% | 156,058 | **0.348 / 0.331** | 0.347 / 0.345 |
| 40-50% | 80,142 | **0.440 / 0.421** | 0.441 / 0.440 |
| 50-60% | 30,392 | 0.545 / 0.536 | 0.543 / 0.567 |
| 60-70% | 19,983 | 0.649 / 0.650 | 0.644 / 0.684 |
| 70-80% | 13,754 | 0.744 / 0.742 | 0.745 / 0.776 |
| 80-90% | 13,234 | 0.853 / 0.861 | 0.857 / 0.888 |
| 90-100% | 78,922 | 0.971 / 0.968 | 0.968 / 0.970 |

v2.2 is slightly over-confident at 30-50% (about 2 pts). v2.1 is under-confident at 50-90% (3-4 pts).

## Engine parity and v2.0/v2.1 byte-identity

| Check | Result |
|---|---|
| `engine-parity-v22.mjs CLIPHL 25` (archived raw inputs, h = 1..23) | 558 cases, temp max abs diff **0**, 0 feature mismatches |
| `engine-parity-v22.mjs CLIDEN 15` / `CLIMIA 10` | 332 / 221 cases, max abs diff **0**, 0 feature mismatches |
| `v20-v21-byte-parity.mjs <git-HEAD copy of src/> CLIPHL,CLIDEN,CLIMIA 8` | 2,760 outputs (v2.0 temp, v2.1 temp, precip 2.0; 23 cutoffs; with **and** without the new `wxcodes`/`sky` fields on the obs rows): **0 byte differences**, including `inputHash` |
| `engine-parity.mjs CLIPHL 25` (v2.0) | 275 cases, temp 0, rain 3.2e-4 (unchanged from the v2.0 report) |
| `engine-parity-v21.mjs CLIPHL 25` / `CLIDEN 15` | temp 0 / 0 (unchanged) |
| `npm test` | `ℹ tests 268 · ℹ pass 268 · ℹ fail 0` |

**How 2.2.0 is enabled.** It is opt-in: `import 'src/weather/intraday/temp-v22.js'` registers the artifact through
`registerIntradayTempArtifact`, which accepts only a SHADOW 2.2.x artifact.

- **Why:** the artifact is 2.8 MB, 512 KB gzipped. `engine.js` does not import it, so the production v2.1 bundle
  (`intraday-live.js`) does not grow.
- **What did not change:** `INTRADAY_TEMP_MODELS`, the default `tempModelVersion` (`'2.0.0'`), and every v2.0/v2.1
  code path. The additive edits are listed below.

Additive edits:

- `models.js`: `tempEDistribution` and `tempFinalDistribution` take an optional `keys` argument. When it is omitted
  they behave exactly as before.
- `features.js`: new functions only.
- `observations.js`: new functions only. `parseNwsObservations` is unchanged; `parseNwsObservationsV22` wraps it.

## Philadelphia 2026-10-04 (DIAGNOSTIC ONLY; never training truth; no market input)

Replayed with `scripts/research/intraday/phl-case-v22-2026-10-04.mjs`. Inputs:

- **Observations:** the live api.weather.gov KPHL METARs and specials, parsed with `parseNwsObservationsV22`.
  - available = valid + 10 min
  - newest usable report at both times: the 18:07Z special, 17/15 (62.06°F), `BKN007 OVC012`, `RAE06` (rain had just
    ended)
  - 6-h max group 64.04°F (11:54Z)
- **Guidance:** IEM NBS 12Z (usable from 17Z) and 06Z.
  - 12Z TXN 67°F
  - 12Z TMP path: 18Z 64, 21Z 64, 00Z 62
  - 06Z path: 18Z 65, 21Z 65

Final-high bucket probabilities, raw:

| Model | ≤63 | 64-65 | 66-67 | 68-69 | 70-71 | ≥72 |
|---|---:|---:|---:|---:|---:|---:|
| v2.0 (18:18Z and 18:33Z) | 0.079 | 0.206 | 0.370 | 0.264 | 0.080 | 0.001 |
| v2.1 (18:18Z and 18:33Z) | 0.000 | 0.249 | 0.358 | 0.311 | 0.078 | 0.004 |
| **v2.2 (18:18Z and 18:33Z)** | 0.004 | **0.791** | 0.174 | 0.030 | 0.001 | 0.000 |

**Why v2.2 says about 79% on 64-65.** The inputs:

- M = 64, current 62, calibration hour 13 LST.
- The 12Z NBM **path** never exceeds 64°F for the rest of the day (remaining peak 64, peak lead 0 h), although its
  TXN says 67.
- The current report is 1.94°F below the path.
- So the gap guidance is 64 + ½ × (−1.94) = 63.03, and round(g) − M = −1, giving cell `13|-1|1`. In training that cell
  means the final high rarely ends above M + 1.
- Overcast (`ovc`) and residual bucket `m2` sharpen it a little.

Ablation using the same artifact tables:

| Variant | P(64-65) |
|---|---:|
| No residual level | 0.785 |
| No sky or residual levels | 0.731 |
| Sky = clear | 0.744 |
| Sky = broken | 0.672 |
| Gap guidance 64.5 | 0.38 |
| Gap guidance 65.5 | 0.19 |
| Gap guidance 66.5 | 0.11 |

The **driver is the NBM path versus its own TXN**, not the present-weather state. The weather levels add about 6
points.

No input changed between 18:18Z and 18:33Z (no new report, same runs). By the dedupe rule, the 18:33Z evaluation
would write **no** new shadow row.

This is not evidence that v2.2 is right about Philadelphia. The final CLI value was not known when this was written.
It is also not a reason for the feature set: every feature was chosen on the 2025-01..06 validation split before this
replay was run.

## Caveats

1. **The holdout is non-pristine.** It was inspected in v2.0/v2.1 and is used here comparatively. Only the forward
   SHADOW lane can validate v2.2.
2. **The gain over v2.1 is small and uneven.**
   - All of it is at odd hours.
   - v2.2 is worse at 01-06 LST, at desert_mountain and gulf_texas, and worse than v1.1 in desert, gulf and clear-sky
     early mornings.
   - The forward lane must report these slices.
3. **There is no hourly NBM archive.** The path is the 3-hourly NBS TMP, interpolated. A live NBH feed would be a
   **different input** and must not be swapped in without refitting.
4. **The `proj_half` weight (½) was picked from three values** (0, ½, 1 via `txn` / `proj_half` / `proj`) on
   validation. Full weight was worse than TXN.
5. **The greedy feature search stopped at two levels by design.** Present-weather regime and precip-now are **not**
   model inputs. They appear only as slices and evidence, because sky captured their signal on validation.
6. **The publication lag is still assumed** (10 min). The live caller must keep first-seen times.
7. **The target is ACIS (final CLI), not TWC settlement**, the same as v2.x.

## Reproduce

```text
node scripts/research/intraday/fetch-asos-wx-v22.mjs                 # 31 requests, ~3 min -> asos-wx/
node scripts/research/intraday/build-cases-v22.mjs                   # ~2 min -> cases-v22.csv (935,553 rows)
node --max-old-space-size=3500 scripts/research/intraday/train-eval-v22.mjs   # ~9 min -> artifact + evidence-v22.json
node --max-old-space-size=3000 scripts/research/intraday/val-hour-diagnostic-v22.mjs
node scripts/research/intraday/engine-parity-v22.mjs CLIPHL 25
node scripts/research/intraday/v20-v21-byte-parity.mjs <copy of src/ at git HEAD> CLIPHL,CLIDEN,CLIMIA 8
node scripts/research/intraday/phl-case-v22-2026-10-04.mjs
node --test test/weather-intraday-v22.test.js
```

Scratch data: `D:\Workers\scratch\predictions-intraday\` (`asos-wx\`, `cases-v22.csv`, `evidence-v22.json`,
`train-v22.log`, `kphl-obs-2026-10-04-v22.json`, `nbs-kphl-2026-10-04T{06,12}Z.json`).
