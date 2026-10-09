-- ROLLBACK for 016. Stop the lane first (SIGNAL10 != "true"). EXPORT pred_s10_* first: the forward paper ledger is
-- permanent evidence and is lost by this rollback.
begin;
drop table if exists pred_s10_marks;
drop table if exists pred_s10_snapshots;
drop table if exists pred_s10_events;
drop table if exists pred_s10_runs;
commit;
