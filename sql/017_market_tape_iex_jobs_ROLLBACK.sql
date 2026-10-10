-- ROLLBACK for 017. Stop the lane first (IEX_HIST_COLLECTOR != "true"). Only operational checkpoints are lost; the
-- collected observations (pred_source_observations iex:TOPS:*) are untouched.
begin;
drop function if exists pred_market_tape_claim(date, text, integer);
drop table if exists pred_market_tape_jobs;
commit;
