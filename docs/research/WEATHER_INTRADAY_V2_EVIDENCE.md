# Weather intraday v2: validation evidence

Generated 2026-10-04. Design: `docs/WEATHER_INTRADAY_V2_DESIGN.md`. This is a separate model generation. Pre-window
v1.x (`src/weather/engine.js` and its artifacts) is not modified.

| Model | Artifact | State | Holdout gate |
|---|---|---|---|
| `pbe-weather-maxtemp-intraday@2.0.0` | `src/weather/artifacts/temp-intraday-v2.0.json` | **RESEARCH** | beats pre-window v1.1, persistence and climatology-of-remaining (95% CI) |
| `pbe-weather-precip-intraday@2.0.0` | `src/weather/artifacts/precip-intraday-v2.0.json` | **RESEARCH** | beats pre-window v1.1, observed-only and climatology-of-remaining (95% CI) |

Gate rule (in the artifacts): a model is RESEARCH only if the 95% date-cluster bootstrap CI of (baseline − intraday) is
above 0 on the full holdout for **both** scoring rules (temp: 2°F-bucket Brier and bucket log loss; rain: Brier and log
loss) against **every** baseline. Otherwise it is SHADOW. Both models also beat both required baselines in all 24
station-group × hour-bucket cells, on both rules, with the CI above 0. The weakest cell is `desert_mountain | 02-06 LST`
against v1.1: temp Brier +0.0011 [0.0004, 0.0018] and rain Brier +0.0043 [0.0002, 0.0081].

RESEARCH means validated against these baselines. It does not mean a proven edge against the market. No market data was
used anywhere.

## Data and point-in-time rules

- **Observations:** the IEM ASOS archive (`asos.py`, `tmpf` and `p01i`, routine METARs (report_type 3) plus specials
  (report_type 4), 2023-01-01..2026-10-01 UTC), at the exact CLI station for all 31 sites. That is 1.2M reports, under
  `D:\Workers\scratch\predictions-intraday\asos`, fetched by `scripts/research/intraday/fetch-asos.mjs`.
- **Publication lag:** `available_at = valid_at + 10 min` (`OBS_PUBLICATION_LAG_MIN`). This lag is a conservative fixed
  value, not a measurement. The IEM archive and api.weather.gov carry no receipt time. METARs are observed at about :51-:56
  and sent within minutes. At an on-the-hour cutoff, the :5x report from the previous hour is therefore **excluded**.
  The live caller should store `first_seen_at`. `parseNwsObservations(body, { firstSeenAt })` then never dates an ob
  earlier than that.
- **Window:** only reports valid inside [observation_start, observation_end) are used. The CLI day runs in local
  standard time.
- **Guidance:** National Blend (NBS) day max (TXN) and 6-h PoP. A run is usable at cycle + 5 h and up to 24 h old, the v1
  rule. Remaining-window PoP is built from hour-aligned slots: each slot takes the newest usable run whose 6-h period
  contains it, and an hour's share of a period's PoP is 1-(1-p)^(1/6).
- **Target:** the NOAA RCC-ACIS daily record at the CLI site (GHCN-D), which is the final NWS CLI value. This is the same
  target v1.1 was trained on.
- **Cases:** every station-day from 2023-01-03 to 2026-09-29, at cutoffs 02, 04, ..., 22 local standard time, giving
  465,587 rows (`scripts/research/intraday/build-cases.mjs`, about 100 s, streamed one station at a time).
- **Split:** the same as v1.1. Selection used fit 2023-01..2024-12 and validation 2025-01..2025-06. The final fit used
  2023-01..2025-06. The holdout is 2025-07..2026-09.
  - Temp: 310,125 train / 155,430 holdout cases.
  - Rain: 309,644 train / 155,130 holdout cases.
- **Frozen pre-window baseline:** the v1.1 forecast as the v1 engine would produce it at window start, for the same
  contract-day. It uses the same artifacts and the same tier rules: NBM if usable, otherwise GFS.

## Models

**Max temp.** M = round(observed ASOS max so far) and D = round(current temp). The model is an empirical distribution of
E = CLI max − max(M, round(guidance max)). It is indexed by cutoff hour × guidance gap bucket (round(g) − M) × drop
bucket (M − D), with hierarchical shrinkage: hour → hour_gap → hour_gap_drop → station_hour_gap → station_hour_gap_drop.

The outcome "final CLI max below the observed max" (y < M) is treated as a rare event estimated on pooled data:

- The rate q comes from the hour × gap cell, shrunk to the hour, shrunk to the global rate.
- The size of the shortfall comes from a pooled deficit histogram.
- The y ≥ M part comes from the table.

Selection on validation, by exact-degree log loss:

| Candidate | Validation exact-degree log loss |
|---|---:|
| M1 (M-anchored) | 1.956 |
| M4 (M-anchored) | 1.930 |
| A1 (max(M, guidance) anchor) | 1.820 |
| **A5 (chosen)** | **1.792** |
| A5 + pooled below-max block (α = 100) | 1.7896 |

**Rain.** If measurable rain (≥ 0.01 in) is reported inside the window, P(YES) is the calibrated station bound. The
report must be valid at least 65 min after window start, so that its hourly accumulation lies inside the window.
Otherwise P(YES) comes from a logistic model (candidate R3, chosen on validation):

- Inputs: logit(remaining PoP), remaining hours, trace seen, measurable only in the first report, logit(climatology),
  and PoP × hours.
- Validation log loss: R1 0.1750, R2 0.1574, **R3 0.1573**.

## Holdout headline (2025-07..2026-09; bootstrap 1,000 draws, clusters = dates)

| Model / metric | intraday | pre-window v1.1 | persistence / observed-only | climatology-of-remaining |
|---|---:|---:|---:|---:|
| Temp, 2°F-bucket Brier | **0.0814** | 0.1071 (Δ +0.0257 [0.0250, 0.0265]) | 0.2013 (Δ +0.1199 [0.1179, 0.1218]) | 0.1437 (Δ +0.0623 [0.0607, 0.0638]) |
| Temp, bucket log loss | **0.2608** | 0.3485 (Δ +0.0877 [0.0854, 0.0904]) | 0.9535 (Δ +0.6927 [0.6834, 0.7014]) | 0.4741 (Δ +0.2133 [0.2072, 0.2193]) |
| Temp, exact-degree log loss | **1.729** | 2.275 (Δ +0.546 [0.532, 0.562]) | 3.913 | 3.047 |
| Rain, Brier | **0.0476** | 0.0762 (Δ +0.0286 [0.0265, 0.0308]) | 0.1107 (Δ +0.0631 [0.0579, 0.0686]) | 0.0915 (Δ +0.0439 [0.0407, 0.0472]) |
| Rain, log loss | **0.1595** | 0.2481 (Δ +0.0886 [0.0822, 0.0953]) | 0.5288 (Δ +0.3693 [0.3435, 0.3958]) | 0.3073 (Δ +0.1478 [0.1392, 0.1563]) |

Δ = baseline − intraday, with its 95% CI. Positive means intraday is better.

How each method is scored:

- **Temp buckets:** 7 buckets per contract-day, centred on the pre-window guidance: two tails plus five 2°F buckets.
- **Probability bounds:**
  - Every method is scored at whole-percent precision, clamped to [0.01, 0.99].
  - For exact-degree log loss, persistence uses 0.99/0.01, v1.1 uses its own bounds, and intraday and climatology are
    floored at 0.001.
- **Climatology-of-remaining:**
  - Temp: y = max(M, round(X)), with X ~ N(1991-2020 normal high, sd).
  - Rain: the training P(YES | nothing measurable yet) for each station × season × hour, and 0.99 once measured.

### By hour bucket (vs the two required baselines)

| Slice | Temp Brier: intraday / v1.1 / persistence | Rain Brier: intraday / v1.1 / observed-only |
|---|---|---|
| 02-06 LST | 0.1031 / 0.1071 (+0.0040 [0.0033, 0.0048]) / 0.2642 | 0.0673 / 0.0762 (+0.0090 [0.0073, 0.0106]) / 0.1858 |
| 08-12 LST | 0.1001 / 0.1071 (+0.0070 [0.0063, 0.0079]) / 0.2583 | 0.0543 / 0.0762 (+0.0219 [0.0196, 0.0242]) / 0.1278 |
| 14-16 LST | 0.0692 / 0.1071 (+0.0380 [0.0370, 0.0390]) / 0.1729 | 0.0418 / 0.0762 (+0.0344 [0.0319, 0.0372]) / 0.0829 |
| 18-22 LST | 0.0491 / 0.1071 (+0.0580 [0.0567, 0.0593]) / 0.1004 (+0.0513 [0.0489, 0.0536]) | 0.0252 / 0.0762 (+0.0510 [0.0478, 0.0547]) / 0.0372 (+0.0120 [0.0097, 0.0146]) |

### By station group

| Group | Temp Brier: intraday / v1.1 (Δ CI) | Rain Brier: intraday / v1.1 (Δ CI) |
|---|---|---|
| northeast | 0.0823 / 0.1104 [0.0265, 0.0298] | 0.0495 / 0.0777 [0.0231, 0.0342] |
| midwest_plains | 0.0818 / 0.1113 [0.0279, 0.0313] | 0.0505 / 0.0833 [0.0280, 0.0381] |
| gulf_texas | 0.0787 / 0.1024 [0.0226, 0.0249] | 0.0529 / 0.0867 [0.0295, 0.0380] |
| desert_mountain | 0.0825 / 0.0996 [0.0158, 0.0184] | 0.0413 / 0.0586 [0.0124, 0.0218] |
| pacific_coast | 0.0829 / 0.1092 [0.0248, 0.0278] | 0.0183 / 0.0374 [0.0141, 0.0244] |
| interior_east | 0.0817 / 0.1093 [0.0258, 0.0295] | 0.0591 / 0.0916 [0.0275, 0.0378] |

The full tables (all metrics, all 24 group × hour cells, and climatology) are in
`D:\Workers\scratch\predictions-intraday\evidence.json` and `tables.md`.

## Calibration (holdout)

| Bin | Temp-bucket intraday: n / mean p / observed | Rain intraday: n / mean p / observed |
|---|---|---|
| 0-10% | 669,324 / 0.024 / 0.020 | 95,858 / 0.021 / **0.011** |
| 10-20% | 120,609 / 0.141 / 0.139 | 9,889 / 0.144 / 0.154 |
| 20-30% | 83,320 / 0.250 / 0.247 | 5,706 / 0.248 / 0.269 |
| 30-40% | 102,710 / 0.347 / 0.348 | 4,205 / 0.349 / 0.375 |
| 40-50% | 40,172 / 0.441 / 0.444 | 3,413 / 0.448 / 0.467 |
| 50-60% | 23,126 / 0.546 / 0.549 | 2,664 / 0.548 / 0.559 |
| 60-70% | 15,480 / 0.647 / 0.647 | 2,303 / 0.650 / 0.677 |
| 70-80% | 8,710 / 0.746 / 0.745 | 2,354 / 0.750 / 0.763 |
| 80-90% | 13,773 / 0.859 / 0.861 | 2,466 / 0.851 / 0.850 |
| 90-100% | 10,786 / 0.940 / 0.940 | 26,272 / 0.985 / 0.991 |

The temp model is close to perfectly calibrated. The rain model over-forecasts at the low end: mean 2.1% against 1.1%
observed, partly because of the 1% publication floor. It is slightly under-confident from 10% to 70%.

## Calibrated bounds (acceptance requirement 1: no arbitrary caps)

### Rain: ASOS measurable vs final CLI

Counted per station-day, training 2023-01..2025-06:

- **Pooled:** 7,145 of 7,153 days with measurable rain reported inside the window ended with CLI > 0.00 (8
  disagreements). The pooled bound is (7145 + 0.5)/(7153 + 1) = **0.99881**.
- **Shrinkage:** an empirical-Bayes Beta prior was fitted by method of moments. Between-station variance
  (5.24e-6) barely exceeds binomial variance (5.14e-6), so the prior strength is k = 12,546 and every station is
  effectively pooled.
- **Station bounds:** 0.99861 (CLIMIA: 311/314) to 0.99884. Every station's n and yes are recorded in the artifact. The
  smallest samples are CLILAS n = 50, CLIPHX n = 57, CLILAX n = 99 and CLIABQ n = 100.
- **Holdout check:** 3,272 of 3,279 agreed (0.99787). The disagreements were CLINYC 1/142, CLIEWR 2/126, CLICLL 1/82 and
  CLIABQ 3/63. ABQ's holdout disagreement rate (4.8%) is well above its bound. Treat ABQ as the weakest station.
- **First-report-only measurable** (accumulation may predate the window): 184 of 202 training days (91%) and 87 of 98
  holdout days (89%). These cases are **not** bounded. They go to the logistic model with a `straddle_measurable`
  feature.

### Temp: final CLI max below the observed ASOS max

This is driven by rounding, conversion and QC of individual ASOS reports.

- **Training:** y < M occurred in 438 of 310,125 cases. The rate rises from 8/28,159 at 02 LST to 79/28,204 at 22 LST.
- **Deficit histogram:** 1°F: 371, 2°F: 21, 3°F: 9, 4°F: 4, 5°F: 4, 7°F: 16, 8°F: 7, ≥14°F: 6.
- **At the 22 LST cutoff:** E = CLI − round(hourly max) is 0 in 39%, +1 in 49% and +2 in 10% of cases. It is negative in
  0.29%. So CLI usually reports **above** the hourly ASOS max, because the 1/5-minute peaks are missed between reports.
- Both effects come from the data. No hard-coded bound is applied. A bucket below an already-observed max gets the
  pooled cell rate, not a forced zero:
  - Typically 0.1-0.2% for y < M in afternoon cells.
  - Up to about 1.3% where the observed max already exceeds guidance by 3°F or more. At 14 LST that cell is 13 of 1,084
    pooled cases, many of them suspect ASOS spikes the CLI did not keep.
  - The engine reports this as `prob_below_observed_max`, with the cell's sample size.

## Engine parity

`scripts/research/intraday/engine-parity.mjs` replays archived raw inputs through `forecastIntraday`:

| Replay | Cases | Max abs diff, temp | Max abs diff, rain |
|---|---:|---:|---:|
| CLIPHL, 25 holdout days × 11 cutoffs | 275 | 0 | 3.2e-4 |
| CLILAX, 15 days | 165 | 0 | 1.3e-5 |

The rain differences come from the engine rounding remaining PoP to 4 decimals.

## Caveats (blunt)

1. **The temp holdout is not pristine for the second selection step.** The holdout was first read with the M-anchored
   candidates only. That model passed the overall gate but was significantly **worse** than v1.1 at 02-06 LST (Brier
   −0.015). I then added the max(M, guidance) anchor and the pooled below-max block. They were chosen on the validation
   split, by a margin of 0.14 nats, and the holdout was re-scored. This is recorded in the artifact as
   `selection_disclosure`. The rain model was not changed after its first holdout read.
2. **The GFS-MOS-only path is unvalidated.** The archive had a usable NBM run at every intraday cutoff: temp had 0
   training cases on GFS (129 in validation and holdout), rain had 0. The engine therefore **fails closed**
   (INCOMPLETE_GUIDANCE) without NBM unless `allowGfsFallback: true` is passed.
3. **The publication lag is assumed, not measured** (10 min). The live system must store when it first saw each ob.
4. **The target is ACIS (final CLI), not TWC settlement.** Kalshi settles on TWC. Verified agreement between TWC and
   CLI is 192/192 over earlier samples. Preliminary CLI and TWC revisions are not separately modelled.
5. **Cutoffs are at even local-standard hours.** The engine maps any time to the calibration hour floor(h/2)·2, clamped
   to [2, 22]. Between table hours it is slightly under-confident. Before 02 LST it uses the 02 table.
6. **The early-morning gain over v1.1 is small** (temp Brier +0.004, rain +0.009 at 02-06 LST). Most of the value comes
   after midday.
7. **The temp artifact is 1.19 MB of JSON** (station-level tables). This is acceptable for a Worker bundle, but it is the
   largest weather artifact.
8. **Not yet built:** intraday designations (`designation-intraday/1`), storage rows, the live api.weather.gov fetch, and
   scoring. This work delivers the model, the engine and the evidence only. There were no deploys and no DB writes.

## Reproduce

```text
node scripts/research/intraday/fetch-asos.mjs            # ~2 min, 31 requests, polite/sequential
node scripts/research/intraday/build-cases.mjs           # ~100 s -> cases.csv (465,587 rows)
node --max-old-space-size=3000 scripts/research/intraday/train-eval.mjs   # ~2 min -> both artifacts + evidence.json
node scripts/research/intraday/engine-parity.mjs CLIPHL 25
node --test test/weather-intraday.test.js
```
