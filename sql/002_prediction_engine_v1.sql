-- 002_prediction_engine_v1 — PropBetEdge Predictions real-world event engine (owner approved 2026-10-03).
-- STRICTLY ADDITIVE on top of 001_predictions_ledger:
--   * new append-only tables pred_contracts and pred_forecast_designations
--   * new nullable columns on existing tables (no rewrites, no defaults that touch rows)
--   * new CHECK constraints that only bind new values
--   * existing UPDATE/DELETE rejection triggers are untouched; new tables get the same trigger
-- Principle: the market is a benchmark, never a model input. pbe probability (pred_forecasts.probability)
-- and market probability (pred_forecasts.market_probability) are separate columns; feature snapshots may
-- not carry any market-derived key (pred_features_market_free).

begin;

-- ---------------------------------------------------------------------------------------------
-- Leakage guard: no market/venue-derived key anywhere inside a feature vector.
create or replace function pred_features_market_free(doc jsonb)
returns boolean
language sql
immutable
as $$
  select not exists (
    select 1
    from jsonb_path_query(coalesce(doc, '{}'::jsonb), 'strict $.**') as node(v)
    cross join lateral jsonb_object_keys(case when jsonb_typeof(node.v) = 'object' then node.v else '{}'::jsonb end) as k(key)
    where k.key ~* '(kalshi|market|venue|yes_bid|yes_ask|no_bid|no_ask|last_price|order_?book|open_interest|liquidity|implied_prob|settlement|traded|volume)'
  ) and not exists (
    select 1 from jsonb_object_keys(case when jsonb_typeof(doc) = 'object' then doc else '{}'::jsonb end) as k(key)
    where k.key ~* '(kalshi|market|venue|yes_bid|yes_ask|no_bid|no_ask|last_price|order_?book|open_interest|liquidity|implied_prob|settlement|traded|volume)'
  );
$$;

alter table pred_feature_snapshots
  add constraint pred_feature_snapshots_market_free check (pred_features_market_free(features));

-- ---------------------------------------------------------------------------------------------
-- Event registry (mutable registry row; history lives in the append-only tables).
alter table pred_events
  add column if not exists domain text,
  add column if not exists event_family text,
  add column if not exists venue text,
  add column if not exists venue_event_id text,
  add column if not exists venue_series_id text,
  add column if not exists model_family text,
  add column if not exists model_state text,
  add column if not exists lifecycle text,
  add column if not exists close_time timestamptz,
  add column if not exists first_discovered_at timestamptz;

alter table pred_events
  add constraint pred_events_domain_check check (domain is null or domain in ('WEATHER','MACRO','HOUSING','ENERGY','GEO_NATURAL','SPORTS','ELECTION_CIVIC','OTHER')),
  add constraint pred_events_model_state_check check (model_state is null or model_state in ('MARKET_MONITORING','RESEARCH','SHADOW','VALIDATED','OFFICIAL')),
  add constraint pred_events_lifecycle_check check (lifecycle is null or lifecycle in ('DISCOVERED','UPCOMING','ACTIVE','CLOSED','SETTLED'));

create unique index if not exists pred_events_venue_event_idx on pred_events (venue, venue_event_id) where venue_event_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Normalized contracts: the exact resolution semantics we model. Append-only: if the venue changes
-- the rules text, a new contract row (new rules hash) is written; the old one is never edited.
create table if not exists pred_contracts (
  contract_id text primary key,
  event_id text not null references pred_events(event_id),
  venue text not null,
  market_id text not null,
  venue_event_id text,
  venue_series_id text,
  normalizer_version text not null,
  rules_sha256 text not null,
  rules_primary text,
  rules_secondary text,
  normalization_status text not null,
  status_reason text,
  domain text not null,
  event_type text,
  subject text,
  comparator text,
  threshold_low numeric,
  threshold_high numeric,
  units text,
  location jsonb,
  station_id text,
  station_source text,
  observation_start timestamptz,
  observation_end timestamptz,
  timezone text,
  resolution_authority text,
  resolution_dataset text,
  verification_dataset text,
  measurement_definition text,
  rounding_rule text,
  exceptions jsonb not null default '[]'::jsonb,
  yes_condition text,
  no_condition text,
  outcome_label text,
  close_time timestamptz,
  expected_settlement_time timestamptz,
  detail jsonb not null default '{}'::jsonb,
  normalized_at timestamptz not null,
  inserted_at timestamptz not null default now(),
  constraint pred_contracts_status_check check (normalization_status in ('NORMALIZED','UNMODELABLE','HOLD_RESOLUTION_AMBIGUOUS','UNSUPPORTED_DOMAIN')),
  constraint pred_contracts_domain_check check (domain in ('WEATHER','MACRO','HOUSING','ENERGY','GEO_NATURAL','SPORTS','ELECTION_CIVIC','OTHER')),
  constraint pred_contracts_reason_required check (normalization_status = 'NORMALIZED' or status_reason is not null),
  constraint pred_contracts_window_order check (observation_start is null or observation_end is null or observation_start < observation_end)
);

create index if not exists pred_contracts_market_idx on pred_contracts (venue, market_id, normalized_at desc);
create index if not exists pred_contracts_event_idx on pred_contracts (event_id);
create index if not exists pred_contracts_status_idx on pred_contracts (normalization_status, domain);

create trigger pred_contracts_no_update
before update or delete on pred_contracts
for each row execute function pred_reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Venue (market) observations: explicit quote fields beside the existing raw jsonb.
alter table pred_venue_snapshots
  add column if not exists contract_id text references pred_contracts(contract_id),
  add column if not exists no_bid numeric(10,9),
  add column if not exists no_ask numeric(10,9),
  add column if not exists last_price numeric(10,9),
  add column if not exists volume_24h numeric,
  add column if not exists market_status text,
  add column if not exists lifecycle text,
  add column if not exists close_time timestamptz,
  add column if not exists source_updated_at timestamptz,
  add column if not exists normalizer text;

alter table pred_venue_snapshots
  add constraint pred_venue_lifecycle_check check (lifecycle is null or lifecycle in ('DISCOVERED','UPCOMING','ACTIVE','CLOSED','SETTLED'));

create index if not exists pred_venue_snapshots_contract_idx on pred_venue_snapshots (contract_id, captured_at desc);

-- ---------------------------------------------------------------------------------------------
-- Forecasts: PBE probability (probability) and market probability stored side by side, never blended.
alter table pred_forecasts
  add column if not exists contract_id text references pred_contracts(contract_id),
  add column if not exists market_id text,
  add column if not exists market_probability numeric(10,9),
  add column if not exists market_snapshot_key text,
  add column if not exists market_observed_at timestamptz,
  add column if not exists data_cutoff_at timestamptz,
  add column if not exists model_state text,
  add column if not exists confidence text,
  add column if not exists features_sha256 text,
  add column if not exists revision_of uuid references pred_forecasts(forecast_id),
  add column if not exists revision_reason text;

alter table pred_forecasts
  add column if not exists divergence_points numeric generated always as (
    case when market_probability is null then null else round((probability - market_probability) * 100, 1) end
  ) stored;

alter table pred_forecasts
  add constraint pred_forecasts_market_probability_check check (market_probability is null or (market_probability >= 0 and market_probability <= 1)),
  add constraint pred_forecasts_market_before_capture check (market_observed_at is null or market_observed_at <= captured_at),
  add constraint pred_forecasts_cutoff_before_capture check (data_cutoff_at is null or data_cutoff_at <= captured_at),
  add constraint pred_forecasts_model_state_check check (model_state is null or model_state in ('RESEARCH','SHADOW','VALIDATED','OFFICIAL')),
  add constraint pred_forecasts_confidence_check check (confidence is null or confidence in ('HIGH','MEDIUM','LOW')),
  add constraint pred_forecasts_revision_reason check (revision_of is null or revision_reason is not null);

create index if not exists pred_forecasts_contract_idx on pred_forecasts (contract_id, captured_at desc);

-- ---------------------------------------------------------------------------------------------
-- Scoring designations: which forecast counts is fixed by rule, once, before the outcome is known.
create table if not exists pred_forecast_designations (
  designation_id uuid primary key default gen_random_uuid(),
  contract_id text not null references pred_contracts(contract_id),
  model_id text not null,
  designation text not null,
  forecast_id uuid not null references pred_forecasts(forecast_id),
  rule_version text not null,
  reference_time timestamptz,
  designated_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  constraint pred_designation_check check (designation in ('FIRST_PUBLISHED','T_MINUS_24H','FINAL_PRE_RESOLUTION')),
  constraint pred_designation_unique unique (contract_id, model_id, designation)
);

create trigger pred_forecast_designations_no_update
before update or delete on pred_forecast_designations
for each row execute function pred_reject_mutation();

-- A designation may only point at a forecast for the same contract/model that existed before resolution.
create or replace function pred_designation_consistent()
returns trigger
language plpgsql
as $$
declare f record;
begin
  select contract_id, model_id, captured_at into f from pred_forecasts where forecast_id = new.forecast_id;
  if f.contract_id is distinct from new.contract_id or f.model_id is distinct from new.model_id then
    raise exception 'designation % points at forecast % of a different contract/model', new.designation, new.forecast_id;
  end if;
  if exists (select 1 from pred_resolutions r where r.contract_id = new.contract_id and r.resolved_at <= f.captured_at) then
    raise exception 'designation % cannot use a forecast captured after resolution', new.designation;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Resolutions: official source and venue settlement recorded independently.
alter table pred_resolutions
  add column if not exists contract_id text references pred_contracts(contract_id),
  add column if not exists market_id text,
  add column if not exists official_outcome text,
  add column if not exists official_value numeric,
  add column if not exists official_units text,
  add column if not exists official_source text,
  add column if not exists official_observation_key text,
  add column if not exists venue_result text,
  add column if not exists venue_settlement_value numeric,
  add column if not exists venue_expiration_value text,
  add column if not exists venue_settled_at timestamptz,
  add column if not exists sources_agree boolean;

alter table pred_resolutions
  add constraint pred_resolutions_official_outcome_check check (official_outcome is null or official_outcome in ('YES','NO','VOID')),
  add constraint pred_resolutions_venue_result_check check (venue_result is null or venue_result in ('yes','no','void','scalar'));

create index if not exists pred_resolutions_contract_idx on pred_resolutions (contract_id, resolved_at desc);

create trigger pred_forecast_designations_consistent
before insert on pred_forecast_designations
for each row execute function pred_designation_consistent();

-- ---------------------------------------------------------------------------------------------
-- Scores: PBE and market scored on the same designated snapshot; idempotent per designation.
alter table pred_scores
  add column if not exists contract_id text references pred_contracts(contract_id),
  add column if not exists designation text,
  add column if not exists market_probability numeric(10,9),
  add column if not exists outcome smallint;

alter table pred_scores
  add constraint pred_scores_designation_check check (designation is null or designation in ('FIRST_PUBLISHED','T_MINUS_24H','FINAL_PRE_RESOLUTION')),
  add constraint pred_scores_outcome_check check (outcome is null or outcome in (0,1));

create unique index if not exists pred_scores_designation_unique
  on pred_scores (forecast_id, resolution_id, scoring_method, designation) where designation is not null;

-- ---------------------------------------------------------------------------------------------
alter table pred_contracts enable row level security;
alter table pred_forecast_designations enable row level security;

comment on table pred_contracts is 'Append-only normalized venue contracts: exact resolution semantics (station, window, authority) or a machine-readable UNMODELABLE/HOLD reason.';
comment on table pred_forecast_designations is 'Append-only, rule-fixed scoring snapshots (FIRST_PUBLISHED, T_MINUS_24H, FINAL_PRE_RESOLUTION) chosen before resolution.';
comment on column pred_forecasts.probability is 'Independent PBE model probability of YES. Never derived from market data.';
comment on column pred_forecasts.market_probability is 'Venue-implied probability of YES observed at or before captured_at. Benchmark only; never a model input.';

commit;
