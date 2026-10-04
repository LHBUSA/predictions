// Homepage truth / accessibility pass (owner 2026-10-04): presentation only. Contracts vs forecast snapshots are named
// for what they count; visible model-vs-market gaps carry "pts"; the seamless tape has ONE semantic copy of every item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const home = read('home.js');
const index = read('index.html');

// Run home.js's tape() against a tiny fake DOM (no network): returns the rendered tape HTML.
function renderTape(reducedMotion) {
  const nodes = {};
  const el = (id) => (nodes[id] ||= { id, innerHTML: '', textContent: '', hidden: false, parentElement: { hidden: false }, querySelectorAll: () => [], addEventListener() {}, closest: () => ({ hidden: false }), dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, style: {} });
  const ctx = {
    window: { matchMedia: () => ({ matches: reducedMotion }), PBE_MEMBERSHIP: null, addEventListener() {} },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: { dataset: {} }, body: { classList: { toggle() {} } } },
    fetch: () => new Promise(() => {}), console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash: '' }, URLSearchParams, Intl, Date, Math, Promise,
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(`${home}\n;globalThis.__setEvents = (x) => { events = x; }; globalThis.__tape = tape;`, ctx);
  const ev = (i, d) => ({ url: `/events/e${i}`, title: `Highest temperature in City${i} today?`, category_label: 'Weather', max_abs_divergence: Math.abs(d), headline: { label: 'Above 80°', pbe_pct: 40 + i, market_pct: 40 + i - d, divergence_pts: d } });
  ctx.__setEvents([ev(1, -78), ev(2, 45), ev(3, 0)]);
  ctx.__tape();
  return nodes.tape.innerHTML;
}

test('tape: exactly one semantic copy of every item; the loop clone is aria-hidden, inert and out of the tab order', () => {
  const html = renderTape(false);
  const anchors = html.match(/<a [^>]*>/g);
  assert.equal(anchors.length, 6, 'semantic set + visual clone');
  const semantic = anchors.filter((a) => !/data-tape-clone/.test(a));
  const clones = anchors.filter((a) => /data-tape-clone/.test(a));
  assert.equal(semantic.length, 3);
  assert.equal(new Set(semantic.map((a) => a.match(/href="([^"]+)"/)[1])).size, 3, 'each item once in the accessible set');
  for (const a of semantic) assert.ok(!/aria-hidden|inert|tabindex/.test(a));
  for (const a of clones) assert.ok(/aria-hidden="true"/.test(a) && /tabindex="-1"/.test(a) && /\binert\b/.test(a), a);
});

test('tape under reduced motion: no loop clone at all', () => {
  const anchors = renderTape(true).match(/<a [^>]*>/g);
  assert.equal(anchors.length, 3);
  assert.ok(anchors.every((a) => !/data-tape-clone/.test(a)));
});

test('visible divergence carries its unit: −78 pts / +45 pts / 0 pts (field and calculation unchanged)', () => {
  const html = renderTape(true);
  assert.ok(html.includes('−78 pts') && html.includes('+45 pts') && html.includes('>0 pts<'), html);
  assert.ok(!/>[-+−]?\d+<\/span><\/a>/.test(html), 'no bare unitless gap');
  assert.match(home, /\$\{pts\(h\.divergence_pts\)\}<\/strong><\/div><\/div>/, 'featured trio uses pts');
  assert.match(home, /<b aria-hidden="true">\$\{pts\(d\)\}<\/b>/, 'desk Div. cell uses pts');
  assert.match(home, /return \{ pts: h\.divergence_pts \};/, 'still the API divergence_pts field');
});

test('hero + track record + registry name what they count; sources unchanged', () => {
  assert.match(home, /\$\('s-modeled'\)\.textContent = s\.modeled_contracts\.toLocaleString\(\);/);
  assert.match(home, /\$\('s-monitor'\)\.textContent = s\.monitoring_contracts\.toLocaleString\(\);/);
  assert.ok(index.includes('<small>contracts with a public PBE probability</small>') && !index.includes('research-stage forecasts'));
  assert.ok(index.includes('<small>tracked contracts without a public PBE model</small>') && !index.includes('market shown, no PBE number'));
  assert.ok(home.includes('<span>Resolved contracts</span>') && !home.includes('Resolved forecasts'));
  assert.match(home, /\$\{t\.resolved_contracts \?/);
  assert.ok(index.includes('<th>Forecast snapshots</th>') && !index.includes('<th>Live forecasts</th>'));
  assert.match(home, /\$\{f\.live_forecasts \|\| '—'\}/, 'registry value field unchanged');
});

test('asset version bumped consistently (SSR pages + static pages + homepage)', () => {
  const v = read('workers/pbe-predictions/src/pages.js').match(/export const ASSET_V = '([^']+)'/)[1];
  for (const p of ['index.html', 'models/index.html', 'methodology/index.html', 'scripts/brand/static-pages.py']) {
    const vs = [...read(p).matchAll(/\/(?:site\.css|home\.js)\?v=([0-9a-z]+)/g)].map((m) => m[1]);
    assert.ok(vs.length && vs.every((x) => x === v), `${p}: ${vs.join(',')} vs ${v}`);
  }
});
