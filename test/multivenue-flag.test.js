// Hidden multi-venue UI (propbetedge-workers docs/MULTI_VENUE_DESK.md): OFF unless ?mv=1. Without the flag the
// event page and the homepage behave exactly as before (no panel, no script, no extra request).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderEvent } from '../workers/pbe-predictions/src/pages.js';

const rec = JSON.parse(readFileSync(new URL('./fixtures/event-fed-oct-2026.json', import.meta.url), 'utf8'));

test('event page: flag off = identical output, no multi-venue panel or script', () => {
  const plain = renderEvent(rec);
  assert.equal(renderEvent(rec, { multiVenue: false }), plain);
  assert.equal(renderEvent(rec, { stories: [] }), plain);
  assert.ok(!plain.includes('mv-chart') && !plain.includes('multivenue.js'));
});

test('event page: flag on = one hidden panel (revealed only when a second venue has stored observations) + module', () => {
  const on = renderEvent(rec, { multiVenue: true });
  assert.match(on, /<section class="card panel" id="mv-chart-panel" hidden data-event="PBE-KXFEDDECISION-26OCT" data-market="KXFEDDECISION-26OCT-[A-Z0-9]+">/);
  assert.match(on, /<script type="module" src="\/multivenue\.js\?v=20261004mv1"><\/script>/);
  // nothing else changes
  assert.equal(on.replace(/<section class="card panel" id="mv-chart-panel"[\s\S]*?<\/script>/, ''), renderEvent(rec));
});

test('homepage: the multi-venue module is imported only with ?mv=1 and every hook is optional', () => {
  const src = readFileSync(new URL('../home.js', import.meta.url), 'utf8');
  assert.match(src, /const MV = new URLSearchParams\(location\.search\)\.get\('mv'\) === '1';/);
  assert.match(src, /if \(d\.status === 'fulfilled' && MV\) await import\('\.\/multivenue\.js/);
  for (const hook of src.match(/window\.PBE_MV[^;]*/g)) assert.match(hook, /window\.PBE_MV\?\./, hook);
  const mv = readFileSync(new URL('../multivenue.js', import.meta.url), 'utf8');
  assert.match(mv, /c\.venues\.length >= 2 && c\.comparison/, 'single venue -> row untouched');
  assert.match(mv, /some\(\(s\) => s\.source === 'polymarket'\)\) return;/, 'no second venue -> existing chart stays the design');
  assert.match(mv, /local && qs\.get\('mvsrc'\)/, 'alternate data source only on localhost');
});
