# Predictions Model Sprint — 2026-10-06

Branch: `codex/predictions-model-sprint-20261006`  
Tracking: GitHub issue #45

## Objective

Expand PropBetEdge Predictions through specialist, auditable probability models without weakening the existing market-separation, point-in-time, append-only, or promotion rules.

This sprint is model research and validation. It is **not** a request to increase the number of public probabilities.

## Current production model truth

The live core is `workers/pbe-predictions`.

| Family | Canonical live implementation | State | Notes |
|---|---|---:|---|
| Weather — measurable rain | `src/weather/*` via `workers/pbe-predictions` | RESEARCH | Public research model |
| Weather — daily high | `src/weather/*` via `workers/pbe-predictions` | RESEARCH | Public research model |
| Treasury yield paths | `src/rates/*` via `workers/pbe-predictions` | RESEARCH | Public research model |
| Fed decision | `src/macro/fed-model.js` + `src/macro/engine.js` | SHADOW | v1 does not beat the always-hold benchmark strongly enough for promotion |
| Corporate fundamentals | none in live core | MONITORING | Tesla/Amazon series tracked only |
| Space operations | none in live core | MONITORING | SpaceX series tracked only |
| Public health counts | none in live core | MONITORING | Measles / Florida dengue tracked only |
| Energy/regulatory | none in live core | MONITORING | NRC reactor license tracked only |
| Corporate event hazard | none in live core | MONITORING | Anthropic/Brex IPO timing tracked only |

## Architecture reconciliation

The repository contains an older specialist-worker architecture in addition to the current live core:

- `workers/model-fed`
- `workers/model-inflation`
- `workers/model-employment`
- `workers/model-gdp`
- `workers/model-housing`
- `workers/model-mortgage`
- `workers/model-router`
- `workers/replay-macro`

These workers are useful research components, but they must not become a second probability truth.

### Canonical decision

1. The current `workers/pbe-predictions` ledger/runtime remains the canonical live Predictions pipeline.
2. Specialist research modules may be used for fitting, replay, and SHADOW research.
3. A family gets one canonical probability implementation before live integration.
4. Market data is benchmark/scoring only and must be attached **after** model computation.
5. No new general-purpose prediction pipeline should be created.

## Duplicate Fed implementation

There are currently two materially different Fed probability engines.

### Canonical current Fed model

- `src/macro/fed-model.js`
- `src/macro/engine.js`
- frozen artifact: `src/macro/artifacts/fed-v1.json`
- model id: `pbe-fed-decision`
- state: `SHADOW`

Inputs are official H.15/FRED series plus the official FOMC calendar. This implementation is integrated with the current core ledger, feature snapshot, evidence, designation, resolution, and scoring architecture.

### Older research baseline

- `src/models/fed-decision-v0.js`
- `workers/model-fed/src/index.js`
- model id: `fed-decision-baseline`

This is a separate hand-tuned inflation/labor-pressure softmax. It is not the current live-core Fed model and must not be allowed to drift into a competing production probability.

### Decision

`pbe-fed-decision` is the canonical Fed family. The older `fed-decision-baseline` may remain only as an explicitly labeled research comparator until it is retired or absorbed into a reproducible Fed-v2 experiment.

Do not publish or promote either model based on this cleanup.

## Inflation research status

Existing paths:

- model: `src/models/inflation-v0.js`
- worker: `workers/model-inflation/src/index.js`
- replay: `src/replay/cpi-history.js`
- point-in-time feature reconstruction: `src/features/inflation-replay-features.js`
- mapped release registry: `data/cpi/headline-yoy-releases.json`

The replay path correctly requests FRED observations with `realtime_start` and `realtime_end` pinned to the historical cutoff date.

However, the current model is a hand-tuned sigmoid baseline, not a fitted calibrated model.

The checked-in mapped release registry contains only **3 releases**:

- 2025-12
- 2026-05
- 2026-07

This is enough to test replay plumbing and historical Kalshi mapping. It is **not** a training or validation sample.

Additional known limitation: replay features currently set `energyMoM=0` and use `coreYoY` as a disclosed proxy for `shelterYoY`. Those approximations must not silently become fitted-model facts.

### Inflation next action

Before fitting v1:

1. build a substantially longer official CPI release registry;
2. reconstruct vintage-safe features at a predeclared cutoff for each release;
3. use official realized CPI as the target;
4. fit a coherent release distribution rather than independent arbitrary threshold sigmoids;
5. derive all threshold probabilities from the same distribution;
6. compare out of sample with climatology, persistence, and a simple empirical/Gaussian error model.

Remain BACKTESTING/SHADOW until the evidence gate passes.

## Employment research status

Existing paths:

- model: `src/models/employment-v0.js`
- worker: `workers/model-employment/src/index.js`
- replay: `src/replay/payroll-history.js`
- point-in-time feature reconstruction: `src/features/employment-replay-features.js`
- mapped release registry: `data/employment/payroll-releases.json`

The replay path uses FRED realtime dates pinned to the forecast cutoff and converts payroll levels into vintage-visible monthly changes. Claims units are normalized explicitly.

The checked-in mapped payroll registry contains only **4 releases**:

- 2026-05
- 2026-06
- 2026-07
- 2026-08

Again, this is replay/venue-mapping coverage, not a training set.

The current model is a hand-tuned sigmoid baseline. It must not be promoted as calibrated probability intelligence.

### Employment next action

Before fitting v1:

1. expand the official BLS payroll release history;
2. preserve first-available/vintage-safe payroll levels at each cutoff;
3. preserve unemployment and weekly claims actually available at the cutoff;
4. build a coherent predictive distribution for payroll change;
5. model unemployment separately rather than mixing threshold-specific hand tuning;
6. evaluate using rolling/time-ordered holdouts.

Remain BACKTESTING/SHADOW until the evidence gate passes.

## Fed v2 research status

Current v1 uses:

- 6-month Treasury minus target midpoint;
- change in that spread since the prior decision;
- prior decision direction;
- meeting horizon.

The current decision-policy evidence explicitly keeps Fed unvalidated because probabilistic skill is weak and top-outcome accuracy trails the always-hold baseline.

### Fed v2 next action

Research v2 only with point-in-time-safe official inputs. Candidate feature groups:

- current Treasury/policy spread and changes;
- curve shape;
- previous decision path;
- time since prior meeting;
- meeting horizon;
- CPI/labor features only when their historical vintage is provably available at cutoff.

Benchmarks:

- always hold;
- previous-decision persistence;
- historical climatology;
- current `pbe-fed-decision@1.0.0`.

Selection must use Brier/log loss and calibration, not just modal accuracy.

## Other existing specialist baselines

### GDP

- `src/models/gdp-v0.js`
- `workers/model-gdp/src/index.js`

Research-only baseline. Requires a vintage-safe GDP/nowcast dataset before validation.

### Mortgage

- `src/models/mortgage-v0.js`
- `workers/model-mortgage/src/index.js`

Research-only baseline. A usable model must define forecast horizon and exact resolution semantics first.

### Housing

- `src/models/housing-v0.js`
- `workers/model-housing/src/index.js`
- `workers/pipeline-housing`

This is more developed operationally than most dormant specialists, but its current baseline still uses neutral imputations and is not part of the live Predictions core. Treat as a separate later validation project rather than auto-wiring it into the public desk.

## Monitoring-family priority

Recommended order after macro validation work:

1. **Tesla deliveries** — high potential if official IR/SEC history and historical cutoff-safe predictors are reconstructible.
2. **SpaceX launch counts** — viable only with a trustworthy point-in-time completed-launch and schedule history; use count/hazard methods.
3. **Public health counts** — CDC/FDOH sources are promising, but reporting delay and cadence must be modeled explicitly.
4. **NRC reactor licensing** — use a procedural hazard model only if historical docket milestone data support it.
5. **Anthropic/Brex IPO timing** — SHADOW at most until contract-resolution semantics and event-history data are strong.
6. **Amazon headcount** — leave monitoring if the contract depends on a commercial settlement dataset that cannot be independently reproduced cleanly.

## Required evidence gate

A family may not move beyond BACKTESTING/SHADOW without:

- exact contract semantics and resolution source;
- strict point-in-time feature reconstruction;
- no market-derived model features;
- reproducible training script;
- frozen model artifact with version/hash;
- time-ordered or rolling-origin holdout;
- at least one strong naive baseline;
- Brier score;
- log loss;
- calibration/reliability;
- sharpness/discrimination summary;
- bootstrap uncertainty for skill vs baseline;
- failure-mode analysis;
- source-failure behavior that fails closed;
- tests proving market-price changes cannot alter the PBE probability;
- prospective SHADOW capture before public promotion.

## Immediate Codex execution order

1. Keep production untouched.
2. Expand CPI and payroll research histories from official sources.
3. Build deterministic research datasets with explicit cutoff/vintage metadata.
4. Fit Inflation v1 and Employment v1 with reproducible scripts and frozen artifacts.
5. Run time-ordered holdouts and publish the evidence packet into `docs/research`.
6. Research Fed v2 and compare with Fed v1 plus naive baselines.
7. Only then propose SHADOW integration changes.
8. Do not alter a public model state or activate CALLs without owner approval.
