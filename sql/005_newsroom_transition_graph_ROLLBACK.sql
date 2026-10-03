-- Rollback for 005: restore the 003 publish-only guard (seq column kept; harmless).
begin;
drop trigger if exists pred_newsroom_transitions_graph_guard on pred_newsroom_transitions;
drop function if exists pred_newsroom_transition_guard();
create or replace function pred_newsroom_publish_guard()
returns trigger
language plpgsql
as $$
declare prior text;
begin
  if new.state = 'PUBLISHED' then
    select state into prior from pred_newsroom_transitions where story_id = new.story_id order by seq desc limit 1;
    if prior is distinct from 'VALIDATED' then
      raise exception 'newsroom: % cannot be PUBLISHED from state %', new.story_id, coalesce(prior, 'none');
    end if;
  end if;
  return new;
end;
$$;
create trigger pred_newsroom_transitions_publish_guard before insert on pred_newsroom_transitions for each row execute function pred_newsroom_publish_guard();
commit;
