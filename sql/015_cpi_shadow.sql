-- 015: CPI V1 PRIVATE SHADOW (owner approval 2026-10-07: KXCPI, KXCPIYOY, KXCPICOREYOY; KXCPICORE stays research).
-- ADDITIVE ONLY. Nothing here is public: RLS on, no policies, service role only.
--   1. pred_macro_first_seen   append-only FIRST-SEEN source records (EIA weekly gasoline, BLS CPI releases). The first
--                              record for (source, series, period) is never rewritten; a later different value is its
--                              own row with its own observed_at (a revision), so the as-of view at any cutoff is exact.
--   2. pred_cpi_shadow_runs    one frozen forecast per (target, reference month, horizon, model version): the full
--                              discretized distribution, or NO_FORECAST with a reason. The unique key means a forecast
--                              can never be regenerated after the answer is known.
--   3. pred_cpi_shadow_grades  one grade per OK run, against the first-seen BLS release (the one-decimal value Kalshi
--                              settles on). A trigger refuses grades for runs frozen at or after publication.
--   4. pred_forecasts_shadow   per-contract CPI rows. CPI has no station or climate day, so those two NOT NULLs are
--                              relaxed for non-weather models only (weather rows still require them, CHECK below).
--                              CPI rows must reference their run and may only be a SHADOW-approved target.

begin;

create table pred_macro_first_seen (
  first_seen_id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('EIA', 'BLS')),
  series text not null,
  period text not null check (period ~ '^\d{4}-\d{2}(-\d{2})?$'),   -- EIA week date / BLS reference month
  value numeric,                                                     -- EIA $/gal; BLS headline SA m/m
  payload jsonb not null default '{}'::jsonb,                        -- BLS: the parsed release (Table A)
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null,                                  -- when PBE first fetched this content
  source_published_at timestamptz,                                   -- stated/derived publication time, if known
  source_url text not null,
  source_document_sha256 text check (source_document_sha256 is null or source_document_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version text not null,
  capture_version text not null,
  inserted_at timestamptz not null default now(),
  constraint pred_macro_first_seen_content unique (source, series, period, content_sha256)
);
create index pred_macro_first_seen_period_idx on pred_macro_first_seen (source, series, period, observed_at);
create trigger pred_macro_first_seen_no_update before update or delete on pred_macro_first_seen
for each row execute function pred_reject_mutation();
create trigger pred_macro_first_seen_no_truncate before truncate on pred_macro_first_seen
for each statement execute function pred_reject_mutation();
alter table pred_macro_first_seen enable row level security;
revoke all on pred_macro_first_seen from anon, authenticated;
comment on table pred_macro_first_seen is 'Append-only FIRST-SEEN macro source records (EIA weekly gasoline, BLS CPI releases) for prospective CPI SHADOW scoring. Never rewritten.';

create table pred_cpi_shadow_runs (
  run_id text primary key,
  model_id text not null check (model_id = 'pbe-cpi-distribution'),
  model_version text not null,
  feature_version text not null,
  adapter_version text not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  model_state text not null check (model_state = 'SHADOW'),
  public boolean not null default false check (public = false),
  target text not null check (target in ('headline_mom', 'headline_yoy', 'core_yoy')),
  kalshi_series text not null check (kalshi_series in ('KXCPI', 'KXCPIYOY', 'KXCPICOREYOY')),
  reference_month text not null check (reference_month ~ '^\d{4}-\d{2}$'),
  horizon text not null,
  release_at timestamptz not null,
  cutoff_at timestamptz not null,
  forecast_created_at timestamptz not null,
  status text not null check (status in ('OK', 'NO_FORECAST')),
  reason text,
  detail jsonb not null default '{}'::jsonb,
  features jsonb,
  input_provenance jsonb not null default '{}'::jsonb,
  inputs_observed_at jsonb not null default '{}'::jsonb,
  location double precision,
  scale double precision,
  nu double precision,
  distribution jsonb,
  median numeric,
  q10 numeric,
  q90 numeric,
  ladder jsonb,
  contracts jsonb not null default '[]'::jsonb,
  inserted_at timestamptz not null default now(),
  constraint pred_cpi_shadow_runs_once unique (target, reference_month, horizon, model_version),
  constraint pred_cpi_shadow_runs_cutoff check (cutoff_at < release_at),
  constraint pred_cpi_shadow_runs_frozen check (status <> 'OK' or (forecast_created_at >= cutoff_at and forecast_created_at < release_at)),
  constraint pred_cpi_shadow_runs_ok_complete check (status <> 'OK' or (distribution is not null and median is not null and q10 is not null and q90 is not null and ladder is not null and features is not null)),
  constraint pred_cpi_shadow_runs_no_forecast_reason check (status = 'OK' or (reason is not null and distribution is null and median is null)),
  constraint pred_cpi_shadow_runs_market_free check (features is null or pred_features_market_free(features))
);
create index pred_cpi_shadow_runs_month_idx on pred_cpi_shadow_runs (reference_month, target);
create trigger pred_cpi_shadow_runs_no_update before update or delete on pred_cpi_shadow_runs
for each row execute function pred_reject_mutation();
create trigger pred_cpi_shadow_runs_no_truncate before truncate on pred_cpi_shadow_runs
for each statement execute function pred_reject_mutation();
alter table pred_cpi_shadow_runs enable row level security;
revoke all on pred_cpi_shadow_runs from anon, authenticated;
comment on table pred_cpi_shadow_runs is 'Append-only PRIVATE CPI V1 SHADOW forecast runs (full distribution or NO_FORECAST). One per target/month/horizon/version; never regenerated.';

create table pred_cpi_shadow_grades (
  grade_id uuid primary key default gen_random_uuid(),
  run_id text not null unique references pred_cpi_shadow_runs(run_id),
  actual_value numeric not null,
  actual_first_seen_id uuid not null references pred_macro_first_seen(first_seen_id),
  actual_published_at timestamptz not null,
  graded_at timestamptz not null,
  grading_version text not null,
  scores jsonb not null,
  contract_scores jsonb not null default '[]'::jsonb,
  kalshi_cross_check jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  constraint pred_cpi_shadow_grades_after check (graded_at >= actual_published_at)
);
create or replace function pred_cpi_grade_guard()
returns trigger
language plpgsql
as $$
declare r record;
begin
  select status, forecast_created_at into r from pred_cpi_shadow_runs where run_id = new.run_id;
  if r.status is distinct from 'OK' then raise exception 'CPI grade refused: run % is not OK', new.run_id; end if;
  if r.forecast_created_at >= new.actual_published_at then raise exception 'CPI grade refused: run % was created at or after publication', new.run_id; end if;
  return new;
end;
$$;
create trigger pred_cpi_shadow_grades_guard before insert on pred_cpi_shadow_grades
for each row execute function pred_cpi_grade_guard();
create trigger pred_cpi_shadow_grades_no_update before update or delete on pred_cpi_shadow_grades
for each row execute function pred_reject_mutation();
create trigger pred_cpi_shadow_grades_no_truncate before truncate on pred_cpi_shadow_grades
for each statement execute function pred_reject_mutation();
alter table pred_cpi_shadow_grades enable row level security;
revoke all on pred_cpi_shadow_grades from anon, authenticated;
comment on table pred_cpi_shadow_grades is 'Append-only grades of CPI V1 SHADOW runs against the first-seen BLS release. Private.';

alter table pred_forecasts_shadow alter column station_id drop not null;
alter table pred_forecasts_shadow alter column climate_date drop not null;
alter table pred_forecasts_shadow add constraint pred_forecasts_shadow_weather_fields
  check (model_id not like 'pbe-weather-%' or (station_id is not null and climate_date is not null));
alter table pred_forecasts_shadow add constraint pred_forecasts_shadow_cpi_scope
  check (model_id <> 'pbe-cpi-distribution' or (metadata ? 'run_id' and metadata->>'cpi_target' in ('headline_mom', 'headline_yoy', 'core_yoy')));

commit;
