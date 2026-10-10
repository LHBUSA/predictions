-- 017: PBE Market Tape IEX HIST collector checkpoints (issue #56; owner approved 2026-10-10).
-- ONE MUTABLE operational row per trading session (like pred_engine_lease): the resumable decoder's exact resume point
-- (compressed byte + bit offset, last 32 KiB of output, parser state) so a ~38 GB next-day IEX TOPS file is processed in
-- short one-minute Worker steps. NOT a ledger: the immutable results are the iex:TOPS:* rows in pred_source_observations.
-- A row is claimed by an atomic lease (pred_market_tape_claim) so two steps never decode the same session at once.
begin;

create table if not exists pred_market_tape_jobs (
  session_date date primary key,
  feed text not null default 'TOPS' check (feed = 'TOPS'),
  file_link text not null,
  file_size bigint not null check (file_size > 0),
  file_version text,
  status text not null default 'RUNNING' check (status in ('RUNNING', 'DONE', 'FAILED')),
  byte_offset bigint not null default 0 check (byte_offset >= 0),
  bit_offset smallint not null default 0 check (bit_offset between 0 and 7),
  window_b64 text,
  parser_state jsonb,
  symbols text[] not null default '{}',
  steps integer not null default 0 check (steps >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  decompressed_bytes bigint not null default 0 check (decompressed_bytes >= 0),
  rows_written integer,
  lease_holder text,
  lease_until timestamptz,
  last_error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Atomic claim: succeeds only when the job is RUNNING and its lease is free or expired. Returns the claimed row (or none).
create or replace function pred_market_tape_claim(p_session date, p_holder text, p_ttl_seconds integer)
returns setof pred_market_tape_jobs
language sql
as $$
  update pred_market_tape_jobs
     set lease_holder = p_holder, lease_until = now() + make_interval(secs => p_ttl_seconds), updated_at = now()
   where session_date = p_session and status = 'RUNNING' and (lease_until is null or lease_until < now())
  returning *;
$$;

alter table pred_market_tape_jobs enable row level security; -- service role only (no anon/auth policies)

commit;
