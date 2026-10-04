-- 012: ABANDONED terminal transition for pred_engine_runs (owner 2026-10-04). A hard-killed invocation (CPU/resource
-- limit, isolate eviction) leaves STARTED with no terminal row. The next run of that lane that claims the lane
-- after the lease expired appends ABANDONED for it: error = 'no_terminal_before_lease_expiry', counts =
-- {detected_at, lease_expires_at, detected_by}. The original STARTED row is never updated or deleted (sql/011).
-- Only the CHECK constraint changes; no existing row is touched.
begin;
alter table pred_engine_runs drop constraint pred_engine_runs_transition_check;
alter table pred_engine_runs add constraint pred_engine_runs_transition_check
  check (transition in ('STARTED', 'COMPLETED', 'FAILED', 'SKIPPED_OVERLAP', 'ABANDONED'));
commit;
