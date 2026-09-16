# PropBetEdge Predictions Workers

The worker layer is intentionally decomposed by responsibility and domain. No universal predictor.

## Platform workers

- `market-ingest` — venue market snapshots (Kalshi first, others later)
- `event-normalizer` — maps venue contracts to canonical events
- `source-capture` — records point-in-time external evidence and rejects post-cutoff data
- `source-macro` — vintage-aware FRED macro capture
- `source-propdata` — server-side PropData market-intelligence capture
- `feature-snapshot` — freezes model inputs and source classes at a forecast cutoff
- `replay-macro` — retrospective point-in-time macro reconstruction; never treated as a live published forecast
- `model-router` — dispatches canonical events to specialist model families
- `resolution` — monitors official resolution authorities and records outcomes
- `scoring` — Brier/log-loss/calibration and model-vs-market evaluation
- `media` — citations, embeds, publication-ready snapshots, historical lookup
- `api` — public/Pro/API delivery surface

## Active specialist model workers

- `model-fed`
- `model-inflation`
- `model-employment`
- `model-gdp`
- `model-housing`
- `model-mortgage`
- `model-weather` — temperature-threshold family only in v0.1; hurricane stays fail-closed
- `model-crypto`

## Specialist scaffolds still intentionally closed

- `model-companies`
- `model-world`
- `model-sports-bridge`

Every specialist worker must expose the same contract while retaining its own feature set, source hierarchy, update cadence, model versions, calibration and failure modes.

## Shared contract

Each specialist receives a canonical event + point-in-time feature snapshot and returns a versioned forecast payload. Unsupported events fail closed.

Retrospective replays are tagged separately from live forecast records. Historical simulations are useful for calibration and failure analysis, but they must never be presented as forecasts that were published in real time.
