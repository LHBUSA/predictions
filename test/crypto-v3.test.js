// Crypto Nowcast V3 (issue #51): the chart draws stored observations only (steps, broken on gaps and nulls), inspection
// is bounded in age and shows each observation's own time, the gap is shown only for a fresh SAME_CONTRACT Kalshi quote,
// failures never leave numbers wearing a LIVE badge, and an older response or older window never overwrites a newer one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../crypto/crypto.js', import.meta.url), 'utf8');
const T0 = Date.parse('2026-10-09T17:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function boot({ now = T0 + 6 * 60e3, responses = [] } = {}) {
  const nodes = {};
  const mk = (id) => { const attrs = {}; const cls = new Set(); return { id, attrs, innerHTML: '', textContent: '', hidden: false, dataset: {}, style: { setProperty() {} }, className: '',
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k] ?? null; }, addEventListener() {}, querySelector: () => ({ textContent: '' }),
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) }, getBBox: () => ({}), clientWidth: 1100 }; };
  const el = (id) => (nodes[id] ||= mk(id));
  const race = mk('race');
  const queue = [...responses]; const calls = []; let booted = false;
  const fetch = (url) => {
    const path = String(url).replace(/^\/api\//, ''); calls.push(path);
    if (path !== 'crypto/nowcast') return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    if (!booted) { booted = true; return new Promise(() => {}); } // the page's own startup read: left pending; tests drive loadCore()
    const r = queue.length ? queue.shift() : { status: 200, body: { ok: true, state: 'NO_WINDOW' } };
    return (r.delay || Promise.resolve()).then(() => ({ ok: r.status === 200, status: r.status, json: async () => r.body }));
  };
  const clock = { now };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }
  const doc = { hidden: false, getElementById: el, querySelector: (s) => (s === '.cx3-race' ? race : null), querySelectorAll: () => [], addEventListener() {} };
  const ctx = { window: { matchMedia: () => ({ matches: true }), addEventListener() {} }, document: doc, fetch, console: { error() {} }, setInterval: () => 1, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, AbortController, Date: FakeDate, Math, JSON, Number, String, Promise, Set, Map, Array, Object, isFinite };
  ctx.window.document = doc; ctx.window.AbortController = AbortController;
  vm.createContext(ctx);
  vm.runInContext(`${src}\n;globalThis.__S=S;globalThis.__f={seriesOf,asOf,stepPath,gapState,driverRows,loadCore,renderNowcast,MAX_GAP};`, ctx);
  return { nodes, calls, ctx, clock, race, f: ctx.__f, S: ctx.__S };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const win = (open = T0) => ({ window_id: `BTC15M:${iso(open)}`, open_at: iso(open), close_at: iso(open + 15 * 60e3), proxy_open_usd: 82000, kalshi_market_ticker: 'KXBTC15M-X' });
function nowcast({ open = T0, now = T0 + 6 * 60e3, p = 0.42, k = 0.35, kAge = 30e3, comp = 'SAME_CONTRACT', fAge = 40e3, prev = true } = {}) {
  const f = { model_id: 'crypto-threshold-diffusion-baseline', model_version: '0.1.0', model_state: 'SHADOW', captured_at: iso(now - fAge), data_cutoff_at: iso(now - fAge), p_up: p,
    features: { btc_spot_usd: 82050, btc_open_ref_usd: 82000, z_distance: 0.2, rv60_annualized: 0.3, horizon_min: 9 } };
  return { ok: true, active: true, state: 'LIVE', window: win(open), latest_forecast: f,
    previous_forecast: prev ? { ...f, captured_at: iso(now - fAge - 60e3), data_cutoff_at: iso(now - fAge - 60e3), p_up: 0.5, features: { btc_spot_usd: 82010, btc_open_ref_usd: 82000, z_distance: 0.05, rv60_annualized: 0.3, horizon_min: 10 } } : null,
    forecast_path: [{ t: iso(open + 60e3), p_up: 0.5 }, { t: iso(open + 120e3), p_up: 0.48 }, { t: iso(open + 6 * 60e3 - fAge), p_up: p }],
    venue_path: { kalshi: [{ t: iso(open + 60e3), mid: 0.5 }, { t: iso(open + 120e3), mid: null }, { t: iso(now - kAge), mid: k }], polymarket: [{ t: iso(open + 60e3), mid: 0.55 }] },
    markets: { kalshi: k == null ? null : { mid: k, bid: k - 0.01, ask: k + 0.01, captured_at: iso(now - kAge), comparability: comp }, polymarket: { mid: 0.55, captured_at: iso(open + 60e3), comparability: 'SAME_WINDOW_DIFFERENT_INDEX' } },
    record: null };
}

test('step path: holds each stored value, breaks on gaps > 2.5 min and on null values, never bridges missing data', () => {
  const { f } = boot();
  const x = (t) => (t - T0) / 1000; const y = (v) => v * 100;
  const rows = [{ t: T0, v: 0.5 }, { t: T0 + 60e3, v: 0.6 }, { t: T0 + 600e3, v: 0.4 }, { t: T0 + 660e3, v: null }, { t: T0 + 720e3, v: 0.3 }];
  const d = f.stepPath(rows, x, y, T0 + 750e3);
  assert.equal(d.match(/M/g).length, 3, 'three runs: the 9-min gap and the null both break the line');
  assert.match(d, /^M0\.0,50\.0 H60\.0 V60\.0 H210\.0 M600\.0,40\.0 H660\.0 M720\.0,30\.0 H750\.0$/);
  assert.doesNotMatch(d, /L/, 'no diagonal interpolation');
});

test('inspection: last observation at or before t, only within the source max age; never a future or distant point', () => {
  const { f } = boot();
  const rows = [{ t: T0, v: 0.5 }, { t: T0 + 60e3, v: 0.6 }, { t: T0 + 400e3, v: 0.7 }];
  assert.equal(f.asOf(rows, T0 + 90e3).v, 0.6);
  assert.equal(f.asOf(rows, T0 + 59e3).v, 0.5, 'not the nearer future point');
  assert.equal(f.asOf(rows, T0 + 300e3), null, '240 s after the last observation: none');
  assert.equal(f.asOf(rows, T0 - 1), null);
  assert.equal(f.asOf([{ t: T0, v: 0 }], T0 + 10e3).v, 0, '0% is a value');
});

test('gap rule: numeric, fresh, SAME_CONTRACT Kalshi against a fresh forecast; everything else is a labelled watch state', () => {
  const { f } = boot(); const now = T0 + 6 * 60e3;
  const fc = { p_up: 0.42, data_cutoff_at: iso(now - 30e3), captured_at: iso(now - 30e3) };
  const k = (o = {}) => ({ mid: 0.35, captured_at: iso(now - 20e3), comparability: 'SAME_CONTRACT', ...o });
  const g = f.gapState(fc, k(), now); assert.equal(g.ok, true); assert.ok(Math.abs(g.pts - 7) < 1e-9);
  assert.equal(f.gapState({ ...fc, p_up: 0 }, k({ mid: 0 }), now).ok, true, 'PBE 0% vs Kalshi 0% is a real (zero) gap');
  assert.equal(f.gapState({ ...fc, p_up: 0 }, k({ mid: 0 }), now).pts, 0);
  assert.equal(f.gapState(fc, k({ captured_at: iso(now - 200e3) }), now).label, 'Stale quote');
  assert.equal(f.gapState(fc, k({ comparability: 'SAME_WINDOW_DIFFERENT_INDEX' }), now).label, 'Not comparable');
  assert.equal(f.gapState(fc, k({ mid: null }), now).label, 'No quote');
  assert.equal(f.gapState(fc, null, now).label, 'No quote');
  assert.equal(f.gapState({ ...fc, data_cutoff_at: iso(now - 400e3) }, k(), now).label, 'Model stale');
  assert.equal(f.gapState(null, k(), now).label, 'No forecast');
});

test('drivers: observed changes between two stored forecasts, honest when there is no earlier forecast', () => {
  const { f } = boot();
  const prev = { p_up: 0.5, features: { btc_spot_usd: 82010, btc_open_ref_usd: 82000, z_distance: 0.05, rv60_annualized: 0.3, horizon_min: 10 } };
  const cur = { p_up: 0.42, features: { btc_spot_usd: 82050, btc_open_ref_usd: 82000, z_distance: 0.2, rv60_annualized: 0.3, horizon_min: 9 } };
  const rows = f.driverRows(prev, cur);
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(by['P(up)'].delta, '−8.0 pts'); assert.equal(by['BTC vs open reference'].delta, '+$40.00'); assert.equal(by['Time left in model'].delta, '−1.0 min');
  assert.ok(f.driverRows(null, cur).every((r) => r.delta === null), 'first forecast: no invented deltas');
});

test('live render: HUD numbers, labelled Polymarket, gap band, broken Kalshi line, readout with observed times', async () => {
  const t = boot({ responses: [{ status: 200, body: nowcast() }] });
  await t.f.loadCore(); await settle();
  assert.equal(t.nodes['hero-pbe-up'].textContent, '42.0%'); assert.equal(t.nodes['hero-kalshi'].textContent, '35.0%');
  assert.equal(t.nodes['hero-gap'].textContent, '+7.0 pts'); assert.match(t.nodes['gap-meta'].textContent, /same contract, fresh/);
  assert.match(t.nodes['poly-meta'].textContent, /different settlement index · stale since/, 'Polymarket labelled, stale when old');
  assert.equal(t.nodes['cx-status'].dataset.state, 'live');
  assert.match(t.nodes['cx-gapband'].innerHTML, /cx3-band/);
  assert.equal((t.nodes['cx-p-kalshi'].attrs.d.match(/M/g) || []).length, 2, 'the null Kalshi observation breaks the line');
  assert.match(t.nodes['cx-readout'].innerHTML, /observed \d\d:\d\d:\d\d UTC/);
  assert.match(t.nodes['cx-readout'].innerHTML, /different index/);
  assert.match(t.nodes['cx-drivers'].innerHTML, /−8\.0 pts/);
  assert.match(t.nodes['cx-table'].innerHTML, /no value stored/, 'the null observation is listed, not hidden');
});

test('stale Kalshi or wrong semantics: no numeric gap, watch wording, no band', async () => {
  for (const [opts, re] of [[{ kAge: 300e3 }, /Stale quote/], [{ comp: 'SAME_WINDOW_DIFFERENT_INDEX' }, /Not comparable/], [{ k: null }, /No quote/]]) {
    const t = boot({ responses: [{ status: 200, body: nowcast(opts) }] });
    await t.f.loadCore(); await settle();
    assert.match(t.nodes['hero-gap'].textContent, re); assert.doesNotMatch(t.nodes['hero-gap'].textContent, /pts/);
    assert.match(t.nodes['gap-meta'].textContent, /^Watch · /); assert.equal(t.nodes['cx-gapband'].innerHTML, '');
  }
});

test('model unchanged and model stale are said plainly', async () => {
  const body = nowcast(); body.previous_forecast.p_up = body.latest_forecast.p_up;
  const t = boot({ responses: [{ status: 200, body }] }); await t.f.loadCore(); await settle();
  assert.match(t.nodes['cx-drivers'].innerHTML, /Model probability unchanged since/);
  const s = boot({ responses: [{ status: 200, body: nowcast({ fAge: 400e3 }) }] }); await s.f.loadCore(); await settle();
  assert.equal(s.nodes['cx-status'].dataset.state, 'stale'); assert.match(s.nodes['cx-status-text'].textContent, /Model stale since/);
  assert.match(s.nodes['hero-gap'].textContent, /Model stale/);
});

test('401/403/502 or ok:false: "temporarily unavailable", never LIVE, last good data dimmed with its time', async () => {
  for (const status of [401, 403, 502]) {
    const t = boot({ responses: [{ status: 200, body: nowcast() }, { status, body: {} }] });
    await t.f.loadCore(); await settle(); await t.f.loadCore(); await settle();
    assert.equal(t.nodes['cx-status'].dataset.state, 'error', String(status));
    assert.match(t.nodes['cx-status-text'].textContent, /temporarily unavailable · showing data as of \d\d:\d\d:\d\d UTC/);
    assert.ok(t.race.classList.contains('is-unavailable'));
  }
  const cold = boot({ responses: [{ status: 502, body: {} }] }); await cold.f.loadCore(); await settle();
  assert.equal(cold.nodes['cx-chart-msg'].hidden, false); assert.match(cold.nodes['cx-chart-msg'].textContent, /temporarily unavailable/);
  const nok = boot({ responses: [{ status: 200, body: { ok: false } }] }); await nok.f.loadCore(); await settle();
  assert.equal(nok.nodes['cx-status'].dataset.state, 'error');
});

test('out-of-order responses: a slower older request or an older window never overwrites newer data', async () => {
  let release; const slow = new Promise((r) => { release = r; });
  const t = boot({ responses: [{ status: 200, body: nowcast({ open: T0, p: 0.11 }), delay: slow }, { status: 200, body: nowcast({ open: T0, p: 0.77 }) }] });
  const first = t.f.loadCore(); const second = t.f.loadCore(); await second; release(); await first; await settle();
  assert.equal(t.nodes['hero-pbe-up'].textContent, '77.0%', 'the aborted/older response is ignored');
  const w = boot({ responses: [{ status: 200, body: nowcast({ open: T0 + 15 * 60e3, now: T0 + 21 * 60e3, p: 0.6 }) }, { status: 200, body: nowcast({ open: T0, p: 0.2 }) }] });
  w.clock.now = T0 + 21 * 60e3;
  await w.f.loadCore(); await settle(); await w.f.loadCore(); await settle();
  assert.equal(w.nodes['hero-pbe-up'].textContent, '60.0%', 'a response for an older window is dropped');
});

test('rollover: a new window resets the canvas; nothing from the previous window is carried', async () => {
  const t = boot({ responses: [{ status: 200, body: nowcast({ open: T0 }) }, { status: 200, body: { ...nowcast({ open: T0 + 15 * 60e3, now: T0 + 16 * 60e3 }), forecast_path: [], venue_path: { kalshi: [], polymarket: [] }, latest_forecast: null, previous_forecast: null, markets: {} } }] });
  await t.f.loadCore(); await settle();
  assert.ok(t.nodes['cx-p-pbe'].attrs.d.length > 0);
  t.clock.now = T0 + 16 * 60e3;
  await t.f.loadCore(); await settle();
  assert.equal(t.S.windowId, `BTC15M:${iso(T0 + 15 * 60e3)}`);
  assert.equal(t.nodes['cx-p-pbe'].attrs.d, '', 'old path not carried'); assert.equal(t.nodes['cx-obs'].innerHTML, '');
  assert.equal(t.nodes['hero-pbe-up'].textContent, '—');
  assert.equal(t.nodes['cx-status'].dataset.state, 'waiting'); assert.match(t.nodes['cx-chart-msg'].textContent, /Waiting for the first stored observation/);
});

test('page contract: reduced motion honoured, hidden tab pauses, no charting library, chart keyboard-focusable with a data table', () => {
  const html = readFileSync(new URL('../crypto/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../crypto/crypto.css', import.meta.url), 'utf8');
  assert.match(html, /<svg id="prob-chart"[^>]*tabindex="0"[^>]*aria-describedby="cx-readout"/);
  assert.match(html, /Observations in this window \(table\)/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.cx3-dot\{transition:none\}/);
  assert.match(src, /visibilitychange/); assert.match(src, /cancelAnimationFrame/);
  assert.doesNotMatch(html, /chart\.js|d3\.|echarts|highcharts/i);
  assert.doesNotMatch(src, /L\$\{/, 'chart paths are steps (H/V), never interpolated L segments');
});
