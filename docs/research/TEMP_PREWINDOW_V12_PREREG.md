# maxtemp pre-window v1.2 challenger: pre-registration (issue #64)

Written 2026-10-10, **before** any v1.2 candidate was fitted or scored. It was committed before the evaluation script was
run. Nothing here changes v1.1, the rain policy, any forecast, settlement, designation or score.

## Why a challenger is being considered

The Stage 1 audit (`TEMP_FORECAST_AUDIT_42.md`) gives two diagnostic facts. They are diagnostic only, because they
come from 6 climate dates:

- the 42 settled events are complete and correctly scored;
- v1.1's top-bucket hit count (14) is close to its own expectation (Σp = 16.0). Its full-distribution scores are far
  worse than the same-time Kalshi quotes.

Station error patterns over those 6 days include:

- Chicago Midway: NBM 2 to 4 °F too cool on every run;
- New York: NBM 1 to 3 °F too warm;
- Los Angeles: errors of 4 to 9 °F in both directions.

**These 6 days are not used to select or fit anything below.** City offsets are not hand-set. Every candidate is a
general rule, fitted per station on the historical archive only.

## Data and point-in-time rules

- **Archive:** `D:\Workers\scratch\predictions-wx`. Inputs:
  - IEM NWS MOS: GFS MAV `n_x`, and NBM NBS `txn` + `xnd`;
  - ACIS daily max (the CLI value).

  This is the same archive and extraction as `scripts/research/wx-temp-nbm.mjs`, the v1.1 build.
- **Cases:** each CLI station × climate date × lead h ∈ {6, 18, 30, 42} h before the LST window start.
- **Guidance:** a run is usable at runtime + 5 h. NBM must be ≤ 24 h old at the cutoff.
- **Past CLI values** (used by the recent-bias candidate): the value for date x counts as known from window_end(x) + 6 h.
  Only values known at the case cutoff are used. The bias input uses the NBM value of the past date, taken from the
  run that was latest at the same lead before that date. That run is itself point-in-time.
- **No market prices, no NWS gridpoint forecast** (it is not archived), and no observation-window data.

## Candidates (fixed now; no others will be added after results are seen)

| id | name | rule |
|---|---|---|
| A | v1.1 reproduction | NBM `txn` + empirical (station × lead-bucket) residual table, as frozen. |
| B | recent bias | NBM − λ·b. `b` = exponentially weighted mean of the station's point-in-time past residuals (half-life H days, ≥ 5 values, else 0). λ ∈ {0.5, 1}, H ∈ {7, 14, 30}, chosen on validation. Tables are rebuilt on the corrected residuals. |
| C | NBM-spread conditioned | Residuals scaled by the NBM spread tercile. Pooled factor `s_k = sd(resid \| xnd tercile k) / sd(resid)` from training. The station table is applied as `round(g + s_k·e)`. |
| D | GFS–NBM regression | Center = NBM + β_s·(GFS − NBM), with β per station fitted by least squares on training and shrunk toward the pooled β (k = 200 cases). The table is rebuilt on the residuals of the new center. |
| E | B + C + D | Only if each of B, C and D individually beat A on validation. |

**Fixed in every candidate**, as in v1.1:

- probability bounds [0.01, 0.99];
- +0.5 smoothing;
- lead buckets le30h / le54h / gt54h;
- station tables when n ≥ 60, pooled otherwise.

## Splits

- **Fit:** 2023-01 → 2024-12.
- **Validation (selection only):** 2025-01 → 2025-06. This is where λ, H and the B/C/D/E choice are made.
- **Retrospective test:** 2025-07 → 2026-09, read once.
  - It is **not pristine**: it was v1.1's holdout. It is therefore an entry screen for SHADOW, never evidence for
    promotion.
  - Train on everything before 2025-07, as v1.1 did.

## Metrics

- **Primary:**
  - exact-degree log loss;
  - 2 °F bucket Brier, on 5 synthetic buckets around the rounded guidance, as in `wx-temp-nbm.mjs`.
- **Secondary:**
  - modal-bucket hit rate vs Σp;
  - PIT / decile calibration;
  - station and month slices.
- **CI:** 2,000-draw bootstrap resampling whole climate dates. All stations on a date move together.

## SHADOW entry screen (retrospective; all must hold)

1. The selected candidate beats A on the retrospective test. The date-clustered 95% CI of (A − cand) must be > 0 for
   **both** exact-degree log loss and 2 °F Brier.
2. It beats A on both metrics in **each** half (2025-07..12 and 2026-01..09) by point estimate.
3. No station's log loss is worse than A's by > 0.05, and no calendar month's by > 0.03.
4. Modal-bucket calibration: |hits − Σp| / Σp ≤ 5% on the test.

If the screen fails, the result is recorded as failed. No v1.2 is defined, and nothing is re-tuned on the test.

## Forward SHADOW (only if the screen passes)

1. **Freeze.** Commit the artifact `temp-prewindow-v1.2.json` before the first forward date, with its sha256 pinned
   in a test. The freeze commit time defines the start of the forward record.
2. **Forward record.** Score climate dates strictly after the freeze, using the same frozen code and artifact:
   - by point-in-time replay of the public IEM archive (same availability rules, same lead set), for **all 31 CLI
     stations**;
   - plus the 7 Kalshi stations' actual bucket ladders, using v1.1's published FINAL forecasts as the paired
     baseline.
3. **Gate (pre-registered).** Requires ≥ 30 resolved climate dates and ≥ 25 stations. Then the date-clustered 95% CI
   of (v1.1 − v1.2) must be > 0 for exact-degree log loss **and** 2 °F Brier, and on the Kalshi-7 bucket events v1.2
   must be no worse than v1.1 by point estimate. Market scores are reported and are never a gate.
4. **Decision.** The first read after the gate becomes ready is the decision of record. A pass goes to owner review.
   A fail stays recorded as failed.

A v1.2 forward SHADOW never:

- writes `pred_forecasts`;
- takes designations;
- reaches a public surface;
- becomes a temperature CALL. Temperature stays `validated: false` in `src/engine/decision.js`.
