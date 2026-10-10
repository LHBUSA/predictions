# Temperature forecast audit: the 42 settled events (issue #64, Stage 1)

**Run date:** 2026-10-10. Read-only throughout.

- **Data:** `scripts/research/temp-audit/export.ps1`. Each query is a single SELECT inside `BEGIN TRANSACTION READ
  ONLY`.
- **Analysis:** `scripts/research/temp-audit/audit-cohort.mjs`, which uses `src/weather/temp-skill.js` (temp-skill/1).
- **Repo is public:** this document carries aggregates only. Event-level rows (picked vs actual bucket) are
  member-only on the site and stay out of the repo.
- **Not touched:** no forecast, settlement, designation, score or rain-policy record.

## Answer in one paragraph

**14/42 is not a scoring or completeness artefact, and on its own it is close to what the model itself expected.**

- **Hits vs expectation:** the expected number of top-bucket hits is the sum of the chosen buckets' probabilities.
  That is Σp = 16.0, so 14 is 2 fewer. A calibrated forecaster lands at 14 or below 31% of the time (exact
  Poisson-binomial), which is not evidence of miscalibration by itself.
- **The real weakness is information:**
  - At the same moment, the Kalshi ladder's favourite bucket hit **27/42**.
  - Market multiclass log loss is **0.95**, against PBE's **1.67**. The date-clustered 95% CI of the difference is
    [0.65, 0.80].
  - The pre-window v1.1 model is an NBM day-max plus a climatological error table. It is much less informed than the
    market at local midnight.
- **There is also a separate display defect:** the public "Brier 0.089 vs market 0.090" compares PBE over all 437
  contracts with the market over only the 295 contracts that had a market mid.
  - Paired on the same contracts, it is **0.130 vs 0.090**.
  - Temperature alone is **0.154 vs 0.098**.

## Cohort and identity checks

| Check | Result |
|---|---|
| Events with an exhaustive ladder (low tail, four 2 °F buckets, high tail) | 63 |
| Fully settled | **42** = 7 stations × 6 climate dates (Oct 4–9) |
| Not settled | 21 (Oct 3: the engine went live mid-window, so there was no pre-window forecast and no designation; Oct 10–11: open) |
| Partition gaps or overlaps, missing tails | 0 |
| Exactly one YES per event | 42/42 |
| Official value identical on all 6 buckets, and inside the YES bucket | 42/42 |
| TWC venue result = NWS CLI official outcome (`sources_agree`), no corrections | 252/252 |
| FINAL_PRE_RESOLUTION designated on all 6 buckets; same capture time; captured strictly before the LST window; data cutoff ≤ capture; reference = window start | 42/42 |
| No newer pre-window forecast than the designated one (no substitution) | 42/42 |
| Score rows restate the designated forecast and the settled outcome | 252/252 |
| Window = 00:00–24:00 local **standard** time | 42/42 |
| Model | v1.1.0 (NBM day max) on all 42; no v1.0 GFS fallback at FINAL |

**Conclusion:** the denominator is correct. `results-board.js` does count only complete events. In the current data
every settled event is complete, so its `rows >= 2 && one winner` rule did not hide any partial event. It is still
weaker than an exhaustiveness check. Any future event-level panel should use `orderBuckets` (full partition) from
`src/weather/temp-skill.js` instead.

## Top bucket: observed vs expected

| Group | Events | Hits | Expected (Σp) |
|---|---:|---:|---:|
| All | 42 | 14 | 16.0 |
| Modal p 0.30–0.35 | 20 | 5 | 6.5 |
| Modal p ≥ 0.45 | 9 | 6 | 5.1 |

- **Mean modal probability:** 0.38.
- **Confidence tiers:**
  - HIGH (32 events) met its expectation.
  - MEDIUM (10 events) fell far short of its expected 3.7 hits: exact one-sided P ≈ 0.01 if calibrated. This is the
    one group-level calibration warning in the cohort.
  - Counts at this level are aggregated on purpose: the repo is public and event results are member-only.
- **How far each miss landed** (buckets from the modal one): 14 hits, 13 off by one, 12 off by two, 3 off by three or
  more.

## PBE vs market at the same capture

**Market data:**

- **Source:** the venue snapshot stored in the same engine cycle as the FINAL forecast.
- **Gaps:** 215/252 buckets have a stored mid. The other 37 are no-bid tails with a 0 ¢ bid and a ≤ 1–2 ¢ ask. Those
  are valued at half the ask.
- **Stored mids alone** cover only 10 events. That 10-event result is shown separately below.

**Method:** both distributions are renormalised over the 6 buckets. CIs resample the 6 climate dates.

| Metric (42 events) | PBE v1.1 | Kalshi | PBE − market, 95% CI |
|---|---:|---:|---|
| Top-bucket hits | 14 (exp. 16.0) | **27** (exp. 21.6) | — |
| Same modal bucket | 23/42 | | |
| Multiclass log loss | 1.672 | 0.949 | +0.72 [0.65, 0.80] |
| Multiclass Brier | 0.789 | 0.502 | +0.29 [0.24, 0.33] |
| Ranked probability score | 0.152 | 0.068 | +0.084 [0.070, 0.104] |
| Stored-mid-only subset (10 events) | 4 hits | 7 hits | log loss +0.41 [0.01, 0.84] |

With 6 dates these are percentile-bootstrap ranges, not formal 95% intervals (only 462 distinct resamples exist).
The sign does hold on every date: the per-date log-loss gap ranges from +0.61 to +0.88.

Contract-level FINAL scores from `pred_scores`, paired on contracts with a market mid:

| Lane | Contracts | PBE (all) | PBE (paired) | Market (paired) |
|---|---:|---:|---:|---:|
| Max temp, Brier | 252 / 215 paired | 0.132 | 0.154 | 0.098 |
| Rain, Brier | 180 / 78 paired | 0.030 | 0.069 | 0.072 |
| All lanes, Brier | 437 / 295 paired | **0.089** | **0.130** | **0.090** |

The public headline is the bold PBE (all) figure next to the bold market (paired) figure. Those are two different
contract sets.

## Baselines on the same 42 events and inputs

| Model | Hits | Expected | Log loss | Brier | RPS |
|---|---:|---:|---:|---:|---:|
| v1.1 as published | 14 | 16.0 | 1.672 | 0.789 | 0.152 |
| v1.1 recomputed from the stored NBM + table (parity) | 14 | 16.0 | 1.670 | 0.789 | 0.152 |
| v1.0 GFS MOS empirical table | 15 | 16.4 | 1.468 | 0.717 | 0.119 |
| Normal error on NBM (table mean, sd) | 16 | 13.6 | 1.698 | 0.791 | 0.152 |
| Climatology 1991–2020 | 5 | 23.7 | 2.588 | 1.130 | 0.271 |

Point-guidance hits (the bucket containing the rounded value):

| Guidance | Hits |
|---|---:|
| NBM | 14 |
| GFS MOS | 19 |
| NWS official high | 17 |
| (NBM+GFS)/2 | 18 |

- v1.1 is reproducible from its stored inputs: log loss 1.670 vs 1.672. The difference comes from per-contract
  clamping.
- On these 6 days GFS beat NBM. The 2025-07..2026-09 holdout said the opposite at 31 stations (NBM log loss 2.431 vs
  GFS 2.583). Six days cannot settle which is right, and that is what Stage 2 tested.

## Errors (official CLI − guidance, °F)

| Station | NBM mean | NBM MAE | GFS MAE | NWS MAE | v1.1 table mean / sd | z-RMS |
|---|---:|---:|---:|---:|---:|---:|
| Austin | +1.5 | 3.2 | 1.3 | 2.7 | +0.05 / 2.95 | 1.21 |
| Chicago Midway | **+2.8** | 2.8 | 1.3 | 2.3 | +0.60 / 3.04 | 0.79 |
| Denver | −0.3 | 0.7 | 1.0 | 0.7 | +0.09 / 3.47 | 0.30 |
| Los Angeles | +0.3 | **5.3** | 4.0 | 4.2 | −0.01 / 2.78 | **2.12** |
| Miami | +0.2 | 0.2 | 0.3 | 0.2 | +0.03 / 1.61 | 0.25 |
| New York | **−1.8** | 1.8 | 2.3 | 2.0 | +0.38 / 2.84 | 0.84 |
| Philadelphia | +0.3 | 2.3 | 1.8 | 2.2 | +0.19 / 2.70 | 1.04 |
| **All** | +0.4 | 2.3 | 1.7 | 2.0 | | 1.10 |

**The owner-visible hypotheses, tested:**

- **Los Angeles "too warm Oct 7–9":** true for those days. But the heat event earlier in the period was a large
  too-cool bust in the other direction.
  - LA's problem is size, not sign: MAE 5.3 °F against a table sd of 2.8, so z-RMS is 2.1. That is two regime busts
    (heat, then marine layer), not a fixed bias.
  - A city offset would have made the heat-event days worse.
- **Chicago "too cool":** true on every day and every NBM run (12Z, 18Z, 00Z); mean +2.8 °F.
  - That is 1.8 standard errors from the table mean: suggestive, not significant on 6 days.
  - GFS had no such bias (MAE 1.3).
- **Philadelphia "too cool":** not supported. Mean +0.3: the late days were too cool, and one early day was too warm
  by a similar margin.
- **Miami matched Oct 7–9:** true across the period: NBM MAE 0.2 °F. Miami also has the narrowest table (sd 1.6), so
  its modal probabilities are the highest (≈0.5).
- **New York:** too warm on every day; mean −1.8 °F.

**Dispersion:** pooled z-RMS is 1.10. 27/42 events fall within 1 sd and 3/42 beyond 2 sd. The v1.1 spread is about
right on average. The misses come from where the distribution is centred, plus LA's outsized busts.

## Lead time and guidance vintage

- **FINAL capture time and run differ by region:**
  - eastern stations (New York, Philadelphia, Miami): captured about 23Z, 6 h before the 05Z window start, from the
    **18Z** NBM run;
  - central and western stations: captured about 05Z, 1–3 h before their window (06–08Z), from the **00Z** run.
- **By region:**
  - western and central stations: 4 hits vs 9.0 expected;
  - eastern stations: 10 hits vs 7.0.

  This tracks the stations, not the run.
- **No run-alignment defect.**
  - The NBM `txn` valid at 00Z of the next day is the daytime max for the climate date. This is the same extraction
    v1.1 was trained on.
  - The 00Z runs are no worse than the 18Z runs: MAE 3.00 vs 2.96.
- **Standing forecast at fixed leads before the window:**
  - T-6 h: 13 hits vs 15.8 expected;
  - FINAL: 14 hits vs 16.0;
  - T-12 h: 37 events only, so it is not comparable.

## Measurement

**Final CLI max vs the ASOS max PBE had seen** in its last intraday row before the window closed:

- equal in 28/42 events;
- CLI 1 °F higher in 12;
- CLI 2 °F higher in 2;
- **never lower.**

The CLI max uses the continuous record; hourly METAR, plus the 6-hour max groups, can miss the peak. This is a
known, one-sided measurement gap.

- **Pre-window impact:** none. The v1.1 tables are trained on the CLI value itself.
- **Intraday impact:** the intraday models already calibrate "final ends above the observed max" from ASOS-vs-CLI
  history.

The settlement source (TWC = NWS CLI) agreed on 252/252.

## Intraday (separate product, separate clock)

**Scope:** `pred_intraday_scores`, designation-intraday/1, v2.1.0, scored at the event level on the same 42 events.

| Designation | Events | Hits | Expected | Log loss |
|---|---:|---:|---:|---:|
| WINDOW_OPEN (02:00 LST) | 33 | 13 | 14.0 | 1.513 |
| MIDDAY_LOCAL (12:00 LST) | 37 | 17 | 16.6 | 1.172 |
| FINAL_INTRADAY | 42 | 34 | 30.6 | 0.422 |

- Intraday v2.1 is calibrated on its own terms: hits track Σp.
- **Same-time market pairs are too rare to compare.** Only 5 events at WINDOW_OPEN have a VALID benchmark on every
  bucket, and the market is ahead on those 5. The other designations have none, because the strict benchmark rules
  (spread ≤ 10 ¢, active, fresh collector) rarely hold for a whole ladder.

**v2.2 SHADOW vs v2.1:**

- **Basis:** the pre-registered fixed hourly grid, paired at contract level. It covers 2,232 points over 3 resolved
  dates (Oct 7–9) at 7 stations.
- **Brier:** 0.0690 vs 0.0776. The difference is +0.0086, with a date-clustered CI of [0.002, 0.040].
- **Log loss:** 0.227 vs 0.249. The difference is +0.021, with a CI of [−0.0002, 0.107].
- **Status:** `ready = false` (30 dates and 10 stations are required). `forward_gate_passed = false`.
- **Do not act on it.** The early direction favours v2.2, but 3 days is not evidence.

## What this means

1. **Not a measurement, settlement or completeness problem.** All 42 events are valid and correctly scored.
2. **The 14/42 shortfall against expectation (−2.0) is within normal uncertainty** for exact 2 °F outcomes.
3. **No evidence of overall miscalibration (6 dates), except the MEDIUM tier; v1.1 is uninformative relative to the
   market at local midnight.**
   - Its favourite bucket carries 38% on average; the market's carries 51%, and the market's favourite hit 64% of the
     time.
   - The market prices newer and higher-resolution guidance, plus current conditions.
   - No re-weighting of v1.1's two inputs can close that gap. Stage 2 measures how much legitimate improvement is
     available from point-in-time guidance.
4. **Fix the display** so pooled contract scores are paired and split by lane, and the temperature panel shows
   observed-vs-expected hits and the full-distribution comparison. `Measurable` is a sample-size check, not a
   significance test.
