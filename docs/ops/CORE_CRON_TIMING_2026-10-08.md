# pbe-predictions cron timing — evidence note (2026-10-08, read-only)

Decision (owner, 2026-10-08): measure, do not restructure Workers, do not add compute. Nothing in this note changes runtime.

Window: core runs scheduled 2026-10-07 19:00Z .. 2026-10-08 12:48Z (534 core starts), from `pred_engine_runs`.
Query: `core-cron-timing-2026-10-08.sql`; raw result: `core-cron-timing-2026-10-08.json`.
Hot-lane schedule is inferred from the `captured_at` of the ASOS rows it writes (`seenAt` = the 1-minute cron's
scheduled time). "Overlap" = the core start is within 20 s of that minute's hot-lane write. Minutes with no hot-lane
write are "unknown". Cloudflare's scheduled-invocation analytics were not used (the local credential is not authorised).

## What the data shows

| Core start overlaps the 1-minute hot lane | runs | p50 total | p50 market reads | p50 ledger writes |
|---|---|---|---|---|
| yes | 115 | 26.8 s | 8.4 s | 4.0 s |
| no | 153 | 6.3 s | 1.2 s | 1.1 s |
| unknown | 266 | 6.1 s | 1.1 s | 1.1 s |

By version and second-of-minute phase (p50 total):

| Worker version | phase | runs | p50 | p95 |
|---|---|---|---|---|
| a8a6cbc9 | :02 | 6 | 29.7 s | 33.5 s |
| 4d8cb251 | :02 | 25 | 26.6 s | 43.3 s |
| f69da80c | :02 | 60 | 27.2 s | 34.9 s |
| f69da80c | :57 | 45 | 7.0 s | 22.3 s |
| 3ceb0a39 | :57 | 9 | 6.9 s | 18.7 s |
| 3f50d75b | :57 | 369 | 6.0 s | 23.5 s |
| 4ca49ed0 (CPI SHADOW) | :57 | 2 | 6.2 s | 6.2 s |
| 4ca49ed0 (CPI SHADOW) | :06 | 18 | 28.2 s | 47.2 s |

Duration follows the phase, not the code: the same version (f69da80c) is ~27 s at :02 and ~7 s at :57, and 4ca49ed0 is
~6 s at :57 and ~28 s at :06. Counts are unchanged across the phase change (39 events, 481 contracts after the deploy).

## Against the owner's criteria

| Criterion | Result |
|---|---|
| Missed core interval | **Yes, once:** scheduled 12:08:57Z -> next 12:14:06Z (309 s; the 12:10 and 12:12 starts never fired) while Cloudflare moved the phase after the 12:05Z deploy. Earlier phase moves show 3-minute gaps (10-07 12:55->12:58, no deploy). Not caused by run duration. |
| Duplicate writes | **No.** The single minute with two core starts (10-07 22:00:02 and 22:00:57) is two distinct schedules during a phase move; separate run_ids, both COMPLETED, 0 forecasts written by either; ledger writes are insert-ignore on natural keys. |
| Timeouts / failures | **None.** 0 core runs without COMPLETED, 0 with errors. |
| Duration vs the 120 s core interval | Max 56.2 s; 0 runs over 60 s. |
| Stale forecasts | **Yes, briefly, around the deploy.** Core was not refreshed for the 309 s gap, and the 1-minute hot lane wrote no ASOS observations from 12:05 to 12:13Z (normally most minutes), catching up at 12:14-12:15Z (11 + 28 rows; `available_at` = when PBE saw them, so point-in-time stays honest). The 1-minute cron did fire at 12:09Z (the CPI lane ran). Earlier phase moves show the same kind of hot-lane hole, shorter: 10-07 22:04->22:09Z and 23:34->23:38Z. Practical rule: a Worker deploy can cost a few minutes of cadence; avoid deploying near a CPI cutoff (20:00 ET the day before a release) or a weather settlement window. |
| Newsroom lane (5-minute interval) | **Affected by the same overlap.** p50 ~20 s at :57 vs ~121-149 s at :02/:06. One run took 332 s (12:16:06Z) and the 12:21:06Z run was `SKIPPED_OVERLAP`; the 12:11Z newsroom start was missed in the phase move. Same pattern pre-CPI: 4 skips on f69da80c at :02. |

## Conclusion

No timeouts, no duplicate writes, core well inside its interval. The phase overlap costs ~20 s of core wall time and
~2 minutes of newsroom wall time, and phase moves (including the one a deploy triggers) can drop scheduled starts for a
few minutes (9 minutes of hot lane on 10-08, the longest seen). All of it predates CPI SHADOW.
Left as is per the owner. Worth re-measuring if the newsroom p95 approaches 300 s or skips become routine.
