// #79 All Non-Sports Markets explorer: honest coverage labels, prices exactly as supplied, stable cursor merging, URL
// state, venue-only links, page wiring (nav, rewrite before the Worker catch-all, sitemap, footer, homepage, desk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../all-markets/explorer-core.js';
import { siteHeader, siteFooter, NETWORK } from '../workers/pbe-predictions/src/network.js';
import { sitemapXml } from '../workers/pbe-predictions/src/pages.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const V = (state, extra = {}) => ({ display: true, state, indexed_markets: 100, coverage: { complete: state === 'COMPLETE' }, ...extra });

test('coverage: "ALL" only when every displayed venue is COMPLETE; any BUILDING / DISABLED / missing venue = PARTIAL CATALOG', () => {
  assert.equal(C.coverage({ kalshi: V('COMPLETE'), polymarket: V('COMPLETE') }).label, 'ALL NON-SPORTS MARKETS');
  for (const venues of [{ kalshi: V('COMPLETE'), polymarket: V('BUILDING') }, { kalshi: V('COMPLETE'), polymarket: { ...V('COMPLETE'), display: false } },
    { kalshi: V('COMPLETE') }, { kalshi: V('PARTIAL'), polymarket: V('COMPLETE') }, { kalshi: V('DEGRADED'), polymarket: V('COMPLETE') }, {}]) {
    const c = C.coverage(venues);
    assert.equal(c.complete, false); assert.equal(c.label, 'PARTIAL CATALOG');
  }
  // COMPLETE state without coverage.complete is not complete
  assert.equal(C.coverage({ kalshi: { display: true, state: 'COMPLETE', coverage: { complete: false } } }, 'kalshi').complete, false);
  assert.equal(C.coverage({ kalshi: V('COMPLETE') }, 'kalshi').label, 'ALL KALSHI NON-SPORTS MARKETS');
  const dis = C.coverage({ kalshi: V('COMPLETE'), polymarket: { ...V('COMPLETE'), display: false } }).rows[1];
  assert.equal(dis.state, 'DISABLED'); assert.equal(C.stateText(dis), 'Paused · display disabled'); assert.equal(dis.contributes, false);
  assert.match(C.stateText({ state: 'BUILDING', sweep: { in_progress: true, phase: 'markets', pages_done: 41 } }), /Building first index · markets · 41 pages/);
});

test('prices: shown exactly as the venue supplied them (probability -> %), never converted across YES/NO or outcomes', () => {
  assert.deepEqual(C.priceView({ last: 0.82, yes_bid: 0.81, yes_ask: 0.83 }), { kind: 'yes', text: '82%', detail: 'bid 81% · ask 83%' });
  assert.deepEqual(C.priceView({ last: null, yes_bid: 0.4, yes_ask: 0.45 }), { kind: 'yes', text: '40%–45%', detail: 'bid–ask' });
  const o = C.priceView({ outcomes: [{ label: 'Yes', price: 0.42 }, { label: 'No', price: 0.58 }] });
  assert.equal(o.kind, 'outcomes'); assert.deepEqual(o.items.map((x) => x.text), ['42%', '58%']);
  assert.equal(C.priceView({}).kind, 'none'); assert.equal(C.priceView(null).kind, 'none');
  assert.equal(C.pct(0.004), '<1%'); assert.equal(C.pct(0.996), '>99%'); assert.equal(C.pct(null), '—');
  assert.equal(C.signedPts(0.031), '+3.1 pts'); assert.equal(C.signedPts(-0.02), '−2 pts');
  assert.equal(C.freshness({ observed_at: new Date(Date.now() - 120000).toISOString(), tier: 'sweep' }), 'as of last sweep 2 min ago');
  assert.equal(C.freshness({}), null, 'no observation time = no freshness claim');
});

test('cursor paging merges without duplicates; URL state round-trips; API query carries only allowed params', () => {
  const a = [{ id: 'k:1' }, { id: 'k:2' }]; const m = C.mergeRows(a, [{ id: 'k:2' }, { id: 'p:3' }]);
  assert.deepEqual(m.map((r) => r.id), ['k:1', 'k:2', 'p:3']);
  const s = C.stateFromSearch('?venue=polymarket&category=politics&status=closing&sort=volume24h&q=fed%20rate&evil=1&venue2=x');
  assert.deepEqual(s, { venue: 'polymarket', category: 'politics', status: 'closing', sort: 'volume24h', search: 'fed rate' });
  assert.equal(C.searchFromState(s), '?venue=polymarket&category=politics&status=closing&sort=volume24h&q=fed+rate');
  assert.deepEqual(C.stateFromSearch('?venue=binance&category=sports&sort=x'), { venue: 'all', category: null, status: 'open', sort: 'closing', search: '' });
  assert.equal(C.apiQuery(s, 'abc'), '/api/market-catalog?venue=polymarket&status=closing&sort=volume24h&limit=50&category=politics&search=fed+rate&cursor=abc');
});

test('links: only plain venue market pages (never a referral or another host)', () => {
  assert.equal(C.venueLink({ url: 'https://kalshi.com/markets/kxfed/x' }), 'https://kalshi.com/markets/kxfed/x');
  assert.equal(C.venueLink({ url: 'https://polymarket.com/event/x' }), 'https://polymarket.com/event/x');
  assert.equal(C.venueLink({ url: 'https://evil.example/kalshi.com/' }), null);
  assert.equal(C.venueLink({ url: 'javascript:alert(1)' }), null);
});

test('page wiring: nav entry + current state, rewrites ahead of the Worker catch-all, sitemap, footer, homepage, desk', () => {
  const keys = NETWORK.product.map((p) => p[2]);
  assert.equal(keys.indexOf('allmarkets'), keys.indexOf('desk') + 1);
  assert.ok(keys.includes('metals'), '#77 Metals entry kept');
  const html = read('all-markets/index.html');
  assert.equal((html.match(/href="\/all-markets\/" aria-current="page"/g) || []).length, 2, 'nav + strip');
  assert.match(html, /<link rel="canonical" href="https:\/\/predictions\.propbetedge\.ai\/all-markets\/">/);
  assert.match(html, /<script type="module" src="\/all-markets\/explorer\.js\?v=/);
  assert.doesNotMatch(html.match(/<main[\s\S]*?<\/main>/)[0], /\d+(\.\d+)?%/, 'no price in static HTML');
  const rw = JSON.parse(read('vercel.json')).rewrites.map((r) => r.source);
  assert.ok(rw.indexOf('/api/market-catalog') >= 0 && rw.indexOf('/api/market-catalog') < rw.indexOf('/api/:path*'), 'catalog rewrite precedes /api/:path*');
  assert.ok(rw.indexOf('/api/market-catalog/health') < rw.indexOf('/api/:path*'));
  assert.match(JSON.parse(read('vercel.json')).rewrites.find((r) => r.source === '/api/market-catalog').destination, /propsports-markets\.sales-fd3\.workers\.dev\/v1\/market-catalog$/);
  assert.ok(sitemapXml([]).includes('/all-markets/</loc>'));
  assert.ok(siteFooter().includes('href="/all-markets/"'));
  assert.match(read('index.html'), /class="allmkts-link" href="\/all-markets\/"/);
  assert.match(read('desk/index.html'), /href="\/all-markets\/">All Markets<\/a>/);
  assert.match(siteHeader('overview'), /href="\/all-markets\/"><svg class="nav-ic"/);
});
