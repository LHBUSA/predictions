-- 003 — Automated Newsroom V1 (additive). Three new append-only tables; nothing existing is altered.
--   pred_newsroom_stories      one immutable row per story: deterministic id, unique trigger (dedupe), cutoff, evidence ids
--   pred_newsroom_transitions  append-only editorial state log CANDIDATE → EVIDENCE_READY → GENERATED → VALIDATED → PUBLISHED | HELD
--                              a PUBLISHED transition is rejected unless the story's latest prior state is VALIDATED
--   pred_cycle_diagnostics     append-only record of skipped publications (expected input unavailable → skip, never substitute)
begin;

create table if not exists pred_newsroom_stories (
  story_id text primary key,
  story_class text not null check (story_class in ('RESOLUTION_REPORT','FORECAST_MOVER','FORECAST_PREVIEW','EVENT_CALENDAR','MODEL_REVIEW','ANOMALY_REVIEW')),
  trigger_key text not null unique,
  slug text not null unique,
  event_ids text[] not null default '{}',
  story_cutoff timestamptz not null,
  evidence jsonb not null,
  rules_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists pred_newsroom_transitions (
  transition_id uuid primary key default gen_random_uuid(),
  story_id text not null references pred_newsroom_stories(story_id),
  state text not null check (state in ('CANDIDATE','EVIDENCE_READY','GENERATED','VALIDATED','PUBLISHED','HELD')),
  reason text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists pred_newsroom_transitions_story_idx on pred_newsroom_transitions (story_id, at desc);
create unique index if not exists pred_newsroom_one_publication on pred_newsroom_transitions (story_id) where state = 'PUBLISHED';

create table if not exists pred_cycle_diagnostics (
  diag_id uuid primary key default gen_random_uuid(),
  cycle_at timestamptz not null,
  kind text not null check (kind in ('FORECAST_SKIP','ANOMALY_FLAG')),
  scope text not null,
  reason text not null,
  contracts integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now()
);
create index if not exists pred_cycle_diagnostics_at_idx on pred_cycle_diagnostics (cycle_at desc);

-- A failed or unvalidated story can never reach PUBLISHED.
create or replace function pred_newsroom_publish_guard()
returns trigger
language plpgsql
as $$
declare prior text;
begin
  if new.state = 'PUBLISHED' then
    select state into prior from pred_newsroom_transitions where story_id = new.story_id order by at desc, transition_id desc limit 1;
    if prior is distinct from 'VALIDATED' then
      raise exception 'newsroom: % cannot be PUBLISHED from state %', new.story_id, coalesce(prior, 'none');
    end if;
  end if;
  return new;
end;
$$;

create trigger pred_newsroom_transitions_publish_guard before insert on pred_newsroom_transitions for each row execute function pred_newsroom_publish_guard();
create trigger pred_newsroom_stories_no_update before update or delete on pred_newsroom_stories for each row execute function pred_reject_mutation();
create trigger pred_newsroom_transitions_no_update before update or delete on pred_newsroom_transitions for each row execute function pred_reject_mutation();
create trigger pred_cycle_diagnostics_no_update before update or delete on pred_cycle_diagnostics for each row execute function pred_reject_mutation();

alter table pred_newsroom_stories enable row level security;
alter table pred_newsroom_transitions enable row level security;
alter table pred_cycle_diagnostics enable row level security;

commit;
