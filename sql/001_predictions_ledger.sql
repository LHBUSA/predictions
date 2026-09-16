create extension if not exists pgcrypto;

create table if not exists pred_events (
  event_id text primary key,
  slug text unique,
  canonical_question text not null,
  category text not null,
  status text not null default 'open',
  resolution_authority text,
  resolution_rule text,
  resolution_time timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pred_source_observations (
  observation_key text primary key,
  provider text not null,
  source_id text not null,
  source_class text not null,
  observed_at timestamptz not null,
  available_at timestamptz not null,
  captured_at timestamptz not null,
  value jsonb,
  data jsonb,
  units text,
  geography jsonb,
  vintage text,
  revision text,
  provenance jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  constraint pred_source_class_check check (source_class in ('propdata','sports','official','venue','licensed','research','proprietary')),
  constraint pred_source_available_before_capture check (available_at <= captured_at)
);

create index if not exists pred_source_observations_source_idx
  on pred_source_observations (provider, source_id, captured_at desc);
create index if not exists pred_source_observations_available_idx
  on pred_source_observations (available_at desc);

create table if not exists pred_feature_snapshots (
  snapshot_id text primary key,
  event_id text not null references pred_events(event_id),
  model_id text not null,
  cutoff_at timestamptz not null,
  created_at timestamptz not null,
  features jsonb not null,
  source_classes text[] not null default '{}',
  source_observation_keys text[] not null default '{}',
  context jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now()
);

create index if not exists pred_feature_snapshots_event_idx
  on pred_feature_snapshots (event_id, cutoff_at desc);

create table if not exists pred_forecasts (
  forecast_id uuid primary key default gen_random_uuid(),
  record_id text not null unique,
  event_id text not null references pred_events(event_id),
  model_id text not null,
  model_version text not null,
  probability numeric(10,9) not null,
  captured_at timestamptz not null,
  feature_snapshot_id text references pred_feature_snapshots(snapshot_id),
  record_type text not null default 'live',
  provenance jsonb not null default '[]'::jsonb,
  explanation jsonb,
  metadata jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  constraint pred_forecast_probability_check check (probability >= 0 and probability <= 1),
  constraint pred_forecast_record_type_check check (record_type in ('live','research','retrospective_replay'))
);

create index if not exists pred_forecasts_event_idx
  on pred_forecasts (event_id, captured_at desc);
create index if not exists pred_forecasts_model_idx
  on pred_forecasts (model_id, model_version, captured_at desc);

create table if not exists pred_venue_snapshots (
  venue_snapshot_id uuid primary key default gen_random_uuid(),
  snapshot_key text not null unique,
  event_id text not null references pred_events(event_id),
  venue text not null,
  market_id text not null,
  captured_at timestamptz not null,
  probability numeric(10,9),
  bid numeric(10,9),
  ask numeric(10,9),
  volume numeric,
  open_interest numeric,
  liquidity numeric,
  raw jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  constraint pred_venue_probability_check check (probability is null or (probability >= 0 and probability <= 1))
);

create index if not exists pred_venue_snapshots_market_idx
  on pred_venue_snapshots (venue, market_id, captured_at desc);
create index if not exists pred_venue_snapshots_event_idx
  on pred_venue_snapshots (event_id, captured_at desc);

create table if not exists pred_resolutions (
  resolution_id uuid primary key default gen_random_uuid(),
  event_id text not null references pred_events(event_id),
  resolved_at timestamptz not null,
  authority text not null,
  source_url text,
  outcome jsonb not null,
  correction_of uuid references pred_resolutions(resolution_id),
  metadata jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now()
);

create index if not exists pred_resolutions_event_idx
  on pred_resolutions (event_id, resolved_at desc);

create table if not exists pred_scores (
  score_id uuid primary key default gen_random_uuid(),
  forecast_id uuid not null references pred_forecasts(forecast_id),
  resolution_id uuid not null references pred_resolutions(resolution_id),
  scoring_method text not null,
  score numeric not null,
  benchmark_score numeric,
  improvement numeric,
  details jsonb not null default '{}'::jsonb,
  scored_at timestamptz not null default now()
);

create index if not exists pred_scores_forecast_idx
  on pred_scores (forecast_id, scored_at desc);

create or replace function pred_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append-only Predictions ledger: % on % is not allowed', tg_op, tg_table_name;
end;
$$;

create trigger pred_source_observations_no_update
before update or delete on pred_source_observations
for each row execute function pred_reject_mutation();

create trigger pred_feature_snapshots_no_update
before update or delete on pred_feature_snapshots
for each row execute function pred_reject_mutation();

create trigger pred_forecasts_no_update
before update or delete on pred_forecasts
for each row execute function pred_reject_mutation();

create trigger pred_venue_snapshots_no_update
before update or delete on pred_venue_snapshots
for each row execute function pred_reject_mutation();

create trigger pred_resolutions_no_update
before update or delete on pred_resolutions
for each row execute function pred_reject_mutation();

create trigger pred_scores_no_update
before update or delete on pred_scores
for each row execute function pred_reject_mutation();

alter table pred_events enable row level security;
alter table pred_source_observations enable row level security;
alter table pred_feature_snapshots enable row level security;
alter table pred_forecasts enable row level security;
alter table pred_venue_snapshots enable row level security;
alter table pred_resolutions enable row level security;
alter table pred_scores enable row level security;

comment on table pred_source_observations is 'Append-only point-in-time source observations used by PropBetEdge Predictions.';
comment on table pred_feature_snapshots is 'Append-only model feature vectors pinned to forecast cutoffs.';
comment on table pred_forecasts is 'Immutable live, research, and retrospective forecast records.';
comment on table pred_resolutions is 'Append-only event resolutions; corrections reference prior resolution rows.';
