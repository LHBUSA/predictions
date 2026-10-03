-- Proof queries for 002_prediction_engine_v1. Run BEFORE (baseline) and AFTER; every check must hold.
-- 1. existing housing observations unchanged (count + content fingerprint)
select count(*) as source_rows,
       md5(string_agg(observation_key || coalesce(value::text, '') || coalesce(data::text, ''), '|' order by observation_key)) as source_fingerprint
from pred_source_observations;

-- 2. every 001 append-only trigger still present and enabled, plus the two new ones
select tgrelid::regclass as table_name, tgname, tgenabled
from pg_trigger
where tgname like 'pred_%' and not tgisinternal
order by 1, 2;

-- 3. updates/deletes still rejected (each statement must raise 'append-only Predictions ledger')
--    run individually inside a transaction that is rolled back:
--    begin; update pred_source_observations set units = units where observation_key = (select min(observation_key) from pred_source_observations); rollback;
--    begin; delete from pred_source_observations where observation_key = (select min(observation_key) from pred_source_observations); rollback;

-- 4. leakage guard rejects market keys at any depth and accepts clean vectors
select pred_features_market_free('{"clim_rate":0.3,"mos":{"p06":[10,20]}}'::jsonb) as clean_ok,
       pred_features_market_free('{"kalshi_mid":0.4}'::jsonb) as top_level_blocked,
       pred_features_market_free('{"a":{"b":{"yes_bid":0.4}}}'::jsonb) as nested_blocked,
       pred_features_market_free('{"inputs":[{"market_probability":0.4}]}'::jsonb) as array_blocked;
-- expected: true, false, false, false

-- 5. new tables exist with RLS on
select relname, relrowsecurity from pg_class where relname in ('pred_contracts','pred_forecast_designations');

-- 6. other 001 tables still empty / unchanged counts
select (select count(*) from pred_events) as events, (select count(*) from pred_forecasts) as forecasts,
       (select count(*) from pred_venue_snapshots) as venue, (select count(*) from pred_resolutions) as resolutions,
       (select count(*) from pred_scores) as scores, (select count(*) from pred_feature_snapshots) as features;
