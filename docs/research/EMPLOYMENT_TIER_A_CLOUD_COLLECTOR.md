# Employment Tier A collector on Cloudflare Workers (`pbe-employment-collector`)

## Decisions and scope

- **2026-10-09, owner direction:** Cloudflare Workers is the permanent runtime for the Tier A collector.
- **Resources approved** ("yes, create it", under $1/month): Worker `pbe-employment-collector`, R2 bucket `pbe-employment-evidence`, Durable Object `CollectorState`, a 5-minute cron.
- **2026-10-09, owner correction:** no GitHub at runtime. R2 is the authoritative evidence archive. The historical GitHub evidence repo stays intact and read-only.
- **Scope is unchanged:** data and market prices only. No fitting, no forecasts, no trading. Tier B stays on HOLD.
- **Isolation:** this is a separate Worker. CPI SHADOW, pbe-predictions, tkmln and customer-facing systems are not touched.

## What stays identical

The rules are **shared, not copied**: the Worker imports `scripts/research/employment/collector/lib.mjs`, the module
the Windows collector runs. It covers:
- the T-7D/T-3D/T-1D slots at 20:00 America/New_York, with the window [slot - 15 min, slot);
- MISSED with no backfill, and the enabled-at guard;
- settlement captures at +1 and +3 days;
- the BLS capture windows;
- order-book derivation (YES ask = 1 - best NO bid);
- the quadratic taker fee.

`src/collector.js` ports `collect.mjs` line for line. It keeps the same requests, the same file names, the same
snapshot, capture and settlement fields, and the same ledger and alert kinds.

**Replay equivalence: PASS.** `scripts/replay-equivalence.mjs` replays the bytes the Windows collector recorded through
the Worker code:
- 4/4 snapshots are identical (the 3 rehearsal T-1D captures and the real ADHOC capture);
- all 27 books, the fees, rules hashes, file sha256s and statuses match;
- negative control: a single tampered byte is detected.

## Architecture (no GitHub, git, SSH or local disk)

| Need | Cloudflare mechanism |
|---|---|
| Schedule | Cron Trigger `*/5 * * * *` (slot windows get ticks at :45, :50 and :55) |
| Original bytes | R2 `pbe-employment-evidence`. Write-once in code: a rewrite with different bytes fails the tick. R2 checks each upload's sha256 server-side and stores it as metadata. **R2 bucket lock rules** make evidence prefixes non-deletable and non-overwritable at the platform level. |
| State, idempotency, concurrency | SQLite Durable Object `CollectorState`:<br>- one lease per namespace;<br>- scheduler state;<br>- capture index (written only after the bytes are in R2);<br>- append-only ledger and tick rows. |
| Audit trail | Hash-chained ledger (`seq`/`prev`/`hash`). Each tick's `TICK_SEAL` entry seals the sha256 of every evidence object it wrote. The chain is held as one write-once R2 object per tick (`ledger-ticks/`) plus Durable Object rows. A failed ledger write never advances the chain and carries the entries to the next tick. The daily heartbeat checks the R2 tail against the Durable Object head. |
| Timestamps | Cloudflare's NTP-disciplined runtime clock. Every response's server `Date` header is kept, and the median difference is checked (CLOCK alert above 2 s). The external, non-backdatable time of storage is the R2 upload time (see verify). |
| Kalshi | Signed Ed25519 reads (`src/kalshi-auth.js`, vendored from propsports-markets). Unsigned requests from Cloudflare are rate-limited, so **without a key no trade-API request is sent**. |
| Health / alerts | `GET /health` (503 when the last tick is over 15 min old, errored, or has unsealed entries). Every alert goes to the ledger and to the ntfy/Slack webhook ([SHADOW]-prefixed in shadow). A healthchecks.io ping each tick acts as the dead-man's switch. |
| Verification | `GET /admin/verify?ns=` checks, end to end:<br>- object hashes and recorded file hashes;<br>- order-book re-derivation;<br>- MISSED vs OK per slot;<br>- the ledger chain against the Durable Object head;<br>- sealed files still present with their sealed hash;<br>- `timestamp_proof` (R2 upload time vs completion, slot and release). |

## Cloudflare compatibility (measured 2026-10-09 from the Workers runtime)

- BLS schedule, current and archive pages; DOL `data.pdf` and the press listing; Kalshi terms PDFs: all 200, byte-identical to direct downloads.
- Kalshi trade API, unsigned: blocked (429 from Cloudflare egress, recorded 2026-10-03; not re-probed).
- Kalshi trade API, signed: works (propsports-markets, read budget 200/s). This collector needs about 35 reads per snapshot.
- Limits: about 40 subrequests per tick against 10,000; a snapshot takes about 10 s against a 15-minute cron wall limit.

## GitHub requirements (flagged, not changed)

V2 protocol B2.5 (frozen) defines capture validity by the GitHub push record. **Proposed Amendment B3**
(`EMPLOYMENT_V2_AMENDMENT_B3_PROPOSED.md`) gives the cloud-native equivalent. It awaits the owner's decision; until
then cloud captures are shadow evidence only.

## Modes

| `MODE` | Writes | Alerts / healthcheck |
|---|---|---|
| `shadow` (deployed) | R2 `shadow/`, namespace `shadow` | webhook `[SHADOW]`, `SHADOW_HEALTHCHECK_URL` |
| `authoritative` (only after owner-approved cutover) | R2 root, namespace `auth` | webhook, `HEALTHCHECK_URL` |
| `off` | nothing | none |

`REHEARSAL` adds an isolated cutoff-window rehearsal under `rehearsal/<id>/`: Kalshi slots only, no external alerts.
Deploy only with `scripts/deploy.mjs`. It refuses a dirty or unpushed tree, runs the tests, and stamps `CODE_COMMIT` and
`CODE_FILES` (the sha256 of each source file) into every capture.

## Proposed cutover (NOT approved; needs separate owner approval and an adopted B3)

1. `Disable-ScheduledTask` for `EmploymentCollector-Tick` and `-Wake`. Wait for the last tick and confirm it pushed (git log).
2. `node scripts/upload-historical.mjs E:\Workers\employment-evidence <worker-url> <admin-token-file>`. It requires:
   - a clean clone;
   - `git fsck --strict`;
   - HEAD = GitHub main;
   - every file equal to its committed blob.

   It uploads byte-for-byte into the R2 root through `PUT /admin/historical`, where the sha256 is checked before writing.
3. `POST /admin/seed-auth`. This builds the `auth` index from R2 and opens the auth chain with an IMPORT entry that seals every imported object.
4. `wrangler deploy` with `MODE=authoritative` (through `deploy.mjs`), then run `/admin/verify?ns=auth`.

**Rollback:**
1. Redeploy with `MODE=shadow` (or roll back the Worker version).
2. Re-enable the Windows tasks.

The R2 archive and the historical GitHub repo are both kept. Nothing is deleted in either direction.
