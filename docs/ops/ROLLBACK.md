# Predictions — rollback topology (as of 2026-10-03 23:40 UTC)

Two independently deployed layers:

- **Worker `pbe-predictions`** — engine, models, leakage guard, API, SSR pages (events, insights), social cards.
- **Vercel `predictions`** — static site only (HTML shell, CSS, JS, images). `.vercelignore` excludes `src/`,
  `workers/`, `sql/`, `test/`, so **no Vercel rollback can change model or guard behavior**.

## Worker versions (Cloudflare keeps every uploaded version; rollback = re-point traffic, no rebuild)

| Role | Version | Commit | Contents |
|---|---|---|---|
| **Current production** | `da480b34-c6c2-49b7-97c6-6f2bb7ebb5a2` (100%) | `2d099a9` | network shell + canonical publisher + article link graph; newsroom manual-publish (no auto); art; guard v2 incl. 3c4e734 DB-parity |
| Previous | `c5cae12f-52e1-4459-81e8-9b862ca5ae93` | `ae3ce1c` | guard v2 + newsroom manual-publish path (no auto) + editorial art + d21b457 hidden `?mv=1` UI |
| Previous | `594d27f2-5a41-4a8d-8c16-93033153e294` | `f34932d` | newsroom dry-run only (cannot serve published newsroom stories) |
| Previous art release | `d83c2426-4be5-42ef-92b5-26745d5bb263` | `92207d9` | guard v2 + newsroom dry-run + editorial art |
| **Guard-v2-only recovery** (preferred for any art/editorial problem) | `46cdcbfe-cb1e-47ca-a59d-af0de5acf7f6` (uploaded, 0% traffic) | `c3decef` | guard v2 + newsroom dry-run, **no** art Worker code. Built from a clean worktree at `c3decef`; 148/148 tests incl. leakage 7/7 (golden outputs byte-identical; Kalshi+Polymarket price invariance) |
| Guard-v2 original deploy (same commit, other session) | `57c12f03-d3be-4dce-9115-87ef056fcac3` | `c3decef` | equivalent to the recovery version |
| **Full pre-guard emergency rollback** (removes guard v2 — last resort) | `b98f1aed-8417-4c06-880b-21ded196f92d` | `cc427d8` | newsroom dry-run, guard v1 |

Commands (run from the repo root):

```sh
# art/editorial problem -> keep guard v2
npx wrangler versions deploy 46cdcbfe-cb1e-47ca-a59d-af0de5acf7f6@100% --config workers/pbe-predictions/wrangler.jsonc -y
# emergency only (drops guard v2)
npx wrangler versions deploy b98f1aed-8417-4c06-880b-21ded196f92d@100% --config workers/pbe-predictions/wrangler.jsonc -y
```

## Vercel deployments

| Role | Deployment | Commit |
|---|---|---|
| Current production | `dpl_H6NFiNnGwwstVPfZoS5SANKZdrbp` | `92207d9` |
| **Pre-art static rollback** | `dpl_9uik15o1XGAmapzWwacbQyH3e2yR` | `c3decef` |
| Pre-newsroom static | `dpl_nYFtW2w9AyGrTx8SLPhPkzBN8b79` | `cc427d8` |

## Pairing rules

- **Art rollback = Worker `46cdcbfe` (+ optionally Vercel `dpl_9uik15o1…`).** The Worker alone is enough to remove
  the art from pages; the art CSS on Vercel is additive and harmless to older markup.
- **Never roll Vercel back to `dpl_9uik15o1…` while the Worker is on an art release (`594d27f2`, `d83c2426`)**: current Worker markup points at
  `/images/insights/...`, which that static deployment does not contain (broken images).
- Guard v2 lives only in the Worker. Any Worker version **older than `57c12f03`** removes it.
- Pages also reference a CSS cache key (`ASSET_V` in `workers/pbe-predictions/src/pages.js`); Vercel serves the current
  `site.css` for any key, so mixed versions degrade to the newest stylesheet, never to a missing one.

## Newsroom data (sql/003, applied 2026-10-03 23:30 UTC as version 20261003233000)

- Rolling the Worker back to any version before `c5cae12f` stops *serving* published newsroom stories (the Boston
  canary would 404); the rows stay in `pred_newsroom_*` (append-only) and reappear when the Worker is rolled forward.
- Unpublishing is not possible by design (append-only). To stop serving a story without a rollback, remove it in
  code from the read path and redeploy; the ledger keeps the record.
- `sql/003_newsroom_v1_ROLLBACK.sql` drops the tables and their records — export first; owner decision only.

## Network integration (2026-10-03 23:45 UTC)

- Predictions static shell: Vercel `index.html`/`models`/`methodology` regenerate from `brand/network.json`
  (`node scripts/brand/shell.mjs --index` + `python scripts/brand/static-pages.py`). Worker pages use the same module.
- Main site `propbetedge.ai` (LHBUSA/propbetedge-news-site, push = production): `a6c962b` + `246678a` add Predictions
  to hasPart, /pro, footer, header, About, search. Revert those two commits to roll back; Stripe identity untouched.
- sql/005 applied (20261003235900). Rollback file: sql/005_newsroom_transition_graph_ROLLBACK.sql (restores the 003 guard).

## All Access product contract (2026-10-05) — supersedes the Free / All Access boundary below

Owner decision: Predictions is a premium product included with PropBetEdge All Access ($29/month). No free tier.
Gated (401 anonymous / 403 signed in without All Access / 503 entitlement unverifiable; private, no-store, no payload):
`/v1/desk`, `/v1/event/*`, `/v1/contract/*`, `/v1/live/event/*`, `/v1/premium/*` (incl. new `/v1/premium/event-page/<slug>`).
Public: event page shell (premium.js `publicEventShell`, whitelist), `/v1/summary`, `/v1/calendar`, `/v1/models`,
`/v1/track-record` (aggregates), `/v1/queue`, `/v1/membership`, methodology, models, Insights (newsroom, unchanged).

| Layer | Live | Roll back to | How |
|---|---|---|---|
| auth-magic (propbetedge-workers 1afaaff) | v2.8 `17dd5d53` (`reason: entitlement_unavailable` on product surfaces when the All Access ledger is unreadable) | v2.7 `84506059` | `npx wrangler versions deploy 84506059-9c9b-4c03-a3bd-ab9ef623d05a@100% -y` in workers/propbetedge-auth-magic |
| pbe-predictions Worker (main 399a0cb) | `34586ac7` | `97539ec8` (431ba2a) | `npx wrangler versions deploy 97539ec8-a1be-408e-b8b5-7345b9b06011@100% --config workers/pbe-predictions/wrangler.jsonc -y` (code-only; crons unchanged) |
| Vercel static (index.html, access.js, home.js, live.js, site.css, models/, methodology/ ?v=20261005aa1) | build of 399a0cb | the previous production deployment (7813c76) | Vercel instant rollback |

Roll back the Worker and Vercel TOGETHER. Old static + new Worker: the old homepage calls `/api/desk` anonymously
(now 401) and shows "desk could not be loaded". New static + old Worker: the old `/v1/membership` answers state
`free` / label `FREE`, which the new header would print. Rolling back auth alone is harmless (a ledger outage shows
"Upgrade" instead of "Access Check"; still fail closed).
NOTE: 399a0cb's Worker deploy also shipped 7813c76 (consent tags on Worker-rendered pages), which had been committed
to main but not deployed. Rolling the Worker back to 97539ec8 removes consent tags from event pages again.
QA: `node scripts/qa/access-qa.mjs --local|--prod` (5 states x 6 widths x home + event).

## Free / All Access boundary (2026-10-04) (SUPERSEDED 2026-10-05)

| Layer | Live | Roll back to | How |
|---|---|---|---|
| auth-magic (propbetedge-workers 5546aa4) | v2.5 `54ea9acf` (adds `?product=predictions`, predictions origin/return host) | v2.4 `ce54843e` | `wrangler versions deploy ce54843e-fec1-4f20-9220-638d23e1b003@100%` in workers/propbetedge-auth-magic |
| pbe-predictions Worker | `843299bf` (schema fix on top of `dc6b28b7`; /v1/membership, /v1/premium/*, public event view, free desk cap 12) | `da480b34` | `wrangler versions deploy da480b34-c6c2-49b7-97c6-6f2bb7ebb5a2@100%` |
| Vercel static (access.js, home.js, site.css) | this commit | previous production deployment | Vercel instant rollback |

Roll back the Worker and Vercel together: the new home.js expects `desk.access` (without it, search/sort hide and no unlock module shows).
Rolling back auth alone makes every Predictions visitor FREE (fail closed), with no data exposure.

## Predictions V4 (2026-10-04) — fact-backed forecasts + first-class venues
| Surface | Live | Rollback |
|---|---|---|
| pbe-predictions Worker | `24e4c9c3` (main 83cb9cd; first V4 deploy `79b3ab3c` = 37b8d26) | `bf48df27` (6315b0b): `npx wrangler versions deploy bf48df27-db42-457c-97d6-99044ff50e11@100% --config workers/pbe-predictions/wrangler.jsonc -y` |
| Vercel predictions (static) | built from 83cb9cd (site.css/home.js ?v=20261004v4) | promote the 6315b0b deployment; the V4 desk lines render nothing without the V4 Worker, so either side can roll back alone |
No migration. prediction-decision-v1 is DRAFT: decisions are served only at `/admin/decisions` (ADMIN_TOKEN).

## Decision ledger (2026-10-04)
- Migration `sql/006_pred_decisions.sql` applied as ledger `20261004140000` (PROOF 12/12 via `sql/006_pred_decisions_PROOF.sql`, always aborts).
- Kill switch: set `DECISIONS_DB` to anything but "true" and deploy (stops writes; the table stays). Table rollback
  `sql/006_pred_decisions_ROLLBACK.sql` destroys the prospective record — export first.

## Ledger TRUNCATE guard (2026-10-04)
- `sql/007_ledger_truncate_guard.sql` applied as ledger `20261004150000` (PROOF via `sql/007_ledger_truncate_guard_PROOF.sql`, always aborts).
  Statement-level `before truncate` triggers + TRUNCATE revoked from service_role/anon/authenticated on exactly:
  pred_source_observations, pred_feature_snapshots, pred_forecasts, pred_venue_snapshots, pred_resolutions, pred_scores,
  pred_forecast_designations (pred_decisions has its own from 006). NOT pred_events (mutable registry).
- Rollback: `sql/007_ledger_truncate_guard_ROLLBACK.sql` (drops only the 007 triggers, restores the default service_role grant,
  removes the ledger row). Row-level update/delete guards from 001/002 are unaffected either way.

## pred_contracts TRUNCATE guard (2026-10-04, final ledger-hardening follow-up)
- `sql/008_contracts_truncate_guard.sql` applied as ledger `20261004160000` (PROOF `sql/008_contracts_truncate_guard_PROOF.sql`, always aborts).
  Rollback: `sql/008_contracts_truncate_guard_ROLLBACK.sql`. pred_events remains mutable with no guard. Ledger architecture closed.

## BTC 15-minute nowcast SHADOW (2026-10-04)
- `sql/009_crypto_shadow.sql` applied by the owner (six isolated append-only `pred_crypto_*` tables; PROOF
  `sql/009_crypto_shadow_PROOF.sql`, PGlite `scripts/db/prove-009.mjs`). Protocol: `docs/research/CRYPTO_SHADOW_V1.md`.
- pbe-predictions `768f0cad-5f2b-4864-b929-1dffdab506d6` (main 92950dc): `CRYPTO_SHADOW="true"`, cron `* * * * *`
  routed by `event.cron` (the */15 engine cycle unchanged). Triggers deployed with `wrangler triggers deploy`.
- Rollback: `npx wrangler versions deploy 56c88d6e-7819-44f0-89be-3230a78c657e@100% --config workers/pbe-predictions/wrangler.jsonc -y`
  IMPORTANT: 56c88d6e runs the engine cycle on EVERY cron invocation, so remove the `* * * * *` trigger FIRST
  (`"crons": ["*/15 * * * *"]` + `wrangler triggers deploy`), then deploy 56c88d6e. Kill switch without rollback:
  `CRYPTO_SHADOW="false"` + deploy (the 1-minute cron then returns immediately).
- Table rollback `sql/009_crypto_shadow_ROLLBACK.sql` destroys the shadow record — export first.

## Automated newsroom (2026-10-04)
- The 15-minute engine cron now runs runCycle -> newsroomCycle (detect -> validate -> auto-publish VALIDATED movers and
  resolution reports). Anomaly lane / HELD never publish. No schema change (uses sql/003 + sql/005).
- Kill switch (preferred, no code rollback): set `NEWSROOM_AUTO_PUBLISH` to anything but "true" in wrangler.jsonc and deploy.
  Detection keeps running; nothing publishes. Already-published stories stay (append-only).
- Worker rollback: previous production `59496aa5` (BTC shadow 5d3b007; same crons, so no trigger change is needed):
  `npx wrangler versions deploy 59496aa5-b252-490e-bc74-0afd5b18b47c@100% --config workers/pbe-predictions/wrangler.jsonc -y`

## BTC shadow: venue settlement observations + completeness (2026-10-04)
- pbe-predictions `07f7cf8a-7332-4be8-93b1-a611844b1e09` (main 8c5f027): completeness report on the first tick of each
  window (log only); `CRYPTO_SETTLEMENTS="false"` until `sql/010_crypto_venue_settlements.sql` is applied (PROOF
  `sql/010_crypto_venue_settlements_PROOF.sql`, PGlite in `scripts/db/prove-009.mjs`). Rollback: `5e36f7bb` (844a618).
- Table rollback `sql/010_crypto_venue_settlements_ROLLBACK.sql` (set CRYPTO_SETTLEMENTS="false" + deploy first).
- pbe-predictions `8df28a94-f6cb-413b-bfda-66c12986951e` (main e00b9b6): venue quotes captured even when the exchange
  read fails (forecast skipped); completeness = the window that just closed. Rollback: `83f0d3d0` (89cb6fa).

## Insights image resolver (2026-10-04) — CLOSED (owner PASS)
- Release: main `89cb6fa`, Worker `83f0d3d0` = the image-release rollback point. The later BTC deployment
  (workers-27, Worker `8df28a94`, main `e00b9b6`, rebased on 89cb6fa) preserves it.
- Order is fixed: flagship art -> verified real photo (Wikidata entity + label/coordinate check, Commons free license,
  >=1600 px) -> story-specific evidence SVG -> category art emergency-only. Do not lower the gates or expand the
  registry for coverage. No further visual work unless production exposes a defect.
- Rollback of images only: `npx wrangler versions deploy <pre-image version>@100%` is NOT recommended (it would also drop
  later BTC work); instead revert 89cb6fa's images.js/render.js and redeploy from main.

## Freshness pass (2026-10-04) — live layer
- Releases: 0961cdc0 (bfdd9fa hot lane + live event pages) -> fe8e9d7e (0bf4af9 Insights LIVE UPDATE) -> 06459033
  (86a5f93 polish) -> e4d81325 (f731e54 intraday wiring + UI, INTRADAY_LIVE=false). Each was deployed on top of the
  then-current BTC release from workers-27 (CRYPTO_SHADOW/CRYPTO_SETTLEMENTS unchanged).
- Kill switches (no code rollback needed): HOT_LANE (station observations), INTRADAY_LIVE (intraday forecasts).
  Stored observations / intraday rows are append-only and stay.
- Worker rollback before the live layer: 8df28a94 (BTC e00b9b6). Keep both crons (that version routes the one-minute cron
  to BTC only).
- 9fffadfd (c5bbdd1): INTRADAY_LIVE=true (first live intraday write 18:18:33Z).

## Live Weather Intelligence V3 (2026-10-04)
- Phase A rain predictive-state write invariant: main `a9604d2`, Worker `441296d6`. Rollback: `9fffadfd`, or INTRADAY_LIVE
  != "true". 96 pre-fix time-only rain rows remain (append-only); the live timeline collapses them.
- Phases C/D/E live weather panel, why-moved, market disagreement, atmosphere, timeline: `7e6de9d` -> `b5e9ae6` (snow)
  -> `5d37f3c` causes, Worker `846b3e1b`. Rollback of the UI only: `441296d6`.
- v2.2 SHADOW research `ff13d02`: research files only, nothing wired (byte parity v2.0/v2.1 vs HEAD = 0 diffs).

## Engine run ledger + scheduler lanes (2026-10-04, Phases 2-3)
- sql/011 applied (`engine_runs_v1`): pred_engine_runs (append-only) + pred_engine_lease + pred_engine_claim/release.
  Rollback SQL `sql/011_engine_runs_ROLLBACK.sql` (set ENGINE_RUNS != "true" and deploy first).
- main `90a95dd`, Worker `8cd99fd7`: crons FAST '* * * * *' / CORE '*/15 * * * *' / NEWSROOM '7,22,37,52 * * * *',
  dispatched by identity. Kill switch ENGINE_RUNS (lanes still split, no lease/heartbeat). Code rollback: `846b3e1b`
  (old */15 engine-then-newsroom; its two crons only — redeploying it drops the newsroom cron).

## Live cadence: core every 2 min, newsroom every 5 min (2026-10-04, owner P0)
- Core parallel I/O: main `f9f21ed`, Worker `6b224593` (crons unchanged */15). Same requests, same writes
  (scripts/ops/cycle-golden.mjs byte-identical); first production run 15.1 s (baseline 31-150 s).
- Cadence: main `e115a57`, Worker `db2cf406`: CORE '*/2 * * * *', NEWSROOM '1,6,11,...,56 * * * *', FAST unchanged.
- **Crons and code must move together.** A version rollback alone (`wrangler rollback`) does NOT change triggers, and
  older code maps an unknown cron to no lane (core silently stops). Roll back by redeploying source:
  - to 15-min with the optimization: `git checkout f9f21ed -- workers/pbe-predictions` then `npx wrangler deploy`
    (restores '*/15' + '7,22,37,52' and the matching CRONS), then `git checkout main -- workers/pbe-predictions`.
  - full pre-change: same with `e190964` (Worker was `bbc9a2f4`).
- Fallback cadence (owner rule): if 2 min fails the safety gate, 3 min ('*/3'), never 15 without owner approval.
- Before ANY cron change read `docs/ops/CRON_MIGRATION.md` (propagation delay, overlap-then-retire, code-only releases via `wrangler versions upload/deploy`).
