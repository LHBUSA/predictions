// Insights image resolver (owner 2026-10-04): real verified photo -> story-specific SVG -> category art only as an
// emergency fallback. Unique art per story subject; full license metadata for every photo; derivatives present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { storyImage, storySvg, heroOverlaySvg, photoForStation } from '../workers/pbe-predictions/src/insights/images.js';
import { imageSubject } from '../workers/pbe-predictions/src/newsroom/publish.js';

const REG = JSON.parse(readFileSync(new URL('../workers/pbe-predictions/src/insights/photo-registry.json', import.meta.url)));
const story = (id, station, overlay = { kind: 'mover', label: 'x', from: 21, to: 34 }) => ({ slug: `s-${id}`, story_id: id, vertical: 'weather', subject: { station }, overlay });

test('Austin and Chicago resolve to different real photos with complete source/license metadata; never category-weather', () => {
  const a = storyImage(story('a29c', 'CLIAUS'));
  const c = storyImage(story('c087', 'CLIMDW'));
  assert.equal(a.type, 'photo'); assert.equal(c.type, 'photo');
  assert.equal(a.key, 'photo-austin'); assert.equal(c.key, 'photo-chicago');
  assert.notEqual(a.key, c.key);
  for (const img of [a, c]) {
    assert.notEqual(img.key, 'category-weather');
    for (const k of ['source_class', 'source_url', 'original_url', 'license', 'attribution', 'file']) assert.ok(img.credit[k], `${img.key} credit.${k}`);
    assert.equal(img.credit.source_class, 'wikimedia-commons');
    assert.match(img.match.verified, /label \+ coordinates/);
    assert.ok(img.og_image.includes(img.key), 'OG cache key changes with the art');
    assert.match(img.og_background, new RegExp(`/images/insights/${img.key}/v1/og-bg\\.jpg`));
    assert.equal(img.overlay, true, 'evidence overlay on the photo');
  }
  assert.equal(photoForStation('CLIORD').key, 'photo-chicago', "O'Hare and Midway share the Chicago photo");
});

test('no safe photo -> a story-specific SVG (unique per story), carrying the evidence geometry; no text or numbers baked in', () => {
  const missing = Object.keys(REG.rejected).length ? Object.values(REG.subjects).flatMap((s) => s.stations) : [];
  const noPhotoStation = ['CLIPIT', 'CLISEA', 'CLIHOU'].find((x) => !missing.includes(x));
  const s1 = storyImage(story('p1', noPhotoStation)); const s2 = storyImage(story('p2', noPhotoStation, { kind: 'mover', label: 'y', from: 60, to: 40 }));
  assert.deepEqual([s1.type, s2.type], ['svg', 'svg']);
  assert.notEqual(s1.key, s2.key);
  const a = storySvg(story('p1', noPhotoStation)); const b = storySvg(story('p2', noPhotoStation));
  assert.notEqual(a, b, 'seeded per story');
  assert.match(a, /class="ev-path"/);
  assert.doesNotMatch(a, /<text/);
  assert.doesNotMatch(heroOverlaySvg(story('p1', 'CLIAUS')), /<text/);
  assert.equal(storySvg(story('p1', noPhotoStation)), a, 'deterministic');
});

test('category art is an emergency fallback only (no story id and no subject); flagship art unchanged', () => {
  assert.equal(storyImage({ slug: 'x', vertical: 'weather' }).key, 'category-weather');
  assert.equal(storyImage({ slug: 'x', vertical: 'weather' }).fallback, true);
  assert.equal(storyImage({ slug: 'lax', vertical: 'weather', image: { key: 'lax-99', version: 'v1', focal: '50% 50%', alt: 'a' } }).key, 'lax-99');
});

test('registry integrity: every photo has license/attribution/source, a verified entity match, and every derivative file', () => {
  const files = ['hero-800.avif', 'hero-800.webp', 'hero-1200.avif', 'hero-1200.webp', 'hero-1600.avif', 'hero-1600.webp', 'hero-1600.jpg', 'mobile-640.avif', 'mobile-640.webp', 'mobile-960.avif', 'mobile-960.webp', 'card-480.avif', 'card-720.webp', 'card-1200.jpg', 'square-1080.jpg', 'og.jpg', 'og-bg.jpg'];
  assert.ok(Object.keys(REG.subjects).length >= 18);
  for (const [city, s] of Object.entries(REG.subjects)) {
    assert.match(s.credit.license, /^(cc0|public domain|pd|cc[- ]by|attribution|fal)/i, city);
    assert.ok(s.credit.source_url.startsWith('https://commons.wikimedia.org/wiki/File:'), city);
    assert.ok(s.credit.attribution.includes('Wikimedia Commons'), city);
    if (s.credit.attribution_required) assert.ok(s.credit.author, `${city} needs an author`);
    assert.match(s.match.entity, /^Q\d+$/);
    assert.match(s.master.sha256, /^[0-9a-f]{64}$/);
    for (const f of files) assert.ok(existsSync(new URL(`../images/insights/${s.key}/${s.version}/${f}`, import.meta.url)), `${s.key}/${f}`);
  }
});

test('imageSubject derives the station and evidence geometry from the story packet', () => {
  const packet = { outcomes: [{ market_id: 'M1', label: '69° or below', contract: { station_id: 'CLIMDW' }, snapshots: [{ pbe: 34, roles: ['FINAL_PRE_RESOLUTION'] }], resolution: { venue_result: 'yes' } }, { market_id: 'M2', label: '70° to 71°', contract: { station_id: 'CLIMDW' }, snapshots: [{ pbe: 30, roles: [] }], resolution: { venue_result: 'no' } }] };
  const m = imageSubject({ story_class: 'FORECAST_MOVER', evidence: { trigger: { market_id: 'M1', from: 21, to: 34 } } }, packet);
  assert.deepEqual(m, { subject: { station: 'CLIMDW' }, overlay: { kind: 'mover', label: '69° or below', from: 21, to: 34 } });
  const r = imageSubject({ story_class: 'RESOLUTION_REPORT', evidence: { trigger: {} } }, packet);
  assert.deepEqual(r, { subject: { station: 'CLIMDW' }, overlay: { kind: 'resolution', values: [34, 30], winner: 0 } });
  const multi = imageSubject({ story_class: 'RESOLUTION_REPORT', evidence: { trigger: {} } }, { outcomes: [{ contract: { station_id: 'CLINYC' }, snapshots: [] }, { contract: { station_id: 'CLIBOS' }, snapshots: [] }] });
  assert.equal(multi.subject.station, null, 'multi-city event -> no single photo subject (story SVG)');
});
