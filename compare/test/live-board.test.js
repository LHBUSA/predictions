// LIVE COMMAND BOARD (2026-10-08): presentation ordering, header summary, columns. No model/comparison change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankLiveMarkets, featuredLive, liveSummary, boardColumns } from '../core.js';

const ev = (key, o = {}) => ({ key, contracts: [], best_gap: null, has_pbe: false, badge: 'SINGLE_VENUE', join: { score: { score: o.score || null } }, ...o });
const sc = (a, h) => ({ away: { score: a }, home: { score: h } });

test('live cards: PBE call > largest gap > cross > closest score > incoming order', () => {
  const cards = [ev('plain'), ev('close', { score: sc(3, 3) }), ev('cross', { contracts: [{ cross: { state: 'CROSS' } }] }), ev('gap', { best_gap: 3.5 }), ev('pbe', { has_pbe: true }), ev('blowout', { score: sc(9, 1) })];
  assert.deepEqual(rankLiveMarkets(cards).map((e) => e.key), ['pbe', 'gap', 'cross', 'close', 'blowout', 'plain']);
  assert.equal(featuredLive(ev('x', { best_gap: 0 })), false, 'a zero gap is not a featured signal');
  assert.equal(featuredLive(ev('x', { best_gap: 0.5 })), true);
  assert.equal(featuredLive(ev('x', { has_pbe: true })), true);
});

test('header summary is computed from the loaded live events only', () => {
  const s = liveSummary([ev('a', { badge: 'COMPARABLE', best_gap: 0.5 }), ev('b', { badge: 'COMPARABLE', best_gap: 4.5 }), ev('c', { badge: 'RULE_MISMATCH' }), ev('d')]);
  assert.deepEqual(s, { markets: 4, comparable: 2, rules_differ: 1, largest_gap: 4.5 });
  assert.equal(liveSummary([]).largest_gap, null);
});

test('command grid columns: 5 / 4 / 3 / 2 by width; 1-5 cards share one row when they fit', () => {
  assert.deepEqual([2048, 1920, 1440, 1280, 1024, 768].map((w) => boardColumns(w, 10)), [5, 4, 4, 3, 3, 2]);
  assert.deepEqual([boardColumns(1440, 3), boardColumns(1440, 5), boardColumns(2048, 2)], [3, 5, 2]);
});

test('markup: grid on desktop (no marquee), swipe rail on phones; golf is one cell; PBEcast is a real link inside the card', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(app, /const board = key === 'market' && window\.innerWidth > 720;/);
  assert.match(css, /#live-market-cards\.lc-board\{display:grid!important;grid-template-columns:repeat\(var\(--cols,4\)/);
  assert.doesNotMatch(css, /lc-golf-card\{grid-row:span 2\}/, 'a spanning golf card re-opened an empty row');
  assert.match(app, /if \(ev\.target\.closest\('\[data-open\] a\[href\]'\)\) return;/, 'inner links navigate, they never also open the drawer');
  assert.match(css, /#live-market-cards \.lc-track\{align-items:stretch\}/, 'phone rail: equal card heights, no floor');
});

test('header fits small phones: the decorative venue pill drops and gaps tighten at <=420px (320/360 overflow fix)', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8')
  assert.ok(css.includes('@media (max-width:420px){.top-in{gap:10px}.top .venues{display:none}.top-nav{gap:10px}.chip .chip-full{display:none}.chip .chip-short{display:inline}}'))
  assert.ok(css.includes('.chip .chip-short{display:none}'), 'short label hidden above 420px')
})

test('account chip: a short label on small phones, the full label stays the accessible name', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  assert.ok(app.includes("entitled: [mm.state === 'owner' ? 'VERIFIED OWNER' : '◆ PLATINUM · All Access', MEMBERS, mm.state === 'owner' ? 'OWNER' : '◆ PLATINUM']"))
  assert.ok(app.includes("a.setAttribute('aria-label', t)"))
  assert.ok(app.includes('<span class="chip-short" aria-hidden="true">${esc(short)}</span>'), 'escaped, hidden from screen readers')
})
