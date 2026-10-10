# PBE Market Tape: `market-tape/1` (issue #56)

PBE Market Tape is the one first-party stock-tape backend for PropBetEdge. It serves Signal 10 now, and Members and Terminal next.

- **Owned by us:** the identities, the market session, the lists, the Robinhood handoffs, the PBE research overlay, the rights gate and the cache.
- **Not owned by us:** quote prices. Prices are an optional, pluggable provider. They are shown **only** when that provider's written rights cover the audience. Today no provider qualifies, so every price field is null for everyone.

## Endpoints (Worker `pbe-predictions`)

| Route | Who | Notes |
|---|---|---|
| `GET /v1/market-tape` (same-origin `/api/market-tape` on predictions.propbetedge.ai) | everyone | Soft entitlement check: All Access gets the `paid` payload; anonymous, free, lapsed or unverifiable gets the `public` payload. Always `private, no-store, max-age=0` with `Vary: Cookie` and `x-pbe-contract: market-tape/1`. GET only. |
| `GET /admin/market-tape` | `ADMIN_TOKEN` or read-only `DIAGNOSTICS_TOKEN` | The paid payload, for production verification without a member session |
| `GET /v1/signal10/tape` | everyone | **Legacy** view, mapped from the same `marketTape()` call. It has no quote logic of its own. It is kept for pages released before the UI switched over. |

Callers can't supply symbols, so a request can't amplify upstream calls. Server-side consumers such as the Members backend call `/v1/market-tape` over a service binding or the same-origin proxy, forwarding the member's cookie. **Browsers never call a quote source.**

## Payload

Top-level fields:

```
contract        "market-tape/1"
generated_at    when the payload was generated
generated_by    Worker version
audience        "public" | "paid"
session         { state, label, date, early_close, session_open_at, session_close_at,
                  next_open_at, last_session, last_close_at, calendar }
rights          { state: "SOURCE_RIGHTS_HOLD" | "CLEARED", provider, scope: "NONE" | "PUBLIC" | "PAID", note }
diagnostics     { securities, priced, last_observed_at, refresh_hint_seconds }
research_snapshot   (paid only) { d, frozen_at, model, content_sha256, eligible, prev_d }
lists[]         { key, kind, label, note, securities[] }
```

The three lists:

| `key` | `kind` | Audience | Content |
|---|---|---|---|
| `FEATURED` | `EDITORIAL` | all | SPCX first, then 10 more |
| `SIGNAL10_TOP10` | `MODEL_RESEARCH` | paid | the latest frozen EOD Top 10 |
| `SIGNAL10_PAPER` | `SIMULATED_PAPER` | paid | positions in the simulated $10,000 account |

Each entry in `securities[]` has these fields:

| Group | Fields |
|---|---|
| Identity | `symbol`, `name`, `security_id`, `legal_name`, `exchange`, `mic`, `type`, `share_class`, `cusip`, `listed_on`, `pinned`, `robinhood_url` |
| Session | `market_session`, `session_open_at`, `session_close_at`, `next_open_at`, `last_close_at` |
| Quote | `source`, `observed_at`, `retrieved_at`, `quote_delay_known`, `state`, `last_price`, `previous_regular_close`, `change_abs`, `change_pct`, `attribution`, `rights_scope` |
| Research (paid only) | `research: { label: "PBE SIGNAL 10 RESEARCH", snapshot_d, in_universe, rank, prev_rank, move, score, paper_held, paper_label }` |

**`state`** is one of:
- `SOURCE_RIGHTS_HOLD`: no rights. **Every price field is null.**
- `LIVE_QUOTES`: in session, with a source time no more than 2 minutes old.
- `DELAYED`: in session, with a source time no more than 20 minutes old.
- `LAST_CLOSE`: closed, and the quote is from the last session.
- `STALE`: the row carries no price.
- `SOURCE_UNAVAILABLE`: the source returned nothing usable.

`market_session` is reported separately: OPEN, PRE_MARKET, AFTER_CLOSE, CLOSED_WEEKEND, CLOSED_HOLIDAY or CALENDAR_UNKNOWN. "MARKET OPEN" is never presented as "LIVE QUOTES".

`observed_at` is the provider's own trade time. `retrieved_at` is our fetch time. They are never conflated. A 90 s refresh hint does not make a quote real-time.

**Identity.** `security_id` is `SYMBOL:MIC`, plus the listing date when a ticker was previously used by another issuer: `SPCX:XNAS:2026-06-12` (Space Exploration Technologies Corp., Class A, CUSIP 84615Q103, Nasdaq listing 2026-06-12). Nothing joins SPCX to an earlier, unrelated SPCX.

**Research.** These values are genuine model evidence only, read from the immutable `pred_s10_snapshots` and the paper STATE event. Nothing is written.
- A symbol outside the model's S&P 500 universe has `in_universe:false` and never a rank. SPCX is outside it.
- Featured placement is not a pick.
- `paper_held` is a SIMULATED paper position, never a brokerage holding.

## Rights gate (in code, not config)

`src/market-tape/contract.js` gives each provider a `rights: { public, paid }` record. Prices are displayed only when **both** of these hold:
1. `MARKET_TAPE_QUOTES === "on"` (the operator switch);
2. the provider named by `MARKET_TAPE_PROVIDER` has `rights[audience] === true`.

An environment flag cannot widen rights. `yahoo-chart` is `{ public: false, paid: false }` (see `docs/signal10/TAPE.md`), so members fail closed as well.

**Deployed:** `MARKET_TAPE_QUOTES="off"` and `MARKET_TAPE_PROVIDER="yahoo-chart"`. That means zero quote-vendor calls.

**To activate a provider later, all of these are required:**
1. Written terms covering the audience, recorded in TAPE.md.
2. A code change to its rights record, reviewed.
3. **A scheduled collector** that writes one canonical snapshot per interval to existing storage, so throttling is global. The per-isolate memo and budget in `market-tape-api.js` are local guards only, not a global throttle.
4. No storage or derivation beyond what the licence allows.

## Load and performance
- **Payload size:** the public payload is under 12 kB (tested).
- **No rights (today):** 0 upstream calls for 1, 100 or 1,000 concurrent viewers (tested).
- **With a cleared test provider:**
  - one upstream call per symbol per TTL per isolate;
  - a cold stampede of 1,000 viewers is capped at `TAPE_BUDGET.perMinute` (40) per isolate;
  - only 2xx subrequests are edge-cached (tested).
- **Browser cadence** (`tapePollMs`):
  - 90 s while the session is open;
  - one read at close + 5 min;
  - otherwise one wake-up at the next open + 60 s;
  - paused while the tab is hidden.

## Consumers
- **Signal 10** (`markets/signal-10/tape.js`) reads `/api/market-tape`. Members see "S10 #rank" badges on featured symbols the model ranks, ▲/▼/NEW moves in the Top 10 group, and PAPER flags.
- **Members / Terminal:** next, behind their own review and deploy. They get one backend through a server-side read. No ticker logic is copied.
