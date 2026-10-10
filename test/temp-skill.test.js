import test from 'node:test';
import assert from 'node:assert/strict';
import { orderBuckets, bucketIndexOf, eventScores, modalIndex, poissonBinomial, hitTail, clusterBootstrap, marketDistribution, temperatureSkillSummary } from '../src/weather/temp-skill.js';

const ladder = [
  { comparator: 'greater', threshold_low: 87 }, { comparator: 'between', threshold_low: 82, threshold_high: 83 },
  { comparator: 'less', threshold_high: 80 }, { comparator: 'between', threshold_low: 80, threshold_high: 81 },
  { comparator: 'between', threshold_low: 84, threshold_high: 85 }, { comparator: 'between', threshold_low: 86, threshold_high: 87 },
];

test('an exhaustive Kalshi ladder orders low -> high and partitions the integers', () => {
  const o = orderBuckets(ladder);
  assert.equal(o.ok, true);
  assert.deepEqual(o.ranges, [[-Infinity, 79], [80, 81], [82, 83], [84, 85], [86, 87], [88, Infinity]]);
  assert.equal(bucketIndexOf(o.ranges, 79), 0); assert.equal(bucketIndexOf(o.ranges, 88), 5); assert.equal(bucketIndexOf(o.ranges, 83), 2);
});

test('a missing tail or a gap makes the event ineligible (never silently scored)', () => {
  assert.equal(orderBuckets(ladder.filter((c) => c.comparator !== 'greater')).reason, 'MISSING_TAIL');
  assert.equal(orderBuckets(ladder.filter((c) => c.threshold_low !== 84)).reason, 'PARTITION_GAP_OR_OVERLAP');
  assert.equal(orderBuckets([...ladder.slice(0, 5), { comparator: 'between', threshold_low: null, threshold_high: 1 }]).reason, 'UNPARSEABLE_BUCKET');
});

test('event scores renormalise, pick the lower bucket on ties and score the whole distribution', () => {
  const s = eventScores([0.1, 0.4, 0.4, 0.1], 2);
  assert.equal(s.modal, 1); assert.equal(s.hit, 0); assert.equal(s.p_modal, 0.4);
  assert.ok(Math.abs(s.log_loss + Math.log(0.4)) < 1e-12);
  assert.ok(Math.abs(s.brier - (0.01 + 0.16 + 0.36 + 0.01)) < 1e-12);
  const r = eventScores([0.2, 0.4, 0.4, 0.2], 0); // sums to 1.2 -> renormalised
  assert.ok(Math.abs(r.p_win - 0.2 / 1.2) < 1e-12); assert.equal(r.raw_sum, 1.2);
  assert.equal(eventScores([0.5, null], 0), null); assert.equal(eventScores([0.5, 0.5], 2), null);
  assert.equal(modalIndex([null, 0.2, 0.2]), 1);
});

test('RPS charges a far miss more than a near miss', () => {
  const near = eventScores([0, 1, 0, 0], 2).rps; const far = eventScores([0, 1, 0, 0], 3).rps;
  assert.ok(far > near && near > 0);
});

test('expected top-bucket hits are the sum of chosen probabilities; Poisson-binomial tail is exact', () => {
  const d = poissonBinomial([0.5, 0.5]);
  assert.deepEqual(d, [0.25, 0.5, 0.25]);
  const t = hitTail([0.5, 0.5], 1); assert.equal(t.p_at_most, 0.75); assert.equal(t.p_at_least, 0.75);
  assert.ok(Math.abs(poissonBinomial(Array(42).fill(0.38)).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('cluster bootstrap resamples whole clusters and is deterministic', () => {
  const items = [{ cluster: 'd1', a: 1, b: 0 }, { cluster: 'd1', a: 1, b: 0 }, { cluster: 'd2', a: 0, b: 0 }];
  const r = clusterBootstrap(items, { boot: 500 });
  assert.equal(r.clusters, 2); assert.equal(r.n, 3); assert.ok(Math.abs(r.diff - 2 / 3) < 1e-12);
  assert.deepEqual(r, clusterBootstrap(items, { boot: 500 }));
  assert.ok(r.ci[0] >= 0 && r.ci[1] <= 1);
});

test('market distribution: mids, no-bid tails at half the ask, otherwise unavailable', () => {
  assert.deepEqual(marketDistribution([{ mid: 0.5 }, { bid: null, ask: 0.01 }]), { probs: [0.5, 0.005], approximated_tails: 1 });
  assert.equal(marketDistribution([{ mid: 0.5 }, { bid: 0.2, ask: 0.6 }]), null);
  assert.equal(marketDistribution([{ mid: 0.5 }, { bid: null, ask: 0.3 }]), null);
});

test('summary separates PBE-only counts from the market-paired subset', () => {
  const ev = [
    { date: 'd1', station: 'A', pbe: eventScores([0.6, 0.4], 0), market: eventScores([0.2, 0.8], 0) },
    { date: 'd2', station: 'B', pbe: eventScores([0.3, 0.7], 0), market: null },
  ];
  const s = temperatureSkillSummary(ev, { boot: 200 });
  assert.equal(s.events, 2); assert.equal(s.top_bucket.hits, 1); assert.ok(Math.abs(s.top_bucket.expected - 1.3) < 1e-12);
  assert.equal(s.market_paired.events, 1); assert.equal(s.market_paired.market_hits, 0); assert.equal(s.market_paired.pbe_hits, 1);
});
