-- PROOF for 017: always aborts (RAISE at the end), so nothing persists. Checks the claim lease, constraints and RLS.
do $$
declare ok int := 0; n int; begin
  insert into pred_market_tape_jobs(session_date, file_link, file_size) values ('2099-01-02', 'https://example.test/x', 1);
  select count(*) into n from pred_market_tape_claim('2099-01-02', 'A', 60);
  if n = 1 then ok := ok + 1; end if;                                   -- free lease -> claimed
  select count(*) into n from pred_market_tape_claim('2099-01-02', 'B', 60);
  if n = 0 then ok := ok + 1; end if;                                   -- held lease -> second claim refused
  update pred_market_tape_jobs set lease_until = now() - interval '1 second' where session_date = '2099-01-02';
  select count(*) into n from pred_market_tape_claim('2099-01-02', 'B', 60);
  if n = 1 then ok := ok + 1; end if;                                   -- expired lease -> reclaimable
  update pred_market_tape_jobs set status = 'DONE', lease_until = null where session_date = '2099-01-02';
  select count(*) into n from pred_market_tape_claim('2099-01-02', 'C', 60);
  if n = 0 then ok := ok + 1; end if;                                   -- DONE jobs are never claimed
  begin update pred_market_tape_jobs set bit_offset = 8 where session_date = '2099-01-02'; raise exception 'bad bit allowed';
  exception when others then if sqlerrm = 'bad bit allowed' then raise; end if; ok := ok + 1; end;
  begin update pred_market_tape_jobs set status = 'X' where session_date = '2099-01-02'; raise exception 'bad status allowed';
  exception when others then if sqlerrm = 'bad status allowed' then raise; end if; ok := ok + 1; end;
  select count(*) into n from pg_class where relname = 'pred_market_tape_jobs' and relrowsecurity;
  if n = 1 then ok := ok + 1; end if;                                   -- RLS on
  raise exception 'PROOF_RESULT % of 7 checks passed', ok;
end $$;
