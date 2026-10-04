-- PROOF for 011_engine_runs: run AFTER the migration in the same transaction; RAISE 'PROOF_RESULT %' aborts it, so
-- nothing persists. Also proven on PGlite (scripts/db/prove-011.mjs).
do $proof$
declare r jsonb := '{}'::jsonb;
begin
  r := r || jsonb_build_object('1_first_claim', pred_engine_claim('core', 'run-a', 600));
  r := r || jsonb_build_object('2_overlap_refused', not pred_engine_claim('core', 'run-b', 600));
  r := r || jsonb_build_object('3_foreign_release_refused', not pred_engine_release('core', 'run-b'));
  r := r || jsonb_build_object('4_holder_release', pred_engine_release('core', 'run-a'));
  r := r || jsonb_build_object('5_claim_after_release', pred_engine_claim('core', 'run-b', 600));
  update pred_engine_lease set expires_at = now() - interval '1 second' where lane = 'core';
  r := r || jsonb_build_object('6_expired_lease_reclaimable', pred_engine_claim('core', 'run-c', 600));
  r := r || jsonb_build_object('7_lanes_independent', pred_engine_claim('newsroom', 'run-n', 600));

  insert into pred_engine_runs (run_id, lane, transition, scheduled_at, worker_version) values ('run-c', 'core', 'STARTED', now(), 'v');
  insert into pred_engine_runs (run_id, lane, transition, scheduled_at, duration_ms, counts) values ('run-c', 'core', 'COMPLETED', now(), 1234, '{"forecasts":3}');
  r := r || '{"8_transitions_written": true}';
  begin
    insert into pred_engine_runs (run_id, lane, transition, scheduled_at) values ('run-c', 'core', 'COMPLETED', now());
    r := r || '{"9_duplicate_transition_refused": false}';
  exception when unique_violation then r := r || '{"9_duplicate_transition_refused": true}';
  end;
  begin
    update pred_engine_runs set duration_ms = 1 where run_id = 'run-c';
    r := r || '{"10_update_refused": false}';
  exception when others then r := r || '{"10_update_refused": true}';
  end;
  begin
    delete from pred_engine_runs where run_id = 'run-c';
    r := r || '{"11_delete_refused": false}';
  exception when others then r := r || '{"11_delete_refused": true}';
  end;
  begin
    insert into pred_engine_runs (run_id, lane, transition, scheduled_at) values ('run-x', 'core', 'RUNNING', now());
    r := r || '{"12_bad_transition_refused": false}';
  exception when check_violation then r := r || '{"12_bad_transition_refused": true}';
  end;
  raise exception 'PROOF_RESULT %', r;
end $proof$;
