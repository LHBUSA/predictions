// PropBetEdge family footer parity (owner decision 2026-10-03).
// brand/family.json is VENDORED from LHBUSA/propbetedge-workers shared/network/family.json (generated from
// shared/network/pbe-network.js). Never hand-edit it; re-vendor when the registry changes.
// brand/network.json is the Predictions shell source (Worker pages + index.html/static pages). This test fails
// if its sports / network links drift from the family registry, or if Predictions ever appears as a sport.
// Sport ORDER is deliberately not pinned: the shell lists NHL before WNBA (family: WNBA before NHL); reordering is a
// visible change that needs a Worker deploy and is out of scope for this source-of-truth pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NETWORK, siteFooter } from '../workers/pbe-predictions/src/network.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const family = JSON.parse(read('brand/family.json'));
const brand = JSON.parse(read('brand/network.json'));
const SPORT_URLS = family.sports.map((s) => s.url);
const PRED_URL = family.products.find((p) => p.key === 'predictions').url;
const hrefsOf = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const sorted = (a) => [...a].sort();

test('vendored family.json is the canonical registry shape', () => {
  assert.equal(family.organization, 'https://propbetedge.ai/#organization');
  assert.equal(family.sports.length, 10);
  assert.equal(PRED_URL, 'https://predictions.propbetedge.ai/');
  assert.ok(family.retired_hosts.includes('hub.propbetedge.ai'));
});

test('brand/network.json sports == family sports (set + canonical urls); Predictions is never a sport', () => {
  const urls = brand.sports.map(([, url]) => url);
  assert.equal(urls.length, family.sports.length);
  assert.equal(new Set(urls).size, urls.length);
  assert.deepEqual(sorted(urls), sorted(SPORT_URLS));
  const labelByUrl = Object.fromEntries(brand.sports.map(([label, url]) => [url, label]));
  for (const s of family.sports) assert.ok(labelByUrl[s.url].startsWith(s.label), `${s.key} label ${labelByUrl[s.url]}`);
  assert.equal(urls.some((u) => /predictions/.test(u)), false);
  assert.deepEqual(NETWORK.sports, brand.sports, 'Worker module renders brand/network.json');
});

test('brand/network.json network links include every family network destination; org id matches', () => {
  const urls = brand.network.map(([, url]) => url);
  for (const n of family.network) assert.ok(urls.includes(n.url), `${n.key} ${n.url}`);
  assert.equal(brand.brand.org_id, family.organization);
  assert.equal(brand.all_access.url, family.network.find((n) => n.key === 'all_access').url);
  assert.match(brand.all_access.line, /10 sports \+ PropBetEdge Predictions/);
  assert.doesNotMatch(JSON.stringify(brand), /11 sports|eleven sports/i);
});

test('rendered footers (Worker shell + static index.html) link each family sport once, no retired hosts, no http://', () => {
  const statik = read('index.html');
  const staticFooter = statik.slice(statik.indexOf('<!-- network:footer -->'), statik.indexOf('<!-- /network:footer -->'));
  assert.ok(staticFooter.length > 0, 'index.html network:footer markers present');
  for (const [where, html] of [['worker', siteFooter()], ['index.html', staticFooter]]) {
    const hrefs = hrefsOf(html);
    for (const url of SPORT_URLS) assert.equal(hrefs.filter((h) => h === url).length, 1, `${where}: ${url}`);
    for (const h of hrefs) {
      for (const host of family.retired_hosts) assert.ok(!h.includes(host), `${where}: retired host ${h}`);
      assert.ok(!h.startsWith('http://'), `${where}: insecure ${h}`);
    }
  }
});
