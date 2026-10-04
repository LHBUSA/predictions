-- ROLLBACK for 010: set CRYPTO_SETTLEMENTS="false" (deployed) first. Drops only the venue-settlement audit table
-- (nothing references it); the frozen SHADOW record (009) is untouched. Export first if it must be kept.
begin;
drop table if exists pred_crypto_venue_settlements;
delete from supabase_migrations.schema_migrations where name like '%crypto_venue_settlements%';
commit;
