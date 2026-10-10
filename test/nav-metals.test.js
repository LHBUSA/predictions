// #77: precious metals are a primary destination — nav (desktop + mobile strip), active state on every metals page,
// homepage feature with one-click Gold / Silver / Platinum, and a link from Markets AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteHeader, NETWORK } from '../workers/pbe-predictions/src/network.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const navOf = (h) => h.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];
const stripOf = (h) => h.match(/<div class="subnav-track">[\s\S]*?<\/div>/)[0];
const count = (s, needle) => s.split(needle).length - 1;

test('Metals is a primary product between Crypto and Markets AI, with its own icon, in the nav and the mobile strip', () => {
  const keys = NETWORK.product.map((p) => p[2]);
  assert.equal(keys.indexOf('metals'), keys.indexOf('crypto') + 1);
  assert.equal(keys.indexOf('markets'), keys.indexOf('metals') + 1);
  const h = siteHeader('overview');
  assert.match(navOf(h), /<a href="\/markets\/metals\/"><svg class="nav-ic"[^>]*>[\s\S]*?<\/svg><span>Metals<\/span><\/a>/);
  assert.equal(count(stripOf(h), 'href="/markets/metals/"'), 1, 'exactly one Metals link in the mobile strip');
  assert.ok(h.includes('href="/markets/metals/"') && /Precious metals tracker/.test(h), 'Research menu entry kept');
});

test('active state: the overview is the page; each per-metal page marks the Metals section (never "page"); Research stays inactive', () => {
  const ov = siteHeader('metals');
  assert.equal(count(ov, 'href="/markets/metals/" aria-current="page"'), 2, 'nav + strip');
  assert.doesNotMatch(ov, /<details class="nav-drop" data-active>/);
  for (const m of ['gold', 'silver', 'platinum']) {
    const html = read(`commodities/${m}/index.html`).match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
    assert.equal(count(html, 'href="/markets/metals/" aria-current="true"'), 2, `${m}: section marker in nav + strip`);
    assert.doesNotMatch(html, /href="\/markets\/metals\/" aria-current="page"/, m);
  }
  assert.equal(count(read('markets/metals/index.html').match(/<header class="topbar">[\s\S]*?<\/header>/)[0], 'href="/markets/metals/" aria-current="page"'), 2);
});

test('compact labels keep the full product name for assistive tech', () => {
  const h = siteHeader('desk');
  assert.match(h, /<a href="\/desk\/" aria-current="page" aria-label="Intelligence Desk">[\s\S]*?<span class="nl-long">Intelligence Desk<\/span><span class="nl-short" aria-hidden="true">Desk<\/span><\/a>/);
  assert.match(h, /aria-label="Track Record">/);
});

test('homepage: a prominent Gold & Silver feature with one-click Gold, Silver and Platinum links', () => {
  const html = read('index.html');
  const f = html.match(/<div class="metals-feature"[\s\S]*?<\/nav>\s*<\/div>/)[0];
  for (const href of ['/commodities/gold/', '/commodities/silver/', '/commodities/platinum/', '/markets/metals/']) assert.ok(f.includes(`href="${href}"`), href);
  assert.match(f, /Gold &amp; Silver tracker/);
  assert.doesNotMatch(f, /\$\s?\d/, 'no price in static HTML');
  assert.match(html, /<div class="product-grid">[\s\S]*?pc-markets[\s\S]*?<\/div>\s*<div class="metals-feature"/, 'below the three product cards, which stay three');
});

test('Markets AI links the metals tracker', () => {
  assert.match(read('markets/index.html'), /<a href="\/markets\/metals\/" class="tb-link">Metals<\/a>/);
});
