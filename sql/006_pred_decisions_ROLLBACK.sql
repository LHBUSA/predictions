-- ROLLBACK for 006_pred_decisions. Only safe while the ledger holds no rows you need: dropping it destroys the
-- prospective record. Export first:  copy (select * from pred_decisions order by inserted_at) to stdout with csv header;
begin;
drop trigger if exists pred_decisions_consistent on pred_decisions;
drop trigger if exists pred_decisions_no_update on pred_decisions;
drop function if exists pred_decision_consistent();
drop table if exists pred_decisions;
commit;
