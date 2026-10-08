-- Read-only. Core lane runs since 2026-10-07 19:00Z joined to the 1-minute hot lane's scheduled time for the same minute.
-- Hot-lane schedule = captured_at of the ASOS observations it wrote that minute (seenAt = the cron's scheduledTime).
with s as (
  select run_id, scheduled_at, at started_at, worker_version, cron from pred_engine_runs
  where lane = 'core' and transition = 'STARTED' and at > '2026-10-07 19:00Z'),
e as (
  select run_id, transition, at ended_at, duration_ms, error, counts from pred_engine_runs
  where lane = 'core' and transition <> 'STARTED' and at > '2026-10-07 19:00Z'),
hot as (
  select date_trunc('minute', captured_at) m, min(captured_at) hot_at from pred_source_observations
  where captured_at > '2026-10-07 19:00Z' and observation_key like '%:asos:%' group by 1),
j as (
  select s.run_id, s.scheduled_at, s.started_at, left(s.worker_version, 8) wv, e.transition end_state, e.ended_at, e.duration_ms,
    (e.counts->'timing'->'phase_ms'->>'market_reads')::int market_ms, (e.counts->'timing'->'phase_ms'->>'ledger_writes')::int ledger_ms,
    (e.counts->>'errors')::int errors, (e.counts->>'events')::int events, (e.counts->'contracts')::text contracts, e.error,
    hot.hot_at,
    case when hot.hot_at is null then 'unknown' when abs(extract(epoch from s.started_at - hot.hot_at)) < 20 then 'yes' else 'no' end overlap,
    extract(second from s.scheduled_at)::int sched_sec,
    lag(s.scheduled_at) over (order by s.scheduled_at) prev_sched
  from s left join e using (run_id) left join hot on hot.m = date_trunc('minute', s.started_at))
select json_build_object(
  'window', json_build_object('from', min(scheduled_at), 'to', max(scheduled_at), 'core_starts', count(*)),
  'not_completed', count(*) filter (where end_state is distinct from 'COMPLETED'),
  'with_errors', count(*) filter (where errors > 0 or error is not null),
  'duplicate_scheduled_minutes', (select count(*) from (select date_trunc('minute', scheduled_at) from s group by 1 having count(*) > 1) d),
  'gaps_over_150s', (select json_agg(json_build_object('from', prev_sched, 'to', scheduled_at, 'gap_s', extract(epoch from scheduled_at - prev_sched)::int, 'wv', wv)) from j j2 where scheduled_at - prev_sched > interval '150 seconds'),
  'max_duration_ms', max(duration_ms),
  'over_60s', count(*) filter (where duration_ms > 60000),
  'over_90s', count(*) filter (where duration_ms > 90000),
  'by_phase', (select json_agg(x order by x->>'first') from (select json_build_object('wv', wv, 'sched_sec', sched_sec, 'n', count(*), 'first', min(scheduled_at), 'last', max(scheduled_at),
      'p50_ms', percentile_cont(0.5) within group (order by duration_ms)::int, 'p95_ms', percentile_cont(0.95) within group (order by duration_ms)::int,
      'p50_market_ms', percentile_cont(0.5) within group (order by market_ms)::int, 'p50_ledger_ms', percentile_cont(0.5) within group (order by ledger_ms)::int,
      'overlap_yes_no_unknown', count(*) filter (where overlap='yes') || '/' || count(*) filter (where overlap='no') || '/' || count(*) filter (where overlap='unknown'),
      'events', min(events) || '-' || max(events)) x
    from j group by wv, sched_sec having count(*) >= 2) q),
  'by_overlap', (select json_agg(x) from (select json_build_object('overlap', overlap,
      'n', count(*), 'p50_ms', percentile_cont(0.5) within group (order by duration_ms)::int, 'p50_market_ms', percentile_cont(0.5) within group (order by market_ms)::int, 'p50_ledger_ms', percentile_cont(0.5) within group (order by ledger_ms)::int) x
    from j group by overlap) q)
) from j;
