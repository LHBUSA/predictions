# Weather intraday: prospective scores (designation-intraday/1), first report

Run: 2026-10-07 19:34Z, the first production run of the intraday scoring lane. Worker `4d8cb251` (main `5a84ff8`),
`sql/013` applied (ledger `20261007190000`). **Descriptive only.** There are 3 climate days (10-04..10-06), so this report
is not a gate and supports no promotion.

## What exists

- 640 designations: 631 marked `backfilled` (designated more than 1 h after their reference time; all point at rows the
  hot lane captured live from 2026-10-04 18:16Z), plus 9 written on time.
- 523 designations scored (1,046 score rows). The other 117 are on contracts not yet settled.
- Intraday rows in designation/1 tables: `pred_forecast_designations` 0, `pred_scores` 0. There is no contamination.
- WINDOW_OPEN / MIDDAY_LOCAL are missing for Oct 4: the hot lane started at 18:16Z that day, after both reference times.
- Quality: all scored rows are `OK`. There was no `SOURCE_GAP`, and the official CLI agreed with the venue on every
  resolution.
- Benchmarks:

  | `benchmark_state` | Max-temp rows | Rain rows |
  |---|---:|---:|
  | `VALID` | 112 | 38 |
  | `NO_MARKET_PRICE` | 188 | 179 |
  | `MARKET_FEED_UNVERIFIED` | 6 | 0 |

  `NO_MARKET_PRICE` means there was no mid, because the spread was wider than 10c.

## Headline

| Model | Designation | n | PBE Brier | PBE log loss | Benchmark n | Paired Brier PBE / market | Paired LL PBE / market |
|---|---|---:|---:|---:|---:|---:|---:|
| maxtemp-intraday 2.1.0 | WINDOW_OPEN | 84 | 0.1288 | 0.4423 | 70 | 0.1544 / 0.1034 | 0.5248 / 0.3326 |
| maxtemp-intraday 2.1.0 | MIDDAY_LOCAL | 96 | 0.0767 | 0.2476 | 38 | 0.1588 / 0.0804 | 0.4740 / 0.2819 |
| maxtemp-intraday 2.1.0 | FINAL_INTRADAY | 126 | 0.0360 | 0.1295 | 4 | 0.2819 / 0.0164 | 0.9152 / 0.1093 |
| precip-intraday 2.0.0 | WINDOW_OPEN | 60 | 0.0336 | 0.1030 | 25 | 0.0805 / 0.0695 | 0.2323 / 0.2010 |
| precip-intraday 2.0.0 | MIDDAY_LOCAL | 67 | 0.0099 | 0.0408 | 10 | 0.0654 / 0.0952 | 0.2123 / 0.2816 |
| precip-intraday 2.0.0 | FINAL_INTRADAY | 90 | 0.0002 | 0.0112 | 3 | 0.0013 / 0.0006 | 0.0273 / 0.0236 |

### Reading

- **Max temp.** The market beats PBE on every designation where a valid benchmark exists: paired Brier is 0.160
  against 0.093 over all 112 rows.
  - That subset is selected. A mid exists only when the book is two-sided, which leaves the hard contracts near the
    bucket edges.
  - It is still a real warning for the v2.1 calibration hold-out claim. Across 7 stations, the 30–40% and 40–50%
    probability bins are close to calibrated, but the 90–100% bin is 0.964 predicted against 0.875 observed (n = 8).
- **Rain.** Overall the two are roughly even: paired Brier 0.070 against 0.071. PBE is better at MIDDAY and slightly worse
  at WINDOW_OPEN.
- Everything here is 3 days. Station-day clustering is severe, so no CI is reported until there are at least 30
  resolved climate days.

The full slices are below: by station, station group, hour bucket, probability bucket, benchmark state and quality state.

## Reproduce

```
# production admin report (ADMIN_TOKEN)
node scripts/ops/intraday-score-report.mjs
# or from exported rows (no token)
#   select ... from pred_intraday_scores  ->  scores.json
node scripts/ops/intraday-score-report.mjs --rows scores.json
```

## Full slices (2026-10-07 19:34Z run)

### by station

| key | n | contracts | days | stations | mean p | yes rate | PBE Brier | PBE log loss | bench n | paired Brier PBE / mkt | paired LL PBE / mkt |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pbe-weather-maxtemp-intraday@2.1.0 | CLIAUS | 42 | 18 | 3 | 1 | 0.170 | 0.167 | 0.0579 | 0.2266 | 18 | 0.1345 / 0.1415 | 0.5079 / 0.4329 |
| pbe-weather-maxtemp-intraday@2.1.0 | CLIDEN | 48 | 18 | 3 | 1 | 0.168 | 0.167 | 0.1067 | 0.3428 | 19 | 0.1583 / 0.0368 | 0.5050 / 0.1735 |
| pbe-weather-maxtemp-intraday@2.1.0 | CLILAX | 48 | 18 | 3 | 1 | 0.170 | 0.167 | 0.0633 | 0.2616 | 11 | 0.2537 / 0.1783 | 0.9715 / 0.5481 |
| pbe-weather-maxtemp-intraday@2.1.0 | CLIMDW | 42 | 18 | 3 | 1 | 0.169 | 0.167 | 0.0830 | 0.2537 | 17 | 0.1681 / 0.0776 | 0.4877 / 0.2556 |
| pbe-weather-maxtemp-intraday@2.1.0 | CLIMIA | 42 | 18 | 3 | 1 | 0.171 | 0.167 | 0.0505 | 0.1800 | 15 | 0.1196 / 0.0904 | 0.3707 / 0.3044 |
| pbe-weather-maxtemp-intraday@2.1.0 | CLINYC | 42 | 18 | 3 | 1 | 0.169 | 0.167 | 0.0699 | 0.2201 | 14 | 0.1738 / 0.0707 | 0.5118 / 0.2553 |
| pbe-weather-maxtemp-intraday@2.1.0 | CLIPHL | 42 | 18 | 3 | 1 | 0.169 | 0.167 | 0.0854 | 0.2678 | 18 | 0.1479 / 0.0826 | 0.4428 / 0.2682 |
| pbe-weather-precip-intraday@2.0.0 | CLIABQ | 8 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLIATL | 7 | 3 | 3 | 1 | 0.231 | 0.143 | 0.0369 | 0.1197 | 3 | 0.0861 / 0.0413 | 0.2658 / 0.1904 |
| pbe-weather-precip-intraday@2.0.0 | CLIAUS | 7 | 3 | 3 | 1 | 0.156 | 0.143 | 0.0004 | 0.0159 | 1 | 0.0025 / 0.0006 | 0.0513 / 0.0253 |
| pbe-weather-precip-intraday@2.0.0 | CLIBOS | 7 | 3 | 3 | 1 | 0.017 | 0.000 | 0.0006 | 0.0175 | 2 | 0.0001 / 0.0006 | 0.0101 / 0.0253 |
| pbe-weather-precip-intraday@2.0.0 | CLICLL | 7 | 3 | 3 | 1 | 0.154 | 0.143 | 0.0003 | 0.0144 | 1 | 0.0016 / 0.0006 | 0.0408 / 0.0253 |
| pbe-weather-precip-intraday@2.0.0 | CLICMH | 7 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLIDCA | 7 | 3 | 3 | 1 | 0.150 | 0.143 | 0.0001 | 0.0101 | 1 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIDEN | 8 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 2 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIDFW | 7 | 3 | 3 | 1 | 0.150 | 0.143 | 0.0001 | 0.0101 | 2 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIEWR | 7 | 3 | 3 | 1 | 0.150 | 0.143 | 0.0001 | 0.0101 | 1 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIHOU | 7 | 3 | 3 | 1 | 0.451 | 0.571 | 0.1110 | 0.3174 | 2 | 0.3880 / 0.2906 | 1.0805 / 0.7445 |
| pbe-weather-precip-intraday@2.0.0 | CLILAS | 8 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLILAX | 8 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLILEX | 7 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLIMIA | 7 | 3 | 3 | 1 | 0.264 | 0.000 | 0.1430 | 0.3989 | 6 | 0.1668 / 0.1523 | 0.4637 / 0.4286 |
| pbe-weather-precip-intraday@2.0.0 | CLIMKE | 7 | 3 | 3 | 1 | 0.019 | 0.000 | 0.0005 | 0.0188 | 1 | 0.0025 / 0.0002 | 0.0513 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIMSP | 7 | 3 | 3 | 1 | 0.039 | 0.000 | 0.0041 | 0.0408 | 3 | 0.0094 / 0.0007 | 0.0819 / 0.0254 |
| pbe-weather-precip-intraday@2.0.0 | CLIMSY | 7 | 3 | 3 | 1 | 0.313 | 0.143 | 0.0854 | 0.2473 | 4 | 0.1495 / 0.2659 | 0.4253 / 0.7113 |
| pbe-weather-precip-intraday@2.0.0 | CLINYC | 7 | 3 | 3 | 1 | 0.150 | 0.143 | 0.0001 | 0.0101 | 1 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIOKC | 7 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLIORD | 7 | 3 | 3 | 1 | 0.014 | 0.000 | 0.0003 | 0.0144 | 1 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIPHL | 7 | 3 | 3 | 1 | 0.150 | 0.143 | 0.0001 | 0.0101 | 1 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIPHX | 8 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLIPIT | 7 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 1 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | CLIPVD | 7 | 3 | 3 | 1 | 0.150 | 0.143 | 0.0001 | 0.0101 | 2 | 0.0001 / 0.0003 | 0.0101 / 0.0177 |
| pbe-weather-precip-intraday@2.0.0 | CLISAT | 7 | 3 | 3 | 1 | 0.011 | 0.000 | 0.0001 | 0.0115 | 2 | 0.0003 / 0.0004 | 0.0151 / 0.0202 |
| pbe-weather-precip-intraday@2.0.0 | CLISEA | 8 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLISFO | 8 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLISGF | 7 | 3 | 3 | 1 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | CLITTN | 7 | 3 | 3 | 1 | 0.150 | 0.143 | 0.0001 | 0.0101 | 1 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |

### by station_group

| key | n | contracts | days | stations | mean p | yes rate | PBE Brier | PBE log loss | bench n | paired Brier PBE / mkt | paired LL PBE / mkt |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pbe-weather-maxtemp-intraday@2.1.0 | desert_mountain | 48 | 18 | 3 | 1 | 0.168 | 0.167 | 0.1067 | 0.3428 | 19 | 0.1583 / 0.0368 | 0.5050 / 0.1735 |
| pbe-weather-maxtemp-intraday@2.1.0 | gulf_texas | 84 | 36 | 3 | 2 | 0.170 | 0.167 | 0.0542 | 0.2033 | 33 | 0.1278 / 0.1183 | 0.4456 / 0.3745 |
| pbe-weather-maxtemp-intraday@2.1.0 | midwest_plains | 42 | 18 | 3 | 1 | 0.169 | 0.167 | 0.0830 | 0.2537 | 17 | 0.1681 / 0.0776 | 0.4877 / 0.2556 |
| pbe-weather-maxtemp-intraday@2.1.0 | northeast | 84 | 36 | 3 | 2 | 0.169 | 0.167 | 0.0777 | 0.2440 | 32 | 0.1592 / 0.0774 | 0.4730 / 0.2626 |
| pbe-weather-maxtemp-intraday@2.1.0 | pacific_coast | 48 | 18 | 3 | 1 | 0.170 | 0.167 | 0.0633 | 0.2616 | 11 | 0.2537 / 0.1783 | 0.9715 / 0.5481 |
| pbe-weather-precip-intraday@2.0.0 | desert_mountain | 32 | 12 | 3 | 4 | 0.010 | 0.000 | 0.0001 | 0.0101 | 2 | 0.0001 / 0.0002 | 0.0101 / 0.0151 |
| pbe-weather-precip-intraday@2.0.0 | gulf_texas | 49 | 21 | 3 | 7 | 0.214 | 0.163 | 0.0486 | 0.1451 | 18 | 0.1322 / 0.1423 | 0.3770 / 0.3904 |
| pbe-weather-precip-intraday@2.0.0 | interior_east | 28 | 12 | 3 | 4 | 0.065 | 0.036 | 0.0093 | 0.0375 | 4 | 0.0646 / 0.0310 | 0.2019 / 0.1466 |
| pbe-weather-precip-intraday@2.0.0 | midwest_plains | 35 | 15 | 3 | 5 | 0.018 | 0.000 | 0.0010 | 0.0188 | 5 | 0.0061 / 0.0005 | 0.0614 / 0.0213 |
| pbe-weather-precip-intraday@2.0.0 | northeast | 49 | 21 | 3 | 7 | 0.131 | 0.122 | 0.0002 | 0.0111 | 9 | 0.0001 / 0.0003 | 0.0101 / 0.0179 |
| pbe-weather-precip-intraday@2.0.0 | pacific_coast | 24 | 9 | 3 | 3 | 0.010 | 0.000 | 0.0001 | 0.0101 | 0 | — | — |

### by hour_bucket

| key | n | contracts | days | stations | mean p | yes rate | PBE Brier | PBE log loss | bench n | paired Brier PBE / mkt | paired LL PBE / mkt |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pbe-weather-maxtemp-intraday@2.1.0 | 00-06 | 84 | 84 | 2 | 7 | 0.167 | 0.167 | 0.1288 | 0.4423 | 70 | 0.1544 / 0.1034 | 0.5248 / 0.3326 |
| pbe-weather-maxtemp-intraday@2.1.0 | 07-12 | 96 | 96 | 3 | 7 | 0.169 | 0.167 | 0.0767 | 0.2476 | 38 | 0.1588 / 0.0804 | 0.4740 / 0.2819 |
| pbe-weather-maxtemp-intraday@2.1.0 | 13-16 | 72 | 72 | 3 | 4 | 0.171 | 0.167 | 0.0396 | 0.1380 | 4 | 0.2819 / 0.0164 | 0.9152 / 0.1093 |
| pbe-weather-maxtemp-intraday@2.1.0 | 17-23 | 54 | 54 | 3 | 3 | 0.172 | 0.167 | 0.0312 | 0.1181 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | 00-06 | 62 | 60 | 2 | 30 | 0.081 | 0.048 | 0.0325 | 0.1000 | 25 | 0.0805 / 0.0695 | 0.2323 / 0.2010 |
| pbe-weather-precip-intraday@2.0.0 | 07-12 | 71 | 71 | 3 | 30 | 0.100 | 0.070 | 0.0093 | 0.0391 | 10 | 0.0654 / 0.0952 | 0.2123 / 0.2816 |
| pbe-weather-precip-intraday@2.0.0 | 13-16 | 6 | 6 | 1 | 6 | 0.990 | 1.000 | 0.0001 | 0.0101 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | 17-23 | 78 | 78 | 3 | 30 | 0.024 | 0.013 | 0.0002 | 0.0114 | 3 | 0.0013 / 0.0006 | 0.0273 / 0.0236 |

### by calibration_bucket

| key | n | contracts | days | stations | mean p | yes rate | PBE Brier | PBE log loss | bench n | paired Brier PBE / mkt | paired LL PBE / mkt |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pbe-weather-maxtemp-intraday@2.1.0 | 0-10% | 182 | 96 | 3 | 7 | 0.025 | 0.022 | 0.0213 | 0.0990 | 36 | 0.1047 / 0.0714 | 0.4243 / 0.2443 |
| pbe-weather-maxtemp-intraday@2.1.0 | 10-20% | 27 | 23 | 3 | 7 | 0.140 | 0.074 | 0.0725 | 0.2815 | 14 | 0.0700 / 0.0288 | 0.2741 / 0.1328 |
| pbe-weather-maxtemp-intraday@2.1.0 | 20-30% | 31 | 24 | 3 | 7 | 0.230 | 0.161 | 0.1409 | 0.4582 | 27 | 0.1533 / 0.0965 | 0.4858 / 0.3103 |
| pbe-weather-maxtemp-intraday@2.1.0 | 30-40% | 23 | 17 | 3 | 6 | 0.355 | 0.435 | 0.2477 | 0.6887 | 19 | 0.2751 / 0.1199 | 0.7454 / 0.4129 |
| pbe-weather-maxtemp-intraday@2.1.0 | 40-50% | 16 | 14 | 3 | 7 | 0.431 | 0.438 | 0.2405 | 0.6741 | 11 | 0.2334 / 0.1129 | 0.6597 / 0.3848 |
| pbe-weather-maxtemp-intraday@2.1.0 | 50-60% | 5 | 5 | 2 | 5 | 0.508 | 0.400 | 0.2582 | 0.7095 | 1 | 0.2500 / 0.3306 | 0.6931 / 0.8557 |
| pbe-weather-maxtemp-intraday@2.1.0 | 60-70% | 2 | 2 | 1 | 2 | 0.620 | 1.000 | 0.1445 | 0.4782 | 0 | — | — |
| pbe-weather-maxtemp-intraday@2.1.0 | 70-80% | 5 | 5 | 3 | 3 | 0.770 | 1.000 | 0.0531 | 0.2616 | 1 | 0.0529 / 0.0225 | 0.2614 / 0.1625 |
| pbe-weather-maxtemp-intraday@2.1.0 | 80-90% | 7 | 6 | 3 | 4 | 0.843 | 1.000 | 0.0254 | 0.1715 | 2 | 0.0196 / 0.2928 | 0.1508 / 0.7342 |
| pbe-weather-maxtemp-intraday@2.1.0 | 90-100% | 8 | 7 | 3 | 4 | 0.964 | 0.875 | 0.1196 | 0.4719 | 1 | 0.9409 / 0.3192 | 3.5066 / 0.8324 |
| pbe-weather-precip-intraday@2.0.0 | 0-10% | 194 | 77 | 3 | 30 | 0.013 | 0.000 | 0.0003 | 0.0129 | 29 | 0.0011 / 0.0034 | 0.0254 / 0.0376 |
| pbe-weather-precip-intraday@2.0.0 | 10-20% | 3 | 3 | 1 | 3 | 0.147 | 0.333 | 0.2752 | 0.8230 | 3 | 0.2752 / 0.2096 | 0.8230 / 0.5691 |
| pbe-weather-precip-intraday@2.0.0 | 20-30% | 1 | 1 | 1 | 1 | 0.270 | 0.000 | 0.0729 | 0.3147 | 1 | 0.0729 / 0.0289 | 0.3147 / 0.1863 |
| pbe-weather-precip-intraday@2.0.0 | 40-50% | 1 | 1 | 1 | 1 | 0.410 | 0.000 | 0.1681 | 0.5276 | 1 | 0.1681 / 0.4556 | 0.5276 / 1.1239 |
| pbe-weather-precip-intraday@2.0.0 | 50-60% | 1 | 1 | 1 | 1 | 0.500 | 0.000 | 0.2500 | 0.6931 | 1 | 0.2500 / 0.0930 | 0.6931 / 0.3638 |
| pbe-weather-precip-intraday@2.0.0 | 60-70% | 3 | 2 | 2 | 2 | 0.663 | 0.000 | 0.4404 | 1.0903 | 3 | 0.4404 / 0.4626 | 1.0903 / 1.1470 |
| pbe-weather-precip-intraday@2.0.0 | 90-100% | 14 | 13 | 2 | 12 | 0.990 | 1.000 | 0.0001 | 0.0101 | 0 | — | — |

### by benchmark_state

| key | n | contracts | days | stations | mean p | yes rate | PBE Brier | PBE log loss | bench n | paired Brier PBE / mkt | paired LL PBE / mkt |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pbe-weather-maxtemp-intraday@2.1.0 | MARKET_FEED_UNVERIFIED | 6 | 6 | 2 | 1 | 0.293 | 0.333 | 0.2698 | 0.7671 | 0 | — | — |
| pbe-weather-maxtemp-intraday@2.1.0 | NO_MARKET_PRICE | 188 | 120 | 3 | 7 | 0.130 | 0.112 | 0.0167 | 0.0757 | 0 | — | — |
| pbe-weather-maxtemp-intraday@2.1.0 | VALID | 112 | 74 | 3 | 7 | 0.229 | 0.250 | 0.1604 | 0.5215 | 112 | 0.1604 / 0.0925 | 0.5215 / 0.3074 |
| pbe-weather-precip-intraday@2.0.0 | NO_MARKET_PRICE | 179 | 87 | 3 | 30 | 0.087 | 0.078 | 0.0001 | 0.0107 | 0 | — | — |
| pbe-weather-precip-intraday@2.0.0 | VALID | 38 | 25 | 2 | 20 | 0.114 | 0.026 | 0.0703 | 0.2108 | 38 | 0.0703 / 0.0708 | 0.2108 / 0.2082 |

### by quality_state

| key | n | contracts | days | stations | mean p | yes rate | PBE Brier | PBE log loss | bench n | paired Brier PBE / mkt | paired LL PBE / mkt |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pbe-weather-maxtemp-intraday@2.1.0 | OK | 306 | 126 | 3 | 7 | 0.169 | 0.167 | 0.0742 | 0.2524 | 112 | 0.1604 / 0.0925 | 0.5215 / 0.3074 |
| pbe-weather-precip-intraday@2.0.0 | OK | 217 | 90 | 3 | 30 | 0.092 | 0.069 | 0.0124 | 0.0457 | 38 | 0.0703 / 0.0708 | 0.2108 / 0.2082 |
