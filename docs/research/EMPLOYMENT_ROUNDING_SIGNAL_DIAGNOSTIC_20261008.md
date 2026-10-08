# Employment rounding-gap exploratory diagnostic — 2026-10-08

**Status: Descriptive, post-gate only. Not a model fit, backtest PASS, predictive advantage, or trading edge.**

From 224 as-published BLS releases encoded in the V2 levels ledger, analyze the prior-month unrounded U-3 gap vs NEXT MONTH'S published rate change. Missing October 2025 breaks adjacency; no imputation. The figures below were independently computed from a compact six-decimal extract of the repository's BLS levels ledger. The committed script `rounding-signal-run.mjs` is the canonical reproducible runner: it refuses nonmatching ledger SHA and checks actual original availability at the target cutoff. This extract-based preview has NOT been validated by executing that full runner against the exact frozen files inside the local Windows archive.

The feature band uses prior gap in percentage points: **low < -0.025**, **middle -0.025 to +0.025**, **high > +0.025**. Outcome UP means the next month's one-decimal first-print U-3 exceeds the preceding month's first print.

| Period | Adjacent pairs | Low-bucket UP | High-bucket UP | High minus low | 95% block-12 bootstrap interval |
|---|---:|---:|---:|---:|---|
| All | 222 | 17/53 (32.1%) | 18/43 (41.9%) | +9.8 pp | [-9.0 pp, +31.4 pp] |
| Excluding 2020-03 to 2021-12 | 200 | 17/50 (34.0%) | 17/40 (42.5%) | +8.5 pp | [-11.1 pp, +31.0 pp] |
| 2022+ | 55 | 5/17 (29.4%) | 6/12 (50.0%) | +20.6 pp | [-9.9 pp, +58.3 pp] |

The unrounded gap's correlation with next-month change is approximately -0.025 all-period, +0.011 excluding pandemic, and +0.154 since 2022. Since 2022 sample size is only 55, this is not evidence of stable or independent signal. The bucket shares are after a feature idea was derived from V1 evidence, so are subject to selection bias. Wide intervals include zero for every cut. A 0.1-point rate prediction remains highly affected by labor-market state and external drivers.

**Decision:** retain the original frozen V2 candidate specifications as research options; do not claim this feature moves the needle or promote any model. Prioritize independent labor-market measures and a robust same-event historical market benchmark, then prospective evaluation.

**Reproduce in the connected Windows checkout:**

`node --test scripts/research/employment/market-horizon-core.test.mjs scripts/research/employment/rounding-signal.test.mjs`

`node scripts/research/employment/rounding-signal-run.mjs docs/research/employment-rounding-signal-evidence.json`

The latter is deliberately separate from the V1 gate and writes a new descriptive research artifact only when explicitly invoked.

**Known blocker:** The full Kalshi raw hourly candle archive is not mounted in this environment. A T-3 versus T-1 paired historical score remains UNVERIFIED. Do not fabricate it from T-1 candles or infer performance from the partial snapshot.

**Safeguards:** no V1 retune, no CPI SHADOW changes, no production deployment, no Kalshi price feature in the independent model.
