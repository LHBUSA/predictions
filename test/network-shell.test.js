// Predictions is a first-class PropBetEdge product: every page carries the network shell, every article carries the
// canonical brand/product/internal links, and the whole site uses ONE PropBetEdge publisher identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteHeader, siteFooter, networkModule, NETWORK } from '../workers/pbe-predictions/src/network.js';
import { renderArticle, articleCrumbs } from '../workers/pbe-predictions/src/insights/render.js';
import { buildMover } from '../workers/pbe-predictions/src/newsroom/templates.js';
import { layout } from '../workers/pbe-predictions/src/pages.js';

const ORG = 'https://propbetedge.ai/#organization';
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const nodes = (html) => ldBlocks(html).flatMap((b) => b['@graph'] || [b]);
const hrefs = (html) => new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));
const orgIds = (html) => new Set(nodes(html).filter((n) => /Organization$/.test(n['@type'])).map((n) => n['@id']));

test('header: product nav preserved + PropBetEdge Network + All Access · $29/mo (desktop and the mobile strip)', () => {
  const h = siteHeader('insights');
  for (const [, href] of NETWORK.product) assert.ok(h.split(`href="${href}"`).length - 1 >= 2, `${href} in nav and mobile strip`);
  assert.match(h, /href="https:\/\/propbetedge\.ai\/"[^>]*>.*PropBetEdge Network/);
  assert.match(h, /href="https:\/\/propbetedge\.ai\/pro"[^>]*>All Access · \$29\/mo</);
  assert.match(h, /aria-current="page">Insights</);
});

test('footer: Predictions, all 10 sports, network, trust, and the All Access line', () => {
  const f = siteFooter();
  assert.equal(NETWORK.sports.length, 10);
  for (const [label, href] of NETWORK.sports) assert.ok(f.includes(`href="${href}"`), label);
  for (const href of ['https://propbetedge.ai/', 'https://propbetedge.ai/pro', '/insights/', '/models/', '/methodology/', '/insights/rss.xml', '/methodology/#scoring']) assert.ok(f.includes(`href="${href}"`), href);
  assert.match(f, /PropBetEdge All Access<\/strong><\/a> — 10 sports \+ PropBetEdge Predictions for \$29\/month\./);
  assert.doesNotMatch(f, /11 sports|eleven sports/i);
});

test('footer trust boundary: subdomain shell keeps About Terms Legal Support only; main-site editorial people stay off Predictions', () => {
  const f = siteFooter();
  for (const href of ['https://propbetedge.ai/about','https://propbetedge.ai/terms','https://propbetedge.ai/legal','https://propbetedge.ai/support'])
    assert.ok(f.includes(`href="${href}"`), href);
  for (const forbidden of [
    'https://propbetedge.ai/media',
    'https://propbetedge.ai/authors',
    'https://propbetedge.ai/authors/justin-erickson',
    'https://propbetedge.ai/authors/propbetedge-editorial-team',
    'https://propbetedge.ai/authors/ty-whitney',
    'https://propbetedge.ai/authors/erik-schwartz',
    'https://propbetedge.ai/editorial-standards',
  ]) assert.ok(!f.includes(forbidden), forbidden);
  for (const label of ['Editorial Team','Justin Erickson','PropBetEdge Editorial Team','Ty Whitney','Erik Schwartz','Editorial Standards'])
    assert.ok(!f.includes(label), label);
});

function sampleArticle() {
  const contract = { contract_id: 'C1', market_id: 'M1', outcome_label: 'Boston', normalization_status: 'NORMALIZED', resolution_authority: 'NWS', resolution_dataset: 'CLI', verification_dataset: 'CLI', measurement_definition: 'rain', rounding_rule: '', exceptions: [], rules_primary: 'rule' };
  const snap = (id, t, pbe) => ({ id, t, pbe, pbe_raw: pbe / 100, market: 30, model: 'pbe-weather-precip@1.1.0', model_id: 'pbe-weather-precip', version: '1.1.0', state: 'RESEARCH', cutoff: t, sha: 'x', feature_snapshot_id: `fs-${id}`, evidence: [], provenance: [], roles: [] });
  const packet = { as_of: '2026-10-03T23:00:00Z', event: { id: 'E1', kind: 'independent', slug: 'where-will-it-rain-on-oct-4-2026', title: 'Where will it rain on Oct 4, 2026?', category: 'WEATHER', category_label: 'Weather' }, outcomes: [{ contract, market_id: 'M1', label: 'Boston', snapshots: [snap('a', '2026-10-03T20:00:00Z', 32), snap('b', '2026-10-03T23:00:00Z', 52)], market_path: [], resolution: null, scores: [] }] };
  const built = buildMover({ packet, marketId: 'M1', s0Id: 'a', s1Id: 'b', features: new Map([['fs-a', { nbm_pop_union: 0.47 }], ['fs-b', { nbm_pop_union: 0.58 }]]) });
  const story = { slug: 'where-will-it-rain-on-oct-4-2026-pbe-move-20261003-2300', family: 'FORECAST_MOVER', family_label: 'Forecast Change', vertical: 'weather', events: [packet.event.slug], primary: packet.event.slug, as_of: packet.as_of, published_at: '2026-10-03T23:18:16Z' };
  const model = { id: 'pbe-weather-precip', name: 'Weather · rain', inputs: 'NBM + GFS MOS', limitations: ['Pre-window only'] };
  return { story, built, html: renderArticle(story, built, { live: null, related: [], model, words: 300 }) };
}

test('every article links up (PropBetEdge, Predictions, vertical), sideways (event, model, record) and down (methodology), plus All Access', () => {
  const { story, html } = sampleArticle();
  const h = hrefs(html);
  for (const href of ['https://propbetedge.ai/', '/', '/insights/', '/insights/weather/', `/events/${story.primary}`, '/models/#pbe-weather-precip', '/methodology/#scoring', '/#track-record', 'https://propbetedge.ai/pro'])
    assert.ok(h.has(href), `article links ${href}`);
  assert.match(html, /Part of the PropBetEdge intelligence network/);
  assert.match(html, /10 sports \+ PropBetEdge Predictions · All Access \$29\/month/);
});

test('article schema: canonical PropBetEdge publisher, Predictions WebSite, WebPage, breadcrumbs that match the visible trail, model mention', () => {
  const { story, built, html } = sampleArticle();
  const all = nodes(html);
  assert.deepEqual([...orgIds(html)], [ORG], 'exactly one Organization identity');
  const article = all.find((n) => n['@type'] === 'NewsArticle');
  assert.equal(article.publisher['@id'], ORG);
  assert.equal(article.isPartOf['@id'], 'https://predictions.propbetedge.ai/#website');
  assert.equal(article.mainEntityOfPage['@id'], `https://predictions.propbetedge.ai/insights/${story.slug}`);
  assert.ok(article.image.length >= 2);
  assert.ok(article.about.some((a) => a.url.endsWith(`/events/${story.primary}`)));
  assert.equal(article.mentions[0].url, 'https://predictions.propbetedge.ai/models/#pbe-weather-precip');
  const site = all.find((n) => n['@type'] === 'WebSite');
  assert.equal(site.isPartOf['@id'], 'https://propbetedge.ai/#website');
  const crumbs = all.find((n) => n['@type'] === 'BreadcrumbList').itemListElement.map((i) => i.name);
  const visible = [...html.match(/<nav class="ix-crumbs"[^>]*>([\s\S]*?)<\/nav>/)[1].matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(crumbs.slice(0, -1), visible);
  assert.deepEqual(crumbs, articleCrumbs(story, built).map((c) => c.name));
});

test('every page type uses the shell and the single publisher identity', () => {
  const page = layout({ title: 't', description: 'd', canonical: 'https://predictions.propbetedge.ai/x', body: '<main></main>', jsonld: [] });
  assert.match(page, /All Access · \$29\/mo/); assert.match(page, /10 sports \+ PropBetEdge Predictions for \$29\/month/);
  for (const f of ['index.html', 'models/index.html', 'methodology/index.html']) {
    const html = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(html, /All Access · \$29\/mo/, f); assert.match(html, /10 sports \+ PropBetEdge Predictions for \$29\/month/, f);
    assert.deepEqual([...orgIds(html)], [ORG], `${f} organization identity`);
    assert.doesNotMatch(html, /predictions\.propbetedge\.ai\/#org"/, f);
  }
  assert.match(networkModule(), /https:\/\/propbetedge\.ai\/pro/);
});
