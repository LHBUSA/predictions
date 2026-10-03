# PBE Crypto Nowcast — first-deliverable audit (2026-10-03)

Scope: research only. Nothing was deployed, no model was registered, no resource was created, no Kalshi client was
added to the repo. Market data was read with a handful of unauthenticated public GETs (no 429s encountered).
Data downloaded for the replay lives outside the repo in `D:\Workers\scratch\crypto\`.
Research scripts: `scripts/research/crypto/fetch-1m.mjs`, `replay-v0.mjs`, `feature-audit.py`.

**Bottom line:** the modeling is easy and the baseline already works; **the blockers are rights, not math.**
(1) The contract settles on CF Benchmarks' BRTI, a proprietary licensed benchmark. (2) Every free underlying source
we could use (Coinbase, Kraken, Bitstamp, Gemini — the BRTI constituents) restricts commercial use/display without
permission. Recommendation at the end: **do not enter SHADOW yet**; two owner decisions unblock it.

---

## 1. Kalshi BTC 15-minute contract — exact semantics

Series **`KXBTC15M`** ("Bitcoin price up down"), frequency `fifteen_min`, category Crypto, contract terms
`https://assets.kalshi.com/contract_terms/CRYPTO.pdf`, settlement source **CF Benchmarks**
(series metadata: `GET https://api.elections.kalshi.com/trade-api/v2/series/KXBTC15M`).

| Field | Value (verified from public market objects, 200 settled windows) |
|---|---|
| Ticker pattern | `KXBTC15M-26OCT031745-45` (event `KXBTC15M-26OCT031745`; time = window **close** in ET) |
| Window | `open_time` → `close_time`, 15 minutes, aligned to :00/:15/:30/:45 UTC; markets listed ahead as `initialized` |
| YES condition (rules_primary) | "If the simple average of the sixty seconds of CF Benchmarks' BRTI before **close** is **at least** the simple average of the sixty seconds of CF Benchmarks' BRTI before **open**, then the market resolves to Yes." |
| Strike | `strike_type = greater_or_equal`, `floor_strike` = the open-time 60-s BRTI average, shown as "Target Price: $84,694.41"; `custom_strike.round_digits = 2`. Before open the target is "TBD". |
| Chaining | Each window's strike equals the previous window's `expiration_value` — verified **199/199** consecutive pairs. |
| Equality | "at least X" = X or greater (terms) → a tie resolves **YES/UP**. |
| Expiration value | 60-s simple average of BRTI before close, **rounded to 2 decimals** (rules_secondary). |
| Settlement timing | `settlement_ts` − close: median **4.0 s**, max 14.1 s (n=200); `settlement_timer_seconds = 1`. Latest expiration one week after date. |
| Revisions | "Revisions to the Underlying made after Expiration will not be accounted for." |
| Missing data | "If no data is available or incomplete … affected strikes resolve to No." (terms) — i.e. a data outage resolves **DOWN**, not void. |
| Review | Kalshi may open a Market Outcome Review (Rule 6.3(d)); payouts under 6.3(b) if no value can be determined. |
| Base rate | 98/200 UP (49 %) on 2026-10-01 20:00Z → 10-03 22:00Z. |

**BRTI** (CME CF Bitcoin Real Time Index): computed every 200 ms from the consolidated order books (not trades) of
the constituent exchanges — mid price-volume curve over a dynamic "utilized depth", erroneous-book filter at 0.5 %
deviation from the median mid (CF RTI Methodology v17, §4–6, `docs.cfbenchmarks.com/CME CF Real Time Indices Methodology.pdf`).
Constituents (reported 2026): **Bitstamp, Coinbase, Gemini, itBit/Paxos, Kraken** — verify against CF's published
constituent list before relying on it.

**Rights:** CF's methodology states "Any use of or access to products, services or information of CF Benchmarks Ltd
requires a license" and derived works need a separate Derived Data License. Kalshi offers an authenticated
"CF Benchmarks Value Feed" websocket (BRTI + trailing 60-s averages) — it is Kalshi-authenticated venue data, and the
index values remain CF's IP. **We must not ingest, store or display BRTI values themselves.**

**Can we verify settlement from free data?** Partly. A proxy — mean of the 1-minute typical price
((o+h+l+c)/4) of the minute before each boundary on Bitstamp + Coinbase (two constituents) — against Kalshi's published
`expiration_value` over 200 windows: median |error| **$4.33**, p95 $15.56, max $25.08, mean bias −$0.57; the proxy
reproduces the UP/DOWN result in **189/200 (94.5 %)**. The median 15-minute move is $44.88 (p10 $6.19), so the proxy
is a good *check* but cannot independently decide near-target windows. Resolution would have to come from Kalshi's
published result (as weather already does with venue settlement) with the proxy as an independent flag.

**Policy consequence (plain):** under the current house rule — contracts that settle on a commercial/proprietary
dataset stay **MARKET MONITORING** (the Amazon-headcount precedent) — `KXBTC15M` is MARKET MONITORING today.
Modeling it requires an explicit owner exception: "settlement taken from the venue's published value, never from
CF data we ingest; independently checked by a free-exchange proxy; no BRTI value stored or displayed."

## 2. Independent underlying sources (free, no new account)

| Source | Public endpoints (no key) | BRTI constituent | Commercial use / display |
|---|---|---|---|
| Coinbase Exchange | REST candles/trades/book, WS ticker/matches/level2 (`api.exchange.coinbase.com`) | yes | **Market Data Terms:** use "exclusively for … personal or research purposes", "may not be used to build an application intended for use by end users", no redistribution/display of data **or derived analytics** without written consent (`coinbase.com/legal/market_data`). |
| Kraken | REST OHLC/Trades/Depth, WS v2 | yes | Prior permission required for "any non-personal commercial use of data from publicly accessible endpoints, such as market data" — `marketdata@kraken.com`. |
| Bitstamp | REST ohlc/transactions/order_book, WS | yes | Commercial use requires signing a **Data License Agreement** (`partners@bitstamp.net`); the licence then allows redistribution and derived works. Cost not published. |
| Gemini | REST candles/trades/book, WS | yes | Gemini Market Data Agreement: licence limited to "Permitted Use"; proprietary; redistribution only for licensed OEMS providers. |
| Binance.com | — | no | Not usable from the US; not a constituent. |
| Chainlink BTC/USD streams | data.chain.link (Polymarket's oracle) | no | Not assessed for commercial terms; not BRTI. |

Rate limits (public docs, approximate — verify before building): Coinbase ~10 req/s per IP; Kraken counter-based (~1 req/s sustained for REST);
Bitstamp 400 req/s (8000/10 min); Gemini 120 req/min. Latency: REST 1-minute candles are complete within ~1–3 s of
the minute; a 1-minute Worker cron is the finest cadence available without a new paid product.

**Every viable free source requires permission for commercial use; Coinbase's terms also cover derived analytics.**
An internal, non-public SHADOW research model is closest to Coinbase's "research purposes" allowance; anything shown
to users (the price, the target race, and arguably the PBE probability itself as derived data) needs written consent.

## 3. Historical / replay availability

| Source | 1-minute candles | Trades | Order book |
|---|---|---|---|
| Bitstamp | `ohlc?step=60&limit=1000&start=` — multi-year | `transactions` last day only | live only |
| Coinbase | `candles?granularity=60` — 300 bars/request, history to 2015 | paginated full history (slow) | live only |
| Kraken | `OHLC` last **720** bars only; quarterly OHLCVT CSV downloads | `Trades?since=` full history | live only |
| Gemini | v2 candles — recent window only (verify) | recent | live only |

Pulled for this audit: 28 days of BTC/USD 1-minute bars, Bitstamp 40,320/40,320 and Coinbase 40,319/40,320 minutes
(2026-09-05 22:02Z → 2026-10-03 22:01Z). **No free historical order-book data exists**: spread and imbalance
features can only come from our own forward collection.

## 4. crypto-v0 baseline replay (`crypto-threshold-diffusion-baseline@0.1.0`)

Method (`scripts/research/crypto/replay-v0.mjs`): 2,680 windows aligned to quarter-hours; target = proxy reference
price at open; forecast at T-14 (first minute after open), T-10, T-5, T-1 using only completed candles:
S = last minute close (mean of both exchanges), σ = realized vol of trailing 60 one-minute log returns (annualized;
median 26.6 %, p10 12.5 %, p90 49.9 %), horizon = minutes left − 0.5, drift/funding 0. Outcome = proxy UP/DOWN
(checked against Kalshi's real results below). No market prices anywhere. Chronological holdout = last 25 % (667 windows).

| Checkpoint | v0 Brier (holdout) | v0 log loss | 50 % Brier / LL | Climatology Brier / LL |
|---|---|---|---|---|
| T-14 (≈FIRST_PUBLISHED) | 0.2347 | 0.6625 | 0.2500 / 0.6931 | 0.2503 / 0.6937 |
| T-10 | 0.1770 | 0.5306 | 0.2500 / 0.6931 | 0.2503 / 0.6938 |
| T-5 | 0.1232 | 0.4132 | 0.2500 / 0.6931 | 0.2503 / 0.6938 |
| T-1 | 0.0336 | 0.1127 | 0.2500 / 0.6931 | 0.2503 / 0.6938 |

Holdout calibration at T-5 (n per bin): 0–10 % → obs 6.5 % (123) · 10–20 % → 12.5 % (56) · 20–30 % → 16.0 % (50) ·
30–40 % → 18.2 % (44) · 40–50 % → 41.9 % (43) · 50–60 % → 62.7 % (51) · 60–70 % → 64.0 % (50) · 70–80 % → 81.1 % (53) ·
80–90 % → 85.0 % (60) · 90–100 % → 97.8 % (137). Reasonable overall; slightly under-confident in the middle bins, and
the extremes are not extreme enough (0–10 % bin realizes 6.5 % vs 2.9 % forecast).

Scored against **Kalshi's actual results** on the 196 overlapping windows: Brier T-14 0.240, T-10 0.190, T-5 0.144,
T-1 **0.055** (vs 0.036 on proxy labels). The T-1 degradation is the proxy-vs-BRTI error ($4 median) becoming
comparable to the remaining one-minute move — a production model must carry an explicit settlement-index noise term.

**Is v0 legitimate at 15 minutes?** As a baseline, yes: zero-drift lognormal terminal probability with a trailing
realized vol is the right first-order structure, and it beats 50 % at every checkpoint. Assumptions that do not hold
and must be fixed in a v1: (a) settlement is a 60-s **average** of an order-book index, not a terminal spot price;
(b) the reference index differs from any single exchange (noise term above); (c) the annualized-vol input should be
a short-window realized vol, not the daily/annual figure v0 was designed for; (d) `fundingAnnualized` is irrelevant
at this horizon and should be zero/absent. At T-14 the honest answer is near a coin flip (Brier 0.235); the
product copy must say so.

## 5. Short-horizon feature audit (chronological holdout, `feature-audit.py`)

Holdout log loss (lower is better), 670 windows per checkpoint:

| Model | T-14 | T-10 | T-5 | T-1 |
|---|---|---|---|---|
| v0 diffusion | 0.6629 | 0.5313 | 0.4130 | 0.1133 |
| v0 with fitted vol scale | 0.6628 (×1.02) | 0.5326 (×1.10) | 0.4110 (×1.06) | 0.1094 (×0.88) |
| logistic: z (distance / σ√τ) | 0.6633 | 0.5322 | 0.4007 | 0.1082 |
| + 5-min momentum | 0.6638 | 0.5319 | 0.4020 | 0.1083 |
| + vol ratio (15m/60m) and interaction | 0.6622 | 0.5298 | 0.3982 | 0.1079 |
| + time of day | 0.6624 | 0.5303 | 0.3994 | 0.1094 |

Distance-to-target in volatility units carries essentially all of the signal. Momentum and time of day add nothing;
a vol-regime ratio helps marginally (≤0.015 LL at T-5, within noise for n=670). Point-in-time availability:

| Feature | Free & point-in-time? |
|---|---|
| current price, distance to target, time remaining | yes (exchange candles/trades) |
| realized vol 1m/5m/15m/1h, returns/momentum, vol regime | yes (derived from candles) |
| trade velocity | yes, forward only from trades endpoints (Kraken has history) |
| spread, order-book imbalance | forward collection only; no free history; rights as §2 |
| funding / perp basis | not from free US-accessible constituents; not worth it at 15 min |
| time-of-day/session | yes; no measurable value here |

Leakage-guard note: today's `MARKET_KEY_PATTERN` rejects any key containing `order_book`, `volume` or `traded`, so
underlying-exchange microstructure features would be refused by name. That is the right default — see §7.

## 6. Polymarket exact-match availability

Polymarket lists **BTC Up or Down** markets every 15 minutes (and every 5 minutes), e.g. event slug
`btc-updown-15m-<window-start-epoch>`, outcomes ["Up","Down"], `eventStartTime`/`endDate` on the same quarter-hour
boundaries as Kalshi, listed about a day ahead (gamma-api `GET /events?slug=…`).

Resolution: "Up" if the **Chainlink BTC/USD 60-second TWAP data stream** at the end of the range is **greater than or
equal to** the price at the beginning (`data.chain.link/streams/btc-usd-twap-60s-streams`; UMA-resolved).
Comparison with Kalshi:

| | Kalshi KXBTC15M | Polymarket btc-updown-15m |
|---|---|---|
| Window | same quarter-hours | same quarter-hours |
| Rule | 60-s avg at close ≥ 60-s avg at open | 60-s TWAP at end ≥ price at start |
| Tie | UP | UP |
| Index | CF BRTI (order-book, 5 exchanges) | Chainlink data stream (different aggregation) |
| Sample agreement | — | 5/5 windows 20:30–21:45Z Oct 3 resolved identically |

**Not exactly comparable**: same question shape, different oracle; they will disagree on near-target windows. If shown,
label it "same window, different reference index" and measure the venue-disagreement rate before using it in any
comparative claim. Polymarket API/data terms for commercial display were not assessed and must be before display.

## 7. UI wireframe and data contract — `/crypto/` (design only)

```
PBE CRYPTO NOWCAST · BTC · 15 MIN                 [RESEARCH | SHADOW: internal only]   08:42 left
TARGET  (Kalshi strike, venue data)        NOW (blocked until display rights)   Δ abs / Δ %
PBE  UP 64 %  ·  DOWN 36 %          as of 12:03:14Z · model crypto-nowcast-v1@x · data age 2 s
MARKETS   Kalshi  89/11 (mid, ts)   ·   Polymarket 71/29 (same window, different index — disclosed)
TARGET RACE   price path (open → now) · target line · expiry · ±1σ√τ band (valid for the diffusion model)
PROBABILITY PATH   PBE / Kalshi / Polymarket — each point a stored timestamped observation; gaps stay gaps
EVIDENCE   distance (σ units) · realized vol (window) · minutes left · data freshness · model version · forecast id
           contribution bars ONLY if the deployed model is additive in log-odds (logistic) — never for the raw diffusion
SETTLEMENT (frozen)   target · venue expiration value (Kalshi) · proxy check (Δ$) · result · designated PBE/Kalshi/
           Polymarket probabilities · Brier/log loss contribution
TRACK RECORD   by horizon/designation · asset · vol regime (σ terciles) · distance bucket (|z|) · PBE vs Kalshi ·
           PBE vs Polymarket · Kalshi vs Polymarket — n always shown; no skill claim below the minimum sample
```

Data contract (per window `contract_id = kalshi:KXBTC15M-…:contract-norm/1:sha`):
`{ asset, horizon_min:15, open, close, settle_rule:"avg60(close) >= avg60(open)", tie:"UP", missing:"DOWN",
target:{ value, source:"kalshi.floor_strike", observed_at }, underlying:[{ t, exchange, price, source_id }],
pbe:[{ forecast_id, t, p_up, model, cutoff, features_sha, designation[] }], kalshi:[{ t, bid, ask, mid }],
polymarket:[{ t, bid, ask, mid, comparability:"SAME_WINDOW_DIFFERENT_INDEX" }],
resolution:{ venue_result, venue_expiration_value, proxy_value, proxy_agrees, resolved_at } }`.

Scoring designations (deterministic, created only when the timing condition is met; reference = close):
`FIRST_PUBLISHED` (first forecast captured ≥ open), `T_MINUS_10`/`T_MINUS_5`/`T_MINUS_1` (latest forecast captured
≤ close − k min and ≥ open), `FINAL_PRE_RESOLUTION` (latest forecast captured < close − 60 s, i.e. before the
settlement averaging window starts). Market benchmark for a designation = the venue mid captured within ±30 s of the
forecast, else null (no interpolation).

Leakage guard (describe, not implemented): add `polymarket|clob|outcome_?prices?|gamma|uma` to `MARKET_KEY_PATTERN`;
add `brti|cf_?benchmark|rti|expiration_value|chainlink` (settlement indices are never features); keep `venue` out of
`MODEL_SOURCE_CLASSES`; add an `exchange` source class whose feature names must match a strict `underlying_*`
allowlist (so `underlying_trade_velocity` passes by allowlist while bare `volume`/`order_book` keys still fail); the
contract strike enters as a contract parameter (like a weather threshold), never as a feature; mirror all of it in
the `pred_features_market_free` CHECK via an additive migration; extend the invariance test to shift Kalshi *and*
Polymarket prices.

## 8. Observation and storage volume (BTC only; ETH doubles it)

| Stream | Cadence | Rows/day | Est. bytes/day |
|---|---|---|---|
| Underlying, 1-min bars × 2 exchanges | 1/min | 2,880 | ~0.7 MB |
| Underlying second-level reconstruction (to mirror the 60-s average) | 1 row/min/exchange holding 60 prices | 2,880 | ~6 MB |
| Kalshi snapshots (1–2 live windows) | 1/min via propsports-markets | 1,440–2,880 | ~1 MB |
| Polymarket snapshots | 1/min | 1,440 | ~0.5 MB |
| PBE forecasts + feature snapshots | 1/min while a window is open | 1,440 + 1,440 | ~2–3 MB |
| Designations / resolutions / scores | per window | 96 × (5 + 1 + 10) | <0.3 MB |
| **Total** | | **~11–13k rows/day** | **~10–12 MB/day ≈ 4 GB/yr** |

Constraints: tkmln is small and shared (max_connections 90; see the 2026-09-28 overload) — ~9 small writes/minute is
fine if batched into one request per table per minute, but 4 GB/yr of growth needs a retention/compaction plan
(e.g. keep per-second rows 30–90 days, then 1-minute bars) and may raise database spend → owner cost decision.
Kalshi capture must go through the canonical propsports-markets service and its shared rate budget; 1-minute polling
of KXBTC15M is new load on it and must be coordinated (that service must not be edited while another session owns it).
Workers: a 1-minute cron on the existing Worker is not a new product; anything sub-minute or push-based for the live
terminal (Durable Objects, Queues, WebSocket fan-out, a new KV namespace) is a **billable resource that needs an
explicit owner "yes, create it"**. The page can poll a cached Worker endpoint every 10–15 s instead.

## Recommendation

**Do not enter SHADOW yet.** The model side is ready: a v1 candidate = v0 structure with a short-window realized vol,
the 60-s-average settlement correction and a settlement-index noise term (expected holdout gain at T-5 ≈ 0.01–0.015
LL over v0; extra features unjustified at current n). Two blockers are owner decisions, not engineering:

1. **Settlement source.** BRTI is a licensed proprietary benchmark. Under the current rule KXBTC15M is MARKET
   MONITORING. Proceeding requires an explicit exception: resolve from Kalshi's published value only, check it with
   the free-exchange proxy (94.5 % result agreement, $4.33 median error), never ingest/store/display BRTI.
2. **Underlying-data rights.** Each constituent exchange requires permission for commercial use, and Coinbase's terms
   cover derived analytics. Free written requests (Coinbase consent; `marketdata@kraken.com`; Bitstamp DLA via
   `partners@bitstamp.net`; Gemini Market Data Agreement) should go out before anything public. An internal,
   never-displayed SHADOW run on Coinbase public data is the most defensible interim position, but only with owner
   sign-off on that reading.

Once both are cleared: SHADOW with BTC only, Kalshi benchmark only (Polymarket displayed only after its own terms
check, labelled "different index"), the five fixed designations, 1-minute cron, batched writes with a retention plan,
and a promotion gate of ≥2,000 resolved live windows (~3 weeks) with Brier and log loss beating v0 and calibration
within bins at T-5 and T-1. No trading integration, no wallet, no prediction-market prices in features.
