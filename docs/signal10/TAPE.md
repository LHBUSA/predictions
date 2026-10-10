# PBE Market Tape on Signal 10: LINK-FIRST, NO QUOTES (issues #54, #56)

A slim "U.S. STOCKS" strip sits under the masthead on all five `/markets/signal-10/` pages. **SpaceX (SPCX) is pinned first**, followed by SPY, QQQ, NVDA, MSFT, AAPL, AMZN, GOOGL, META, TSLA and HOOD. Every stock links to its Robinhood stock page. Each item also shows the NYSE session state, the dated last close and the next open.

**This is a link-first tape, not a live-price ticker.** No price, change or quote time is shown to anyone, public or paid. The reason is that no quote source we have permits the display. A paywall is access control. It is not redistribution permission.

The tape is editorial. It is not the Signal 10 model, its Top 10, the simulated $10,000 paper account or its ledger. Members additionally see two separately labelled groups, taken from the immutable Signal 10 tables:
- **Top 10 · frozen <date>**, the model's research ranking;
- **Paper holdings**, which are simulated.

## Quote-source rights matrix (2026-10-10). Robinhood was checked first.

| Source | What it is | Public display | Paid (member) display | Decision |
|---|---|---|---|---|
| **Robinhood: our existing integration** (`workers/pbe-predictions/src/robinhood-crypto.js`, `ROBINHOOD_CRYPTO_*`) | Robinhood **Crypto Trading API**. The client refuses any path outside `/api/v2/crypto/`. | — | — | **Not a stock source.** It has no equity quotes and crypto keys grant no stock rights. It was not repurposed. |
| **Robinhood equities API** | Robinhood publishes none. Community libraries reverse-engineer the authenticated app API. | no | no | **Forbidden.** We don't scrape or reverse-engineer broker endpoints. |
| **Robinhood public stock pages** `robinhood.com/us/en/stocks/<SYM>/` | Public web pages | links only | links only | **Links only.** All 11 symbols answered 200 with the correct company title on 2026-10-10; a bogus symbol answers 404. Linking out grants no price rights. |
| **Yahoo Finance chart endpoint** (already used by Signal 10 `/live` and the paper-account marks) | Unofficial endpoint | **no** | **no** | **Rights hold.** Yahoo's guidance (help.yahoo.com SLN2310) says not to redistribute Yahoo Finance data. Its YDN guidelines (legal.yahoo.com) say non-commercial APIs may not be incorporated into paywalled products. |
| **Finnhub** (key exists in `LHBUSA/markets-proptechusa`) | finnhub.io terms: "strictly for personal use"; "can't be used by any business even internally without a written approval"; no redistribution without written approval | no | no | **Rights hold.** Needs written approval or a paid plan. No spend was made. |

Further existing sources from the repo inventory are recorded in the Market Tape contract docs (issue #56). **No existing source permits display. Every price field is null for every audience.**

## Switch: `MARKET_TAPE_QUOTES` = `off` plus a provider rights gate in code

Since `market-tape/1`, prices need **both** `MARKET_TAPE_QUOTES="on"` **and** a provider whose rights record in `src/market-tape/contract.js` permits the audience. The `yahoo-chart` record is `{ public: false, paid: false }`, so an environment flag alone can never show Yahoo prices. The contract is described in `docs/market-tape/CONTRACT.md`.

| State | Who sees prices | Vendor calls |
|---|---|---|
| **Deployed:** `MARKET_TAPE_QUOTES="off"` (owner order) | **Nobody.** The tape shows symbols, session, last close and next open, Robinhood links, and member research groups. | **Zero** |
| `on` + a provider whose rights cover the audience | That audience only | Through the collector (see CONTRACT.md) |

The first OFF deploy used `SIGNAL10_TAPE_QUOTES="off"` (Worker 8b954eb7). That variable has been replaced.

In OFF mode every security has `state = SOURCE_RIGHTS_HOLD` with last_price, previous_regular_close, change, observed_at and retrieved_at all null. The legacy view reports `quotes.withheld = "SOURCE_RIGHTS_HOLD"`. The UI says "Prices: source rights hold". It never shows a fake price or a green LIVE badge.

Production proof (2026-10-10, Worker 8b954eb7):
- the member view (read-only diagnostics route) returned 21 rows and 0 rows with any price, timestamp or fetch field, with the groups FEATURED and TOP10;
- the public view returned 11 rows, 0 priced, FEATURED only;
- both returned `private, no-store` with `Vary: Cookie`.

## Pre-existing `/live` paper-account quotes: audited, NOT changed here

`/v1/signal10/live` (All Access) already returns Yahoo-sourced `price`, `quoteTime` and `previousClose` for paper positions, plus `benchmarksQuotes` for SPY and QQQ, and computes the live NAV from them. The cron's `pred_s10_marks` also stores NAV derived from Yahoo closes.

The same rights analysis applies to displaying those raw quotes: membership is not permission. This PR does not widen that display and does not touch paper accounting. **This is an open owner rights decision** with two options:
1. Keep internal-only valuation and stop displaying raw quote fields.
2. Obtain rights.

## Calendar (America/New_York)

The tape uses the NYSE 2026–2028 published holidays and 1:00 p.m. early closes, from nyse.com/markets/hours-calendars, read 2026-10-10. Nasdaq observes the same days. Federal holidays that are trading days, such as **Mon 2026-10-12** and Veterans Day, are open. DST is handled. Past the calendar the session reports CALENDAR_UNKNOWN and fails closed. **Extend the calendar before 2029.**

## Handoff wording

Links open in a new tab with `rel="noopener noreferrer external"`. Each link carries the screen-reader text "View <SYM> on Robinhood (opens in a new tab)". The tooltip and fine print say that prices, eligibility and any order happen entirely at Robinhood, that PropBetEdge places no orders, and that PropBetEdge is not affiliated with Robinhood. There is no broker API, no token and no order path.

## Rollback

| What | How |
|---|---|
| Worker | `wrangler rollback`, or `versions deploy` to the previous version. Pre-tape Worker = `cca69ce7`. |
| Static pages | The previous Vercel deployment (ID in the release note). |
| Quotes | Already off. Turning them on needs written rights first. |
