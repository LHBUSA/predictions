# PropBetEdge Predictions Workers

The worker layer is intentionally decomposed by responsibility and domain. No universal predictor.

## Platform workers

- `market-ingest` — venue market snapshots (Kalshi first, others later)
- `event-normalizer` — maps venue contracts to canonical events
- `source-capture` — validates and records point-in-time evidence
- `source-macro` — vintage-aware FRED macro observations
- `source-propdata` — server-side PropData market-intelligence snapshots
- `feature-snapshot` — freezes model features against a forecast cutoff and rejects post-cutoff sources
- `model-router` — dispatches canonical events to specialist model families
- `resolution` — monitors official resolution authorities and records outcomes
- `scoring` — Brier/log-loss/calibration and model-vs-market evaluation
- `media` — citations, embeds, publication-ready snapshots, historical lookup
- `api` — public/Pro/API delivery surface

## Active specialist model workers

- `model-fed` — Fed decision outcome probabilities
- `model-inflation` — CPI/inflation threshold probabilities
- `model-employment` — unemployment and payroll threshold probabilities
- `model-gdp` — GDP growth above-threshold baseline
- `model-housing` — home-price threshold model with explicit PropData participation
- `model-mortgage` — mortgage-rate above/below threshold model
- `model-weather` — continuous temperature threshold model only; hurricane events fail closed
- `model-crypto` — price-threshold volatility/horizon model

## Specialist scaffolds still requiring domain work

- `model-companies`
- `model-world`
- `model-sports-bridge`

A dedicated hurricane/storm model will be separate from the generic temperature worker.

Every specialist worker must expose the same forecast contract while retaining its own feature set, source hierarchy, update cadence, model versions, calibration and failure modes.

## Shared data contract

The intended path is:

`source worker -> source observation -> feature snapshot -> model router -> specialist model -> forecast envelope -> resolution -> scoring`

Every source observation carries observed, available and captured timestamps. Feature snapshots reject any observation that was not available before the forecast cutoff. Historical replays must use retained historical snapshots rather than present-day API responses.

Unsupported event families or unsupported event shapes fail closed.
