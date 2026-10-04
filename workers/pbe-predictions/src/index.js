// pbe-predictions — PropBetEdge Predictions real-world event engine (v1: WEATHER; MACRO next).
// Internally modular: discovery + contract normalization (src/engine/contracts.js), domain routing
// (src/engine/classify.js), weather model (src/weather/*), publication/resolution/scoring (cycle.js), API (api.js).
import { EngineStore } from '../../../src/engine/store.js';
import { runCycle } from './cycle.js';
import { prospectiveRecord } from './prospective.js';
import { verifyDecisions } from './decision-ledger.js';
import { desk, summary, calendar, models, eventRecord, contractRecord, contractToSlug, queue, trackRecord, sitemapEntries } from './api.js';
import { renderEvent, renderNotFound, sitemapXml, SITE, headlineOutcome } from './pages.js';
import { renderPng } from './og.js';
import { predictionsMembership, PRIVATE_HEADERS } from './membership.js';
import { publicEventView, premiumEventView, eventCsv, publicDesk, ALL_ACCESS_REQUIRED } from './premium.js';
import { storyImage } from './insights/images.js';
import { eventCard, cardSvg } from './og-render.js';
import { publishedStories, storyForSlug, storiesForEvent, buildStory } from './insights/service.js';
import { renderArticle, renderDesk, rssXml, newsSitemapXml } from './insights/render.js';
import { VERTICALS, storyBySlug } from './insights/stories.js';
import { FAMILIES } from '../../../src/engine/registry.js';
import { runNewsroom, evidenceView } from './newsroom/engine.js';
import { publishStory, publishedNewsroomStories } from './newsroom/publish.js';

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
async function storyBackground(story) {
  try {
    const r = await fetch(storyImage(story).og_background, { cf: { cacheTtl: 86400, cacheEverything: true } });
    return r.ok && /image\/jpeg/.test(r.headers.get('content-type') || '') ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch { return null; }
}

async function cachedPng(req, ctx, render, opts = {}) {
  const cache = caches.default;
  const key = new Request(req.url, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = png(await renderPng(await render(), opts));
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// Member-only and identity responses: private, no-store, Vary: Cookie (never in a shared cache).
const privateJson = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS } });
async function requireAllAccess(req, env) {
  const m = await predictionsMembership(req, env);
  if (m.membership.entitled) return { ok: true, m };
  return { ok: false, res: privateJson({ ...ALL_ACCESS_REQUIRED, authenticated: m.authenticated, membership: { state: m.membership.state, label: m.membership.label } }, m.authenticated ? 403 : 401) };
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
      // prediction-decision-v1 DRAFT preview (owner review before CALL becomes a public state): every live modeled
      // outcome's decision, evidence integrity and both venues at the current forecast. Admin only, never cached.
      if (req.method === 'GET' && p === '/admin/decisions/verify') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        return json(await verifyDecisions(storeFor(env)), 200, 'no-store');
      }
      if (req.method === 'GET' && p === '/admin/decisions/prospective') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        return json(await prospectiveRecord(storeFor(env)), 200, 'no-store');
      }
      if (req.method === 'GET' && p === '/admin/decisions') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const st = storeFor(env);
        const d = await desk(st);
        const rows = [];
        for (const ev of d.events.filter((x) => x.outcomes_modeled > 0)) {
          const rec = await eventRecord(st, ev.slug);
          for (const o of rec?.outcomes || []) {
            if (!o.call) continue;
            const atF = (v) => (v ? v.at_forecast.at(-1) : null);
            const dr = o.call.evidence.drivers[0];
            rows.push({ slug: ev.slug, label: o.label, pbe_pct: o.call.pbe_pct, confidence: o.call.confidence, model: o.call.model, data_cutoff_at: o.call.data_cutoff_at, decision: o.call.decision, integrity: o.call.evidence.integrity, evidence_sha256: o.call.evidence_sha256, driver: dr ? `${dr.label} ${dr.display}${dr.unit}` : null, kalshi_at_forecast: atF(o.venues.kalshi)?.benchmark ?? null, polymarket: o.venues.polymarket ? { semantic_class: o.venues.polymarket.semantic_class, at_forecast: atF(o.venues.polymarket)?.benchmark ?? null } : null });
          }
        }
        const count = (k) => rows.reduce((a, r) => { const key = k(r); a[key] = (a[key] || 0) + 1; return a; }, {});
        return json({ policy: rows[0] ? { version: rows[0].decision.policy, status: rows[0].decision.policy_status } : null, n: rows.length, by_state: count((r) => (r.decision.state === 'CALL' ? `CALL_${r.decision.side}` : r.decision.state)), by_reason: count((r) => r.decision.reasons.join('+') || 'CALL'), integrity_failures: rows.filter((r) => !r.integrity.ok).length, rows }, 200, 'no-store');
      }
      // Automated Newsroom V1 — DRY RUN ONLY (no writes, nothing published): candidates, holds, evidence packets, previews
      // Manual, admin-only publication of ONE validated story (automatic publication does not exist in V1).
      if (req.method === 'POST' && p.startsWith('/admin/newsroom/publish/')) {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (env.NEWSROOM_MANUAL_PUBLISH !== 'true') return json({ error: 'manual publication disabled (NEWSROOM_MANUAL_PUBLISH)' }, 403, 'no-store');
        const store = storeFor(env);
        const sid = decodeURIComponent(p.slice('/admin/newsroom/publish/'.length));
        const fams = (await models(store)).families;
        const r = await runNewsroom(store, { familyResolved: Object.fromEntries(fams.map((f) => [f.id, f.resolved])) });
        const s = r.stories.find((x) => x.story_id === sid);
        if (!s) return json({ error: 'not_found_in_current_run' }, 404, 'no-store');
        const out = await publishStory(store, s, { note: url.searchParams.get('note') });
        if (out.ok) await publishedNewsroomStories(store, { fresh: true });
        return json(out, out.ok ? 200 : 409, 'no-store');
      }
      if (req.method === 'GET' && (p === '/admin/newsroom' || p.startsWith('/admin/newsroom/'))) {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const store = storeFor(env);
        const now = url.searchParams.get('now') || new Date().toISOString();
        const fams = (await models(store)).families;
        const r = await runNewsroom(store, { now, familyResolved: Object.fromEntries(fams.map((f) => [f.id, f.resolved])) });
        const rest = p.slice('/admin/newsroom'.length).replace(/^\//, '');
        if (!rest) return json({ ...r, stories: r.stories.map((s) => ({ story_id: s.story_id, class: s.class, state: s.state, reason: s.reason ?? null, slug: s.slug ?? null, title: s.built?.title ?? null, trigger: s.trigger, preview: s.state === 'VALIDATED' ? `/admin/newsroom/preview/${s.story_id}` : null, evidence: `/admin/newsroom/evidence/${s.story_id}` })) }, 200, 'no-store');
        const [kind, sid] = rest.split('/');
        const s = r.stories.find((x) => x.story_id === sid);
        if (!s) return json({ error: 'not_found' }, 404, 'no-store');
        if (kind === 'evidence') return json(evidenceView(s), 200, 'no-store');
        if (kind === 'card' && s.built) return png(await renderPng(cardSvg(s.built.card)), 'no-store');
        if (kind === 'preview' && s.built) {
          const live = await eventRecord(store, s.def.primary);
          return html(renderArticle(s.def, s.built, { live, related: [], model: FAMILIES.find((f) => f.id === live?.event.model_family) || null }).replace('content="index,follow,max-image-preview:large"', 'content="noindex"'), 200, 'no-store');
        }
        return json({ error: 'not_available', state: s.state, reason: s.reason ?? null }, 409, 'no-store');
      }
      // pre-publication QA: renders a story regardless of its publish time (admin token only, never indexed)
      if (req.method === 'GET' && p.startsWith('/admin/insights/')) {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const st = storyBySlug(decodeURIComponent(p.slice('/admin/insights/'.length)));
        const store = storeFor(env);
        const item = st ? await buildStory(store, st) : null;
        if (!item) return json({ error: 'unavailable' }, 404, 'no-store');
        if (url.searchParams.get('card') === '1') return png(await renderPng(cardSvg(item.built.card), { background: await storyBackground(st) }), 'no-store');
        const [live, d] = await Promise.all([eventRecord(store, st.primary), desk(store)]);
        const exclude = new Set(st.events);
        const related = d.events.filter((e) => e.category === live?.event.category && !exclude.has(e.slug) && e.state !== 'MARKET_MONITORING').sort((x, y) => y.max_abs_divergence - x.max_abs_divergence).slice(0, 4);
        return html(renderArticle(st, item.built, { live, related, model: FAMILIES.find((f) => f.id === live?.event.model_family) || null, words: item.words }).replace('content="index,follow,max-image-preview:large"', 'content="noindex"'), 200, 'no-store');
      }
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, 'no-store');
      const store = storeFor(env);
      if (p === '/v1/health') return json({ ok: true, engine_enabled: env.ENGINE_ENABLED === 'true', series: { weather: env.WEATHER_SERIES, macro: env.MACRO_SERIES, rates: env.RATES_SERIES, monitor: env.MONITOR_SERIES } }, 200, 'no-store');
      if (p === '/v1/summary') return json(await summary(store));
      if (p === '/v1/desk') return json(publicDesk(await desk(store, { venues: true })));
      // Membership + All Access (Predictions is an All-Access-only product surface; network authority decides)
      if (p === '/v1/membership') { const m = await predictionsMembership(req, env); return privateJson({ authenticated: m.authenticated, membership: m.membership }); }
      if (p === '/v1/premium/desk') { const g = await requireAllAccess(req, env); if (!g.ok) return g.res; return privateJson({ ...(await desk(store, { venues: true })), access: { tier: 'all_access' } }); }
      if (p.startsWith('/v1/premium/event/')) {
        const g = await requireAllAccess(req, env); if (!g.ok) return g.res;
        const rest = decodeURIComponent(p.slice('/v1/premium/event/'.length));
        const csv = rest.endsWith('.csv');
        const slug = csv ? rest.slice(0, -4) : rest;
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return privateJson({ error: 'not_found' }, 404);
        const rec = await eventRecord(store, slug);
        if (!rec) return privateJson({ error: 'not_found' }, 404);
        if (csv) return new Response(eventCsv(rec), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="pbe-${slug}.csv"`, ...PRIVATE_HEADERS } });
        return privateJson(premiumEventView(rec));
      }
      if (p === '/v1/calendar') return json(await calendar(store));
      if (p === '/v1/models') return json(await models(store), 200, 'public, max-age=120');
      if (p === '/v1/queue') return json(await queue(store));
      if (p === '/v1/track-record') return json(await trackRecord(store));
      if (p.startsWith('/v1/event/')) {
        const rec = await eventRecord(store, decodeURIComponent(p.slice('/v1/event/'.length)));
        return rec ? json(publicEventView(rec)) : json({ error: 'not_found' }, 404);
      }
      if (p.startsWith('/v1/contract/')) {
        const rec = await contractRecord(store, decodeURIComponent(p.slice('/v1/contract/'.length)));
        return rec ? json(publicEventView(rec)) : json({ error: 'not_found' }, 404);
      }
      // server-rendered pages (Vercel rewrites predictions.propbetedge.ai/events/:slug, /record, /sitemap.xml here)
      if (p.startsWith('/pages/events/')) {
        const slug = decodeURIComponent(p.slice('/pages/events/'.length));
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return html(renderNotFound(`/events/${slug}`), 404);
        const full = await eventRecord(store, slug);
        const rec = full ? publicEventView(full) : null; // public SSR never carries the member archive
        // Multi-venue panel on every event page (?mv=1 canary removed 2026-10-04): hidden until a second venue has
        // stored observations or a related venue market exists; the shared Worker's kill switch governs both.
        return rec ? html(renderEvent(rec, { stories: (await storiesForEvent(store, slug)).map((s) => ({ slug: s.slug, title: s.link_title, family_label: s.family_label, published_at: s.published_at })), multiVenue: true })) : html(renderNotFound(`/events/${slug}`), 404);
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
        return cachedPng(req, ctx, () => cardSvg(item.built.card), { background: await storyBackground(item.story) });
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
