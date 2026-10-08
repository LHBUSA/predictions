# Employment V1 — research evidence packet (2026-10-08)

Status: **RESEARCH. Both targets FAIL the pre-registered gate.** Nothing is deployed, SHADOW, CALL or public. There are no
Employment production tables, cron lanes, Worker paths or model rows. Protocol: `EMPLOYMENT_V1_PROTOCOL.md` (written before
any fit: aad04a2; Amendment A1 e2e3a86; Amendment A2 + ledger freeze c35abc0). The gate was not changed after fitting.

| Target | Verdict | Origins | Best baseline | Candidate gain vs best (mean ladder log loss) | 95% CI (block 12, 2,000 reps) | 80% coverage |
|---|---|---|---|---|---|---|
| **KXU3** | **FAIL** | 179 (2011-02 .. 2026-09) | CLAIMS_ONLY | -0.0017 | [-0.0178, +0.0093] | 0.855 (in band) |
| **KXPAYROLLS** | **FAIL** | 177 (2011-04 .. 2026-09) | ROLLING_MEAN_GAUSS | -0.0746 | [-0.2439, +0.0610] | 0.780 (in band) |

Gate (A1 item 1): PASS needs the CI lower bound > 0 against the best baseline AND 80% coverage in [0.72, 0.88].

## Frozen artifacts

| Artifact | sha256 |
|---|---|
| `data/employment/LEDGER_FREEZE.json` | 6da8d084f817579c29d91f4ada24e59f4494301de960067761596e183ec9697e |
| `data/employment/bls-empsit-releases-v1.json` | ed7206bb37a6fd7d0ee8c3cfda3d0ae1e18a7a7e090e38faa16ea298cb935add |
| `data/employment/bls-empsit-first-prints-v1.json` | 7c763c3ec87a72e83368526d3c6156720c0075060a32a88789dd56c986e0c148 |
| `data/employment/dol-claims-releases-v1.json` | 56c0d204dfe8978269f2706fa5c223042703606012e9b12042595f26063ecd55 |
| raw BLS releases (224 files, listing hash) | 5f6907d991288b229dee3f8e74acd7d63aaead4572bbc0ec49978c3de0812866 |
| raw DOL releases (1,028 files, listing hash) | 4371adaf7a6937088fee5f538b63e556e92b7979d8e7fc3ffbe1c90d1c35ce25 |
| feature dataset (both targets) | 35a014f4812fdca6eedbc15ff80cee4d395d51fe9e509ba3b2257f37f00e9a94 |
| `docs/research/employment-v1-u3-evidence.json` | 362165a1e1b326e0d0e0b193df504ed76254983e66c900dd72868378c00d30d9 |
| `docs/research/employment-v1-payrolls-evidence.json` | 5c920ef42bdb4066b30f1fb437b1b07f89c9dccf8b16fed36d6249dc13a0ad40 |

Versions: bls-empsit-parser/2, dol-claims-parser/2, employment-ledger/2, employment-features/1, model
employment-v1/0.1.0-research, cutoff T-1D 20:00 America/New_York. Reproduce: `node scripts/research/employment/validate.mjs u3|payrolls`
(it refuses to run if any ledger differs from LEDGER_FREEZE.json).

## Stage 1 — BLS first-print ledger

224 archived Employment Situation releases (2008-01 .. 2026-09), 0 parse failures. 225 reference months. Every record
carries the release date/time, the source URL, the document sha256 and the parser version. First print = the earliest
release (by embargo time) printing a non-null value. No FRED/ALFRED value is used anywhere.
- U-3 reprint check: 222 months checked, 217 equal, 5 year-end seasonal revisions (Nov 2008, 2011, 2012, 2022, 2025),
  0 unexplained mismatches.
- Reissues: 2008-06, 2015-01, 2019-11, 2019-12, 2020-01..08, 2025-04. Each reissue note in the file says U-3 and payrolls
  are unaffected (quoted in Amendment A2).
- April 2020: the archived file carries the May 11, 2020 correction (-20,537k). The first print is restored from that
  file's own note ("37,000 lower than initially reported") as -20,500k. The Wayback Machine could not be reached
  (HTTP 429) for an independent copy of the original, so the note in the file is the only evidence.
- **2025 shutdown, from the releases:** September 2025 data was released 2025-11-20. There was no October 2025 release. The
  November release (2025-12-16) prints October U-3 as not available (INPUT_UNAVAILABLE) and the first October payroll
  change, -105k. The January 2026 release revises it to -173k, and that revision never replaces the first print.
  January 2026 data was released 2026-02-11.

## Stage 2 — DOL claims point-in-time ledger

1,028 archived weekly releases (oui.doleta.gov/press, 2007 .. 2026-10-08), 1,022 distinct releases (2 identical
duplicates). The values are the ADVANCE seasonally adjusted initial claims (week W) and continuing claims (week W-1),
exactly as printed in that week's release. Revisions in later releases are never written back.
- 4 documents are refused because they are defective, and nothing is inferred from them: 2011-11-23 (prints Thursday on a
  Wednesday), 2012/010312 (a misfiled copy of the 2013-01-03 release with the year misprinted; the real copy parses),
  2012-03-15 ("Mach 3"), 2014/031514 (DOL placeholder file).
- Missing weeks: 2011-11-19, 2012-03-10, 2019-10-12 (absent from the DOL listing), and 2025-09-27 .. 2025-11-08
  (7 shutdown weeks).
- **Manual proof, 10/10 match** (`employment-v1-dol-manual-proof.json`): the raw sentences, extracted by a different path
  from the parser, read beside the stored values for 2007-01-04, 2008-02-21, 2011-08-04, 2014-01-02, 2016-06-16, 2020-03-26
  (3,283,000 / 1,803,000), 2020-04-02 (6,648,000 / 3,029,000), 2025-09-25, 2025-11-20 (first release after the shutdown)
  and 2026-10-08.
- Ops note: two sessions fetched concurrently and one clobbered the other's 2014 manifest entries. This was caught by a
  disk-vs-manifest audit, re-fetched as a single writer, and is now 1,028/1,028 with 0 sha mismatches.

## Stage 3 — availability / leakage

Every input value carries `available_at` = the embargo time of the release that printed it. At an origin, only values
with `available_at <=` cutoff (20:00 America/New_York the day before the release) are visible. Over the full dataset,
0 rows have an input after its cutoff. A fold guard throws if a training row's target was released after the origin
cutoff. Tests (`test/employment-v1.test.js`, 15/15):
- no later BLS release and no revised BLS value leaks backward;
- no later DOL release or revision leaks backward; a missing week is NO_FORECAST, never filled;
- no Kalshi price/mid/market feature in the U-3 or payroll model graph, and smuggled market fields change nothing;
- DST: the cutoff on both DST transition days is resolved by named timezone (Intl America/New_York), and the source
  contains no hard-coded UTC offset;
- strict "above" at exact strikes for U-3 and payrolls (contract side and model/scoring side);
- the KXPAYROLLS PPI metadata is recorded and never trusted; rules that do not reconcile fail closed; KXADP is out of scope;
- employment-v0 is unreachable without every input explicit (its fabricated defaults cannot be used).

NO_FORECAST origins (excluded for every model, each with the missing input named in the evidence JSON):
U-3: 2008-01, 2011-11, 2011-12, 2012-03, 2012-04, 2019-10, 2019-11, 2025-11, 2025-12.
Payrolls: the same plus 2008-02 and 2008-03 (3 prior months needed). October 2025 has no release, so it is no origin.

## Stage 4/5 — KXU3 (fit first)

| Model | n | Log loss | Brier | RPS | 80% cov | ECE | Log loss ex-2020/21 | Log loss 2020-03..2021-12 (n=22) |
|---|---|---|---|---|---|---|---|---|
| RIDGE_T_EWMA (candidate) | 179 | 0.2585 | 0.0783 | 0.1477 | 0.855 | 0.023 | 0.2326 | 0.4433 |
| CLAIMS_ONLY | 179 | **0.2568** | 0.0781 | 0.1439 | 0.877 | 0.019 | 0.2349 | 0.4131 |
| PERSISTENCE_EMPIRICAL | 179 | 0.3210 | 0.0950 | 0.2074 | 0.944 | 0.082 | 0.2663 | 0.7115 |
| ROLLING_MEAN_GAUSS | 179 | 0.3639 | 0.1116 | 0.2402 | 0.950 | 0.092 | 0.2886 | 0.9014 |
| employment-v0 (quarantined) | 179 | 0.6674 | 0.1623 | — | — | 0.154 | 0.3809 | 2.7120 |

Candidate log-loss gain (95% CI): vs persistence +0.0625 [0.0125, 0.1312]; vs rolling mean +0.1054 [0.0233, 0.2116];
vs v0 +0.4090 [0.1233, 0.9165]; **vs claims-only -0.0017 [-0.0178, 0.0093]**. Reading: weekly claims carry the
U-3 signal. The candidate's extra term (last month's U-3 change, coefficient about -0.03) adds nothing, so it cannot beat
the claims-only baseline it contains. PIT deciles (candidate): 0.133 0.109 0.092 0.083 0.088 0.119 0.126 0.109 0.083 0.057.

## Stage 6 — KXPAYROLLS (after the U-3 verdict)

| Model | n | Log loss | Brier | 80% cov | ECE | Log loss ex-2020/21 | MAE ex-2020/21 | Log loss 2020-03..2021-12 |
|---|---|---|---|---|---|---|---|---|
| RIDGE_T_EWMA (candidate) | 177 | 0.5848 | 0.1686 | 0.780 | 0.120 | 0.4998 | 146k | 1.1840 |
| ROLLING_MEAN_GAUSS | 177 | **0.5103** | 0.1697 | 0.960 | 0.162 | 0.4540 | 64k | 0.9068 |
| PERSISTENCE_EMPIRICAL | 177 | 0.5381 | 0.1621 | 0.881 | 0.109 | 0.4735 | 86k | 0.9937 |
| CLAIMS_ONLY | 177 | 0.6531 | 0.2189 | 0.814 | 0.242 | 0.6954 | 204k | 0.3553 |

Candidate log-loss gain (95% CI): vs rolling mean -0.0746 [-0.2439, 0.0610]; vs persistence -0.0467 [-0.1844, 0.0696];
vs claims-only +0.0683 [-0.2108, 0.2446]. The candidate also loses outside 2020-21 (-0.046 vs the rolling mean,
n = 155). Observation only, not acted on: the 2020 prints (-20.5M, +4.8M) sit in every later expanding training window
and distort the ridge fit (ex-2020 MAE 146k vs 64k). Any fix would be a new model generation with a new pre-registered
protocol, never a tune of this one.

## Contract semantics (unchanged, enforced in tests)

KXU3 and KXPAYROLLS: YES iff the first-published value is strictly ABOVE the strike (`strike_type: greater`).
P(YES) = P(value > strike) on integer grid indices; the exact strike is NO. KXPAYROLLS series metadata names the PPI
page (`ppi.nr0.htm`). The rules name the Employment Situation and total nonfarm payroll employment, so the rules govern.
The conflict is recorded on every normalized term, and any market whose rules do not reconcile is refused (not modeled).
KXADP is out of scope (proprietary ADP data, not purchased or ingested).

## Stop point

Research evidence only. No Employment production table, cron lane, Worker path, public model row or SHADOW forecast exists.
Both targets stay RESEARCH. A next step, if any, needs the owner.

## Post-gate addenda (2026-10-08, after the verdicts; the verdicts are unchanged and final per the owner)

**Data integrity: PASS.**
- DOL reconciliation: 1,028 archived files = 1,022 releases + 2 identical duplicates (the same release listed under two
  years: 2013-01-03 in 2012/ and 2013/, 2013-08-01 in 2012/ and 2013/) + 4 refused defective documents. All 1,028 have
  HTTP 200 and their sha256 matches the manifest (382 .asp, 646 .pdf). No other category exists.
- Independent truth check against Kalshi's own settlements (`employment-v1-kalshi-comparison.json`): **810 / 810**
  checkable contracts agree with our first-print ledger (KXU3 461/461, KXPAYROLLS 349/349, 2021-2026). This includes
  November 2025 U-3: Kalshi `expiration_value` 4.6 = our first print, not the 4.5 January revision.
- Not checkable: the 9 October 2025 KXU3 contracts. Kalshi settled them with `expiration_value` 4.4, but BLS never
  published an October 2025 U-3 (the release prints it as not available). The ledger keeps INPUT_UNAVAILABLE. This is a
  settlement-source risk to note for any future U-3 lane.
- Reproducibility: rebuilding both ledgers from the raw archive into a clean directory and re-running both gates gives
  byte-identical ledgers (3/3 hashes) and evidence (both sha256 identical).

**April 2020 provenance limitation.** The only source for the -20,500k first print is the correction note inside the
archived, corrected BLS file. An independent copy of the original release was not retrievable (Wayback 429). Kalshi has
no April 2020 market. The figure is used as-is and flagged.

**The four full-suite failures** (identical before and after all Employment commits; none touch Employment code):
1. `test/entitlement.test.js`: environmental. `@resvg/resvg-wasm` is not installed in this dependency-free worktree; the
   test passes 14/14 in `D:\Workers\predictions`, which has node_modules.
2. `home-truth`, "asset version bumped consistently": `index.html` mixes `?v=20261006nav3` and `20261005aa4` (main content drift).
3. `network-family-parity`, rendered footers: the Worker footer lacks the expected All Access link (`worker: all_access`).
4. `network-shell`, single publisher identity: the expected copy "10 sports + PropBetEdge Predictions for $29/month" no
   longer matches the page.
Items 2-4 fail on main too. They belong to the network/All Access work, not to Predictions research.

**V1 vs Kalshi, descriptive only** (T-1D 20:00 ET mid of the last hourly candle with both quotes; every source scored on
the same priced contracts; fail-closed term refusals excluded for all sources; block-3 bootstrap):
| | Events | Contracts | Market LL / Brier | V1 candidate | Best V1 baseline | Candidate minus market (LL), 95% CI |
|---|---|---|---|---|---|---|
| KXU3 | 39 (2022-12 .. 2026-07) | 316 | **0.2654 / 0.0824** | 0.3654 / 0.1154 | claims-only 0.3731 / 0.1185 | -0.100 [-0.168, -0.039] |
| KXPAYROLLS | 31 (2023-03 .. 2026-07) | 279 | **0.4136 / 0.1365** | 0.6878 / 0.2331 | rolling mean 0.6518 / 0.2294 | -0.274 [-0.444, -0.011] |
The market beats every V1 model on both targets, with confidence intervals excluding zero. Median quoted spread: 3 cents.
Contracts refused by the fail-closed terms check (missing `strike_type`, `4.099999` floors, a double space in a month,
off-grid strikes like 215,999, and 2022 rules that do not name the Employment Situation): KXU3 129, KXPAYROLLS 47.

