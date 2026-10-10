# PBE Signal 10 Strategy Arena — PRE-REGISTRATION (issue #62)

**Frozen 2026-10-10, before any Arena decision, backtest or forward result exists.** Three philosophies, one market,
a permanent record. **Owner correction (2026-10-10): the competition is THREE brand-new $10,000 accounts launched
together** — ORIGINAL (the unchanged V1 rules on a new, empty account), TECH and DIVERSIFIED — with the same cash, zero
positions, the same market snapshot and the same T0. The legacy V1 account (`S10-FWD-1`, funded 2026-10-09) continues
separately as historical research and is not a competitor; its holdings and NAV are never used in the Arena. Simulated paper accounts only: no brokerage connection, no real orders, no margin, shorting, options
or futures.

The binding record is the **policy sha256** of each challenger: `sha256(canonical({arena, strategy, account, model,
policy, universe, rank, manager}))` over the frozen objects in `src/signal10/arena/policies.js`. It is written into the
FUNDING event and stamped on **every** ledger row (`policy_sha256`). `test/signal10-arena.test.js` fails if this
document and the code disagree. Any parameter change is a new version string with its own account; records made under
a version keep that version forever. No parameter is tuned on observed returns.

| Strategy | Account | Rank model | Manager policy | Policy sha256 |
|---|---|---|---|---|
| ORIGINAL (V1 rules, new account) | `S10-ARENA-ORIG-1` | `signal10-rank/1.0.0` | `signal10-manager/1.0.0` | `1d6401f651ed37309889dc34dd11592cc55fca32d11b27a0505ca3e335cf280e` |
| TECH / Technology Conviction | `S10-ARENA-TECH-1` | `signal10-tech-rank/1.0.0` | `signal10-tech-manager/1.0.0` | `7832d3cbf7756752e0e1c623a2eb83a1a11f93632659029063e41251749f571a` |
| DIVERSIFIED / Risk Discipline | `S10-ARENA-DIV-1` | `signal10-div-rank/1.0.0` | `signal10-div-manager/1.0.0` | `00f38b93e2c69a3e6bb15ca6cccd4dcfe8071bab7756b374e9e3c3268ae12b02` |

Arena version `signal10-arena/1.1.0` (1.0.0 = the two-challenger design superseded on 2026-10-10 before any record). Implementation at preregistration (source sha256, informative; the engine may
receive reviewed bug fixes **before** T0, each recorded below; after T0 any behaviour change is a new version):
`policies.js 044206fe…`, `engine.js 712adee0…`, `taxonomy.js 45e74cbd…`, `market-tape/metals.js aea80e9a…`.

## 1. ORIGINAL = the unchanged V1 algorithm on a new account; the legacy V1 account is not touched
ORIGINAL imports `RANK` and `MANAGER` from `src/signal10/policy.js` (not a copy), ranks with V1's `rankUniverse`
(`src/signal10/rank.js`) on the full S&P 500 member list, decides with V1's `decide()` (`src/signal10/portfolio.js`) and
uses V1's SPY 200-day regime rule (fewer than 200 bars = risk-off, as in V1). A test proves that over 8 sessions every
ORDER, DECISION and FILL equals the legacy V1 lane's on identical inputs; an independent differential probe (25 sessions,
risk-off, crash, splits) found no other decision difference. The differences are Arena-wide execution and record
conventions, shared by all three accounts and listed here in full:
1. **Split on a fill day:** a SELL sized at the previous close sells the whole post-split position (the legacy lane sells
   the pre-split share count, a known defect).
2. **A series that ends is liquidated:** a holding whose source series stops for 3 sessions is sold at its last observed
   close (DELIST_LIQUIDATION, flagged ESTIMATE) — the V1 backtest's rule. The legacy forward lane never liquidates such a
   name, so from that point its cash and decisions would differ.
3. **Stale marks are NOT AVAILABLE:** if any holding has no observed close, that day's EOD NAV is stored as NULL (coverage
   < 1) instead of a NAV built on a stale price; the gap is never interpolated. Decisions are unaffected.
4. **Fail-closed per account:** a held symbol whose source returns nothing is handled per §5 (the legacy lane throws on
   every EOD after that, a known defect).
5. **NYSE early closes:** the final-close gate is 13:00 ET on early-close days (the legacy lane skips those EODs).
Sector labels on ORIGINAL's holdings are display metadata, never a rule input.

### The legacy account is not touched
`S10-FWD-1`, `signal10-rank/1.0.0`, `signal10-manager/1.0.0`, its ledger, holdings, fills, scheduler, frozen ranks and
history are not modified by the Arena. Golden proof: `test/signal10-arena.test.js` pins the sha256 of the V1 algorithm
and data files and `sql/016`; a second test proves the Arena code never names a legacy table, the legacy account or the
legacy kill switch. All three Arena accounts use V1's pure accounting helpers read-only (fills at the open, splits,
dividends, delist liquidation, EOD mark), so execution conventions are identical across the Arena — selection, sizing,
regime, exits and caps are each strategy's own. The legacy account keeps its own inception and ledger as separate
history (its writer repair is issue #69).

## 2. Securities, membership and taxonomy
- **Membership:** S&P 500 point-in-time members from fja05680/sp500 (MIT), read at every EOD — the control's source.
  Bundled fallback = the same `members-latest.js` row; the snapshot records which was used and its sha256.
- **Identity:** the price-source symbol is resolved through the control's alias table (`aliases.js`, e.g. FB→META);
  a reused ticker is never joined to an unrelated earlier security.
- **Sector taxonomy `pbe-sic-sectors/1.0.0`** (`src/signal10/arena/taxonomy.js`): the SEC-assigned Standard Industrial
  Classification of each registrant (data.sec.gov submissions; U.S. government data, no licence fee) mapped by ordered
  SIC ranges to 11 sectors. This is **not GICS** and is disclosed as such (Alphabet/Meta SIC 7370 = Technology; Visa/
  Mastercard SIC 7389 = Industrials; Amazon SIC 5961 = Consumer discretionary).
- **Dated classification snapshot** `data/signal10/arena/classification.json`: effective **2026-10-10**, content sha256
  `4da461401070a3104975026b81244a05fe2c9ab00399d22984e66a483b81e447`; 503 members, 502 classified, 78 technology.
  A snapshot never classifies a date before its effective date. Refreshes are new dated files (old hashes stay in the
  ledger snapshots); never edited in place.
- **Out of coverage:** a member with no SEC ticker match or no SIC is UNCLASSIFIED: listed in every snapshot, never
  traded by TECH or DIVERSIFIED (2026-10-10: PSKY). ORIGINAL has no taxonomy rule (V1 universe) and may trade it. A company added to the index after the snapshot is UNCLASSIFIED
  until a new dated snapshot is published; a held position keeps the sector it had when bought.

## 3. TECH / Technology Conviction (`S10-ARENA-TECH-1`)
- **Universe:** members whose SIC is in the technology ranges (computers/storage 3570–3579, semiconductor equipment 3559,
  communications equipment 3661–3669, electronic components & semiconductors 3670–3679, semiconductor test/inspection
  3825/3827, computer wholesale 5045, software/IT/cloud services 7370–7379). Never ETFs, metals or commodity proxies.
  Concentration is 100% technology **by design** and is reported every session.
- **Eligibility:** ≥ 253 bars, close ≥ $5, 63-session median dollar volume ≥ $50M, ≤ 5 missing sessions in the window.
- **Rank:** percentile composite of mom12-1 0.30, mom6 0.30, mom3 0.20, trend50 0.10, 52-week-high proximity 0.10. No
  volatility penalty (the control's low-volatility tilt is deliberately absent).
- **Regime:** new buys only while QQQ ≥ its 200-day average. After **10 consecutive** risk-off closes: DERISK sells
  holdings below their own 200-day average.
- **Entries:** top-8 names above their 50-day average with a one-day return > −8% (buys strength, no dip required); ≤ 4
  new names per session; 8 slots; target 12.5% of NAV each.
- **Exits:** rank > 20; trailing stop −25% from the highest adj close since entry; DERISK as above.
- **Re-entry:** a name sold by TRAILING_STOP or DERISK cannot be re-bought for **10 sessions**.
- **Trim:** a holding above 20% of NAV is sold back to 15%. **Rotation:** with all slots full, a rank ≤ 2 candidate
  replaces the weakest holding when that holding ranks > 12 (≤ 1 per session).

## 4. DIVERSIFIED / Risk Discipline (`S10-ARENA-DIV-1`)
- **Universe:** every classified member (all 11 sectors) plus the precious-metal ETF sleeve (GLD, SLV, PPLT) when each
  instrument passes the registry (`src/market-tape/metals.js`): SEC registrant identity (ticker → CIK → exchange),
  ≥ 253 bars, a bar on the decision date on an equity session, and no corporate action unknown to the registry (SLV's
  2008-07-24 and PPLT's 2026-05-18 10-for-1 splits are registered, each from SEC filings). Spot XAU/XAG/XPT are **never** used to simulate ETF fills.
- **Eligibility:** ≥ 253 bars, close ≥ $5, median dollar volume ≥ $25M, ≤ 5 missing sessions.
- **Rank:** risk-adjusted momentum (mom12-1 ÷ 252-day vol) 0.35, low 63-day vol 0.20, 52-week resilience 0.15,
  trend200 0.15, mom6 0.15.
- **Regime:** new **equity** buys only while SPY ≥ its 200-day average; the metal sleeve may enter in either regime.
- **Equity entries:** rank ≤ 25, above the 200-day average, one-day return > −8%; ≤ 2 names per sector; ≤ 12 equity
  holdings; ≤ 4 new names per session (equities + metals). No mandate to fill every slot; cash is allowed.
- **Sizing:** inverse volatility: weight = min(10%, 1.5% ÷ annualized 63-day vol), further limited by the sector cap
  and available cash.
- **Metal entries:** ETF above its 200-day average with positive 6-month momentum; same inverse-vol size; sleeve ≤ 20%.
  A metal ETF must also pass the Diversified eligibility screen (≥ 253 bars, close ≥ $5, median dollar volume ≥ $25M,
  ≤ 5 missing sessions).
- **HARD limits:** ≤ 10% of NAV per holding; ≤ 25% per equity sector; ≤ 20% aggregate precious-metal ETFs. New orders
  never create a breach. **Post-drift (every EOD, sold at the next open):** holding > 10% → trimmed to 9%; sector > 25%
  → largest holdings in it trimmed until ≤ 24%; metals > 20% → each metal ETF trimmed pro rata to 19%. An excess smaller
  than the $100 minimum order is recorded (CAP_DRIFT_BELOW_MIN_ORDER) and enforced once it is tradable. Prices can move
  between the decision close and the next open; the limits are enforced at decision closes, which is disclosed.
- **Exits (equities):** rank > 60; close below the 200-day average; trailing stop −15%. **Exits (metal ETFs):** below
  its 200-day average, no longer verified, or the same −15% trailing stop. **Re-entry:** stops and trend exits cool
  down **15 sessions**.

## 5. Shared execution, data and edge cases
- **Fills:** next regular-session **open** after the decision close (daily-bar open, unadjusted); no bar = order
  EXPIRES. 10 bps slippage per side, $0 commission, whole shares, $100 minimum order, idle cash 0%.
- **Source:** the control's daily-bar source (Yahoo Finance chart endpoint; see the rights note in §7). **One** history
  fetch per session serves all three Arena accounts (legacy lane 1× + Arena 1×; never one read per account).
- **Missing / stale data:** no bar for a holding on D = HOLD with `NO_BAR_TODAY`, marked at its last observed close and
  flagged stale; the EOD mark then stores **NOT AVAILABLE** (`nav_cents` NULL, coverage < 1) — never an invented mark.
  A holding whose series disappears entirely is held at the close in its last persisted mark (SERIES_UNAVAILABLE) and
  liquidated by the delist rule after 3 missing sessions; with no persisted close that account (only) skips the day
  before any claim. Universe coverage < 90% skips that account's run. A missing regime series is never treated as
  risk-off: no new buys that day and the risk-off streak is frozen.
- **Split on a fill date:** a full exit sells the whole post-split position; a partial trim is scaled by the split ratio
  (ORDER_SPLIT_ADJUSTED event).
- **Failed runs:** a run that fails after its claim leaves the claim; the day is re-run manually with a new claim key
  (`<ACCOUNT>:EOD:<date>#2`, admin route) and the gap is visible in the ledger. The ledger is written before the snapshot
  and mark rows.
- **Holidays / early closes:** no SPY bar dated D = no session. The final-close gate uses the NYSE calendar
  (`market-tape/core.js`): 16:00 ET, or 13:00 ET on early-close days.
- **Corporate actions:** splits (cash in lieu), dividends credited on the ex-date, a series that ends is liquidated at
  its last observed close (flagged ESTIMATE) after 3 missing sessions — the V1 backtest rule (see §1, difference 2).
- **Schedule:** the existing one-minute cron (no new trigger). OPEN ≥ 09:45 ET; EOD from 16:31 ET on odd minutes (the
  control's lane, `signal10Tick` in signal10-api.js, attempts its EOD on even minutes from 16:20 ET). Kill switch `SIGNAL10_ARENA`; cohort start `SIGNAL10_ARENA_T0`.

## 6. Fair head-to-head
- **T0** = the first EOD on or after `SIGNAL10_ARENA_T0` whose gates pass **for all three accounts**; all three fund
  $10,000 that day from zero positions (if any one fails a gate, none funds) and their first fills are at the next open.
  No Arena record is written for any date before T0.
- No indexing or normalization is needed: every account starts from the same $10,000 and the same snapshot.
- **Comparisons since T0:** total return, max drawdown, volatility, turnover and trading cost, max position, sector and
  metal exposure, cash; SPY/QQQ buy-and-hold comparators funded at the same T0. Sharpe only after **≥ 60** daily
  observations. No early winner is declared. Any retrospective research is labelled POST-HOC / IN-SAMPLE and never
  mixed with prospective results.

## 7. Known limitations (disclosed, not fixed by tuning)
- **Price-source rights:** the daily-bar source is the one the control uses. Yahoo's terms restrict commercial use,
  automated collection and redistribution; the owner licensing decision recorded in docs/signal10/README.md §1 is still
  owed and applies to all three accounts equally. The Arena pages and the metals tracker show weights, returns and NAV,
  never a source price; the member ledger API (like the control's) returns full ledger payloads, which include fill and
  mark prices, so that anyone can recompute the chain — an owner rights decision covers both lanes.
- **Taxonomy:** SIC is coarser and older than GICS; some technology-adjacent names fall outside (Amazon, data-center
  REITs) and some technology-coded names are unusual (e.g. First Solar SIC 3674). Rule-based, verifiable, disclosed.
- **Survivorship:** forward-only records have no survivorship bias; the universe is the live index.

## 8. Change log (pre-T0; policy parameters never changed; policy hashes changed once, with the arena version, below)
- 2026-10-10: preregistration frozen. EOD final-close gate uses the NYSE early-close calendar (found while writing §5).
- 2026-10-10, independent adversarial review (before any forward record):
  - ledger payloads are normalised through JSON before hashing (undefined values broke verification after storage);
    STATE is nested under `payload.state` (seq/origin survived no restore); FILL.orderSeq links to ORDER.local_seq;
  - full exits on a split date sell the whole post-split position; partial trims scale by the split ratio;
  - post-drift caps are measured after the day's exits (exiting positions no longer trigger trims);
  - a missing held series blocks only its own account, with the delist fallback above; the cohort funds together;
  - a missing regime series is not risk-off; rotation respects the $100 minimum and never sells a trimmed name twice;
  - the fill check reads the ledger's FILL rows; the kill switch is enforced inside the lane; OPEN needs a T0;
  - FUNDING records the classification snapshot hash and the metal-ETF registry hash.
- 2026-10-10, re-verification of the fixes: a pending order whose symbol loses its series now simply expires (only held
  positions can block a run); member metals and Arena payloads carry no source prices; admin reruns require an integer
  ≥ 2 and an original claim older than 20 minutes; a zero-share split-adjusted trim expires; DERISK never fires on a day
  the regime series is unavailable; benchmark events carry no account-local sequence number.

- 2026-10-10, owner correction (still before any record): three brand-new accounts instead of two challengers versus the
  legacy account. Added ORIGINAL (`S10-ARENA-ORIG-1`, V1 rules imported, not copied); arena version 1.0.0 → 1.1.0, so the
  TECH and DIVERSIFIED policy hashes changed (their parameters did not); sql/018 admits the ORIG account; the API,
  scoreboard and pages compare three symmetric accounts; the legacy account is shown only as separate history.
- 2026-10-10, independent review of the three-account design (GO, conditional on disclosure): §1 now lists every
  ORIGINAL vs legacy-lane difference (delist liquidation and NOT AVAILABLE marks were missing); stale control/challenger
  wording fixed; member payloads no longer carry order quantities (a share count with a weight could reveal a price).

- 2026-10-10, real-data pre-flight (in memory, nothing written): all three accounts funded together on the 2026-10-09
  session; ORIGINAL reproduced the legacy V1 lane's real funding-day decisions (top 5 PSX VLO MPC EXPD MRNA; BUY MU,
  VTRS). The registry gate held PPLT on an unregistered 2026-05-18 10-for-1 split; the split was verified in SEC 8-K
  0001999371-26-011013 and registered (metal-ETF registry hash changes; no policy parameter or hash changes).

## 9. Activation record
Filled at activation: T0, worker version, ledger FUNDING hashes, engine source hashes at T0.
