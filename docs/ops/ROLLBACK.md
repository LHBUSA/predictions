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

## Free / All Access boundary (2026-10-04)

| Layer | Live | Roll back to | How |
|---|---|---|---|
| auth-magic (propbetedge-workers 5546aa4) | v2.5 `54ea9acf` (adds `?product=predictions`, predictions origin/return host) | v2.4 `ce54843e` | `wrangler versions deploy ce54843e-fec1-4f20-9220-638d23e1b003@100%` in workers/propbetedge-auth-magic |
| pbe-predictions Worker | `843299bf` (schema fix on top of `dc6b28b7`; /v1/membership, /v1/premium/*, public event view, free desk cap 12) | `da480b34` | `wrangler versions deploy da480b34-c6c2-49b7-97c6-6f2bb7ebb5a2@100%` |
| Vercel static (access.js, home.js, site.css) | this commit | previous production deployment | Vercel instant rollback |

Roll back the Worker and Vercel together: the new home.js expects `desk.access` (without it, search/sort hide and no unlock module shows).
Rolling back auth alone makes every Predictions visitor FREE (fail closed), with no data exposure.
