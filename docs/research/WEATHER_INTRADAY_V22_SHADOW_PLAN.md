# maxtemp-intraday 2.2.0: prospective SHADOW forward-validation plan

Status: **designed and implemented as a pure module. Not wired.** Nothing in `workers/` calls it yet. No deploys and
no DB writes were made.

- Module: `src/weather/intraday/shadow.js`
- Tests: `test/weather-intraday-v22.test.js`
- Evidence: `docs/research/WEATHER_INTRADAY_V22_EVIDENCE.md`

## Why this lane exists

The 2025-07..2026-09 holdout was inspected during v2.0 and v2.1, so a v2.2 win there cannot count as pristine
validation. The only clean test left is a forward one: record v2.2 predictions from now on, at every eligible
station, before outcomes are known, and score them against v2.1 on the same contracts. Scoring starts only after a
pre-registered minimum sample.

v2.2 **does not replace v2.1**. v2.1 stays the live production model and keeps its current write path unchanged.

## What the live caller must do

The live caller is the hot intraday lane (`workers/pbe-predictions/src/intraday-live.js`, `intradayForStation`). For
each open-window `MAX_TEMP_BUCKET` contract it already evaluates with v2.1, it should do the following **after** the
v2.1 write. Use the same stored observations, the same `now`, and the same guidance fetch.

```js
import { forecastIntradayShadow, shadowWriteDecision, shadowForecastRow, shadowSourceStateHash } from '../../../src/weather/intraday/shadow.js';
import { parseMetarWeather } from '../../../src/weather/intraday/observations.js';

// 1. observation rows: the v2.1 rows PLUS wxcodes / sky decoded from the stored raw METAR
const obs22 = obs.map((o, i) => ({ ...o, ...parseMetarWeather(rawMetarOf(obsRows[i])) }));   // wxcodes: string[]|null, sky: [...]|null
// 2. guidance: the NBS run(s) as fetched today (IEM mos.json rows already carry `tmp`; normalizeMosRow keeps it)
const r = forecastIntradayShadow(c, { obs: obs22, nbm: src.nbm }, { now });
// 3. dedupe against the newest prior SHADOW row for (contract_id, model_id, model_version '2.2.0')
const d = shadowWriteDecision(priorShadowRow, r);
if (d.write) {
  const obsUsed = obs22.filter((o) => Date.parse(o.available_at) <= Date.parse(now) && o.valid_at >= c.observation_start && o.valid_at < c.observation_end);
  rows.push(shadowForecastRow(c, r, { now, sourceStateHash: await shadowSourceStateHash(r, c.contract_id, obsUsed), featureSnapshotId }));
}
```

**Bundle size.** `shadow.js` imports `src/weather/intraday/temp-v22.js`, which registers the 2.2.0 artifact. That
artifact is 2.8 MB, about 512 KB gzipped. Wiring the lane adds it to the worker bundle. The production v2.1 path
(`engine.js` alone) does not carry it.

**Two NBS runs.** `nbm_run_change_f` is evidence only, not a model input, so one usable run is enough to forecast.
Passing two keeps the evidence complete. If `weatherSources()` returns a single run, the forecast is unaffected.

### Exact inputs

| Input | Requirement | If missing |
|---|---|---|
| `obs[].max6_f` | `number \| null` on every row (as for v2.1) | `INCOMPLETE_OBSERVATIONS` |
| `obs[].wxcodes` | `string[] \| null` on every row. Decode the stored raw METAR with `parseMetarWeather`, or use `parseNwsObservationsV22` on an api.weather.gov payload. `null` means unknown, never "clear". | `INCOMPLETE_OBSERVATIONS`, when the artifact's `requires.observation_weather_fields` is true. It is true for the selected model, which uses a sky level. |
| `obs[].sky` | `[{cover, base_ft}] \| null` on every row. Same source as `wxcodes`. | same |
| `obs[].available_at` | When PBE first saw the report, never earlier than valid + 10 min (as today) | the row is excluded at `now` |
| `nbm` | Usable NBS runs (cycle + 5 h, ≤ 24 h old) whose `rows[]` carry `tmp` (3-hourly TMP) and `txn`. Pass at least the newest **two** usable runs, so that `nbm_run_change_f` is defined. | `INCOMPLETE_GUIDANCE`, when `requires.nbm_tmp_path` is true. It is true for the selected model: gap source `proj_half`. |
| market data | **Never.** The shadow row sets `market_probability`, `market_snapshot_key` and `market_observed_at` to `null`. `assertModelInput` throws `MarketLeakageError` on any venue key in an observation row. | — |

The stored observation row (`pred_source_observations.data`) must therefore keep the raw METAR text. If it keeps only
decoded fields, the hot lane has to add `wxcodes` and `sky` at ingest. That is a worker change for the other session.
Until then, every shadow call returns `INCOMPLETE_OBSERVATIONS` and nothing is written. This is the intended
fail-closed behaviour.

## Write-dedupe semantics (Phase A)

These are the same three states as the Phase A rain lane. One hash never carries three meanings.

| State | Hash | Role |
|---|---|---|
| Source state | `source_state_hash` = `shadowSourceStateHash(r, contract_id, obsUsed)`: the usable observations (valid, tmpf, max6, wxcodes, sky) plus the guidance runs used | Audit only. Never decides a write. |
| Predictive state | `predictive_input_hash` = `shadowPredictiveHash(r)` = sha256(canonical `explanation.predictive_state`): the calibration-table cell key at **every** level, the integer observed max M, the anchor, the below-max cell and the contract's integer range | **Decides the write.** Two results with the same predictive hash have the same probability by construction: the probability is a pure function of those cells. |
| Presentation | wall clock, minutes since the last report, freshness labels | Never part of either hash. Never writes a row. |

Rules:

- **Write** if there is no prior shadow row for (contract, `pbe-weather-maxtemp-intraday`, `2.2.0`), or the newest
  prior row's `explanation.predictive_input_hash` differs.
- **Do not write** if only the source state changed, for example a new report that leaves every cell, M and the
  anchor unchanged, or a newer NBS run whose path leaves the cells unchanged. Count it as `unchanged`.
- **No clock-only rows.** A wall-clock tick is not an input. Two inputs do depend on time, by design:
  - the hourly calibration hour (`h`)
  - the remaining NBM path peak, which declines once the forecast peak has passed

  Each changes a table cell only at a discrete boundary, which is a real change of the model's conditioning. Those
  rows are legitimate and are labelled by the changed cell.
- **`record_id`** = `contract|model@2.2.0|shadow|<predictive hash prefix>`. It is content-addressed, so a retried cycle
  cannot insert a duplicate.
- Rows are immutable. They are append-only, like live rows.

## Row semantics

`shadowForecastRow` returns a row with these fields:

| Field | Value |
|---|---|
| `record_type` | `'shadow'` |
| `model_state` | `'SHADOW'` |
| `public` | `false` |
| `designation_rules` | `'designation-intraday-shadow/1'` |
| `explanation.lane` | `'hot-intraday-shadow'` |
| `explanation.research_gate_passed` | carried from the artifact |

Shadow rows:

- never take pre-window or intraday public designations
- never appear on any public surface, API, feed, newsroom or "why PBE moved" timeline
- are excluded from public track records

If `pred_forecasts` cannot hold a `'shadow'` record type, write them to a separate table with the same columns, for
example `pred_forecasts_shadow`. That is a schema decision for the owner. No migration was made.

## Evaluation (pre-registered)

Call `shadowEvaluationReport(rows, outcomes)`:

- `rows` are the v2.1 live rows and the v2.2 shadow rows for the same `MAX_TEMP_BUCKET` contracts. Each row carries
  `contract_id`, `model_version`, `captured_at`, `raw_probability`, `station_id`, `climate_date`,
  `observation_start`, `comparator`, `threshold_low` and `threshold_high`.
- `outcomes` maps `station|climate_date` to the final CLI max. Use the same ACIS/CLI source as training. TWC-settled
  disagreements are reported separately.

How it scores:

- **Fixed grid.** Each contract is scored at every whole hour 1..23 after its window opens. At each point it uses each
  model's newest row captured at or before that time. This makes write frequency irrelevant: v2.2 writes more often
  because its calibration hour is hourly.
- **Paired.** A grid point counts only if **both** models have a row there.
- **Scores:** Brier and log loss, with probabilities clamped to [0.01, 0.99].
- **CI:** a date-clustered bootstrap (1,000 draws) of (v2.1 − v2.2).

Readiness:

- `ready` requires at least **30 resolved climate days** at **10 or more stations**. Before that, the report is
  descriptive only and nobody may act on it.

Forward gate:

- `forward_gate_passed` requires `ready`, and the 95% CI of (v2.1 − v2.2) above 0 for **both** Brier and log loss.
- After the gate first reads `ready`, re-run it monthly. Keep the first ready read as the decision of record. Do not
  re-read until it passes.

Also report:

- the regime slices (precip / overcast / broken / clear at the scoring time)
- station group × hour bucket
- calibration deciles

Use these as diagnostics, not gates.

Promotion beyond SHADOW needs **both** of the following. The forward lane is the only pristine evidence v2.2 can get.

- `forward_gate_passed`
- an owner decision

## What is deliberately not in this module

- No network fetches, no DB access, no scheduling.
- No change to v2.1 dedupe or to `intraday-live.js`, which belongs to the other session.
- No use of market prices for evaluation weighting or selection. The report takes no market field.
