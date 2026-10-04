# PropBetEdge Predictions — real-world event engine v1

`MARKET QUESTION → EXACT RESOLUTION RULE → REAL DATA → SPECIALIST MODEL → PBE PROBABILITY → MARKET PROBABILITY → DIVERGENCE → IMMUTABLE SNAPSHOT → RESULT`

## Runtime

- Worker `pbe-predictions` (`workers/pbe-predictions`, cron `*/15`, writes only when `ENGINE_ENABLED=true`).
- Kalshi is read **only** through the canonical `propsports-markets` Worker (service binding `MARKETS`, signed reads,
  shared rate-limit backoff). Normalization/lifecycle code is vendored unchanged from it (`src/vendor/propsports-markets`, pinned + parity test).
- Ledger: tkmln `pred_*` tables (sql/001 + sql/002), append-only by trigger. `pred_events` is the only mutable registry row.
- Public API (`/v1/board`, `/v1/divergences`, `/v1/contract/:id`, `/v1/queue`, `/v1/track-record`) served same-origin
  at `predictions.propbetedge.ai/api/*` (Vercel rewrite). SHADOW forecasts are never served publicly (`/admin/contract/:id` only).

## The market never enters the model

- Feature vectors are built by `buildFeatureVector` from allowlisted source classes; `venue` is refused.
- No key matching `kalshi|market|venue|bid|ask|price|volume|open_interest|liquidity|settlement|implied_prob|order_book`
  may appear at any depth (JS guard + DB CHECK `pred_features_market_free`).
- Invariance test: shifting every Kalshi price/volume leaves every PBE feature hash and probability unchanged.
- `pred_forecasts.probability` (PBE) and `market_probability` (venue mid at capture, ≤10¢ spread) are separate columns;
  `divergence_points` is generated; `market_observed_at <= captured_at` is enforced.

## Contract normalization (`contract-norm/1`)

Every venue market becomes `NORMALIZED`, `UNMODELABLE`, `HOLD_RESOLUTION_AMBIGUOUS` or `UNSUPPORTED_DOMAIN` (+ machine reason).
Rules text and structured venue fields must agree or the contract is held. Contracts are append-only: a rules change → new `contract_id` (rules hash).

| Family | Station / authority | Window | YES |
|---|---|---|---|
| KXRAIN (30 cities) | named NWS CLI site (e.g. CLIMIA = KMIA; Chicago = O'Hare CLIORD); The Weather Company | CLI climate day, local **standard** time | precip > 0.00 in (trace/missing = NO) |
| KXHIGH{NY,MIA,CHI,LAX,AUS,DEN,PHIL} | CLI site (NY = Central Park KNYC; Chicago = **Midway** CLIMDW); TWC | CLI climate day | integer max in bucket |
| KXFEDDECISION | Federal Reserve FOMC statement; meeting must be on the official calendar | announcement (18:00Z) | exact bucket of the target change |

Verification: TWC settlement vs official NWS CLI at the exact station — 40/40 (NYC highs, Aug 24–Oct 2), 40/40 (NYC rain),
112/112 (all series, 29 stations, Oct 1–2) (`scripts/research/resolution-proof.mjs`).

## Models (all RESEARCH or SHADOW — not validated edge)

| Model | Inputs (official/public) | Holdout (out of sample) |
|---|---|---|
| `pbe-weather-precip@1.1.0` | GFS MOS + NBM 6-h PoP for the window, 1991–2020 station climatology | Brier 0.0864 vs GFS-only 0.0920 vs raw NBM 0.0925 vs climatology 0.1787 (2025-07..2026-09, 52,896 cases) |
| `pbe-weather-precip@1.0.0` | GFS MOS + climatology (fallback when no current NBM run) | Brier 0.0929 vs raw MOS 0.0964 vs climatology 0.1808 |
| `pbe-weather-maxtemp@1.0.0` | GFS MOS day-max + station empirical guidance-error table | exact-degree log loss 2.583 vs Normal 2.613; 2°F-bucket Brier 0.1386 vs 0.1395 |
| `pbe-fed-decision@1.0.0` (SHADOW) | H.15 6-month CMT vs target midpoint, its change since last decision, previous decision, horizon | log loss 0.894 vs climatology 1.093, but top-outcome accuracy 0.565 < always-hold 0.659 → SHADOW + LOW |

Point-in-time: MOS/NBM runs usable only at cycle + 5 h; H.15 daily series are never revised; climatology uses completed years only.
Weather forecasts are published only **before** the climate day opens (no intraday nowcasting in v1).

## Records site contract (for `records.propbetedge.ai`)

- Scoring snapshots are fixed by rule `designation/1` (`pred_forecast_designations`, unique, append-only, trigger forbids post-resolution forecasts):
  `FIRST_PUBLISHED`, `T_MINUS_24H` (latest at or before window start − 24 h), `FINAL_PRE_RESOLUTION` (latest before window start).
- `pred_scores` holds PBE and market (benchmark) Brier + log loss on the same designated snapshot, idempotent per designation.
- `pred_resolutions` stores the venue settlement and the independent official value separately (`sources_agree`).
- Corrections never edit rows: `revision_of` + `revision_reason` on a new forecast; `correction_of` on a new resolution.
- Calibration, buckets, horizon, model-version and data-quality breakdowns are derivable from `pred_forecasts` (+metadata/explanation) joined to scores.

## Not yet supported (fail closed)

International TWC cities (no CLI site), lows/snow/monthly rain series, intraday (window-started) forecasts, CPI/payrolls/GDP markets,
housing, energy, geo/natural, election/civic (classified, queued, no probability).

## Decision ledger (sql/006, owner-approved 2026-10-04)

- `pred_decisions` = the system of record for decisions (pbe-decision-record/1): one immutable row per contract for the
  predeclared unit (FINAL_PRE_RESOLUTION designated forecast captured at/after the policy freeze), written by the cycle at
  designation time (`DECISIONS_DB=true`) via `src/engine/decision-record.js`. Prospective only (DB CHECK: decision_as_of >=
  2026-10-04 13:21Z); no backfill. Append-only (UPDATE/DELETE/TRUNCATE rejected); corrections = new rows with
  `correction_of` + `correction_reason`. A trigger requires each row to restate its designated forecast exactly.
- No market value in the row (no price/venue column; the firewall holds). Venue benchmarks join afterwards.
- No retroactive official calls: `official_at_decision = activated_at known at decision time AND decision_as_of >= activated_at`
  (DB CHECK + `isOfficial`). Activation later never makes an earlier row official.
- `/admin/decisions/verify` recomputes every stored row from the pinned policy (state, side, reasons, policy hash, evidence
  hash, official, probability, decision time must match). `/admin/decisions/prospective` counts the stored ledger.
