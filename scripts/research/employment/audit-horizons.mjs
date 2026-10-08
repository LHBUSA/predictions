#!/usr/bin/env node
// Read-only horizon feasibility: verify frozen V1 source ledgers and archived
// Kalshi quotes at 1/3/7/14 days before the BLS release. No models are fit.
// Usage: node scripts/research/employment/audit-horizons.mjs <raw-kalshi-dir> [output.json]
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDaysYmd, etToUtcIso } from '../../../src/macro/cpi/timeline.js';
import { buildFeatureRow, claimsIndex } from '../../../src/macro/employment/features.js';
import { employmentTerms, yesOutcome } from '../../../src/macro/employment/employment-contract.js';
import { HORIZONS_DAYS, archivedWindow, quoteAt, binaryLogLoss, average, summarizePairedEventScores } from './market-horizon-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [rawArg, outArg] = process.argv.slice(2);
if (!rawArg) {
  console.error('usage: node scripts/research/employment/audit-horizons.mjs <raw-kalshi-dir> [output.json]');
  process.exit(2);
}
const rawDir = resolve(rawArg);
const read = (p) => readFileSync(p, 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const relPaths = [
  'data/employment/bls-empsit-releases-v1.json',
  'data/employment/bls-empsit-first-prints-v1.json',
  'data/employment/dol-claims-releases-v1.json',
];
const freeze = JSON.parse(read(join(root, 'data/employment/LEDGER_FREEZE.json')));
const sources = relPaths.map((p) => {
  const raw = read(join(root, p));
  if (freeze.files[p]?.sha256 !== sha256(raw)) throw new Error(`frozen employment ledger mismatch: ${p}`);
  return JSON.parse(raw);
});
const [releaseJson, firstJson, claimsJson] = sources;
const releases = releaseJson.releases;
const firstPrints = new Map(firstJson.months.map((m) => [m.reference_month, m]));
const claimsIdx = claimsIndex(claimsJson.records);
const releaseByMonth = new Map(releases.map((r) => [r.reference_month, r]));

// buildFeatureRow ordinarily computes T-1 using the release date. Shifting only
// a COPY of the date allows the frozen V1 feature-builder to enforce the exact
// original availability guards at earlier horizons. The real ledger is unchanged.
function featureAt(release, h) {
  const shiftedDate = addDaysYmd(release.release_date, 1 - h);
  const expectedCutoff = etToUtcIso(addDaysYmd(release.release_date, -h), 20, 0);
  const row = buildFeatureRow({
    month: release.reference_month,
    release: { ...release, release_date: shiftedDate }, releases, claimsIdx,
  });
  if (row.cutoff_at !== expectedCutoff) {
    throw new Error(`incorrect as-of horizon for ${release.reference_month} T-${h}`);
  }
  return { cutoff_at: expectedCutoff, u3: row.u3, payrolls: row.payroll,
    missing: { u3: row.u3.missing || {}, payrolls: row.payroll.missing || {} } };
}
const featureRows = new Map(releases.map((r) => [r.reference_month,
  Object.fromEntries(HORIZONS_DAYS.map((h) => [h, featureAt(r, h)]))]));

const manifestPath = join(rawDir, 'manifest.json');
const summaryPath = join(rawDir, 'summary.json');
if (!existsSync(manifestPath) || !existsSync(summaryPath)) throw new Error('missing original Kalshi research manifest.json or summary.json');
const manifestRaw = read(manifestPath);
const manifest = JSON.parse(manifestRaw);
const summary = JSON.parse(read(summaryPath));
const cache = new Map();
function archivedResponse(key) {
  if (cache.has(key)) return cache.get(key);
  const meta = manifest.responses?.[key];
  const filename = `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
  const path = join(rawDir, 'responses', filename);
  if (!meta || meta.status !== 200 || !existsSync(path)) {
    const result = { status: 'NO_ARCHIVED_RESPONSE', meta };
    cache.set(key, result);
    return result;
  }
  const contents = read(path);
  if (sha256(contents) !== meta.sha256) throw new Error(`Kalshi raw response hash mismatch: ${key}`);
  const result = { status: 'OK', meta, data: JSON.parse(contents) };
  cache.set(key, result);
  return result;
}

const events = [];
for (const entry of summary) {
  if (!['KXU3', 'KXPAYROLLS'].includes(entry.series) || !entry.month) continue;
  const release = releaseByMonth.get(entry.month);
  if (!release) continue;
  const fh = featureRows.get(entry.month);
  const outcomeRecord = firstPrints.get(entry.month);
  const first = entry.series === 'KXU3' ? outcomeRecord?.u3 : outcomeRecord?.payroll_change_k;
  const outcomeValue = first?.status === 'OK' ? first.value : null;
  const historic = archivedResponse(`hist_markets_${entry.event}`);
  const live = archivedResponse(`live_markets_${entry.event}`);
  const markets = historic.data?.markets?.length ? historic.data.markets : live.data?.markets || [];
  const rec = {
    event: entry.event, month: entry.month, series: entry.series,
    feature_status: Object.fromEntries(HORIZONS_DAYS.map((h) => [h, fh[h][entry.series === 'KXU3' ? 'u3' : 'payrolls'].status])),
    cutoff_at: Object.fromEntries(HORIZONS_DAYS.map((h) => [h, fh[h].cutoff_at])),
    outcome_status: first?.status || 'UNAVAILABLE',
    markets_archived: markets.length,
    terms_refused: {}, contracts: [],
  };
  const cut1 = Math.floor(Date.parse(fh[1].cutoff_at) / 1000);
  for (const market of markets) {
    const term = employmentTerms(market);
    if (!term.ok || term.series !== entry.series || term.reference_month !== entry.month) {
      const reason = term.ok ? 'SERIES_OR_MONTH_MISMATCH' : term.reason;
      rec.terms_refused[reason] = (rec.terms_refused[reason] || 0) + 1;
      continue;
    }
    const outcome = outcomeValue === null ? null : Number(yesOutcome(term, outcomeValue));
    const key = `candles_${market.ticker}_${cut1}`;
    const recorded = archivedResponse(key);
    const prices = {};
    for (const h of HORIZONS_DAYS) {
      const cutoffSeconds = Math.floor(Date.parse(fh[h].cutoff_at) / 1000);
      const coverage = archivedWindow(recorded.meta, cutoffSeconds);
      prices[h] = recorded.status !== 'OK' ? { status: 'NO_ARCHIVED_RESPONSE' }
        : !coverage.covered ? { status: coverage.reason }
          : quoteAt(recorded.data.candlesticks, cutoffSeconds);
    }
    rec.contracts.push({ ticker: market.ticker, strike: term.strike, outcome, prices });
  }
  events.push(rec);
}

function summarizeSeries(series) {
  const seriesEvents = events.filter((e) => e.series === series);
  const available = Object.fromEntries(HORIZONS_DAYS.map((h) => {
    const k = series === 'KXU3' ? 'u3' : 'payrolls';
    const missing = {};
    let rowsReady = 0;
    for (const row of featureRows.values()) {
      if (row[h][k].status === 'OK') rowsReady++;
      else for (const field of Object.keys(row[h].missing[k])) missing[field] = (missing[field] || 0) + 1;
    }
    return [h, { ledger_release_months: featureRows.size, feature_ready_months: rowsReady, missing_feature_counts: missing }];
  }));
  const byHorizon = Object.fromEntries(HORIZONS_DAYS.map((h) => {
    const status = {};
    const scored = [];
    let termsPassed = 0;
    for (const e of seriesEvents) {
      let valid = [];
      for (const c of e.contracts) {
        termsPassed++;
        status[c.prices[h].status] = (status[c.prices[h].status] || 0) + 1;
        if (c.prices[h].status === 'PRICED' && c.outcome !== null && e.feature_status[h] === 'OK') valid.push(c);
      }
      if (valid.length) scored.push({ event: e.event, n: valid.length,
        logLoss: average(valid.map((c) => binaryLogLoss(c.prices[h].mid, c.outcome))) });
    }
    return [h, { terms_passed_contracts: termsPassed, contract_quote_status: status,
      feature_eligible_priced_events: scored.length,
      feature_eligible_priced_contracts: scored.reduce((s, e) => s + e.n, 0),
      market_mean_event_log_loss: average(scored.map((e) => e.logLoss)) }];
  }));
  return { events_with_release_month: seriesEvents.length, feature_inventory: available,
    price_inventory: byHorizon,
    paired_T3_vs_T1_market_only: summarizePairedEventScores(seriesEvents, 3, 1) };
}
const result = {
  status: 'RESEARCH_ONLY',
  note: 'Market-only horizon and as-of feature feasibility; no model fit; descriptive, not a PASS or trading edge.',
  input_hashes: { ledger_freeze_sha256: sha256(read(join(root, 'data/employment/LEDGER_FREEZE.json'))),
    kalshi_manifest_sha256: sha256(manifestRaw) },
  freshness_max_age_hours: 2,
  horizons_calendar_days_before_release_at_20_et: HORIZONS_DAYS,
  series: { KXU3: summarizeSeries('KXU3'), KXPAYROLLS: summarizeSeries('KXPAYROLLS') },
};
const json = JSON.stringify(result, null, 2);
if (outArg) writeFileSync(resolve(outArg), json + '\n');
else process.stdout.write(json + '\n');