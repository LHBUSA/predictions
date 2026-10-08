// Employment V1 point-in-time features (Amendment A1 items 4, 5, 8). Pure.
// Every value carries available_at = the embargo time of the release that published it, and a feature row for origin M
// uses only values with available_at <= cutoff(M) = 20:00 America/New_York the day before M's Employment Situation.
// Missing anything -> { status: 'NO_FORECAST', reason, missing } for that origin. Nothing is imputed.
import { addDaysYmd, etToUtcIso } from '../cpi/timeline.js';
import { shiftMonth } from './bls-empsit.js';

export const FEATURE_VERSION = 'employment-features/1';
export const CUTOFF_RULE = 'T-1D 20:00 America/New_York';

export const cutoffFor = (releaseDate) => etToUtcIso(addDaysYmd(releaseDate, -1), 20, 0);

// Saturday ending the Sunday-Saturday week that contains the 12th (BLS reference week)
export function referenceSaturday(month) {
  const d = new Date(`${month}-12T00:00:00Z`);
  d.setUTCDate(12 + ((6 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// BLS: latest value for `month` among releases published at or before `cutoff`
function blsAsOf(releases, field, month, cutoff) {
  let best = null;
  for (const r of releases) {
    if (r.release_at > cutoff) continue;
    const v = r[field]?.[month];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    if (!best || r.release_at > best.available_at) best = { value: v, available_at: r.release_at, source: r.file_name };
  }
  return best;
}

// DOL: the advance (first-published) value for a week, if its release is at or before the cutoff
function claimsIndex(claims) {
  const ic = new Map(); const cc = new Map();
  for (const r of claims) {
    if (!ic.has(r.initial_week_ending)) ic.set(r.initial_week_ending, { value: r.initial_claims_sa, available_at: r.release_at, source: r.file_name });
    if (!cc.has(r.continuing_week_ending)) cc.set(r.continuing_week_ending, { value: r.continuing_claims_sa, available_at: r.release_at, source: r.file_name });
  }
  return { ic, cc };
}
const known = (x, cutoff) => (x && x.available_at <= cutoff ? x : null);

export function buildFeatureRow({ month, release, releases, claimsIdx }) {
  const cutoff = cutoffFor(release.release_date);
  const missing = {};
  const take = (name, x, why) => { if (!x) missing[name] = why; return x; };
  const A = take('ANCHOR_U3', blsAsOf(releases, 'u3_by_month', shiftMonth(month, -1), cutoff), `U-3 for ${shiftMonth(month, -1)} not published by the cutoff`);
  const U2 = take('U3_M2', blsAsOf(releases, 'u3_by_month', shiftMonth(month, -2), cutoff), `U-3 for ${shiftMonth(month, -2)} not published by the cutoff`);
  const pays = [1, 2, 3].map((k) => take(`PAY_M${k}`, blsAsOf(releases, 'payroll_change_k_by_month', shiftMonth(month, -k), cutoff), `payroll change for ${shiftMonth(month, -k)} not published by the cutoff`));
  const ref = referenceSaturday(month); const refPrev = referenceSaturday(shiftMonth(month, -1));
  const cc = take('CC_REF', known(claimsIdx.cc.get(ref), cutoff), `continuing claims for week ending ${ref} not published by the cutoff`);
  const ccP = take('CC_REF_PREV', known(claimsIdx.cc.get(refPrev), cutoff), `continuing claims for week ending ${refPrev} not published by the cutoff`);
  const ic4 = (sat) => [0, 7, 14, 21].map((d) => known(claimsIdx.ic.get(addDaysYmd(sat, -d)), cutoff));
  const icNow = ic4(ref); const icPrev = ic4(refPrev);
  if (icNow.some((x) => !x)) missing.IC4_REF = `initial claims for the 4 weeks ending ${ref} not all published by the cutoff`;
  if (icPrev.some((x) => !x)) missing.IC4_REF_PREV = `initial claims for the 4 weeks ending ${refPrev} not all published by the cutoff`;
  const avg = (xs) => xs.reduce((s, x) => s + x.value, 0) / xs.length;
  const claimsOk = cc && ccP && !missing.IC4_REF && !missing.IC4_REF_PREV;
  const features = {
    CC_LOGCHG_REF: cc && ccP ? Math.log(cc.value / ccP.value) : null,
    IC4_LOGCHG_REF: !missing.IC4_REF && !missing.IC4_REF_PREV ? Math.log(avg(icNow) / avg(icPrev)) : null,
    DU_L1: A && U2 ? Math.round((A.value - U2.value) * 10) / 10 : null,
    PAY_L1: pays[0]?.value ?? null,
    PAY_AVG3: pays.every(Boolean) ? (pays[0].value + pays[1].value + pays[2].value) / 3 : null,
  };
  // availability per target (A1 item 8): only the inputs that target's candidate uses
  const need = { u3: ['ANCHOR_U3', 'U3_M2', 'CC_REF', 'CC_REF_PREV', 'IC4_REF', 'IC4_REF_PREV'], payroll: ['PAY_M1', 'PAY_M2', 'PAY_M3', 'CC_REF', 'CC_REF_PREV', 'IC4_REF', 'IC4_REF_PREV'] };
  const statusFor = (t) => { const m = Object.fromEntries(need[t].filter((k) => missing[k]).map((k) => [k, missing[k]])); return Object.keys(m).length ? { status: 'NO_FORECAST', reason: 'INPUT_UNAVAILABLE', missing: m } : { status: 'OK' }; };
  const used = [A, U2, ...pays, cc, ccP, ...icNow, ...icPrev].filter(Boolean);
  return {
    month, release_date: release.release_date, release_at: release.release_at, cutoff_at: cutoff, reference_week: ref,
    u3: statusFor('u3'), payroll: statusFor('payroll'),
    anchor_u3: A?.value ?? null,
    features,
    // raw inputs for employment-v0 (quarantined baseline): every input explicit, so its defaults are never reached;
    // null when any is missing, and v0 is then not scored for this origin
    v0_inputs: A && U2 && pays[0] && pays[1] && claimsOk ? { unemploymentRate: A.value, priorUnemploymentRate: U2.value, payrollChangeK: pays[0].value, priorPayrollChangeK: pays[1].value, initialClaimsK: icNow[0].value / 1000, continuingClaimsM: cc.value / 1e6 } : null,
    inputs_available_at_max: used.map((x) => x.available_at).sort().at(-1) ?? null,
    provenance: { anchor: A?.source ?? null, cc: cc?.source ?? null, ic_latest: icNow[0]?.source ?? null },
  };
}

// Target = first print for the origin month (ledger row). null when that first print does not exist.
export function buildDataset({ releases, claims, firstPrints }) {
  const claimsIdx = claimsIndex(claims);
  const fp = new Map(firstPrints.map((m) => [m.reference_month, m]));
  return releases.map((release) => {
    const row = buildFeatureRow({ month: release.reference_month, release, releases, claimsIdx });
    const t = fp.get(release.reference_month);
    return { ...row, target: { u3: t?.u3.status === 'OK' ? t.u3.value : null, u3_release_at: t?.u3.release_at ?? null, payroll_change_k: t?.payroll_change_k.status === 'OK' ? t.payroll_change_k.value : null, payroll_release_at: t?.payroll_change_k.release_at ?? null } };
  });
}
export { claimsIndex };
