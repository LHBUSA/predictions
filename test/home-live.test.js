// Live refresh (owner P4 2026-10-04), per page since the IA split (issue #50): no reloads; each page registers ONLY the
// datasets it shows (overview V2: summary/featured/crypto 60 s, pulse 120 s, track/results 300 s; desk: desk/summary 60 s; calendar 120 s; track
// record 300 s); zero network while hidden + immediate catch-up on return; one timer + one visibility listener for the
// page's life; no overlapping fetches; the desk is All Access only (anonymous readers never request it; a member is never
// downgraded by a failed read); unchanged payloads do not re-render. The overview never downloads the desk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const core = read('core.js');
const PAGES = { home: read('home.js'), desk: read('desk.js'), calendar: read('calendar.js'), record: read('track-record.js') };
const PATHS = { home: '/', desk: '/desk/', calendar: '/calendar/', record: '/track-record/' };

function boot({ page = 'desk', entitled = false, deskBody = null, deskStatus = 200, hash = '' } = {}) {
  const nodes = {};
  const el = (id) => (id === 'desk-lock' && !nodes[id] ? null : nodes[id] ||= { id, remove() {}, removeAttribute(a) { if (a === 'hidden') this.hidden = false; }, innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, style: {}, parentElement: { hidden: false }, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, closest: () => ({ hidden: false }), after() {}, scrollIntoView() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const listeners = {};
  const intervals = [];
  const calls = [];
  const replaced = [];
  let pending = null;
  const summary = { live_contracts: 1, live_events: 1, by_category: { WEATHER: 1 }, modeled_contracts: 1, monitoring_contracts: 0, resolved_scored: 0, last_engine_cycle: new Date().toISOString(), models_live: 1, models_shadow: 0 };
  const desk = deskBody || { events: [{ url: '/events/a', title: 'A?', category: 'WEATHER', category_label: 'Weather', close_time: new Date(Date.now() + 3600e3).toISOString(), outcomes: [], outcomes_modeled: 1, outcomes_total: 1, max_abs_divergence: 5, state: 'RESEARCH', headline: { label: 'x', pbe_pct: 50, market_pct: 45, divergence_pts: 5, published_at: new Date().toISOString() } }], access: entitled ? { tier: 'all_access' } : { tier: 'free', total_events: 1, shown: 1 } };
  const previewEvent = { slug: 'p', url: '/events/p', title: 'P?', category: 'WEATHER', category_label: 'Weather', state: 'RESEARCH', close_time: new Date(Date.now() + 3600e3).toISOString(), outcomes_total: 2, outcomes_modeled: 1, headline: { label: 'x', market_pct: 45, modeled: true } };
  const board = { top_outcome: { matched: 1, missed: 1, events: 2, rows: [{ slug: 'a', title: 'A?', picked: '80-81°', actual: '80-81°', result: 'MATCHED' }, { slug: 'b', title: 'B?', picked: '70-71°', actual: '72-73°', result: 'MISSED' }] }, prospective: { matched: 0, missed: 0, pending: 1, calls: 1, rows: [] }, official: { calls: 0, matched: 0, missed: 0, pending: 0, rows: [] } };
  const bodies = { 'summary': summary, 'preview/desk': { events: [previewEvent] }, 'desk': { ...desk, access: { tier: 'all_access' } }, 'calendar': { generated_at: new Date().toISOString(), events: [] }, 'track-record': { resolved_contracts: 0, min_for_claims: 30, groups: [] }, 'models': { families: [] }, 'preview/featured': { audience: 'preview', events: [previewEvent] }, 'featured': { audience: 'member', comparable_count: 1, events: desk.events, watch: [] }, 'preview/pulse': { categories: [] }, 'crypto/nowcast': { ok: false }, 'premium/results-board': board };
  const gated = new Set(['desk', 'featured', 'premium/results-board']);
  const fetch = (url, init = {}) => {
    const path = String(url).replace(/^\/api\//, '').replace(/\?.*$/, '');
    calls.push({ path, init });
    if (pending && path === pending.path) return pending.promise;
    const b = bodies[path];
    if (gated.has(path) && (!entitled || deskStatus !== 200)) return Promise.resolve({ ok: false, status: entitled ? deskStatus : 401, json: async () => ({}), text: async () => '{}' });
    return Promise.resolve({ ok: !!b, status: b ? 200 : 404, json: async () => b, text: async () => JSON.stringify(b) });
  };
  const doc = { hidden: false, getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, documentElement: { dataset: {}, classList: { add() {}, remove() {} } }, body: { classList: { toggle() {} } }, createElement: () => el('x') };
  const ctx = {
    window: { matchMedia: () => ({ matches: true }), PBE_MEMBERSHIP: entitled ? { entitled: true } : null, addEventListener() {} },
    document: doc, fetch, console: { error() {}, warn() {}, log() {} }, setTimeout: (f) => 0, clearTimeout() {}, setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; }, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash, pathname: PATHS[page], replace: (u) => replaced.push(u) }, history: { replaceState() {} }, URLSearchParams, Intl, Date, Math, Promise, JSON,
  };
  ctx.window.document = doc;
  vm.createContext(ctx);
  const src = PAGES[page].replace(/import\('\/multivenue\.js[^)]*\)/, 'Promise.reject(new Error("no mv in test"))');
  const hooks = page === 'desk' ? 'globalThis.__events = () => events; globalThis.__member = () => member;' : page === 'home' ? 'globalThis.__member = () => member;' : '';
  vm.runInContext(`${core}\n${src}\n;globalThis.__live = live; globalThis.__tick = liveTick; globalThis.__pull = pull; globalThis.__datasets = PBE.datasets; ${hooks}`, ctx);
  return { ctx, calls, intervals, listeners, doc, nodes, replaced, setPending: (p) => { pending = p; } };
}
const flush = () => new Promise((r) => setImmediate(r));
const back = (t, ms) => { for (const k of Object.keys(t.ctx.__live.last)) t.ctx.__live.last[k] -= ms; };

test('first load seeds the lifecycle: one timer, one visibility listener, no immediate duplicate fetches (every page)', async () => {
  for (const page of Object.keys(PAGES)) {
    const t = boot({ page });
    await flush(); await flush();
    assert.equal(t.intervals.length, 1, `${page}: one timer`);
    assert.equal((t.listeners.visibilitychange || []).length, 1, `${page}: one visibility listener`);
    const n = t.calls.length;
    t.ctx.__tick();
    await flush();
    assert.equal(t.calls.length, n, `${page}: nothing due right after the first load`);
  }
});

test('each page registers only its own datasets and cadences; every request is no-store', async () => {
  const cad = (page) => Object.fromEntries(Object.entries(boot({ page }).ctx.__datasets).map(([k, d]) => [k, d.ms]));
  assert.deepEqual(cad('home'), { summary: 60e3, featured: 60e3, pulse: 120e3, crypto: 60e3, track: 300e3, results: 300e3 });
  assert.deepEqual(cad('desk'), { desk: 60e3, summary: 60e3 });
  assert.deepEqual(cad('calendar'), { calendar: 120e3, summary: 60e3 });
  assert.deepEqual(cad('record'), { track: 300e3, results: 300e3 });
  const t = boot({ page: 'desk', entitled: true });
  await flush(); await flush();
  t.calls.length = 0;
  back(t, 61e3); t.ctx.__tick(); await flush(); await flush();
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['desk', 'summary']);
  const h = boot({ page: 'home', entitled: true });
  await flush(); await flush();
  h.calls.length = 0;
  back(h, 61e3); h.ctx.__tick(); await flush(); await flush();
  assert.deepEqual(h.calls.map((c) => c.path).sort(), ['crypto/nowcast', 'featured', 'summary']);
  h.calls.length = 0;
  back(h, 300e3); h.ctx.__tick(); await flush(); await flush();
  assert.deepEqual(h.calls.map((c) => c.path).sort(), ['crypto/nowcast', 'featured', 'premium/results-board', 'preview/pulse', 'summary', 'track-record']);
  assert.ok([...t.calls, ...h.calls].every((c) => c.init.cache === 'no-store'));
});

test('the overview never downloads the desk, the calendar or the model registry', async () => {
  for (const entitled of [false, true]) {
    const t = boot({ page: 'home', entitled });
    await flush(); await flush();
    back(t, 10 * 60e3); t.ctx.__tick(); await flush(); await flush();
    const paths = new Set(t.calls.map((c) => c.path));
    for (const p of ['desk', 'preview/desk', 'calendar', 'models']) assert.ok(!paths.has(p), `${entitled ? 'member' : 'anonymous'}: no ${p}`);
    if (!entitled) assert.ok(!t.calls.some((c) => c.path === 'featured' || c.path.startsWith('premium')), 'anonymous: no gated route requested');
    else assert.ok(t.calls.some((c) => c.path === 'premium/results-board' && c.init.credentials === 'same-origin'));
  }
});

test('hidden tab: zero requests; returning to the tab catches up immediately; repeated visibility changes add no timers', async () => {
  const t = boot({ page: 'desk', entitled: true });
  await flush(); await flush();
  t.doc.hidden = true;
  back(t, 10 * 60e3);
  t.calls.length = 0;
  for (let i = 0; i < 5; i++) t.ctx.__tick();
  for (let i = 0; i < 5; i++) for (const f of t.listeners.visibilitychange) f();
  await flush();
  assert.equal(t.calls.length, 0, 'no network while hidden');
  t.doc.hidden = false;
  for (const f of t.listeners.visibilitychange) f();
  await flush(); await flush();
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['desk', 'summary']);
  assert.equal(t.intervals.length, 1);
  assert.equal(t.listeners.visibilitychange.length, 1);
});

test('no overlapping fetch for a dataset while one is in flight', async () => {
  const t = boot({ page: 'desk' });
  await flush(); await flush();
  let release;
  t.setPending({ path: 'summary', promise: new Promise((r) => { release = r; }) });
  t.calls.length = 0;
  t.ctx.__pull('summary'); t.ctx.__pull('summary'); t.ctx.__pull('summary');
  assert.equal(t.calls.filter((c) => c.path === 'summary').length, 1);
  release({ ok: false, status: 500, text: async () => '' });
  await flush();
});

test('anonymous reader: the gated desk is never requested; the public preview renders with locked PBE cells', async () => {
  const t = boot({ page: 'desk' });
  await flush(); await flush();
  assert.ok(!t.calls.some((c) => c.path === 'desk' || c.path.startsWith('premium')), 'no desk on first load');
  back(t, 10 * 60e3);
  t.ctx.__tick(); await flush(); await flush();
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['preview/desk', 'preview/desk', 'summary', 'summary']);
  assert.equal(t.ctx.__member(), false);
  const list = t.nodes['desk-list'].innerHTML;
  assert.match(list, /locked-num/); assert.match(list, /45%/, 'venue price visible');
  assert.doesNotMatch(list.replace(/<i aria-hidden="true">\+?00<\/i>/g, ''), /PBE<\/span><strong class="num">\d/, 'no PBE number');
  assert.equal(t.nodes['desk-gate']?.hidden ?? false, false, 'gate still shown');
  // the overview's spotlight is a placeholder too: a public preview never carries a PBE number
  const h = boot({ page: 'home' });
  await flush(); await flush();
  assert.match(h.nodes.spot.innerHTML, /locked-num/); assert.match(h.nodes.spot.innerHTML, /45%/, 'public market price shown');
  assert.doesNotMatch(h.nodes.spot.innerHTML.replace(/<i aria-hidden="true">\+?00<\/i>/g, ''), /PBE forecast<\/span><strong class="num">\d/);
});

test('member: desk reads /desk with credentials, unlocks the desk, and a failed read keeps what is on screen', async () => {
  const t = boot({ page: 'desk', entitled: true });
  await flush(); await flush();
  assert.equal(t.ctx.__member(), true);
  assert.equal(t.nodes['desk-gate'].hidden, true, 'gate replaced'); assert.equal(t.nodes['desk-controls'].hidden, false);
  t.calls.length = 0;
  t.ctx.__live.sig.desk = 'old';
  await t.ctx.__pull('desk');
  assert.deepEqual(t.calls.map((c) => c.path), ['desk']);
  assert.equal(t.calls[0].init.credentials, 'same-origin');
  assert.equal(t.ctx.__events().length, 1);
  t.setPending({ path: 'desk', promise: Promise.resolve({ ok: false, status: 503, text: async () => '' }) });
  await t.ctx.__pull('desk');
  assert.equal(t.ctx.__events().length, 1, 'never downgraded by a failed read');
});

test('a member whose desk read is refused (403/503) keeps the gate', async () => {
  const t = boot({ page: 'desk', entitled: true, deskStatus: 403 });
  await flush(); await flush();
  assert.equal(t.ctx.__member(), false);
  assert.notEqual(t.nodes['desk-gate']?.hidden, true);
});

test('an unchanged payload does not re-render (no tape restart, no layout shift)', async () => {
  const t = boot({ page: 'desk', entitled: true });
  await flush(); await flush();
  await t.ctx.__pull('desk'); // first refresh records the signature
  t.nodes.tape.innerHTML = 'SENTINEL'; t.nodes['desk-list'].innerHTML = 'SENTINEL';
  await t.ctx.__pull('desk');
  assert.equal(t.nodes.tape.innerHTML, 'SENTINEL');
  assert.equal(t.nodes['desk-list'].innerHTML, 'SENTINEL');
});

test('old homepage anchors become one-time redirects to the dedicated pages', () => {
  const to = (hash, search = '') => { const t = boot({ page: 'home', hash }); if (search) return null; return t.replaced[0] ?? null; };
  assert.equal(to('#desk'), '/desk/');
  assert.equal(to('#track-record'), '/track-record/');
  assert.equal(to('#picks-results'), '/track-record/');
  assert.equal(to('#calendar'), '/calendar/');
  assert.equal(to('#models'), '/models/');
  assert.equal(to(''), null, 'no redirect on a plain visit');
});

test('relative ages are rendered with data attributes so they tick between network calls', () => {
  assert.match(core, /const agoEl = \(iso\) => `<span data-ago=/);
  assert.match(PAGES.desk, /\$\{agoEl\(h\.published_at\)\}/);
  assert.match(PAGES.home, /\$\('e-cycle-ago'\)\.dataset\.ago = s\.last_engine_cycle/);
  assert.match(core, /for \(const el of document\.querySelectorAll\('\[data-ago\]'\)\)/);
});

test('engine card reads the heartbeat: cadence from engine.cadence_minutes, state from engine.state, honest before the first run', () => {
  const run = (summary) => {
    const nodes = {};
    const el = (id) => (nodes[id] ||= { id, textContent: '', innerHTML: '', dataset: {}, style: {}, hidden: false, parentElement: { hidden: false }, querySelectorAll: () => [], closest: () => ({ hidden: false }), addEventListener() {}, removeAttribute() {} });
    nodes['live-text'] = { textContent: 'Live engine' };
    const doc = { hidden: false, getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: { dataset: {} }, body: { classList: { toggle() {} } } };
    const ctx = { window: { matchMedia: () => ({ matches: true }), addEventListener() {} }, document: doc, fetch: () => new Promise(() => {}), console: { error() {} }, setTimeout() {}, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash: '', pathname: '/', replace() {} }, history: { replaceState() {} }, URLSearchParams, Intl, Date, Math, Promise, JSON };
    vm.createContext(ctx);
    vm.runInContext(`${core}\n${PAGES.home}\n;globalThis.__stats = stats;`, ctx);
    ctx.__stats({ live_contracts: 1, live_events: 1, by_category: {}, modeled_contracts: 1, monitoring_contracts: 0, resolved_scored: 0, models_live: 1, models_shadow: 0, ...summary });
    return { cycle: nodes['e-cycle-ago'].textContent, sub: nodes['e-cycle-sub'].textContent, live: nodes['live-text'].textContent, cardHidden: nodes['e-cycle'].hidden };
  };
  const now = new Date().toISOString();
  assert.deepEqual(run({ last_engine_cycle: now, engine: { state: 'healthy', cadence_minutes: 15 } }).sub, `${now.slice(11, 16)} UTC · every 15 min`);
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'healthy', cadence_minutes: 2 } }).sub, `${now.slice(11, 16)} UTC · every 2 min`);
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'running', cadence_minutes: 2 } }).live, 'Live engine');
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'delayed', cadence_minutes: 2 } }).live, 'Engine delayed');
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'failed', cadence_minutes: 2 } }).live, 'Engine cycle failed');
  const first = run({ last_engine_cycle: null, engine: { state: 'delayed', cadence_minutes: 15, last_success: null } });
  assert.deepEqual([first.cycle, first.sub, first.cardHidden], ['', '', true], 'no empty-state engine line before the first recorded run');
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'healthy', cadence_minutes: 15 } }).cardHidden, false);
  for (const src of [core, PAGES.home]) {
    assert.ok(!src.includes('awaiting the first recorded cycle'));
    assert.ok(!/every 15 min/.test(src.replace(/\/\/.*$/gm, '')), 'no hard-coded cadence copy');
  }
});
