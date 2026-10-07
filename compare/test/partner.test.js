// Kalshi partner CTA in the Compare drawer (kalshi-partner/1, owner brief 2026-10-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeEvent, scoreIndex, partnerLine, venuePrice, PARTNER_DISABLED } from '../core.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const idx = scoreIndex(fx('live-board.json').items);
const CFG = { contract: 'kalshi-partner/1', enabled: true, path: '/go/kalshi' };
const nba = fx('desk-nba.json').events.map((e) => normalizeEvent({ ...e, sport: 'nba', lane: 'nba' }, idx));
const priced = nba.find((e) => e.contracts.some((c) => c.kalshi?.market_url && c.kalshi.mid_bp != null));

test('drawer: one partner line per event, first-party route only, sponsored + disclosure', () => {
  assert.ok(priced, 'fixture has a priced Kalshi event');
  const html = partnerLine(priced, CFG, '', '/');
  assert.equal((html.match(/<a /g) || []).length, 1, 'exactly one CTA per drawer');
  assert.match(html, /href="\/go\/kalshi\?placement=compare_drawer&amp;sport=nba&amp;event=\d+&amp;page=%2F"/);
  assert.match(html, /rel="sponsored noopener noreferrer"/);
  assert.match(html, /New to Kalshi\? Get started/);
  assert.match(html, /may receive compensation for eligible new Kalshi customers/);
  assert.doesNotMatch(html, /kalshi\.com|\$\d/);
});

test('drawer: focused contract id travels as an aggregate dimension', () => {
  const c = priced.contracts.find((x) => x.kalshi?.market_url);
  const html = partnerLine(priced, CFG, c.id, '/');
  assert.ok(html.includes(`contract=${encodeURIComponent(c.id).replace(/%20/g, '+')}`), html);
});

test('drawer: missing / disabled config and Kalshi-less events render nothing', () => {
  assert.equal(partnerLine(priced, PARTNER_DISABLED), '');
  assert.equal(partnerLine(priced, null), '');
  const noK = { ...priced, contracts: priced.contracts.map((c) => ({ ...c, kalshi: null })) };
  assert.equal(partnerLine(noK, CFG), '');
});

test('canonical market link is untouched: venuePrice keeps the exact desk market_url', () => {
  const raw = fx('desk-nba.json').events.flatMap((e) => e.contracts).flatMap((c) => c.venues || []).filter((v) => v.venue === 'kalshi' && v.market_url);
  assert.ok(raw.length);
  for (const v of raw) {
    assert.equal(venuePrice(v).market_url, v.market_url);
    assert.doesNotMatch(v.market_url, /[?&](ref|partner|affiliate|referral)=/);
  }
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('href="${esc(v.market_url)}" target="_blank" rel="noopener nofollow">Open on ${VENUE[name].name} ↗</a>'), 'Open on Kalshi link unchanged');
  assert.equal((app.match(/partnerLine\(/g) || []).length, 1, 'partner line rendered in exactly one place');
});

test('vendored kalshi-partner.js is the canonical copy (both copies in this repo identical)', () => {
  const a = readFileSync(new URL('../kalshi-partner.js', import.meta.url));
  const b = readFileSync(new URL('../../workers/pbe-predictions/src/vendor/kalshi-partner.js', import.meta.url));
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
});

test('vercel rewrites: fixed upstream paths only', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(v.rewrites, [
    { source: '/go/kalshi', destination: 'https://propsports-markets.sales-fd3.workers.dev/go/kalshi' },
    { source: '/go/kalshi/config', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/partner/kalshi' },
  ]);
});
