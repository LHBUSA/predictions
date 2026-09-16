import { createPredictionSnapshot } from '../domain.js';

export const FED_DECISION_MODEL = Object.freeze({
  id: 'fed-decision-baseline',
  version: '0.1.0',
  status: 'research',
  outcomes: Object.freeze(['cut_gt_25', 'cut_25', 'hold', 'hike_25', 'hike_gt_25'])
});

const DEFAULTS = Object.freeze({
  inflationTarget: 2.0,
  longRunUnemployment: 4.2,
  coreInflationWeight: 1.0,
  headlineInflationWeight: 0.35,
  unemploymentGapWeight: 0.65,
  unemploymentMomentumWeight: 0.8,
  holdBias: 1.15,
  largeMovePenalty: 1.8,
  temperature: 1.0
});

function finite(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be a finite number`);
  return n;
}

function softmax(logits, temperature = 1) {
  const t = Math.max(0.05, finite(temperature, 'temperature'));
  const scaled = logits.map((x) => x / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

export function policyPressure(features, config = {}) {
  const p = { ...DEFAULTS, ...config };
  const core = finite(features.coreInflationYoY, 'coreInflationYoY');
  const headline = finite(features.headlineInflationYoY, 'headlineInflationYoY');
  const unemployment = finite(features.unemploymentRate, 'unemploymentRate');
  const unemploymentChange3m = finite(features.unemploymentChange3m ?? 0, 'unemploymentChange3m');

  const inflationPressure =
    p.coreInflationWeight * (core - p.inflationTarget) +
    p.headlineInflationWeight * (headline - p.inflationTarget);

  const laborCooling =
    p.unemploymentGapWeight * (unemployment - p.longRunUnemployment) +
    p.unemploymentMomentumWeight * unemploymentChange3m;

  return Object.freeze({
    score: inflationPressure - laborCooling,
    inflationPressure,
    laborCooling,
    assumptions: Object.freeze({
      inflationTarget: p.inflationTarget,
      longRunUnemployment: p.longRunUnemployment
    })
  });
}

export function fedDecisionProbabilities(features, config = {}) {
  const p = { ...DEFAULTS, ...config };
  const pressure = policyPressure(features, p);
  const x = pressure.score;

  // v0 deliberately favors ordinary 25bp moves over >25bp moves.
  // These logits are research priors, not calibrated production parameters.
  const logits = [
    -x - p.largeMovePenalty,
    -x,
    p.holdBias - Math.abs(x),
    x,
    x - p.largeMovePenalty
  ];
  const probabilities = softmax(logits, p.temperature);

  return Object.freeze({
    modelId: FED_DECISION_MODEL.id,
    modelVersion: FED_DECISION_MODEL.version,
    pressure,
    probabilities: Object.freeze(Object.fromEntries(
      FED_DECISION_MODEL.outcomes.map((outcome, i) => [outcome, probabilities[i]])
    ))
  });
}

export function classifyFedContract(title = '') {
  const text = String(title).toLowerCase().replace(/\s+/g, ' ');
  if (/cut.*(more than|>|greater than).*25|cut.*50|decrease.*(more than|>|greater than).*25/.test(text)) return 'cut_gt_25';
  if (/cut.*25|decrease.*25/.test(text)) return 'cut_25';
  if (/maintain|no change|hold|unchanged/.test(text)) return 'hold';
  if (/hike.*(more than|>|greater than).*25|hike.*50|increase.*(more than|>|greater than).*25/.test(text)) return 'hike_gt_25';
  if (/hike.*25|increase.*25/.test(text)) return 'hike_25';
  return null;
}

export function buildFedPredictionSnapshots({ eventId, markets, features, capturedAt, featureSnapshotId, provenance = [], config = {} }) {
  if (!eventId) throw new TypeError('eventId is required');
  if (!Array.isArray(markets)) throw new TypeError('markets must be an array');
  if (!capturedAt) throw new TypeError('capturedAt is required');

  const result = fedDecisionProbabilities(features, config);

  return markets.flatMap((market) => {
    const outcome = classifyFedContract(market.title);
    if (!outcome) return [];
    const modelProbability = result.probabilities[outcome];

    return [createPredictionSnapshot({
      id: `${eventId}:${market.marketId}:${FED_DECISION_MODEL.version}:${capturedAt}`,
      eventId: `${eventId}:${market.marketId}`,
      modelId: FED_DECISION_MODEL.id,
      modelVersion: FED_DECISION_MODEL.version,
      capturedAt,
      modelProbability,
      marketProbability: market.impliedProbability ?? null,
      confidence: 'research-baseline',
      featureSnapshotId: featureSnapshotId ?? null,
      explanation: {
        outcome,
        policyPressure: result.pressure.score,
        inflationPressure: result.pressure.inflationPressure,
        laborCooling: result.pressure.laborCooling,
        note: 'Uncalibrated baseline model. Preserve and score; do not present as validated edge.'
      },
      provenance,
      metadata: {
        venue: market.venue,
        marketId: market.marketId,
        modelStatus: FED_DECISION_MODEL.status
      }
    })];
  });
}
