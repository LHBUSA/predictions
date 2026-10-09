// Information architecture (issue #50, 2026-10-09): overview homepage + dedicated /desk/, /track-record/, /calendar/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuredForMember, featuredForPreview } from '../workers/pbe-predictions/src/featured.js';
import { limitRows } from '../workers/pbe-predictions/src/results-board.js';
import { siteHeader, NETWORK } from '../workers/pbe-predictions/src/network.js';
import { sitemapXml } from '../workers/pbe-predictions/src/pages.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PAGES = { '/': 'index.html', '/desk/': 'desk/index.html', '/track-record/': 'track-record/index.html', '/calendar/': 'calendar/index.html', '/models/': 'models/index.html', '/methodology/': 'methodology/index.html', '/crypto/': 'crypto/index.html' };

test('member featured = the three largest |divergence| events with both numbers; events pass through unchanged', () => {
  const ev = (id, d, extra = {}) => ({ url: `/events/${id}`, close_time: '2026-10-10T00:00:00Z', headline: { pbe_pct: 50, market_pct: 50 - d, divergence_pts: d }, ...extra });
  const desk = { generated_at: 'g', events: [ev('a', 3), ev('b', -40), ev('c', 12), ev('d', 25), { url: '/events/nomodel', headline: { pbe_pct: null, divergence_pts: null } }, ev('e', null)] };
  const f = featuredForMember(desk);
  assert.deepEqual(f.events.map((e) => e.url), ['/events/b', '/events/d', '/events/c']);
  assert.equal(f.events[0], desk.events[1], 'same object: no field added, removed or recomputed');
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

test('the overview is an overview: no full lists in the DOM, <= 4 KPIs, 3 featured slots, a results preview, no desk scripts', () => {
  const html = read('index.html');
  for (const id of ['desk-list', 'cal', 'reg', 'results-ledger', 'tr', 'tape', 'cats']) assert.ok(!html.includes(`id="${id}"`), `no #${id} on the overview`);
  assert.ok([...html.matchAll(/<div class="stat"><span>/g)].length <= 4);
  assert.equal([...html.matchAll(/class="card feat skel"/g)].length, 3, 'three featured slots reserved');
  assert.match(html, /id="results-preview"/);
  assert.match(html, /href="\/track-record\/">View the complete Track Record/);
  assert.match(html, /id="hero-member-cta" href="\/desk\/" hidden>Open Intelligence Desk/);
  assert.ok(!/desk\.js|multivenue\.js/.test(html));
  assert.ok(read('home.js').length < 12000, 'overview controller stays small');
});

test('routing: slashless redirects, cache headers for the page scripts, sitemap lists the new pages', () => {
  const v = JSON.parse(read('vercel.json'));
  for (const k of ['desk', 'track-record', 'calendar']) assert.ok(v.redirects.some((r) => r.source === `/${k}` && r.destination === `/${k}/` && r.permanent), k);
  const h = v.headers.find((x) => /core\.js/.test(x.source));
  assert.ok(h && /desk\.js/.test(h.source) && /track-record\.js/.test(h.source) && /calendar\.js/.test(h.source));
  const xml = sitemapXml([], []);
  for (const p of ['/desk/', '/track-record/', '/calendar/']) assert.ok(xml.includes(`https://predictions.propbetedge.ai${p}`), p);
});
