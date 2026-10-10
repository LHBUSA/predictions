# PBE Market Tape: quote sources, use cases and the remaining gate (2026-10-10)

PBE Market Tape is our own acquisition, normalization and display layer. A source becomes **displayable** only when its terms permit the specific use. We treat these as separate use cases:

| Use case | Meaning | Example |
|---|---|---|
| **Internal research** | Values used inside our systems and never shown as quotes | Paper-account valuation inputs |
| **Derived analytics** | A displayed result computed from source data, with no quote shown | Rank changes, model scores |
| **Public / paid quote display** | Showing a price, change or quote time to a visitor or member | The ticker |

## Verified sources (primary documents, read 2026-10-10)

| Source | Access from Cloudflare | Display rights (public / paid) | Cost / paperwork | Status in Market Tape |
|---|---|---|---|---|
| **IEX Historical Data (HIST), TOPS 1.6** | Yes. JSON index `iextrading.com/api/1.0/hist?date=YYYYMMDD` plus a public Google Cloud Storage gzip pcapng (~9 GB compressed, ~38 GB raw per day). | **Yes / yes.** Policies §15: "IEX does not require an IEX Data Subscriber Agreement from any Person who receives, uses, or distributes IEX Historical Data." | $0. Credit line required, verbatim: "Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use." | **ACTIVE provider `iex-hist`.** IEX-venue last regular-session sale, next-day (T+1), with an exchange nanosecond timestamp. |
| IEX TOPS real-time | No. Cross-connect or extranet only. The old public `api.iextrading.com` endpoints return 403. | Redistribution allowed | Data Subscriber Agreement, **$1,000/month** (fee schedule effective 2026-10-01; SEC 34-105989) | Not used (paid) |
| IEX TOPS delayed | Only through a third-party Data Subscriber (a vendor). Policies: "cannot be obtained directly from IEX". | Free from IEX, with labels "IEX Delayed Price and Last Sale" / "IEX Market Data Delayed 15 minutes" | A vendor relationship is needed | Not available without a vendor |
| CTA / UTP SIP delayed (consolidated) | Through SIAC/vendors, not HTTPS | Delayed usage is fee-free | CTA "Agreement for Receipt and Use of Market Data" and UTP Vendor Agreement, signed by a company officer, **plus** a feed someone pays to delay | Gate (see below) |
| Nasdaq / NYSE / Cboe / MEMX / MIAX proprietary | Feeds or cross-connect | Agreements and fees | Paid | Not used |
| Yahoo Finance chart endpoint | Yes (unofficial) | **No / no.** help.yahoo.com SLN2310: no redistribution. YDN guidelines: non-commercial APIs may not go into paywalled products. Website display is not "personal use". | — | **Internal research only.** It is the existing Signal 10 paper-account valuation input (owner decision pending, docs/signal10/TAPE.md). Never displayed by the tape; its rights record is `{public:false, paid:false}`. |
| Finnhub (key in markets-proptechusa) | Yes | **No / no** ("strictly for personal use", no redistribution without written approval) | — | Not used. **Flag:** the pre-existing public route `predictions.propbetedge.ai/api/market-intelligence/market` proxies Finnhub quotes publicly. That is outside this tape and needs an owner rights decision. |
| Robinhood | Crypto Trading API only; no equities API | — | — | Stock pages are **links only** |

**Accuracy check (2026-10-09, full-day IEX parse versus the consolidated close):** SPY 778.51 vs 778.57, NVDA 229.35 vs 229.28, QQQ 751.26 vs 751.27, AMZN 262.42 vs 262.43, TSLA 382.68 vs 382.70. That is within about 0.05%. We label it "IEX last sale · <date> · IEX venue only · next-day" and never call it the official close or a live quote.

## The precise remaining gate for intraday prices

Same-day prices, delayed 15 minutes or real time, need **one** of the following:
1. A market-data vendor whose licence covers public display. This is a new paid resource and needs explicit owner approval naming the cost.
2. Signed CTA and UTP vendor agreements (by an officer of the company), plus a feed. Usage is fee-free but the feed is not.
3. A real-time IEX TOPS subscription at $1,000/month with connectivity.

Nothing else in our existing infrastructure provides permitted intraday U.S. equity quotes. The tape is built so that any of these becomes a new provider record with rights, with no UI or API change.

## Collector status
- **Parser:** `src/market-tape/iex-hist.js` (streaming pcapng / IEX-TP / TOPS 1.6, Workers- and Node-compatible). Tested on a synthetic capture and verified on the real 2026-10-09 file: 37.7 GB decompressed, 6.5M trades, 221k matched.
- **Lane:** `workers/pbe-predictions/src/iex-hist-lane.js`. It writes `pred_source_observations` rows keyed `iex:TOPS:<YYYYMMDD>:<SYMBOL>`, with class `official` and full provenance. It is idempotent.
- **Nightly automation is OFF** (`IEX_HIST_COLLECTOR="false"`). One full session costs about 410 s of CPU in workerd, which is over a single invocation's 300 s cap. The replacement is a resumable decompressor that checkpoints decoder state across one-minute cron steps overnight. It needs one small checkpoint table. Until then, sessions are loaded with the same parser code.
