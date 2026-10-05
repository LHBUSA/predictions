# PropBetEdge Compare (compare.propbetedge.ai)

Isolated Vercel project `compare-propbetedge`, root `/compare`, git-linked to `main` (branch pushes = previews).
Rollback point before V1 repair: `dpl_2M7jzWJQJGWAn3qyH9ohNUvD8MPj` (578eba5).

## Routes (all private, no-store; one entitlement decision per request)
| route | upstream | notes |
|---|---|---|
| `/api/membership` | pbe-predictions `/v1/membership` | header chip only |
| `/api/desk?scope=sports\|nonsports\|<sport>` | propsports-markets `/v1/market-desk` (one read per lane) | per-lane state `ok` / `not_connected` (404) / `unavailable`; `limit=50` = upstream cap, `capped` flag, no paging contract exists |
| `/api/event?sport=&event=` | `/v1/market-intelligence/event/:sport/:id` + `/v1/market-desk?sport=&event=` | stored Kalshi change rows, book, volume, OI + Polymarket stored points |
| `/api/series?event=&market=` | `/v1/market-desk/series` | prediction markets only (sports ids reach pred_* tables and 404) |
| `/api/live?sports=` | sport score sources via `lib/scores/adapters.js` (vendored Members @ 59de9d2) | one entitlement decision; 10 s per-instance memo; regenerate with `node compare/scripts/vendor-members-live.mjs` (drift test enforces) |

Protected routes: anonymous 401 · signed in without All Access 403 · authority unreachable 503 + Retry-After.

## Data rules
- Score ↔ market joins are ID-only (`core.js` `ID_JOIN_SPORTS` = NFL, NBA, MLB, NHL). UFC and every other sport = UNMATCHED. No title or team-name matching anywhere.
- Badges: COMPARABLE (± EXACT / NOT ALIGNED), RULE MISMATCH, WITHDRAWN, SINGLE VENUE; score join: UNMATCHED. RULE_MISMATCH stays fail-closed: shown with its own price, never a spread.
- Movement = stored observations only (step semantics); a window without an observation at or before its start is "not enough observations", never 0.

## Tests / QA
`node --test compare/test/*.test.js` (also part of the root `npm test`). Fixtures in `test/fixtures` are real production payloads captured 2026-10-05.

## Follow-ups
1. DONE 2026-10-05: score adapters run in Compare (pinned Members `59de9d2`, deterministic transform, drift tests). To re-pin, copy the new Members `api/live.js` byte-for-byte to `test/fixtures/members-<sha>/live.js.txt`, update `MEMBERS_LIVE_SHA256`, and re-run the vendor script.
2. NHL Origin: DONE in the adapter (patch 3). OPEN: replace Origin-as-server-auth on nhl-api with a proper internal caller contract (signed service token or service binding); a browser header is not a server credential. Members' own NHL adapter is still broken (unchanged by owner instruction).
3. DONE: propsports-markets `386af6fa` (212cecb: series validator + tie guard + NFL tie parser) at 100%, rollback `2e805cb1`.
4. OPEN (separate auth decision): auth-magic return allowlist lacks compare.propbetedge.ai; sign-in goes through Members.
5. NFL standalone-tie template: owner-approved through the parser (212cecb); re-gates on the next pairs run.
6. Pre-existing: predictions CI runs Node 20, but `test/entitlement.test.js` needs `node:module.registerHooks` (Node >= 22), so main CI is red independent of Compare.
