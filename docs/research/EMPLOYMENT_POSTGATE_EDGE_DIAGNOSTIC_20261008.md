# Employment V1 — post-gate edge diagnostic (2026-10-08)

**Scope:** Research diagnosis only. V1 U-3 FAIL and payroll FAIL are final and unchanged. V2 proposal is NOT a registered passing model. No fit, shadow, public forecasts, or deployment is authorized by this note.

## 1. Why the market comparison matters

The frozen V1 employment model predicts the first-print BLS outcomes at T-1D 20:00 ET. Its U-3 features are `CC_LOGCHG_REF`, `IC4_LOGCHG_REF`, and `DU_L1`. Payroll features are `PAY_L1`, `PAY_AVG3`, `IC4_LOGCHG_REF`, and `CC_LOGCHG_REF`. It does not incorporate labor-force transition flows, the unemployment-rate rounding position, payroll tax deposits, or any Kalshi feature.

The *paired* historical Kalshi comparison (source `employment-v1-kalshi-comparison.json`) shows:

| Series | Events | Priced contracts | Market mean event LL | V1 mean event LL | V1 - market |
| --- | ---: | ---: | ---: | ---: | ---: |
| U-3 | 39 | 316 | 0.265 | 0.365 | +0.100 |
| Payrolls | 31 | 279 | 0.414 | 0.688 | +0.274 |

Lower log loss is better. The original report's label "candidate minus market" has the sign reversed: its negative values are **market minus candidate**. Restore this labeling in a new post-gate addendum; never rewrite or overwrite the frozen V1 evaluation.

**Different sample caution:** U-3's 179 full-history scored origins versus 39 market-priced events are NOT comparable as absolute log-loss levels. Similarly, 316 and 279 contracts are correlated within 39 and 31 independent release events. Statistical uncertainty and block bootstraps should use the release/event level.

## 2. Market quote freshness sensitivity — exploratory, not a new gate

The comparison selects the most recent hourly candle with both bid and ask available at or before T-1D. It does **not** cap quote age. From the committed event/contract details:

- U-3: 106 / 316 priced contracts had quotes older than 2 hours. Maximum observed age: 71 hours.
- Payrolls: 39 / 279 older than 2 hours. Maximum observed age: 46 hours.

Recomputing event-mean paired log losses with quote age <= 2 hours, preserving the committed contract predictions/outcomes and using the same probability floor:

| Series | Events with >=1 fresh-priced contract | Fresh contracts | Market LL | V1 LL |
| --- | ---: | ---: | ---: | ---: |
| U-3 | 38 | 210 | 0.394 | 0.505 |
| Payrolls | 31 | 240 | 0.470 | 0.756 |

Freshness filtering changes the sample; these scores do not replace the official comparison. **Market advantage persists.** The long-ago quotes are an audit concern but not an explanation for the V1 gap. Before describing tradable edge, price comparisons must separately evaluate executable bid/ask, fees, spreads, liquidity and timestamp strictness; a candle mid is not a guaranteed fill.

## 3. What a recent-era cut actually shows

Among the **7** market-matched payroll events in 2026 (January-July), model mean log loss was 0.637 versus market 0.733 (V1 minus market = -0.096). But the result is highly concentrated: January (-1.028) and February (-0.862) model-minus-market dominate. Omitting those two events, the remaining five events show an approximate **+0.244** model-minus-market disadvantage. This is exploratory selection, not evidence for changing a gate or claiming 2026 alpha.

## 4. Real signal bottleneck: claims are not the CPS unemployment flow

BLS Employment Situation publishes **two different survey constructs**: household CPS unemployment (U-3) versus establishment CES nonfarm payrolls. BLS documents that insured unemployment claims capture only benefit claimants and omit job-finding and workers entering or leaving the labor force; claims cannot directly measure unemployment. Relevant official sources:

- BLS: https://www.bls.gov/cps/faq.htm
- BLS labor-force flows: https://www.bls.gov/cps/cps_flows.htm
- BLS published flow series: https://www.bls.gov/webapps/legacy/cpsflowstab.htm
- BLS Employment Situation sample/methodology: https://www.bls.gov/news.release/archives/empsit_06052026.htm

**Potential independent U-3 feature family, not validated:** LAGGED, as-published monthly CPS flow transitions `E->U`, `U->E`, `N->U`, and `U->N`, with levels scaled to the corresponding prior labor-force denominator. They describe unemployment inflow, job finding, reentry and departure. Use only releases actually available BEFORE each forecast cutoff; official research series may be revised. Verify vintage availability and publication timestamps before using a value. Consider a two-component model for the unemployed numerator and civilian labor-force denominator, then map to the 0.1-percentage-point U-3 grid.

The V2 proposal already identifies `U3_UNROUNDED_GAP` and `IUR_CHG_REF`; these remain the low-cost first extensions, subject to original-release and revision guards. Adding four highly correlated flow terms uncritically could overfit 179 months; freeze one small interpretable specification and one benchmark, not an open search.

Payrolls are CES, not CPS: its V1 expanding ridge retains extreme 2020 payroll shocks, causing the documented post-2022 problem. A pre-registered single robust candidate such as Huber/MAD can address training fragility; that alone does not establish market advantage. A payroll-specific, free, genuinely leading official indicator needs a separate source-vintage and cost review.

## 5. The more promising commercial test is a change of forecasting horizon

At T-1D, Kalshi has nearly all publicly available signals incorporated. The independent model is allowed to compete at other **predeclared** cutoff horizons without market features: e.g., T-14D, T-7D, T-3D, T-1D at 20:00 ET. Rebuild all features strictly as-of each historical cutoff; do not reuse T-1 features in T-7 research. Pair each cutoff to the market quote that existed at the same cutoff and inspect volume/spread/quote age. Historical results are exploratory because these hypotheses follow inspection of V1. Pre-register the horizon(s) and prospective test BEFORE evaluating new live outcomes. No horizon-cherry-picking after looking at scores.

A different, explicitly labeled **market-informed decision overlay** may evaluate disagreement between a separately frozen independent forecast and bid/ask prices to identify possible mispricing; it must never be represented as a market-independent forecasting model. An overlay is not validated by historical rank alone; verify executable edge and prospective results after transaction costs.

## 6. Work order

1. Audit market quote latency, stale/no-quote refusal reasons, strike coverage and executable price availability. Produce a same-event and same-contract sensitivity table for cutoffs and explicitly disclose sample changes. No refitting.
2. Extend the frozen ledger additively with first-print BLS unemployed/labor-force levels and DOL advance IUR; manual proofs, immutable hashes, no fitting.
3. Feasibility-test BLS CPS flow history: original publication timestamps, archived as-published revisions, missing months, lagged availability. **No model fit** until one simple, preregistered specification is approved.
4. Audit payroll V1 residuals by regime, largest errors, coefficient drift, and leverage of 2020 observations. Keep frozen V1 intact.
5. After a new prospective protocol and explicit owner approval, build a single isolated research challenger per target, score by independent release, and compare separately against best baseline and contemporaneous market price.
6. Do not deploy, alter CPI SHADOW, change production cron lanes, publish edge numbers, or call any failed research candidate a premium pick.

**Decision:** HOLD deployment; GO on narrow, source-backed diagnostic and dataset-enrichment research. A failed gate closes V1, not all future hypotheses.
