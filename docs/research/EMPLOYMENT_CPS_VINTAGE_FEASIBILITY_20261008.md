# Labor-force flows and rounding-position feasibility — source proof (2026-10-08)

**Research only.** No employment model fit, promotion, deployment, V1 baseline retuning, or CPI SHADOW change.

## Confirmed point-in-time example: August 2026 first print

From the **archived** BLS Employment Situation of August 2026, released September 4, 2026 at 08:30 ET:

- SA civilian labor force **169,777 thousand**
- SA unemployed **7,031 thousand**
- Published U-3 **4.1%**
- Ratio `100 * 7031 / 169777 = 4.141315%`
- `U3_UNROUNDED_GAP = 4.141315 - 4.1 = +0.041315 percentage point`

This is an illustrative feature value **for a subsequent forecast** (e.g. September 2026's release on October 2), not a forecast score. It uses a release available before T-1D for that subsequent target.

Evidence: https://www.bls.gov/news.release/archives/empsit_09042026.htm (Summary table A, first-publication copy).

A second arithmetic check from the September 2026 **first print** (released October 2):
- SA civilian labor force 170,262 thousand; unemployed 7,109 thousand; published U-3 4.2%.
- Implied 100*7109/170262 = 4.175330%, rounding gap = -0.024670 percentage point.
- This September figure must NEVER enter a forecast frozen before the October 2 embargo for September U-3.

Evidence: https://www.bls.gov/news.release/archives/empsit_10022026.htm .

Do not infer forecasting effectiveness from either example. Both demonstrate that the numeric information exists in archived first-print BLS releases, distinct from the one-decimal U-3 observation.

## CPS flow vintage risks verified against BLS

- CPS flow series describe 3x3 movements E/U/N and are revised through seasonal adjustment.
  https://www.bls.gov/cps/cps_flows.htm
- BLS reported incorrect flow estimates for **April 2020 through January 2021** in a January 5, 2024 annual revision, corrected January 10. Therefore **current** historical flow database values cannot be backdated to earlier forecast cutoffs.
  https://www.bls.gov/cps/notices/2024/errata-january-2024-seasonally-adjusted-data.htm
- October and November 2025 flows cannot be constructed from consecutive CPS interviews following the October 2025 shutdown, and the December 2025 flow estimates were delayed.
  https://www.bls.gov/web/empsit/cps_flows_recent.htm
  https://www.bls.gov/cps/methods/2025-federal-government-shutdown-impact-cps.htm
- Current flow tables are continually updated URLs (`/web/empsit/cps_flows_current.htm` and `cps_flows_recent.htm`) and the BLS historical database retrieves revised series; **vintage availability remains unproven** for a full 2011–2026 backtest.

### Admission rules

1. Only lagged, original-publication flow values with attributable `published_at <= forecast_cutoff` may enter a research feature ledger.
2. Archive the document byte hash, source URL, first-seen publication timestamp, reference month, transformation formula, and whether revised values were present. If first publication cannot be proven, set `UNVERIFIED_VINTAGE` and do not train on the data.
3. Treat 2025-10 and 2025-11 flows as `SOURCE_NOT_PUBLISHED`, not 0; treat delayed December 2025 flows as unavailable until the actual publication time.
4. Keep the original V1 frozen data and gate untouched. Extend separate V2 research ledgers only after proof.
5. No model fit or new performance claim until a prospective challenger protocol is frozen.

**Decision:** BLS first-print numerator/denominator is a feasible low-cost research feature; wholesale revised CPS flows database ingestion is **NO-GO** without as-published historical records.
