-- PROOF for 014 (run after the migration; always aborts via RAISE 'PROOF_RESULT %', nothing persists).
do $proof$
declare c record; r jsonb := '{}'::jsonb; id1 uuid; h text := repeat('a', 64);
begin
  select contract_id, event_id, market_id, station_id, observation_start, (detail->>'climate_date')::date d into c
    from pred_contracts where event_type = 'MAX_TEMP_BUCKET' and normalization_status = 'NORMALIZED' order by observation_start desc limit 1;
  insert into pred_forecasts_shadow (record_id, event_id, contract_id, market_id, model_id, model_version, model_state, record_type, designation_rules, probability, raw_probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256)
  values ('proof|1', c.event_id, c.contract_id, c.market_id, 'pbe-weather-maxtemp-intraday', '2.2.0', 'SHADOW', 'shadow', 'designation-intraday-shadow/1', 0.25, 0.2513, c.observation_start + interval '3 hours', c.observation_start + interval '2 hours', c.station_id, c.d, c.observation_start, h, h, '{"obs_max_so_far_f": 70}', h)
  returning forecast_id into id1;
  r := r || jsonb_build_object('1_valid_insert', id1 is not null);
  begin update pred_forecasts_shadow set probability = 0.5 where forecast_id = id1; r := r || '{"2_update_rejected": false}';
  exception when raise_exception then r := r || '{"2_update_rejected": true}'; end;
  begin delete from pred_forecasts_shadow where forecast_id = id1; r := r || '{"3_delete_rejected": false}';
  exception when raise_exception then r := r || '{"3_delete_rejected": true}'; end;
  begin
    insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, designation_rules, probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256, market_probability)
    values ('proof|2', c.event_id, c.contract_id, 'pbe-weather-maxtemp-intraday', '2.2.0', 'SHADOW', 'shadow', 'x', 0.25, c.observation_start + interval '3 hours', c.observation_start, c.station_id, c.d, c.observation_start, h, h, '{}', h, 0.4);
    r := r || '{"4_market_value_rejected": false}';
  exception when check_violation then r := r || '{"4_market_value_rejected": true}'; end;
  begin
    insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, designation_rules, probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256)
    values ('proof|3', c.event_id, c.contract_id, 'pbe-weather-maxtemp-intraday', '2.2.0', 'SHADOW', 'shadow', 'x', 0.25, c.observation_start + interval '3 hours', c.observation_start, c.station_id, c.d, c.observation_start, h, h, '{"kalshi_mid": 0.4}', h);
    r := r || '{"5_market_feature_rejected": false}';
  exception when check_violation then r := r || '{"5_market_feature_rejected": true}'; end;
  begin
    insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, designation_rules, probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256)
    values ('proof|4', c.event_id, c.contract_id, 'pbe-weather-maxtemp-intraday', '2.2.0', 'RESEARCH', 'shadow', 'x', 0.25, c.observation_start + interval '3 hours', c.observation_start, c.station_id, c.d, c.observation_start, h, h, '{}', h);
    r := r || '{"6_non_shadow_state_rejected": false}';
  exception when check_violation then r := r || '{"6_non_shadow_state_rejected": true}'; end;
  begin
    insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, public, designation_rules, probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256)
    values ('proof|5', c.event_id, c.contract_id, 'pbe-weather-maxtemp-intraday', '2.2.0', 'SHADOW', 'shadow', true, 'x', 0.25, c.observation_start + interval '3 hours', c.observation_start, c.station_id, c.d, c.observation_start, h, h, '{}', h);
    r := r || '{"7_public_rejected": false}';
  exception when check_violation then r := r || '{"7_public_rejected": true}'; end;
  begin
    insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, designation_rules, probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256)
    values ('proof|6', c.event_id, c.contract_id, 'pbe-weather-maxtemp-intraday', '2.2.0', 'SHADOW', 'shadow', 'x', 0.25, c.observation_start + interval '3 hours', c.observation_start + interval '4 hours', c.station_id, c.d, c.observation_start, h, h, '{}', h);
    r := r || '{"8_cutoff_after_capture_rejected": false}';
  exception when check_violation then r := r || '{"8_cutoff_after_capture_rejected": true}'; end;
  r := r || jsonb_build_object('9_rls_enabled', (select relrowsecurity from pg_class where relname = 'pred_forecasts_shadow'),
                               '10_anon_cannot_select', not has_table_privilege('anon', 'pred_forecasts_shadow', 'select'),
                               '11_no_shadow_rows_in_pred_forecasts', not exists (select 1 from pred_forecasts where record_type = 'shadow' or model_version = '2.2.0'));
  raise exception 'PROOF_RESULT %', r;
end $proof$;
