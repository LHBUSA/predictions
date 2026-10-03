// Automated Newsroom V1 — documented thresholds (versioned; a change here is a newsroom contract change).
export const NEWSROOM_RULES = 'newsroom/1';

export const STATES = Object.freeze(['CANDIDATE', 'EVIDENCE_READY', 'GENERATED', 'VALIDATED', 'PUBLISHED', 'HELD']);

export const MOVER = Object.freeze({
  // A mover compares two PUBLIC snapshots of the SAME model id AND version for the same contract:
  min_abs_pts: 10,          // |PBE(t1) - PBE(t0)| in percentage points (rounded stored probabilities)
  min_elapsed_hours: 2,     // t1.captured_at - t0.captured_at
  require_new_cutoff: true, // t1.data_cutoff_at must be later than t0's: new information, not a re-run
  large_jump_pts: 25,       // at or above: publish only if a PRIMARY input changed; otherwise anomaly HOLD
  lookback_hours: 48,       // snapshots considered for detection
  cooldown_hours: 12,       // per event: at most one mover per window
  desk_cap_per_day: 8,      // across all events
});

export const RESOLUTION = Object.freeze({
  lookback_days: 10,
  require_official_check: true, // independent official value stored AND agreeing with the venue settlement
  require_scores: true,         // designated snapshots scored before the report is generated
});

// Inputs whose change can explain a probability move. Bookkeeping fields (run lead hours, table labels) never can.
export const PRIMARY_INPUTS = Object.freeze({
  'pbe-weather-maxtemp': ['nbm_max_temp_guidance_f', 'mos_max_temp_guidance_f', 'nbm_max_temp_spread_f'],
  'pbe-weather-precip': ['nbm_pop_union', 'mos_pop_union', 'nbm_pop_max', 'mos_pop_max'],
  'pbe-rates-path': ['last_published_yield', 'period_running_extreme', 'remaining_business_days', 'ewma_daily_sigma'],
});
export const INPUT_LABELS = Object.freeze({
  nbm_max_temp_guidance_f: ['National Blend of Models forecast high', '°F'], mos_max_temp_guidance_f: ['GFS MOS forecast high', '°F'], nbm_max_temp_spread_f: ['National Blend spread', '°F'],
  nbm_pop_union: ['National Blend chance of rain in the window', 'prob'], mos_pop_union: ['GFS MOS chance of rain in the window', 'prob'], nbm_pop_max: ['National Blend max 6-h chance of rain', 'prob'], mos_pop_max: ['GFS MOS max 6-h chance of rain', 'prob'],
  last_published_yield: ['Latest official par yield', '%'], period_running_extreme: ['Period high/low so far', '%'], remaining_business_days: ['Business days left', ''], ewma_daily_sigma: ['Daily volatility (EWMA)', 'pp'],
  run_lead_hours: ['Guidance lead time', 'h'],
});

export const ANOMALY = Object.freeze({
  SAME_CUTOFF_VERSION_CHANGE: 'Consecutive public snapshots share a data cutoff but come from different model versions',
  VERSION_REGRESSION: 'A later public snapshot uses an older model version than an earlier one',
  LARGE_JUMP_UNEXPLAINED: 'Probability jumped at least the large-jump threshold with no change in a primary input',
  NO_INPUT_CHANGE: 'Probability changed between same-version snapshots although no stored input changed',
});
