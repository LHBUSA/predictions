// decision-policy-v1 evidence: assemble docs/research/decision-policy-v1-evidence.json from analysis.json + policy-check.json.
//   node scripts/research/decision/dp-build-evidence.mjs [caseDir]
// The `recommended` blocks are the DRAFT recommendation argued in docs/research/DECISION_POLICY_V1_EVIDENCE.md.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-decision';
const A = JSON.parse(await readFile(join(DIR, 'analysis.json'), 'utf8'));
const PC = JSON.parse(await readFile(join(DIR, 'policy-check.json'), 'utf8'));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const F = A.families;

const recommended = {
  'pbe-weather-precip': {
    allow_call: true, threshold: 0.70, confidence_floor: 'HIGH', near_certain_cutoff: 0.97, sides: 'YES and NO',
    scoped_exclusions: [{ side: 'YES', climate_months: ['06', '07', '08', '09'], reason: 'MODEL_NOT_VALIDATED', why: 'warm-season YES calls overconfident: selection-window hit 75.3% vs mean p 82.5% (n=1982) at T=0.70 all grades; final window 80.8% vs 84.0% (n=1398, HIGH)' }],
    mechanical_selection: { criterion_A: { filter: F['pbe-weather-precip'].selection.criterion_A_calibration_only?.filter, T: F['pbe-weather-precip'].selection.criterion_A_calibration_only?.T }, criterion_B: { filter: F['pbe-weather-precip'].selection.criterion_B_with_abs_floor?.filter, T: F['pbe-weather-precip'].selection.criterion_B_with_abs_floor?.T } },
    deviations_from_mechanical: ['confidence floor tightened ALL -> HIGH: MEDIUM-grade calls at T=0.70 hit 76.9% vs mean p 81.5% (selection, n=1821)', 'warm-season YES exclusion; both were formulated after the final window had been viewed (bias is visible in the selection window alone, but the final check is no longer untouched for these two refinements)'],
    expected: PC.precip.find((r) => r.label.startsWith('DRAFT')),
  },
  'pbe-weather-maxtemp': {
    allow_call: false, threshold: null, confidence_floor: 'HIGH', near_certain_cutoff: 0.97, sides: 'none in v1', state: 'PASS:MODEL_NOT_VALIDATED (decision layer)',
    why: ['YES: HIGH grade never reaches p>=0.60 on any bucket; modal bucket hits 35.1% overall; YES calls at p>=0.55 come from NBM/GFS disagreement and hit 51% vs mean p 71% (n=5810); final-window HIGH YES 41.6% vs 56.0% (n=89)', 'NO: calibrated in aggregate (82.5% vs 82.5%) but below the trivial "every bucket NO" hit rate of 83.3%, and central-bucket NO calls are overconfident by 3-5 pts', 'probabilities themselves are skilled (event BSS 0.327 vs climatology, 0.014 vs Normal error model) and should still be published'],
    mechanical_selection: { criterion_A: { filter: F['pbe-weather-maxtemp'].selection.criterion_A_calibration_only?.filter, T: F['pbe-weather-maxtemp'].selection.criterion_A_calibration_only?.T, final_passes: F['pbe-weather-maxtemp'].selection.criterion_A_calibration_only?.final?.passes }, criterion_B: { filter: F['pbe-weather-maxtemp'].selection.criterion_B_with_abs_floor?.filter, T: F['pbe-weather-maxtemp'].selection.criterion_B_with_abs_floor?.T, sides: 'NO only', final_passes: F['pbe-weather-maxtemp'].selection.criterion_B_with_abs_floor?.final?.passes } },
    trivial_reference: PC.temp_trivial_reference, mechanical_policy_check: PC.temp[0],
  },
  'pbe-rates-path': { allow_call: false, threshold: null, confidence_floor: 'HIGH', near_certain_cutoff: 0.97, state: 'PASS:MODEL_NOT_VALIDATED', why: ['BSS vs named Gaussian baseline 0.019, 95% CI [-0.003, 0.042] includes 0 (105 month clusters)', 'tail calibration weak: max(p,1-p)>=0.97 hit 95.3% vs 98.2%', 'final 3 months (3 clusters) hit 65.8% vs mean p 76.2% at T=0.55'], mechanical_selection_if_validated: { criterion_B: { filter: 'ALL', T: F['pbe-rates-path'].selection.criterion_B_with_abs_floor?.T } } },
  'pbe-fed-decision': F['pbe-fed-decision'].recommended,
};

const tablesOf = (f) => (f.tables || []);
const out = {
  policy: 'prediction-decision-v1', status: 'DRAFT_EVIDENCE', generated_at: new Date().toISOString(),
  owner_rule: 'Facts create the PBE probability. Kalshi and Polymarket benchmark it afterward. No market/venue price is read anywhere in this evidence.',
  method: { ...A.method, scripts: ['scripts/research/decision/dp-wx-cases.mjs', 'scripts/research/decision/dp-rates-cases.mjs', 'scripts/research/decision/dp-fed-cases.mjs', 'scripts/research/decision/dp-analyze.mjs', 'scripts/research/decision/dp-policy-check.mjs', 'scripts/research/decision/dp-build-evidence.mjs'], case_outputs: 'D:/Workers/scratch/predictions-decision/*.jsonl', validation_rule: '`skill_validated` iff 95% cluster-bootstrap CI lower bound of BSS > 0 vs EVERY listed baseline (weather: climatology AND the strongest naive reference; rates: Gaussian AND climatology) and n_dates >= 180; `validated` (for CALL) additionally requires that the decision-level holdout evidence supports calls (recommended.allow_call)', p_used: 'published probability (whole percent), as the decision layer will see it' },
  families: Object.fromEntries(Object.entries(F).map(([id, f]) => [id, {
    validated: Boolean(f.validated && recommended[id]?.allow_call), skill_validated: f.validated, skill: f.skill, skill_ci: f.skill_ci, skill_baseline: f.skill_baseline, n_cases: f.n_cases, n_dates: f.n_dates,
    ...pick(f, ['versions', 'validated_reason', 'skill_vs_raw_guidance', 'skill_vs_raw_guidance_ci', 'skill_vs_normal_error_model', 'skill_vs_normal_error_model_ci', 'skill_vs_climatology', 'skill_vs_climatology_ci', 'skill_vs_persistence', 'skill_vs_persistence_ci', 'n_bucket_contracts', 'n_months_clusters', 'holdout', 'grade_distribution', 'grade_production_vs_point_in_time_mismatches', 'tier_distribution', 'top_outcome_accuracy', 'always_hold_accuracy', 'near_certain_calibration']),
    recommended: recommended[id],
    selection: f.selection,
    skill_slices: f.skill_slices,
    tables: tablesOf(f),
    ...pick(f, ['by_lead_selection', 'by_lead_final', 'by_grade_selection', 'by_season_full', 'by_window_season', 'by_tier_full', 'by_month_full', 'by_bucket_selection', 'by_disagreement_full', 'event_level_modal', 'by_k_selection', 'by_offset_selection', 'by_year_full']),
  }])),
  policy_checks: PC,
};
await writeFile(new URL('../../../docs/research/decision-policy-v1-evidence.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('written', Object.keys(out.families));
