# Changing a cron schedule on pbe-predictions safely

Cron triggers are deployment state that is **separate from the Worker code**, and changes to them are not instant.
Read this before changing any entry in `wrangler.jsonc` `triggers.crons` or `CRONS` in `src/engine-runs.js`.

## What we observed (2026-10-04, cadence change e115a57)

| time (UTC) | event |
|---|---|
| 23:00:59 | last tick of the old core schedule `*/15` (completed) |
| 23:03:37 | `wrangler deploy` of Worker db2cf406: crons `*/2`, `* * * * *`, `1,6,...,56` |
| 23:03:40 | CF API `GET .../workers/scripts/pbe-predictions/schedules` already lists the new crons (`modified_on`) |
| 23:07, 23:15 | old newsroom / old core ticks **did not fire**: the replaced schedules stopped immediately |
| 23:24:47 | first `*/2` core tick (~21 min after deploy) |
| 23:26:47 | first `1,6,...,56` newsroom tick |
| throughout | the unchanged `* * * * *` entry kept firing (FAST lane writes 23:01–23:28) |

Result: **23 minutes with no core run and no newsroom run.** Cloudflare documents up to ~15 minutes for cron
changes to propagate; we saw ~21. Ticks arrive at `:47`–`:59` seconds past the minute; `scheduled_at` in the run
ledger reflects that, so do not expect `:00`.

Rules that follow:

1. **A deploy does not mean the cadence changed.** The schedules API shows the new crons within seconds; that is
   configuration, not execution. Only the run ledger proves execution.
2. **A replaced cron stops at once; a new cron starts late; an unchanged cron keeps running.** Plan for a gap
   unless you use the overlap procedure below.
3. **Worker-version rollback alone is insufficient.** `wrangler rollback` / `wrangler versions deploy <old>` change
   the code but NOT the triggers. Code dispatches lanes by cron identity (`laneFor`): an older version that does not
   know the live cron string logs `unknown_cron` and runs no lane, so the core silently stops. Always roll back by
   redeploying source with its own `wrangler.jsonc` (`wrangler deploy`), and expect the same propagation delay.
4. **Code-only releases must not touch triggers.** Use `wrangler versions upload` then
   `wrangler versions deploy <id>@100%`; these leave schedules alone (verified 2026-10-05 00:22Z: `modified_on`
   unchanged). `wrangler deploy` always re-sends the trigger set.

## How to verify a new trigger is firing

The run ledger records the cron string of every tick:

```sql
select lane, cron, min(scheduled_at) first_tick, max(scheduled_at) last_tick, count(*)
from pred_engine_runs where transition = 'STARTED' and scheduled_at > now() - interval '2 hours'
group by 1, 2 order by 3;
```

The new schedule is live when it has **at least two consecutive ticks at the expected spacing**, each followed by
`COMPLETED`, and `/api/summary` `engine.cadence_minutes` shows the new value with `engine.state = healthy`.
(`cadence_minutes` comes from the deployed code, so it changes at deploy time; it is not evidence of firing.)

## Gap-free procedure (overlap, then retire)

1. **Add, do not replace.** Deploy code whose `laneFor` maps BOTH the old and the new cron string to the same lane,
   with both strings in `triggers.crons`. The old entry is unchanged, so it keeps firing; the new one starts after
   propagation. Duplicate execution is prevented by the lease: two ticks for the same lane in the same minute (e.g.
   `:00` matches `*/15` and `*/2`) give one run plus one `SKIPPED_OVERLAP` (or a second back-to-back run if the first
   already finished). Both are safe: every write is idempotent and dedupe is keyed on inputs.
2. **Wait for proof** with the query above: the new cron has two consecutive completed ticks.
3. **Retire the old entry.** Deploy with only the new cron (and `laneFor` mapping only the new string). The old
   schedule is retired once this deploy is done AND the ledger shows no tick from it for one full old interval. Until
   then, treat both as possibly live.
4. Record both Worker versions and the trigger set in `docs/ops/ROLLBACK.md`.

During step 1 the lane's health reads the shorter cadence from code. `SKIPPED_OVERLAP` rows created by the
deliberate overlap are expected. Explain them in the release note so they are not read as an incident.

## Checklist for any schedule change

- [ ] Owner approval for the cadence (fallback rule: 3 minutes, never 15 without approval)
- [ ] Overlap deploy (both crons) → ledger shows new cron firing twice → retire deploy
- [ ] Schedules API checked after each deploy (`GET /accounts/<acct>/workers/scripts/pbe-predictions/schedules`)
- [ ] `/api/summary` healthy at the new cadence; no `unknown_cron` in logs
- [ ] ROLLBACK.md updated with versions + trigger sets; rollback = redeploy source, never version-only
