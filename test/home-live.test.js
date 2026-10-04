// Homepage live refresh (owner P4 2026-10-04): no reloads; summary + desk 60 s, calendar 2 min, track/models 5 min;
// zero network while hidden + immediate catch-up on return; one timer + one visibility listener for the page's life;
// no overlapping fetches; an entitled reader never falls back to the free desk; unchanged payloads do not re-render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const home = readFileSync(new URL('../home.js', import.meta.url), 'utf8');

function boot({ entitled = false, deskBody = null } = {}) {
  const nodes = {};
  const el = (id) => (id === 'desk-lock' && !nodes[id] ? null : nodes[id] ||= { id, remove() {}, innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, parentElement: { hidden: false }, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, closest: () => ({ hidden: false }), after() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const listeners = {};
  const intervals = [];
  const calls = [];
  let pending = null;
  const summary = { live_contracts: 1, live_events: 1, by_category: { WEATHER: 1 }, modeled_contracts: 1, monitoring_contracts: 0, resolved_scored: 0, last_engine_cycle: new Date().toISOString(), models_live: 1, models_shadow: 0 };
  const desk = deskBody || { events: [{ url: '/events/a', title: 'A?', category: 'WEATHER', category_label: 'Weather', close_time: new Date(Date.now() + 3600e3).toISOString(), outcomes: [], outcomes_modeled: 1, outcomes_total: 1, max_abs_divergence: 5, state: 'RESEARCH', headline: { label: 'x', pbe_pct: 50, market_pct: 45, divergence_pts: 5, published_at: new Date().toISOString() } }], access: entitled ? { tier: 'all_access' } : { tier: 'free', total_events: 1, shown: 1 } };
  const bodies = { 'summary': summary, 'desk': desk, 'premium/desk': { ...desk, access: { tier: 'all_access' } }, 'calendar': { events: [] }, 'track-record': { resolved_contracts: 0, min_for_claims: 30, groups: [] }, 'models': { families: [] } };
  const fetch = (url, init = {}) => {
    const path = String(url).replace(/^\/api\//, '').replace(/\?.*$/, '');
    calls.push({ path, init });
    if (pending && path === pending.path) return pending.promise;
    const b = bodies[path];
    return Promise.resolve({ ok: !!b, status: b ? 200 : 404, json: async () => b, text: async () => JSON.stringify(b) });
  };
  const doc = { hidden: false, getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, documentElement: { dataset: {} }, body: { classList: { toggle() {} } }, createElement: () => el('x') };
  const ctx = {
    window: { matchMedia: () => ({ matches: true }), PBE_MEMBERSHIP: entitled ? { entitled: true } : null, addEventListener() {} },
    document: doc, fetch, console: { error() {}, warn() {}, log() {} }, setTimeout: (f) => 0, clearTimeout() {}, setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; }, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash: '' }, URLSearchParams, Intl, Date, Math, Promise, JSON,
  };
  ctx.window.document = doc;
  vm.createContext(ctx);
  const src = home.replace(/import\('\.\/multivenue\.js[^)]*\)/, 'Promise.reject(new Error("no mv in test"))');
  vm.runInContext(`${src}\n;globalThis.__live = live; globalThis.__tick = liveTick; globalThis.__pull = pull; globalThis.__events = () => events; globalThis.__access = () => deskAccess;`, ctx);
  return { ctx, calls, intervals, listeners, doc, nodes, setPending: (p) => { pending = p; } };
}
const flush = () => new Promise((r) => setImmediate(r));

test('first load seeds the lifecycle: one timer, one visibility listener, no immediate duplicate fetches', async () => {
  const t = boot();
  await flush(); await flush();
  assert.equal(t.intervals.length, 1, 'one timer');
  assert.equal((t.listeners.visibilitychange || []).length, 1, 'one visibility listener');
  const n = t.calls.length;
  t.ctx.__tick();
  await flush();
  assert.equal(t.calls.length, n, 'nothing due right after the first load');
});

test('due datasets refresh on their cadence (summary/desk 60 s, calendar 120 s, track/models 300 s), all with no-store', async () => {
  const t = boot();
  await flush(); await flush();
  const L = t.ctx.__live;
  const back = (ms) => { for (const k of Object.keys(L.last)) L.last[k] -= ms; };
  t.calls.length = 0;
  back(61e3); t.ctx.__tick(); await flush(); await flush();
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['desk', 'summary']);
  t.calls.length = 0;
  back(61e3); t.ctx.__tick(); await flush(); await flush();
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['calendar', 'desk', 'summary']);
  t.calls.length = 0;
  back(181e3); t.ctx.__tick(); await flush(); await flush();
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['calendar', 'desk', 'models', 'summary', 'track-record']);
  assert.ok(t.calls.every((c) => c.init.cache === 'no-store'));
});

test('hidden tab: zero requests; returning to the tab catches up immediately; repeated visibility changes add no timers', async () => {
  const t = boot();
  await flush(); await flush();
  const L = t.ctx.__live;
  t.doc.hidden = true;
  for (const k of Object.keys(L.last)) L.last[k] -= 10 * 60e3;
  t.calls.length = 0;
  for (let i = 0; i < 5; i++) t.ctx.__tick();
  for (let i = 0; i < 5; i++) for (const f of t.listeners.visibilitychange) f();
  await flush();
  assert.equal(t.calls.length, 0, 'no network while hidden');
  t.doc.hidden = false;
  for (const f of t.listeners.visibilitychange) f();
  await flush(); await flush();
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['calendar', 'desk', 'models', 'summary', 'track-record']);
  assert.equal(t.intervals.length, 1);
  assert.equal(t.listeners.visibilitychange.length, 1);
});

test('no overlapping fetch for a dataset while one is in flight', async () => {
  const t = boot();
  await flush(); await flush();
  let release;
  t.setPending({ path: 'summary', promise: new Promise((r) => { release = r; }) });
  t.calls.length = 0;
  t.ctx.__pull('summary'); t.ctx.__pull('summary'); t.ctx.__pull('summary');
  assert.equal(t.calls.filter((c) => c.path === 'summary').length, 1);
  release({ ok: false, status: 500, text: async () => '' });
  await flush();
});

test('entitled reader: desk refresh reads only /premium/desk and a failed premium read keeps the All Access desk', async () => {
  const t = boot({ entitled: true });
  await flush(); await flush();
  t.calls.length = 0;
  await t.ctx.__pull('desk');
  assert.deepEqual(t.calls.map((c) => c.path), ['premium/desk']);
  assert.equal(t.calls[0].init.credentials, 'same-origin');
  assert.equal(t.ctx.__access().tier, 'all_access');
  t.setPending({ path: 'premium/desk', promise: Promise.resolve({ ok: false, status: 503, text: async () => '' }) });
  await t.ctx.__pull('desk');
  assert.equal(t.ctx.__access().tier, 'all_access', 'never downgraded to the free desk');
  assert.ok(!t.calls.some((c) => c.path === 'desk'));
});

test('an unchanged payload does not re-render (no tape restart, no layout shift)', async () => {
  const t = boot();
  await flush(); await flush();
  await t.ctx.__pull('desk'); // first refresh records the signature
  t.nodes.tape.innerHTML = 'SENTINEL'; t.nodes['desk-list'].innerHTML = 'SENTINEL';
  await t.ctx.__pull('desk');
  assert.equal(t.nodes.tape.innerHTML, 'SENTINEL');
  assert.equal(t.nodes['desk-list'].innerHTML, 'SENTINEL');
});

test('relative ages are rendered with data attributes so they tick between network calls', () => {
  assert.match(home, /const agoEl = \(iso\) => `<span data-ago=/);
  assert.match(home, /\$\{agoEl\(h\.published_at\)\}/);
  assert.match(home, /\$\('s-cycle'\)\.dataset\.ago = s\.last_engine_cycle/);
  assert.match(home, /for \(const el of document\.querySelectorAll\('\[data-ago\]'\)\)/);
});

test('engine card reads the heartbeat: cadence from engine.cadence_minutes, state from engine.state, honest before the first run', () => {
  const run = (summary) => {
    const nodes = {};
    const el = (id) => (nodes[id] ||= { id, textContent: '', innerHTML: '', dataset: {}, style: {}, hidden: false, parentElement: { hidden: false }, querySelectorAll: () => [], closest: () => ({ hidden: false }), addEventListener() {} });
    nodes['live-text'] = { textContent: 'Live engine' };
    const doc = { hidden: false, getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: { dataset: {} }, body: { classList: { toggle() {} } } };
    const ctx = { window: { matchMedia: () => ({ matches: true }), addEventListener() {} }, document: doc, fetch: () => new Promise(() => {}), console: { error() {} }, setTimeout() {}, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash: '' }, URLSearchParams, Intl, Date, Math, Promise, JSON };
    vm.createContext(ctx);
    vm.runInContext(`${home}\n;globalThis.__stats = stats;`, ctx);
    ctx.__stats({ live_contracts: 1, live_events: 1, by_category: {}, modeled_contracts: 1, monitoring_contracts: 0, resolved_scored: 0, models_live: 1, models_shadow: 0, ...summary });
    return { cycle: nodes['s-cycle'].textContent, sub: nodes['s-cycle-sub'].textContent, live: nodes['live-text'].textContent };
  };
  const now = new Date().toISOString();
  assert.deepEqual(run({ last_engine_cycle: now, engine: { state: 'healthy', cadence_minutes: 15 } }).sub, `${now.slice(11, 16)} UTC · core every 15 min`);
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'healthy', cadence_minutes: 2 } }).sub, `${now.slice(11, 16)} UTC · core every 2 min`);
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'running', cadence_minutes: 2 } }).live, 'Live engine');
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'delayed', cadence_minutes: 2 } }).live, 'Engine delayed');
  assert.equal(run({ last_engine_cycle: now, engine: { state: 'failed', cadence_minutes: 2 } }).live, 'Engine cycle failed');
  const first = run({ last_engine_cycle: null, engine: { state: 'delayed', cadence_minutes: 15, last_success: null } });
  assert.deepEqual([first.cycle, first.sub], ['—', 'awaiting the first recorded cycle']);
  assert.ok(!/every 15 min/.test(home.replace(/\/\/.*$/gm, '')), 'no hard-coded cadence copy');
});
