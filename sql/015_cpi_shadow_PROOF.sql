-- PROOF for 015 (run after the migration; always aborts via RAISE 'PROOF_RESULT %', nothing persists).
do $proof$
declare r jsonb := '{}'::jsonb; fs uuid; h text := repeat('b', 64); w record;
begin
  -- first-seen: insert, duplicate content ignored by the unique key, revisions are new rows, no update/delete
  insert into pred_macro_first_seen (source, series, period, value, content_sha256, observed_at, source_url, parser_version, capture_version)
  values ('EIA', 'EMM_EPM0_PTE_NUS_DPG', '2026-10-05', 3.1, h, now(), 'proof', 'proof', 'proof') returning first_seen_id into fs;
  r := r || jsonb_build_object('1_first_seen_insert', fs is not null);
  begin insert into pred_macro_first_seen (source, series, period, value, content_sha256, observed_at, source_url, parser_version, capture_version)
    values ('EIA', 'EMM_EPM0_PTE_NUS_DPG', '2026-10-05', 3.1, h, now(), 'proof', 'proof', 'proof'); r := r || '{"2_duplicate_rejected": false}';
  exception when unique_violation then r := r || '{"2_duplicate_rejected": true}'; end;
  begin update pred_macro_first_seen set value = 9 where first_seen_id = fs; r := r || '{"3_first_seen_update_rejected": false}';
  exception when raise_exception then r := r || '{"3_first_seen_update_rejected": true}'; end;
  begin delete from pred_macro_first_seen where first_seen_id = fs; r := r || '{"4_first_seen_delete_rejected": false}';
  exception when raise_exception then r := r || '{"4_first_seen_delete_rejected": true}'; end;

  -- runs: OK must be frozen in [cutoff, release); core m/m refused; NO_FORECAST carries no distribution
  insert into pred_cpi_shadow_runs (run_id, model_id, model_version, feature_version, adapter_version, artifact_sha256, model_state, target, kalshi_series, reference_month, horizon, release_at, cutoff_at, forecast_created_at, status, features, distribution, median, q10, q90, ladder)
  values ('proof|ok', 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'cpi-features/1', 'cpi-contract-adapter/1', h, 'SHADOW', 'headline_mom', 'KXCPI', '2026-09', 'T-1D', '2026-10-14 12:30Z', '2026-10-14 00:00Z', '2026-10-14 00:09Z', 'OK', '{"H_AVG3": 0.3}', '{"lo": -3, "step": 0.1, "mass": []}', 0.4, 0.3, 0.6, '[]');
  r := r || '{"5_ok_run_insert": true}';
  begin insert into pred_cpi_shadow_runs (run_id, model_id, model_version, feature_version, adapter_version, artifact_sha256, model_state, target, kalshi_series, reference_month, horizon, release_at, cutoff_at, forecast_created_at, status, features, distribution, median, q10, q90, ladder)
    values ('proof|late', 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'f', 'a', h, 'SHADOW', 'core_yoy', 'KXCPICOREYOY', '2026-09', 'T-1D', '2026-10-14 12:30Z', '2026-10-14 00:00Z', '2026-10-14 12:31Z', 'OK', '{}', '{}', 2.5, 2.3, 2.7, '[]');
    r := r || '{"6_ok_after_release_rejected": false}';
  exception when check_violation then r := r || '{"6_ok_after_release_rejected": true}'; end;
  begin insert into pred_cpi_shadow_runs (run_id, model_id, model_version, feature_version, adapter_version, artifact_sha256, model_state, target, kalshi_series, reference_month, horizon, release_at, cutoff_at, forecast_created_at, status, reason)
    values ('proof|core', 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'f', 'a', h, 'SHADOW', 'core_mom', 'KXCPICORE', '2026-09', 'T-1D', '2026-10-14 12:30Z', '2026-10-14 00:00Z', '2026-10-14 00:09Z', 'NO_FORECAST', 'x');
    r := r || '{"7_core_mom_run_rejected": false}';
  exception when check_violation then r := r || '{"7_core_mom_run_rejected": true}'; end;
  begin insert into pred_cpi_shadow_runs (run_id, model_id, model_version, feature_version, adapter_version, artifact_sha256, model_state, target, kalshi_series, reference_month, horizon, release_at, cutoff_at, forecast_created_at, status, reason)
    values ('proof|again', 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'f', 'a', h, 'SHADOW', 'headline_mom', 'KXCPI', '2026-09', 'T-1D', '2026-10-14 12:30Z', '2026-10-14 00:00Z', '2026-10-14 00:39Z', 'NO_FORECAST', 'x');
    r := r || '{"8_second_run_same_month_rejected": false}';
  exception when unique_violation then r := r || '{"8_second_run_same_month_rejected": true}'; end;
  begin insert into pred_cpi_shadow_runs (run_id, model_id, model_version, feature_version, adapter_version, artifact_sha256, model_state, target, kalshi_series, reference_month, horizon, release_at, cutoff_at, forecast_created_at, status, features, distribution, median, q10, q90, ladder)
    values ('proof|mkt', 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'f', 'a', h, 'SHADOW', 'headline_yoy', 'KXCPIYOY', '2026-09', 'T-1D', '2026-10-14 12:30Z', '2026-10-14 00:00Z', '2026-10-14 00:09Z', 'OK', '{"kalshi_mid": 0.4}', '{}', 3.6, 3.4, 3.8, '[]');
    r := r || '{"9_market_feature_rejected": false}';
  exception when check_violation then r := r || '{"9_market_feature_rejected": true}'; end;
  begin insert into pred_cpi_shadow_runs (run_id, model_id, model_version, feature_version, adapter_version, artifact_sha256, model_state, public, target, kalshi_series, reference_month, horizon, release_at, cutoff_at, forecast_created_at, status, reason)
    values ('proof|pub', 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'f', 'a', h, 'SHADOW', true, 'headline_yoy', 'KXCPIYOY', '2026-10', 'T-1D', '2026-11-10 13:30Z', '2026-11-10 01:00Z', '2026-11-10 01:09Z', 'NO_FORECAST', 'INPUT_UNAVAILABLE');
    r := r || '{"10_public_rejected": false}';
  exception when check_violation then r := r || '{"10_public_rejected": true}'; end;
  begin update pred_cpi_shadow_runs set median = 0.5 where run_id = 'proof|ok'; r := r || '{"11_run_update_rejected": false}';
  exception when raise_exception then r := r || '{"11_run_update_rejected": true}'; end;

  -- grades: only for OK runs frozen before publication
  insert into pred_macro_first_seen (source, series, period, value, content_sha256, observed_at, source_published_at, source_url, parser_version, capture_version)
  values ('BLS', 'CPI-U Table A', '2026-09', 0.4, repeat('c', 64), '2026-10-14 12:39Z', '2026-10-14 12:30Z', 'proof', 'proof', 'proof') returning first_seen_id into fs;
  insert into pred_cpi_shadow_grades (run_id, actual_value, actual_first_seen_id, actual_published_at, graded_at, grading_version, scores)
  values ('proof|ok', 0.4, fs, '2026-10-14 12:30Z', '2026-10-14 12:39Z', 'proof', '{}');
  r := r || '{"12_grade_insert": true}';
  insert into pred_cpi_shadow_runs (run_id, model_id, model_version, feature_version, adapter_version, artifact_sha256, model_state, target, kalshi_series, reference_month, horizon, release_at, cutoff_at, forecast_created_at, status, reason)
  values ('proof|nf', 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'f', 'a', h, 'SHADOW', 'core_yoy', 'KXCPICOREYOY', '2026-09', 'T-1D', '2026-10-14 12:30Z', '2026-10-14 00:00Z', '2026-10-14 13:09Z', 'NO_FORECAST', 'RUNTIME_MISSED_WINDOW');
  begin insert into pred_cpi_shadow_grades (run_id, actual_value, actual_first_seen_id, actual_published_at, graded_at, grading_version, scores)
    values ('proof|nf', 2.5, fs, '2026-10-14 12:30Z', '2026-10-14 13:10Z', 'proof', '{}'); r := r || '{"13_grade_of_no_forecast_rejected": false}';
  exception when raise_exception then r := r || '{"13_grade_of_no_forecast_rejected": true}'; end;

  -- pred_forecasts_shadow: weather rows still need station + climate day; CPI rows must carry run_id + an approved target
  select contract_id, event_id, observation_start into w from pred_contracts where event_type = 'MAX_TEMP_BUCKET' and normalization_status = 'NORMALIZED' order by observation_start desc limit 1;
  begin insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, designation_rules, probability, captured_at, data_cutoff_at, station_id, climate_date, observation_start, predictive_input_hash, source_state_hash, features, features_sha256)
    values ('proof|wx', w.event_id, w.contract_id, 'pbe-weather-maxtemp-intraday', '2.2.0', 'SHADOW', 'shadow', 'x', 0.25, w.observation_start + interval '3 hours', w.observation_start, null, null, w.observation_start, h, h, '{}', h);
    r := r || '{"14_weather_row_without_station_rejected": false}';
  exception when check_violation then r := r || '{"14_weather_row_without_station_rejected": true}'; end;
  begin insert into pred_forecasts_shadow (record_id, event_id, contract_id, model_id, model_version, model_state, record_type, designation_rules, probability, captured_at, data_cutoff_at, observation_start, predictive_input_hash, source_state_hash, features, features_sha256, metadata)
    values ('proof|cpicore', w.event_id, w.contract_id, 'pbe-cpi-distribution', 'cpi-v1/1.0.0', 'SHADOW', 'shadow', 'x', 0.25, w.observation_start + interval '3 hours', w.observation_start, w.observation_start, h, h, '{}', h, '{"run_id": "x", "cpi_target": "core_mom"}');
    r := r || '{"15_cpi_core_mom_row_rejected": false}';
  exception when check_violation then r := r || '{"15_cpi_core_mom_row_rejected": true}'; end;

  r := r || jsonb_build_object(
    '16_rls_enabled', (select bool_and(relrowsecurity) from pg_class where relname in ('pred_macro_first_seen', 'pred_cpi_shadow_runs', 'pred_cpi_shadow_grades')),
    '17_anon_cannot_select', not (has_table_privilege('anon', 'pred_macro_first_seen', 'select') or has_table_privilege('anon', 'pred_cpi_shadow_runs', 'select') or has_table_privilege('anon', 'pred_cpi_shadow_grades', 'select')),
    '18_weather_rows_unchanged_valid', not exists (select 1 from pred_forecasts_shadow where model_id like 'pbe-weather-%' and (station_id is null or climate_date is null)),
    '19_no_cpi_rows_in_pred_forecasts', not exists (select 1 from pred_forecasts where model_id = 'pbe-cpi-distribution'));
  raise exception 'PROOF_RESULT %', r;
end $proof$;
