// pbe-predictions — PropBetEdge Predictions real-world event engine (v1: WEATHER; MACRO next).
// Internally modular: discovery + contract normalization (src/engine/contracts.js), domain routing
// (src/engine/classify.js), weather model (src/weather/*), publication/resolution/scoring (cycle.js), API (api.js).
import { EngineStore } from '../../../src/engine/store.js';
import { runCycle } from './cycle.js';
import { desk, summary, calendar, models, eventRecord, contractRecord, contractToSlug, queue, trackRecord, sitemapEntries } from './api.js';
import { renderEvent, renderNotFound, sitemapXml, SITE, headlineOutcome } from './pages.js';
import { renderPng } from './og.js';
import { eventCard, cardSvg } from './og-render.js';
import { publishedStories, storyForSlug, storiesForEvent, buildStory } from './insights/service.js';
import { renderArticle, renderDesk, rssXml, newsSitemapXml } from './insights/render.js';
import { VERTICALS, storyBySlug } from './insights/stories.js';
import { FAMILIES } from '../../../src/engine/registry.js';

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

const png = (bytes, cache = 'public, max-age=900, s-maxage=900') => new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': `${cache}, no-transform`, 'x-content-type-options': 'nosniff' } });
const xml = (body, type = 'application/xml') => new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'public, max-age=900, no-transform', vary: 'Accept-Encoding' } });

// Social cards are cached at the edge by full URL (event cards carry a ?v= content key).
async function cachedPng(req, ctx, render) {
  const cache = caches.default;
  const key = new Request(req.url, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = png(await renderPng(await render()));
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

const storeFor = (env) => new EngineStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });

export default {
  async scheduled(event, env, ctx) {
    if (env.ENGINE_ENABLED !== 'true') return;
    ctx.waitUntil(runCycle(env, { store: storeFor(env) }).then((r) => console.log(JSON.stringify({ cycle: r.summary }))).catch((e) => console.error('cycle failed', e.stack || e.message)));
  },

  async fetch(req, env, ctx) {
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
      // pre-publication QA: renders a story regardless of its publish time (admin token only, never indexed)
      if (req.method === 'GET' && p.startsWith('/admin/insights/')) {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const st = storyBySlug(decodeURIComponent(p.slice('/admin/insights/'.length)));
        const store = storeFor(env);
        const item = st ? await buildStory(store, st) : null;
        if (!item) return json({ error: 'unavailable' }, 404, 'no-store');
        if (url.searchParams.get('card') === '1') return png(await renderPng(cardSvg(item.built.card)), 'no-store');
        const [live, d] = await Promise.all([eventRecord(store, st.primary), desk(store)]);
        const exclude = new Set(st.events);
        const related = d.events.filter((e) => e.category === live?.event.category && !exclude.has(e.slug) && e.state !== 'MARKET_MONITORING').sort((x, y) => y.max_abs_divergence - x.max_abs_divergence).slice(0, 4);
        return html(renderArticle(st, item.built, { live, related, model: FAMILIES.find((f) => f.id === live?.event.model_family) || null, words: item.words }).replace('content="index,follow,max-image-preview:large"', 'content="noindex"'), 200, 'no-store');
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
        return rec ? html(renderEvent(rec, { stories: storiesForEvent(slug).map((s) => ({ slug: s.slug, title: s.link_title, family_label: s.family_label, published_at: s.published_at })) })) : html(renderNotFound(`/events/${slug}`), 404);
      }
      // Social cards (Vercel rewrites /og/events/* and /og/insights/* here)
      if (p.startsWith('/og/events/') && p.endsWith('.png')) {
        const slug = decodeURIComponent(p.slice('/og/events/'.length, -4));
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return json({ error: 'not_found' }, 404);
        const rec = await eventRecord(store, slug);
        if (!rec) return json({ error: 'not_found' }, 404);
        return cachedPng(req, ctx, () => eventCard(rec, headlineOutcome(rec)));
      }
      if (p.startsWith('/og/insights/') && p.endsWith('.png')) {
        const item = await storyForSlug(store, decodeURIComponent(p.slice('/og/insights/'.length, -4)));
        if (!item) return json({ error: 'not_found' }, 404);
        return cachedPng(req, ctx, () => cardSvg(item.built.card));
      }
      // Prediction Intelligence (Vercel rewrites /insights/* here)
      if (p === '/pages/insights/rss.xml') return xml(rssXml(await publishedStories(store)), 'application/rss+xml');
      if (p === '/news-sitemap.xml') return xml(newsSitemapXml(await publishedStories(store)));
      if (p === '/pages/insights' || p.startsWith('/pages/insights/')) {
        const rest = decodeURIComponent(p.slice('/pages/insights'.length).replace(/^\//, ''));
        const items = await publishedStories(store);
        if (!items.length) return html(renderNotFound('/insights/'), 404);
        if (!rest || VERTICALS[rest]) {
          if (rest && !items.some((i) => i.story.vertical === rest)) return html(renderNotFound(`/insights/${rest}/`), 404);
          const d = await desk(store);
          const gaps = d.events.filter((e) => e.headline?.divergence_pts !== null && e.headline?.divergence_pts !== undefined && e.state !== 'MARKET_MONITORING' && (!rest || e.category.toLowerCase().replace('_', '-') === rest)).sort((a, b) => Math.abs(b.headline.divergence_pts) - Math.abs(a.headline.divergence_pts)).slice(0, 6);
          const cal = (await calendar(store)).events.filter((e) => !rest || e.category.toLowerCase().replace('_', '-') === rest).slice(0, 6);
          const mods = (await models(store)).families.filter((f) => f.state !== 'SHADOW' && f.state !== 'MONITORING');
          return html(renderDesk({ items, vertical: rest || null, gaps, calendar: cal, models: mods }), 200, 'public, max-age=120');
        }
        if (!/^[a-z0-9-]{3,160}$/.test(rest)) return html(renderNotFound(`/insights/${rest}`), 404);
        const item = items.find((i) => i.story.slug === rest);
        if (!item) return html(renderNotFound(`/insights/${rest}`), 404);
        const [live, d] = await Promise.all([eventRecord(store, item.story.primary), desk(store)]);
        const cat = live?.event.category;
        const exclude = new Set(item.story.events);
        const related = d.events.filter((e) => e.category === cat && !exclude.has(e.slug) && e.state !== 'MARKET_MONITORING').sort((a, b) => b.max_abs_divergence - a.max_abs_divergence).slice(0, 4);
        const fam = FAMILIES.find((f) => f.id === live?.event.model_family) || null;
        return html(renderArticle(item.story, item.built, { live, related, model: fam, words: item.words }), 200, 'public, max-age=120');
      }
      if (p.startsWith('/v1/insights/')) {
        const item = await storyForSlug(store, decodeURIComponent(p.slice('/v1/insights/'.length)));
        return item ? json({ slug: item.story.slug, family: item.story.family, vertical: item.story.vertical, published_at: item.story.published_at, data_as_of: item.story.as_of, events: item.story.events, title: item.built.title, evidence: item.built.ledger, resolution_rule: item.built.rule }) : json({ error: 'not_found' }, 404);
      }
      if (p === '/pages/record') {
        const id = url.searchParams.get('id') || '';
        const ref = id ? await contractToSlug(store, id) : null;
        return ref ? new Response(null, { status: 301, headers: { location: `${SITE}/events/${ref.slug}#${encodeURIComponent(ref.market_id)}`, 'cache-control': 'public, max-age=3600' } }) : html(renderNotFound('/record/'), 404);
      }
      if (p === '/sitemap.xml') return new Response(sitemapXml(await sitemapEntries(store), (await publishedStories(store)).map((i) => ({ slug: i.story.slug, vertical: i.story.vertical, published_at: i.story.published_at }))), { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=900, no-transform', vary: 'Accept-Encoding' } });
      return json({ error: 'not_found', routes: ['/v1/health', '/v1/summary', '/v1/desk', '/v1/calendar', '/v1/models', '/v1/track-record', '/v1/queue', '/v1/event/:slug', '/v1/contract/:contract_id'] }, 404);
    } catch (e) {
      console.error(e.stack || e.message);
      return json({ error: 'internal_error', message: e.message }, 500, 'no-store');
    }
  },
};
