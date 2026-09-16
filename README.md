# PropBetEdge Predictions

**Target public launch: January 2027**

PropBetEdge Predictions is the prediction-market intelligence vertical of PropBetEdge.

The product goal is not to recreate an exchange. It is to build an independent intelligence layer around real-world event markets: ingest active markets, collect outside-world data, estimate fair probabilities, measure divergence from market pricing, explain the drivers, and score every forecast after resolution.

## Our data advantage

PropBetEdge Predictions is not starting from a blank sheet. The broader PropBetEdge / PropTechUSA ecosystem already operates real data infrastructure across two important domains:

- global property and real-estate intelligence infrastructure
- sports intelligence infrastructure across multiple leagues and combat sports

When those datasets are relevant to a prediction market, specialist models may use normalized internal data alongside authoritative external sources. Examples include housing, mortgage, property-market, disaster-exposure, local economic, and sports-related event markets.

The system must never imply that every forecast uses proprietary data. Every public forecast should disclose the model family, model version, material source classes, and provenance used for that specific prediction.

The long-term objective is to combine proprietary domain data, authoritative public data, venue pricing, historical outcomes, and specialist models into a continuously scored probability-intelligence dataset.

## Initial focus

The first build phase prioritizes categories where PropBetEdge and PropTechUSA already have useful infrastructure or differentiated data advantages:

- Macro / economic releases
- Housing and real estate
- Weather and disaster events
- Sports-linked prediction markets

Future categories may include companies, crypto, culture, geopolitics, and other event classes where reliable source data and measurable outcomes exist.

## Core product loop

1. Ingest prediction markets and market metadata.
2. Normalize contracts into canonical events and resolution rules.
3. Ingest external and, where relevant, proprietary internal source data.
4. Produce a model probability and confidence state.
5. Compare model probability with market-implied probability.
6. Explain the most important model drivers and source provenance.
7. Archive snapshots over time.
8. Record final resolution.
9. Score calibration, accuracy, and historical edge.
10. Feed resolved outcomes back into evaluation and model development.

## Product principles

- Evidence before opinion.
- Explicit resolution criteria.
- Provenance on every meaningful input.
- No fabricated data; unknown values remain unknown.
- Model probabilities are tracked historically rather than overwritten.
- Market prices and model estimates are separate concepts.
- Proprietary data use is disclosed at the forecast level when material.
- Performance claims must be backed by resolved-market history.
- Production access remains closed until validation is strong enough to support it.

## Proposed architecture

```text
market adapters
  -> canonical events
  -> public + proprietary data adapters
  -> feature snapshots
  -> specialist probability engines
  -> divergence / edge engine
  -> explanation + provenance
  -> resolution engine
  -> scoring + calibration history
  -> media / API / web product
```

## First vertical slice

The first end-to-end slice uses Federal Reserve decision markets.

Current research foundation includes:

- Kalshi public market normalization
- FRED macro-source ingestion
- Fed decision baseline-v0 probability model
- explicit model-vs-market snapshots
- append-only market/source/prediction history
- official FOMC outcome registry
- historical categorical backtesting
- Brier and log-loss scoring
- calibration bins and expected calibration error

The official-decision registry currently covers September 2024 through July 2026 policy decisions. Historical model testing must use macro features that were actually available before each meeting; post-meeting or revised data must never leak into a backtest.

A slice is complete only when it can:

- discover an active market,
- persist market price history,
- normalize its resolution rules,
- collect relevant source data,
- calculate a versioned model probability,
- display the model-vs-market gap,
- retain every historical prediction snapshot,
- ingest the official resolution,
- score the forecast,
- expose provenance and validation results.

## January 2027 roadmap

### Phase 0 — Foundation

Repository architecture, event schema, provenance model, market-adapter interfaces, scoring definitions, validation gates, and documentation.

### Phase 1 — Macro intelligence

One complete macro event family running end to end with historical backfill and resolved-event scoring.

### Phase 2 — Multi-category expansion

Add housing/real-estate, weather, and sports-linked event families where differentiated internal data can improve the intelligence layer.

### Phase 3 — Product layer

Prediction cards, event pages, market/model timelines, source explanations, historical track record, watchlists, alerts, media tools, and API surfaces.

### Phase 4 — Pre-launch validation

Calibration reporting, leakage checks, source-rights audit, failure-mode testing, production readiness, and public launch preparation.

## Working domain

`predictions.propbetedge.ai`

## Status

Early foundation build. No rush to production. The priority is building a defensible historical intelligence system before opening the product publicly.
