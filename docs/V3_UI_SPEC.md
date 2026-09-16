# PropBetEdge Predictions — V3 UI System

## Product position

PropBetEdge Predictions should look and behave like an independent probability-intelligence publication and research terminal, not a betting dashboard.

Design keywords:

- authoritative
- global
- citable
- transparent
- calm
- technical
- premium
- editorial
- data-first
- public-record quality

Core product statement:

> The world has a price. We measure the probability.

Supporting data statement:

> We do not begin with a prompt. We begin with data.

## Visual system

### Palette

- canvas: soft off-white / ice (#f6f9fc family)
- surface: white
- text primary: deep navy / ink
- text secondary: slate
- primary accent: electric intelligence blue
- positive directional state: restrained green
- negative directional state: restrained red
- research state: pale amber/gold
- proprietary-data state: pale violet/blue

Avoid casino neon, heavy gradients, dark sportsbook motifs, excessive red/green, and gamified animations.

### Typography

Use a modern sans-serif system stack until a licensed product font is intentionally selected. Headlines should be editorial and highly legible. Numeric probability values should use strong tabular-style presentation. Metadata should be quiet but precise.

### Spacing and density

Use generous whitespace. Research cards should feel like reports, not trading widgets. Dense details belong inside records, drawers, tables, and expandable ledgers rather than being sprayed across the homepage.

### Motion

Subtle only: hover elevation, gentle drawer transitions, line-chart inspection, disclosure expansion. Never use flashing odds, pulsing betting CTAs, or casino-like motion.

---

# Screen 1 — Intelligence Home

## Purpose

Answer in under five seconds:

1. What is PropBetEdge Predictions?
2. What does it measure?
3. What is different about it?
4. Can I inspect and trust the record?

## Required sections

### Global masthead

- product brand
- Global Probability Intelligence label
- primary statement
- short explanation of model probability vs market price
- Open Intelligence Desk CTA
- Explore Data Layer CTA
- trust strip: versioned forecasts / provenance / resolution rules / scored history

### Data infrastructure

Headline: **Built on real data infrastructure**

Three source pillars:

1. PropTechUSA / PropData — global real-estate and property intelligence
2. PropBetEdge Sports — multi-sport history and model infrastructure
3. Authoritative sources — official macro, weather, agency, company and venue data

Every forecast must show the actual source classes used. Never imply proprietary sources contributed when they did not.

### Intelligence desk

Cards show:

- event title
- category
- venue(s)
- model probability
- market probability / consensus
- divergence
- forecast state
- updated timestamp
- source-class badges
- model ID/version on inspect

### Featured forecast record

A highly polished reference card showing the permanent forecast ID and citation pattern.

### Track-record preview

- resolved forecast count
- Brier score
- log loss
- calibration state
- no metrics displayed until they are legitimately computed

### Media/reference strip

Prominent path to Media / Cite / Embed / Historical lookup.

---

# Screen 2 — Canonical Event Record

## Purpose

This is the atomic product unit and must be publication-grade.

Canonical path pattern:

`/events/<event-slug>`

Example:

`/events/fed-september-2026`

## Header

- category breadcrumb
- event status
- permanent event/forecast record ID
- canonical event title
- short resolution description
- last updated
- research / validated state
- Copy citation
- Share
- Methodology

## Primary probability block

Show side-by-side:

- PropBetEdge probability
- venue probability / consensus
- divergence
- confidence/research state

Avoid language implying certainty or guaranteed edge.

## Probability history

Publication-quality chart:

- model probability line
- market probability line
- optional venue-specific lines
- release/event annotations
- timeline selector
- exact hover timestamps
- chart export later

## Why the model moved

Chronological driver cards showing changes to features or source observations.

## Data used

Source-class badges + ledger:

- proprietary property data — if used
- PropBetEdge sports data — if used
- authoritative public/official data
- market venue data
- other licensed data

Every material source row should eventually include provider, series/resource, observation time, retrieval time, and provenance reference.

## Model record

- model family
- model ID
- model version
- research/validated status
- feature snapshot ID
- methodology link
- known limitations

## Resolution record

- declared resolution rule
- resolution authority
- expected resolution time
- final outcome when resolved
- resolution evidence
- score after resolution

## Forecast archive

Immutable chronological snapshots. Historical forecast records are never overwritten.

## Citation block

Copyable citation should include:

- PropBetEdge Predictions
- event title
- forecast ID
- probability
- timestamp
- model version
- canonical URL

---

# Screen 3 — Track Record

## Purpose

Make performance auditable, not promotional.

## Sections

- overall resolved count
- calibration curve
- Brier score
- log loss
- model vs market comparison when like-for-like market snapshots exist
- performance by model family
- performance by horizon
- research vs validated models
- resolved-event table
- methodology and leakage rules

Never hide losing or poorly calibrated forecasts from the historical record.

---

# Screen 4 — Models

## Purpose

Show the federation of specialist engines and make it clear there is no universal oracle.

## Model-family cards

Initial families:

- Fed decisions
- Inflation
- Employment
- GDP
- Housing
- Mortgage
- Weather
- Crypto
- Companies
- World events
- Sports bridge

Each card shows:

- status
- model version
- source classes
- update cadence
- current coverage
- resolved sample count
- calibration state
- methodology
- known limitations

## Principle

LLMs may help summarize and explain evidence, but specialist forecasting engines own probabilities.

---

# Screen 5 — Media

## Purpose

Make PropBetEdge easy to cite and difficult to misquote.

## Media desk

- notable current forecasts
- recently resolved records
- largest model/market changes
- historical lookup by timestamp
- citation generator
- embed generator
- chart export
- methodology index
- press contact / press access later

## Embed card

Should support:

- event
- probability
- market comparison
- timestamp
- forecast ID
- PropBetEdge branding
- canonical URL

The public event record remains accessible without a paid subscription.

---

# Screen 6 — Pro Intelligence

## Product boundary

The public probability record remains free. Pro monetizes workflow and advanced intelligence.

Target concepts:

- $19.99 monthly
- $7.99 weekly

Potential Pro features:

- real-time divergence scanner
- specialist-model detail
- model disagreement / ensemble view
- confidence bands
- advanced historical lookup
- alerts and watchlists
- cross-venue comparison
- deeper driver attribution
- downloadable datasets
- advanced calibration/backtest reports
- saved dashboards

The public canonical forecast record, public methodology summary, resolution result, and citation surface should not disappear behind the Pro wall.

---

# Core component library

## Navigation

- global top nav
- category tabs
- research-state indicator
- citation mode

## Probability components

- probability value
- market comparison
- divergence chip
- confidence/research state
- movement indicator

## Data components

- source-class badge
- source ledger row
- proprietary-data disclosure
- feature snapshot reference
- model-version chip

## Record components

- forecast ID
- immutable timestamp
- resolution authority
- resolution state
- score block
- citation action

## Media components

- share card
- embed card
- publication chart
- copy citation
- historical lookup

---

# Source-class visual taxonomy

Use consistent badges across all surfaces:

- `PropData` — proprietary real-estate / property intelligence
- `PropBetEdge Sports` — internal sports intelligence
- `Official` — authoritative agencies and declared public authorities
- `Venue` — exchange / prediction-market pricing
- `Licensed` — licensed external commercial datasets
- `Research` — non-production experimental inputs

Source classes describe actual forecast inputs, not company capabilities in general.

---

# World-class acceptance criteria

V3 is not accepted until:

- desktop and mobile both look intentional
- homepage no longer resembles a sportsbook or generic SaaS template
- Event Record looks publication-ready in a screenshot
- probability hierarchy is obvious within two seconds
- proprietary-data claims are forecast-specific and auditable
- all research examples are clearly labeled
- no fake track-record metrics are shown
- model and market probability are visually distinct
- every event surface exposes resolution authority
- every event surface has a citation path
- typography, spacing, cards, charts and metadata use one coherent system
- all pages share one brand/navigation/footer system
- keyboard and basic accessibility states are preserved
- URLs and page titles are suitable for indexing and media linking

---

# Build order

1. Canonical Event Record V3
2. Homepage V3 refinement around Event Record design language
3. Track Record
4. Models
5. Media
6. Pro shell / paywall states
7. Live backend binding and real chart data
8. screenshot/export/embed polish

The Event Record defines the system. Do not independently redesign later screens; derive them from the Event Record primitives.