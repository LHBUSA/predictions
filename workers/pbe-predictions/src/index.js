// pbe-predictions — PropBetEdge Predictions real-world event engine (v1: WEATHER; MACRO next).
// Internally modular: discovery + contract normalization (src/engine/contracts.js), domain routing
// (src/engine/classify.js), weather model (src/weather/*), publication/resolution/scoring (cycle.js), API (api.js).
import { EngineStore } from '../../../src/engine/store.js';
import { runCycle } from './cycle.js';
import { desk, summary, calendar, models, eventRecord, contractRecord, contractToSlug, queue, trackRecord, sitemapEntries } from './api.js';
import { renderEvent, renderNotFound, sitemapXml, SITE } from './pages.js';

// no-transform + Vary: Vercel's external-rewrite cache ignores Accept-Encoding (network incident 2026-10-02).
const json = (data, status = 200, cache = 'public, max-age=30') => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': `${cache}, no-transform`, vary: 'Accept-Encoding' },
});
const html = (body, status = 200, cache = 'public, max-age=60') => new Response(body, {
  status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `${cache}, no-transform`, vary: 'Accept-Encoding', 'x-content-type-options': 'nosniff' },
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
        return json(dry ? {
          summary: r.summary,
          fail_closed: r.writes.contracts.filter((c) => c.normalization_status !== 'NORMALIZED').map((c) => ({ market_id: c.market_id, status: c.normalization_status, reason: c.status_reason, detail: c.detail, rules: c.rules_primary })),
          forecasts: r.writes.forecasts.map((f) => ({ market_id: f.market_id, model: `${f.model_id}@${f.model_version}`, state: f.model_state, pbe: f.probability, market: f.market_probability, confidence: f.confidence, cutoff: f.data_cutoff_at, evidence: f.explanation.evidence, tier: f.explanation.model_tier ?? null })),
        } : { summary: r.summary }, 200, 'no-store');
      }
      if (req.method === 'GET' && p.startsWith('/admin/contract/')) {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const rec = await contractRecord(storeFor(env), decodeURIComponent(p.slice('/admin/contract/'.length)), { includeShadow: true });
        return rec ? json(rec, 200, 'no-store') : json({ error: 'not_found' }, 404, 'no-store');
      }
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, 'no-store');
      const store = storeFor(env);
      if (p === '/v1/health') return json({ ok: true, engine_enabled: env.ENGINE_ENABLED === 'true', series: { weather: env.WEATHER_SERIES, macro: env.MACRO_SERIES, rates: env.RATES_SERIES, monitor: env.MONITOR_SERIES } }, 200, 'no-store');
      if (p === '/v1/summary') return json(await summary(store));
      if (p === '/v1/desk') return json(await desk(store));
      if (p === '/v1/calendar') return json(await calendar(store));
      if (p === '/v1/models') return json(await models(store), 200, 'public, max-age=120');
      if (p === '/v1/queue') return json(await queue(store));
      if (p === '/v1/track-record') return json(await trackRecord(store));
      if (p.startsWith('/v1/event/')) {
        const rec = await eventRecord(store, decodeURIComponent(p.slice('/v1/event/'.length)));
        return rec ? json(rec) : json({ error: 'not_found' }, 404);
      }
      if (p.startsWith('/v1/contract/')) {
        const rec = await contractRecord(store, decodeURIComponent(p.slice('/v1/contract/'.length)));
        return rec ? json(rec) : json({ error: 'not_found' }, 404);
      }
      // server-rendered pages (Vercel rewrites predictions.propbetedge.ai/events/:slug, /record, /sitemap.xml here)
      if (p.startsWith('/pages/events/')) {
        const slug = decodeURIComponent(p.slice('/pages/events/'.length));
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return html(renderNotFound(`/events/${slug}`), 404);
        const rec = await eventRecord(store, slug);
        return rec ? html(renderEvent(rec)) : html(renderNotFound(`/events/${slug}`), 404);
      }
      if (p === '/pages/record') {
        const id = url.searchParams.get('id') || '';
        const ref = id ? await contractToSlug(store, id) : null;
        return ref ? new Response(null, { status: 301, headers: { location: `${SITE}/events/${ref.slug}#${encodeURIComponent(ref.market_id)}`, 'cache-control': 'public, max-age=3600' } }) : html(renderNotFound('/record/'), 404);
      }
      if (p === '/sitemap.xml') return new Response(sitemapXml(await sitemapEntries(store)), { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=900, no-transform', vary: 'Accept-Encoding' } });
      return json({ error: 'not_found', routes: ['/v1/health', '/v1/summary', '/v1/desk', '/v1/calendar', '/v1/models', '/v1/track-record', '/v1/queue', '/v1/event/:slug', '/v1/contract/:contract_id'] }, 404);
    } catch (e) {
      console.error(e.stack || e.message);
      return json({ error: 'internal_error', message: e.message }, 500, 'no-store');
    }
  },
};
