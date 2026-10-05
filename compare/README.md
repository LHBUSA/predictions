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
| `/api/live?sports=` | **interim** Members `/api/live` proxy | see follow-up 1 |

Protected routes: anonymous 401 · signed in without All Access 403 · authority unreachable 503 + Retry-After.

## Data rules
- Score ↔ market joins are ID-only (`core.js` `ID_JOIN_SPORTS` = NFL, NBA, MLB, NHL). UFC and every other sport = UNMATCHED. No title or team-name matching anywhere.
- Badges: COMPARABLE (± EXACT / NOT ALIGNED), RULE MISMATCH, WITHDRAWN, SINGLE VENUE; score join: UNMATCHED. RULE_MISMATCH stays fail-closed: shown with its own price, never a spread.
- Movement = stored observations only (step semantics); a window without an observation at or before its start is "not enough observations", never 0.

## Tests / QA
`node --test compare/test/*.test.js` (also part of the root `npm test`). Fixtures in `test/fixtures` are real production payloads captured 2026-10-05.

## Follow-ups (open)
1. **Score adapters in Compare (owner item 8).** Run the Members live adapters directly, pinned to Members `59de9d2`, with drift tests; removes the second membership check + proxy hop. Blocked 2026-10-05 on a tool permission to read the pinned Members files.
2. **NHL scores (owner item 7).** nhl-api `/nhl/board` 403s without `Origin: https://nhl.propbetedge.ai`; the fix (send that Origin from the server adapter) lands with follow-up 1. Then replace Origin-as-server-auth with a proper internal caller contract (signed service token / service binding) and stop using a browser header as a server credential.
3. **propsports-markets series validator** (2404302) uploaded as version `1aaaa7ed` at 0%; promote needs owner action (`npx wrangler versions deploy 1aaaa7ed-a0cf-47d6-abae-a5ac30a5461e@100%`), rollback `2e805cb1`.
4. **Sign-in return host.** auth-magic does not list compare.propbetedge.ai as a safe return; Compare sends members to Members to sign in. Adding it is an auth change (owner approval).
5. **NFL Polymarket RULE_MISMATCH** (30 upcoming markets): rule packet for owner review; no reclassification without approval.
