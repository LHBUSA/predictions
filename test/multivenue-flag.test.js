// Multi-venue UI (propbetedge-workers docs/MULTI_VENUE_DESK.md). The ?mv=1 canary was removed 2026-10-04 (owner
// decision f357506: Polymarket display ON; the shared Worker's POLYMARKET_DISPLAY_ENABLED is the kill switch).
// Normal URLs load the desk module; with no second venue / related market nothing visible changes (no empty slot).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderEvent } from '../workers/pbe-predictions/src/pages.js';

const rec = JSON.parse(readFileSync(new URL('./fixtures/event-fed-oct-2026.json', import.meta.url), 'utf8'));
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('event page: production handler renders the multi-venue panel without any URL flag', () => {
  const idx = src('../workers/pbe-predictions/src/index.js');
  assert.match(idx, /html\(renderEvent\(rec, \{ stories: .*, multiVenue: true \}\)\)/);
  assert.ok(!/searchParams\.get\('mv'\)/.test(idx), 'no ?mv gate left');
});

test('event page: one HIDDEN panel (chart + related box) + module; the rest of the page is unchanged', () => {
  const on = renderEvent(rec, { multiVenue: true });
  assert.match(on, /<section class="card panel" id="mv-chart-panel" hidden data-event="PBE-KXFEDDECISION-26OCT" data-market="KXFEDDECISION-26OCT-[A-Z0-9]+">/);
  assert.match(on, /<div class="mv-chart"><\/div><div class="mv-related-box" hidden><\/div><\/section>/);
  assert.match(on, /<script type="module" src="\/multivenue\.js\?v=20261004mv2"><\/script>/);
  assert.equal(on.replace(/<section class="card panel" id="mv-chart-panel"[\s\S]*?<\/script>/, ''), renderEvent(rec));
});

test('homepage: the module loads on the normal URL, after the desk renders; every hook is optional', () => {
  const home = src('../home.js');
  assert.ok(!/get\('mv'\)/.test(home), 'no ?mv gate left');
  assert.match(home, /if \(d\.status === 'fulfilled'\) import\('\.\/multivenue\.js\?v=20261004mv2'\)\.then\(\(m\) => m\.ready\)\.then\(\(\) => \{ window\.PBE_MV\?\.addModes\(events\); desk\(\); \}\)/);
  // the desk renders before the venue module is awaited (a slow venue read never blocks the page)
  assert.ok(home.indexOf("tape(); featured(); cats(); desk();") < home.indexOf("import('./multivenue.js"));
  for (const hook of home.match(/window\.PBE_MV[^;]*/g)) assert.match(hook, /window\.PBE_MV\?\./, hook);
});

test('multivenue: venue rules — compare only qualifying quotes, related markets at native price, no consensus', () => {
  const mv = src('../multivenue.js');
  assert.match(mv, /c\.venues\.length >= 2 && c\.comparison/, 'a single venue leaves the row untouched');
  assert.match(mv, /some\(\(s\) => s\.source === 'polymarket'\)\) return;/, 'no second-venue series -> existing chart stays the design');
  assert.match(mv, /cmp\.match_class === 'COMPARABLE_EXCEPT_EXCEPTIONS'/, 'comparable class carries its disclosure');
  assert.match(mv, /\(its own price, not compared\)/);
  assert.match(mv, /r\.freshness !== 'stale'/, 'a stale related quote never renders');
  assert.match(mv, /if \(!list\.length\) return false; \/\/ nothing related: no panel, no placeholder/);
  assert.ok(!/consensus\s*[:=]/i.test(mv) && !/average|blend/i.test(mv.replace(/\/\/.*$/gm, '')), 'no pooled number');
  assert.match(mv, /local && qs\.get\('mvsrc'\)/, 'alternate data source only on localhost');
});
