// Kalshi PERPETUALS partner offer on Predictions (kalshi-partner/2, owner 2026-10-07): one module on /markets/ and one on
// /crypto/; nothing on event/contract pages (weather/macro contracts do not qualify); model + market rendering untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { partnerOffer } from '../kalshi-partner.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CFG = { contract: 'kalshi-partner/2', enabled: true, path: '/go/kalshi-perps', program: 'perpetuals',
  offer: { qualifying_volume: '$50', user_discount: '10%', user_discount_term: '3 months', pbe_revenue_share: '30%', pbe_revenue_term: '1 year', last_verified_at: '2026-10-07T23:45:00.000Z' } };
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

for (const [page, slot, placement] of [['markets/index.html', 'kxo-markets', 'predictions_markets'], ['crypto/index.html', 'kxo-crypto', 'predictions_crypto']]) {
  test(`${page}: one offer slot + module mount, first-party config, own placement`, () => {
    const h = read(page);
    assert.equal((h.match(new RegExp(`id="${slot}"`, 'g')) || []).length, 1);
    assert.equal((h.match(/partnerOffer\(/g) || []).length, 1);
    assert.match(h, new RegExp(`placement: '${placement}', product: 'predictions'`));
    assert.match(h, /loadPartnerConfig\('\/go\/kalshi-perps\/config'\)/);
    assert.match(h, /href="\/kalshi-offer\.css\?v=/);
    assert.ok(!h.includes('38800c96'), 'referral UUID is never in product HTML');
  });
}

test('crypto: the offer sits after the Robinhood price board, not inside the Kalshi event-contract panel', () => {
  const h = read('crypto/index.html');
  const slot = h.indexOf('id="kxo-crypto"');
  assert.ok(slot > h.indexOf('id="market-board"'));
  assert.ok(slot < h.indexOf('id="execution-lab"'));
  const kalshiPanel = h.slice(h.indexOf('cx-panel cx-market'), h.indexOf('cx-panel cx-rh'));
  assert.doesNotMatch(kalshiPanel, /kxo/);
});

test('module copy: $50 tied to Perps, 10% tied to fees for 3 months, rev-share disclosed, no prediction-market claim', () => {
  const t = text(partnerOffer(CFG, { placement: 'predictions_markets', product: 'predictions' }, { variant: 'module' }));
  assert.match(t, /KALSHI PERPETUALS Trade \$50 in Perps 10% Off Fees · First 3 Months/);
  assert.match(t, /NEW CUSTOMER OFFER →/);
  assert.match(t, /PropBetEdge may earn 30% of referred users' perpetuals trading fees for up to one year, subject to Kalshi terms\./);
  assert.match(t, /Offer eligibility and terms are determined by Kalshi\./);
  assert.doesNotMatch(t, /prediction[- ]market|event contract|sports?\b|deposit|spend \$|\$50 free/i);
});

test('event / contract pages carry no referral (Worker render path untouched)', () => {
  for (const f of ['workers/pbe-predictions/src/record-blocks.js', 'workers/pbe-predictions/src/pages.js', 'workers/pbe-predictions/src/index.js']) {
    assert.doesNotMatch(read(f), /partnerConfig|partnerCta|partnerOffer|kalshi-partner|kalshi-perps|kxo|kxp/, f);
  }
  assert.equal(existsSync(new URL('../workers/pbe-predictions/src/partner-config.js', import.meta.url)), false);
});

test('methodology + rewrites', () => {
  const m = read('methodology/index.html');
  assert.match(m, /Partner compensation does not affect PropBetEdge model probabilities, market comparisons, rankings, editorial conclusions, or research/);
  assert.match(m, /Kalshi Perpetuals/);
  const v = JSON.parse(read('vercel.json'));
  assert.deepEqual(v.rewrites.filter((r) => r.source.startsWith('/go/')), [
    { source: '/go/kalshi-perps', destination: 'https://propsports-markets.sales-fd3.workers.dev/go/kalshi-perps' },
    { source: '/go/kalshi-perps/config', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/partner/kalshi' },
  ]);
});
