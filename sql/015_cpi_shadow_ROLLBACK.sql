-- ROLLBACK for 015. Stop the lane first (CPI_SHADOW != "true"). Drops only the CPI SHADOW ledgers and the CPI rows'
-- table changes. Weather shadow rows are untouched. CPI shadow history and first-seen records are lost: export first.
-- The append-only triggers block DELETE, so CPI rows in pred_forecasts_shadow are removed with the trigger disabled
-- inside this transaction only.
begin;
alter table pred_forecasts_shadow disable trigger pred_forecasts_shadow_no_update;
delete from pred_forecasts_shadow where model_id = 'pbe-cpi-distribution';
alter table pred_forecasts_shadow enable trigger pred_forecasts_shadow_no_update;
alter table pred_forecasts_shadow drop constraint if exists pred_forecasts_shadow_cpi_scope;
alter table pred_forecasts_shadow drop constraint if exists pred_forecasts_shadow_weather_fields;
alter table pred_forecasts_shadow alter column station_id set not null;
alter table pred_forecasts_shadow alter column climate_date set not null;
drop table if exists pred_cpi_shadow_grades;
drop function if exists pred_cpi_grade_guard();
drop table if exists pred_cpi_shadow_runs;
drop table if exists pred_macro_first_seen;
delete from supabase_migrations.schema_migrations where name = 'cpi_shadow_v1';
commit;
