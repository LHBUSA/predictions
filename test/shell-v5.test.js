// Network shell v5 (2026-10-10): grouped Research menu, nav iconography, live-engine tooltip, explainer footer and
// the /about/ flagship page. A redesign never deletes destinations: every pre-v5 header/footer href is pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteHeader, siteFooter, NETWORK } from '../workers/pbe-predictions/src/network.js';
import { sitemapXml } from '../workers/pbe-predictions/src/pages.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const hrefs = (html) => new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));
const ldNodes = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => { const b = JSON.parse(m[1]); return b['@graph'] || [b]; });

// every destination the pre-v5 shell linked (header + footer), captured from main 58f24a7
const PRE_V5 = ['/', '/markets/signal-10/', '/desk/', '/crypto/', '/markets/', '/insights/', '/track-record/', '/calendar/', '/models/', '/methodology/',
  '/insights/rss.xml', '/methodology/#immutable', '/methodology/#evidence', '/methodology/#scoring',
  'https://propbetedge.ai/', 'https://propbetedge.ai/news', 'https://learn.propbetedge.ai/', 'https://propbetedge.ai/pro', 'https://propbetedge.ai/about',
  'https://propbetedge.ai/terms', 'https://propbetedge.ai/legal', 'https://propbetedge.ai/support',
  'https://members.propbetedge.ai/', 'https://compare.propbetedge.ai/', 'https://predictions.propbetedge.ai/',
  ...NETWORK.sports.map(([, href]) => href)];

test('no destination lost: every pre-v5 header/footer href is still in the shell', () => {
  const all = new Set([...hrefs(siteHeader('overview')), ...hrefs(siteFooter())]);
  for (const href of PRE_V5) assert.ok(all.has(href), href);
});

test('footer: mission explainer, five directories in order, compliance + All Access lines', () => {
  const f = siteFooter();
  const cols = [...f.matchAll(/<div class="nf-col[^"]*"><strong>([^<]+)<\/strong>/g)].map((m) => m[1]);
  assert.deepEqual(cols, ['Predictions', 'What We Cover', 'PropBetEdge Sports', 'All Access', 'Network &amp; Trust']);
  assert.match(f, /<h2 id="nf-intro-h">Predictive intelligence, built as a living ledger\.<\/h2>/);
  assert.match(f, /append-only ledger/);
  assert.match(f, /href="\/about\/">What is PropBetEdge Predictions\?/);
  assert.match(f, /href="\/about\/">About PropBetEdge Predictions<\/a>/);
  for (const [, href] of NETWORK.coverage) assert.ok(f.includes(`href="${href}"`), `coverage ${href}`);
  assert.match(f, /never enter a PropBetEdge model/);
  assert.match(f, /10 sports \+ Predictions \+ Compare — part of the broader PropBetEdge intelligence network\./);
  assert.doesNotMatch(f, /\bFREE\b|free tier/i);
  // trust/legal pages keep opening in place; other network properties open a new tab
  assert.match(f, /<a href="https:\/\/propbetedge\.ai\/terms">Terms<\/a>/);
  assert.match(f, /<a href="https:\/\/compare\.propbetedge\.ai\/" target="_blank" rel="noopener">Compare<\/a>/);
});

test('nav: one decorative icon per product; Signal 10 carries its accent hook; Crypto uses the Bitcoin mark', () => {
  const desktop = siteHeader('desk').match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];
  assert.equal((desktop.match(/<svg class="nav-ic"/g) || []).length, NETWORK.product.length + 1, 'products + Research');
  assert.ok([...desktop.matchAll(/<svg class="nav-ic"[^>]*>/g)].every((m) => /aria-hidden="true"/.test(m[0])));
  assert.match(desktop, /<a href="\/markets\/signal-10\/" data-signal>/);
  assert.match(desktop, /<a href="\/crypto\/"><svg class="nav-ic"[^>]*><path d="M5\.5 3\.5h4/);
});

test('live engine chip: keyboard-focusable tooltip that core.js can rewrite; opt-out for pages without core.js', () => {
  const h = siteHeader('desk');
  assert.match(h, /<span class="live-dot" id="live-dot" tabindex="0" aria-describedby="live-tip">/);
  assert.match(h, /<span class="live-tip" id="live-tip" role="tooltip">Monitoring live data, models, and market activity\.<\/span>/);
  assert.doesNotMatch(siteHeader('signal10', { live: false }), /live-dot/);
  assert.match(siteHeader('crypto', { live: { id: 'crypto-live', text: 'Connecting' } }), /id="crypto-live"/);
  const core = read('core.js');
  assert.match(core, /const tip = \$\('live-tip'\)/);
  assert.match(core, /dot\.dataset\.stale = '1'/);
  for (const p of ['markets/signal-10/index.html', 'markets/signal-10/live/index.html']) assert.doesNotMatch(read(p), /id="live-dot"/, p);
});

test('/about/ flagship: shell, AboutPage schema, every coverage anchor exists, no live PBE numbers, sitemap entry', () => {
  const html = read('about/index.html');
  assert.match(html, /<h1>Predictive intelligence, built as a living ledger\.<\/h1>/);
  assert.match(html, /<a href="\/about\/" aria-current="page"><b>What is PropBetEdge Predictions\?<\/b>/);
  assert.match(html, /<details class="nav-drop" data-active>/);
  const page = ldNodes(html).find((n) => n['@id'] === 'https://predictions.propbetedge.ai/about/#webpage');
  assert.equal(page['@type'], 'AboutPage');
  assert.equal(page.publisher['@id'], 'https://propbetedge.ai/#organization');
  for (const id of ['monitor', 'weather', 'macro', 'crypto', 'equities', 'sports', 'emerging']) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const [, href] of [...NETWORK.coverage, ...NETWORK.research.groups.flatMap((g) => g.items)]) {
    const m = href.match(/^\/about\/#(.+)$/); if (m) assert.match(html, new RegExp(`id="${m[1]}"`), href);
  }
  assert.doesNotMatch(html, /\b\d{1,3}%/, 'no probabilities on a public page');
  assert.doesNotMatch(html, /\bFREE\b/);
  assert.match(read('methodology/index.html'), /<section class="card panel" id="states">/);
  assert.match(sitemapXml([]), /<loc>https:\/\/predictions\.propbetedge\.ai\/about\/<\/loc>/);
});
