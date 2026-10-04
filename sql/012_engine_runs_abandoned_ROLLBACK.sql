-- ROLLBACK for 012. Fails (by design) while any ABANDONED row exists: the append-only ledger cannot drop history.
begin;
alter table pred_engine_runs drop constraint pred_engine_runs_transition_check;
alter table pred_engine_runs add constraint pred_engine_runs_transition_check
  check (transition in ('STARTED', 'COMPLETED', 'FAILED', 'SKIPPED_OVERLAP'));
delete from supabase_migrations.schema_migrations where name = 'engine_runs_abandoned_v1';
commit;
