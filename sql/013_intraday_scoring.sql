-- 013: intraday scoring ledger (designation-intraday/1). Sprint 2026-10-07, Phase 1.
-- ADDITIVE ONLY: two new append-only tables. No existing table, constraint, trigger or row is touched.
-- Intraday (*-intraday) forecasts never take designation/1 (pred_forecast_designations) and are never written to
-- pred_scores, so the pre-window track record cannot be contaminated. Their designations and scores live here.
-- Rule (src/engine/intraday-designations.js, FROZEN):
--   WINDOW_OPEN    = standing forecast at observation_start + 2 h
--   MIDDAY_LOCAL   = standing forecast at observation_start + 12 h
--   FINAL_INTRADAY = latest forecast captured strictly before min(observation_end, resolved_at)
-- The DB re-checks the rule: the designated row must be the NEWEST live row of the same contract/model/version
-- captured inside the window at/before (strictly before, for FINAL) the reference time.
-- Market columns are BENCHMARK ONLY (attached at scoring); nothing here feeds a model.
-- No anon/authenticated policies (RLS on): internal/admin only, never public.

begin;

create table pred_intraday_designations (
  designation_key text primary key,                       -- contract|model@version|DESIGNATION
  contract_id text not null references pred_contracts(contract_id),
  model_id text not null check (model_id ~ '-intraday$'),
  model_version text not null,
  designation text not null check (designation in ('WINDOW_OPEN', 'MIDDAY_LOCAL', 'FINAL_INTRADAY')),
  forecast_id uuid not null references pred_forecasts(forecast_id),
  rule_version text not null check (rule_version = 'designation-intraday/1'),
  reference_time timestamptz not null,
  forecast_captured_at timestamptz not null,
  designated_at timestamptz not null default now(),
  backfilled boolean not null default false,
  detail jsonb not null default '{}'::jsonb,
  constraint pred_intraday_designation_unique unique (contract_id, model_id, model_version, designation),
  constraint pred_intraday_designation_time check (forecast_captured_at <= reference_time and reference_time <= designated_at)
);
create index pred_intraday_designations_contract_idx on pred_intraday_designations (contract_id);

create or replace function pred_intraday_designation_consistent()
returns trigger language plpgsql as $$
declare f record; c record;
begin
  select contract_id, model_id, model_version, record_type, captured_at into f from pred_forecasts where forecast_id = new.forecast_id;
  select observation_start, observation_end into c from pred_contracts where contract_id = new.contract_id;
  if f.contract_id is distinct from new.contract_id or f.model_id is distinct from new.model_id or f.model_version is distinct from new.model_version then
    raise exception 'intraday designation % points at forecast % of a different contract/model/version', new.designation_key, new.forecast_id;
  end if;
  if f.record_type is distinct from 'live' then raise exception 'intraday designation % must point at a live row', new.designation_key; end if;
  if f.captured_at is distinct from new.forecast_captured_at then raise exception 'intraday designation % misstates captured_at', new.designation_key; end if;
  if f.captured_at < c.observation_start then raise exception 'intraday designation % uses a pre-window row', new.designation_key; end if;
  if new.designation = 'FINAL_INTRADAY' and f.captured_at >= new.reference_time then
    raise exception 'FINAL_INTRADAY % must be captured strictly before its reference', new.designation_key;
  end if;
  if new.designation = 'WINDOW_OPEN' and new.reference_time is distinct from c.observation_start + interval '2 hours'
     or new.designation = 'MIDDAY_LOCAL' and new.reference_time is distinct from c.observation_start + interval '12 hours'
     or new.designation = 'FINAL_INTRADAY' and new.reference_time > c.observation_end then
    raise exception 'intraday designation % has a reference time outside the frozen rule', new.designation_key;
  end if;
  if exists (select 1 from pred_forecasts g where g.contract_id = new.contract_id and g.model_id = new.model_id and g.model_version = new.model_version
               and g.record_type = 'live' and g.captured_at > f.captured_at
               and (g.captured_at < new.reference_time or (new.designation <> 'FINAL_INTRADAY' and g.captured_at = new.reference_time))) then
    raise exception 'intraday designation % is not the standing forecast at its reference time', new.designation_key;
  end if;
  return new;
end $$;

create trigger pred_intraday_designations_consistent before insert on pred_intraday_designations
for each row execute function pred_intraday_designation_consistent();
create trigger pred_intraday_designations_no_update before update or delete on pred_intraday_designations
for each row execute function pred_reject_mutation();
create trigger pred_intraday_designations_no_truncate before truncate on pred_intraday_designations
for each statement execute function pred_reject_mutation();

create table pred_intraday_scores (
  score_key text primary key,                             -- designation_key|scoring_method
  designation_key text not null references pred_intraday_designations(designation_key),
  forecast_id uuid not null references pred_forecasts(forecast_id),
  resolution_id uuid not null references pred_resolutions(resolution_id),
  contract_id text not null references pred_contracts(contract_id),
  model_id text not null,
  model_version text not null,
  designation text not null check (designation in ('WINDOW_OPEN', 'MIDDAY_LOCAL', 'FINAL_INTRADAY')),
  scoring_method text not null check (scoring_method in ('brier', 'log_loss')),
  pbe_probability numeric not null check (pbe_probability >= 0 and pbe_probability <= 1),
  outcome smallint not null check (outcome in (0, 1)),
  score double precision not null,
  benchmark_state text not null check (benchmark_state in ('VALID', 'NO_MARKET_PRICE', 'MARKET_AFTER_FORECAST', 'MARKET_NOT_ACTIVE', 'MARKET_FEED_UNVERIFIED')),
  market_probability numeric,
  market_observed_at timestamptz,
  benchmark_score double precision,
  improvement double precision,
  station_id text,
  station_group text,
  climate_date date,
  local_cutoff text,
  hour_bucket text,
  calibration_bucket text,
  quality_state text not null,
  data_quality jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  scored_at timestamptz not null default now(),
  constraint pred_intraday_scores_unique unique (designation_key, scoring_method),
  constraint pred_intraday_scores_benchmark check ((benchmark_state = 'VALID') = (benchmark_score is not null and market_probability is not null))
);
create index pred_intraday_scores_model_idx on pred_intraday_scores (model_id, model_version, designation);

create or replace function pred_intraday_score_consistent()
returns trigger language plpgsql as $$
declare d record; r record; f record;
begin
  select contract_id, forecast_id, model_id, model_version, designation into d from pred_intraday_designations where designation_key = new.designation_key;
  select contract_id, venue_result into r from pred_resolutions where resolution_id = new.resolution_id;
  select probability into f from pred_forecasts where forecast_id = new.forecast_id;
  if d.forecast_id is distinct from new.forecast_id or d.contract_id is distinct from new.contract_id or d.model_id is distinct from new.model_id
     or d.model_version is distinct from new.model_version or d.designation is distinct from new.designation then
    raise exception 'intraday score % does not restate its designation', new.score_key;
  end if;
  if r.contract_id is distinct from new.contract_id or r.venue_result not in ('yes', 'no') or new.outcome <> (case when r.venue_result = 'yes' then 1 else 0 end) then
    raise exception 'intraday score % outcome does not match the stored resolution', new.score_key;
  end if;
  if f.probability is distinct from new.pbe_probability then raise exception 'intraday score % misstates the PBE probability', new.score_key; end if;
  return new;
end $$;

create trigger pred_intraday_scores_consistent before insert on pred_intraday_scores
for each row execute function pred_intraday_score_consistent();
create trigger pred_intraday_scores_no_update before update or delete on pred_intraday_scores
for each row execute function pred_reject_mutation();
create trigger pred_intraday_scores_no_truncate before truncate on pred_intraday_scores
for each statement execute function pred_reject_mutation();

alter table pred_intraday_designations enable row level security;
alter table pred_intraday_scores enable row level security;
revoke truncate on pred_intraday_designations, pred_intraday_scores from anon, authenticated;

comment on table pred_intraday_designations is 'Append-only designation-intraday/1 snapshots (WINDOW_OPEN, MIDDAY_LOCAL, FINAL_INTRADAY) for *-intraday live rows. Separate from designation/1.';
comment on table pred_intraday_scores is 'Append-only intraday scores (Brier, log loss) per designation; market columns are a same-time benchmark only, never a model input.';

commit;
