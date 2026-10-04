-- 006: append-only Predictions decision ledger (pbe-decision-record/1). Owner-approved 2026-10-04.
-- One immutable row per contract for the predeclared counting unit (FINAL_PRE_RESOLUTION designated forecast),
-- written by the engine at designation time and verified against deterministic recomputation
-- (src/engine/decision-record.js). Prospective only: the ledger begins at the rain-v1-candidate freeze
-- (2026-10-04T13:21:00Z); there is no historical backfill.
-- MODEL/MARKET FIREWALL: this table has NO price / quote / venue column. Venue benchmarks stay in the venue layer and
-- join by forecast_id / contract_id afterwards.
-- NO RETROACTIVE OFFICIAL CALLS: official_at_decision is fixed at write time and must equal
-- (policy_activated_at known at decision time is not null AND decision_as_of >= policy_activated_at).

create table if not exists pred_decisions (
  decision_id uuid primary key default gen_random_uuid(),
  record_key text not null,
  record_schema text not null default 'pbe-decision-record/1',
  contract_id text not null references pred_contracts(contract_id),
  event_id text,
  forecast_id uuid not null references pred_forecasts(forecast_id),
  designation text not null,
  counting_unit text not null,
  candidate text not null,
  policy_version text not null,
  policy_status text not null,
  policy_sha256 text not null,
  policy_frozen_at timestamptz not null,
  policy_activated_at timestamptz,
  model_id text not null,
  model_version text not null,
  model_state text not null,
  probability numeric not null,
  confidence text,
  evidence_sha256 text not null,
  feature_snapshot_id text not null,
  features_sha256 text,
  data_cutoff_at timestamptz not null,
  decision_as_of timestamptz not null,
  decided_at timestamptz not null default now(),
  state text not null,
  side text,
  reasons text[] not null default '{}',
  official_at_decision boolean not null,
  correction_of uuid references pred_decisions(decision_id),
  correction_reason text,
  inserted_at timestamptz not null default now(),
  constraint pred_decisions_record_key_unique unique (record_key),
  constraint pred_decisions_designation check (designation = 'FINAL_PRE_RESOLUTION'),
  constraint pred_decisions_state check (state in ('CALL', 'PASS', 'HOLD')),
  constraint pred_decisions_side check ((state = 'CALL' and coalesce(side, '') in ('YES', 'NO')) or (state <> 'CALL' and side is null)),
  constraint pred_decisions_probability check (probability >= 0 and probability <= 1),
  constraint pred_decisions_hashes check (policy_sha256 ~ '^[0-9a-f]{64}$' and evidence_sha256 ~ '^[0-9a-f]{64}$'),
  constraint pred_decisions_official check (official_at_decision = (policy_activated_at is not null and decision_as_of >= policy_activated_at)),
  constraint pred_decisions_time_order check (data_cutoff_at <= decision_as_of and decision_as_of <= decided_at and policy_frozen_at <= decision_as_of),
  constraint pred_decisions_ledger_start check (decision_as_of >= timestamptz '2026-10-04 13:21:00+00'),
  constraint pred_decisions_correction check ((correction_of is null) = (correction_reason is null))
);

-- one original row per contract / designation / candidate / frozen policy; corrections are new rows that reference it
create unique index if not exists pred_decisions_one_original
  on pred_decisions (contract_id, designation, candidate, policy_sha256) where correction_of is null;
create index if not exists pred_decisions_candidate_idx on pred_decisions (candidate, decision_as_of);

create trigger pred_decisions_no_update
before update or delete on pred_decisions
for each row execute function pred_reject_mutation();

-- A decision row may only restate its designated forecast: same contract, model, probability, cutoff, capture time and
-- feature snapshot, and the forecast must hold that designation. A correction must reference a row of the same contract.
create or replace function pred_decision_consistent()
returns trigger
language plpgsql
as $$
declare f record; o record;
begin
  select contract_id, model_id, model_version, probability, data_cutoff_at, captured_at, feature_snapshot_id
    into f from pred_forecasts where forecast_id = new.forecast_id;
  if f.contract_id is distinct from new.contract_id or f.model_id is distinct from new.model_id or f.model_version is distinct from new.model_version
     or f.probability is distinct from new.probability or f.data_cutoff_at is distinct from new.data_cutoff_at
     or f.captured_at is distinct from new.decision_as_of or f.feature_snapshot_id is distinct from new.feature_snapshot_id then
    raise exception 'decision % does not restate its designated forecast %', new.record_key, new.forecast_id;
  end if;
  if not exists (select 1 from pred_forecast_designations d where d.forecast_id = new.forecast_id and d.designation = new.designation and d.contract_id = new.contract_id) then
    raise exception 'decision % has no % designation for forecast %', new.record_key, new.designation, new.forecast_id;
  end if;
  if new.correction_of is not null then
    select contract_id into o from pred_decisions where decision_id = new.correction_of;
    if o.contract_id is distinct from new.contract_id then
      raise exception 'correction % must reference a decision of the same contract', new.record_key;
    end if;
  end if;
  return new;
end;
$$;

create trigger pred_decisions_consistent
before insert on pred_decisions
for each row execute function pred_decision_consistent();

alter table pred_decisions enable row level security;
grant select, insert on pred_decisions to service_role;

-- TRUNCATE bypasses row triggers: block it at statement level and revoke the default grant.
create trigger pred_decisions_no_truncate
before truncate on pred_decisions
for each statement execute function pred_reject_mutation();
revoke truncate, update, delete on pred_decisions from service_role, anon, authenticated;
