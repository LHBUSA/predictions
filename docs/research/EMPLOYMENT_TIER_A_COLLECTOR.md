# Employment Tier A collector (owner-approved 2026-10-08; data and prices only)

Owner authorization 2026-10-08: Tier A prospective data collection only, under goodl-c0's exclusive ownership.
- No model fitting, forecast generation or live trading.
- No contact with CPI SHADOW, the pbe-predictions Worker, tkmln or any customer-facing surface.
- Tier B (forecast capture) stays on HOLD.
- The V1 evidence and the V2 protocol are unchanged by this collector.

## Components

| Part | Location |
|---|---|
| Code (this repo, public) | `scripts/research/employment/collector/{collect.mjs, lib.mjs}`; tests `test/employment-collector.test.js` |
| Running copy (pinned) | `D:\Workers\employment-collector`: a detached git worktree of this repo at the commit recorded in every capture's `code.commit`. Edits elsewhere never change the running code. |
| Evidence (private) | GitHub `LHBUSA/pbe-employment-evidence` (private, owner-only access); local clone `E:\Workers\employment-evidence` (Samsung T7 USB SSD, migrated from D: on 2026-10-08; all files hash-identical, `git fsck --strict` clean; old copy kept read-only as `D:\Workers\employment-evidence.pre-migration-20261008`). Branch protection on `main`: no force-push, no deletion, enforced for admins (a test force-push was rejected). |
| Local state (not evidence) | `E:\Workers\employment-evidence\.state\` (git-ignored): tick log, lock, alert de-dup, throttles, `pushed-heads.log` (used to detect a rewritten remote) |
| Scheduler | Windows Task Scheduler: `\PropBetEdge-Research\EmploymentCollector-Tick`, every 5 min plus at logon; `\PropBetEdge-Research\EmploymentCollector-Wake`, daily 07:40 and 18:40 America/Chicago (08:40/19:40 ET), wakes the PC |
| Launcher | `D:\Workers\employment-collector-run.vbs` (hidden window): sets `EMP_EVIDENCE_DIR=E:\Workers\employment-evidence`, runs `node collect.mjs tick`. A missing E: drive is alerted from a C: fallback log. |
| Credentials | None for Kalshi/BLS/DOL (public endpoints). Evidence pushes use an SSH **deploy key** with write access to `pbe-employment-evidence` only. The key and the pinned GitHub host key are in `C:\Users\goodl\.pbe-employment-collector\` (NTFS, ACL: goodl, SYSTEM, Administrators; inheritance removed). Nothing depends on Windows Credential Manager, and no token is in source or in the repo. The same folder holds `alert-webhook-url` and `healthcheck-url` when configured, plus `fallback.log`. |

## Schedule (all times America/New_York; DST from the named zone)

| What | When |
|---|---|
| Kalshi snapshot, KXU3 + KXPAYROLLS event of each release | T-7D, T-3D, T-1D at 20:00; counts only if it completes inside [slot - 15 min, slot). Every tick in the window takes one (up to 3 per slot). |
| Settlement facts | Release + 1 day and + 3 days |
| BLS Employment Situation (current page + dated archive) | From release + 30 s; retried every 10 min until the page title shows the reference month |
| DOL weekly claims (`dol.gov/ui/data.pdf`) | Weekdays 08:31-20:00, every 30 min (every 4 min Thursday 08:31-10:00); a new document is stored on first sight. Dated archive copies from `oui.doleta.gov/press/<year>/` every 6 h. |
| BLS release calendar | Daily after 06:00; changes are archived and alerted |
| Heartbeat | Daily (ledger entry + commit) |

A snapshot holds:
- the full order book for every listed contract, plus the derived executable best bid/ask with sizes, depth, mid and
  spread;
- the market record (quotes, volume, open interest, rules hashes);
- the series fee settings and the taker fee for 1 contract;
- the contract-terms PDFs, stored once per sha256;
- per-request UTC timestamps, with server Date and Last-Modified headers;
- the clock record and the code identity.

## Timestamps

Windows Time (w32time) is stopped on this host and cannot be started without admin. Each run therefore measures its
clock offset by SNTP against time.cloudflare.com, time.google.com and time.windows.com. It records every `*_utc` field
as local clock + median offset, alongside the raw samples. An alert fires if the offset is over 2 s or no server
answers. Owner fix: run `owner-admin-setup.ps1` (this folder) elevated. It enables Windows Time with explicit NTP peers and switches both tasks to S4U, so they run whether or not anyone is signed in. Until then a WINDOWS_TIME_STOPPED alert is logged daily.
The external proof of time is the GitHub push record of the evidence repo. Git commit dates are self-reported.

## Missed runs and no-backfill

- Every tick records its time. A silence of more than 15 minutes becomes a `GAP` ledger entry (from, to, minutes) when
  the next tick runs, with an alert at 60 minutes or more.
- A Kalshi slot with no complete on-time snapshot gets `kalshi/<release>/<slot>/MISSED.json` plus an alert. Nothing is
  ever written into a closed slot.
- `verify` fails if a slot has both MISSED and an on-time OK snapshot.
- BLS and DOL documents stay publicly archived, so a late fetch is kept with its true fetch time and a
  seconds-after-release figure. It is never presented as on time.

## Alerts

Each alert is a ledger entry plus a Windows toast. Off-machine, it also opens a GitHub issue in the evidence repo and
posts to the webhook if configured (an ntfy.sh topic URL gets a plain-text push; any other URL gets Slack-style JSON). An optional dead-man's-switch URL (`healthcheck-url`) is pinged on every successful tick. It is the only channel that can report a machine that is completely off. External alerts go out at most once per kind per ET day; the ledger keeps every
occurrence. GitHub does not notify an account about issues it opened itself. For a push notification off this
machine, the owner must supply a webhook (secret file above).
Alert kinds: MISSED_SNAPSHOT, SNAPSHOT_INCOMPLETE, CALENDAR_MISMATCH, CALENDAR_CHANGED, OFFLINE_GAP, CLOCK,
BLS_LATE, DOL_FETCH_FAILED, DOL_STALE, DISK_LOW (< 1.5 GB free; D: had 3.0 GB free on 2026-10-08), PUSH_FAILING,
TICK_ERROR, SCHEDULE_*.

## Runbook

```
node D:\Workers\employment-collector\scripts\research\employment\collector\collect.mjs status
node D:\Workers\employment-collector\scripts\research\employment\collector\collect.mjs verify
type E:\Workers\employment-evidence\.state\ticks.log
Get-ScheduledTaskInfo -TaskPath \PropBetEdge-Research\ -TaskName EmploymentCollector-Tick
Disable-ScheduledTask -TaskPath \PropBetEdge-Research\ -TaskName EmploymentCollector-Tick   # stop collection
```
Updating the collector: commit on `employment-v1`, then `git -C D:\Workers\employment-collector checkout --detach <commit>`.
Every capture records the commit it ran.
