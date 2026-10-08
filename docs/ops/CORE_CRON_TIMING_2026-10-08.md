# pbe-predictions cron timing — evidence note (2026-10-08, read-only)

Decision (owner, 2026-10-08): measure, do not restructure Workers, do not add compute. Nothing in this note changes runtime.

**Revision B (14:50Z): the cause is Cloudflare cron PLACEMENT (which colo runs the crons), not overlap with the 1-minute
hot lane.** Revision A (12:52Z, below the line) attributed the slow phase to hot-lane overlap. Cloudflare's own
scheduled-invocation data shows all three crons always fire in the same second, in fast and slow regimes alike, so "overlap"
cannot separate them. What changes at every phase shift is the colo.

Evidence files: `core-cron-timing-2026-10-08b.json` (this revision) and `core-cron-timing-2026-10-08.{sql,json}` (revision A).
Sources: `pred_engine_runs` (810 core runs scheduled 2026-10-07 11:20:58Z .. 2026-10-08 14:24:06Z);
Cloudflare GraphQL `workersInvocationsScheduled` (scheduled second per cron, sampled) and `workersInvocationsAdaptive`
by `coloCode` per hour (read with the local wrangler OAuth token; read-only).

## Placement explains the duration, to the hour

| Window (UTC) | Scheduled second, all 3 crons | Cron colo | Core p50 | Market reads p50 | Ledger writes p50 |
|---|---|---|---|---|---|
| 10-07 11:20 – 12:54 | :58 | FRA (Frankfurt) | 18.0 s | 4.7 s | 2.9 s |
| 10-07 12:58 – 22:00 | :02 | SIN (Singapore) | 29.1 s | 8.9 s | 4.1 s |
| 10-07 22:00 – 10-08 12:08 | :57 | EWR (Newark) | 6.1 s | 1.1 s | 1.1 s |
| 10-08 12:14 – now | :06 | SIN (Singapore) | 28.8 s | 8.7 s | 4.0 s |

- Every I/O phase slows by the same ~4-8x (market reads, ledger writes, designate/resolve/score), which is what
  round-trip distance to Supabase (tkmln) and the propsports-markets binding produces. CPU and counts do not change.
- The step happens at the shift instant, not with the time of day: 10-08 11Z (EWR) p50 6.3 s, then 28 s from 12:14Z (SIN).
- The same code runs in both regimes (f69da80c :02/SIN ~27 s and :57/EWR ~7 s; 4ca49ed0 :57/EWR ~6 s and :06/SIN ~28 s).
- About 100 invocations/hour run in the dominant colo = 30 core + 60 one-minute + 12 newsroom: the Worker's whole cron set
  moves together.
- A deploy can trigger a re-placement (12:05Z deploy -> SIN at 12:14Z) but does not have to (later shifts happened with no
  deploy). We cannot choose the colo from code without a config change (for example Smart Placement). That is
  architecture, so it is not proposed here.

## Against the owner's criteria (810 core runs)

| Criterion | Result |
|---|---|
| Real missed core interval | **4 even minutes of 813 had no core run.** 10-07 12:56 and 10-08 12:10 + 12:12 = ticks dropped while Cloudflare moved the schedule (phase shift / re-placement). 10-07 12:02 = `SKIPPED_OVERLAP`: the 12:00:58 run started 74 s late (top-of-hour) and ran 85.6 s; the lease refused the 12:02 start, as designed. All pre-date CPI except the 10-08 deploy shift. |
| Stale forecasts | **None that matter.** Longest gap between completed core runs: 357 s (10-08 12:08:57 -> 12:15:04, the shift). The newsroom max core age is 10 min, so no newsroom run saw a stale core. 0 forecast rows were due in that gap. |
| Duplicate writes | **None.** One minute had two core starts (10-07 22:00:02 and 22:00:57, a shift), with distinct run_ids, both COMPLETED, 0 forecasts each. `pred_forecasts` since 10-07 11:20Z: 2,266 rows, 0 duplicate record_ids, 0 identical consecutive rows (same contract, model, version, features hash and probability), 0 rows for the same contract and model < 2 min apart. |
| Timeouts / failures | **None.** 810/810 COMPLETED, 0 FAILED, 0 ABANDONED in the window (the 28 FAILED / 9 ABANDONED are 10-07 before 11:20Z, a separate earlier incident). 3 runs with a counted external error (IEM MOS, FRED, NWS gridpoint), all handled. |
| Duration vs the 120 s interval | p50 15.6 s, p90 31.2 s, p99 48.3 s, max 85.6 s. 2 runs >= 60 s (both 10-07, top of hour / shift), 0 >= 90 s. In the current SIN placement: max 56.2 s. No run was still in flight when the next one started. |
| Counts | Events 38-46, contracts 451-524; changes follow the Kalshi listings, not the regime. The 12:14Z shift kept 39/481 before and after. |

## Conclusion

The ~28 s cycles are Singapore placement. No missed interval caused by duration, no stale forecasts, no duplicate writes, no
timeouts, and the worst case (86 s) stays under the 120 s interval. Left as is per the owner.
Re-measure if: p99 core > 90 s, routine `SKIPPED_OVERLAP` on core, or newsroom p95 > 300 s.
Practical rule (unchanged): a Worker deploy can cost a few minutes of cadence. Do not deploy within an hour of a CPI cutoff
(20:00 ET the day before a release) or a weather settlement window.

---

## Revision A (12:52Z, superseded on cause; its counts stand)

Window 10-07 19:00Z .. 10-08 12:48Z (534 core starts). Hot-lane overlap was inferred from ASOS `captured_at`, and
Cloudflare analytics were not used then. "Overlap yes" runs had p50 26.8 s vs 6.3 s "no", and the phase split was
:02 ~27 s / :57 ~6-7 s / :06 ~28 s. Its findings on the 12:08:57 -> 12:14:06 gap, the 10-07 22:00 double start (no duplicate
writes), and the hot-lane hole 12:05-12:13Z on 10-08 (caught up 12:14-12:15Z with honest `available_at`) still hold.
Newsroom (5-minute lane): p50 ~20 s in EWR vs ~121-149 s in SIN; one 332 s run (10-08 12:16:06Z) and the 12:21:06Z run
`SKIPPED_OVERLAP`. Newsroom skips: 34 since 10-07 08:37Z, all `SKIPPED_OVERLAP`, no failures.
