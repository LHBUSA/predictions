// Builds the dated Strategy Arena security classification snapshot from SEC EDGAR (no licence fee, U.S. government data).
//   node scripts/signal10/arena/build-classification.mjs [--effective YYYY-MM-DD]
// Members: the latest fja05680/sp500 row (same source as the V1 forward lane). For each member: ticker -> CIK
// (sec.gov/files/company_tickers.json) -> SIC (data.sec.gov/submissions/CIK##########.json) -> PBE sector (taxonomy.js).
// Writes data/signal10/arena/classification.json with every source sha256. A snapshot is never edited: a refresh is a new
// file version with a later effective date (the old one stays in git history and its hash stays in the ledger).
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadComponents } from '../../../src/signal10/universe.js';
import { resolveSymbol } from '../../../src/signal10/aliases.js';
import { COMPONENTS_URL } from '../../../src/signal10/forward.js';
import { TAXONOMY_VERSION, sectorOfSic, isTechSic } from '../../../src/signal10/arena/taxonomy.js';

const UA = 'PropBetEdge Predictions research https://predictions.propbetedge.ai/methodology/';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

async function get(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json,text/csv' } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch { /* transient network error: retry */ }
    await sleep(1500 * (a + 1));
  }
  throw new Error(`fetch failed ${url}`);
}

const csv = await get(COMPONENTS_URL);
const members = loadComponents(csv).at(-1);
const tickersJson = await get('https://www.sec.gov/files/company_tickers.json');
const byTicker = new Map(Object.values(JSON.parse(tickersJson)).map((x) => [x.ticker.toUpperCase(), x]));
const effective = arg('--effective') || new Date().toISOString().slice(0, 10);

const rows = {}; const missing = [];
for (const t of [...members.tickers].sort()) {
  const sym = resolveSymbol(t, effective) || t;
  const cand = [t, sym].flatMap((x) => [x, x.replace(/\./g, '-'), x.replace(/-/g, '.')]).map((x) => x.toUpperCase());
  const hit = cand.map((c) => byTicker.get(c)).find(Boolean);
  if (!hit) { missing.push(t); rows[t] = { symbol: sym, cik: null, sic: null, sector: 'UNCLASSIFIED', tech: false, reason: 'ticker_not_in_sec_company_tickers' }; continue; }
  const cik = String(hit.cik_str).padStart(10, '0');
  const body = await get(`https://data.sec.gov/submissions/CIK${cik}.json`);
  await sleep(130); // SEC fair-access: < 10 requests/second
  const j = body ? JSON.parse(body) : null;
  const sic = j?.sic ? String(j.sic) : null;
  rows[t] = { symbol: sym, cik, name: j?.name || hit.title, sic, sic_description: j?.sicDescription || null, sector: sic ? sectorOfSic(sic) : 'UNCLASSIFIED', tech: !!sic && isTechSic(sic),
    submissions_sha256: body ? sha(body) : null };
  if (!sic) rows[t].reason = 'no_sic_in_submissions';
}

const out = {
  taxonomy: TAXONOMY_VERSION, effective_from: effective, built_at: new Date().toISOString(),
  sources: {
    members: { url: COMPONENTS_URL, row_date: members.date, count: members.tickers.length, sha256: sha(csv), licence: 'MIT (fja05680/sp500)' },
    sec_company_tickers: { url: 'https://www.sec.gov/files/company_tickers.json', sha256: sha(tickersJson), licence: 'U.S. government work (SEC EDGAR)' },
    sec_submissions: 'https://data.sec.gov/submissions/CIK##########.json (per-row sha256)',
  },
  counts: { members: members.tickers.length, classified: Object.values(rows).filter((r) => r.sector !== 'UNCLASSIFIED').length, tech: Object.values(rows).filter((r) => r.tech).length, missing: missing.length },
  rows,
};
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
out.content_sha256 = sha(canonical({ taxonomy: out.taxonomy, effective_from: out.effective_from, rows: out.rows }));
mkdirSync('data/signal10/arena', { recursive: true });
writeFileSync('data/signal10/arena/classification.json', JSON.stringify(out, null, 1) + '\n');
const bySector = {}; for (const r of Object.values(rows)) bySector[r.sector] = (bySector[r.sector] || 0) + 1;
console.log(JSON.stringify({ ...out.counts, bySector, missing, content_sha256: out.content_sha256 }, null, 1));
