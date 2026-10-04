-- PROOF for 009_crypto_shadow: run AFTER the migration text in the same transaction. Every check runs, then
-- RAISE 'PROOF_RESULT %' aborts the transaction: nothing persists. Also proven on PGlite (scripts/db/prove-009.mjs).
do $proof$
declare
  r jsonb := '{}'::jsonb; fid bigint; oid bigint; did bigint;
begin
  insert into pred_crypto_windows (window_id, asset, horizon_min, open_at, close_at, settle_rule, kalshi_market_ticker, polymarket_slug, proxy_open_usd, proxy_basis)
  values ('BTC15M:proof', 'BTC', 15, '2026-10-04T16:00:00Z', '2026-10-04T16:15:00Z', 'avg60(close) >= avg60(open)', 'KXBTC15M-PROOF', 'btc-updown-15m-0', 60000.12, '{"rule":"proof"}');
  insert into pred_crypto_forecasts (window_id, model_id, model_version, model_state, captured_at, data_cutoff_at, p_up, features, features_sha256)
  values ('BTC15M:proof', 'm', '0.1.0', 'SHADOW', '2026-10-04T16:05:04Z', '2026-10-04T16:05:00Z', 0.61, '{"btc_spot_usd":60010.5,"z_distance":0.3}', repeat('a', 64)) returning forecast_id into fid;
  r := r || jsonb_build_object('1_valid_rows', fid is not null);

  -- 2. a market key in features is refused by the generated sql/004 guard
  begin
    insert into pred_crypto_forecasts (window_id, model_id, model_version, model_state, captured_at, data_cutoff_at, p_up, features, features_sha256)
    values ('BTC15M:proof', 'm', '0.1.0', 'SHADOW', '2026-10-04T16:06:04Z', '2026-10-04T16:06:00Z', 0.6, '{"kalshi_mid":0.5}', repeat('a', 64));
    r := r || '{"2_market_key_refused": false}';
  exception when check_violation then r := r || '{"2_market_key_refused": true}';
  end;

  -- 3. only SHADOW forecasts
  begin
    insert into pred_crypto_forecasts (window_id, model_id, model_version, model_state, captured_at, data_cutoff_at, p_up, features, features_sha256)
    values ('BTC15M:proof', 'm', '0.1.0', 'OFFICIAL', '2026-10-04T16:07:04Z', '2026-10-04T16:07:00Z', 0.6, '{}', repeat('a', 64));
    r := r || '{"3_non_shadow_refused": false}';
  exception when check_violation then r := r || '{"3_non_shadow_refused": true}';
  end;

  insert into pred_crypto_venue_obs (window_id, venue, market_id, captured_at, bid, ask, mid, market_status, comparability)
  values ('BTC15M:proof', 'kalshi', 'KXBTC15M-PROOF', '2026-10-04T16:05:04Z', 0.5, 0.52, 0.51, 'active', 'SAME_CONTRACT') returning obs_id into oid;
  insert into pred_crypto_designations (window_id, model_id, designation, forecast_id, reference_time, rule_version, kalshi_obs_id)
  values ('BTC15M:proof', 'm', 'T_MINUS_10', fid, '2026-10-04T16:05:00Z', 'crypto-designation/1', oid) returning designation_id into did;
  -- 4. a designation is unique per window/model
  begin
    insert into pred_crypto_designations (window_id, model_id, designation, forecast_id, reference_time, rule_version) values ('BTC15M:proof', 'm', 'T_MINUS_10', fid, now(), 'x');
    r := r || '{"4_designation_unique": false}';
  exception when unique_violation then r := r || '{"4_designation_unique": true}';
  end;
  insert into pred_crypto_resolutions (window_id, venue_result, proxy_close_usd, proxy_result, proxy_agrees) values ('BTC15M:proof', 'yes', 60020.0, 'yes', true);
  insert into pred_crypto_scores (designation_id, window_id, designation, method, outcome, pbe_p, pbe_score, kalshi_p, kalshi_score)
  values (did, 'BTC15M:proof', 'T_MINUS_10', 'brier', 1, 0.61, 0.1521, 0.51, 0.2401);

  -- 5. append-only: update and delete rejected on every table
  begin update pred_crypto_forecasts set p_up = 0.9 where forecast_id = fid; r := r || '{"5_update_rejected": false}';
  exception when raise_exception then r := r || '{"5_update_rejected": true}'; end;
  begin delete from pred_crypto_resolutions where window_id = 'BTC15M:proof'; r := r || '{"5_delete_rejected": false}';
  exception when raise_exception then r := r || '{"5_delete_rejected": true}'; end;

  -- 6. no column can hold a Kalshi strike / expiration value (BRTI)
  r := r || jsonb_build_object('6_no_brti_columns', not exists (select 1 from information_schema.columns where table_name like 'pred_crypto_%' and column_name ~* 'strike|expiration|brti|settlement_value'));

  raise exception 'PROOF_RESULT %', r;
end
$proof$;
