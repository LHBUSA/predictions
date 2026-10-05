// All Access boundary (owner contract 2026-10-05): PropBetEdge Predictions is a premium product included with All Access
// ($29/month). There is no free Predictions tier. The network authority (auth-magic, product=predictions) decides;
// Predictions fails closed; no PBE probability, market comparison, evidence or history reaches a non-entitled reader —
// not in HTML, not in JSON-LD, not in a social card, not in an API body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/worker-assets.js';
const { default: worker } = await import('../workers/pbe-predictions/src/index.js');
import { predictionsMembership, sessionCookie } from '../workers/pbe-predictions/src/membership.js';
import { publicEventShell, publicEventView, premiumEventView, eventCsv } from '../workers/pbe-predictions/src/premium.js';
import { renderEvent, eventIntel } from '../workers/pbe-predictions/src/pages.js';
import { eventCard } from '../workers/pbe-predictions/src/og-render.js';
import { siteHeader } from '../workers/pbe-predictions/src/network.js';

const JWT = 'aaaa.bbbb.cccc';
const req = (path, cookie) => new Request(`https://pbe-predictions.example${path}`, { headers: cookie ? { cookie } : {} });
function authStub(answer) {
  const calls = [];
  return { calls, fetch: async (r) => { calls.push(r.url); if (answer instanceof Error) throw answer; return new Response(JSON.stringify(answer), { status: answer.__status || 200 }); } };
}
// what propbetedge-auth-magic answers for ?product=predictions (state 'free' = no All Access, incl. sport-only plans)
const verdict = (state, { authenticated = state !== 'anon', reason = state } = {}) => ({ authenticated, reason, membership: { product: 'predictions', sport: null, state: state === 'anon' ? 'free' : state, label: state === 'owner' ? 'OWNER' : state === 'all_access' ? 'ALL ACCESS ACTIVE' : 'FREE', entitled: state === 'all_access' || state === 'owner', email: authenticated ? 'reader@example.com' : null } });
const SIGNED_IN = verdict('free', { authenticated: true, reason: 'no_all_access' });
const LEDGER_DOWN = verdict('free', { authenticated: true, reason: 'entitlement_unavailable' });

test('membership: no cookie or a malformed cookie is anonymous without asking the authority', async () => {
  const auth = authStub(verdict('all_access'));
  for (const r of [req('/'), req('/', 'pbe_session=not-a-jwt')]) {
    const m = (await predictionsMembership(r, { AUTH: auth })).membership;
    assert.deepEqual([m.state, m.label, m.entitled, m.show_purchase_cta], ['anonymous', 'Sign in', false, true]);
  }
  assert.equal(auth.calls.length, 0);
  assert.equal(sessionCookie(req('/', `a=1; pbe_session=${JWT}; b=2`)), JWT);
});

test('membership states: All Access / owner unlock; signed-in (incl. sport-only) = Upgrade; outages = Access Check, never unsubscribed', async () => {
  const ask = async (answer, env) => (await predictionsMembership(req('/', `pbe_session=${JWT}`), env ?? { AUTH: authStub(answer) })).membership;
  const s = (m) => [m.state, m.label, m.entitled, m.show_purchase_cta];
  assert.deepEqual(s(await ask(verdict('all_access'))), ['all_access', 'ALL ACCESS ACTIVE', true, false]);
  assert.deepEqual(s(await ask(verdict('owner'))), ['owner', 'OWNER', true, false]);
  assert.deepEqual(s(await ask(SIGNED_IN)), ['signed_in', 'Upgrade', false, true], 'signed in without All Access (a sport-only plan is answered the same way)');
  assert.deepEqual(s(await ask(verdict('anon', { reason: 'invalid_session' }))), ['anonymous', 'Sign in', false, true], 'expired/invalid session');
  const down = ['unverified', 'Access Check', false, false];
  assert.deepEqual(s(await ask(LEDGER_DOWN)), down, 'All Access ledger unreadable: not shown as unsubscribed');
  assert.deepEqual(s(await ask(Object.assign(verdict('all_access'), { __status: 503 }))), down);
  assert.deepEqual(s(await ask(new Error('authority down'))), down);
  assert.deepEqual(s(await ask(null, {})), down, 'no AUTH binding');
  assert.deepEqual(s(await ask({ ...verdict('all_access'), membership: { ...verdict('all_access').membership, product: undefined, sport: 'golf' } })), down, 'a sport verdict is never accepted for Predictions');
  assert.equal((await ask({ ...SIGNED_IN, membership: { ...SIGNED_IN.membership, entitled: true } })).entitled, false, 'entitled flag without a granting state is rejected');
  assert.equal((await ask({ ...verdict('all_access'), membership: { ...verdict('all_access').membership, state: 'sport_pro' } })).entitled, false, 'a sport Pro state never unlocks Predictions');
});

const GATED = ['/v1/desk', '/v1/premium/desk', '/v1/event/highest-temperature-in-los-angeles-on-oct-4-2026', '/v1/contract/KXHIGHLAX-26OCT04-T98', '/v1/live/event/highest-temperature-in-los-angeles-on-oct-4-2026', '/v1/premium/event/highest-temperature-in-los-angeles-on-oct-4-2026', '/v1/premium/event/x-event.csv', '/v1/premium/event-page/highest-temperature-in-los-angeles-on-oct-4-2026'];
async function call(path, cookie, auth) {
  const env = { AUTH: auth, SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_KEY: 'x' };
  const realFetch = globalThis.fetch; let db = 0;
  globalThis.fetch = async () => { db += 1; throw new Error('db reached'); };
  try { const r = await worker.fetch(req(path, cookie), env, { waitUntil() {} }); return { r, db, body: await r.text() }; } finally { globalThis.fetch = realFetch; }
}
const assertPrivate = (r, path) => { assert.match(r.headers.get('cache-control'), /private/, path); assert.match(r.headers.get('cache-control'), /no-store/, path); assert.equal(r.headers.get('vary'), 'Cookie', path); };

test('server gate: anonymous 401, signed-in 403, unverified 503 — private, no payload, the database is never reached', async () => {
  const cases = [[undefined, authStub(verdict('all_access')), 401, 'all_access_required'], [`pbe_session=${JWT}`, authStub(SIGNED_IN), 403, 'all_access_required'], [`pbe_session=${JWT}`, authStub(LEDGER_DOWN), 503, 'entitlement_unavailable'], [`pbe_session=${JWT}`, authStub(new Error('down')), 503, 'entitlement_unavailable']];
  for (const path of GATED) {
    for (const [cookie, auth, status, error] of cases) {
      const { r, db, body } = await call(path, cookie, auth);
      assert.equal(r.status, status, `${path} ${status}`);
      assertPrivate(r, path);
      assert.equal(db, 0, `${path}: no data read for a non-entitled reader`);
      const b = JSON.parse(body);
      assert.equal(b.error, error);
      for (const k of ['outcomes', 'events', 'history', 'market_path', 'main', 'regions', 'pbe_pct']) assert.equal(body.includes(`"${k}"`), false, `${path}: no ${k}`);
      if (status === 503) assert.equal(r.headers.get('retry-after'), '5');
    }
  }
});

test('server gate: All Access and owner pass the gate (the request proceeds to the data layer)', async () => {
  for (const v of [verdict('all_access'), verdict('owner')]) {
    for (const path of GATED) {
      const { db } = await call(path, `pbe_session=${JWT}`, authStub(v));
      assert.ok(db > 0, `${path} reaches the data layer for ${v.membership.state}`);
    }
  }
});

test('/v1/membership is private and never says FREE', async () => {
  for (const [cookie, auth, label] of [[undefined, authStub(verdict('all_access')), 'Sign in'], [`pbe_session=${JWT}`, authStub(SIGNED_IN), 'Upgrade'], [`pbe_session=${JWT}`, authStub(verdict('all_access')), 'ALL ACCESS ACTIVE'], [`pbe_session=${JWT}`, authStub(verdict('owner')), 'OWNER'], [`pbe_session=${JWT}`, authStub(LEDGER_DOWN), 'Access Check']]) {
    const { r, body } = await call('/v1/membership', cookie, auth);
    assertPrivate(r, '/v1/membership');
    assert.equal(JSON.parse(body).membership.label, label);
    assert.doesNotMatch(body, /FREE|"free"/);
  }
});

function eventWithHistory() {
  const rec = JSON.parse(readFileSync(new URL('./fixtures/event-fed-oct-2026.json', import.meta.url), 'utf8'));
  const o = rec.outcomes[0];
  const h = (id, t, pct, roles = [], changed = []) => ({ forecast_id: id, t, pct, market_pct: 13, model: 'pbe-x@1.0.0', state: 'RESEARCH', confidence: 'HIGH', cutoff: t, sha: `sha-${id}`, roles, changed });
  o.history = [h('first-pub', '2026-10-03T18:00:00Z', 81, ['FIRST_PUBLISHED']), h('secret-mid-1', '2026-10-03T20:00:00Z', 84, [], [{ feature: 'nbm', from: 1, to: 2 }]), h('secret-mid-2', '2026-10-03T22:00:00Z', 86, [], [{ feature: 'nbm', from: 2, to: 3 }]), h('current', '2026-10-03T23:00:00Z', 87)];
  Object.assign(o, { pbe_pct: 87, pbe_raw: 0.87, market_pct: 13, divergence_pts: 74, model: 'pbe-x@1.0.0', evidence: [{ label: 'SECRET-EVIDENCE', value: 5, unit: 'x', detail: 'd' }], provenance: [{ source: 'SECRET-SOURCE', role: 'input' }], data_cutoff_at: '2026-10-03T23:00:00Z', scores: [{ designation: 'FIRST_PUBLISHED', method: 'brier', pbe: 0.0123, market: 0.4567 }] });
  rec.model = { id: 'pbe-fed', name: 'Fed v1', state: 'RESEARCH', inputs: 'Treasury CMT', limitations: ['weak holdout'], versions: ['1.0.0'] };
  rec.event.latest_forecast_at = '2026-10-03T23:00:00Z';
  return rec;
}
const LEAKS = [/87%/, /81%/, /84%/, /86%/, /\b13%/, /\+74/, /secret-mid/, /first-pub/, /SECRET-EVIDENCE/, /SECRET-SOURCE/, /0\.0123/, /0\.4567/, /nbm: 1/, /PBE data model/];

test('public shell is a whitelist: no probability, market comparison, evidence, history or score fields', () => {
  const shell = publicEventShell(eventWithHistory());
  const keys = new Set(); (function walk(v) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } })(shell);
  for (const k of ['pbe_pct', 'pbe_raw', 'market_pct', 'divergence_pts', 'history', 'market_path', 'call', 'evidence', 'provenance', 'scores', 'venue_scores', 'venues', 'intel', 'live', 'distribution', 'forecast_id', 'versions', 'latest_forecast_at']) assert.equal(keys.has(k), false, `shell carries ${k}`);
  assert.equal(shell.modeled, true);
  const blob = JSON.stringify(shell);
  for (const re of LEAKS) assert.doesNotMatch(blob, re);
});

test('anonymous event HTML: shell + gate + exact rules, no premium data, JSON-LD not free, no FREE badge', () => {
  const html = renderEvent(publicEventShell(eventWithHistory()));
  for (const re of LEAKS) assert.doesNotMatch(html, re, `leak ${re}`);
  assert.match(html, /PROPBETEDGE PREDICTIONS · ALL ACCESS/);
  assert.match(html, /Included with PropBetEdge All Access · <b>\$29\/month<\/b>/);
  assert.match(html, /data-gate-cta><a class="cta-primary" href="https:\/\/propbetedge\.ai\/pro"[^>]*>Get All Access<\/a><a class="cta-secondary" href="#" data-pbe-signin>Sign in<\/a>/);
  assert.match(html, /<h2>Exactly how this resolves<\/h2>/);
  assert.match(html, /data-event-slug="/);
  assert.doesNotMatch(html, /\bFREE\b/); assert.doesNotMatch(html, /free (desk|predictions)/i);
  const graph = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => JSON.parse(m[1])['@graph'] || []);
  const ds = graph.find((n) => n['@type'] === 'Dataset');
  assert.equal(ds.isAccessibleForFree, false);
  assert.match(ds.conditionsOfAccess, /All Access \(\$29\/month\)/);
  assert.equal('distribution' in ds, false, 'no public download of a gated record');
  assert.ok(!graph.some((n) => n.isAccessibleForFree === true));
  const desc = html.match(/<meta name="description" content="([^"]*)"/)[1];
  assert.doesNotMatch(desc, /\d+%/); assert.match(desc, /All Access/);
});

test('public social card has no numbers from the forecast or the market', () => {
  const svg = eventCard(publicEventShell(eventWithHistory()));
  for (const re of LEAKS) assert.doesNotMatch(svg, re);
  assert.match(svg, /ALL ACCESS/);
});

test('member event intelligence (private route) carries the full record; CSV keeps every snapshot', () => {
  const full = eventWithHistory();
  const { main, aside } = eventIntel(premiumEventView(full), { multiVenue: true });
  assert.match(main, /87%/); assert.match(main, /secret-mid-1|84%/); assert.match(main, /SECRET-EVIDENCE/);
  assert.match(aside, /Permanent record/);
  for (const id of ['first-pub', 'secret-mid-1', 'secret-mid-2', 'current']) assert.match(eventCsv(full), new RegExp(id));
  assert.equal(publicEventView(full).access.archive.snapshots, 4, 'Insights archive module size');
});

test('header: Sign in + Get All Access, neutral loading state, never a FREE badge', () => {
  const h = siteHeader('desk');
  assert.match(h, /<a class="mem-chip" id="mem-chip" href="#" data-pbe-signin data-state="loading" aria-label="Account"><span class="mem-state">Account<\/span><\/a>/);
  assert.match(h, /data-acct-cta[^>]*>Get All Access<\/a>/);
  assert.ok(h.indexOf('mem-chip') < h.indexOf('Get All Access'), 'Sign in sits before Get All Access');
  assert.doesNotMatch(h, /FREE|data-state="free"/);
});

test('public pages never read membership; every intelligence route is gated and private', () => {
  const src = readFileSync(new URL('../workers/pbe-predictions/src/index.js', import.meta.url), 'utf8');
  const at = src.indexOf("if (p.startsWith('/pages/events/'))");
  const pagesBlock = src.slice(at, src.indexOf('// Social cards', at));
  assert.ok(pagesBlock.length > 100);
  assert.doesNotMatch(pagesBlock, /predictionsMembership|requireAllAccess|cookie\b/i);
  assert.match(pagesBlock, /renderEvent\(publicEventShell\(full\)/);
  assert.match(src, /eventCard\(publicEventShell\(rec\)\)/);
  assert.doesNotMatch(src, /publicDesk|publicEventView/, 'no free desk / public event view is served');
  for (const route of ["p === '/v1/desk'", "p.startsWith('/v1/premium/event-page/')", "p.startsWith('/v1/event/')", "p.startsWith('/v1/live/event/')", "p.startsWith('/v1/contract/')", "p.startsWith('/v1/premium/event/')"]) {
    const i = src.indexOf(route); assert.ok(i > 0, route);
    const end = Math.min(...['\n      if (', '\n      //'].map((t) => { const k = src.indexOf(t, i + 10); return k < 0 ? Infinity : k; }));
    const block = src.slice(i, end);
    assert.match(block, /requireAllAccess/, route); assert.doesNotMatch(block, /\bjson\(/, `${route}: only privateJson`);
  }
});

test('shipped client copy: no FREE badge, no free desk, no free Predictions', () => {
  for (const f of ['index.html', 'access.js', 'home.js', 'models/index.html', 'methodology/index.html', 'workers/pbe-predictions/src/network.js', 'workers/pbe-predictions/src/pages.js']) {
    const s = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /\bFREE\b/, f);
    assert.doesNotMatch(s, /free (desk|predictions)/i, f);
    assert.doesNotMatch(s, /data-state="free"|mem-action/, f);
  }
});
