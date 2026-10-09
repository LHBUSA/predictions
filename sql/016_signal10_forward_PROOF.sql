-- PROOF for 016: always aborts (RAISE at the end), so nothing persists. Checks append-only + origin pin + run claim.
do $$
declare ok int := 0; begin
  insert into pred_s10_events(event_key, account, origin, seq, type, d, payload, model_version, policy_version, prev_hash, hash)
    values ('PROOF:1', 'PROOF', 'FORWARD_PAPER', 1, 'FUNDING', current_date, '{}', 'm', 'p', repeat('0', 64), repeat('a', 64));
  ok := ok + 1;
  begin update pred_s10_events set type = 'X' where event_key = 'PROOF:1'; raise exception 'update allowed';
  exception when others then if sqlerrm = 'update allowed' then raise; end if; ok := ok + 1; end;
  begin delete from pred_s10_events where event_key = 'PROOF:1'; raise exception 'delete allowed';
  exception when others then if sqlerrm = 'delete allowed' then raise; end if; ok := ok + 1; end;
  begin insert into pred_s10_events(event_key, account, origin, seq, type, d, payload, model_version, policy_version, prev_hash, hash)
    values ('PROOF:2', 'PROOF', 'HISTORICAL_REPLAY', 2, 'FILL', current_date, '{}', 'm', 'p', repeat('0', 64), repeat('b', 64)); raise exception 'replay origin allowed';
  exception when others then if sqlerrm = 'replay origin allowed' then raise; end if; ok := ok + 1; end;
  begin insert into pred_s10_marks(mark_key, account, d, kind, observed_at, cash_cents, coverage, positions)
    values ('PROOF:M', 'PROOF', current_date, 'INTRADAY', now(), -1, 1, '[]'); raise exception 'negative cash allowed';
  exception when others then if sqlerrm = 'negative cash allowed' then raise; end if; ok := ok + 1; end;
  insert into pred_s10_runs(run_key, account, kind, d) values ('EOD:2099-01-01', 'PROOF', 'EOD', '2099-01-01');
  begin insert into pred_s10_runs(run_key, account, kind, d) values ('EOD:2099-01-01', 'PROOF', 'EOD', '2099-01-01'); raise exception 'double claim allowed';
  exception when others then if sqlerrm = 'double claim allowed' then raise; end if; ok := ok + 1; end;
  raise exception 'PROOF_RESULT % of 6 checks passed', ok;
end $$;
