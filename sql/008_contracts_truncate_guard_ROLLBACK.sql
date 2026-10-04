-- ROLLBACK for 008: removes only the pred_contracts TRUNCATE guard; restores the default service_role grant.
begin;
drop trigger if exists pred_contracts_no_truncate on pred_contracts;
grant truncate on pred_contracts to service_role;
delete from supabase_migrations.schema_migrations where version = '20261004160000';
commit;
