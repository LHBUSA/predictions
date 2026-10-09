# Predictions production release recovery — 2026-10-09 (goodl-c0)

Owner directive "PREDICTIONS PRODUCTION RELEASE RECOVERY" (session ownership confirmed by the owner; goodl-3d
handed over its untouched worktree and merge-tree inventory). Direct-main workflow, no preview branches.

## Rollback references (captured before the first deploy)
- Vercel production before: `dpl_DqmHPVqXD8ior3S4hDMQJHg99q1m` (main `2c3f700`)
- pbe-predictions Worker before: `4ca49ed0-ccc0-4e87-8e3a-03c64eb81c96`
- Intermediate Worker versions: `317d3871` (a3a0136), `567b6fe0` (rolled back: Insights 500), `c97ac844` (52ab7bf)

## Releases (all on main, CI green from 63042ea)
| Commit | Content | Worker |
|---|---|---|
| a3a0136 | Node 24 CI; ONE asset version 20261009rel1 (site.css/home.js changed after 20261005aa4 but SSR/models/methodology still pointed at it); footer links each All Access product once; v2 copy assertion aligned | 317d3871 |
| ea7aa59 | Merge PR #47 (Insights read path) | |
| 802b75a | Merge PR #48 (plain-English forecasts, actual winners, gated results board); asset version 20261009rel2; results-board read caps removed | |
| 63042ea | CI `npm ci` (workflow never installed deps) | 567b6fe0 → **rolled back** |
| 52ab7bf | Insights memo stores plain data (PR #47 cached a Response across requests → /insights 500 on Workers) | c97ac844 |
| 8b3a299 | Crypto: stop requesting 6 logos Simple Icons removed (404s) | (static) |
| f01ccd5 | Insights cold path: bounded parallel rebuild of published stories (18–26 s → ~8 s) | **d1053af8** |

Order used for Worker+Vercel releases: Vercel first when static assets change (site.css is cached 300 s +
SWR 86400 s, so the Worker must not reference a new ?v= before Vercel serves it), then the Worker.

## Backlog reconciliation
| Item | Outcome |
|---|---|
| PR #48 clear picks / results board | RELEASED (802b75a) |
| PR #47 Insights performance | RELEASED with production fix (52ab7bf, f01ccd5) |
| PR #49 CI Node 24 | SUPERSEDED by a3a0136 + 63042ea (closed) |
| PR #9 Terms/Support/Media footer | SUPERSEDED: Terms+Support live; Media forbidden by later decision b5de1ed (closed) |
| PR #39 Crypto hero/chart v2 | SUPERSEDED: all hero/chart ids on main via the 10-06/10-07 crypto series (closed) |
| PR #43 Market Intelligence + Trade Lab | SUPERSEDED: all features live in the later premium workspace 44468fc (closed) |
| crypto-product-page-v1 | SUPERSEDED (085f56d dedicated BTC Nowcast desk) |
| crypto-execution-intelligence-v1, crypto-first-class-realtime-ui, crypto-rail-ui-polish, crypto-manual-trade-handoff | SUPERSEDED (later crypto command-center series; small residue only) |
| robinhood-market-rail-ui, robinhood-rail-labels, robinhood-quote-normalization-v2, robinhood-quote-diagnostics, robinhood-account-readiness | SUPERSEDED / already in main (patch-equivalent or later rail on /crypto/) |
| robinhood-live-execution, robinhood-live-preflight | EXCLUDED: changes execution permissions (directive forbids) |
| markets-terminal-levelup-2026-10-06 | SUPERSEDED (technicals + watchlist in 44468fc workspace) |
| home-live-refresh | ALREADY IN MAIN (patch-equivalent) |
| compare-* (5) + fix/compare-upstream-fanout | SUPERSEDED (2a88afc Compare P0 load fix and Compare LIVE NOW 10-07) |
| codex/predictions-model-sprint, crypto-live-board-order, robinhood-effective-execution-prices, cpi-v1 | ALREADY IN MAIN |
| ops-cron-timing | NOT CUSTOMER-FACING (ops docs) — not part of this release |
| employment-v1, employment-edge-feasibility, employment-selective-edge | RESEARCH — never merged |

## Production verification (anonymous, 2026-10-09 ~15:20Z)
- 390 / 768 / 1440 px: /, /crypto/, /markets/, /insights/, an article, /models/, /methodology/, compare.propbetedge.ai —
  all 200, no horizontal overflow, no console errors, no broken images, one asset version (20261009rel2).
- APIs: /api/summary, /api/track-record, /api/models, /api/preview/desk, /api/health 200; /api/desk and
  /api/premium/results-board 401 all_access_required (no paid data to anonymous readers).
- Insights: 0 Worker error events under sequential + 10-way concurrent cold load; warm ~0.2 s; RSS, news sitemap OK.
- Signed-in All Access checks (member desk unlock, results board content) need an owner session — NOT performed.

## Remaining issues
- Insights cold build still ~8 s (warm 0.2 s); further work: precompute the desk on the cron instead of per request.
- Signed-in All Access production verification (owner session).
- /record without ?id= is a 404 by design (legacy permalink redirector, a627de3).
