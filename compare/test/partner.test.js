// Kalshi PERPETUALS partner offer on Compare (kalshi-partner/2, owner 2026-10-07): ONE footer card for the page; never
// in the market drawer / beside a sports YES/NO price; "Open on Kalshi" links stay the canonical market URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { venuePrice, partnerOffer, PARTNER_DISABLED } from '../core.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const fx = (n) => JSON.parse(read(`./fixtures/${n}`));
const CFG = { contract: 'kalshi-partner/2', enabled: true, path: '/go/kalshi-perps', program: 'perpetuals',
  offer: { qualifying_volume: '$50', user_discount: '10%', user_discount_term: '3 months', pbe_revenue_share: '30%', pbe_revenue_term: '1 year', last_verified_at: '2026-10-07T23:45:00.000Z' } };
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

test('footer card: perps-specific copy, first-party route, sponsored, disclosed', () => {
  const html = partnerOffer(CFG, { placement: 'compare_footer', product: 'compare' }, { variant: 'footer' });
  assert.match(html, /href="\/go\/kalshi-perps\?placement=compare_footer&amp;product=compare"/);
  assert.match(html, /rel="sponsored noopener noreferrer"/);
  const t = text(html);
  assert.match(t, /NEW TO KALSHI\?/);
  assert.match(t, /trade \$50 in perpetual futures → receive 10% off fees for 3 months/);
  assert.match(t, /VIEW OFFER/);
  assert.match(t, /PropBetEdge may receive compensation from qualifying Kalshi referrals\. Offer eligibility and terms are determined by Kalshi\./);
  assert.doesNotMatch(t, /prediction|sports?\b|deposit|spend|free/i);
  assert.ok(!html.includes('kalshi.com'));
  assert.equal(partnerOffer(PARTNER_DISABLED, { placement: 'compare_footer' }, { variant: 'footer' }), '');
});

test('placement: exactly one offer mount, in the page footer, never in the drawer / market tiles', () => {
  const app = read('../app.js');
  const html = read('../index.html');
  assert.equal((app.match(/partnerOffer\(/g) || []).length, 1);
  assert.match(app, /placement: 'compare_footer'/);
  assert.doesNotMatch(app, /partnerLine|kxp/);
  const drawer = app.slice(app.indexOf('function renderDrawer()'), app.indexOf('function render()'));
  assert.doesNotMatch(drawer, /partner|kxo|go\/kalshi/i, 'drawer has no referral');
  assert.equal((html.match(/id="kxo-compare"/g) || []).length, 1);
  assert.ok(html.indexOf('id="kxo-compare"') > html.indexOf('<footer class="foot wrap">'), 'slot lives inside the footer');
  assert.match(html, /PropBetEdge participates in Kalshi's referral program/);
  assert.doesNotMatch(html, /not affiliated with either/);
});

test('canonical sports market links are untouched: exact desk market_url, no referral params, same drawer markup', () => {
  const raw = fx('desk-nba.json').events.flatMap((e) => e.contracts).flatMap((c) => c.venues || []).filter((v) => v.venue === 'kalshi' && v.market_url);
  assert.ok(raw.length);
  for (const v of raw) {
    assert.equal(venuePrice(v).market_url, v.market_url);
    assert.match(v.market_url, /^https:\/\/kalshi\.com\/markets\//);
    assert.doesNotMatch(v.market_url, /[?&](ref|partner|affiliate|referral)=|\/p\//);
  }
  assert.ok(read('../app.js').includes('href="${esc(v.market_url)}" target="_blank" rel="noopener nofollow">Open on ${VENUE[name].name} ↗</a>'));
});

test('vendored kalshi-partner.js identical in this repo (root static copy + compare copy)', () => {
  const h = (p) => createHash('sha256').update(readFileSync(new URL(p, import.meta.url))).digest('hex');
  assert.equal(h('../kalshi-partner.js'), h('../../kalshi-partner.js'));
});

test('vercel rewrites: fixed upstream paths only', () => {
  const v = JSON.parse(read('../vercel.json'));
  assert.deepEqual(v.rewrites, [
    { source: '/go/kalshi-perps', destination: 'https://propsports-markets.sales-fd3.workers.dev/go/kalshi-perps' },
    { source: '/go/kalshi-perps/config', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/partner/kalshi' },
  ]);
});
