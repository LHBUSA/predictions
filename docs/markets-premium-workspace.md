# Markets premium workspace

Production owner: `LHBUSA/predictions`, branch `main`, route `https://predictions.propbetedge.ai/markets/`. Confirmed against production deployment `6894718091` at base commit `ad280a48d871aad0e8e498fa05dacbe3b5159449`. The network family points here; `markets.propbetedge.ai` did not resolve at implementation time.

The existing terminal remains the implementation. `markets/index.html` retains its data feeds, ticker controls, mode routing, chart review and analyst SSE handling. `premium-workspace.css` supplies the navy/champagne palette, readable text and responsive workspace. `premium-workspace.js` supplies wire actions, browser memory and state handling.

`GET /api/market-intelligence/wire` requires the shared All Access authority and sends private/no-store responses. It ranks verified session/24h moves, news context and sentiment from the existing market-data worker. Observation times are not exchange timestamps. The browser refreshes every 60 seconds while visible. Failed refreshes label old observations stale; missing data does not produce simulated alerts. Anonymous previews describe workflows and never fetch the wire.

The wire is feed-derived; its explanations describe research checks. AI thesis analysis runs through Debate/Consult, where the existing research service verifies current evidence. Matched Kalshi/Polymarket divergence remains in the existing Compare product; the terminal links to it rather than manufacturing contract matches. Intraday momentum, verified volume/volatility and automatic cached AI annotations are future feed work.

Watchlists, prompts, style and eight bounded sessions use `pbe_markets_memory_v1` in browser storage. This is browser-local, not account/cloud sync. The UI explicitly explains shared-browser visibility and includes Clear memory. Stored results reopen as historical text. Follow-ups pass bounded, untrusted historical context and preferences to the authenticated APIs, which fetch fresh research. No credentials are stored or changed.

Debate preserves Quant → Bull → Bear, adds five consistent evidence headings, and finishes with a neutral AI decision brief. Existing personalized-trade restrictions remain intact.

## Validation

- `node --test tests/market-wire.test.mjs tests/market-intelligence.test.mjs`: six passing tests, including denied anonymous/unpaid/unverified requests, bounded memory, and explicit price-change periods.
- `node scripts/qa/markets-qa.mjs`: 16 browser combinations across 1440, 1280, 1024, 768 and 390, testing anonymous/free/unverified/all_access/owner states with deterministic fixtures. Includes prompt saving, watchlist persistence, saved-session reopening, Consult memory and Trade Lab visibility.
- Full suite: 369 pass, three existing failures in homepage asset-version and network footer assertions. Reproduced against the unchanged base commit in a separate checkout. Baseline production GitHub CI already failed. These assertions are outside the terminal change.
- Production QA uses `node scripts/qa/markets-qa.mjs https://predictions.propbetedge.ai` and real unauthenticated requests. Paid live AI output requires an authenticated subscriber session; fixture coverage does not claim a live paid-session test.

Screenshots and results are saved under ignored `_preview/markets/`; fixture filenames name the membership state. Production filenames use `production-<width>.png`.
