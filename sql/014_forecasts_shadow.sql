-- 014: private SHADOW forecast ledger (maxtemp-intraday 2.2.0 forward validation). Sprint 2026-10-07, Phase 2.
-- ADDITIVE ONLY. Shadow rows live in their own table, never in pred_forecasts, so:
--   * no public read path (desk, event pages, live layer, Insights, newsroom, track record, decisions, venues) can see them;
--   * the live v2.1 write-dedupe (newest prior pred_forecasts row) can never be influenced by a shadow row.
-- Market columns exist only to be provably NULL (CHECK): no market value is ever carried on a shadow row.
-- Feature vectors are stored inline and must pass pred_features_market_free (same guard as pred_feature_snapshots).
-- RLS on, no policies: service role only.

begin;

create table pred_forecasts_shadow (
  forecast_id uuid primary key default gen_random_uuid(),
  record_id text not null unique,                         -- contract|model@version|shadow|<predictive hash 24>|<captured_at>
  event_id text not null,
  contract_id text not null references pred_contracts(contract_id),
  market_id text,
  model_id text not null,
  model_version text not null,
  model_state text not null check (model_state = 'SHADOW'),
  record_type text not null check (record_type = 'shadow'),
  public boolean not null default false check (public = false),
  designation_rules text not null,
  probability numeric(10,9) not null check (probability >= 0 and probability <= 1),
  raw_probability double precision,
  captured_at timestamptz not null,
  data_cutoff_at timestamptz not null,
  confidence text,
  station_id text not null,
  climate_date date not null,
  observation_start timestamptz not null,
  predictive_input_hash text not null check (predictive_input_hash ~ '^[0-9a-f]{64}$'),
  source_state_hash text not null check (source_state_hash ~ '^[0-9a-f]{64}$'),
  features jsonb not null,
  features_sha256 text not null,
  provenance jsonb not null default '[]'::jsonb,
  explanation jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  market_probability numeric check (market_probability is null),
  market_snapshot_key text check (market_snapshot_key is null),
  market_observed_at timestamptz check (market_observed_at is null),
  inserted_at timestamptz not null default now(),
  constraint pred_forecasts_shadow_market_free check (pred_features_market_free(features)),
  constraint pred_forecasts_shadow_time check (data_cutoff_at <= captured_at and observation_start <= captured_at)
);
create index pred_forecasts_shadow_contract_idx on pred_forecasts_shadow (contract_id, model_version, captured_at desc);

create trigger pred_forecasts_shadow_no_update before update or delete on pred_forecasts_shadow
for each row execute function pred_reject_mutation();
create trigger pred_forecasts_shadow_no_truncate before truncate on pred_forecasts_shadow
for each statement execute function pred_reject_mutation();

alter table pred_forecasts_shadow enable row level security;
revoke all on pred_forecasts_shadow from anon, authenticated;

comment on table pred_forecasts_shadow is 'Append-only PRIVATE SHADOW forecasts (forward validation). Never public, never a market input; compared against live rows on a fixed hourly grid.';

commit;
