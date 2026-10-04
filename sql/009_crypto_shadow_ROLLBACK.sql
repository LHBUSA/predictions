-- ROLLBACK for 009_crypto_shadow: drops ONLY the isolated BTC SHADOW tables (no other table references them).
-- Set CRYPTO_SHADOW="false" on pbe-predictions (deployed) first, or the 1-minute cron fails its writes.
-- Destroys the shadow record collected since 009 was applied; export first if it must be kept:
--   copy (select * from pred_crypto_forecasts) to ... (and the other five tables).
begin;
drop table if exists pred_crypto_scores;
drop table if exists pred_crypto_resolutions;
drop table if exists pred_crypto_designations;
drop table if exists pred_crypto_venue_obs;
drop table if exists pred_crypto_forecasts;
drop table if exists pred_crypto_windows;
delete from supabase_migrations.schema_migrations where name = '009_crypto_shadow';
commit;
