-- PROOF for 018: always aborts (RAISE at the end), so nothing persists. Append-only, origin/strategy/account pins,
-- account-scoped claims (a challenger claim can never take a control-shaped key), negative cash, mark key shape.
do $$
declare ok int := 0; h text := repeat('a', 64); z text := repeat('0', 64); begin
  insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-ARENA-TECH-1:1', 'S10-ARENA-TECH-1', 'ARENA_FORWARD_PAPER', 'TECH', 1, 'FUNDING', current_date, '{}', 'm', 'p', h, z, h);
  ok := ok + 1;                                                                                                        -- 1
  begin update pred_s10a_events set type = 'X' where event_key = 'S10-ARENA-TECH-1:1'; raise exception 'update allowed';
  exception when others then if sqlerrm = 'update allowed' then raise; end if; ok := ok + 1; end;                       -- 2
  begin delete from pred_s10a_events where event_key = 'S10-ARENA-TECH-1:1'; raise exception 'delete allowed';
  exception when others then if sqlerrm = 'delete allowed' then raise; end if; ok := ok + 1; end;                       -- 3
  begin insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-ARENA-TECH-1:2', 'S10-ARENA-TECH-1', 'FORWARD_PAPER', 'TECH', 2, 'FILL', current_date, '{}', 'm', 'p', h, z, h); raise exception 'control origin allowed';
  exception when others then if sqlerrm = 'control origin allowed' then raise; end if; ok := ok + 1; end;              -- 4
  begin insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-FWD-1:9', 'S10-FWD-1', 'ARENA_FORWARD_PAPER', 'TECH', 9, 'FILL', current_date, '{}', 'm', 'p', h, z, h); raise exception 'control account allowed';
  exception when others then if sqlerrm = 'control account allowed' then raise; end if; ok := ok + 1; end;             -- 5
  begin insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-ARENA-DIV-1:1', 'S10-ARENA-DIV-1', 'ARENA_FORWARD_PAPER', 'TECH', 1, 'FILL', current_date, '{}', 'm', 'p', h, z, h); raise exception 'strategy mismatch allowed';
  exception when others then if sqlerrm = 'strategy mismatch allowed' then raise; end if; ok := ok + 1; end;           -- 6
  begin insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-ARENA-TECH-1:1', 'S10-ARENA-TECH-1', 'ARENA_FORWARD_PAPER', 'TECH', 1, 'FILL', current_date, '{}', 'm', 'p', h, z, h); raise exception 'duplicate seq allowed';
  exception when others then if sqlerrm = 'duplicate seq allowed' then raise; end if; ok := ok + 1; end;               -- 7
  begin insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-ARENA-TECH-1:2', 'S10-ARENA-TECH-1', 'ARENA_FORWARD_PAPER', 'TECH', 2, 'FILL', current_date, '{}', 'm', 'p', 'nope', z, h); raise exception 'bad policy hash allowed';
  exception when others then if sqlerrm = 'bad policy hash allowed' then raise; end if; ok := ok + 1; end;             -- 8
  insert into pred_s10a_runs(run_key, account, kind, d) values ('S10-ARENA-DIV-1:EOD:2099-01-01', 'S10-ARENA-DIV-1', 'EOD', '2099-01-01');
  begin insert into pred_s10a_runs(run_key, account, kind, d) values ('S10-ARENA-DIV-1:EOD:2099-01-01', 'S10-ARENA-DIV-1', 'EOD', '2099-01-01'); raise exception 'double claim allowed';
  exception when others then if sqlerrm = 'double claim allowed' then raise; end if; ok := ok + 1; end;                -- 9
  begin insert into pred_s10a_runs(run_key, account, kind, d) values ('EOD:2099-01-02', 'S10-ARENA-DIV-1', 'EOD', '2099-01-02'); raise exception 'control-shaped claim allowed';
  exception when others then if sqlerrm = 'control-shaped claim allowed' then raise; end if; ok := ok + 1; end;        -- 10
  begin insert into pred_s10a_runs(run_key, account, kind, d) values ('S10-ARENA-TECH-1:EOD:2099-01-03', 'S10-ARENA-DIV-1', 'EOD', '2099-01-03'); raise exception 'cross-account claim allowed';
  exception when others then if sqlerrm = 'cross-account claim allowed' then raise; end if; ok := ok + 1; end;         -- 11
  begin insert into pred_s10a_marks(mark_key, account, d, kind, observed_at, cash_cents, coverage, positions, exposures)
    values ('S10-ARENA-TECH-1:EOD:2099-01-01', 'S10-ARENA-TECH-1', '2099-01-01', 'EOD_CLOSE', now(), -1, 1, '[]', '{}'); raise exception 'negative cash allowed';
  exception when others then if sqlerrm = 'negative cash allowed' then raise; end if; ok := ok + 1; end;               -- 12
  begin insert into pred_s10a_marks(mark_key, account, d, kind, observed_at, cash_cents, coverage, positions, exposures)
    values ('S10-ARENA-TECH-1:EOD:2099-01-02', 'S10-ARENA-TECH-1', '2099-01-01', 'EOD_CLOSE', now(), 1, 1, '[]', '{}'); raise exception 'mark key/date mismatch allowed';
  exception when others then if sqlerrm = 'mark key/date mismatch allowed' then raise; end if; ok := ok + 1; end;      -- 13
  insert into pred_s10a_marks(mark_key, account, d, kind, observed_at, nav_cents, cash_cents, coverage, positions, exposures)
    values ('S10-ARENA-TECH-1:EOD:2099-01-01', 'S10-ARENA-TECH-1', '2099-01-01', 'EOD_CLOSE', now(), null, 5, 0.5, '[]', '{}');
  ok := ok + 1;                                                                                                        -- 14 (NOT AVAILABLE mark accepted)
  begin truncate pred_s10a_runs; raise exception 'truncate allowed';
  exception when others then if sqlerrm = 'truncate allowed' then raise; end if; ok := ok + 1; end;                    -- 15
  insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-ARENA-ORIG-1:1', 'S10-ARENA-ORIG-1', 'ARENA_FORWARD_PAPER', 'ORIGINAL', 1, 'FUNDING', current_date, '{}', 'signal10-rank/1.0.0', 'signal10-manager/1.0.0', h, z, h);
  ok := ok + 1;                                                                                                        -- 16 (ORIGINAL arena account accepted)
  begin insert into pred_s10a_events(event_key, account, origin, strategy, seq, type, d, payload, model_version, policy_version, policy_sha256, prev_hash, hash)
    values ('S10-ARENA-TECH-1:3', 'S10-ARENA-TECH-1', 'ARENA_FORWARD_PAPER', 'ORIGINAL', 3, 'FILL', current_date, '{}', 'm', 'p', h, z, h); raise exception 'original on tech account allowed';
  exception when others then if sqlerrm = 'original on tech account allowed' then raise; end if; ok := ok + 1; end;   -- 17
  raise exception 'PROOF_RESULT % of 17 checks passed', ok;
end $$;
