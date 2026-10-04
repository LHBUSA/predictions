-- PROOF for 007_ledger_truncate_guard: run AFTER the migration text in the same transaction. Every check runs, then
-- RAISE 'PROOF_RESULT %' aborts: nothing persists. Proves, per guarded table: INSERT works (incl. corrections/revisions as
-- new rows), UPDATE/DELETE/TRUNCATE rejected; pred_events stays mutable; existing row counts unchanged.
do $proof$
declare
  tabs text[] := array['pred_source_observations','pred_feature_snapshots','pred_forecasts','pred_venue_snapshots','pred_resolutions','pred_scores','pred_forecast_designations'];
  t text; col text; n bigint; r jsonb := '{}'::jsonb; before jsonb := '{}'::jsonb; res jsonb;
  f record; d record; res_id uuid; res2_id uuid; ins jsonb := '{}'::jsonb;
begin
  foreach t in array tabs || array['pred_events'] loop execute format('select count(*) from %I', t) into n; before := before || jsonb_build_object(t, n); end loop;

  -- INSERT still works; corrections/revisions are new rows
  insert into pred_source_observations select (jsonb_populate_record(null::pred_source_observations,
    to_jsonb(o) || jsonb_build_object('observation_key', o.observation_key || '|proof-rev', 'revision', coalesce(o.revision, '') || '+proof-rev', 'inserted_at', now()))).*
    from pred_source_observations o limit 1;
  ins := ins || '{"pred_source_observations": "revision row"}';
  insert into pred_feature_snapshots select (jsonb_populate_record(null::pred_feature_snapshots, to_jsonb(s) || jsonb_build_object('snapshot_id', s.snapshot_id || '|proof', 'inserted_at', now()))).* from pred_feature_snapshots s limit 1;
  ins := ins || '{"pred_feature_snapshots": "new row"}';
  select * into f from pred_forecasts order by captured_at desc limit 1;
  insert into pred_forecasts (record_id, event_id, model_id, model_version, probability, captured_at, feature_snapshot_id, record_type, provenance, explanation, metadata, contract_id, market_id, market_probability, market_snapshot_key, market_observed_at, data_cutoff_at, model_state, confidence, features_sha256, revision_of, revision_reason)
    values (f.record_id || '|proof', f.event_id, f.model_id, f.model_version, f.probability, f.captured_at, f.feature_snapshot_id, f.record_type, f.provenance, f.explanation, f.metadata, f.contract_id, f.market_id, f.market_probability, f.market_snapshot_key, f.market_observed_at, f.data_cutoff_at, f.model_state, f.confidence, f.features_sha256, f.forecast_id, 'proof revision');
  ins := ins || '{"pred_forecasts": "revision row (revision_of)"}';
  insert into pred_venue_snapshots select (jsonb_populate_record(null::pred_venue_snapshots, to_jsonb(v) || jsonb_build_object('venue_snapshot_id', gen_random_uuid(), 'snapshot_key', v.snapshot_key || '|proof', 'inserted_at', now()))).* from pred_venue_snapshots v limit 1;
  ins := ins || '{"pred_venue_snapshots": "new row"}';
  select x.* into d from pred_forecast_designations x
    where x.designation = 'FIRST_PUBLISHED' and not exists (select 1 from pred_forecast_designations y where y.contract_id = x.contract_id and y.model_id = x.model_id and y.designation = 'T_MINUS_24H')
      and not exists (select 1 from pred_resolutions z where z.contract_id = x.contract_id) limit 1;
  insert into pred_forecast_designations (contract_id, model_id, designation, forecast_id, rule_version, reference_time, detail)
    values (d.contract_id, d.model_id, 'T_MINUS_24H', d.forecast_id, 'proof', now(), '{"proof": true}');
  ins := ins || '{"pred_forecast_designations": "new designation"}';
  insert into pred_resolutions (event_id, contract_id, resolved_at, authority, outcome, venue_result) values (f.event_id, f.contract_id, now(), 'proof', '{"proof": true}', 'yes') returning resolution_id into res_id;
  insert into pred_resolutions (event_id, contract_id, resolved_at, authority, outcome, venue_result, correction_of) values (f.event_id, f.contract_id, now(), 'proof', '{"proof": true}', 'no', res_id) returning resolution_id into res2_id;
  ins := ins || '{"pred_resolutions": "row + correction row (correction_of)"}';
  insert into pred_scores (forecast_id, resolution_id, contract_id, scoring_method, score) values (f.forecast_id, res2_id, f.contract_id, 'brier', 0.1);
  ins := ins || '{"pred_scores": "new row"}';
  r := r || jsonb_build_object('inserts_ok', ins);

  -- UPDATE / DELETE / TRUNCATE rejected on every guarded table
  foreach t in array tabs loop
    select column_name into col from information_schema.columns where table_name = t order by ordinal_position limit 1;
    res := '{}'::jsonb;
    begin execute format('update %I set %I = %I where ctid in (select ctid from %I limit 1)', t, col, col, t); res := res || '{"update_rejected": false}';
    exception when raise_exception then res := res || '{"update_rejected": true}'; end;
    begin execute format('delete from %I where ctid in (select ctid from %I limit 1)', t, t); res := res || '{"delete_rejected": false}';
    exception when raise_exception then res := res || '{"delete_rejected": true}'; end;
    begin execute format('truncate %I cascade', t); res := res || '{"truncate_rejected": false}';
    exception when raise_exception then res := res || '{"truncate_rejected": true}'; end;
    r := r || jsonb_build_object(t, res);
  end loop;

  -- pred_events is NOT append-only: no truncate guard, updates still allowed
  update pred_events set updated_at = updated_at where ctid in (select ctid from pred_events limit 1);
  r := r || jsonb_build_object('pred_events', jsonb_build_object('update_allowed', true,
    'truncate_guard', exists (select 1 from pg_trigger where tgrelid = 'pred_events'::regclass and tgname like '%truncate%')));

  -- existing rows untouched: count now = count before + rows this proof inserted
  r := r || jsonb_build_object('counts_before', before, 'counts_after_proof_inserts', (select jsonb_object_agg(x, (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I', x), false, true, '')))[1]::text::bigint) from unnest(tabs || array['pred_events']) x));
  raise exception 'PROOF_RESULT %', r::text;
end
$proof$;
