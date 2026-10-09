-- 016: PBE Signal 10 FORWARD PAPER account (owner build order, issue #52, 2026-10-09). ADDITIVE ONLY.
-- Simulated $10,000 paper account. No real money, no brokerage, no orders anywhere. Nothing here is public: RLS on, no
-- policies, service role only; the Worker serves members through requireAllAccess.
--   pred_s10_runs       idempotency claims (OPEN:<date>, EOD:<date>). A run writes only after its claim row inserts.
--   pred_s10_events     append-only, hash-chained ledger (FUNDING, ORDER, FILL, DIVIDEND, SPLIT, DECISION, RANK_SNAPSHOT,
--                       EOD_MARK, STATE, ...). origin is pinned to FORWARD_PAPER: historical replay rows can never land here.
--   pred_s10_snapshots  the frozen daily rank snapshot per model version and date (never regenerated).
--   pred_s10_marks      persisted NAV marks: EOD_CLOSE and INTRADAY (5-minute buckets) with per-quote source timestamps.

begin;

create table pred_s10_runs (
  run_key text primary key check (run_key ~ '^(OPEN|EOD):\d{4}-\d{2}-\d{2}(#\d+)?$'),
  account text not null,
  kind text not null check (kind in ('OPEN', 'EOD')),
  d date not null,
  worker_version text,
  claimed_at timestamptz not null default now()
);

create table pred_s10_events (
  event_key text primary key,
  account text not null,
  origin text not null check (origin = 'FORWARD_PAPER'),
  seq integer not null check (seq > 0),
  type text not null,
  d date not null,
  payload jsonb not null,
  model_version text not null,
  policy_version text not null,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  inserted_at timestamptz not null default now(),
  constraint pred_s10_events_seq unique (account, seq),
  constraint pred_s10_events_key check (event_key = account || ':' || seq::text)
);
create index pred_s10_events_type_idx on pred_s10_events (account, type, seq desc);
create index pred_s10_events_d_idx on pred_s10_events (account, d);

create table pred_s10_snapshots (
  snapshot_key text primary key,
  d date not null,
  model_version text not null,
  origin text not null check (origin = 'FORWARD_PAPER'),
  frozen_at timestamptz not null,
  data_cutoff text not null,
  eligible integer not null,
  excluded jsonb not null default '{}'::jsonb,
  ranks jsonb not null,
  held_ranks jsonb not null default '[]'::jsonb,
  regime jsonb,
  members jsonb not null,
  source_digest jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  inserted_at timestamptz not null default now(),
  constraint pred_s10_snapshots_unique unique (model_version, d)
);

create table pred_s10_marks (
  mark_key text primary key,
  account text not null,
  d date not null,
  kind text not null check (kind in ('EOD_CLOSE', 'INTRADAY')),
  observed_at timestamptz not null,
  nav_cents bigint,                 -- NULL when coverage < 1 (partial marks never claim a complete NAV)
  cash_cents bigint not null check (cash_cents >= 0),
  coverage numeric not null check (coverage >= 0 and coverage <= 1),
  positions jsonb not null,
  benchmarks jsonb,
  inserted_at timestamptz not null default now()
);
create index pred_s10_marks_d_idx on pred_s10_marks (account, d, observed_at);

do $$ declare t text; begin
  foreach t in array array['pred_s10_runs', 'pred_s10_events', 'pred_s10_snapshots', 'pred_s10_marks'] loop
    execute format('create trigger %I before update or delete on %I for each row execute function pred_reject_mutation()', t || '_no_update', t);
    execute format('create trigger %I before truncate on %I for each statement execute function pred_reject_mutation()', t || '_no_truncate', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

comment on table pred_s10_events is 'Signal 10 FORWARD_PAPER hash-chained append-only ledger. Simulated paper account; not real trading.';
comment on table pred_s10_snapshots is 'Signal 10 frozen daily rank snapshots (one per model version and date). Never regenerated.';
comment on table pred_s10_marks is 'Signal 10 persisted NAV marks with source quote timestamps; partial coverage stored with NULL nav.';
comment on table pred_s10_runs is 'Signal 10 run idempotency claims.';

commit;
