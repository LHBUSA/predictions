// Commodity-specific research pages: canonical routes, source rights, independent metadata and shared API.
// Node's pure module import exercises the exact browser decision logic without a price source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteHeader, siteFooter } from '../workers/pbe-predictions/src/network.js';
import { METAL_ETFS, SPOT } from '../src/market-tape/metals.js';
import { METAL_PAGES, metalDetail, quotePresentation, displaySession } from '../commodities/metal-detail.js';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const q = (slug, { sourceOk = true, spotCleared = false } = {}) => {
  const c = METAL_PAGES[slug], i = METAL_ETFS.find((x) => x.symbol === c.etf);
  const s = SPOT.find((x) => x.code === c.code);
  return { contract: 'metals/1', audience: 'public',
    rights: { spot: { state: spotCleared ? 'CLEARED' : 'SOURCE_RIGHTS_HOLD', note: 'No verified spot licence' },
      etf: { state: sourceOk ? 'CLEARED' : 'SOURCE_RIGHTS_HOLD' } },
    spot: [{ ...s, quote: { unit: 'USD/ozt', currency: 'USD', state: spotCleared ? 'OBSERVED' : 'SOURCE_RIGHTS_HOLD', value: 9876, observed_at: '2026-10-09T19:00:00Z', source: 'Test provider' } }],
    etfs: [{ ...i, quote: { unit: 'USD/share', currency: 'USD', state: 'NEXT_DAY', rights_scope: 'PUBLIC', source: 'IEX Historical Data (TOPS)',
      value: 232.44, observed_at: '2026-10-09T19:59:00Z', session_date: '2026-10-09', previous: { value: 230, session_date: '2026-10-08' }, change_pct: 232.44 / 230 - 1 } }] };
};
test('each metal has an individually indexed canonical research page and shared, current network shell', () => {
  for (const [slug, c] of Object.entries(METAL_PAGES)) {
    const html = read('commodities/' + slug + '/index.html');
    assert.match(html, new RegExp('https://predictions\\.propbetedge\\.ai/commodities/' + slug + '/'));
    assert.match(html, /<meta name="robots" content="index,follow">/);
    assert.match(html, new RegExp('data-metal="' + slug + '"'));
    assert.ok(html.includes('href="/commodities/' + slug + '/" aria-current="page"'));
    assert.ok(html.includes('href="/markets/metals/"'), 'overview navigation');
    assert.ok(html.includes('href="/markets/signal-10/arena/"'), 'arena connection');
    assert.ok(html.includes('/commodities/metal-detail.js?v='), 'single data client');
    assert.ok(html.includes('<!-- network:header -->'), 'shared header marker');
    assert.ok(html.includes(siteHeader('metals', { live: false })), 'canonical shared nav');
    assert.ok(html.includes(siteFooter()), 'canonical shared footer');
    assert.match(html, /QUOTE UNAVAILABLE/);
    assert.doesNotMatch(html, /real.time spot price|guaranteed hedge/i);
    assert.match(html, new RegExp(c.code + '/USD'));
    assert.match(html, new RegExp(c.etf));
  }
});
test('metal selection requires exact registry identity and shared metals/1 contract', () => {
  for (const [slug,c] of Object.entries(METAL_PAGES)) {
    const m = metalDetail(q(slug), slug);
    assert.equal(m.spot.code, c.code); assert.equal(m.etf.symbol, c.etf);
    assert.equal(m.etf.metal, c.metal);
    assert.equal(m.spot.kind, 'SPOT');
  }
  assert.equal(metalDetail({ ...q('gold'), contract: 'metals/0' }, 'gold'), null);
  assert.equal(metalDetail(q('silver'), 'gold'), null);
  assert.equal(metalDetail(q('gold'), 'copper'), null);
});
test('notional spot quotes never leak when display rights remain on hold', () => {
  const z = quotePresentation(q('gold'), 'gold');
  assert.equal(z.spot.price, '—'); assert.match(z.spot.status, /SOURCE RIGHTS HOLD/);
  assert.equal(z.spot.observed, null);
  const v = quotePresentation(q('gold',{spotCleared:true}), 'gold');
  assert.equal(v.spot.price, '$9,876.00');
  const bad = q('gold',{spotCleared:true}); delete bad.spot[0].quote.source;
  assert.equal(quotePresentation(bad,'gold').spot.price,'—');
});
test('ETF value shown only for entitled IEX T+1 venue observation and valid session', () => {
  const valid = quotePresentation(q('platinum'), 'platinum').etf;
  assert.equal(valid.price, '$232.44');
  assert.match(valid.status,/IEX NEXT-DAY/);
  assert.match(valid.change,/Oct 8, 2026/);
  const b1 = q('platinum',{sourceOk:false}); assert.equal(quotePresentation(b1,'platinum').etf.price,'—');
  const b2 = q('platinum'); b2.etfs[0].quote.rights_scope = null; assert.equal(quotePresentation(b2,'platinum').etf.price,'—');
  const b3 = q('platinum'); b3.etfs[0].quote.source = 'Yahoo Finance'; assert.equal(quotePresentation(b3,'platinum').etf.price,'—');
  const b4 = q('platinum'); b4.etfs[0].quote.session_date = null; assert.equal(quotePresentation(b4,'platinum').etf.price,'—');
  const b5 = q('platinum'); b5.etfs[0].quote.state = 'AWAITING_FIRST_OBSERVATION'; assert.equal(quotePresentation(b5,'platinum').etf.price,'—');
  const b6 = q('platinum'); b6.etfs[0].quote.value = null; assert.equal(quotePresentation(b6,'platinum').etf.price,'—');
});
test('no member allocation is exposed to anonymous viewers; date formatting is deterministic', () => {
  const d = q('silver'); d.diversified_sleeve = { holdings: [{ symbol:'SLV',weight:0.1 }] };
  assert.equal(quotePresentation(d,'silver').sleeve,null);
  d.audience='member';d.etfs[0].quote.rights_scope='PAID';
  assert.deepEqual(quotePresentation(d,'silver').sleeve,d.diversified_sleeve);
  assert.equal(displaySession('2026-10-09'),'Oct 9, 2026');
  assert.equal(displaySession(''),'—');
});
test('overview keeps all three directly navigable metal research destinations', () => {
  const overview = read('markets/metals/index.html');
  for(const slug of Object.keys(METAL_PAGES)) assert.ok(overview.includes('href="/commodities/'+slug+'/"'));
  const js = read('markets/metals/metals.js');
  assert.match(js,/commodities\/\$\{METAL\[x\.metal\]\}/);
  // These pages add NO new Worker, quote provider, subscription, domain routing or cron.
  for(const slug of Object.keys(METAL_PAGES)) assert.doesNotMatch(read('commodities/'+slug+'/index.html'),/https:\/\/[^" ]*(?:api\.yahoo|data\.cme|resend\.com)/i);
});
