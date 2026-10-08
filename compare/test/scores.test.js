// Vendored Members score adapters: pin + drift + contract. No network (fetch stubbed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transform, MEMBERS_LIVE_SHA256 } from '../scripts/vendor-members-live.mjs';
import { loadBoard, SPORTS } from '../api/_lib/scores/adapters.js';
import { boardFor } from '../api/live.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('pin: fixture is byte-identical to Members api/live.js @ 59de9d2', () => {
  assert.equal(createHash('sha256').update(read('./fixtures/members-59de9d2/live.js.txt')).digest('hex'), MEMBERS_LIVE_SHA256);
  assert.equal(createHash('sha256').update(read('../api/_lib/scores/_media.js')).digest('hex'), '1cc661ec69a3300b7dea36888b84350c5c78c5cc9c80e506c79a0f3193c81423', '_media.js verbatim @ 59de9d2');
});

test('drift: api/_lib/scores/adapters.js equals the deterministic transform of the pinned source', () => {
  assert.equal(read('../api/_lib/scores/adapters.js'), transform(read('./fixtures/members-59de9d2/live.js.txt')));
});

test('drift: every line outside the eight documented patches is unchanged from Members', () => {
  const src = read('./fixtures/members-59de9d2/live.js.txt').split('\n');
  const out = new Set(read('../api/_lib/scores/adapters.js').split('\n'));
  const loaderEnd = src.findIndex((l) => l.startsWith('export default async function handler'));
  const changed = src.slice(0, loaderEnd).filter((l) => !out.has(l));
  assert.deepEqual(changed, [
    "import { memberAccess } from './_member-auth.js';",
    'const SOURCE_TIMEOUT_MS = 4200;',
    'async function getJson(url) {',
    "    headers: { accept: 'application/json', 'user-agent': 'PropBetEdge-Members/1.0' },",
    '      const away = teamSide(g?.away), home = teamSide(g?.home);', // PATCH 7: WNBA sides -> wnbaSide
    '  const body = await getJson(`https://nhl-api.propbetedge.ai/nhl/board?date=${date}`);',
    '        updatedAt:ev?.updated_at || body?.generated_at || null' // PATCH 8: golf keeps its board + market_id
  ]);
  assert.ok(!read('../api/_lib/scores/adapters.js').includes('memberAccess'), 'no second membership check');
  assert.match(read('../api/_lib/scores/adapters.js'), /const SOURCE_TIMEOUT_MS = 6500;/, 'Compare owns a 6.5 s direct score-source budget');
  assert.match(read('../api/_lib/scores/adapters.js'), /meta:\{ sides:m\?\.sides \|\| null \}/, 'tennis live rows preserve canonical player media');
});

test('NHL adapter sends the NHL product Origin; other sources do not', async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), origin: init?.headers?.origin ?? null }); return new Response(JSON.stringify({ games: [] }), { status: 200 }); };
  try { await loadBoard('nhl,nba'); } finally { globalThis.fetch = real; }
  assert.equal(seen.find((x) => x.url.includes('nhl-api.propbetedge.ai')).origin, 'https://nhl.propbetedge.ai');
  assert.equal(seen.find((x) => x.url.includes('nba.propbetedge.ai')).origin, null);
});

test('contract: members-live/1 shape; a failing source is "unavailable", never thrown', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('nhl-api') ? new Response('{}', { status: 403 }) : new Response(JSON.stringify({ games: [] }), { status: 200 }));
  let b;
  try { b = await loadBoard('nhl,nfl'); } finally { globalThis.fetch = real; }
  assert.equal(b.contract, 'members-live/1');
  assert.deepEqual(b.sources.map((s) => s.key).sort(), ['nfl', 'nhl']);
  const nhl = b.sources.find((s) => s.key === 'nhl');
  assert.equal(nhl.state, 'unavailable');
  assert.equal(nhl.error, 'HTTP_403');
  assert.deepEqual(SPORTS, ['mlb', 'nfl', 'nba', 'wnba', 'nhl', 'ufc', 'tennis', 'soccer', 'golf', 'f1']);
});

test('memo: one upstream board per sports key per 10 s, then refreshes', async () => {
  let calls = 0;
  const load = async () => { calls++; return { items: [] }; };
  await boardFor('memo-test', 1000, load); await boardFor('memo-test', 5000, load);
  assert.equal(calls, 1);
  await boardFor('memo-test', 12000, load);
  assert.equal(calls, 2);
});
