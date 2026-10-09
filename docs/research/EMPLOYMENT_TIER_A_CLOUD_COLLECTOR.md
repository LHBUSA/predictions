# Employment Tier A collector on Cloudflare Workers (`pbe-employment-collector`)

Owner direction, 2026-10-09: move the Tier A collector off the Windows PC and onto Cloudflare Workers, keeping every
approved collection rule and every evidence-integrity rule. Scope is unchanged: data and market prices only. No model
fitting, no forecasts, no trading. Tier B stays on HOLD. CPI SHADOW, pbe-predictions, tkmln and customer-facing systems
are not touched; this is a separate Worker.

## What stays identical

The rules module is **shared, not copied**. `workers/pbe-employment-collector` imports
`scripts/research/employment/collector/lib.mjs`, the same file the Windows collector runs. That module defines:
- the T-7D / T-3D / T-1D slots at 20:00 America/New_York, with the window [slot - 15 min, slot);
- MISSED with no backfill, and the enabled-at guard;
- settlement captures at +1 day and +3 days;
- the BLS current and archive capture windows;
- order-book derivation (YES ask = 1 - best NO bid);
- the quadratic taker fee.

`src/collector.js` is a line-for-line port of `collect.mjs`: the same requests, the same file names, the same
`snapshot.json`, `capture.json` and `settlement.json` fields, and the same ledger entry types and alert kinds.

**Replay equivalence: PASS (2026-10-09).** `scripts/replay-equivalence.mjs` served the raw bytes recorded by the
Windows collector, URL for URL, to the Worker's capture code and compared every derived field.
- All 4 snapshots tested are equivalent: the 3 rehearsal T-1D captures and the real ADHOC capture.
- File names, URLs, statuses, byte counts and sha256s match.
- All 27 order books, the fees, the rules hashes, the market records, completeness and the close-date checks match.
- Negative control: changing one order-book byte makes the check fail on both the series and the files.

## What is replaced

| Windows | Cloudflare |
|---|---|
| Task Scheduler, every 5 min while signed in | Cron Trigger `*/5 * * * *` |
| `E:\` evidence clone | R2 bucket `pbe-employment-evidence`. Write-once: rewriting a key with different bytes fails the tick. R2 verifies each upload's sha256 server-side. |
| `.state/` files and lock file | SQLite Durable Object `CollectorState`: lease (single writer), scheduler state, capture index, append-only ledger, tick log, mirror retry queue |
| git + SSH deploy key push | GitHub REST API (fine-grained token). Each blob's git object id is checked against our bytes, and refs are updated without force (branch protection unchanged). Failures queue and retry; R2 keeps the originals. |
| SNTP + Windows Time | Cloudflare's NTP-disciplined runtime clock. Every response's server `Date` header is kept, and the median difference is checked (CLOCK alert above 2 s). |
| Windows toast + `gh` issue | ntfy/Slack webhook + GitHub issue + `/health` (503 when stale) + healthchecks.io dead-man's switch |
| Node `fs` / `child_process` | none: R2, Durable Object and `fetch` only |

## Cloudflare compatibility (measured 2026-10-09 09:21Z from the Workers runtime, colo ORD)

| Source | Result |
|---|---|
| BLS schedule, `empsit.htm`, dated archive | 200, bytes identical to a direct fetch |
| DOL `ui/data.pdf`, `oui.doleta.gov/press/2026/` | 200, bytes identical |
| Kalshi contract-terms PDFs (`assets.kalshi.com`) | 200, identical; sha256 `bb568889…` = the stored U3 terms |
| Kalshi trade API, **unsigned** | **Blocked**: HTTP 429 from Cloudflare egress on both documented hosts (recorded 2026-10-03, CloudFront). Not re-probed, on owner instruction. |
| Kalshi trade API, **signed** (Ed25519 API key) | Works from Cloudflare (propsports-markets since 2026-10-03; read budget 200/s). The collector uses ~35 reads per snapshot. |

The existing `propsports-markets` `/admin/kalshi` passthrough was not used, for three reasons:
- its path allowlist excludes `/markets/{ticker}/orderbook`;
- it re-serializes the body, so the original bytes are lost;
- it requires the broad admin token.

The collector therefore signs its own requests with `src/kalshi-auth.js`, vendored unchanged from propsports-markets
@ 6ca6c0e. **Without a key it fails closed and sends no trade-API request.**

Limits: Workers Paid allows 10,000 subrequests per invocation; the largest tick (one snapshot) makes about 40. Cron
wall time can reach 15 minutes; a snapshot takes about 10 s.

## Modes, shadow and cutover

| `MODE` | Writes | GitHub | Alerts |
|---|---|---|---|
| `shadow` | R2 `shadow/`, namespace `shadow` | never | webhook only if `SHADOW_ALERTS=true` |
| `authoritative` | R2 root, namespace `auth` | mirror to `LHBUSA/pbe-employment-evidence` | webhook + issue + healthcheck |
| `off` | nothing | nothing | none |

A single authoritative writer is guaranteed by construction:
- shadow never writes GitHub or the R2 root;
- the Windows tasks are disabled before `MODE=authoritative` is deployed.

`REHEARSAL` adds an isolated cutoff-window run under `rehearsal/<id>/`: Kalshi slots only, no GitHub, no external alerts.

**Cutover**, after the shadow passes:
1. Disable the Windows tasks `EmploymentCollector-Tick` and `-Wake`.
2. Confirm their last push.
3. Run `POST /admin/import-github`. It copies the GitHub evidence byte-for-byte (git object id checked) into the R2 root and seeds the `auth` index, `enabled_at` and the last pushed head.
4. Deploy with `MODE=authoritative`.
5. Run `/admin/verify?ns=auth`.

**Rollback:**
1. Deploy with `MODE=shadow` (or roll back the Worker version).
2. Re-enable the Windows tasks.

The GitHub evidence repo remains the shared audit trail throughout, so no evidence is lost in either direction.

Deploy only with `scripts/deploy.mjs`. It refuses a dirty or unpushed tree, runs the tests, and stamps `CODE_COMMIT` and
`CODE_FILES` (the sha256 of each source file, including the rules lib) into every capture's `code`.

## Owner prerequisites (not created yet)

- Approval of the resources (estimate below).
- Kalshi API key secrets (`KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY`).
- A fine-grained GitHub token for the evidence repo only.
- The alert channel.

Estimated incremental cost, on the existing Workers Paid plan:
- **R2:** about 0.5 GB per year (≤ $0.01/month), plus about 5,000 writes per month (≈ $0.02).
- **Worker:** 8,928 cron runs per month, inside the plan's included requests and CPU.
- **Durable Object:** about 9,000 requests per month, inside the included allowance.

Expected total: **under $0.10/month**; worst case under $1/month.
