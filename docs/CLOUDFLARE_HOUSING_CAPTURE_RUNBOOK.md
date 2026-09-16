# Cloudflare housing capture deployment runbook

This runbook deploys the PropBetEdge Predictions housing runtime into Cloudflare Workers. Cloudflare is the execution/cron/service-binding layer. GitHub remains source control + CI only.

## Deployment topology

All Workers in this stack are private service-only deployments:

- `pbe-predictions-ledger`
- `pbe-predictions-source-housing-history`
- `pbe-predictions-source-macro`
- `pbe-predictions-source-zori`
- `pbe-predictions-source-permits`
- `pbe-predictions-source-propdata`
- `pbe-predictions-source-census`
- `pbe-predictions-feature-housing`
- `pbe-predictions-model-housing`
- `pbe-predictions-pipeline-housing`
- `pbe-predictions-collector-housing-history`
- `pbe-predictions-collector-housing-signals`

Every config sets `workers_dev=false` and `preview_urls=false`. The internal ledger and source Workers are reachable through Cloudflare service bindings rather than public `workers.dev` routes.

Existing production upstream services are bound directly:

- `PROPDATA` -> `propdata-api-worker`
- `CENSUS_INTEL` -> `propdata-census-api`

## Capture schedules

Cloudflare cron expressions are UTC.

- Housing HPI collector: `15 9 * * *`
  - captures all state/DC and current metro FHFA HPI snapshots daily
  - HPI observation keys remain pinned to PropData's upstream retrieval timestamp, so an unchanged upstream vintage is a ledger no-op
- Housing signals collector: `30 14 * * *`
  - captures current Freddie Mac/FRED `MORTGAGE30US`
  - captures the full Zillow state and metro ZORI snapshots with two CSV fetches
  - captures one of seven Census BPS state shards per day, covering all 50 states + DC every seven UTC days

ZORI, BPS and FRED observations carry deterministic `revision` identities. Re-fetching unchanged source content is idempotent even when the HTTP capture time changes. If the source revises a value, the changed revision appends a new immutable row.

## Required secrets

Never commit values for these secrets.

| Worker | Secret |
| --- | --- |
| `ledger` | `SUPABASE_SERVICE_KEY` |
| `source-housing-history` | `PROPDATA_SUPABASE_PUBLISHABLE_KEY` |
| `source-macro` | `FRED_API_KEY` |
| `source-permits` | `CENSUS_API_KEY` |
| `source-propdata` | `PROPDATA_API_KEY` |
| `source-census` | `CENSUS_INTEL_KEY` |

`source-housing-history` prefers the publishable PropData Supabase credential because the retained HPI tables are readable with that role; `PROPDATA_SUPABASE_SERVICE_KEY` remains a compatibility fallback but should not be used when the lower-privilege credential is sufficient.

## Production deployment order

Run from the repository root in an authenticated Cloudflare shell. Use the installed `wrangler` executable; no GitHub workflow is part of the runtime.

### 1. Confirm the Cloudflare account

```powershell
wrangler whoami
```

The upstream PropData and Census service bindings must resolve in the same Cloudflare account.

### 2. Deploy the private dependency Workers first

These Workers have no cron triggers, so deploying them before secrets are loaded cannot start background capture.

```powershell
wrangler deploy --config workers/ledger/wrangler.jsonc
wrangler deploy --config workers/source-housing-history/wrangler.jsonc
wrangler deploy --config workers/source-macro/wrangler.jsonc
wrangler deploy --config workers/source-zori/wrangler.jsonc
wrangler deploy --config workers/source-permits/wrangler.jsonc
wrangler deploy --config workers/source-propdata/wrangler.jsonc
wrangler deploy --config workers/source-census/wrangler.jsonc
wrangler deploy --config workers/feature-housing/wrangler.jsonc
wrangler deploy --config workers/model-housing/wrangler.jsonc
```

### 3. Load secrets interactively

Each command prompts for the value and stores it in Cloudflare; do not paste values into Git or the Wrangler config files.

```powershell
wrangler secret put SUPABASE_SERVICE_KEY --config workers/ledger/wrangler.jsonc
wrangler secret put PROPDATA_SUPABASE_PUBLISHABLE_KEY --config workers/source-housing-history/wrangler.jsonc
wrangler secret put FRED_API_KEY --config workers/source-macro/wrangler.jsonc
wrangler secret put CENSUS_API_KEY --config workers/source-permits/wrangler.jsonc
wrangler secret put PROPDATA_API_KEY --config workers/source-propdata/wrangler.jsonc
wrangler secret put CENSUS_INTEL_KEY --config workers/source-census/wrangler.jsonc
```

### 4. Deploy the housing pipeline

```powershell
wrangler deploy --config workers/pipeline-housing/wrangler.jsonc
```

Its service bindings resolve the source, feature, model and ledger Workers privately inside Cloudflare.

### 5. Deploy collectors LAST

This is the point at which the two production cron schedules become active.

```powershell
wrangler deploy --config workers/collector-housing-history/wrangler.jsonc
wrangler deploy --config workers/collector-housing-signals/wrangler.jsonc
```

Do not deploy the collectors until all dependency Workers exist and the required secrets are loaded.

## Verification

Confirm Cloudflare accepted each deployment:

```powershell
wrangler deployments list --config workers/ledger/wrangler.jsonc
wrangler deployments list --config workers/collector-housing-history/wrangler.jsonc
wrangler deployments list --config workers/collector-housing-signals/wrangler.jsonc
```

Tail the collectors when validating a scheduled run:

```powershell
wrangler tail pbe-predictions-collector-housing-history
wrangler tail pbe-predictions-collector-housing-signals
```

Expected housing-history log on success includes the number of national HPI snapshots captured. Expected housing-signals output is a JSON summary with `mortgage30`, `zori_all`, `permits_states`, the permit shard, and any per-source error rather than silently fabricating a value.

## Ledger verification contract

After the first successful production capture, verify in the PropBetEdge Predictions Supabase ledger:

1. unchanged 2026-Q2 HPI rows do not multiply on repeated cron runs;
2. current ZORI state and metro vintages appear with deterministic revision keys;
3. `MORTGAGE30US` captures the newest weekly observation and previous observation;
4. Census BPS state coverage accumulates across the seven shards;
5. changed/revised upstream values append new records rather than mutate prior records;
6. no collector writes a forecast by itself — sources are evidence; the housing pipeline creates research forecasts separately.

## Rollback / emergency stop

The collectors own the cron triggers. To stop automated capture without touching the source Workers or ledger data, remove or disable the collector cron triggers in Cloudflare. Do not delete or rewrite existing ledger observations as a rollback mechanism.

The ledger is append-only by design. Corrections must append new evidence/resolution records rather than editing history.
