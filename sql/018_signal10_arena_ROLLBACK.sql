-- ROLLBACK for 018. Stop the challenger lane first (SIGNAL10_ARENA != "true"). EXPORT pred_s10a_* first: the challenger
-- ledgers are permanent evidence and are lost by this rollback. The control (pred_s10_*) is not touched.
-- The append-only triggers block TRUNCATE/DELETE but not DROP TABLE (which removes the triggers with the table).
begin;
drop table if exists pred_s10a_marks;
drop table if exists pred_s10a_snapshots;
drop table if exists pred_s10a_events;
drop table if exists pred_s10a_runs;
commit;
