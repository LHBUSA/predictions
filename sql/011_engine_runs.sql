-- 011: engine run ledger + atomic engine lease (owner 2026-10-04, Predictions Phases 2-3).
--
-- pred_engine_runs: APPEND-ONLY run transitions (STARTED -> COMPLETED | FAILED, or a lone SKIPPED_OVERLAP) for each
-- scheduled lane run. /api/summary.last_engine_cycle comes from the latest COMPLETED core run, not
-- pred_events.updated_at. Row-level update/delete and TRUNCATE are rejected by pred_reject_mutation() (sql/001).
--
-- pred_engine_lease: one MUTABLE row per lane (operational lock, not ledger). pred_engine_claim() is a single atomic
-- INSERT .. ON CONFLICT DO UPDATE .. WHERE (row-locked): a run claims the lane only when it is free or the previous
-- lease expired (a crashed run cannot block forever). A run that cannot claim records SKIPPED_OVERLAP and stops,
-- so two core engines never run concurrently. pred_engine_release() frees the lane only for its holder.

begin;

create table pred_engine_runs (
  transition_id bigint generated always as identity primary key,
  run_id text not null,                              -- '<lane>:<scheduled ISO>:<random>'
  lane text not null check (lane in ('core', 'newsroom')),
  transition text not null check (transition in ('STARTED', 'COMPLETED', 'FAILED', 'SKIPPED_OVERLAP')),
  scheduled_at timestamptz not null,                 -- the cron's scheduled time
  at timestamptz not null default now(),             -- when this transition happened
  cron text,                                         -- dispatching cron identity
  worker_version text,                               -- Cloudflare version id of the Worker that ran it
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  counts jsonb not null default '{}'::jsonb,         -- events, contracts, forecasts, venue_snapshots, market_requests, supabase_requests, supabase_writes, errors
  error text,
  unique (run_id, transition)
);
create index pred_engine_runs_lane_at_idx on pred_engine_runs (lane, transition, at desc);

create table pred_engine_lease (
  lane text primary key check (lane in ('core', 'newsroom')),
  holder text,                                       -- run_id holding the lane, null when free
  claimed_at timestamptz,
  expires_at timestamptz not null default now()
);

create or replace function pred_engine_claim(p_lane text, p_run_id text, p_ttl_seconds integer)
returns boolean language plpgsql as $$
declare got text;
begin
  insert into pred_engine_lease as l (lane, holder, claimed_at, expires_at)
  values (p_lane, p_run_id, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (lane) do update set holder = excluded.holder, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
    where l.holder is null or l.expires_at < now()
  returning holder into got;
  return coalesce(got = p_run_id, false);   -- no row returned = lane held by a live lease
end $$;

create or replace function pred_engine_release(p_lane text, p_run_id text)
returns boolean language plpgsql as $$
declare n integer;
begin
  update pred_engine_lease set holder = null, expires_at = now() where lane = p_lane and holder = p_run_id;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create trigger pred_engine_runs_no_update before update or delete on pred_engine_runs for each row execute function pred_reject_mutation();
create trigger pred_engine_runs_no_truncate before truncate on pred_engine_runs for each statement execute function pred_reject_mutation();
alter table pred_engine_runs enable row level security;
alter table pred_engine_lease enable row level security;
revoke truncate, update, delete on pred_engine_runs from anon, authenticated, service_role;
revoke all on pred_engine_lease from anon, authenticated;
revoke execute on function pred_engine_claim(text, text, integer) from public, anon, authenticated;
revoke execute on function pred_engine_release(text, text) from public, anon, authenticated;
grant execute on function pred_engine_claim(text, text, integer) to service_role;
grant execute on function pred_engine_release(text, text) to service_role;

commit;
