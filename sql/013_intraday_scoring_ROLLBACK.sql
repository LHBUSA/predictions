-- ROLLBACK for 013. Drops only the two intraday scoring tables (and their functions). Forecasts, pre-window
-- designations and pred_scores are untouched. Intraday designations/scores are re-derivable from the immutable
-- forecast + resolution ledger by the frozen rule.
begin;
drop table if exists pred_intraday_scores;
drop table if exists pred_intraday_designations;
drop function if exists pred_intraday_score_consistent();
drop function if exists pred_intraday_designation_consistent();
delete from supabase_migrations.schema_migrations where name = 'intraday_scoring_v1';
commit;
