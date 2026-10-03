// pbe-predictions — PropBetEdge Predictions real-world event engine (v1: WEATHER; MACRO next).
// Internally modular: discovery + contract normalization (src/engine/contracts.js), domain routing
// (src/engine/classify.js), weather model (src/weather/*), publication/resolution/scoring (cycle.js), API (api.js).
import { EngineStore } from '../../../src/engine/store.js';
import { runCycle } from './cycle.js';
import { board, divergences, contractRecord, queue, trackRecord } from './api.js';

const json = (data, status = 200, cache = 'public, max-age=30') => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': cache },
});

async function tokenMatches(req, expected) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || !got || got.length !== expected.length) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(got)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(a, b) : new Uint8Array(a).every((x, i) => x === new Uint8Array(b)[i]);
}

const storeFor = (env) => new EngineStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });

export default {
  async scheduled(event, env, ctx) {
    if (env.ENGINE_ENABLED !== 'true') return;
    ctx.waitUntil(runCycle(env, { store: storeFor(env) }).then((r) => console.log(JSON.stringify({ cycle: r.summary }))).catch((e) => console.error('cycle failed', e.stack || e.message)));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'POST' && p === '/admin/run') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const dry = url.searchParams.get('dry_run') !== '0';
        const r = await runCycle(env, { store: storeFor(env), dryRun: dry });
        return json(dry ? { summary: r.summary, sample: { contracts: r.writes.contracts.slice(0, 3), forecasts: r.writes.forecasts.slice(0, 3), venue: r.writes.venue.slice(0, 3) } } : { summary: r.summary }, 200, 'no-store');
      }
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, 'no-store');
      const store = storeFor(env);
      if (p === '/v1/health') return json({ ok: true, engine_enabled: env.ENGINE_ENABLED === 'true', series: String(env.WEATHER_SERIES || '').split(',') }, 200, 'no-store');
      if (p === '/v1/board') return json(await board(store, { domain: url.searchParams.get('domain') }));
      if (p === '/v1/divergences') return json({ rows: divergences(await board(store, { domain: url.searchParams.get('domain') })) });
      if (p === '/v1/queue') return json(await queue(store));
      if (p === '/v1/track-record') return json(await trackRecord(store));
      if (p.startsWith('/v1/contract/')) {
        const rec = await contractRecord(store, decodeURIComponent(p.slice('/v1/contract/'.length)));
        return rec ? json(rec) : json({ error: 'not_found' }, 404);
      }
      return json({ error: 'not_found', routes: ['/v1/health', '/v1/board?domain=WEATHER', '/v1/divergences', '/v1/queue', '/v1/track-record', '/v1/contract/:contract_id'] }, 404);
    } catch (e) {
      console.error(e.stack || e.message);
      return json({ error: 'internal_error', message: e.message }, 500, 'no-store');
    }
  },
};
