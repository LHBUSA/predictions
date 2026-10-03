# Predictions — rollback topology (as of 2026-10-03 23:20 UTC)

Two independently deployed layers:

- **Worker `pbe-predictions`** — engine, models, leakage guard, API, SSR pages (events, insights), social cards.
- **Vercel `predictions`** — static site only (HTML shell, CSS, JS, images). `.vercelignore` excludes `src/`,
  `workers/`, `sql/`, `test/`, so **no Vercel rollback can change model or guard behavior**.

## Worker versions (Cloudflare keeps every uploaded version; rollback = re-point traffic, no rebuild)

| Role | Version | Commit | Contents |
|---|---|---|---|
| **Current production** | `594d27f2-5a41-4a8d-8c16-93033153e294` (100%) | main at the commit adding this file | guard v2 + newsroom dry-run (+ sql/003 probe, mover copy fixes) + editorial art |
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
