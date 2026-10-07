-- PROOF for 013_intraday_scoring: run AFTER the migration (same session). Every check runs on a REAL resolved intraday
-- contract, then RAISE 'PROOF_RESULT %' aborts the transaction: nothing persists.
do $proof$
declare
  c record; s record; e record; res record; r jsonb := '{}'::jsonb; ref timestamptz; k text;
begin
  -- a resolved max-temp contract with >= 2 live intraday rows before local noon
  select pc.contract_id, pc.observation_start, pc.observation_end, f.model_id, f.model_version into c
    from pred_contracts pc join pred_forecasts f on f.contract_id = pc.contract_id
    where f.model_id = 'pbe-weather-maxtemp-intraday' and f.record_type = 'live'
      and f.captured_at <= pc.observation_start + interval '12 hours'
      and exists (select 1 from pred_resolutions x where x.contract_id = pc.contract_id and x.venue_result in ('yes', 'no'))
    group by 1, 2, 3, 4, 5 having count(*) >= 2 order by pc.observation_start desc limit 1;
  ref := c.observation_start + interval '12 hours';
  select forecast_id, captured_at, probability into s from pred_forecasts
    where contract_id = c.contract_id and model_id = c.model_id and model_version = c.model_version and record_type = 'live'
      and captured_at >= c.observation_start and captured_at <= ref order by captured_at desc limit 1;
  select forecast_id, captured_at into e from pred_forecasts
    where contract_id = c.contract_id and model_id = c.model_id and model_version = c.model_version and record_type = 'live'
      and captured_at >= c.observation_start and captured_at < s.captured_at order by captured_at desc limit 1;
  select resolution_id, venue_result into res from pred_resolutions where contract_id = c.contract_id limit 1;
  r := r || jsonb_build_object('sample_contract', c.contract_id, 'standing', s.forecast_id, 'earlier', e.forecast_id);
  k := c.contract_id || '|' || c.model_id || '@' || c.model_version || '|MIDDAY_LOCAL';

  -- 1. the standing forecast is accepted
  insert into pred_intraday_designations (designation_key, contract_id, model_id, model_version, designation, forecast_id, rule_version, reference_time, forecast_captured_at)
  values (k, c.contract_id, c.model_id, c.model_version, 'MIDDAY_LOCAL', s.forecast_id, 'designation-intraday/1', ref, s.captured_at);
  r := r || '{"1_standing_accepted": true}';

  -- 2. an earlier (superseded) row is rejected
  begin
    insert into pred_intraday_designations (designation_key, contract_id, model_id, model_version, designation, forecast_id, rule_version, reference_time, forecast_captured_at)
    values (k || 'x', c.contract_id, c.model_id, c.model_version, 'MIDDAY_LOCAL', e.forecast_id, 'designation-intraday/1', ref, e.captured_at);
    r := r || '{"2_superseded_rejected": false}';
  exception when raise_exception then r := r || '{"2_superseded_rejected": true}'; end;
  -- 2b. a reference time outside the frozen rule (WINDOW_OPEN must be start + 2 h) is rejected
  begin
    insert into pred_intraday_designations (designation_key, contract_id, model_id, model_version, designation, forecast_id, rule_version, reference_time, forecast_captured_at)
    values (c.contract_id || '|' || c.model_id || '@' || c.model_version || '|WINDOW_OPEN', c.contract_id, c.model_id, c.model_version, 'WINDOW_OPEN', e.forecast_id, 'designation-intraday/1', ref, e.captured_at);
    r := r || '{"2b_wrong_reference_rejected": false}';
  exception when raise_exception then r := r || '{"2b_wrong_reference_rejected": true}'; end;

  -- 3. a duplicate designation is rejected (unique)
  begin
    insert into pred_intraday_designations (designation_key, contract_id, model_id, model_version, designation, forecast_id, rule_version, reference_time, forecast_captured_at)
    values (k || '2', c.contract_id, c.model_id, c.model_version, 'MIDDAY_LOCAL', s.forecast_id, 'designation-intraday/1', ref, s.captured_at);
    r := r || '{"3_duplicate_rejected": false}';
  exception when unique_violation then r := r || '{"3_duplicate_rejected": true}'; end;

  -- 4. a pre-window model id / wrong rule version is rejected
  begin
    insert into pred_intraday_designations (designation_key, contract_id, model_id, model_version, designation, forecast_id, rule_version, reference_time, forecast_captured_at)
    values (k || '3', c.contract_id, 'pbe-weather-maxtemp', c.model_version, 'MIDDAY_LOCAL', s.forecast_id, 'designation/1', ref, s.captured_at);
    r := r || '{"4_prewindow_model_rejected": false}';
  exception when check_violation or raise_exception then r := r || '{"4_prewindow_model_rejected": true}'; end;

  -- 5/6. update / delete rejected
  begin update pred_intraday_designations set backfilled = true where designation_key = k; r := r || '{"5_update_rejected": false}';
  exception when raise_exception then r := r || '{"5_update_rejected": true}'; end;
  begin delete from pred_intraday_designations where designation_key = k; r := r || '{"6_delete_rejected": false}';
  exception when raise_exception then r := r || '{"6_delete_rejected": true}'; end;

  -- 7. a faithful score row is accepted (no benchmark)
  insert into pred_intraday_scores (score_key, designation_key, forecast_id, resolution_id, contract_id, model_id, model_version, designation, scoring_method, pbe_probability, outcome, score, benchmark_state, quality_state)
  values (k || '|brier', k, s.forecast_id, res.resolution_id, c.contract_id, c.model_id, c.model_version, 'MIDDAY_LOCAL', 'brier', s.probability,
          case when res.venue_result = 'yes' then 1 else 0 end, power(s.probability - case when res.venue_result = 'yes' then 1 else 0 end, 2), 'NO_MARKET_PRICE', 'OK');
  r := r || '{"7_score_accepted": true}';

  -- 8. wrong outcome rejected
  begin
    insert into pred_intraday_scores (score_key, designation_key, forecast_id, resolution_id, contract_id, model_id, model_version, designation, scoring_method, pbe_probability, outcome, score, benchmark_state, quality_state)
    values (k || '|log_loss', k, s.forecast_id, res.resolution_id, c.contract_id, c.model_id, c.model_version, 'MIDDAY_LOCAL', 'log_loss', s.probability,
            case when res.venue_result = 'yes' then 0 else 1 end, 1, 'NO_MARKET_PRICE', 'OK');
    r := r || '{"8_wrong_outcome_rejected": false}';
  exception when raise_exception then r := r || '{"8_wrong_outcome_rejected": true}'; end;

  -- 9. misstated PBE probability rejected
  begin
    insert into pred_intraday_scores (score_key, designation_key, forecast_id, resolution_id, contract_id, model_id, model_version, designation, scoring_method, pbe_probability, outcome, score, benchmark_state, quality_state)
    values (k || '|log_loss', k, s.forecast_id, res.resolution_id, c.contract_id, c.model_id, c.model_version, 'MIDDAY_LOCAL', 'log_loss', least(1, s.probability + 0.05),
            case when res.venue_result = 'yes' then 1 else 0 end, 1, 'NO_MARKET_PRICE', 'OK');
    r := r || '{"9_misstated_probability_rejected": false}';
  exception when raise_exception then r := r || '{"9_misstated_probability_rejected": true}'; end;

  -- 10. a benchmark score without VALID state rejected
  begin
    insert into pred_intraday_scores (score_key, designation_key, forecast_id, resolution_id, contract_id, model_id, model_version, designation, scoring_method, pbe_probability, outcome, score, benchmark_state, market_probability, benchmark_score, quality_state)
    values (k || '|log_loss', k, s.forecast_id, res.resolution_id, c.contract_id, c.model_id, c.model_version, 'MIDDAY_LOCAL', 'log_loss', s.probability,
            case when res.venue_result = 'yes' then 1 else 0 end, 1, 'MARKET_FEED_UNVERIFIED', 0.5, 0.69, 'OK');
    r := r || '{"10_invalid_benchmark_rejected": false}';
  exception when check_violation then r := r || '{"10_invalid_benchmark_rejected": true}'; end;

  -- 11. score update rejected
  begin update pred_intraday_scores set score = 0 where score_key = k || '|brier'; r := r || '{"11_score_update_rejected": false}';
  exception when raise_exception then r := r || '{"11_score_update_rejected": true}'; end;

  -- 12. the pre-window tables were not touched by any of this
  r := r || jsonb_build_object('12_no_designation1_rows_for_intraday', not exists (select 1 from pred_forecast_designations where model_id ~ '-intraday$'));

  raise exception 'PROOF_RESULT %', r;
end $proof$;
