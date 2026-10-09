# PBE Signal 10 — The $10,000 Experiment (issue #52)

Simulated paper research. No real money, no brokerage connection, no orders anywhere. Two record populations that are
never merged: **HISTORICAL_REPLAY** (backtest, reconstructed history) and **FORWARD_PAPER** (live since launch).

## 1. Data audit (2026-10-09)

| Need | Source used | Rights / cost | Notes |
|---|---|---|---|
| Daily OHLCV, splits, dividends (history) | Yahoo Finance chart API v8 (public, unofficial) | $0. Yahoo terms restrict redistribution and commercial use. **Owner licensing decision OWED before any public marketing.** We serve derived portfolio values to members only; raw bars are not published. | Raw responses cached immutably on E:\Workers\cache\signal10\raw (sha256 manifest). Returns `close` split-adjusted only; unadjusted prices rebuilt from split events (`src/signal10/data.js`). |
| Live quotes | Same endpoint (meta.regularMarketPrice + regularMarketTime) | Same caveat. Delay is not documented; the UI shows the source's own trade timestamp, never our fetch time. | Edge-cached 15 s. |
| Point-in-time universe | fja05680/sp500 "Historical Components & Changes (Updated).csv" (MIT), compiled from the public S&P 500 change record | $0, MIT | Last row 2026-08-18; forward lane re-reads it every EOD (falls back to the bundled copy and records which). |
| Cross-check | Nasdaq public historical endpoint | $0, unofficial | 50/50 sampled fill opens agree within 0.2%; 993/1004 sampled closes (misses = DXC spin-off, NKTR reverse-split adjustment conventions). |
| Existing Markets feed | markets-proptechusa (Finnhub /quote, ≤20 tickers) | existing key | Drops the quote timestamp; Finnhub candles are premium ("No data" from markets-technicals). Not used. |
| Rejected | Stooq (anti-bot wall — never bypassed), Finnhub candles (paid), any new vendor (no new paid data without approval) | | |

Fundamentals/valuation/earnings: **not in v1**. SEC EDGAR companyfacts is reachable and point-in-time (filed dates), but
mapping CIKs for delisted historical members was not built; adding it only for survivors would bias the backtest.

### Coverage of point-in-time S&P 500 member-days with price history
2016 81.1% · 2017 84.3% · **2018 86.4%** · 2019 88.9% · 2020 90.9% · 2021 92.1% · 2022 93.6% · 2023 95.2% · 2024 96.2% · 2025 97.5% · 2026 98.9%.
Backtest starts 2018-01-02, the first year with ≥ 85% (rule set before running). 132 member tickers are uncovered for some
days, mostly acquisitions/failures (AVB, EQR, EA, HOLX, K, IPG, WBA, HES, JNPR, DFS, ATVI, XLNX, CELG, TWTR, SIVB, FRC…).
**Residual survivorship bias remains and is labelled.** Identity traps found and fixed (`src/signal10/aliases.js`):
FB→META (FB is now a 2025 ETF), LB→BBWI (LB is now LandBridge), BBT→TFC (BBT now returns another bank), IR before
2020-03-02→TT, PARA/CBS/VIAC blocked (PARA returns Banzai International), plus 25 documented renames.

## 2. Model + manager (pre-registered)
`src/signal10/policy.js`, committed in **bd75be9 (2026-10-09 13:24 CDT) before any result**. Rank model
`signal10-rank/1.0.0`, manager `signal10-manager/1.0.0`. Same code runs the replay and the forward account.

## 3. Historical result (data cutoff 2026-10-08, dataset sha256 8222a5d7…, ledger sha256 224afafa…)
$10,000 → **$18,775.34** (+87.8%, CAGR 7.45%, max drawdown −30.6% 2026-06-22→2026-07-29; 47 of 106 months negative;
worst month 2026-07 −23.6%, best 2026-01 +18.5%; 771 fills; dividends $1,012.63; slippage $761.86; ~85% invested).
SPY same timing $30,709.53 (13.66%); QQQ $47,660.32 (19.50%); immediate top-10 comparator $30,584.24 (13.61%).
**The pre-registered strategy underperformed both benchmarks.** Research variants (post-hoc, in-sample) are in
`data/signal10/research-variants.json`; none beat QQQ. Cost sensitivity: 0 bps 7.37%, 10 bps 7.45%, 25 bps 6.64%, 50 bps 5.59%.

Reproduce: `node scripts/signal10/fetch-history.mjs` → `build-dataset.mjs --cutoff 2026-10-08` →
`run-backtest.mjs --cutoff 2026-10-08` (ledger hash must match) → `run-variants.mjs`.

## 4. Forward paper account (FORWARD_PAPER)
- Worker `pbe-predictions`, lane on the existing one-minute cron (no new crons): OPEN ≥ 09:45 ET (corporate actions,
  fills at the session open), EOD ≥ 16:20 ET (SPY final-bar gate, ≥ 90% universe bars, freeze snapshot, mark, decide),
  MARK every 5 min 09:30–16:05 ET. Kill switch `SIGNAL10` (wrangler var). Start date `SIGNAL10_START`.
- Tables (tkmln, sql/016, ledger row 20261009200000, append-only, RLS service-only): `pred_s10_runs` (claims),
  `pred_s10_events` (hash chain; STATE events carry the account head), `pred_s10_snapshots`, `pred_s10_marks`.
- Manual run: `POST /admin/signal10/run?kind=OPEN|EOD|MARK` with the admin token.
- A failed run after its claim leaves the claim row; re-run with a new claim key is a manual operation (run_key `EOD:<d>#2`).

## 5. API (Vercel `/api/*` → Worker `/v1/*`)
Public: `/v1/signal10/proof`. All Access (401/403/503, private, no DB read when not entitled): `/today`, `/live`,
`/backtest`, `/backtest/ranks`, `/ledger?origin=HISTORICAL_REPLAY|FORWARD_PAPER`.

## 6. Rollback
Worker: `wrangler rollback` to **bae61af4** (pre-Signal-10) or set `SIGNAL10` ≠ "true" to stop writes only.
DB: `sql/016_signal10_forward_ROLLBACK.sql` (export pred_s10_* first — it is permanent evidence).

## 7. Known v1.0.0 weaknesses (found 2026-10-09 by reading the replay ledger; NOT fixed in v1.0.0)
- **Stop-out / re-buy whipsaw:** there is no re-entry cooldown, so a name stopped out can be re-bought as a "dip" the
  next session (WDC: STOP_LOSS 2026-06-29, DIP_ENTRY 06-30, STOP_LOSS 07-08, DIP_ENTRY 07-09, STOP_LOSS 07-17). The July
  2026 memory/storage sell-off (SNDK, STX, WDC, MU) produced the worst month (−23.6%) this way. Stops+whipsaw cost about
  4 points of CAGR versus the no-stops research variant.
- **Only the one-day ≥8% drop is treated as a broken thesis**; a −20% ten-day slide still qualifies as a "dip".
- **Composite tilts to low-volatility/risk-adjusted momentum**, so the highest-volatility AI/semiconductor leaders rank
  lower than under pure momentum.
Any fix is a new version (v1.1+) whose backtest is IN-SAMPLE for 2018–2026 and must be labelled so; the forward account
keeps running the version it started with unless the owner approves a documented version change (recorded in the ledger).
