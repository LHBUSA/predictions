// Fed decision engine (SHADOW). Live inputs = official daily H.15 series (FRED public CSV, keyless), the
// official FOMC calendar and the target-range history. Same feature construction as scripts/research/fed-train.mjs.
import fedArtifact from './artifacts/fed-v1.json' with { type: 'json' };
import registry from '../../data/fomc/scheduled-decisions.json' with { type: 'json' };
import { predictFed, parseFredCsv, valueAsOf, targetMidAsOf } from './fed-model.js';
import { buildFeatureVector, assertModelInput, assertContractTermsOnly } from '../engine/leakage.js';

export const FED_MODEL = Object.freeze({ id: fedArtifact.model_id, version: fedArtifact.version, state: 'SHADOW' });
export const FRED_CSV = (id, cosd) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}${cosd ? `&cosd=${cosd}` : ''}`;
export const FED_INPUT_SERIES = ['DGS6MO', 'DFEDTARU', 'DFEDTARL'];
export const FED_CONTEXT_SERIES = ['CPIAUCSL', 'CPILFESL', 'UNRATE', 'PAYEMS'];

const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const pct = (p) => Math.round(p * 100);

export async function fetchFredSeries(ids, { fetchImpl = globalThis.fetch, userAgent, since }) {
  const out = {};
  for (const id of ids) {
    const url = FRED_CSV(id, since);
    const res = await fetchImpl(url, { headers: { accept: 'text/csv', 'user-agent': userAgent } });
    if (!res.ok) throw new Error(`FRED ${id} ${res.status}`);
    out[id] = { url, rows: parseFredCsv(await res.text()) };
  }
  return out;
}

// Previous scheduled meeting and its decision, from the calendar + the live target series (never from Kalshi).
export function previousDecision(meetingDate, upper, today) {
  const prior = registry.meetings.filter((m) => m.meetingDate < meetingDate).at(-1);
  if (!prior || prior.meetingDate >= today) return null;
  const before = valueAsOf(upper, shift(prior.meetingDate, -1));
  const after = valueAsOf(upper, shift(prior.meetingDate, 2));
  if (!before || !after || after.date <= prior.meetingDate) return null;
  return { meetingDate: prior.meetingDate, changeBps: Math.round((after.value - before.value) * 100) };
}

function yoy(rows) {
  const last = rows.at(-1);
  if (!last) return null;
  const [y, m] = last[0].split('-').map(Number);
  const prior = rows.find((r) => r[0] === `${y - 1}-${String(m).padStart(2, '0')}-01`);
  return prior ? { date: last[0], value: ((last[1] / prior[1]) - 1) * 100 } : null;
}

// sources: { fred: {DGS6MO, DFEDTARU, DFEDTARL, ...context}, capturedAt }
export function forecastFed(contract, sources, { now }) {
  assertContractTermsOnly(contract); // leakage guard: a contract reaches the model as terms only, never with a venue price
  if (contract.event_type !== 'FOMC_DECISION_BUCKET') return { status: 'UNSUPPORTED_EVENT_TYPE' };
  if (Date.parse(now) >= Date.parse(contract.observation_start)) return { status: 'WINDOW_STARTED' };
  const today = now.slice(0, 10);
  const meetingDate = contract.detail.meeting_date;
  const horizonDays = Math.round((Date.parse(`${meetingDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (horizonDays < 1 || horizonDays > 35) return { status: 'HORIZON_OUT_OF_RANGE' };
  const f = sources.fred;
  const legacy = [];
  const upper = f.DFEDTARU.rows; const lower = f.DFEDTARL.rows; const cmt6 = f.DGS6MO.rows;
  const prev = previousDecision(meetingDate, upper, today);
  if (!prev) return { status: 'NOT_NEXT_MEETING' }; // the meeting before this one has not been decided yet
  const asOf = today;
  const base = shift(prev.meetingDate, 2);
  const spreadAt = (d) => { const b = valueAsOf(cmt6, d); const mid = targetMidAsOf({ legacy, upper, lower }, d); return b && mid ? { v: b.value - mid.value, b, mid } : null; };
  const nowS = spreadAt(asOf); const baseS = spreadAt(base);
  if (!nowS || !baseS) return { status: 'INCOMPLETE_INPUTS' };
  const src = (id) => ({ sourceClass: 'official', provider: 'Federal Reserve H.15 via FRED', sourceId: `fred:${id}@${f[id].rows.at(-1)[0]}`, observationKey: sources.observationKeys?.[id] ?? null });
  const { features, featureSources } = buildFeatureVector([
    { name: 'cmt6m_change_since_last_decision', value: +(nowS.v - baseS.v).toFixed(4), source: src('DGS6MO') },
    { name: 'cmt6m_minus_target_mid', value: +nowS.v.toFixed(4), source: src('DGS6MO') },
    { name: 'previous_decision_direction', value: Math.sign(prev.changeBps), source: src('DFEDTARU') },
    { name: 'horizon_days', value: horizonDays, source: { sourceClass: 'official', provider: 'Federal Reserve FOMC calendar', sourceId: `fomc-calendar:${meetingDate}` } },
  ]);
  const dist = predictFed(fedArtifact, assertModelInput({ d6: features.cmt6m_change_since_last_decision, c6: features.cmt6m_minus_target_mid, prev: features.previous_decision_direction, horizonDays }));
  const outcome = contract.detail.outcome;
  const cpi = f.CPIAUCSL ? yoy(f.CPIAUCSL.rows) : null;
  const core = f.CPILFESL ? yoy(f.CPILFESL.rows) : null;
  const un = f.UNRATE?.rows.at(-1) ?? null;
  const pay = f.PAYEMS?.rows.length >= 2 ? { date: f.PAYEMS.rows.at(-1)[0], value: f.PAYEMS.rows.at(-1)[1] - f.PAYEMS.rows.at(-2)[1] } : null;
  const ho = fedArtifact.holdout.metrics;
  const evidence = [
    { label: 'Current target range', value: `${(nowS.mid.lower ?? nowS.mid.value).toFixed(2)}-${(nowS.mid.upper ?? nowS.mid.value).toFixed(2)}`, unit: '%', detail: `as of ${nowS.mid.date}` },
    { label: '6-month Treasury yield minus target midpoint', value: +(nowS.v * 100).toFixed(0), unit: ' bps', detail: `6-month CMT ${nowS.b.value.toFixed(2)}% on ${nowS.b.date}` },
    { label: 'Change since the last decision', value: +((nowS.v - baseS.v) * 100).toFixed(0), unit: ' bps', detail: `since ${prev.meetingDate}` },
    { label: 'Previous decision', value: prev.changeBps > 0 ? `+${prev.changeBps}` : String(prev.changeBps), unit: ' bps', detail: `FOMC ${prev.meetingDate}` },
    { label: 'PBE distribution', value: `cut>25 ${pct(dist.cut_gt_25)} / cut25 ${pct(dist.cut_25)} / hold ${pct(dist.hold)} / hike25 ${pct(dist.hike_25)} / hike>25 ${pct(dist.hike_gt_25)}`, unit: '%', detail: 'one distribution across the five Kalshi buckets' },
    ...(core ? [{ label: 'Core CPI, 12-month (context, not a model input)', value: +core.value.toFixed(1), unit: '%', detail: `through ${core.date.slice(0, 7)}` }] : []),
    ...(cpi ? [{ label: 'Headline CPI, 12-month (context)', value: +cpi.value.toFixed(1), unit: '%', detail: `through ${cpi.date.slice(0, 7)}` }] : []),
    ...(un ? [{ label: 'Unemployment rate (context)', value: un[1], unit: '%', detail: `${un[0].slice(0, 7)}` }] : []),
    ...(pay ? [{ label: 'Payrolls, monthly change (context)', value: Math.round(pay.value), unit: 'k', detail: `${pay.date.slice(0, 7)}` }] : []),
  ];
  const provenance = [
    ...FED_INPUT_SERIES.map((id) => ({ source: `FRED ${id}`, provider: 'Board of Governors of the Federal Reserve System (H.15) via FRED', url: f[id].url, latest_value_date: f[id].rows.at(-1)[0], role: 'model input' })),
    { source: 'FOMC meeting calendar', provider: 'federalreserve.gov', url: contract.detail.calendar_source, role: 'model input (meeting date, previous decision)' },
    ...FED_CONTEXT_SERIES.filter((id) => f[id]).map((id) => ({ source: `FRED ${id}`, provider: 'BLS via FRED (latest vintage at capture)', url: f[id].url, latest_value_date: f[id].rows.at(-1)[0], role: 'context (not a model input)' })),
    { source: 'Contract resolution', provider: contract.resolution_authority, dataset: contract.resolution_dataset, verification: contract.verification_dataset, role: 'resolution' },
  ];
  const latestInputDate = [cmt6.at(-1)[0], upper.at(-1)[0], lower.at(-1)[0]].sort().at(-1);
  return {
    status: 'OK', model: FED_MODEL, features, featureSources,
    probability: Math.round(dist[outcome] * 100) / 100, rawProbability: dist[outcome], distribution: dist,
    confidence: 'LOW', evidence, provenance,
    explanation: { distribution: dist, outcome, quality_rules: 'fed-quality/1: LOW while v1 holdout top-outcome accuracy is below an always-hold baseline', holdout: ho, artifact_version: fedArtifact.version },
    dataCutoffAt: new Date(Math.min(Date.parse(now), Date.parse(`${shift(latestInputDate, 1)}T23:59:59Z`))).toISOString(),
    inputs: { latest_input_date: latestInputDate, previous_meeting: prev.meetingDate },
  };
}
