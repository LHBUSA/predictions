-- Rollback for 003_newsroom_v1 (drops only the three newsroom tables; export them first if they hold records).
begin;
drop trigger if exists pred_newsroom_transitions_publish_guard on pred_newsroom_transitions;
drop trigger if exists pred_newsroom_transitions_no_update on pred_newsroom_transitions;
drop trigger if exists pred_newsroom_stories_no_update on pred_newsroom_stories;
drop trigger if exists pred_cycle_diagnostics_no_update on pred_cycle_diagnostics;
drop function if exists pred_newsroom_publish_guard();
drop table if exists pred_newsroom_transitions;
drop table if exists pred_newsroom_stories;
drop table if exists pred_cycle_diagnostics;
commit;
