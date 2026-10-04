-- PROOF for 010 (run after the migration in one transaction; always aborts with PROOF_RESULT).
do $proof$
declare r jsonb := '{}'::jsonb; w text;
begin
  select window_id into w from pred_crypto_windows order by open_at limit 1;
  if w is null then
    insert into pred_crypto_windows (window_id, asset, horizon_min, open_at, close_at, settle_rule, proxy_open_usd, proxy_basis)
    values ('BTC15M:proof10', 'BTC', 15, '2026-10-04T16:00:00Z', '2026-10-04T16:15:00Z', 'x', 1, '{}');
    w := 'BTC15M:proof10';
  end if;
  insert into pred_crypto_venue_settlements (window_id, venue, market_id, result, direction, observed_at, source_settled_at, source, ref)
  values (w, 'polymarket', '0xproof', 'down', 'DOWN', now(), '2026-10-04T16:01:28Z', 'gamma-api events', '{"umaEndDate":"2026-10-04T16:01:28Z"}');
  insert into pred_crypto_venue_settlements (window_id, venue, market_id, result, direction, observed_at, source, ref)
  values (w, 'kalshi', 'KXBTC15M-PROOF', 'no', 'DOWN', now(), 'kalshi markets', '{}');
  r := r || '{"1_valid_rows": true}';
  begin insert into pred_crypto_venue_settlements (window_id, venue, market_id, result, direction, observed_at, source) values (w, 'polymarket', 'x', 'up', 'UP', now(), 's');
    r := r || '{"2_one_per_window_venue": false}'; exception when unique_violation then r := r || '{"2_one_per_window_venue": true}'; end;
  begin insert into pred_crypto_venue_settlements (window_id, venue, market_id, result, direction, observed_at, source) values (w, 'kalshi', 'x', 'yes', 'DOWN', now(), 's');
    r := r || '{"3_direction_consistent": false}'; exception when check_violation then r := r || '{"3_direction_consistent": true}'; end;
  begin update pred_crypto_venue_settlements set result = 'up' where window_id = w;
    r := r || '{"4_update_rejected": false}'; exception when raise_exception then r := r || '{"4_update_rejected": true}'; end;
  begin delete from pred_crypto_venue_settlements where window_id = w;
    r := r || '{"4_delete_rejected": false}'; exception when raise_exception then r := r || '{"4_delete_rejected": true}'; end;
  raise exception 'PROOF_RESULT %', r;
end
$proof$;
