# Employment edge feasibility — read-only execution plan (2026-10-08)

**Scope:** Research only. V1 fails remain frozen. No models fit, no deployment, no CPI changes.

## Confirmed implementation constraints
- The archived Kalshi collection job `scripts/research/employment/fetch-kalshi-employment.mjs` records hourly candles only from **72 hours before T-1D 20:00 ET** through T-1D. T-3D is *inside the requested interval* but requires a per-contract candle/quote coverage check; T-7D and T-14D are **not in the existing requested window**.
- Existing scorer picks the newest candle at/before cutoff without a maximum age; previous descriptive audit found 106/316 U-3 and 39/279 payroll quotes >2h stale at T-1D. T-3 must not reuse T-1 prices or features.
- Independent scoring uses first-print BLS truth, strict > strikes, and original as-of DOL/BLS inputs; missing feature => NO_FORECAST, missing quote => NO_PRICE, missing archive => NOT_COLLECTED. Never conflate these.
- Local proof: market-horizon-core.mjs helper passed six Node tests for timestamp exclusion, stale and crossed quotes, missing archive, capped log loss and same-contract pairing.
- The branch contains the helper and tests. A larger standalone read-only runner is available as a conversation artifact, requiring access to the original raw Kalshi archive on the Windows machine.

## BLS flows audit
- Official BLS CPS flows track month-to-month movements between employed (E), unemployed (U), and not in labor force (N). These are CPS household concepts; continuing and initial DOL insurance claims are not the same measurement.
- URLs to validate for series definitions, seasonal adjustments and revision policies:
  https://www.bls.gov/cps/cps_flows.htm
  https://www.bls.gov/webapps/legacy/cpsflowstab.htm
  https://www.bls.gov/cps/faq.htm
- **Current-month flows arrive with the Employment Situation, too late to predict that month's U-3 at T-1D.** Only lagged flows from a *demonstrably earlier release* are eligible.
- Archived historical series can contain annual seasonal revisions and must not be silently treated as first-published vintages.
- Feasibility inventory: for each reference month, record first public release URL/date/time, as-published monthly E→U, U→E, N→U and U→N levels, denominator availability, first-seen timestamp, document hash, revision exposure, and the forecast cutoff. Mark unrecoverable vintages NO_FORECAST rather than substituting revised modern data.
- Start with the cheap V2 ledger extensions (BLS first-print unemployed/labor-force levels and DOL first-print insured unemployment rate), and 10 independently checked manual proof cases. Do not fit a model or alter frozen V1 ledgers.

## Market horizon audit
1. Load and verify archived manifest and source-document hashes.
2. Build **separate** feature rows for each horizon T-1, T-3, T-7, T-14 at 20:00 ET using cutoff-specific immutable inputs.
3. Read valid Kalshi contracts, check exact rule/strike agreement, demand both bid and ask, reject crossed spreads and stale quotes >2h.
4. Report total event counts, contracts, NO_ARCHIVE_WINDOW, NO_CANDLE, NO_PRICE, STALE, INPUT_UNAVAILABLE, terms-refused and final paired samples for every horizon. A longer requested span does not prove candles actually existed.
5. Compare **same event and same contract** priced at both cutoffs. Compute per-event log loss, Brier, uncertainty, spread, quote age; report both event-weighted and contract-weighted descriptive tables.
6. T-7/T-14 require an additional separately hashed historical query/collection pass; never reuse T-1 snapshots.
7. **No market-free V1 model comparison at T-3/T-7/T-14 using original T-1 fitted predictions.** Each horizon needs point-in-time recalculation and a new preregistered prospective test before any claims of improvement.

## Research go/no-go
Go: provenance and horizon archive feasibility, descriptive market-only horizon differences, original-release ledger extension, frozen independent future protocol design.
Hold: model fitting, production writes, public edge claims, execution/trading, CPI SHADOW changes, V1 result restatement.
