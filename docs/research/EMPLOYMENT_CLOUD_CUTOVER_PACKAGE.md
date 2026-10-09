> **SUPERSEDED 2026-10-09T13:57Z by the owner's directive** (Issue #3 comment 6082392799):
> - B3 adopted; immediate cloud-only cutover.
> - The Windows/GitHub history import (steps 2-4 below) is **rejected**. It is replaced by a fresh authoritative GENESIS:
>   `POST /admin/genesis`, which requires an empty auth namespace and an empty R2 root, and an RFC 3161 anchor.
> - **Windows is not a rollback.** Rollback is Cloudflare-only: deploy MODE=shadow or off, or roll back the Worker version.
> - `upload-historical.mjs` and the `/admin/historical` and `/admin/seed-auth` routes are removed.
> - The actual cutover record is in Issue #3.

# Employment Tier A: Cloudflare cutover package (PREPARED; NOT APPROVED, NOT EXECUTED)

Status 2026-10-09. Windows remains the authoritative collector. The cutover runs only after the owner's explicit approval
**and** the owner's adoption of Amendment B3 (or an equivalent). Nothing below has been executed.

## Readiness

| Gate | Status | Evidence |
|---|---|---|
| Scheduled cloud collection | PASS | Durable Object alarm every 5 min, intervals 300 s ± 40 ms, no gaps (cron unusable: account over its 250-trigger limit) |
| Signed Kalshi GET from Cloudflare | PASS | Dedicated key, `signed:ed25519`; 27/27 order books in the 13:05:59Z ADHOC capture |
| Cloud vs Windows, same second | PASS | 13:05:59Z: started 10 ms apart. 33/33 identical file names, URLs and HTTP 200. Recorded hashes match bytes on both sides. 30/33 files byte-identical. Tickers, rules hashes, fee settings, terms PDF hashes, close-date checks and 27/27 fee calculations match. 3 KXPAYROLLS books differ in depth only (same best bid/ask): a live market change between the two fetches |
| Other sources | PASS | DOL `data.pdf` and the BLS schedule are byte-identical to the Windows captures |
| Evidence integrity | PASS | Write-once R2, 16 bucket-lock rules (overwrite rejected in test), hash-chained ledger with a seal per tick, RFC 3161 anchors |
| Independent verifier | PASS | `scripts/research/employment/collector/verify-r2.mjs`: 46/46 shadow objects, 27 books re-derived, 1/1 anchor `openssl ts -verify` OK; tampering detected |
| Alerts | PASS | Cloudflare Email Routing; test email sent; fault drill delivered a real alert |
| Cost | PASS | About $0.03/month (first-hour measurement) |
| Tests | PASS | Employment 24/24; full suite 476/480, the same 4 pre-existing failures |
| Cloud cutoff rehearsal `cloud-20261009` | PENDING | Window 2026-10-09 23:45–00:00Z; read out with `verify-r2.mjs --ns rehearsal:cloud-20261009` |
| Amendment B3 | OWNER DECISION | `EMPLOYMENT_V2_AMENDMENT_B3_PROPOSED.md` |
| Cutover approval | OWNER DECISION | |

**Found and fixed during preparation: Windows/GitHub line-ending conversion.** Git for Windows' system-wide
`core.autocrlf=true` had silently converted line endings in one archived BLS schedule HTML when it was committed. The
GitHub copy was 55,339 bytes against the 55,578-byte original (sha256 `8a61955e…`, as recorded in the capture).
- The evidence repo now has the local setting `core.autocrlf=false`.
- The collector's own tick `c9db2f3` re-committed the original bytes, and GitHub now serves `8a61955e…`.
- Every future BLS HTML capture on Windows is stored byte-exact.
- The cloud collector has no git and was never affected.
- The upload tool checks each file byte-for-byte against its committed blob and refuses any mismatch (this is how the
  bug was found). All 47 files at `c9db2f3` pass.

## Procedure (about 30 minutes, at least 48 h away from any slot window)

1. **Freeze Windows.** Right after a tick logs in `E:\Workers\employment-evidence\.state\ticks.log`, and with
   `.state\lock` absent, run `Disable-ScheduledTask` for `\PropBetEdge-Research\EmploymentCollector-Tick` and `-Wake`.
   Confirm the last push: local HEAD = `git ls-remote origin refs/heads/main`, and `git status` is clean.
2. **Import the history** (cloud still in shadow):
   `node workers/pbe-employment-collector/scripts/upload-historical.mjs E:\Workers\employment-evidence https://pbe-employment-collector.sales-fd3.workers.dev C:\Users\goodl\.pbe-employment-collector\admin-token`
   - It requires a clean clone, `git fsck --strict`, HEAD = GitHub main, and every file equal to its committed blob.
   - The Worker checks each sha256 before writing.
   - Uploads are write-once and land under bucket locks.
3. **Seed the authoritative namespace:** `POST /admin/seed-auth`. It builds the `auth` index from R2 (index, `enabled_at`,
   calendar) and opens the auth chain with an IMPORT entry that seals every imported object's sha256.
4. **Verify before switching:** `node scripts/research/employment/collector/verify-r2.mjs --ns auth` must return
   `ok: true`, with an object count equal to the import count.
5. **Switch:** set `"MODE": "authoritative"` in `wrangler.jsonc`, commit, push, and deploy with
   `node workers/pbe-employment-collector/scripts/deploy.mjs`.
6. **Prove:** the next alarm tick writes into `auth` with `trigger=alarm`, `/health` is 200, and
   `verify-r2.mjs --ns auth` is OK. The gap between the last Windows tick and the first auth tick is recorded honestly as a
   GAP; nothing is backfilled.
7. **Retire Windows** after the first authoritative release cycle passes (for example the Nov 6 T-7D/T-3D/T-1D slots):
   unregister the tasks and revoke the evidence deploy key 165826310. Until then the tasks stay disabled, not deleted.

## Rollback (any time before step 7)

1. Set `"MODE": "shadow"` and deploy (or `wrangler rollback` to the previous version).
2. `Enable-ScheduledTask` for Tick and Wake. The first Windows tick records the GAP honestly.
3. Nothing is deleted in either direction. R2 `auth` evidence stays locked and verifiable, and the GitHub history is unchanged.

## Current versions

- Worker `pbe-employment-collector`, code commit `7d5d359` plus later docs and verifier commits, version `beb04cd0`.
  MODE=shadow; alarm scheduler; no cron.
- R2 bucket `pbe-employment-evidence` (ENAM); Durable Object `CollectorState`; `send_email` binding `EMAIL`.
- Windows: pinned `D:\Workers\employment-collector` @ `9f0b3f6`; evidence `E:\Workers\employment-evidence` @ `c9db2f3`
  (= GitHub).
