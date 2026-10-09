// Information architecture (issue #50, 2026-10-09): overview homepage + dedicated /desk/, /track-record/, /calendar/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuredForMember, featuredForPreview, comparableHeadline, pulseFromPreview, latestInsight } from '../workers/pbe-predictions/src/featured.js';
import { limitRows } from '../workers/pbe-predictions/src/results-board.js';
import { siteHeader, NETWORK } from '../workers/pbe-predictions/src/network.js';
import { sitemapXml } from '../workers/pbe-predictions/src/pages.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PAGES = { '/': 'index.html', '/desk/': 'desk/index.html', '/track-record/': 'track-record/index.html', '/calendar/': 'calendar/index.html', '/models/': 'models/index.html', '/methodology/': 'methodology/index.html', '/crypto/': 'crypto/index.html' };

// a desk event whose headline is a comparable model-vs-market pair (same contract, fresh Kalshi quote)
const cmpEv = (id, d, { pbe = 50, close = '2026-10-10T00:00:00Z', fresh = 'live' } = {}) => ({ url: `/events/${id}`, close_time: close,
  headline: { pbe_pct: pbe, market_pct: pbe - d, divergence_pts: d, venues: { kalshi: { mid_pct: pbe - d, freshness: fresh, divergence: { pts: d } } } } });

test('member featured = the three largest |divergence| among COMPARABLE events only; events pass through unchanged', () => {
  const desk = { generated_at: 'g', events: [cmpEv('a', 3), cmpEv('b', -40), cmpEv('c', 12), cmpEv('d', 25), { url: '/events/nomodel', headline: { pbe_pct: null, divergence_pts: null } }, cmpEv('e', 30, { fresh: 'stale' })] };
  const f = featuredForMember(desk);
  assert.equal(f.audience, 'member');
  assert.deepEqual(f.events.map((e) => e.url), ['/events/b', '/events/d', '/events/c'], 'a stale quote is never ranked as a gap');
  assert.equal(f.comparable_count, 4);
  assert.equal(f.events[0], desk.events[1], 'same object: no field added, removed or recomputed');
  assert.deepEqual(f.watch, []);
});

test('featured eligibility (owner P0): null/missing headline, rule mismatch, mismatched delta, out-of-range values are never gaps; 0% is a real value', () => {
  const noVenue = { url: '/events/novenue', close_time: '2026-10-10T00:00:00Z', headline: { pbe_pct: 60, market_pct: 40, divergence_pts: 20, venues: { kalshi: null } } };
  const mismatch = { url: '/events/mismatch', close_time: '2026-10-11T00:00:00Z', headline: { pbe_pct: 60, market_pct: null, divergence_pts: null, venues: { kalshi: null, polymarket: { comparable: false, semantic_class: 'RULE_MISMATCH' } } } };
  const badDelta = { ...cmpEv('bad', 10), headline: { ...cmpEv('bad', 10).headline, divergence_pts: 99 } };
  const range = cmpEv('range', 10, { pbe: 140 });
  const zero = cmpEv('zero', -7, { pbe: 0 }); // PBE 0%, market 7%: a genuine comparable gap
  for (const e of [{ url: '/events/x' }, { url: '/events/y', headline: null }, noVenue, mismatch, badDelta, range]) assert.equal(comparableHeadline(e), false, e.url);
  assert.equal(comparableHeadline(zero), true, '0% is a value, not missing');
  const f = featuredForMember({ events: [noVenue, mismatch, badDelta, range, zero, { url: '/events/missing' }] });
  assert.deepEqual(f.events.map((e) => e.url), ['/events/zero']);
  assert.equal(f.comparable_count, 1);
  // the other slots are WATCH cards: modeled (finite PBE) but no comparable quote, soonest first, never counted as gaps
  assert.deepEqual(f.watch.map((e) => e.url), ['/events/novenue', '/events/bad']);
  assert.ok(f.watch.every((e) => !comparableHeadline(e)));
});

test('zero comparable events: no gaps claimed, up to three watch cards', () => {
  const w = (id, h) => ({ url: `/events/${id}`, close_time: `2026-10-1${h}T00:00:00Z`, headline: { pbe_pct: 30, market_pct: null, divergence_pts: null } });
  const f = featuredForMember({ events: [w('c', 3), w('a', 1), w('b', 2), w('d', 4), { url: '/events/nomodel', headline: { pbe_pct: null } }] });
  assert.deepEqual(f.events, []); assert.equal(f.comparable_count, 0);
  assert.deepEqual(f.watch.map((e) => e.url), ['/events/a', '/events/b', '/events/c']);
  assert.deepEqual(featuredForMember({ events: [] }), { audience: 'member', generated_at: null, basis: 'largest_comparable_divergence', comparable_count: 0, events: [], watch: [] });
});

test('pulse is built from preview rows only: one priced observation per category, coverage counts, no PBE number', () => {
  const row = (cat, id, close, mkt, modeled) => ({ category: cat, category_label: cat[0] + cat.slice(1).toLowerCase(), url: `/events/${id}`, title: id, state: modeled ? 'RESEARCH' : 'MARKET_MONITORING', close_time: close, outcomes_modeled: modeled, headline: { label: 'fav', market_pct: mkt } });
  const p = pulseFromPreview({ generated_at: 'g', events: [row('WEATHER', 'w2', '2026-10-12T00:00:00Z', 40, 1), row('WEATHER', 'w1', '2026-10-11T00:00:00Z', 55, 1), row('MACRO', 'm1', '2026-10-10T00:00:00Z', null, 0), row('MACRO', 'm2', '2026-10-13T00:00:00Z', 90, 0)] });
  const by = Object.fromEntries(p.categories.map((c) => [c.key, c]));
  assert.equal(by.WEATHER.observation.url, '/events/w1'); assert.equal(by.WEATHER.observation.market_pct, 55); assert.equal(by.WEATHER.modeled_events, 2);
  assert.equal(by.MACRO.observation.url, '/events/m2', 'an unpriced contract is skipped'); assert.equal(by.MACRO.observation.modeled, false);
  assert.equal(by.RATES.observation, null);
  assert.doesNotMatch(JSON.stringify(p), /pbe_pct|divergence/);
});

test('latest insight line carries title, link and date only', () => {
  assert.equal(latestInsight([]), null);
  assert.deepEqual(latestInsight([{ story: { slug: 's1', link_title: 'T', published_at: '2026-10-09T00:00:00Z', family_label: 'Resolution report' }, built: { title: 'ignored' } }]), { title: 'T', url: '/insights/s1', published_at: '2026-10-09T00:00:00Z', family: 'Resolution report' });
});

test('public featured is built from preview rows only: no PBE number, three soonest-closing modeled events', () => {
  const row = (id, close, modeled = 1, mkt = 40) => ({ url: `/events/${id}`, close_time: close, outcomes_modeled: modeled, headline: { label: 'x', market_pct: mkt } });
  const f = featuredForPreview({ events: [row('late', '2026-10-12T00:00:00Z'), row('soon', '2026-10-10T00:00:00Z'), row('mon', '2026-10-09T00:00:00Z', 0), row('nomkt', '2026-10-09T01:00:00Z', 1, null), row('mid', '2026-10-11T00:00:00Z'), row('later', '2026-10-13T00:00:00Z')] });
  assert.deepEqual(f.events.map((e) => e.url), ['/events/soon', '/events/mid', '/events/late']);
  assert.doesNotMatch(JSON.stringify(f), /pbe_pct|divergence/);
});

test('results board: counts always cover every row; ?limit only trims the row lists', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ slug: `s${i}` }));
  const card = { top_outcome: { matched: 7, missed: 5, events: 12, rows: rows(12) }, prospective: { calls: 3, rows: rows(3) }, official: { calls: 0, rows: [] } };
  const cut = limitRows(card, 5);
  assert.equal(cut.top_outcome.rows.length, 5); assert.equal(cut.top_outcome.events, 12); assert.equal(cut.top_outcome.matched, 7);
  assert.equal(cut.prospective.rows.length, 3);
  assert.equal(limitRows(card, NaN), card, 'no limit = full record');
});

test('header: Overview, Desk, Crypto, Markets AI, Insights, Track Record + a Research dropdown; mobile strip flattens it', () => {
  const h = siteHeader('calendar');
  const desktop = h.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];
  for (const [, href] of NETWORK.product) assert.ok(desktop.includes(`href="${href}"`), href);
  assert.match(desktop, /<details class="nav-drop" data-active><summary aria-current="true">Research/);
  assert.match(desktop, /<a href="\/calendar\/" aria-current="page">Calendar<\/a>/);
  const strip = h.match(/<div class="subnav-track">[\s\S]*?<\/div>/)[0];
  for (const href of ['/', '/desk/', '/track-record/', '/calendar/', '/models/', '/methodology/']) assert.ok(strip.includes(`href="${href}"`), `strip ${href}`);
  assert.doesNotMatch(strip, /<details/);
  assert.ok(!/\/#(desk|track-record|calendar|models)"/.test(h), 'no homepage anchors in the nav');
  assert.match(siteHeader('overview'), /<a href="\/" aria-current="page">Overview<\/a>/);
});

test('every static page uses the one shell: one consent load, one access.js, the current nav, the shared footer', () => {
  for (const [path, file] of Object.entries(PAGES)) {
    const html = read(file);
    assert.equal((html.match(/pbe-consent-v1\.js/g) || []).length, 1, `${file} consent once`);
    assert.equal((html.match(/\/access\.js\?v=/g) || []).length, 1, `${file} access.js once`);
    assert.match(html, /<nav class="nav" aria-label="Predictions">/, file);
    assert.match(html, /<details class="nav-drop"/, file);
    assert.match(html, /class="footer net-footer"/, file);
    assert.ok(!/href="\/#(desk|track-record|calendar|models|picks-results)"/.test(html), `${file} no stale homepage anchors`);
    if (path !== '/' && path !== '/crypto/') assert.match(html, new RegExp(`<link rel="canonical" href="https://predictions\\.propbetedge\\.ai${path.replace(/\//g, '\\/')}">`), `${file} canonical`);
  }
  assert.match(read('desk/index.html'), /<script src="\/core\.js\?v=[0-9a-z]+" defer><\/script><script src="\/desk\.js\?v=/);
  assert.match(read('track-record/index.html'), /<script src="\/track-record\.js\?v=/);
  assert.match(read('calendar/index.html'), /<script src="\/calendar\.js\?v=/);
  assert.match(read('desk/index.html'), /id="desk-gate" data-gate/, 'the All Access gate is on the desk page');
});

test('Homepage V2 is an executive landing page: six sections, no full lists, no stat wall, no desk scripts', () => {
  const html = read('index.html');
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  for (const id of ['desk-list', 'cal', 'reg', 'results-ledger', 'tr', 'tape', 'cats']) assert.ok(!main.includes(`id="${id}"`), `no #${id} on the overview`);
  assert.equal([...main.matchAll(/<section /g)].length, 6, 'hero, pulse, comparisons, scoreboard, products, value');
  assert.equal([...main.matchAll(/<div class="stat"><span>/g)].length, 0, 'no giant stat-card panel');
  for (const id of ['spot', 'engine-line', 'pulse', 'featured', 'scoreboard', 'latest-insight']) assert.match(main, new RegExp(`id="${id}"`), id);
  assert.match(main, /The world has a price\.<br><span>We measure the probability\.<\/span>/);
  // explorer tabs route to the desk's own category filter keys
  for (const k of ['WEATHER', 'RATES', 'MACRO', 'BUSINESS', 'SPACE', 'PUBLIC_HEALTH', 'ENERGY']) assert.match(main, new RegExp(`href="/desk/\\?category=${k}"`), k);
  // members get the desk, not a marketing-only screen; guests see one sales story
  assert.match(main, /class="cta-primary member-only" href="\/desk\/"/);
  assert.equal([...main.matchAll(/data-purchase-cta/g)].length, 2, 'All Access CTA in the hero and the value strip only');
  assert.match(main, /href="\/track-record\/">The complete Track Record/);
  assert.ok(!/desk\.js|multivenue\.js/.test(html));
  assert.ok(read('home.js').length < 26000, 'overview controller stays small');
});

test('routing: slashless redirects, cache headers for the page scripts, sitemap lists the new pages', () => {
  const v = JSON.parse(read('vercel.json'));
  for (const k of ['desk', 'track-record', 'calendar']) assert.ok(v.redirects.some((r) => r.source === `/${k}` && r.destination === `/${k}/` && r.permanent), k);
  const h = v.headers.find((x) => /core\.js/.test(x.source));
  assert.ok(h && /desk\.js/.test(h.source) && /track-record\.js/.test(h.source) && /calendar\.js/.test(h.source));
  const xml = sitemapXml([], []);
  for (const p of ['/desk/', '/track-record/', '/calendar/']) assert.ok(xml.includes(`https://predictions.propbetedge.ai${p}`), p);
});
