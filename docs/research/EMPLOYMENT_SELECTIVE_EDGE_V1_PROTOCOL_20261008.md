# Selective Edge V1 — research protocol, 2026-10-08

**Owner direction:** We do not have to win every round. Identify opportunities before outcomes are known, abstain when evidence is insufficient, and evaluate selected events prospectively.

**Status: design + isolated research code only. NOT a deployed, validated, or tradable model.** V1 U-3 and payroll failures are final. V2 HOLD and its frozen gates remain untouched. Nothing may be labeled a customer PICK without separate owner approval and a validated model.

## Selection and abstention

At the recorded forecast cutoff and before the event resolves, require valid Kalshi contract terms, unaltered independent model forecast, pre-cutoff capture timestamp, no future or >2h-stale bid/ask, noncrossed quotes, verified liquidity, spread <= 10 cents, 5-percentage-point haircut to model probability, a two-cent conservative fee reserve, >=10-point gross probability advantage and >=4-point net advantage. Evaluate YES using the ask, NO using 1 minus the YES bid, with strict contract outcome rules. At most one selected contract per event; score every pass and refusal. Thresholds are **research hypotheses, not optimized or backed by transaction evidence**; the two-cent reserve is not verified Kalshi fee calculation. Future commercial checks must substitute actual official fee schedules, order-book depth, slippage and size-dependent fills. Missing values => PASS.

No posterior outcome can enter the selection function. The initial implementation returns RESEARCH_CANDIDATE only when the independent model has the status VALIDATED. Employment V1 is NOT VALIDATED, so the current research runner must abstain on V1 automatically. The V2 HOLD cannot be treated as VALIDATED.

## Evaluation

Capture a timestamped immutable eligibility decision and every reason for abstention before each release; hash input snapshots. After settlement, score release-level hit rate, selection/abstention frequency, mean net payout using executable quotes and documented fees, Brier/log loss on ALL eligible contracts, conditional calibration and the selection uplift relative to comparable market implied probabilities. No cherry-picking event thresholds, horizons, or selected months after observing outcomes. Use prospective releases and appropriate clustered uncertainty at the release level; report negative outcomes and small samples.

Historical diagnostic analyses (including recent V1 or any future selective cut on the known 2022-26 outcomes) are **design-influencing** and cannot independently clear a PASS. Any later change creates a new prospective protocol version.

## Operational separation

Pure code may live in isolated `scripts/research/employment/selective-edge.mjs` and its tests. This work does not deploy workers, schedule jobs, write Supabase production tables, make live trading decisions, modify CPI SHADOW, or change existing Employment market-monitoring labels. No model training in this phase.

## Promotion safeguards

The existing V2 statistical and commercial gates must both pass independently. In addition, any selective edge must be supported by precommitted, live-paper prospective evidence net of realistic execution costs. Until then emit research-only status.