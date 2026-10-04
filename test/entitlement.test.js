// Free / All Access boundary. Public record free; depth, history and workflow All Access. The network authority
// (auth-magic, product=predictions) decides; Predictions fails closed; premium data never reaches anonymous HTML/APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/worker-assets.js';
const { default: worker } = await import('../workers/pbe-predictions/src/index.js');
import { predictionsMembership, sessionCookie } from '../workers/pbe-predictions/src/membership.js';
import { publicEventView, premiumEventView, eventCsv, publicDesk, FREE_DESK_LIMIT } from '../workers/pbe-predictions/src/premium.js';
import { renderEvent } from '../workers/pbe-predictions/src/pages.js';

const JWT = 'aaaa.bbbb.cccc';
const req = (path, cookie) => new Request(`https://pbe-predictions.example${path}`, { headers: cookie ? { cookie } : {} });
function authStub(answer) {
  const calls = [];
  return { calls, fetch: async (r) => { calls.push(r.url); if (answer instanceof Error) throw answer; return new Response(JSON.stringify(answer), { status: answer.__status || 200 }); } };
}
const verdict = (state, extra = {}) => ({ authenticated: state !== 'anon', reason: state, membership: { product: 'predictions', sport: null, state, label: state === 'owner' ? 'OWNER' : state === 'all_access' ? 'ALL ACCESS ACTIVE' : 'FREE', entitled: state === 'all_access' || state === 'owner', email: 'reader@example.com', ...extra } });

test('membership: no cookie or a malformed cookie is FREE without asking the authority', async () => {
  const auth = authStub(verdict('all_access'));
  assert.equal((await predictionsMembership(req('/'), { AUTH: auth })).membership.state, 'free');
  assert.equal((await predictionsMembership(req('/', 'pbe_session=not-a-jwt'), { AUTH: auth })).membership.state, 'free');
  assert.equal(auth.calls.length, 0);
  assert.equal(sessionCookie(req('/', `a=1; pbe_session=${JWT}; b=2`)), JWT);
});

test('membership: All Access and owner unlock; sport-only (authority says free), wrong shape, errors and outages stay FREE', async () => {
  const ask = async (answer) => (await predictionsMembership(req('/', `pbe_session=${JWT}`), { AUTH: authStub(answer) })).membership;
  assert.deepEqual([(await ask(verdict('all_access'))).label, (await ask(verdict('all_access'))).entitled], ['ALL ACCESS ACTIVE', true]);
  assert.deepEqual([(await ask(verdict('owner'))).label, (await ask(verdict('owner'))).entitled], ['OWNER', true]);
  assert.equal((await ask(verdict('free'))).entitled, false, 'sport-only subscriber: the authority answers free for product=predictions');
  assert.equal((await ask({ ...verdict('all_access'), membership: { ...verdict('all_access').membership, product: undefined, sport: 'golf' } })).entitled, false, 'a sport verdict is never accepted for Predictions');
  assert.equal((await ask({ ...verdict('free'), membership: { ...verdict('free').membership, entitled: true } })).entitled, false, 'entitled flag without a granting state is rejected');
  assert.equal((await ask(Object.assign(verdict('all_access'), { __status: 503 }))).entitled, false);
  assert.equal((await ask(new Error('authority down'))).entitled, false);
  assert.equal((await predictionsMembership(req('/', `pbe_session=${JWT}`), {})).membership.entitled, false, 'no AUTH binding -> free');
});

test('anonymous premium APIs return 401 with no data, private no-store; /v1/membership is private', async () => {
  const env = { AUTH: authStub(verdict('all_access')), SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_KEY: 'x' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('anonymous premium request reached the database'); };
  try {
  for (const path of ['/v1/premium/event/highest-temperature-in-los-angeles-on-oct-4-2026', '/v1/premium/event/x-event.csv', '/v1/premium/desk']) {
    const r = await worker.fetch(req(path), env, { waitUntil() {} });
    assert.equal(r.status, 401, path);
    assert.match(r.headers.get('cache-control'), /private/); assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal(r.headers.get('vary'), 'Cookie');
    const b = await r.json();
    assert.equal(b.error, 'all_access_required');
    for (const k of ['outcomes', 'events', 'history', 'market_path']) assert.equal(k in b, false, `${path}: no ${k}`);
  }
  const free = await worker.fetch(req('/v1/premium/desk', `pbe_session=${JWT}`), { ...env, AUTH: authStub(verdict('free')) }, { waitUntil() {} });
  assert.equal(free.status, 403, 'signed-in but not All Access -> 403, still no data');
  const m = await worker.fetch(req('/v1/membership'), env, { waitUntil() {} });
  assert.match(m.headers.get('cache-control'), /private, no-store/); assert.equal((await m.json()).membership.label, 'FREE');
  } finally { globalThis.fetch = realFetch; }
});

function eventWithHistory() {
  const rec = JSON.parse(readFileSync(new URL('./fixtures/event-fed-oct-2026.json', import.meta.url), 'utf8'));
  const o = rec.outcomes[0];
  const h = (id, t, pct, roles = [], changed = []) => ({ forecast_id: id, t, pct, market_pct: 40, model: 'pbe-x@1.0.0', state: 'RESEARCH', confidence: 'HIGH', cutoff: t, sha: `sha-${id}`, roles, changed });
  o.history = [h('first-pub', '2026-10-03T18:00:00Z', 30, ['FIRST_PUBLISHED']), h('secret-mid-1', '2026-10-03T20:00:00Z', 35, [], [{ feature: 'nbm', from: 1, to: 2 }]), h('secret-mid-2', '2026-10-03T22:00:00Z', 38, [], [{ feature: 'nbm', from: 2, to: 3 }]), h('current', '2026-10-03T23:00:00Z', 41)];
  o.pbe_pct = 41;
  return rec;
}

test('public event view keeps the auditable record and removes the archive; premium/CSV keep everything', () => {
  const full = eventWithHistory();
  const pub = publicEventView(full);
  const ids = pub.outcomes[0].history.map((x) => x.forecast_id);
  assert.deepEqual(ids, ['first-pub', 'current'], 'designated checkpoints + current snapshot only');
  assert.equal(pub.outcomes[0].history.some((x) => 'changed' in x), false, 'no input-change ledger in the public record');
  assert.ok(pub.outcomes[0].market_path.length <= 1, 'current market observation only');
  assert.equal(pub.access.archive.snapshots, 4);
  assert.equal(premiumEventView(full).outcomes[0].history.length, 4);
  const csv = eventCsv(full);
  for (const id of ['first-pub', 'secret-mid-1', 'secret-mid-2', 'current']) assert.match(csv, new RegExp(id));
});

test('anonymous event HTML contains the public record and the All Access preview, but no member data', () => {
  const html = renderEvent(publicEventView(eventWithHistory()));
  assert.doesNotMatch(html, /secret-mid/); assert.doesNotMatch(html, /nbm: 1/);
  assert.match(html, /Scoring checkpoints/);
  assert.match(html, /id="pbe-premium" data-slug="/);
  assert.match(html, /<b class="num">4<\/b> immutable PBE snapshots/);
  assert.match(html, /10 sports \+ PropBetEdge Predictions · \$29\/month/);
  assert.match(html, /<script src="\/access\.js\?v=/);
});

test('free desk = largest headline gaps (capped) with honest totals; the full scanner is All Access', () => {
  const ev = (i, div) => ({ slug: `e${i}`, title: `E${i}`, category: 'WEATHER', headline: { pbe_pct: 50, divergence_pts: div }, max_abs_divergence: Math.abs(div), outcomes_total: 3 });
  const full = { generated_at: 'x', events: Array.from({ length: 30 }, (_, i) => ev(i, i)) };
  const pub = publicDesk(full);
  assert.equal(pub.events.length, FREE_DESK_LIMIT);
  assert.equal(pub.events[0].slug, 'e29', 'largest gap first');
  assert.deepEqual([pub.access.tier, pub.access.total_events, pub.access.total_contracts], ['free', 30, 90]);
});

test('public pages never read membership: SSR is identical for every visitor and shared-cacheable', () => {
  const src = readFileSync(new URL('../workers/pbe-predictions/src/index.js', import.meta.url), 'utf8');
  const at = src.indexOf("if (p.startsWith('/pages/events/'))");
  const pagesBlock = src.slice(at, src.indexOf('// Social cards', at));
  assert.ok(pagesBlock.length > 100);
  assert.doesNotMatch(pagesBlock, /predictionsMembership|requireAllAccess|cookie/i);
  assert.match(pagesBlock, /publicEventView\(full\)/);
  const premiumBlock = src.slice(src.indexOf("if (p === '/v1/premium/desk')"), src.indexOf('return privateJson(premiumEventView(rec));') + 50);
  assert.match(premiumBlock, /requireAllAccess/); assert.doesNotMatch(premiumBlock, /\bjson\(/, 'premium responses only via privateJson');
});
