// Build the normalized Signal 10 dataset from immutable raw captures + coverage report.
// node scripts/signal10/build-dataset.mjs --cutoff 2026-10-08 [--cache E:/Workers/cache/signal10]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseYahooChart } from '../../src/signal10/data.js';
import { loadComponents, membersOn, universeTickers } from '../../src/signal10/universe.js';
import { resolveSymbol, SYMBOL_ALIASES, DATED_ALIASES, BLOCKED_SYMBOLS } from '../../src/signal10/aliases.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', process.env.SIGNAL10_CACHE || 'E:/Workers/cache/signal10');
const CUTOFF = arg('--cutoff');
if (!CUTOFF) throw new Error('--cutoff YYYY-MM-DD (last COMPLETE session) is required');

const manifest = fs.readFileSync(path.join(CACHE, 'raw/yahoo-manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const latest = new Map();
for (const m of manifest) if (m.status === 200) latest.set(m.yahoo_symbol, m); // later lines win
const series = {};
const sources = {};
for (const [ys, m] of latest) {
  const raw = fs.readFileSync(path.join(CACHE, 'raw/yahoo', m.file));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (sha !== m.sha256) throw new Error(`raw capture hash mismatch: ${m.file}`);
  const s = parseYahooChart(JSON.parse(raw), { cutoffDate: CUTOFF });
  if (!s || !s.bars.length) continue;
  const sym = ys.replace(/-/g, '.');
  series[sym] = s;
  sources[sym] = { file: m.file, sha256: m.sha256, retrieved_at: m.retrieved_at, url: m.url };
}
const compsCsv = fs.readFileSync(path.join(CACHE, 'raw/universe/components.csv'), 'utf8');
const comps = loadComponents(compsCsv);
const calendar = series.SPY.bars.map((b) => b.d);

// coverage: member-days with a bar on that session, per year
const byYear = {};
const uncovered = new Map();
for (const d of calendar) {
  if (d < '2016-01-01') continue;
  const row = membersOn(comps, d);
  const y = d.slice(0, 4);
  byYear[y] ||= { member_days: 0, covered: 0 };
  for (const t of row.tickers) {
    byYear[y].member_days++;
    const rs = resolveSymbol(t, d); const s = rs && series[rs];
    const has = s && s._idx ? s._idx.has(d) : (s && (s._idx = new Set(s.bars.map((b) => b.d))).has(d));
    if (has) byYear[y].covered++; else uncovered.set(t, (uncovered.get(t) || 0) + 1);
  }
}
for (const s of Object.values(series)) delete s._idx;
for (const y of Object.values(byYear)) y.pct = Math.round((y.covered / y.member_days) * 10000) / 100;

const dataset = {
  schema: 'signal10-dataset/1', cutoff: CUTOFF, built_at: new Date().toISOString(),
  universe_source: { name: 'fja05680/sp500 S&P 500 Historical Components & Changes (Updated).csv', license: 'MIT',
    sha256: crypto.createHash('sha256').update(compsCsv).digest('hex'), last_row: comps.at(-1).date },
  price_source: 'Yahoo Finance chart API v8 (daily OHLCV + split/dividend events), unofficial public endpoint',
  aliases: SYMBOL_ALIASES, dated_aliases: DATED_ALIASES, blocked: [...BLOCKED_SYMBOLS], calendar, series, sources
};
const body = JSON.stringify(dataset);
const hash = crypto.createHash('sha256').update(body).digest('hex');
fs.writeFileSync(path.join(CACHE, `dataset-${CUTOFF}.json`), body);
const coverage = {
  cutoff: CUTOFF, dataset_sha256: hash, symbols_with_data: Object.keys(series).length,
  universe_tickers_2016: universeTickers(comps, '2016-01-01').length, by_year: byYear,
  uncovered_member_days: [...uncovered.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ ticker: t, member_days: n })),
  parse_issues: Object.fromEntries(Object.entries(series).filter(([, s]) => s.issues.length).map(([k, s]) => [k, s.issues.length]))
};
fs.writeFileSync(path.join(CACHE, `coverage-${CUTOFF}.json`), JSON.stringify(coverage, null, 1));
console.log(JSON.stringify({ hash, symbols: coverage.symbols_with_data, by_year: byYear, uncovered: coverage.uncovered_member_days.length }, null, 1));
