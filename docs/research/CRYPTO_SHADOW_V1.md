# BTC 15-minute nowcast — SHADOW V1 (frozen protocol)

Owner decision 2026-10-04: **proceed to BTC SHADOW.** Follows `CRYPTO_NOWCAST_AUDIT.md` (cc427d8), whose two blockers
the owner resolved:

- Public BTC exchange observations are research / model **inputs**. Raw exchange feeds are not republished or stored
  as a data product; only our derived features, probabilities, designations and scores are stored.
- CF Benchmarks' **BRTI is never ingested, stored or displayed.** Kalshi's `floor_strike` and `expiration_value`
  (both BRTI averages) are dropped at parse time; `sql/009` has no column that could hold them (proved).
- The contract resolves from **Kalshi's published result** (yes = UP). Our exchange proxy is stored beside it as an
  independent check (`proxy_agrees`), never as the outcome.
- Kalshi and Polymarket are **benchmarks, never inputs** (features pass `buildFeatureVector` + the DB market-free CHECK).
- **No public activation.** `pred_crypto_*` tables are read by no public route; nothing reaches `pred_events`, the
  live slate or the sitemap. A displayed product (and any branded exchange quote / book display) is a later, separate
  review.

## Frozen for the whole run — no tuning while it runs

| Item | Frozen value |
|---|---|
| Asset / contract | BTC, Kalshi `KXBTC15M` (UP if avg60(close) >= avg60(open); tie UP; missing data DOWN) |
| Model | `crypto-threshold-diffusion-baseline@0.1.0` (`src/models/crypto-v0.js`), exactly as replayed (`scripts/research/crypto/replay-v0.mjs`) |
| Target K | OUR proxy: mean typical price ((o+h+l+c)/4) of the minute [open-60s, open) on Bitstamp + Coinbase |
| S, sigma, horizon | mean close of the last completed minute; annualized realized vol of the trailing 60 one-minute log returns; minutes from data cutoff to close - 0.5 |
| Cadence | one forecast per minute (cron `* * * * *`) from open until close - 60 s (the settlement averaging window) |
| Designations (`crypto-designation/1`, reference = close) | FIRST_PUBLISHED = first forecast >= open; T_MINUS_10 / T_MINUS_5 / T_MINUS_1 = latest forecast in [open, close - k min]; FINAL_PRE_RESOLUTION = latest forecast < close - 60 s |
| Benchmarks | each venue's observation captured within +-30 s of the designated forecast, else none (no interpolation). Kalshi = SAME_CONTRACT (mid of yes bid/ask when width <= 0.10). Polymarket `btc-updown-15m-<open>` = SAME_WINDOW_DIFFERENT_INDEX (Chainlink stream), quote from the Up token's CLOB book — Gamma's bestBid/bestAsk lag (2026-10-04 15:18Z: 0.47/0.48 vs book 0.70/0.71) |
| Scores | Brier + log loss per designation for PBE, Kalshi and Polymarket on the same window; Polymarket reported separately, never pooled with Kalshi |

With a 1-minute cron, a forecast lands a few seconds after each minute boundary, so T_MINUS_1 and
FINAL_PRE_RESOLUTION normally designate the same forecast (captured about 2 minutes before close). That is a property
of the frozen rule, not a bug, and is reported as such.

## Promotion gate (evaluated once, after >= 2,000 resolved windows, about 3 weeks)

At T_MINUS_5 and T_MINUS_1: PBE Brier and log loss beat the 50 % baseline and climatology; calibration within bins
(10 bins, observed within the binomial 95 % band in >= 8 of 10 populated bins); the proxy-vs-Kalshi agreement rate
reported. PBE vs Kalshi is reported, not a gate. A v1 model (short-window vol, 60-s average correction, settlement
noise term) is a new protocol version evaluated on fresh windows, never a mid-run change.

## Operations

- Storage: `sql/009_crypto_shadow.sql` (+ `_PROOF.sql`, `_ROLLBACK.sql`; PGlite proof `scripts/db/prove-009.mjs`).
  About 1,440 forecasts + 2,880 venue rows + 96 x (5 designations + 1 resolution + 10 scores) per day, written in
  2-4 small requests per minute.
- Switch: `CRYPTO_SHADOW` var on pbe-predictions (`"false"` stops the shadow; the */15 engine cycle is untouched).
- Requests per minute: Coinbase 1, Bitstamp 1, Kalshi 1-2 via propsports-markets, Polymarket 2 (Gamma + CLOB).
