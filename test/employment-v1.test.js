// Employment V1 research: as-published ledgers, availability/leakage, contract semantics. No production path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseEmpsitRelease } from '../src/macro/employment/bls-empsit.js';
import { parseClaimsRelease } from '../src/macro/employment/dol-claims.js';
import { firstPrints, releaseAtUtc, u3ReprintConsistency } from '../src/macro/employment/ledger.js';
import { buildFeatureRow, claimsIndex, cutoffFor, referenceSaturday } from '../src/macro/employment/features.js';
import { employmentTerms, parseEmploymentTicker, probabilityAbove, yesOutcome } from '../src/macro/employment/employment-contract.js';
import { PAY_FAMILIES, PAY_FEATURES, PAY_CLAIMS_FEATURES, payLadder, toPayUnits, U3_FAMILIES, U3_FEATURES, U3_CLAIMS_FEATURES, u3Ladder } from '../src/macro/employment/models.js';
import { scoreThresholds } from '../src/macro/cpi/scoring.js';
import { makeDistribution } from '../src/macro/cpi/distribution.js';

const fx = (f) => readFileSync(new URL(`./fixtures/employment/${f}`, import.meta.url), 'utf8');
const parse = (f) => { const r = parseEmpsitRelease(fx(f), { fileName: f }); assert.ok(r.ok, `${f}: ${r.reason}`); return { ...r, release_at: releaseAtUtc(r) }; };

test('BLS HTML release (Dec 2025): first prints, shutdown month printed as not available, narrative agrees', () => {
  const r = parse('empsit_01092026.trim.htm');
  assert.equal(r.reference_month, '2025-12');
  assert.equal(r.release_date, '2026-01-09');
  assert.equal(r.release_time_et, '08:30');
  assert.deepEqual(r.headline, { u3: 4.4, payroll_change_k: 50 });
  assert.equal(r.u3_by_month['2025-10'], null); // household survey not collected (shutdown), never 0
  assert.deepEqual(r.checks, { u3_narrative: 'MATCH', payroll_narrative: 'MATCH' });
});

test('BLS text-table release (Jan 2008) and a release with no weekday in the embargo line (Aug 2009)', () => {
  const a = parse('empsit_02012008.trim.htm');
  assert.equal(a.format, 'text-tables');
  assert.deepEqual([a.reference_month, a.headline.u3, a.headline.payroll_change_k], ['2008-01', 4.9, -17]);
  const b = parse('empsit_09042009.trim.htm');
  assert.deepEqual([b.reference_month, b.release_date, b.weekday, b.headline.u3, b.headline.payroll_change_k], ['2009-08', '2009-09-04', 'Friday', 9.7, -216]);
});

test('a post-publication correction in the archived file is undone: April 2020 first print is the published -20,500k', () => {
  const r = parse('empsit_05082020.trim.htm');
  assert.equal(r.payroll_change_k_by_month['2020-04'], -20537); // the archive carries the corrected table
  assert.equal(r.payroll_corrections[0].corrected_minus_original_k, -37);
  const [apr] = firstPrints([r]).filter((m) => m.reference_month === '2020-04');
  assert.equal(apr.payroll_change_k.value, -20500);
  assert.equal(apr.payroll_change_k.restored_from_correction_note.archived_value, -20537);
});

test('2025 shutdown, from the releases themselves: Oct 2025 U-3 INPUT_UNAVAILABLE; Oct payrolls first printed with November', () => {
  const nov = parse('empsit_12162025.trim.htm'); const dec = parse('empsit_01092026.trim.htm');
  const fp = new Map(firstPrints([nov, dec], { fromMonth: '2025-10' }).map((m) => [m.reference_month, m]));
  const oct = fp.get('2025-10');
  assert.equal(oct.own_release, null);
  assert.deepEqual([oct.u3.status, oct.u3.value, oct.u3.reason], ['INPUT_UNAVAILABLE', null, 'PRINTED_AS_NOT_AVAILABLE']);
  assert.deepEqual([oct.payroll_change_k.value, oct.payroll_change_k.release_date, oct.payroll_change_k.in_own_release], [-105, '2025-12-16', false]);
  assert.deepEqual(oct.payroll_change_k.later_prints.map((p) => p.value), [-173]); // the revision never replaces the first print
  assert.equal(fp.get('2025-11').u3.value, 4.6); // first print, not the 4.5 year-end SA revision printed in January
  const c = u3ReprintConsistency([nov, dec]);
  assert.deepEqual(c.mismatches, []);
  assert.deepEqual(c.year_end_sa_revisions.map((x) => [x.month, x.first, x.reprinted]), [['2025-11', 4.6, 4.5]]);
});

test('DOL weekly claims: advance SA values, release date from the embargo line (PDF era and .asp era)', () => {
  const a = parseClaimsRelease(fx('dol_100126.txt'));
  assert.deepEqual([a.release_date, a.release_time_et, a.initial_week_ending, a.initial_claims_sa, a.continuing_week_ending, a.continuing_claims_sa], ['2026-10-01', '08:30', '2026-09-26', 197000, '2026-09-19', 1701000]);
  const b = parseClaimsRelease(fx('dol_010809.asp'));
  assert.deepEqual([b.release_date, b.initial_week_ending, b.initial_claims_sa, b.continuing_week_ending, b.continuing_claims_sa], ['2009-01-08', '2009-01-03', 467000, '2008-12-27', 4611000]);
  assert.equal(parseClaimsRelease('In the week ending Jan. 3, the advance figure for seasonally adjusted initial claims was 1').ok, false);
});

// ------------------------------------------------------------------ availability / leakage
const rel = (month, date, u3, pay) => ({ reference_month: month, release_date: date, release_time_et: '08:30', release_at: releaseAtUtc({ release_date: date, release_time_et: '08:30' }), u3_by_month: u3, payroll_change_k_by_month: pay, file_name: `${date}.htm` });
function weeklyClaims(fromSat, n, ic, cc) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = new Date(Date.parse(`${fromSat}T00:00:00Z`) + i * 7 * 86400000).toISOString().slice(0, 10);
    const relDate = new Date(Date.parse(`${w}T00:00:00Z`) + 5 * 86400000).toISOString().slice(0, 10);
    const prev = new Date(Date.parse(`${w}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
    out.push({ release_date: relDate, release_at: releaseAtUtc({ release_date: relDate, release_time_et: '08:30' }), initial_week_ending: w, initial_claims_sa: ic(i), continuing_week_ending: prev, continuing_claims_sa: cc(i), file_name: `${relDate}.pdf` });
  }
  return out;
}
const claims = weeklyClaims('2026-01-03', 30, (i) => 200000 + i * 1000, (i) => 1800000 + i * 5000);
const R = [rel('2026-03', '2026-04-03', { '2026-02': 4.4, '2026-03': 4.3 }, { '2026-01': 20, '2026-02': 30, '2026-03': 40 }),
  rel('2026-04', '2026-05-08', { '2026-03': 4.3, '2026-04': 4.5 }, { '2026-02': 31, '2026-03': 41, '2026-04': 60 })];
const may = { reference_month: '2026-05', release_date: '2026-06-05' };

test('no later BLS release and no revised value leaks backward', () => {
  // the June release (after the May cutoff) revises April and prints May: neither may be visible to the May row
  const later = rel('2026-05', '2026-06-05', { '2026-04': 9.9, '2026-05': 9.9 }, { '2026-03': 999, '2026-04': 999, '2026-05': 999 });
  const row = buildFeatureRow({ month: '2026-05', release: may, releases: [...R, later], claimsIdx: claimsIndex(claims) });
  assert.equal(row.u3.status, 'OK');
  assert.equal(row.anchor_u3, 4.5); // April as published 2026-05-08, not the 9.9 printed after the cutoff
  assert.equal(row.features.PAY_L1, 60);
  assert.equal(row.features.PAY_AVG3, (60 + 41 + 31) / 3); // latest published by the cutoff (March revised 40 -> 41 on 05-08)
  assert.ok(row.inputs_available_at_max <= row.cutoff_at);
});

test('no later DOL claims revision or later release leaks backward; a missing week is NO_FORECAST, never filled', () => {
  const ref = referenceSaturday('2026-05');
  // a later release (after the cutoff) that re-states the reference week must not replace the advance figure
  const revised = { ...claims.find((c) => c.continuing_week_ending === ref), release_date: '2026-06-11', release_at: releaseAtUtc({ release_date: '2026-06-11', release_time_et: '08:30' }), continuing_claims_sa: 9e6, initial_claims_sa: 9e6, file_name: 'later.pdf' };
  const idx = claimsIndex([...claims, revised]);
  const row = buildFeatureRow({ month: '2026-05', release: may, releases: R, claimsIdx: idx });
  const ccRef = claims.find((c) => c.continuing_week_ending === ref).continuing_claims_sa;
  const ccPrev = claims.find((c) => c.continuing_week_ending === referenceSaturday('2026-04')).continuing_claims_sa;
  assert.equal(row.features.CC_LOGCHG_REF, Math.log(ccRef / ccPrev));
  const gap = claimsIndex(claims.filter((c) => c.continuing_week_ending !== ref));
  const r2 = buildFeatureRow({ month: '2026-05', release: may, releases: R, claimsIdx: gap });
  assert.equal(r2.u3.status, 'NO_FORECAST');
  assert.equal(r2.u3.reason, 'INPUT_UNAVAILABLE');
  assert.ok(r2.u3.missing.CC_REF);
  assert.equal(r2.features.CC_LOGCHG_REF, null);
});

test('no Kalshi price, mid or market feature exists in the model graph', () => {
  const row = buildFeatureRow({ month: '2026-05', release: may, releases: R, claimsIdx: claimsIndex(claims) });
  const market = /price|bid|ask|mid|kalshi|market|venue|volume|interest|odds|implied/i;
  for (const k of [...Object.keys(row.features), ...U3_FEATURES, ...U3_CLAIMS_FEATURES, ...Object.keys(row.v0_inputs)]) assert.doesNotMatch(k, market, k);
  // a market field smuggled onto a row changes nothing: models read only their named features
  const train = Array.from({ length: 40 }, (_, i) => ({ anchor_u3: 4, target: { u3: 4 + ((i % 3) - 1) / 10 }, features: { CC_LOGCHG_REF: (i % 5) / 100, IC4_LOGCHG_REF: (i % 7) / 100, DU_L1: ((i % 3) - 1) / 10 } }));
  const p = U3_FAMILIES.RIDGE_T_EWMA.fit(train);
  const base = { anchor_u3: 4.2, features: { CC_LOGCHG_REF: 0.02, IC4_LOGCHG_REF: 0.01, DU_L1: 0.1 } };
  const a = p(base); const b = p({ ...base, features: { ...base.features, kalshi_mid: 0.9 }, yes_bid: 0.9 });
  assert.deepEqual(a.mass, b.mass);
});

test('T-1D cutoff is 20:00 America/New_York by named timezone across DST', () => {
  assert.equal(cutoffFor('2026-03-06'), '2026-03-06T01:00:00.000Z'); // 20:00 EST Thu 03-05
  assert.equal(cutoffFor('2026-03-09'), '2026-03-09T00:00:00.000Z'); // 20:00 EDT Sun 03-08 (DST began 02:00 that day)
  assert.equal(cutoffFor('2026-11-02'), '2026-11-02T01:00:00.000Z'); // 20:00 EST Sun 11-01 (DST ended that day)
  assert.equal(cutoffFor('2026-07-02'), '2026-07-02T00:00:00.000Z'); // 20:00 EDT
  assert.equal(releaseAtUtc({ release_date: '2026-01-09', release_time_et: '08:30' }), '2026-01-09T13:30:00.000Z');
  assert.equal(releaseAtUtc({ release_date: '2026-07-02', release_time_et: '08:30' }), '2026-07-02T12:30:00.000Z');
  assert.equal(referenceSaturday('2026-09'), '2026-09-12'); // the 12th is a Saturday
  assert.equal(referenceSaturday('2026-10'), '2026-10-17'); // the 12th is a Monday
});

// ------------------------------------------------------------------ Kalshi semantics
const kalshi = JSON.parse(fx('kalshi-employment-events-2026-10-08.json'));
const mk = (s, strike) => kalshi.series[s].events[0].markets.find((m) => m.floor_strike === strike);

test('KXU3 / KXPAYROLLS: YES iff the first print is STRICTLY above the strike; exact-strike boundaries are NO', () => {
  const u = employmentTerms(mk('KXU3', 4.3), { seriesMeta: kalshi.series.KXU3.series });
  assert.ok(u.ok);
  assert.deepEqual([u.comparator, u.strike, u.reference_month], ['greater', 4.3, '2026-10']);
  assert.equal(yesOutcome(u, 4.3), false);
  assert.equal(yesOutcome(u, 4.4), true);
  assert.equal(yesOutcome(u, 4.2), false);
  assert.equal(yesOutcome(u, null), null);
  assert.equal(probabilityAbove({ lo: 4.2, step: 0.1, mass: [0.2, 0.5, 0.3] }, u), 0.3); // P(U3 > 4.3) excludes 4.3
  const p = employmentTerms(mk('KXPAYROLLS', 50000), { seriesMeta: kalshi.series.KXPAYROLLS.series });
  assert.ok(p.ok);
  assert.equal(yesOutcome(p, 50), false); // +50,000 is not above 50,000
  assert.equal(yesOutcome(p, 51), true);
  assert.equal(probabilityAbove({ lo: 49, step: 1, mass: [0.2, 0.5, 0.3] }, p), 0.3);
  const neg = employmentTerms(mk('KXPAYROLLS', -25000), {});
  assert.equal(yesOutcome(neg, -25), false);
  assert.equal(yesOutcome(neg, -24), true);
});

test('KXPAYROLLS PPI settlement-source metadata is recorded, never trusted; rules that do not reconcile fail closed; KXADP out of scope', () => {
  const ser = kalshi.series.KXPAYROLLS.series;
  const p = employmentTerms(mk('KXPAYROLLS', 50000), { seriesMeta: ser });
  assert.equal(p.metadata_conflicts.length, 1);
  assert.match(p.metadata_conflicts[0].settlement_source_url, /ppi\.nr0\.htm/);
  assert.match(p.rules_primary, /Employment Situation/);
  const m = mk('KXPAYROLLS', 50000);
  assert.equal(employmentTerms({ ...m, rules_primary: m.rules_primary.replace('Employment Situation', 'Producer Price Index') }).reason, 'RULES_DISAGREE_WITH_SERIES');
  assert.equal(employmentTerms({ ...m, rules_primary: m.rules_primary.replace('October 2026', 'September 2026') }).reason, 'RULES_MONTH_DISAGREES_WITH_TICKER');
  assert.equal(employmentTerms({ ...m, floor_strike: 60000 }).reason, 'STRIKE_FIELDS_DISAGREE_WITH_RULES');
  assert.equal(employmentTerms({ ...m, strike_type: 'between' }).reason, 'STRIKE_TYPE_NOT_GREATER');
  const u = mk('KXU3', 4.3);
  assert.equal(employmentTerms({ ...u, rules_primary: u.rules_primary.replace('seasonally adjusted ', '') }).reason, 'RULES_DISAGREE_WITH_SERIES');
  for (const a of kalshi.series.KXADP.events[0].markets) assert.equal(employmentTerms(a).ok, false);
});

test('employment-v0 is only reachable with every input explicit (its fabricated defaults cannot be used)', () => {
  const p = U3_FAMILIES.EMPLOYMENT_V0.fit([]);
  assert.equal(p({ v0_inputs: null }), null);
  assert.throws(() => p({ v0_inputs: { unemploymentRate: 4, priorUnemploymentRate: 4, payrollChangeK: 50, priorPayrollChangeK: 40, continuingClaimsM: 1.9 } }), /defaults are not allowed/);
  const ok = p({ v0_inputs: { unemploymentRate: 4, priorUnemploymentRate: 4, payrollChangeK: 50, priorPayrollChangeK: 40, initialClaimsK: 220, continuingClaimsM: 1.9 } });
  assert.ok(ok.probAbove(4.1) > 0 && ok.probAbove(4.1) < 1);
});

test('model-side strict ">" at exact strikes: P(U3 > t) and P(payrolls > t) exclude the strike bucket; scoring outcome is NO at equality', () => {
  // U-3 on the 0.1 grid
  const d = makeDistribution([4.2, 4.3, 4.4], [0.2, 0.5, 0.3]);
  assert.ok(Math.abs(d.probAbove(4.3) - 0.3) < 1e-12);
  assert.equal(scoreThresholds((t) => d.probAbove(t), 4.3, [4.3]).pairs[0].o, 0); // y == strike -> NO
  assert.equal(scoreThresholds((t) => d.probAbove(t), 4.4, [4.3]).pairs[0].o, 1);
  assert.ok(u3Ladder(4.3).includes(4.3) && u3Ladder(4.3).length === 13);
  // payrolls: 10k-person units, 0.1 step = 1,000 persons; +50,000 is 5.0
  assert.equal(toPayUnits(50), 5); assert.equal(toPayUnits(-25), -2.5); assert.equal(toPayUnits(-20500), -2050);
  const p = makeDistribution([4.9, 5.0, 5.1], [0.2, 0.5, 0.3]);
  assert.ok(Math.abs(p.probAbove(5.0) - 0.3) < 1e-12); // P(change > 50,000) excludes exactly 50,000
  assert.equal(scoreThresholds((t) => p.probAbove(t), toPayUnits(50), [5.0]).pairs[0].o, 0);
  assert.equal(scoreThresholds((t) => p.probAbove(t), toPayUnits(51), [5.0]).pairs[0].o, 1);
  assert.deepEqual([payLadder()[0], payLadder().at(-1), payLadder().length], [-10, 30, 17]); // -100k .. +300k
});

test('payroll model graph has no market feature; smuggled market fields change nothing', () => {
  const market = /price|bid|ask|mid|kalshi|market|venue|volume|interest|odds|implied/i;
  for (const k of [...PAY_FEATURES, ...PAY_CLAIMS_FEATURES]) assert.doesNotMatch(k, market, k);
  const train = Array.from({ length: 40 }, (_, i) => ({ target: { payroll_change_k: 100 + (i % 5) * 20 }, features: { PAY_L1: 100 + (i % 4) * 10, PAY_AVG3: 110, IC4_LOGCHG_REF: (i % 7) / 100, CC_LOGCHG_REF: (i % 5) / 100 } }));
  const f = PAY_FAMILIES.RIDGE_T_EWMA.fit(train);
  const base = { features: { PAY_L1: 120, PAY_AVG3: 110, IC4_LOGCHG_REF: 0.01, CC_LOGCHG_REF: 0.02 } };
  assert.deepEqual(f(base).mass, f({ ...base, features: { ...base.features, kalshi_mid: 0.9 }, yes_bid: 0.9 }).mass);
});

test('no hard-coded UTC offset in Employment code: Eastern time is resolved by named timezone only', () => {
  const dir = new URL('../src/macro/employment/', import.meta.url);
  for (const f of ['features.js', 'ledger.js', 'bls-empsit.js', 'dol-claims.js', 'models.js', 'employment-contract.js']) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /[-+]0[45]:00|UTC-?[45]|(?:4|5)\s*\*\s*3600|1[78]000000|14400000/, f);
  }
  const tl = readFileSync(new URL('../src/macro/cpi/timeline.js', import.meta.url), 'utf8');
  assert.match(tl, /America\/New_York/);
});

test('legacy Kalshi tickers map to the same series; the rules checks still fail closed', () => {
  assert.deepEqual(parseEmploymentTicker('U3-24MAY-T4.0'), { series: 'KXU3', ticker_prefix: 'U3', reference_month: '2024-05', ticker_strike: 4 });
  assert.equal(parseEmploymentTicker('PROLLS-23SEP-T150000').series, 'KXPAYROLLS');
  assert.equal(parseEmploymentTicker('PAYROLLS-24MAY-T175000').series, 'KXPAYROLLS');
  assert.equal(parseEmploymentTicker('ADP-24MAY-T175000'), null);
  const legacy = { ticker: 'U3-24MAY-T4.0', strike_type: 'greater', floor_strike: 4.0, rules_primary: 'If the seasonally adjusted unemployment rate (U-3) reported by the Bureau of Labor Statistics in the Employment Situation Report is above 4.0% in May 2024, then the market resolves to Yes.' };
  assert.ok(employmentTerms(legacy).ok);
  assert.equal(employmentTerms({ ...legacy, rules_primary: 'If the unemployment rate (U-3) is above 4.0% in May 2024 then the market resolves to Yes.' }).ok, false);
  assert.equal(employmentTerms({ ...legacy, floor_strike: 3.999999 }).reason, 'STRIKE_FIELDS_DISAGREE_WITH_RULES');
});
