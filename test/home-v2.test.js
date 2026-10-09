// Homepage V2 (issue #50, owner P0 2026-10-09): a preview payload is never rendered as member data; member reads fail
// closed (401/403/503) with a useful message; missing values never print "null"; only comparable pairs are called gaps;
// the scoreboard keeps three records with three denominators and shows losses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const core = read('core.js'); const home = read('home.js');
const soon = () => new Date(Date.now() + 3600e3).toISOString();
const ev = (id, h) => ({ url: `/events/${id}`, title: `${id}?`, category: 'WEATHER', category_label: 'Weather', state: 'RESEARCH', close_time: soon(), outcomes_total: 6, outcomes_modeled: 6, headline: h });
const cmp = (id, pbe, mkt) => ev(id, { label: '80-81°', pbe_pct: pbe, market_pct: mkt, divergence_pts: pbe - mkt, venues: { kalshi: { mid_pct: mkt, freshness: 'live', observed_at: new Date().toISOString(), divergence: { pts: pbe - mkt } } },
  spark: { from: new Date(Date.now() - 86400e3).toISOString(), to: new Date().toISOString(), gap_ms: 2700e3, pbe: [{ t: new Date(Date.now() - 3600e3).toISOString(), v: pbe }], kalshi: [{ t: new Date(Date.now() - 1800e3).toISOString(), v: mkt }] },
  why: { model: 'tmax@1', model_state: 'RESEARCH', data_cutoff_at: new Date().toISOString(), published_at: new Date().toISOString(), drivers: [{ label: 'NBM max', display: '82', unit: '°F', source: 'NOAA NBM' }], sources: [], record_url: `/events/${id}#facts-h` } });
const PREVIEW = { audience: 'preview', events: [ev('p1', { label: '80-81°', market_pct: 45, modeled: true })] };

function boot({ member = null, bodies = {}, status = {}, hold = null } = {}) {
  const nodes = {};
  const el = (id) => (nodes[id] ||= { id, innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, closest: () => (nodes[`${id}:section`] ||= { hidden: false }), removeAttribute() {}, addEventListener() {}, querySelectorAll: () => [], classList: { add() {}, toggle() {} } });
  const calls = []; const listeners = {}; let gate = null;
  const all = { summary: { live_contracts: 1, live_events: 1, by_category: {}, modeled_contracts: 1, resolved_scored: 1, last_engine_cycle: new Date().toISOString() }, 'preview/featured': PREVIEW, 'preview/pulse': { categories: [] }, 'crypto/nowcast': { ok: false }, 'track-record': { resolved_contracts: 365, min_for_claims: 30, groups: [{ designation: 'FINAL_PRE_RESOLUTION', method: 'brier', n: 365, pbe_mean: 0.0887, market_n: 252, market_mean: 0.0907 }] }, ...bodies };
  const fetch = (url, init = {}) => {
    const path = String(url).replace(/^\/api\//, '').replace(/\?.*$/, ''); calls.push({ path, init });
    const res = () => (status[path] ? { ok: false, status: status[path], text: async () => '{}', json: async () => ({}) } : { ok: !!all[path], status: all[path] ? 200 : 404, text: async () => JSON.stringify(all[path]), json: async () => all[path] });
    if (hold && path === hold) return new Promise((r) => { gate = () => r(res()); });
    return Promise.resolve(res());
  };
  const doc = { hidden: false, getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, documentElement: { dataset: {}, classList: { add() {} } }, body: { classList: { toggle() {} } } };
  const ctx = { window: { matchMedia: () => ({ matches: true }), PBE_MEMBERSHIP: member, addEventListener() {} }, document: doc, fetch, console: { error() {}, warn() {}, log() {} },
    setTimeout: (f) => setImmediate(f), clearTimeout() {}, setInterval: () => 1, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '', pathname: '/', replace() {} }, history: { replaceState() {} }, URLSearchParams, Intl, Date, Math, Promise, JSON };
  ctx.window.document = doc; vm.createContext(ctx);
  vm.runInContext(`${core}\n${home}\n;globalThis.__member = () => member;`, ctx);
  return { nodes, calls, ctx, membership: (m) => (listeners['pbe:membership'] || []).forEach((f) => f({ detail: m })), release: () => gate && gate() };
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const noNull = (html) => assert.doesNotMatch(html, />\s*null\s*</, 'no literal "null" rendered');

test('race: a preview response in flight when membership resolves is dropped and the member payload is read', async () => {
  const t = boot({ hold: 'preview/featured', bodies: { featured: { audience: 'member', comparable_count: 1, events: [cmp('m1', 62, 48)], watch: [] } } });
  await settle();
  t.membership({ entitled: true });        // membership resolves while the preview request is still pending
  t.release(); await settle();
  const spot = t.nodes.spot.innerHTML;
  assert.ok(t.calls.some((c) => c.path === 'featured' && c.init.credentials === 'same-origin'), 'member payload requested');
  assert.match(spot, /62%/); assert.match(spot, /48%/); assert.match(spot, /\+14 pts/); assert.match(spot, /Largest comparable gap/);
  assert.doesNotMatch(spot, /locked-num/, 'the preview render never landed with member labels');
  noNull(spot);
  assert.match(spot, /class="move-chart"/, 'stored-history chart'); assert.match(spot, /NBM max/, 'source driver');
});

test('member with no comparable quote: watch wording, never "largest gaps", never null', async () => {
  const watch = ev('w1', { label: '70-71°', pbe_pct: 33, market_pct: null, divergence_pts: null, venues: { kalshi: null } });
  const nopbe = ev('w2', { label: 'x', pbe_pct: null, market_pct: null, divergence_pts: null });
  const t = boot({ member: { entitled: true }, bodies: { featured: { audience: 'member', comparable_count: 0, events: [], watch: [watch, { ...watch, url: '/events/w3' }, nopbe] } } });
  await settle();
  const spot = t.nodes.spot.innerHTML; const cards = t.nodes.featured.innerHTML;
  assert.match(spot, /Watch · no comparable quote/); assert.match(spot, /33%/); assert.match(spot, /No comparable quote/); assert.match(spot, /Not comparable/);
  assert.doesNotMatch(spot + cards, /largest/i);
  assert.match(cards, /No comparable quote/); assert.match(cards, /Not modeled/);
  assert.match(t.nodes['featured-sub'].textContent, /^0 events have a fresh market quote/);
  noNull(spot); noNull(cards);
});

test('member reads fail closed: 401, 403 and 503 each show a useful state and no cards from another audience', async () => {
  for (const [code, re] of [[401, /sign-in has expired/], [403, /does not include All Access/], [503, /temporarily unavailable/]]) {
    const t = boot({ member: { entitled: true }, status: { featured: code, 'premium/results-board': code } });
    await settle();
    assert.match(t.nodes.spot.innerHTML, re, String(code));
    assert.doesNotMatch(t.nodes.spot.innerHTML, /locked-num|\d+%/, `${code}: no numbers`);
    assert.equal(t.nodes['featured:section'].hidden, true, `${code}: comparisons hidden`);
    assert.ok(!t.calls.some((c) => c.path === 'preview/featured'), `${code}: preview never substituted`);
  }
});

test('a payload is rendered only for its own audience', async () => {
  const t = boot({ member: { entitled: true }, bodies: { featured: { events: [ev('x', { label: 'x', market_pct: 45 })] } } }); // no audience
  await settle();
  assert.doesNotMatch(t.nodes.spot?.innerHTML ?? '', /x\?/,'an unlabelled payload is not rendered as member data');
  const g = boot({ bodies: { 'preview/featured': { audience: 'member', events: [cmp('leak', 70, 40)] } } });
  await settle();
  assert.doesNotMatch(g.nodes.spot?.innerHTML ?? '', /70%/, 'a guest page never renders a member-labelled payload from the public route');
});

test('guest: spotlight shows the public price, locked PBE and provenance, no chart', async () => {
  const t = boot();
  await settle();
  const spot = t.nodes.spot.innerHTML;
  assert.match(spot, /45%/); assert.match(spot, /locked-num/); assert.match(spot, /With All Access, this card shows/);
  assert.doesNotMatch(spot, /move-chart/); noNull(spot);
  assert.ok(!t.calls.some((c) => c.path === 'featured' || c.path.startsWith('premium')));
});

test('scoreboard: three records, three denominators, losses shown, official picks not activated', async () => {
  const board = { top_outcome: { matched: 11, missed: 24, events: 35, rows: [{ slug: 'a', title: 'A?', picked: '80-81°', actual: '82-83°', probability_pct: 41, scored_at: '2026-10-09T10:00:00Z', result: 'MISSED' }] },
    prospective: { matched: 10, missed: 1, pending: 2, calls: 13, rows: [{ slug: 'r', title: 'R?', label: 'Above 4.1%', side: 'NO', probability_pct: 22, decided_at: '2026-10-08T10:00:00Z', result: 'MATCHED', actual: 'NO' }, { slug: 'q', title: 'Q?', label: 'x', side: 'YES', decided_at: '2026-10-09T11:00:00Z', result: 'PENDING', actual: null }] },
    official: { calls: 0, matched: 0, missed: 0, pending: 0, rows: [] } };
  const t = boot({ member: { entitled: true }, bodies: { featured: { audience: 'member', comparable_count: 0, events: [], watch: [] }, 'premium/results-board': board } });
  await settle();
  const sb = t.nodes.scoreboard.innerHTML;
  assert.match(sb, /11\/35/); assert.match(sb, /24 missed/); assert.match(sb, /10–1/); assert.match(sb, /2 pending/); assert.match(sb, /Not activated/);
  assert.match(sb, /MISSED/); assert.match(sb, /RIGHT/); assert.doesNotMatch(sb, /Q\?/, 'pending calls are not listed as results');
  assert.ok(t.calls.some((c) => c.path === 'premium/results-board'));
  assert.doesNotMatch(sb, /profit|ROI|units/i);
});
