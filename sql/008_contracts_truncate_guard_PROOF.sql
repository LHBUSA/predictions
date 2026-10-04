-- PROOF for 008 (run after the migration text in one transaction; always aborts via PROOF_RESULT).
do $proof$
declare r jsonb := '{}'::jsonb; before bigint; ev bigint; c record;
begin
  select count(*) into before from pred_contracts; select count(*) into ev from pred_events;
  -- INSERT works: a new contract version (new contract_id) as the engine writes on a rules change
  select * into c from pred_contracts order by normalized_at desc limit 1;
  insert into pred_contracts select (jsonb_populate_record(null::pred_contracts, to_jsonb(c) || jsonb_build_object('contract_id', c.contract_id || '|proof-v2', 'normalized_at', now()))).*;
  r := r || '{"insert_new_version": true}';
  begin update pred_contracts set contract_id = contract_id where ctid in (select ctid from pred_contracts limit 1); r := r || '{"update_rejected": false}';
  exception when raise_exception then r := r || '{"update_rejected": true}'; end;
  begin delete from pred_contracts where ctid in (select ctid from pred_contracts limit 1); r := r || '{"delete_rejected": false}';
  exception when raise_exception then r := r || '{"delete_rejected": true}'; end;
  begin truncate pred_contracts cascade; r := r || '{"truncate_rejected": false}';
  exception when raise_exception then r := r || '{"truncate_rejected": true}'; end;
  update pred_events set updated_at = updated_at where ctid in (select ctid from pred_events limit 1);
  r := r || jsonb_build_object('pred_events_update_allowed', true, 'pred_events_truncate_guard', exists (select 1 from pg_trigger where tgrelid = 'pred_events'::regclass and tgname like '%truncate%'),
    'contracts_before', before, 'contracts_after_proof_insert', (select count(*) from pred_contracts), 'events_before', ev, 'events_after', (select count(*) from pred_events));
  raise exception 'PROOF_RESULT %', r::text;
end
$proof$;
