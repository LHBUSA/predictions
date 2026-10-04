-- ROLLBACK for 007_ledger_truncate_guard: removes only the TRUNCATE guards added by 007 (row-level update/delete
-- guards from 001/002 stay). Restores the Supabase default TRUNCATE grant to service_role.
begin;
drop trigger if exists pred_source_observations_no_truncate on pred_source_observations;
drop trigger if exists pred_feature_snapshots_no_truncate on pred_feature_snapshots;
drop trigger if exists pred_forecasts_no_truncate on pred_forecasts;
drop trigger if exists pred_venue_snapshots_no_truncate on pred_venue_snapshots;
drop trigger if exists pred_resolutions_no_truncate on pred_resolutions;
drop trigger if exists pred_scores_no_truncate on pred_scores;
drop trigger if exists pred_forecast_designations_no_truncate on pred_forecast_designations;
grant truncate on pred_source_observations, pred_feature_snapshots, pred_forecasts, pred_venue_snapshots,
  pred_resolutions, pred_scores, pred_forecast_designations to service_role;
delete from supabase_migrations.schema_migrations where version = '20261004150000';
commit;
