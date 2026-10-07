# Weather intraday v2 — design (not built)

Separate model generation. It never edits, replaces or re-designates pre-window (v1.x) forecasts.

- **Scope:** contracts whose climate-day window has started (`now >= observation_start`) and not ended.
- **Model ids:** `pbe-weather-precip-intraday@2.x`, `pbe-weather-maxtemp-intraday@2.x`; record_type `live`, own immutable rows.
- **Designations:** a separate rule set `designation-intraday/1` (e.g. `WINDOW_OPEN`, `MIDDAY_LOCAL`, `FINAL_INTRADAY`),
  scored separately from `designation/1`. Intraday scores never mix into the pre-window track record.
- **Inputs:** everything v1.1 uses, plus observations at the exact resolution station dated inside the window only:
  hourly/5-min ASOS (temperature, precip accumulation), NWS preliminary data, latest guidance runs.
- **Temperature:** reported max ≥ observed_max_so_far (integer CLI semantics after rounding/conversion).
  P(bucket) = P(max(observed_so_far, future_max) in bucket), with future_max from the remaining-hours guidance
  distribution, calibrated on archived ASOS + MOS/NBM. Preliminary-vs-final rounding risk kept explicit (TWC rule).
- **Rain:** once measurable precipitation (≥ 0.01 in, not trace) is recorded at the exact station inside the window,
  YES is effectively determined subject to the contract rules (trace = 0; missing value = 0 → NO; TWC/exchange revision clause),
  so the probability is bounded (e.g. ≤ 0.98) rather than 1, with the bound justified by observed ASOS-vs-CLI disagreement rates.
- **Point-in-time:** observation `available_at` = publication time of the ob (not its valid time); forecasts carry data_cutoff_at.
- **Validation before RESEARCH:** backtest on archived ASOS + guidance 2023–2026 with the same holdout discipline as v1.

## Acceptance requirements (owner, 2026-10-03)

1. **No arbitrary caps.** Any bound after an apparently decisive observation (e.g. measurable ASOS rain, observed max
   already inside/above a bucket) must be calibrated per station from historical preliminary-observation vs final
   resolution (TWC settlement / NWS CLI) disagreement rates, with the sample size recorded in the artifact.
2. **Point-in-time observations.** Every observation used carries its actual publication/availability time; backtests use
   only what was published before each forecast cutoff (no hindsight finals).

## Pre-window v1.x is frozen

`pbe-weather-precip@1.1.0` / `@1.0.0`, `pbe-weather-maxtemp@1.1.0` / `@1.0.0` stay unchanged. The candidate pre-window feature
"previous-day station guidance error" may only be added in a new version after a strict point-in-time holdout shows
incremental skill over v1.1, using the value actually available before the next window opened (preliminary ASOS /
publication timestamps — the final CLI for D-1 is often issued after the D window opens).

## designation-intraday/1 — BUILT and FROZEN 2026-10-07

Code: `src/engine/intraday-designations.js` (pure), lane `workers/pbe-predictions/src/intraday-scoring.js` (:04/:34 off the
one-minute cron, `INTRADAY_SCORING=true`), tables `pred_intraday_designations` / `pred_intraday_scores` (`sql/013`, with
ROLLBACK and an always-aborting PROOF). Never inside the core cycle; never writes `pred_forecast_designations` / `pred_scores`.

| Designation | Reference time R | Forecast |
|---|---|---|
| `WINDOW_OPEN` | observation_start + 2 h (02:00 LST) | newest live row of (contract, model, version) captured in [start, R] |
| `MIDDAY_LOCAL` | observation_start + 12 h (12:00 LST) | newest live row captured in [start, R] |
| `FINAL_INTRADAY` | min(observation_end, resolved_at) | newest live row captured in [start, R) |

- Written once, only after R + 10 min. No standing row at R = no designation (counted as missing, never substituted).
- The DB trigger re-checks the choice (newest row at R, frozen reference offsets, live rows only, no pre-window rows).
- Per model **version**: a version change mid-window gives each version its own designations.
- Outcome: the stored venue settlement (as designation/1); official CLI agreement kept as data quality.
- Benchmark: the venue mid stored on the designated row at capture, VALID only if the snapshot was `active` and a core
  run COMPLETED within 10 min before capture with zero market HTTP/backoff errors (venue snapshots are change-only).
  Otherwise `benchmark_state` says why and no market score is stored.
- Quality: `SOURCE_GAP` if no exact-station ob became available in the 90 min before R; `RESOLUTION_SOURCES_DISAGREE`
  / `OFFICIAL_UNVERIFIED` from the resolution row. Scored either way; reports slice by it.
- Report: `GET /admin/intraday/scores` (admin token) — by model version, designation, station, station group, hour bucket
  (capture LST 00-06/07-12/13-16/17-23), probability bucket, benchmark state, quality state.
  `node scripts/ops/intraday-score-report.mjs`.
- Backfill: the first runs designate rows captured since the hot lane started (2026-10-04 18:16Z), all genuinely
  prospective; such rows carry `backfilled=true` (designated > 1 h after R). No forecast is ever created.
