-- 005 — Newsroom: deterministic transition order + full editorial transition graph (DRAFT; owner approval required; numbered after 004_features_market_free_v2).
-- Fixes a defect found by the 003 production proof: the publish guard ordered transitions by (at, uuid). Rows written
-- in one transaction share now(), so ties fell to a random uuid — a false rejection in the proof, and in principle a
-- VALIDATED+HELD pair in one transaction could be read in the wrong order. 004 adds a monotonic `seq` and enforces:
--   (none) -> CANDIDATE
--   CANDIDATE -> EVIDENCE_READY | HELD        EVIDENCE_READY -> GENERATED | HELD
--   GENERATED -> VALIDATED | HELD             VALIDATED -> PUBLISHED | HELD
--   HELD -> CANDIDATE (re-detection)          PUBLISHED -> (terminal)
begin;

alter table pred_newsroom_transitions add column if not exists seq bigint;
create sequence if not exists pred_newsroom_transitions_seq owned by pred_newsroom_transitions.seq;

-- backfill existing rows in their recorded order (append-only trigger paused for this one statement only)
alter table pred_newsroom_transitions disable trigger pred_newsroom_transitions_no_update;
update pred_newsroom_transitions t set seq = o.n
  from (select transition_id, row_number() over (order by at, transition_id) as n from pred_newsroom_transitions) o
  where o.transition_id = t.transition_id;
alter table pred_newsroom_transitions enable trigger pred_newsroom_transitions_no_update;
select setval('pred_newsroom_transitions_seq', coalesce((select max(seq) from pred_newsroom_transitions), 0) + 1, false);

alter table pred_newsroom_transitions alter column seq set default nextval('pred_newsroom_transitions_seq');
alter table pred_newsroom_transitions alter column seq set not null;
create unique index if not exists pred_newsroom_transitions_seq_idx on pred_newsroom_transitions (seq);

create or replace function pred_newsroom_transition_guard()
returns trigger
language plpgsql
as $$
declare prior text;
begin
  select state into prior from pred_newsroom_transitions where story_id = new.story_id order by seq desc limit 1;
  prior := coalesce(prior, 'none'); -- never compare against NULL: NOT (NULL OR ...) is NULL and would not raise
  if not (
       (prior = 'none' and new.state = 'CANDIDATE')
    or (prior = 'CANDIDATE' and new.state in ('EVIDENCE_READY', 'HELD'))
    or (prior = 'EVIDENCE_READY' and new.state in ('GENERATED', 'HELD'))
    or (prior = 'GENERATED' and new.state in ('VALIDATED', 'HELD'))
    or (prior = 'VALIDATED' and new.state in ('PUBLISHED', 'HELD'))
    or (prior = 'HELD' and new.state = 'CANDIDATE')
  ) then
    raise exception 'newsroom: % cannot move from % to %', new.story_id, prior, new.state;
  end if;
  return new;
end;
$$;

drop trigger if exists pred_newsroom_transitions_publish_guard on pred_newsroom_transitions;
create trigger pred_newsroom_transitions_graph_guard before insert on pred_newsroom_transitions for each row execute function pred_newsroom_transition_guard();
drop function if exists pred_newsroom_publish_guard();

commit;
