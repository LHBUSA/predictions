# Signal 10 U.S. stock tape (issue #54)

A slim "U.S. STOCKS" strip under the masthead on all five `/markets/signal-10/` pages. **SpaceX (SPCX) is pinned first.** Every stock links to its Robinhood stock page. The tape is a separate editorial feature. It is not the model, the Top 10, the $10,000 paper account or its ledger.

## Quote source audit (2026-10-10). Robinhood was checked first.

| Candidate | What it is | Can it feed this tape? |
|---|---|---|
| **Robinhood: our existing integration** (`workers/pbe-predictions/src/robinhood-crypto.js`, secrets `ROBINHOOD_CRYPTO_*`) | Robinhood **Crypto Trading API** (`trading.robinhood.com`). Its routes are `/api/v2/crypto/...` only (the client hard-refuses any other path; market data = `/api/v2/crypto/marketdata/best_bid_ask/`). | **No.** It has no equity quote route, and crypto credentials grant no stock data and no redistribution rights. It was not repurposed. |
| **Robinhood equities API** | Robinhood publishes no official equities or market-data developer API. Community libraries (robin-stocks, pyrh) reverse-engineer the private, authenticated app API. | **No.** That would mean scraping or reverse-engineering authenticated brokerage endpoints, which is forbidden. |
| **Robinhood public stock pages** `https://robinhood.com/us/en/stocks/<SYM>/` | Public web pages | **Links only.** A page is a click-through destination, not permission to redistribute quotes. All 11 featured symbols answered **200** with the right company title on 2026-10-10. A bogus symbol answers **404** "Page not found". BRK.B also resolves, with the dot kept. |
| **Finnhub** (key exists in `LHBUSA/markets-proptechusa`) | finnhub.io/terms-of-service: "All plan listed on Finnhub website is strictly for personal use unless explicitly stated otherwise", "Personal plan can't be used by any business even internally without a written approval", and no redistribution "with anyone or any 3rd party without written approval". | **No.** Using it needs written approval or a paid plan, and neither was bought (no new spend). |
| **Yahoo Finance chart API** (already used by Signal 10 `/live` and the paper-account marks) | Unofficial endpoint. Redistribution is not licensed and the delay is undocumented. Its responses carry the source's own `regularMarketTime`. | **Members-only fallback, same as the existing `/live` page.** It is never public. |

**Verdict:** no licensed public-display source is available without new spend. **Public live prices are BLOCKED** pending an owner licensing decision. That decision is either a vendor with display/redistribution rights for U.S. equities, or written approval from Finnhub.

## Activation switch: `SIGNAL10_TAPE_QUOTES` (wrangler var)

| Value | Public visitor | All Access member | Vendor calls |
|---|---|---|---|
| `members` (**deployed**) | Symbols, session, last-close and next-open times, Robinhood links. **No prices.** | Prices with source trade times, plus separate *Paper holdings* and *Top 10 · frozen <date>* groups | Yes, for members only, through the edge cache |
| `public` | Prices | Prices | Yes. **Enable only after rights are documented here.** |
| anything else | No prices | No prices | None |

Public responses contain no ranking or holding symbols. Every response is `private, no-store` with `Vary: Cookie`, because member and public bodies share one URL.

## Data contract: `GET /api/signal10/tape` (Worker `/v1/signal10/tape`)

`session` gives `{state, label, date, early_close, opens_at, closes_at, next_open_at, last_session, last_close_at}`. `state` is one of OPEN, PRE_MARKET, AFTER_CLOSE, CLOSED_WEEKEND, CLOSED_HOLIDAY or CALENDAR_UNKNOWN.

`groups[].rows[]` gives `symbol, name, robinhood_url, group, pinned, price, previous_close, change_abs, change_pct, price_observed_at, session_date, status, fetched_at, rank?`.

How the fields are built:
- `price` is `meta.regularMarketPrice`.
- `price_observed_at` is `meta.regularMarketTime`, the source's trade time and **never our fetch time**. Our fetch time is reported separately as `fetched_at`.
- `previous_close` is the close of the last daily bar dated **before** the trade's session date, taken from `range=5d` bars. `chartPreviousClose` is never used.
- `status` takes these values:
  - CURRENT: open, with a source time no more than 2 minutes old.
  - DELAYED: open, with a source time no more than 20 minutes old.
  - LAST_CLOSE: closed, and the quote is from the last session.
  - STALE: the row carries **no price**.
  - SOURCE_UNAVAILABLE: the source returned nothing usable.
  - MEMBERS_ONLY or QUOTES_OFF: prices are withheld for this reader.
- The source response's `meta.symbol` must match the requested symbol, otherwise the quote is rejected. This means no other security's history is ever joined. SPCX `firstTradeDate` = 2026-06-12 13:30Z, which matches the Nasdaq listing.

Sample source receipt, fetched from this machine 2026-10-10:

| Symbol | Price | Previous close | Source time |
|---|---|---|---|
| SPCX | 162.57 | 160.57 | 2026-10-09T20:00:00Z |
| SPY | 778.57 | 773.93 | 2026-10-09T20:00:00Z |
| HOOD | 109.02 | 107.01 | 2026-10-09T20:00:01Z |

## Load, quota and cadence
- **Symbols:** one fixed list with no caller-supplied symbols, so a request cannot amplify vendor calls. That is 11 featured symbols plus up to 20 member symbols, fetched with 6 in parallel.
- **Caching:** the Worker is reached only through `*.workers.dev`, where Cloudflare documents working Cache API operations only for custom domains. Quotes are therefore cached in three layers:
  1. a per-isolate memo that holds **plain quote data** with an expiry. It never holds a Response or a promise shared across requests.
  2. `caches.default`, which takes effect once the Worker is behind a zone route or custom domain.
  3. the Yahoo subrequest itself, with `cf.cacheTtlByStatus` set to cache 2xx responses only, for at most 300 s.
- **Cache lifetimes:**
  - 45 s while the session is open;
  - 60 s for the first 10 minutes after the bell, so the closing print arrives;
  - otherwise the cache expires **at** the next open, capped at 6 h;
  - failures are held for 60 s.
- **Hard budget:** at most 40 vendor fetches per isolate per minute (`TAPE_BUDGET`). Over budget, a symbol shows its last known record (its age is still judged) or SOURCE_UNAVAILABLE. This protects the paper account's own Yahoo reads in the same Worker.
- **Browser polling** (`tapePollMs`):
  - every **90 s** while the regular session is open;
  - **one** more read at close + 5 min;
  - otherwise one wake-up at the next open + 60 s, capped at 6 h;
  - errors retry after 2 min while open and 15 min while closed;
  - paused while the tab is hidden, with an immediate refresh on return if the data is older than 90 s.
- **Production verification without a member session:** `GET /admin/signal10/tape` with `ADMIN_TOKEN` returns the member view through the same handler and caches.

## Calendar (America/New_York)

The NYSE published holidays and 1:00 p.m. early closes for 2026–2028 come from nyse.com/markets/hours-calendars, read 2026-10-10. Nasdaq observes the same days. Federal holidays that are trading days, such as **Mon 2026-10-12** and Veterans Day, are open. DST is handled with Intl. **Extend `HOLIDAYS`/`EARLY_CLOSES` in `src/signal10/tape.js` before 2029.** After that date the session reports CALENDAR_UNKNOWN and fails closed, so no LIVE badge is shown.

## Handoff wording

Links use `target="_blank" rel="noopener noreferrer external"`. Each link carries sr-only text "View <SYM> on Robinhood (opens in a new tab)". The tooltip and fine print say that prices, eligibility and any order happen entirely at Robinhood, that PropBetEdge places no orders, and that PropBetEdge is not affiliated with Robinhood. There is no Robinhood brokerage API, no broker token and no order path.

## Rollback
- **Prices off without a code deploy:** set `SIGNAL10_TAPE_QUOTES` to `off` in wrangler.jsonc and run `wrangler deploy`. This is a vars-only change, so the crons are untouched.
- **Full rollback:** redeploy the previous Worker version and the previous Vercel deployment. The release IDs are in the PR.
