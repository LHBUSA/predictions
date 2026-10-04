-- PROOF for 006_pred_decisions: run AFTER the migration text in the same transaction (scripts/db/run-006.ps1 concatenates
-- them). Every check runs, then RAISE 'PROOF_RESULT %' aborts the transaction: nothing persists.
-- Uses a real FINAL_PRE_RESOLUTION designation; because no forecast exists after the ledger start yet, the proof first
-- shows the ledger-start rule rejecting it, then lifts that ONE rule inside this doomed transaction to exercise the rest.
do $proof$
declare
  f record; r jsonb := '{}'::jsonb; id1 uuid;
begin
  select d.contract_id, d.forecast_id, p.model_id, p.model_version, p.model_state, p.probability, p.data_cutoff_at, p.captured_at, p.feature_snapshot_id
    into f
    from pred_forecast_designations d join pred_forecasts p on p.forecast_id = d.forecast_id
    where d.designation = 'FINAL_PRE_RESOLUTION' order by p.captured_at desc limit 1;
  r := r || jsonb_build_object('sample_forecast', f.forecast_id, 'sample_captured_at', f.captured_at);

  -- 1. ledger start rejects a pre-freeze decision (no historical backfill)
  begin
    insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, policy_activated_at, model_id, model_version, model_state, probability, confidence, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, side, reasons, official_at_decision)
    values ('proof|backfill', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', null, f.model_id, f.model_version, f.model_state, f.probability, 'HIGH', repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'PASS', null, '{MODEL_NOT_VALIDATED}', false);
    r := r || '{"1_backfill_rejected": false}';
  exception when check_violation then r := r || '{"1_backfill_rejected": true}';
  end;

  alter table pred_decisions drop constraint pred_decisions_ledger_start;

  -- 2. a faithful row is accepted
  insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, policy_activated_at, model_id, model_version, model_state, probability, confidence, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, side, reasons, official_at_decision)
  values ('proof|ok', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', null, f.model_id, f.model_version, f.model_state, f.probability, 'HIGH', repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'PASS', null, '{MODEL_NOT_VALIDATED}', false)
  returning decision_id into id1;
  r := r || jsonb_build_object('2_valid_insert', id1 is not null);

  -- 3/4. update and delete rejected
  begin update pred_decisions set state = 'CALL' where decision_id = id1; r := r || '{"3_update_rejected": false}';
  exception when raise_exception then r := r || '{"3_update_rejected": true}'; end;
  begin delete from pred_decisions where decision_id = id1; r := r || '{"4_delete_rejected": false}';
  exception when raise_exception then r := r || '{"4_delete_rejected": true}'; end;

  -- 5. a second ORIGINAL row for the same contract/designation/candidate/policy rejected
  begin
    insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, model_id, model_version, model_state, probability, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, reasons, official_at_decision)
    values ('proof|dup', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', f.model_id, f.model_version, f.model_state, f.probability, repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'PASS', '{}', false);
    r := r || '{"5_duplicate_rejected": false}';
  exception when unique_violation then r := r || '{"5_duplicate_rejected": true}'; end;

  -- 6. a row that misstates the forecast probability rejected
  begin
    insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, model_id, model_version, model_state, probability, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, reasons, official_at_decision)
    values ('proof|prob', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof2', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', f.model_id, f.model_version, f.model_state, least(1, f.probability + 0.1), repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'PASS', '{}', false);
    r := r || '{"6_misstated_probability_rejected": false}';
  exception when raise_exception then r := r || '{"6_misstated_probability_rejected": true}'; end;

  -- 7. official without activation rejected; 8. official before activation rejected (no retroactive official)
  begin
    insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, model_id, model_version, model_state, probability, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, reasons, official_at_decision)
    values ('proof|off1', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof3', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', f.model_id, f.model_version, f.model_state, f.probability, repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'PASS', '{}', true);
    r := r || '{"7_official_without_activation_rejected": false}';
  exception when check_violation then r := r || '{"7_official_without_activation_rejected": true}'; end;
  begin
    insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, policy_activated_at, model_id, model_version, model_state, probability, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, reasons, official_at_decision)
    values ('proof|off2', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof4', 'v', 'ACTIVE', repeat('a', 64), '2026-01-01', f.captured_at + interval '1 day', f.model_id, f.model_version, f.model_state, f.probability, repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'PASS', '{}', true);
    r := r || '{"8_retroactive_official_rejected": false}';
  exception when check_violation then r := r || '{"8_retroactive_official_rejected": true}'; end;

  -- 9. CALL without a side rejected
  begin
    insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, model_id, model_version, model_state, probability, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, reasons, official_at_decision)
    values ('proof|side', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof5', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', f.model_id, f.model_version, f.model_state, f.probability, repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'CALL', '{}', false);
    r := r || '{"9_call_without_side_rejected": false}';
  exception when check_violation then r := r || '{"9_call_without_side_rejected": true}'; end;

  -- 10. a correction (new row referencing the original, with a reason) accepted; without a reason rejected
  insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, model_id, model_version, model_state, probability, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, reasons, official_at_decision, correction_of, correction_reason)
  values ('proof|corr', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', f.model_id, f.model_version, f.model_state, f.probability, repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'HOLD', '{STALE_EVIDENCE}', false, id1, 'proof correction');
  r := r || '{"10a_correction_accepted": true}';
  begin
    insert into pred_decisions (record_key, contract_id, forecast_id, designation, counting_unit, candidate, policy_version, policy_status, policy_sha256, policy_frozen_at, model_id, model_version, model_state, probability, evidence_sha256, feature_snapshot_id, data_cutoff_at, decision_as_of, state, reasons, official_at_decision, correction_of)
    values ('proof|corr2', f.contract_id, f.forecast_id, 'FINAL_PRE_RESOLUTION', 'u', 'proof', 'v', 'FROZEN_PROSPECTIVE', repeat('a', 64), '2026-01-01', f.model_id, f.model_version, f.model_state, f.probability, repeat('b', 64), f.feature_snapshot_id, f.data_cutoff_at, f.captured_at, 'HOLD', '{}', false, id1);
    r := r || '{"10b_correction_without_reason_rejected": false}';
  exception when check_violation then r := r || '{"10b_correction_without_reason_rejected": true}'; end;

  -- 11. firewall: no price / venue column exists on the table
  r := r || jsonb_build_object('11_market_columns', (select coalesce(jsonb_agg(column_name), '[]'::jsonb) from information_schema.columns where table_name = 'pred_decisions'
    and column_name ~* 'kalshi|polymarket|market|venue|bid|ask|mid|spread|price|volume|liquidity|consensus|divergence|benchmark'));

  raise exception 'PROOF_RESULT %', r::text;
end
$proof$;
