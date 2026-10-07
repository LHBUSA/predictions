-- ROLLBACK for 014: drops only the private shadow ledger. Live forecasts are untouched. Shadow history is lost (the
-- forward experiment would restart), so export it first if it has value.
begin;
drop table if exists pred_forecasts_shadow;
delete from supabase_migrations.schema_migrations where name = 'forecasts_shadow_v1';
commit;
