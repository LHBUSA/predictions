import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildFeatures, FEATURES } from '../src/macro/cpi/features.js';
import { asOfView } from '../src/macro/cpi/asof.js';
import { FAMILIES, ridgeStudentEwma } from '../src/macro/cpi/models.js';
import { discretize, gaussianCdf, studentCdf, studentTCdf, GRID } from '../src/macro/cpi/distribution.js';
import { eventProbability, parseKalshiTicker, translateKalshiMarket } from '../src/macro/cpi/contracts.js';
import { predictFromArtifact } from '../src/macro/cpi/artifact.js';
import { etToUtcIso } from '../src/macro/cpi/timeline.js';
import { assertMarketFree, MARKET_KEY_PATTERN, VENUE_SOURCE_PATTERN } from '../src/engine/leakage.js';
import { buildDataset } from '../scripts/research/cpi/build-dataset.mjs';
import { runTarget, trainingRows, usableRows } from '../scripts/research/cpi/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const ledger = read('../data/cpi/bls-cpi-releases-v1.json');
const gas = read('../data/cpi/eia-gasoline-weekly-v1.json');
const dataset = read('../data/cpi/cpi-v1-dataset.json');
const releases = ledger.releases;

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

test('ledger: as-published values parse correctly across all archive formats', () => {
  const by = Object.fromEntries(releases.map((r) => [r.referenceMonth, r]));
  const pick = (m) => [by[m].series.headline.saMoM[m], by[m].series.headline.nsa12m, by[m].series.core.saMoM[m], by[m].series.core.nsa12m];
  assert.deepEqual(pick('2022-06'), [1.3, 9.1, 0.7, 5.9]); // html-table era
  assert.deepEqual(pick('2017-12'), [0.1, 2.1, 0.3, 1.8]); // pre-text era
  assert.deepEqual(pick('2008-01'), [0.4, 4.3, 0.3, 2.5]); // 2008 compound-rate layout
  assert.deepEqual(pick('2016-05'), [0.2, 1.0, 0.2, 2.2]); // PDF-only archive entry
  assert.equal(by['2025-10'], undefined, 'October 2025 CPI was never published');
  assert.equal(by['2025-11'].series.headline.saMoM['2025-11'], null, 'November 2025 SA m/m was not published');
  assert.equal(ledger.failures.length, 0);
  assert.equal(releases.length, 223);
  assert.equal(by['2022-06'].releaseAt, '2022-07-13T12:30:00.000Z');
  assert.equal(by['2017-12'].releaseAt, '2018-01-12T13:30:00.000Z'); // EST
});

test('timeline: Eastern wall clock converts across DST', () => {
  assert.equal(etToUtcIso('2026-01-13', 8, 30), '2026-01-13T13:30:00.000Z');
  assert.equal(etToUtcIso('2026-07-14', 8, 30), '2026-07-14T12:30:00.000Z');
  assert.equal(etToUtcIso('2026-03-08', 20, 0), '2026-03-09T00:00:00.000Z');
});

test('leakage: no feature input in the dataset is published after its cutoff', () => {
  let checked = 0;
  for (const o of dataset.observations) {
    const cutoff = Date.parse(o.cutoffAt);
    assert.ok(Date.parse(o.releaseAt) > cutoff, `${o.referenceMonth} ${o.horizon}: target release must be after cutoff`);
    // the first ledger month (2008-01) has no earlier release, hence no vintage
    if (o.vintage === null) assert.equal(o.referenceMonth, releases[0].referenceMonth);
    else assert.ok(Date.parse(o.vintagePublishedAt) <= cutoff);
    for (const [name, p] of Object.entries(o.provenance)) {
      for (const s of p.bls ?? []) {
        const publishedAt = s.split('|')[1];
        assert.ok(Date.parse(publishedAt) <= cutoff, `${o.referenceMonth} ${name} ${s}`);
        checked += 1;
      }
      if (p.eiaLastAvailableAt) {
        assert.ok(Date.parse(p.eiaLastAvailableAt) <= cutoff, `${o.referenceMonth} ${name} EIA`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 3000, `checked ${checked} inputs`);
});

test('leakage: later releases and later revisions cannot leak backward', () => {
  const referenceMonth = '2022-06';
  const target = releases.find((r) => r.referenceMonth === referenceMonth);
  const cutoffAt = etToUtcIso('2022-07-12', 20, 0);
  const base = buildFeatures({ releases, gasWeeks: gas.weeks, referenceMonth, cutoffAt });

  const poisoned = deepClone(releases);
  for (const r of poisoned) {
    if (Date.parse(r.releaseAt) <= Date.parse(cutoffAt)) continue;
    // later vintages revise every earlier month and add wild values
    for (const s of Object.values(r.series)) {
      for (const m of Object.keys(s.saMoM)) s.saMoM[m] = 99;
      s.saMoM['2022-05'] = -99;
      s.nsa12m = 99;
    }
  }
  const poisonedGas = gas.weeks.map((w) => (w.date > '2022-07-11' ? { ...w, price: 99 } : w));
  const after = buildFeatures({ releases: poisoned, gasWeeks: poisonedGas, referenceMonth, cutoffAt });
  assert.deepEqual(after.values, base.values);
  assert.equal(after.vintage, 'bls-cpi:2022-05');
  assert.ok(Date.parse(target.releaseAt) > Date.parse(cutoffAt));

  // positive control: changing the vintage that IS visible changes the features
  const visible = deepClone(releases);
  visible.find((r) => r.referenceMonth === '2022-05').series.core.saMoM['2022-05'] = 5;
  const changed = buildFeatures({ releases: visible, gasWeeks: gas.weeks, referenceMonth, cutoffAt });
  assert.notEqual(changed.values.C_L1, base.values.C_L1);
});

test('leakage: a cutoff after the target release is refused', () => {
  assert.throws(() => buildFeatures({ releases, gasWeeks: gas.weeks, referenceMonth: '2022-06', cutoffAt: '2022-07-13T12:30:00.000Z' }), /target would be visible/);
});

test('leakage: EIA weeks are visible only from date + 1 day 17:00 ET', () => {
  const view = asOfView({ releases, gasWeeks: gas.weeks, cutoffAt: etToUtcIso('2022-06-07', 16, 59) });
  assert.equal(view.gasWeeks[view.gasWeeks.length - 1].date, '2022-05-30');
  const later = asOfView({ releases, gasWeeks: gas.weeks, cutoffAt: etToUtcIso('2022-06-07', 17, 0) });
  assert.equal(later.gasWeeks[later.gasWeeks.length - 1].date, '2022-06-06');
});

test('no fake features: missing inputs are reported missing, never defaulted', () => {
  const o = dataset.observations.find((x) => x.referenceMonth === '2025-12' && x.horizon === 'T-1D');
  assert.ok(o.missingFeatures.H_L1, 'November 2025 m/m was never published');
  assert.equal(o.features.H_L1, undefined);
  for (const x of dataset.observations) {
    for (const k of Object.keys(x.missingFeatures)) assert.equal(x.features[k], undefined);
  }
});

test('market price is absent from the model feature graph', () => {
  for (const name of Object.keys(FEATURES)) assert.ok(!MARKET_KEY_PATTERN.test(name), name);
  for (const o of dataset.observations) assertMarketFree(o.features);
  const sources = new Set(dataset.observations.flatMap((o) => Object.values(o.provenance).flatMap((p) => [...(p.bls ?? []), ...(p.eiaWeeks ? ['eia_weekly_retail_gasoline'] : [])])));
  for (const s of sources) assert.ok(!VENUE_SOURCE_PATTERN.test(s), s);
  for (const f of ['asof.js', 'features.js', 'models.js', 'distribution.js']) {
    const src = readFileSync(new URL(`../src/macro/cpi/${f}`, import.meta.url), 'utf8');
    assert.ok(!/from '.*(contracts|kalshi|market|venue|polymarket)/i.test(src), `${f} must not import market code`);
  }
});

test('chronological folds: training rows were released before the forecast cutoff', () => {
  const { rows } = runTarget(dataset.observations, 'core_yoy', 'T-1D', { only: 'PERSISTENCE_GAUSS' });
  assert.ok(rows.length > 150);
  for (const r of rows) assert.ok(r.trainLast < r.referenceMonth, `${r.trainLast} < ${r.referenceMonth}`);
  const all = usableRows(dataset.observations, 'core_yoy', 'T-1D');
  for (const row of all.slice(40, 60)) {
    for (const t of trainingRows(all, row)) assert.ok(Date.parse(t.releaseAt) <= Date.parse(row.cutoffAt));
    assert.ok(!trainingRows(all, row).includes(row));
  }
});

test('randomized labels destroy skill', () => {
  const real = runTarget(dataset.observations, 'headline_mom', 'T-1D', { only: 'RIDGE_T_EWMA' }).rows;
  const mean = (rs, n) => rs.reduce((s, r) => s + r.scores[n].brier, 0) / rs.length;
  const clim = runTarget(dataset.observations, 'headline_mom', 'T-1D', { only: 'CLIMATOLOGY' }).rows;
  const realBrier = mean(real, 'RIDGE_T_EWMA');
  for (const seed of [11, 23]) {
    const perm = runTarget(dataset.observations, 'headline_mom', 'T-1D', { permuteSeed: seed }).rows;
    const permBrier = mean(perm, 'RIDGE_T_EWMA');
    assert.ok(permBrier > realBrier * 1.25, `permuted ${permBrier} vs real ${realBrier}`);
    assert.ok(permBrier > mean(clim, 'CLIMATOLOGY') - 0.005, 'permuted model must not beat climatology');
  }
});

test('distribution: threshold, range and exact probabilities are coherent and monotonic', () => {
  for (const dist of [discretize(studentCdf(0.27, 0.18, 5), GRID.mom), discretize(gaussianCdf(3.3, 0.2), GRID.yoy)]) {
    const total = dist.mass.reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    let prev = 1;
    for (const k of dist.support) {
      const p = dist.probAbove(k);
      assert.ok(p <= prev + 1e-12, `P(>${k}) not monotonic`);
      assert.ok(Math.abs(p + dist.cdfAt(k) - 1) < 1e-9);
      assert.ok(Math.abs(dist.probBelow(k) + dist.probExact(k) + p - 1) < 1e-9);
      prev = p;
    }
    const lo = dist.support[20];
    const hi = dist.support[25];
    let sum = 0;
    for (let i = 20; i <= 25; i += 1) sum += dist.probExact(dist.support[i]);
    assert.ok(Math.abs(dist.probRange(lo, hi) - sum) < 1e-9);
  }
  assert.ok(Math.abs(studentTCdf(2.015, 5) - 0.95) < 1e-3);
  assert.ok(Math.abs(studentTCdf(0, 5) - 0.5) < 1e-12);
});

test('contract adapter translates Kalshi semantics without touching the model', () => {
  assert.deepEqual(parseKalshiTicker('KXCPIYOY-26DEC-T3.0'), { series: 'KXCPIYOY', referenceMonth: '2026-12' });
  const m = translateKalshiMarket({ ticker: 'KXCPI-26OCT-T0.3', strike_type: 'greater', floor_strike: 0.3 });
  assert.deepEqual(m, { status: 'SUPPORTED', target: 'headline_mom', referenceMonth: '2026-10', event: { kind: 'above', threshold: 0.3 } });
  assert.equal(translateKalshiMarket({ ticker: 'KXCPI-26OCT-T0.25', strike_type: 'greater', floor_strike: 0.25 }).status, 'UNSUPPORTED');
  assert.equal(translateKalshiMarket({ ticker: 'KXGDP-26Q3-T2', strike_type: 'greater', floor_strike: 2 }).status, 'UNSUPPORTED');
  const dist = discretize(studentCdf(0.27, 0.18, 5), GRID.mom);
  // ladder probabilities from one distribution are non-increasing in the strike
  const ladder = [-0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5].map((t) => eventProbability(dist, translateKalshiMarket({ ticker: `KXCPI-26OCT-T${t}`, strike_type: 'greater', floor_strike: t }).event));
  for (let i = 1; i < ladder.length; i += 1) assert.ok(ladder[i] <= ladder[i - 1]);
});

test('reproducibility: identical inputs produce identical dataset, fits and predictions', () => {
  const a = buildDataset({ releases, gasWeeks: gas.weeks });
  const b = buildDataset({ releases: deepClone(releases), gasWeeks: deepClone(gas.weeks) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.observations.length, dataset.observationCount);
  assert.equal(JSON.stringify(a.observations), JSON.stringify(dataset.observations), 'committed dataset must match a rebuild from the committed sources');
  const rows = usableRows(dataset.observations, 'headline_yoy', 'T-1D');
  const train = rows.slice(0, 120);
  const p1 = FAMILIES.RIDGE_T_EWMA.fit(train, 'headline_yoy')(rows[130]);
  const p2 = FAMILIES.RIDGE_T_EWMA.fit(deepClone(train), 'headline_yoy')(deepClone(rows[130]));
  assert.deepEqual([...p1.mass], [...p2.mass]);
});

test('frozen artifact reproduces its fit and stays market-free', { skip: !existsSync(new URL('../src/macro/artifacts/cpi-v1.json', import.meta.url)) }, () => {
  const artifact = read('../src/macro/artifacts/cpi-v1.json');
  assert.equal(artifact.marketInputs, 'NONE');
  for (const [target, spec] of Object.entries(artifact.targets)) {
    const rows = usableRows(dataset.observations, target, 'T-1D');
    assert.equal(rows.length, spec.trainingWindow.n);
    const refit = ridgeStudentEwma(rows, target, spec.features);
    const last = rows[rows.length - 1];
    const fromArtifact = predictFromArtifact(artifact, target, last.features).distribution;
    const fromRefit = refit(last);
    for (let i = 0; i < fromRefit.mass.length; i += 1) assert.ok(Math.abs(fromRefit.mass[i] - fromArtifact.mass[i]) < 1e-9);
    for (const n of spec.features) assert.ok(!MARKET_KEY_PATTERN.test(n));
  }
});
