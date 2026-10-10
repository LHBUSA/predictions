# maxtemp pre-window v1.2: retrospective screen result and forward SHADOW (issue #64, Stage 2)

**Status: SHADOW. Retrospective screen PASSED. Forward record starts with climate date 2026-10-11.**

v1.1 stays the published pre-window model. Nothing here is wired into the Worker. Temperature stays
`validated: false`, so it cannot issue a CALL. The rain policy is untouched.

- **Pre-registration:** `TEMP_PREWINDOW_V12_PREREG.md`, commit `eaa9f41`, pushed 2026-10-10 19:11Z, before any
  candidate was fitted.
- **Evaluation:** `scripts/research/temp-audit/v12-challenger.mjs` (shared case builder `cases.mjs`).
- **Frozen artifact:** `src/weather/artifacts/temp-prewindow-v1.2.json`. Canonical-JSON sha256 `b1269e94…`, pinned in
  `test/temp-prewindow-v12.test.js`.
- **Model:** `src/weather/temp-prewindow-v12.js`.

## What was tested

The data and point-in-time rules are those of the v1.1 build:

- 31 CLI stations, 2023-01 → 2026-09;
- leads of 6, 18, 30 and 42 h before the LST window;
- runs usable at +5 h;
- NBM no more than 24 h old;
- 169,504 cases in total.

**No market data and no observation-window data were used.**

### Validation (2025-01..06, 22,440 cases; selection only)

| Candidate | Exact-degree log loss | 2 °F Brier |
|---|---:|---:|
| A: v1.1 reproduction | 2.4713 | 0.13650 |
| B: recent bias λ=0.5, H=14 d (best of 6) | 2.4677 | 0.13623 |
| C: NBM-spread (`xnd`) conditioned | 2.5519 (worse) | 0.13680 |
| **D: GFS–NBM regression, station β shrunk (k=200)** | **2.4527** | **0.13569** |
| E: B+C+D | not run: C failed, as the pre-registration requires | |

Selected: **D**.

### Retrospective test (2025-07..2026-09, 56,668 cases; read once, not pristine)

**v1.1 − D, with date-clustered 95% CIs:**

| Metric | v1.1 | D | Difference | 95% CI |
|---|---:|---:|---:|---|
| Exact-degree log loss | 2.386 | 2.355 | +0.031 | [0.027, 0.035] |
| 2 °F Brier | 0.1383 | 0.1368 | +0.0015 | [0.0013, 0.0017] |

All pre-registered screen checks passed:

| Check | Result |
|---|---|
| Both CIs > 0 | pass |
| Better on both metrics in 2025-H2 and in 2026 | pass |
| No station worse | pass: all 31 better, improvement 0.004 (Pittsburgh) to 0.083 (Los Angeles) |
| No month worse | pass: all 12 better |
| Modal calibration | pass: hits 18,805 vs Σp 18,186 (+3.4%; v1.1 −0.8%) |

Also reported, though not selected: B (recent bias) improved log loss by 0.007 [0.004, 0.010]. C was worse by 0.11.

**PIT deciles** (pre-registered secondary metric):

- **Basis:** mid-bucket PIT on the 7-bucket ladder, test period. It is coarse, because probability mass lumps at
  bucket midpoints.
- **v1.1:** 0.10 / 0.13 / 0.00 / 0.29 / 0.02 / 0.00 / 0.21 / 0.09 / 0.09 / 0.08.
- **D:** 0.09 / 0.10 / 0.07 / 0.18 / 0.09 / 0.08 / 0.14 / 0.10 / 0.08 / 0.08. This is closer to uniform. Both are
  reported in `pit_deciles_test` of the screen output.

**Process notes (independent review):**

- **Code freeze.** The scoring code (`v12-challenger.mjs`, `cases.mjs`) was first committed with the freeze, after
  the pre-registration commit.
  - Timeline: pre-registration pushed 19:11Z; one screen run at 19:15Z; freeze at 19:23Z.
  - A later re-run is byte-identical. It added only the PIT report.
  - The repo cannot prove the code was not edited between 19:11Z and 19:23Z. The timestamps are the evidence.
- **Erratum, candidate B wording.** The pre-registration writes "NBM − λ·b". The code implements NBM + λ·mean(CLI −
  NBM). These are the same rule if b = NBM − CLI.
- **gt54h tables.** The pooled table for leads over 54 h has n = 7 in both artifacts. Pre-window FINAL forecasts never
  use it, but probabilities in that bucket are degenerate.
- **GFS run age.** Unlike NBM, there is no age cap on the GFS run. This is the v1.1 case rule, kept unchanged.

### Frozen v1.2

**What changed from v1.1:**

- **Center:** NBM + β_station·(GFS MOS − NBM). β is fitted on the whole archive after selection.
- **β values:**
  - pooled 0.235;
  - per station 0.12 (Pittsburgh) to 0.39 (Los Angeles);
  - Chicago Midway 0.14, New York 0.34, Miami 0.26.
- **Residual tables:** rebuilt on that center, with residuals kept at 0.001 °F.

**What is unchanged:** lead buckets, the station-table rule (n ≥ 60), +0.5 smoothing and the [0.01, 0.99] bounds.

**No GFS run:** NO_GFS, meaning no v1.2 forecast. v1.1 is never substituted inside v1.2's record.

## Post-hoc check on the 42 settled Kalshi events (diagnostic only, not forward evidence)

**Method:** apply the frozen v1.2 to the exact NBM, GFS and lead bucket stored on each published v1.1 FINAL
forecast.

**Why this is not forward evidence:** those days were not used to fit or select anything. They were seen, however,
before the pre-registration.

| | v1.1 (published) | v1.2 (frozen) | v1.1 − v1.2, 6-date CI |
|---|---:|---:|---|
| Top-bucket hits | 14 (exp. 16.0) | 17 (exp. 16.0) | |
| Multiclass log loss | 1.672 | 1.540 | +0.13 [0.03, 0.24]* |
| Multiclass Brier | 0.789 | 0.752 | +0.036 [0.000, 0.077] |
| RPS | 0.152 | 0.131 | +0.021 [0.005, 0.040] |

\* 6-cluster percentile ranges, not formal 95% intervals.

**What did NOT improve:**

- **The market gap.** The same-time Kalshi log loss is 0.949, so v1.2 recovers about 18% of the gap at most.
- **Chicago's 6-day cool bias.** β is only 0.14, because history does not support a large GFS weight there.
- **LA's regime busts.** Its errors of ±4–9 °F remain beyond any guidance blend.
- **The pre-window lane's lack of information.** Newer, higher-resolution guidance would be needed. The NWS gridpoint
  forecast is not archived point-in-time, and no paid data may be used.

## Forward SHADOW (pre-registered gate)

- **Forward days:** climate dates ≥ 2026-10-11, scored with `--after 2026-10-10`. Their windows open after the freeze
  commit, and both artifacts are frozen.
- **No production path:** the forward record is computed by point-in-time replay from public archives. There is
  nothing to deploy and no cron.
- **One run reads the gate.** Pass both `--archive` and `--export` in a single run. With only one half, the scorer
  reports `forward_gate: INCOMPLETE`, never a fail.
  - **All 31 stations:** refresh the archive into a new directory (`node scripts/research/wx-fetch.mjs <dir> GFS,NBS`;
    it keeps existing files, so use a fresh directory) and run
    `node scripts/research/temp-audit/v12-forward.mjs --archive <dir> --after 2026-10-10`.
  - **Kalshi-7 ladders:** take a fresh `export.ps1` and run
    `node scripts/research/temp-audit/v12-forward.mjs --export <dir> --after 2026-10-10`. v1.2 is applied to v1.1's own
    stored FINAL inputs, so the comparison is exact.
  - **Gate read:** `node scripts/research/temp-audit/v12-forward.mjs --archive <dir> --export <dir> --after 2026-10-10`.
- **Gate:**
  - needs ≥ 30 resolved dates and ≥ 25 stations;
  - the date-clustered 95% CI of (v1.1 − v1.2) must be > 0 for exact-degree log loss and for 2 °F Brier;
  - on the Kalshi-7 ladders, v1.2 must be no worse by point estimate;
  - market scores are reported but never gate.
- **Control (reported, never a gate).** The forward v1.1 artifact was trained on data to 2025-06; v1.2 on data to
  2026-09. To separate the two effects, `--archive` also scores **the v1.1 recipe refit on v1.2's window**
  (`control_v11_recipe_refit_to_2026_09`). A v1.2 gain that the control also shows is "more data", not
  "re-centring". The gate stays as pre-registered, because it compares the product actually published.
- **Earliest gate read:** 2026-11-10, or later if archive days are missing. The first ready read is the decision of
  record.
- **Promotion beyond SHADOW needs** a passed gate plus an owner decision. Even then v1.2 would replace v1.1 as the
  *published* probability. It would not make temperature a CALL family: that is a separate decision-policy version.

The script's MOS archive years are 2023–2026 (`wx-fetch.mjs` `MOS_YEARS`). Add 2027 before any read after
2026-12-31.
