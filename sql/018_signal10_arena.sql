-- 018: PBE Signal 10 STRATEGY ARENA challenger paper accounts (issue #62). ADDITIVE ONLY: new tables; nothing in
-- pred_s10_* (the ORIGINAL / CONTROL account, sql/016) is altered, constrained or read by these objects.
-- Simulated $10,000 paper accounts. No real money, no brokerage, no orders anywhere. RLS on with no policies: service role
-- only; the Worker serves members through requireAllAccess.
--   pred_s10a_runs       account-scoped idempotency claims: <ACCOUNT>:<OPEN|EOD>:<date>[#n]
--   pred_s10a_events     append-only hash-chained ledgers, one chain per account; origin pinned to ARENA_FORWARD_PAPER;
--                        every row carries the preregistered policy sha256
--   pred_s10a_snapshots  frozen daily rank snapshot per challenger model and date (never regenerated)
--   pred_s10a_marks      EOD NAV marks with exposures; NULL nav when any holding could not be marked (NOT AVAILABLE)

begin;

create table pred_s10a_runs (
  run_key text primary key check (run_key ~ '^S10-ARENA-(TECH|DIV)-\d+:(OPEN|EOD):\d{4}-\d{2}-\d{2}(#\d+)?$'),
  account text not null check (account ~ '^S10-ARENA-(TECH|DIV)-\d+$'),
  kind text not null check (kind in ('OPEN', 'EOD')),
  d date not null,
  worker_version text,
  claimed_at timestamptz not null default now(),
  constraint pred_s10a_runs_account check (run_key like account || ':' || kind || ':%')
);

create table pred_s10a_events (
  event_key text primary key,
  account text not null check (account ~ '^S10-ARENA-(TECH|DIV)-\d+$'),
  origin text not null check (origin = 'ARENA_FORWARD_PAPER'),
  strategy text not null check (strategy in ('TECH', 'DIVERSIFIED')),
  seq integer not null check (seq > 0),
  type text not null,
  d date not null,
  payload jsonb not null,
  model_version text not null,
  policy_version text not null,
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  inserted_at timestamptz not null default now(),
  constraint pred_s10a_events_seq unique (account, seq),
  constraint pred_s10a_events_key check (event_key = account || ':' || seq::text),
  constraint pred_s10a_events_strategy check ((strategy = 'TECH') = (account like 'S10-ARENA-TECH-%'))
);
create index pred_s10a_events_type_idx on pred_s10a_events (account, type, seq desc);
create index pred_s10a_events_d_idx on pred_s10a_events (account, d);

create table pred_s10a_snapshots (
  snapshot_key text primary key,
  account text not null check (account ~ '^S10-ARENA-(TECH|DIV)-\d+$'),
  d date not null,
  model_version text not null,
  origin text not null check (origin = 'ARENA_FORWARD_PAPER'),
  frozen_at timestamptz not null,
  data_cutoff text not null,
  eligible integer not null,
  excluded jsonb not null default '{}'::jsonb,
  ranks jsonb not null,
  regime jsonb,
  metals jsonb not null default '[]'::jsonb,
  members jsonb not null,
  classification jsonb not null,
  source_digest jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  inserted_at timestamptz not null default now(),
  constraint pred_s10a_snapshots_unique unique (model_version, d)
);

create table pred_s10a_marks (
  mark_key text primary key,
  account text not null check (account ~ '^S10-ARENA-(TECH|DIV)-\d+$'),
  d date not null,
  kind text not null check (kind = 'EOD_CLOSE'),
  observed_at timestamptz not null,
  nav_cents bigint,                 -- NULL = NOT AVAILABLE (a holding had no observed close)
  cash_cents bigint not null check (cash_cents >= 0),
  coverage numeric not null check (coverage >= 0 and coverage <= 1),
  positions jsonb not null,
  exposures jsonb not null,
  benchmarks jsonb,
  inserted_at timestamptz not null default now(),
  constraint pred_s10a_marks_key check (mark_key = account || ':EOD:' || d::text)
);
create index pred_s10a_marks_d_idx on pred_s10a_marks (account, d);

do $$ declare t text; begin
  foreach t in array array['pred_s10a_runs', 'pred_s10a_events', 'pred_s10a_snapshots', 'pred_s10a_marks'] loop
    execute format('create trigger %I before update or delete on %I for each row execute function pred_reject_mutation()', t || '_no_update', t);
    execute format('create trigger %I before truncate on %I for each statement execute function pred_reject_mutation()', t || '_no_truncate', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

comment on table pred_s10a_events is 'Signal 10 Strategy Arena challenger ledgers (one hash chain per account). Simulated paper; not real trading.';
comment on table pred_s10a_snapshots is 'Signal 10 Strategy Arena frozen daily rank snapshots per challenger model and date.';
comment on table pred_s10a_marks is 'Signal 10 Strategy Arena EOD NAV marks with exposures; NULL nav = NOT AVAILABLE.';
comment on table pred_s10a_runs is 'Signal 10 Strategy Arena account-scoped run claims.';

commit;
