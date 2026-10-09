// Homepage truth / accessibility pass (owner 2026-10-04): presentation only. Contracts vs forecast snapshots are named
// for what they count; visible model-vs-market gaps carry "pts"; the seamless tape has ONE semantic copy of every item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Since the IA split (issue #50) the tape and desk rows live in desk.js (/desk/), the KPIs in home.js (/), the scoring
// record in track-record.js and the registry on /models/. The same truth rules are asserted where the code now lives.
const core = read('core.js');
const home = read('home.js');
const desk = read('desk.js');
const record = read('track-record.js');
const index = read('index.html');
const deskPage = read('desk/index.html');
const models = read('models/index.html');

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
  vm.runInContext(`${core}\n${desk}\n;globalThis.__setEvents = (x) => { events = x; }; globalThis.__tape = tape;`, ctx);
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
  assert.match(home, /\$\{pts\(h\.divergence_pts\)\}<\/strong>/, 'featured trio uses pts');
  assert.match(desk, /<b aria-hidden="true">\$\{pts\(d\)\}<\/b>/, 'desk Div. cell uses pts');
  assert.match(desk, /return \{ pts: h\.divergence_pts \};/, 'still the API divergence_pts field');
});

test('KPIs, desk, track record and registry name what they count; sources unchanged', () => {
  // overview: exactly four KPIs (issue #50); contracts are never called forecasts or wins
  assert.match(home, /\$\('s-modeled'\)\.textContent = s\.modeled_contracts\.toLocaleString\(\);/);
  assert.equal([...index.matchAll(/<div class="stat"><span>/g)].length, 4, 'four KPIs on the overview');
  assert.ok(index.includes('<small>contracts with a PBE probability</small>') && !index.includes('research-stage forecasts'));
  assert.match(home, /contracts with stored scores \(not wins\)/);
  // market-monitoring count moved to the desk, named for what it counts
  assert.match(desk, /\$\{s\.monitoring_contracts\.toLocaleString\(\)\} market monitoring/);
  assert.ok(!index.includes('market shown, no PBE number') && !deskPage.includes('market shown, no PBE number'));
  // track record: resolved contracts, never "resolved forecasts"
  assert.ok(record.includes('<span>Resolved contracts</span>') && !record.includes('Resolved forecasts'));
  assert.match(record, /\$\{t\.resolved_contracts \?/);
  // registry (now on /models/): forecast snapshots, not "live forecasts"; same value field
  assert.ok(models.includes('Forecast snapshots (60 d)') && !models.includes('Live forecasts'));
  assert.match(models, /\$\{f\.live_forecasts\}/, 'registry value field unchanged');
});

test('asset version bumped consistently (SSR pages + every static page + generator)', () => {
  const v = read('workers/pbe-predictions/src/pages.js').match(/export const ASSET_V = '([^']+)'/)[1];
  assert.match(read('scripts/brand/static-pages.py'), new RegExp(`^ASSET_V = '${v}'`, 'm'), 'static generator version');
  for (const p of ['index.html', 'models/index.html', 'methodology/index.html', 'desk/index.html', 'track-record/index.html', 'calendar/index.html', 'crypto/index.html']) {
    const vs = [...read(p).matchAll(/\/(?:site\.css|home\.js|core\.js|desk\.js|track-record\.js|calendar\.js)\?v=([0-9a-z]+)/g)].map((m) => m[1]);
    assert.ok(vs.length && vs.every((x) => x === v), `${p}: ${vs.join(',')} vs ${v}`);
  }
});
