-- ROLLBACK for 011_engine_runs. Set ENGINE_RUNS="false" on pbe-predictions (deployed) first: with it off the scheduler
-- runs the core engine without a lease or heartbeat (the pre-011 behaviour). Destroys the run history; export first
-- if it must be kept: copy (select * from pred_engine_runs) to ...
begin;
drop function if exists pred_engine_claim(text, text, integer);
drop function if exists pred_engine_release(text, text);
drop table if exists pred_engine_lease;
drop table if exists pred_engine_runs;
delete from supabase_migrations.schema_migrations where name = 'engine_runs_v1';
commit;
