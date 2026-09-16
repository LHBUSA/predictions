# PropBetEdge Predictions Workers

The worker layer is intentionally decomposed by responsibility and domain. No universal predictor.

## Runtime rule

Cloudflare Workers are the execution and automation layer. Upstream PropTechUSA / PropBetEdge data products are consumed through Cloudflare service bindings where possible, with authenticated HTTPS fallback only when explicitly configured. GitHub is not a product runtime.

## Platform workers

- `market-ingest` — venue market snapshots (Kalshi first, others later)
- `event-normalizer` — maps venue contracts to canonical events
- `source-capture` — records point-in-time external evidence and rejects post-cutoff data
- `source-macro` — vintage-aware FRED macro capture
- `source-propdata` — authenticated PropData `/v1/market` and `/v1/state-intel` capture
- `source-census` — authenticated PropTechUSA Census Intelligence capture for ZIP/state/county structural context
- `source-business` — authenticated PropTechUSA Business Intelligence capture for company identity/classification context
- `feature-snapshot` — freezes model inputs and source classes at a forecast cutoff
- `feature-housing` — assembles PropData/Census observations into a disclosed housing feature vector
- `ledger` — persists events, observations, feature snapshots, venue snapshots, forecasts, resolutions and scores to the append-only Supabase Predictions ledger
- `replay-macro` — retrospective point-in-time macro reconstruction; never treated as a live published forecast
- `model-router` — dispatches canonical events to specialist model families
- `resolution` — monitors official resolution authorities and records outcomes
- `scoring` — Brier/log-loss/calibration and model-vs-market evaluation
- `media` — citations, embeds, publication-ready snapshots, historical lookup
- `api` — public/Pro/API delivery surface

## Cloudflare bindings and secrets

### `source-propdata`

Preferred binding:

- `PROPDATA` — service binding to the production PropData Worker

Required secret:

- `PROPDATA_API_KEY` — server-side authenticated key passed in `x-api-key`

Optional fallback:

- `PROPDATA_BASE_URL` — HTTPS origin when service binding is not configured

### `source-census`

Preferred binding:

- `CENSUS_INTEL` — service binding to the US Census Intelligence Worker

Required secret:

- `CENSUS_INTEL_KEY` — authenticated key so Predictions receives the full structural profile rather than the anonymous/free subset

Optional fallback:

- `CENSUS_INTEL_BASE_URL`

### `source-business`

Preferred binding:

- `BUSINESS_INTEL` — service binding to the US Business Intelligence Worker

Required secret:

- `BUSINESS_INTEL_KEY` — authenticated key passed to the upstream Worker

Optional fallback:

- `BUSINESS_INTEL_BASE_URL`

### `ledger`

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` preferred; `SUPABASE_KEY` is accepted for compatibility when it is the server-side service credential

The ledger credential must never be exposed to browser code.

## Source taxonomy

Forecast provenance uses these normalized classes:

- `propdata` — PropData property/market intelligence
- `sports` — PropBetEdge sports intelligence
- `official` — authoritative public sources such as Census/Fed/BLS/FHFA after normalization
- `venue` — prediction-market pricing
- `licensed` — licensed commercial data
- `research` — explicitly experimental research inputs
- `proprietary` — other PropTechUSA-normalized proprietary intelligence such as Business Intelligence

The normalization Worker is always retained in provenance. A normalized source is not relabeled as official merely because one upstream component came from an official source.

## Active specialist model workers

- `model-fed`
- `model-inflation`
- `model-employment`
- `model-gdp`
- `model-housing` — v0.1.1 discloses neutral imputations and separates PropData state signal from FHFA
- `model-mortgage`
- `model-weather` — temperature-threshold family only in v0.1; hurricane stays fail-closed
- `model-crypto`

## Active retrospective replay families

- `fomc_decision` — categorical Fed decision replay with five-outcome same-cutoff Kalshi comparison when a verified venue event is mapped
- `cpi_yoy_thresholds` — independent headline-CPI threshold contracts scored against official BLS releases and same-cutoff Kalshi prices
- `payroll_thresholds` — independent payroll threshold contracts using vintage payroll/unemployment data plus weekly initial and continuing claims

Replay artifacts preserve source vintages, feature transformations, model version, cutoff time, official resolution source, venue settlement checks, and distinct model-vs-market sample counts.

## Specialist scaffolds still intentionally closed

- `model-companies` — now fails closed with `MODEL_NOT_READY`; Business Intelligence identity data alone cannot produce a probability
- `model-world`
- `model-sports-bridge`

Every specialist worker must expose the same contract while retaining its own feature set, source hierarchy, update cadence, model versions, calibration and failure modes.

## Shared contract

Each specialist receives a canonical event + point-in-time feature snapshot and returns a versioned forecast payload. Unsupported events fail closed.

Retrospective replays are tagged separately from live forecast records. Historical simulations are useful for calibration and failure analysis, but they must never be presented as forecasts that were published in real time.
