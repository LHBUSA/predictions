# Employment V2: prospective research collection (PROPOSAL, 2026-10-08)

**Status update 2026-10-08:** the owner approved Tier A only, now built (`EMPLOYMENT_TIER_A_COLLECTOR.md`). Tier B stays HOLD.

Owner direction 2026-10-08, item 5. This is a proposal only. No collector exists, no task is scheduled, and nothing
here is authorized until the owner says GO. V2 stays HOLD under `EMPLOYMENT_V2_PROTOCOL.md` (Amendment B2).

## Why start early

Both V2 gates count only releases captured before publication. A snapshot of the cutoff order book cannot be rebuilt
afterwards, and Kalshi candles keep only hourly bid/ask with no depth. BLS and DOL documents are archived publicly and
can be re-fetched later; market state cannot. Every release without a live capture is lost for good. With about two
years (24 releases) required, starting at the 2026-11-06 release instead of a later one saves that many months.

## Two tiers, approved separately

| | Tier A: data and prices only | Tier B: forecast capture |
|---|---|---|
| What runs | Fetch, hash and commit raw documents and market snapshots | Tier A, plus the frozen V2 candidates and baselines computed at the cutoff |
| Model fitting | None | Refit of the frozen specifications at each origin (protocol section 5), no tuning |
| Starts the 24-release gate clock | **No** | Yes (records the Amendment B1 date) |
| Needs | Owner GO on this proposal | Separate owner GO on V2 capture |

Tier A alone keeps the evidence (prices, depth, fees, terms, documents) but cannot pass a gate. Forecasts produced
later from archived inputs would be in-sample with respect to their timing and would not count. If the owner wants the
first gate release to be 2026-11-06, Tier B needs a GO before 2026-11-05 20:00 EST. Otherwise Tier A preserves the
data until Tier B is approved.

## What Tier A collects

| Item | When (America/New_York, named zone so DST is handled) | Source | Kept |
|---|---|---|---|
| Kalshi snapshot, every listed KXU3 and KXPAYROLLS contract for the next release | **T-1D, 19:50-20:00** (the cutoff); also T-7D and T-3D at 20:00 as context only, with no horizon claim (protocol cutoff stays T-1D) | Public Kalshi API, no key: `/markets?event_ticker=`, `/markets/{t}/orderbook`, `/series/{s}` | Full order book, market record, series fee settings, fetch timestamp per response |
| Contract terms PDFs | With each T-1D snapshot | `contract_url` from the series record and `assets.kalshi.com/contract_terms/*.pdf` | sha256. The PDF is stored only when its hash changes. |
| Settlement | Release day + 1 and + 3 days | `/markets?event_ticker=` (result, expiration_value, settlement time) | For B2.2 exclusions and settlement validation only |
| BLS Employment Situation | Release day, 08:45 and 10:00 | bls.gov release HTML + archive index | Raw file, sha256, fetch time; parsed later by the frozen V1 / extension parsers |
| DOL weekly claims | Every Thursday 09:00 (plus holiday-shifted days) | dol.gov weekly release | Raw file, sha256, fetch time |

That is about 30-60 HTTP requests per release and about 2 per week for DOL, all to public endpoints at a polite rate.

## Where it runs (zero production footprint)

- **Host:** the owner's Windows machine via Task Scheduler, the same pattern as the PBEcast latency study. It does not
  use Cloudflare, the pbe-predictions Worker, tkmln/Supabase or GitHub Actions (Actions may only shrink). It creates no
  new billable resource.
- **Code:** one script under `scripts/research/employment/` on a dedicated branch `employment-capture`, owned by one
  session (B2.5). It imports nothing the Worker bundles and touches no CPI file.
- **Storage:**
  - Raw documents and order books go to `D:\Workers\scratch\predictions-employment\prospective\` (append-only, with a
    sha256 manifest).
  - A per-release JSON (hashes, snapshot summary, fetch times, code sha) is committed and pushed on `employment-capture`
    before 08:30 ET on release day. The GitHub push record is the external timestamp.
- **Failure rule:** a missed or partial T-1D snapshot is recorded as `MISSED` with the reason. It is never backfilled,
  except through the probability-only candle fallback in B2.3. A file written after its release is void.
- **Risk:** the machine must be on and online at 19:50-20:00 ET on 12 cutoff evenings a year. Mitigations: wake-timer
  tasks, retries every 2 minutes inside the window, and an alert to the owner if the 20:00 file is missing. A missed
  month is simply lost; it does not invalidate the others.

## Cost and effort

About one engineering day for Tier A: collector, manifest, push, and a dry run against the 2026-11-06 release window.
About half a day more for Tier B, which calls the frozen candidate code. $0 running cost. No production change, no
cron change, no deploy, and nothing near the CPI cutoffs.

## Decisions requested

1. **Tier A GO / NO-GO.** Recommendation: **GO**. It costs almost nothing, and market depth at the cutoff cannot be
   recovered later.
2. **Tier B.** Recommendation: **stay on HOLD until the owner chooses**. If 2026-11-06 should be the first gate release,
   it needs a GO before 2026-11-05 20:00 EST; otherwise the clock starts at the first release after GO.
3. **KXPAYROLLS.** Recommendation: snapshot it in Tier A (no extra cost); keep it out of Tier B unless separately
   approved (protocol section 2).
