// #79 explorer QA: real Chrome over the static page; /api/market-catalog answered from a SYNTHETIC fixture (never shipped)
// that implements the market-catalog/1 query semantics (venue, category, status, search, cursor). Fails loudly.
//   node scripts/qa/all-markets-qa.mjs [--out <dir>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', join(tmpdir(), 'pbe-allmkts-qa')); mkdirSync(OUT, { recursive: true });
const fails = []; const fail = (m) => { fails.push(m); console.log('FAIL', m); };

// ---------- synthetic catalog (120 markets, both venues, all categories) ----------
const CATS = ['weather', 'politics', 'economics', 'crypto', 'commodities', 'business', 'space-tech', 'geopolitics', 'culture', 'science', 'health', 'other'];
const NOW = Date.now();
const MARKETS = Array.from({ length: 120 }, (_, i) => {
  const venue = i % 3 === 0 ? 'polymarket' : 'kalshi'; const cat = CATS[i % CATS.length];
  return { _synthetic: true, id: `${venue}:SYN-${i}`, venue, market_id: venue === 'kalshi' ? `KXSYN-26OCT-${i}` : `0xsyn${i}`, event_id: `SYN-E${i >> 1}`, series_id: 'KXSYN',
    event_title: `Synthetic ${cat} question number ${i} with a deliberately long title that must wrap without overflowing on a phone`, title: `Outcome ${i}`, outcome_label: `Outcome ${i}`,
    category: cat, category_native: cat, status: 'OPEN', close_time: new Date(NOW + (i + 1) * 3600e3).toISOString(), open_time: null,
    quote: venue === 'polymarket' && i % 2 ? { units: 'probability_0_1', yes_bid: null, yes_ask: null, last: null, outcomes: [{ label: 'Yes', price: 0.42 }, { label: 'No', price: 0.58 }], change_24h: -0.02, observed_at: new Date(NOW - 300e3).toISOString(), source_updated_at: null, tier: 'sweep' }
      : { units: 'probability_0_1', yes_bid: 0.31, yes_ask: 0.33, last: 0.32, outcomes: null, change_24h: 0.031, observed_at: new Date(NOW - 90e3).toISOString(), source_updated_at: null, tier: i < 10 ? 'hot' : 'sweep' },
    volume_24h: 1000 * (120 - i), volume: 50000, liquidity: null, open_interest: venue === 'kalshi' ? 4200 : null,
    url: venue === 'kalshi' ? `https://kalshi.com/markets/kxsyn/syn/kxsyn-${i}` : `https://polymarket.com/event/syn-${i}`, first_observed_at: new Date(NOW - 86400e3).toISOString() };
});
const VEN = { complete: { kalshi: { display: true, state: 'COMPLETE', indexed_events: 40, indexed_markets: 80, last_full_sync_at: new Date(NOW - 600e3).toISOString(), last_quote_sync_at: new Date(NOW - 60e3).toISOString(), sweep: { in_progress: false }, coverage: { basis: 'full cursor walk', complete: true, excluded: {} }, error: null },
  polymarket: { display: true, state: 'COMPLETE', indexed_events: 20, indexed_markets: 40, last_full_sync_at: new Date(NOW - 900e3).toISOString(), last_quote_sync_at: new Date(NOW - 60e3).toISOString(), sweep: { in_progress: false }, coverage: { basis: 'full cursor walk', complete: true, excluded: {} }, error: null } },
  partial: { kalshi: { display: true, state: 'BUILDING', indexed_events: 0, indexed_markets: 0, last_full_sync_at: null, last_quote_sync_at: null, sweep: { in_progress: true, phase: 'markets', pages_done: 41, started_at: new Date(NOW - 600e3).toISOString() }, coverage: { complete: false }, error: null },
    polymarket: { display: false, state: 'DISABLED', indexed_events: 0, indexed_markets: 0, last_full_sync_at: null, last_quote_sync_at: null, sweep: null, coverage: { complete: false }, error: null } } };
function answer(u, mode) {
  const q = u.searchParams; const venue = q.get('venue') || 'all'; const cat = q.get('category'); const search = (q.get('search') || '').toLowerCase();
  const venues = VEN[mode];
  let rows = MARKETS.filter((m) => (venue === 'all' || m.venue === venue) && venues[m.venue].display !== false && venues[m.venue].state !== 'BUILDING');
  if (search) rows = rows.filter((m) => `${m.event_title} ${m.title} ${m.market_id}`.toLowerCase().includes(search));
  const categories = Object.fromEntries(CATS.map((c) => [c, { label: c, count: rows.filter((m) => m.category === c).length }]));
  if (cat) rows = rows.filter((m) => m.category === cat);
  const limit = Number(q.get('limit') || 50); const start = Number(q.get('cursor') || 0);
  const page = rows.slice(start, start + limit);
  return { schema: 'market-catalog/1', generated_at: new Date().toISOString(), query: {}, total: rows.length, returned: page.length, has_next: start + limit < rows.length, next_cursor: start + limit < rows.length ? String(start + limit) : null, categories, venues, markets: page };
}

const { server, origin } = await startServer();
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: join(OUT, 'profile'), args: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  let mode = 'complete'; let calls = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin || !u.pathname.startsWith('/api/')) return r.continue();
    if (u.pathname === '/api/market-catalog') { calls.push(u.search); return mode === 'down' ? r.respond({ status: 503, body: '{}' }) : r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(answer(u, mode)) }); }
    return r.respond({ status: 404, contentType: 'application/json', body: '{}' });
  });
  page.on('pageerror', (e) => fail(`pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|404|503/.test(m.text())) fail(`console ${m.text()}`); });
  const ready = () => page.waitForFunction(() => ['ready', 'unavailable'].includes(document.getElementById('am-app')?.dataset.state), { timeout: 10000 });
  const go = async (w, q = '') => { await page.setViewport({ width: w, height: 900 }); await page.goto(`${origin}/all-markets/${q}`, { waitUntil: 'networkidle2' }); await ready(); };
  const info = () => page.evaluate(() => ({ o: document.documentElement.scrollWidth - document.documentElement.clientWidth, cov: document.querySelector('.am-cov-h')?.textContent, rows: document.querySelectorAll('.am-row').length,
    ids: [...document.querySelectorAll('.am-id')].map((x) => x.textContent), load: !!document.getElementById('am-load'), title: document.title, empty: document.querySelector('.am-empty')?.textContent || null,
    links: [...document.querySelectorAll('.am-link')].map((a) => a.href), state: document.getElementById('am-app').dataset.state }));

  // 1) complete catalog at every width: no overflow, labelled ALL, 50 rows, load more
  for (const w of [320, 360, 390, 430, 768, 1024, 1440]) {
    await go(w); const r = await info();
    if (r.o > 0) fail(`@${w} horizontal overflow ${r.o}`);
    if (r.cov !== 'ALL NON-SPORTS MARKETS') fail(`@${w} complete label = ${r.cov}`);
    if (r.rows !== 50 || !r.load) fail(`@${w} first page rows=${r.rows} load=${r.load}`);
    if (!r.links.every((h) => /^https:\/\/(kalshi\.com|polymarket\.com)\//.test(h))) fail(`@${w} non-venue link`);
    if ([390, 1440].includes(w)) { await page.bringToFront(); await page.screenshot({ path: join(OUT, `all-${w}.png`), fullPage: true }); }
  }
  // 2) paging: 120 rows over 3 pages, no duplicates, no further load button
  await go(1440); await page.click('#am-load'); await page.waitForFunction(() => document.querySelectorAll('.am-row').length === 100); await page.click('#am-load'); await page.waitForFunction(() => document.querySelectorAll('.am-row').length === 120);
  let r = await info(); if (new Set(r.ids).size !== 120 || r.load) fail(`paging ids=${new Set(r.ids).size} load=${r.load}`);
  // 3) venue tab + keyboard, category, search, URL state
  await go(1440); await page.focus('[data-venue="all"]'); await page.keyboard.press('ArrowRight'); await ready(); await page.waitForFunction(() => location.search.includes('venue=kalshi'));
  r = await info(); if (r.ids.some((id) => id.startsWith('0x'))) fail('kalshi tab shows polymarket rows');
  await page.click('[data-category="politics"]'); await page.waitForFunction(() => location.search.includes('category=politics'));
  await page.type('#am-q', 'number 13'); await page.waitForFunction(() => location.search.includes('q=number+13'), { timeout: 5000 }).catch(() => fail('search not applied'));
  await new Promise((s) => setTimeout(s, 400)); r = await info(); if (r.rows !== 1 || !r.ids[0].includes('13')) fail(`search rows=${r.rows} ${r.ids}`);
  // 4) partial: Kalshi BUILDING + Polymarket DISABLED -> never "ALL", explicit states, no rows, honest empty text
  mode = 'partial'; await go(390); r = await info();
  if (r.cov !== 'PARTIAL CATALOG' || /^All Non-Sports/.test(r.title)) fail(`partial label ${r.cov} / ${r.title}`);
  const txt = await page.$eval('.am-coverage', (e) => e.textContent);
  if (!/Building first index · markets · 41 pages/.test(txt) || !/Paused · display disabled/.test(txt)) fail(`partial states missing: ${txt}`);
  if (r.rows !== 0 || !/No venue index is available yet/.test(r.empty || '')) fail(`partial rows=${r.rows} empty=${r.empty}`);
  await page.bringToFront(); await page.screenshot({ path: join(OUT, 'partial-390.png'), fullPage: true });
  // 5) backend down: unavailable, no rows
  mode = 'down'; await go(390); r = await info(); if (r.state !== 'unavailable' || r.rows !== 0) fail(`down state=${r.state} rows=${r.rows}`);
  // 6) dark theme render
  mode = 'complete'; await go(1440); await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await page.bringToFront(); await page.screenshot({ path: join(OUT, 'all-1440-dark.png') });
} finally { await browser.close(); server.close(); }
console.log(`screens: ${OUT}`);
if (fails.length) { console.log(`${fails.length} FAILURE(S)`); process.exit(1); }
console.log('all-markets QA PASS');
