-- PROOF for 012: run after 011 + 012 in one transaction; RAISE aborts it.
do $proof$
declare r jsonb := '{}'::jsonb;
begin
  insert into pred_engine_runs (run_id, lane, transition, scheduled_at) values ('k', 'newsroom', 'STARTED', now());
  insert into pred_engine_runs (run_id, lane, transition, scheduled_at, error, counts) values ('k', 'newsroom', 'ABANDONED', now(), 'no_terminal_before_lease_expiry', '{"lease_expires_at":"x"}');
  r := r || '{"1_abandoned_appended": true}';
  begin insert into pred_engine_runs (run_id, lane, transition, scheduled_at) values ('k', 'newsroom', 'ABANDONED', now()); r := r || '{"2_abandoned_once": false}';
  exception when unique_violation then r := r || '{"2_abandoned_once": true}'; end;
  begin update pred_engine_runs set error = null where run_id = 'k'; r := r || '{"3_started_immutable": false}';
  exception when others then r := r || '{"3_started_immutable": true}'; end;
  begin insert into pred_engine_runs (run_id, lane, transition, scheduled_at) values ('z', 'core', 'RUNNING', now()); r := r || '{"4_other_values_refused": false}';
  exception when check_violation then r := r || '{"4_other_values_refused": true}'; end;
  raise exception 'PROOF_RESULT %', r;
end $proof$;
