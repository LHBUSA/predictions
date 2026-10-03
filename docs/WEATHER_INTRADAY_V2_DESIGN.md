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
