// pbe-predictions — PropBetEdge Predictions real-world event engine (v1: WEATHER; MACRO next).
// Internally modular: discovery + contract normalization (src/engine/contracts.js), domain routing
// (src/engine/classify.js), weather model (src/weather/*), publication/resolution/scoring (cycle.js), API (api.js).
import { runBtcShadow } from '../../../src/crypto/btc-shadow.js';
import { robinhoodConfigured, robinhoodForEnv, robinhoodCredentialFingerprint } from './robinhood-crypto.js';
import { MarketsService } from './markets.js';
import { EngineStore } from '../../../src/engine/store.js';
import { runCycle } from './cycle.js';
import { newsroomCycle } from './newsroom/auto.js';
import { CRONS, laneFor, runLane, countingFetch, countingBinding, coreCounts, NEWSROOM_MAX_CORE_AGE_MIN } from './engine-runs.js';
import { runHotLane } from './hot-lane.js';
import { intradayForStation } from './intraday-live.js';
import { callBlock, stationBlock, marketView } from './record-blocks.js';
import { liveWeatherBlock } from './weather-blocks.js';
import { prospectiveRecord } from './prospective.js';
import { verifyDecisions, loadDecisionInputs } from './decision-ledger.js';
import { buildDecisionRecord } from '../../../src/engine/decision-record.js';
import { desk, summary, calendar, models, eventRecord, contractRecord, contractToSlug, queue, trackRecord, sitemapEntries } from './api.js';
import { memberScorecard, limitRows } from './results-board.js';
import { featuredForMember, featuredForPreview } from './featured.js';
import { renderEvent, renderNotFound, sitemapXml, SITE, headlineOutcome, eventIntel } from './pages.js';
import { renderPng } from './og.js';
import { predictionsMembership, PRIVATE_HEADERS } from './membership.js';
import { publicEventShell, premiumEventView, eventCsv, deskPreview, ALL_ACCESS_REQUIRED, ENTITLEMENT_UNAVAILABLE } from './premium.js';
import { storyImage } from './insights/images.js';
import { eventCard, cardSvg } from './og-render.js';
import { publishedStories, storyForSlug, storiesForEvent, buildStory } from './insights/service.js';
import { cachedInsightsDesk } from './insights/page-cache.js';
import { renderArticle, renderDesk, rssXml, newsSitemapXml, liveUpdate } from './insights/render.js';
import { VERTICALS, storyBySlug } from './insights/stories.js';
import { FAMILIES } from '../../../src/engine/registry.js';
import { runNewsroom, evidenceView } from './newsroom/engine.js';
import { runIntradayScoring, intradayReport, intradayScoringDue, shadowCompareReport } from './intraday-scoring.js';
import { runCpiShadow, cpiShadowDue } from './cpi-shadow.js';
import { cpiShadowReport, renderCpiShadowHtml } from './cpi-shadow-report.js';
import { shadowEvaluationReport } from '../../../src/weather/intraday/shadow.js';
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
const privateJson = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS, ...extra } });
// The ONE server-side gate for Predictions intelligence (All Access or owner). Not entitled -> no payload:
// anonymous 401, signed in without All Access 403, entitlement unverifiable 503 (retry; never treated as unsubscribed).
async function requireAllAccess(req, env) {
  const m = await predictionsMembership(req, env);
  if (m.membership.entitled) return { ok: true, m };
  const membership = { state: m.membership.state, label: m.membership.label };
  if (m.membership.state === 'unverified') return { ok: false, res: privateJson({ ...ENTITLEMENT_UNAVAILABLE, membership }, 503, { 'retry-after': '5' }) };
  return { ok: false, res: privateJson({ ...ALL_ACCESS_REQUIRED, authenticated: m.authenticated, membership }, m.authenticated ? 403 : 401) };
}

export const BTC_SHADOW_CRON = CRONS.FAST;
const storeFor = (env, fetchImpl) => new EngineStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY, ...(fetchImpl ? { fetchImpl } : {}) });

export default {
  async scheduled(event, env, ctx) {
    // BTC 15-minute nowcast SHADOW (src/crypto/btc-shadow.js): its own 1-minute cron, isolated pred_crypto_* tables,
    // never the engine cycle below. Off unless CRYPTO_SHADOW = "true" (sql/009 applied).
    if (event.cron === BTC_SHADOW_CRON) {
      // HOT lane (weather freshness): independent of the BTC gate, its own waitUntil + catch, hard-capped subrequests.
      if (env.HOT_LANE === 'true') ctx.waitUntil(runHotLane(env, { store: storeFor(env), now: new Date(event.scheduledTime || Date.now()).toISOString(), onNewObservations: env.INTRADAY_LIVE === 'true' ? (st, fresh, { spend, now }) => intradayForStation(storeFor(env), st, { now, spend, shadow: env.INTRADAY_SHADOW_V22 === 'true' }).then((r) => console.log(JSON.stringify({ intraday: r }))) : null })
        .then((r) => console.log(JSON.stringify({ hot_lane: r }))).catch((e) => console.error('hot lane failed', e.stack || e.message)));
      // INTRADAY SCORING (designation-intraday/1, sql/013): :04 and :34, own waitUntil, never inside the core cycle.
      const minuteAt = new Date(event.scheduledTime || Date.now()).toISOString();
      if (env.INTRADAY_SCORING === 'true' && intradayScoringDue(minuteAt)) ctx.waitUntil(runIntradayScoring(storeFor(env), { now: minuteAt })
        .then((r) => console.log(JSON.stringify({ intraday_scoring: r }))).catch((e) => console.error('intraday scoring failed', e.stack || e.message)));
      // CPI V1 PRIVATE SHADOW (sql/015): :09 and :39, own waitUntil, never inside the core cycle. Kill switch CPI_SHADOW.
      if (env.CPI_SHADOW === 'true' && cpiShadowDue(minuteAt)) ctx.waitUntil(runCpiShadow({ store: storeFor(env), mkt: new MarketsService({ binding: env.MARKETS, token: env.MARKETS_READ_TOKEN }), now: minuteAt })
        .then((r) => console.log(JSON.stringify({ cpi_shadow: r }))).catch((e) => console.error('cpi shadow failed', e.stack || e.message)));
      if (env.CRYPTO_SHADOW !== 'true') return;
      ctx.waitUntil(runBtcShadow({ store: storeFor(env), mkt: new MarketsService({ binding: env.MARKETS, token: env.MARKETS_READ_TOKEN }), settlements: env.CRYPTO_SETTLEMENTS === 'true' })
        .then((r) => console.log(JSON.stringify({ btc_shadow: r }))).catch((e) => console.error('btc shadow failed', e.stack || e.message)));
      return;
    }
    if (env.ENGINE_ENABLED !== 'true') return;
    const lane = laneFor(event.cron);
    if (!lane || lane === 'fast') { console.error(JSON.stringify({ unknown_cron: event.cron })); return; }
    const scheduledAt = new Date(event.scheduledTime || Date.now()).toISOString();
    const workerVersion = env.CF_VERSION_METADATA?.id ?? null;
    const ledger = env.ENGINE_RUNS === 'true';
    if (lane === 'core') {
      // CORE lane: runCycle only (never the newsroom), under the atomic lease + run ledger (sql/011, ENGINE_RUNS).
      const work = async () => {
        const supa = countingFetch(); const mk = countingBinding(env.MARKETS); const ext = countingFetch();
        const r = await runCycle(env, { store: storeFor(env, supa.fetch), markets: new MarketsService({ binding: mk.binding, token: env.MARKETS_READ_TOKEN }), fetchImpl: ext.fetch });
        console.log(JSON.stringify({ cycle: r.summary }));
        return { counts: coreCounts(r.summary, supa.counts, mk.counts, ext.counts) };
      };
      ctx.waitUntil((ledger ? runLane({ store: storeFor(env), lane, cron: event.cron, scheduledAt, workerVersion, work }) : work())
        .then((r) => console.log(JSON.stringify({ core_run: { ...r, counts: r.counts } }))).catch((e) => console.error('core lane failed', e.stack || e.message)));
      return;
    }
    // NEWSROOM lane (every 5 min): consumes the latest SUCCESSFUL core run; never triggers an engine run.
    const work = async () => {
      const store = storeFor(env);
      let cycleAt = scheduledAt; let engineCompletedAt = null; let engineOk = false;
      if (ledger) {
        const ok = (await store.select('pred_engine_runs', { lane: 'eq.core', transition: 'eq.COMPLETED', select: 'scheduled_at,at' }, { limit: 1, order: 'transition_id.desc' }))[0];
        if (ok && Date.parse(scheduledAt) - Date.parse(ok.at) <= NEWSROOM_MAX_CORE_AGE_MIN * 60000) { cycleAt = ok.scheduled_at; engineCompletedAt = ok.at; engineOk = true; }
      } else { engineOk = true; engineCompletedAt = scheduledAt; }
      const r = await newsroomCycle(env, store, { cycleAt, engineCompletedAt, engineOk });
      console.log(JSON.stringify({ newsroom: r }));
      return { counts: { engine_ok: engineOk, core_completed_at: engineCompletedAt, published: r?.published?.length ?? r?.publish?.published ?? null } };
    };
    ctx.waitUntil((ledger ? runLane({ store: storeFor(env), lane, cron: event.cron, scheduledAt, workerVersion, work }) : work())
      .then((r) => console.log(JSON.stringify({ newsroom_run: r }))).catch((e) => console.error('newsroom lane failed', e.stack || e.message)));
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
      if (req.method === 'GET' && p === '/admin/crypto/robinhood') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false, mode: 'READ_ONLY_MARKET_DATA' }, 503, 'no-store');
        const rh = robinhoodForEnv(env);
        try {
          const [pairs, quotes, estimate] = await Promise.all([
            rh.tradingPairs(['BTC-USD', 'ETH-USD']),
            rh.bestBidAsk(['BTC-USD', 'ETH-USD']),
            rh.estimatedPrice('BTC-USD', { side: 'both', quantity: '0.01' }),
          ]);
          return json({
            ok: true,
            configured: true,
            mode: 'READ_ONLY_MARKET_DATA',
            trading_enabled: false,
            api_key_suffix: String(env.ROBINHOOD_CRYPTO_API_KEY).slice(-4),
            pairs,
            quotes,
            estimate,
          }, 200, 'no-store');
        } catch (e) {
          return json({
            ok: false,
            configured: true,
            mode: 'READ_ONLY_MARKET_DATA',
            trading_enabled: false,
            status: e?.status ?? null,
            error: e?.message ?? 'robinhood_read_failed',
          }, 502, 'no-store');
        }
      }
      if (req.method === 'GET' && p === '/admin/crypto/robinhood/account') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false }, 503, 'no-store');
        const rh = robinhoodForEnv(env);
        try {
          const accounts = await rh.accounts();
          const account = accounts?.results?.[0] ?? null;
          if (!account?.account_number) return json({ ok: false, error: 'no_crypto_account' }, 404, 'no-store');
          const [holdings, orders, pairs] = await Promise.all([
            rh.holdings(account.account_number),
            rh.orders(account.account_number),
            rh.tradingPairs(),
          ]);
          const tradable = (pairs?.results || []).filter((x) => x?.is_api_tradable === true).map((x) => x.symbol);
          return json({
            ok: true,
            configured: true,
            trading_enabled: false,
            account,
            holdings,
            orders,
            api_tradable_symbols: tradable,
          }, 200, 'no-store');
        } catch (e) {
          return json({ ok: false, configured: true, status: e?.status ?? null, error: e?.message ?? 'robinhood_account_read_failed', detail: e?.detail ?? null }, 502, 'no-store');
        }
      }
      if (req.method === 'GET' && p === '/admin/crypto/robinhood/preflight') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false }, 503, 'no-store');
        const rh = robinhoodForEnv(env);
        const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
        try {
          const accounts = await rh.accounts();
          const account = accounts?.results?.[0] ?? null;
          if (!account?.account_number) return json({ ok: false, error: 'no_crypto_account' }, 404, 'no-store');
          const [pairs, quotes] = await Promise.all([
            rh.tradingPairs(symbols),
            rh.bestBidAsk(symbols),
          ]);
          const bySymbol = Object.fromEntries((pairs?.results || []).map((x) => [x.symbol, x]));
          return json({
            ok: true,
            configured: true,
            authenticated: true,
            account_status: account.status ?? null,
            account_api_tradable: account.is_api_tradable === true,
            buying_power: account.buying_power ?? null,
            buying_power_currency: account.buying_power_currency ?? null,
            symbols: symbols.map((symbol) => ({
              symbol,
              api_tradable: bySymbol[symbol]?.is_api_tradable === true,
            })),
            quotes,
            live_order_submission_enabled: false,
          }, 200, 'no-store');
        } catch (e) {
          return json({ ok: false, configured: true, status: e?.status ?? null, error: e?.message ?? 'robinhood_preflight_failed', detail: e?.detail ?? null }, 502, 'no-store');
        }
      }
      if (req.method === 'GET' && p === '/admin/crypto/robinhood/execution-intelligence') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false }, 503, 'no-store');
        const rh = robinhoodForEnv(env);
        const ladderUsd = [10, 25, 50, 100];
        const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
        try {
          const accounts = await rh.accounts();
          const account = accounts?.results?.[0] ?? null;
          if (!account?.account_number) return json({ ok: false, error: 'no_crypto_account' }, 404, 'no-store');
          const [holdings, orders, pairs, quotes] = await Promise.all([
            rh.holdings(account.account_number),
            rh.orders(account.account_number),
            rh.tradingPairs(symbols),
            rh.bestBidAsk(symbols),
          ]);
          const pairBy = Object.fromEntries((pairs?.results || []).map((x) => [x.symbol, x]));
          const quoteBy = Object.fromEntries((quotes?.results || []).map((x) => [x.symbol, x]));
          const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
          const ladders = {};
          for (const symbol of symbols) {
            const q = quoteBy[symbol] || {};
            const rawBid = num(q.bid); const rawAsk = num(q.ask);
            const rawMid = rawBid != null && rawAsk != null ? (rawBid + rawAsk) / 2 : null;
            if (!(rawMid > 0)) { ladders[symbol] = []; continue; }
            const rows = [];
            for (const usd of ladderUsd) {
              const quantity = (usd / rawMid).toPrecision(12);
              const est = await rh.estimatedPrice(symbol, { side: 'both', quantity });
              const er = est?.results || [];
              const sell = er.find((x) => x?.side === 'bid') || null;
              const buy = er.find((x) => x?.side === 'ask') || null;
              const qty = num(quantity);
              const sellCredit = num(sell?.est_total_credit);
              const buyCost = num(buy?.est_total_cost);
              const netSell = qty > 0 && sellCredit != null ? sellCredit / qty : null;
              const grossBuy = qty > 0 && buyCost != null ? buyCost / qty : null;
              const mid = netSell != null && grossBuy != null ? (netSell + grossBuy) / 2 : null;
              rows.push({
                usd,
                quantity,
                net_sell: netSell,
                gross_buy: grossBuy,
                total_friction_bps: mid > 0 && netSell != null && grossBuy != null ? ((grossBuy - netSell) / mid) * 10000 : null,
                fee_ratio: num(buy?.fee_ratio ?? sell?.fee_ratio),
                timestamp: buy?.timestamp || sell?.timestamp || null,
              });
            }
            ladders[symbol] = rows;
          }
          return json({
            ok: true,
            source: 'Robinhood Crypto',
            account: {
              status: account.status ?? null,
              account_type: account.account_type ?? null,
              buying_power: account.buying_power ?? null,
              buying_power_currency: account.buying_power_currency ?? null,
              is_api_tradable: account.is_api_tradable === true,
              fee_tier_status: account.fee_tier_status ?? null,
            },
            holdings: holdings?.results || [],
            recent_orders: (orders?.results || []).slice(0, 25),
            pairs: symbols.map((symbol) => ({
              symbol,
              api_tradable: pairBy[symbol]?.is_api_tradable === true,
              asset_increment: pairBy[symbol]?.asset_increment ?? null,
              quote_increment: pairBy[symbol]?.quote_increment ?? null,
              min_order_size: pairBy[symbol]?.min_order_size ?? null,
              max_order_size: pairBy[symbol]?.max_order_size ?? null,
            })),
            execution_ladders: ladders,
            generated_at: new Date().toISOString(),
          }, 200, 'no-store');
        } catch (e) {
          return json({ ok: false, status: e?.status ?? null, error: e?.message ?? 'robinhood_execution_intelligence_failed', detail: e?.detail ?? null }, 502, 'no-store');
        }
      }
      if (req.method === 'GET' && p === '/admin/crypto/robinhood/quote-debug') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false }, 503, 'no-store');
        const rh = robinhoodForEnv(env);
        const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
        try {
          const out = {};
          for (const symbol of symbols) {
            const quantity = symbol === 'BTC-USD' ? '0.001' : symbol === 'ETH-USD' ? '0.01' : '0.1';
            const [book, both, bid, ask] = await Promise.all([
              rh.bestBidAsk([symbol]),
              rh.estimatedPrice(symbol, { side: 'both', quantity }),
              rh.estimatedPrice(symbol, { side: 'bid', quantity }),
              rh.estimatedPrice(symbol, { side: 'ask', quantity }),
            ]);
            out[symbol] = { quantity, best_bid_ask: book, estimated_both: both, estimated_bid: bid, estimated_ask: ask };
          }
          return json({ ok: true, source: 'Robinhood Crypto', symbols: out }, 200, 'no-store');
        } catch (e) {
          return json({ ok: false, status: e?.status ?? null, error: e?.message ?? 'robinhood_quote_debug_failed', detail: e?.detail ?? null }, 502, 'no-store');
        }
      }
      if (req.method === 'GET' && p.startsWith('/admin/contract/')) {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const rec = await contractRecord(storeFor(env), decodeURIComponent(p.slice('/admin/contract/'.length)), { includeShadow: true });
        return rec ? json(rec, 200, 'no-store') : json({ error: 'not_found' }, 404, 'no-store');
      }
      // prediction-decision-v1 DRAFT preview (owner review before CALL becomes a public state): every live modeled
      // outcome's decision, evidence integrity and both venues at the current forecast. Admin only, never cached.
      // the exact row the ledger writer would build for one designated forecast (NOT written; freeze not applied) — for
      // payload proofs against the real table inside a rolled-back transaction
      if (req.method === 'GET' && p === '/admin/decisions/preview-row') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const [inp] = await loadDecisionInputs(storeFor(env), [url.searchParams.get('forecast') || '']);
        return inp ? json(await buildDecisionRecord(inp), 200, 'no-store') : json({ error: 'not_found' }, 404, 'no-store');
      }
      if (req.method === 'GET' && p === '/admin/decisions/verify') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        return json(await verifyDecisions(storeFor(env)), 200, 'no-store');
      }
      // intraday scoring (designation-intraday/1): aggregate report of stored scores; ?run=1 runs the lane now (POST only writes)
      // read-only diagnostics accept ADMIN_TOKEN or the narrower DIAGNOSTICS_TOKEN (GET only; never writes)
      // CPI V1 private SHADOW report (read-only; ?format=html). POST /admin/cpi/shadow/run runs the lane now (ADMIN_TOKEN).
      if (req.method === 'GET' && p === '/admin/cpi/shadow') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN)) && !(await tokenMatches(req, env.DIAGNOSTICS_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        const rep = await cpiShadowReport(storeFor(env));
        if (url.searchParams.get('format') === 'html') return new Response(renderCpiShadowHtml(rep), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
        return json(rep, 200, 'no-store');
      }
      if (req.method === 'POST' && p === '/admin/cpi/shadow/run') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (env.CPI_SHADOW !== 'true') return json({ error: 'CPI_SHADOW is off' }, 409, 'no-store');
        return json(await runCpiShadow({ store: storeFor(env), mkt: new MarketsService({ binding: env.MARKETS, token: env.MARKETS_READ_TOKEN }), now: new Date().toISOString() }), 200, 'no-store');
      }
      if (req.method === 'GET' && p === '/admin/intraday/shadow-compare') {
        if (!(await tokenMatches(req, env.ADMIN_TOKEN)) && !(await tokenMatches(req, env.DIAGNOSTICS_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        return json(await shadowCompareReport(storeFor(env), { evaluate: shadowEvaluationReport }), 200, 'no-store');
      }
      if (p === '/admin/intraday/scores' && (req.method === 'GET' || req.method === 'POST')) {
        const diag = req.method === 'GET' && (await tokenMatches(req, env.DIAGNOSTICS_TOKEN));
        if (!diag && !(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
        if (req.method === 'POST') return json(await runIntradayScoring(storeFor(env), { now: new Date().toISOString(), dryRun: url.searchParams.get('dry_run') !== '0' }), 200, 'no-store');
        return json(await intradayReport(storeFor(env)), 200, 'no-store');
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
      // Manual, admin-only publication of ONE validated story: emergency/manual tool (the normal path is the cron's auto-publication).
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
      if (p === '/v1/health') return json({ ok: true, engine_enabled: env.ENGINE_ENABLED === 'true', robinhood_configured: robinhoodConfigured(env), series: { weather: env.WEATHER_SERIES, macro: env.MACRO_SERIES, rates: env.RATES_SERIES, monitor: env.MONITOR_SERIES } }, 200, 'no-store');
      // Public operational health only: authenticates a READ-ONLY Robinhood quote request and returns status booleans.
      // No credentials, account data, holdings, orders, balances, prices or trading actions are exposed here.
      if (p === '/v1/health/robinhood') {
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false, mode: 'READ_ONLY_MARKET_DATA', trading_enabled: false }, 503, 'public, max-age=30');
        const credential = await robinhoodCredentialFingerprint(env);
        try {
          await robinhoodForEnv(env).bestBidAsk(['BTC-USD', 'ETH-USD']);
          return json({ ok: true, configured: true, authenticated: true, mode: 'READ_ONLY_MARKET_DATA', trading_enabled: false, symbols_verified: ['BTC-USD', 'ETH-USD'], credential }, 200, 'public, max-age=30');
        } catch (e) {
          return json({ ok: false, configured: true, authenticated: false, mode: 'READ_ONLY_MARKET_DATA', trading_enabled: false, upstream_status: e?.status ?? null, credential }, 502, 'public, max-age=10');
        }
      }
      if (p === '/v1/crypto/nowcast') {
        const now = new Date().toISOString();
        try {
          let [window] = await store.select('pred_crypto_windows', {
            select: 'window_id,asset,horizon_min,open_at,close_at,settle_rule,kalshi_market_ticker,polymarket_slug,proxy_open_usd,created_at',
            open_at: `lte.${now}`,
            close_at: `gt.${now}`,
          }, { limit: 1, order: 'open_at.desc' });
          let active = true;
          if (!window) {
            active = false;
            [window] = await store.select('pred_crypto_windows', {
              select: 'window_id,asset,horizon_min,open_at,close_at,settle_rule,kalshi_market_ticker,polymarket_slug,proxy_open_usd,created_at',
              close_at: `lte.${now}`,
            }, { limit: 1, order: 'close_at.desc' });
          }
          if (!window) return json({ ok: true, active: false, state: 'NO_WINDOW' }, 200, 'public, max-age=10');

          const [forecasts, obs, resolution] = await Promise.all([
            store.select('pred_crypto_forecasts', {
              select: 'forecast_id,window_id,model_id,model_version,model_state,captured_at,data_cutoff_at,p_up,features,features_sha256',
              window_id: `eq.${window.window_id}`,
            }, { order: 'captured_at.asc' }),
            store.select('pred_crypto_venue_obs', {
              select: 'obs_id,window_id,venue,market_id,captured_at,bid,ask,mid,market_status,comparability',
              window_id: `eq.${window.window_id}`,
            }, { order: 'captured_at.asc' }),
            store.select('pred_crypto_resolutions', {
              select: 'window_id,venue_result,venue_settled_at,proxy_close_usd,proxy_result,proxy_agrees,polymarket_result,resolved_at',
              window_id: `eq.${window.window_id}`,
            }, { limit: 1 }),
          ]);
          const latestForecast = forecasts.at(-1) || null;
          const latestVenue = (venue) => obs.filter((x) => x.venue === venue).at(-1) || null;
          const latestKalshi = latestVenue('kalshi');
          const latestPolymarket = latestVenue('polymarket');

          const recentScores = await store.select('pred_crypto_scores', {
            select: 'window_id,designation,method,outcome,pbe_p,pbe_score,kalshi_p,kalshi_score,polymarket_p,polymarket_score,created_at',
            designation: 'eq.FINAL_PRE_RESOLUTION',
          }, { limit: 400, order: 'created_at.desc' }).catch(() => []);
          const avg = (rows, key) => {
            const vals = rows.map((x) => Number(x[key])).filter(Number.isFinite);
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          };
          const brier = recentScores.filter((x) => x.method === 'brier');
          const log = recentScores.filter((x) => x.method === 'log_loss');

          return json({
            ok: true,
            active,
            state: active ? 'LIVE' : 'LAST_WINDOW',
            generated_at: now,
            window,
            latest_forecast: latestForecast,
            forecast_path: forecasts.map((x) => ({ t: x.captured_at, p_up: Number(x.p_up) })),
            venue_path: {
              kalshi: obs.filter((x) => x.venue === 'kalshi').map((x) => ({ t: x.captured_at, mid: x.mid == null ? null : Number(x.mid) })),
              polymarket: obs.filter((x) => x.venue === 'polymarket').map((x) => ({ t: x.captured_at, mid: x.mid == null ? null : Number(x.mid) })),
            },
            markets: { kalshi: latestKalshi, polymarket: latestPolymarket },
            resolution: resolution?.[0] || null,
            record: {
              designation: 'FINAL_PRE_RESOLUTION',
              brier_n: brier.length,
              pbe_brier: avg(brier, 'pbe_score'),
              kalshi_brier: avg(brier, 'kalshi_score'),
              log_loss_n: log.length,
              pbe_log_loss: avg(log, 'pbe_score'),
              kalshi_log_loss: avg(log, 'kalshi_score'),
            },
          }, 200, 'public, max-age=10');
        } catch (e) {
          return json({ ok: false, error: 'crypto_nowcast_unavailable', detail: e?.message ?? null }, 502, 'public, max-age=5');
        }
      }
      if (p === '/v1/crypto/universe') {
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false, source: 'Robinhood Crypto' }, 503, 'public, max-age=60');
        try {
          const all = await robinhoodForEnv(env).tradingPairsAll({ limit: 100, maxPages: 20 });
          const rows = (all.results || []).filter((x) => x?.is_api_tradable === true).map((x) => ({
            symbol: x.symbol,
            asset_code: x.asset_code ?? null,
            quote_code: x.quote_code ?? 'USD',
            asset_increment: x.asset_increment ?? null,
            quote_increment: x.quote_increment ?? null,
            min_order_size: x.min_order_size ?? null,
            max_order_size: x.max_order_size ?? null,
            api_tradable: true,
          })).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
          return json({ ok: true, source: 'Robinhood Crypto', count: rows.length, pages: all.pages, symbols: rows }, 200, 'public, max-age=60');
        } catch (e) {
          return json({ ok: false, source: 'Robinhood Crypto', status: e?.status ?? null, error: 'crypto_universe_unavailable' }, 502, 'public, max-age=10');
        }
      }
      if (p === '/v1/crypto/live-prices') {
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false, source: 'Robinhood Crypto' }, 503, 'public, max-age=5');
        const rh = robinhoodForEnv(env);
        const preferred = ['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','XRP-USD','ADA-USD','LINK-USD','AVAX-USD','LTC-USD','BCH-USD','SHIB-USD','UNI-USD','AAVE-USD','ETC-USD','XLM-USD','DOT-USD','ARB-USD','OP-USD','PEPE-USD','BONK-USD'];
        try {
          const all = await rh.tradingPairsAll({ limit: 100, maxPages: 20 });
          const tradable = (all.results || []).filter((x) => x?.is_api_tradable === true);
          const by = Object.fromEntries(tradable.map((x) => [x.symbol, x]));
          const selected = preferred.filter((s) => by[s]).concat(tradable.map((x) => x.symbol).filter((s) => !preferred.includes(s))).slice(0, 24);
          const quotes = selected.length ? await rh.bestBidAsk(selected) : { results: [] };
          const quoteBy = Object.fromEntries((quotes?.results || []).map((q) => [q.symbol, q]));
          const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
          const rows = selected.map((symbol) => {
            const q = quoteBy[symbol] || {};
            const bid = num(q.bid); const ask = num(q.ask);
            const crossed = bid != null && ask != null && bid > ask;
            const mark = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);
            const pair = by[symbol] || {};
            return {
              symbol,
              timestamp: q.timestamp ?? null,
              mark,
              raw_bid: bid,
              raw_ask: ask,
              raw_quote_crossed: crossed,
              api_tradable: pair.is_api_tradable === true,
              asset_increment: pair.asset_increment ?? null,
              quote_increment: pair.quote_increment ?? null,
              min_order_size: pair.min_order_size ?? null,
              max_order_size: pair.max_order_size ?? null,
            };
          }).filter((x) => x.mark != null);
          return json({ ok: true, source: 'Robinhood Crypto', generated_at: new Date().toISOString(), count: rows.length, symbols: rows }, 200, 'public, max-age=3');
        } catch (e) {
          return json({ ok: false, source: 'Robinhood Crypto', status: e?.status ?? null, error: 'crypto_live_prices_unavailable' }, 502, 'public, max-age=3');
        }
      }
      if (p === '/v1/crypto/execution-ladder') {
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false, source: 'Robinhood Crypto' }, 503, 'public, max-age=30');
        const rh = robinhoodForEnv(env);
        const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
        const ladderUsd = [10, 25, 50, 100];
        try {
          const quotes = await rh.bestBidAsk(symbols);
          const quoteBy = Object.fromEntries((quotes?.results || []).map((x) => [x.symbol, x]));
          const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
          const out = {};
          for (const symbol of symbols) {
            const q = quoteBy[symbol] || {};
            const rawBid = num(q.bid); const rawAsk = num(q.ask);
            const rawMid = rawBid != null && rawAsk != null ? (rawBid + rawAsk) / 2 : null;
            const rows = [];
            if (rawMid > 0) {
              const quantities = ladderUsd.map((usd) => (usd / rawMid).toPrecision(12));
              const est = await rh.estimatedPrice(symbol, { side: 'both', quantity: quantities.join(',') });
              const er = est?.results || [];
              for (let i = 0; i < ladderUsd.length; i += 1) {
                const quantity = quantities[i];
                const qty = num(quantity);
                const sameQty = (x) => Math.abs(num(x?.quantity) - qty) <= Math.max(1e-12, qty * 1e-9);
                const sell = er.find((x) => x?.side === 'bid' && sameQty(x)) || null;
                const buy = er.find((x) => x?.side === 'ask' && sameQty(x)) || null;
                const sellCredit = num(sell?.est_total_credit);
                const buyCost = num(buy?.est_total_cost);
                const netSell = qty > 0 && sellCredit != null ? sellCredit / qty : null;
                const grossBuy = qty > 0 && buyCost != null ? buyCost / qty : null;
                const mid = netSell != null && grossBuy != null ? (netSell + grossBuy) / 2 : null;
                rows.push({
                  usd: ladderUsd[i],
                  quantity,
                  net_sell: netSell,
                  gross_buy: grossBuy,
                  total_friction_bps: mid > 0 && netSell != null && grossBuy != null ? ((grossBuy - netSell) / mid) * 10000 : null,
                  fee_ratio: num(buy?.fee_ratio ?? sell?.fee_ratio),
                  timestamp: buy?.timestamp || sell?.timestamp || null,
                });
              }
            }
            out[symbol] = rows;
          }
          return json({ ok: true, source: 'Robinhood Crypto', sizes_usd: ladderUsd, ladders: out, generated_at: new Date().toISOString() }, 200, 'public, max-age=15');
        } catch (e) {
          return json({ ok: false, source: 'Robinhood Crypto', status: e?.status ?? null, error: 'crypto_execution_ladder_unavailable' }, 502, 'public, max-age=5');
        }
      }
      if (p === '/v1/crypto/markets') {
        if (!robinhoodConfigured(env)) return json({ ok: false, configured: false, source: 'Robinhood Crypto' }, 503, 'public, max-age=15');
        const rh = robinhoodForEnv(env);
        const defs = [
          { symbol: 'BTC-USD', quantity: '0.001' },
          { symbol: 'ETH-USD', quantity: '0.01' },
          { symbol: 'SOL-USD', quantity: '0.1' },
        ];
        try {
          const [pairs, quotes, ...estimates] = await Promise.all([
            rh.tradingPairs(defs.map((x) => x.symbol)),
            rh.bestBidAsk(defs.map((x) => x.symbol)),
            ...defs.map((d) => rh.estimatedPrice(d.symbol, { side: 'both', quantity: d.quantity })),
          ]);
          const pairBy = Object.fromEntries((pairs?.results || []).map((x) => [x.symbol, x]));
          const quoteBy = Object.fromEntries((quotes?.results || []).map((x) => [x.symbol, x]));
          const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

          // v2 best_bid_ask is a fee-exclusive partner-exchange snapshot and can be crossed across venues.
          // For the public execution rail, publish fee-adjusted, size-aware economics instead:
          // net proceeds per unit on a sell and gross cost per unit on a buy. These are derived directly
          // from Robinhood's estimated total credit/cost and therefore reflect the selected order size + fee.
          const rows = defs.map((d, i) => {
            const q = quoteBy[d.symbol] || {};
            const rawBid = num(q.bid); const rawAsk = num(q.ask);
            const rawCrossed = rawBid != null && rawAsk != null && rawBid > rawAsk;
            const estRows = estimates[i]?.results || [];
            const sell = estRows.find((x) => x?.side === 'bid') || null;
            const buy = estRows.find((x) => x?.side === 'ask') || null;
            const qty = num(d.quantity);
            const totalCredit = num(sell?.est_total_credit);
            const totalCost = num(buy?.est_total_cost);
            const effectiveBid = qty > 0 && totalCredit != null ? totalCredit / qty : null;
            const effectiveAsk = qty > 0 && totalCost != null ? totalCost / qty : null;
            const valid = effectiveBid != null && effectiveAsk != null && effectiveBid <= effectiveAsk;
            const cleanBid = valid ? effectiveBid : null;
            const cleanAsk = valid ? effectiveAsk : null;
            const mid = valid ? (cleanBid + cleanAsk) / 2 : null;
            const spreadBps = valid && mid > 0 ? ((cleanAsk - cleanBid) / mid) * 10000 : null;
            return {
              symbol: d.symbol,
              api_tradable: pairBy[d.symbol]?.is_api_tradable === true,
              timestamp: buy?.timestamp || sell?.timestamp || q.timestamp || null,
              bid: cleanBid,
              ask: cleanAsk,
              mid,
              spread_bps: spreadBps,
              quote_valid: valid,
              quote_source: valid ? 'estimated_price_fee_adjusted' : 'estimated_price_rejected',
              estimate_quantity: d.quantity,
              fee_ratio: num(buy?.fee_ratio ?? sell?.fee_ratio),
              raw_bid: rawBid,
              raw_ask: rawAsk,
              raw_quote_crossed: rawCrossed,
            };
          });
          return json({
            ok: true,
            source: 'Robinhood Crypto',
            mode: 'READ_ONLY_MARKET_DATA',
            execution_enabled: false,
            generated_at: new Date().toISOString(),
            symbols: rows,
          }, 200, 'public, max-age=5');
        } catch (e) {
          return json({ ok: false, source: 'Robinhood Crypto', status: e?.status ?? null, error: 'crypto_market_data_unavailable' }, 502, 'public, max-age=5');
        }
      }
      if (p === '/v1/summary') return json(await summary(store));
      // Membership + All Access. Predictions is a premium product included with All Access: every route below that
      // carries a PBE probability, market comparison, evidence or history is behind requireAllAccess + privateJson.
      if (p === '/v1/membership') { const m = await predictionsMembership(req, env); return privateJson({ authenticated: m.authenticated, membership: m.membership }); }
      // Public homepage preview: whitelisted desk rows, no PBE numbers (the page blurs placeholders in their place).
      if (p === '/v1/preview/desk') return json(deskPreview(await desk(store)));
      // Overview: three events only (the homepage never downloads the whole desk). Public = preview fields only.
      if (p === '/v1/preview/featured') return json(featuredForPreview(deskPreview(await desk(store))));
      if (p === '/v1/featured') { const g = await requireAllAccess(req, env); if (!g.ok) return g.res; return privateJson({ ...featuredForMember(await desk(store, { venues: true })), access: { tier: 'all_access' } }); }
      if (p === '/v1/desk' || p === '/v1/premium/desk') { const g = await requireAllAccess(req, env); if (!g.ok) return g.res; return privateJson({ ...(await desk(store, { venues: true })), access: { tier: 'all_access' } }); }
      if (p.startsWith('/v1/premium/event-page/')) {
        const g = await requireAllAccess(req, env); if (!g.ok) return g.res;
        const slug = decodeURIComponent(p.slice('/v1/premium/event-page/'.length));
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return privateJson({ error: 'not_found' }, 404);
        const full = await eventRecord(store, slug);
        if (!full) return privateJson({ error: 'not_found' }, 404);
        return privateJson({ at: full.generated_at, ...eventIntel(premiumEventView(full), { multiVenue: true }) });
      }
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
      if (p === '/v1/premium/results-board') { const g = await requireAllAccess(req, env); if (!g.ok) return g.res; return privateJson(limitRows(await memberScorecard(store), Number.parseInt(url.searchParams.get('limit') || '', 10))); }
      if (p.startsWith('/v1/event/')) {
        const g = await requireAllAccess(req, env); if (!g.ok) return g.res;
        const rec = await eventRecord(store, decodeURIComponent(p.slice('/v1/event/'.length)));
        return rec ? privateJson(premiumEventView(rec)) : privateJson({ error: 'not_found' }, 404);
      }
      // Live LIVE UPDATE layer of an Insights article (published evidence never changes; only this region refreshes).
      if (p.startsWith('/v1/live/insight/')) {
        const item = await storyForSlug(store, decodeURIComponent(p.slice('/v1/live/insight/'.length)));
        if (!item) return json({ error: 'not_found' }, 404);
        const live = await eventRecord(store, item.story.primary);
        return json({ at: live?.generated_at ?? null, regions: { insight: liveUpdate(live, item.built.outcome_market_id, item.story, item.built) } }, 200, 'public, max-age=15');
      }
      // Live regions of an event page (re-rendered by the SAME server functions; the page swaps them in place while visible).
      if (p.startsWith('/v1/live/event/')) {
        const g = await requireAllAccess(req, env); if (!g.ok) return g.res;
        const slug = decodeURIComponent(p.slice('/v1/live/event/'.length));
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return privateJson({ error: 'not_found' }, 404);
        const full = await eventRecord(store, slug);
        if (!full) return privateJson({ error: 'not_found' }, 404);
        const rec = premiumEventView(full); const h = headlineOutcome(rec);
        return privateJson({ at: rec.generated_at, atmosphere: h?.intel?.atmosphere ?? null, regions: { call: h?.call ? callBlock(h) : null, station: h?.intel ? liveWeatherBlock(h) : stationBlock(h), market: marketView(h) } });
      }
      if (p.startsWith('/v1/contract/')) {
        const g = await requireAllAccess(req, env); if (!g.ok) return g.res;
        const rec = await contractRecord(store, decodeURIComponent(p.slice('/v1/contract/'.length)));
        return rec ? privateJson(premiumEventView(rec)) : privateJson({ error: 'not_found' }, 404);
      }
      // server-rendered pages (Vercel rewrites predictions.propbetedge.ai/events/:slug, /record, /sitemap.xml here)
      if (p.startsWith('/pages/events/')) {
        const slug = decodeURIComponent(p.slice('/pages/events/'.length));
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return html(renderNotFound(`/events/${slug}`), 404);
        const full = await eventRecord(store, slug);
        // public SSR = the whitelisted product shell (no PBE, market comparison, evidence or history; never keyed on
        // cookies). Members load the intelligence from /v1/premium/event-page/<slug> (incl. the multi-venue panel).
        return full ? html(renderEvent(publicEventShell(full), { stories: (await storiesForEvent(store, slug)).map((s) => ({ slug: s.slug, title: s.link_title, family_label: s.family_label, published_at: s.published_at })) })) : html(renderNotFound(`/events/${slug}`), 404);
      }
      // Social cards (Vercel rewrites /og/events/* and /og/insights/* here)
      if (p.startsWith('/og/events/') && p.endsWith('.png')) {
        const slug = decodeURIComponent(p.slice('/og/events/'.length, -4));
        if (!/^[a-z0-9-]{3,140}$/.test(slug)) return json({ error: 'not_found' }, 404);
        const rec = await eventRecord(store, slug);
        if (!rec) return json({ error: 'not_found' }, 404);
        return cachedPng(req, ctx, () => eventCard(publicEventShell(rec)));
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
        if (!rest || VERTICALS[rest]) {
          return cachedInsightsDesk(rest || 'all', async () => {
            const [items, d, calData, modelData] = await Promise.all([
              publishedStories(store), desk(store), calendar(store), models(store),
            ]);
            if (!items.length || (rest && !items.some((i) => i.story.vertical === rest))) return html(renderNotFound('/insights/'), 404);
            const gaps = d.events.filter((e) => e.headline?.divergence_pts !== null && e.headline?.divergence_pts !== undefined && e.state !== 'MARKET_MONITORING' && (!rest || e.category.toLowerCase().replace('_', '-') === rest)).sort((a, b) => Math.abs(b.headline.divergence_pts) - Math.abs(a.headline.divergence_pts)).slice(0, 6);
            const cal = calData.events.filter((e) => !rest || e.category.toLowerCase().replace('_', '-') === rest).slice(0, 6);
            const mods = modelData.families.filter((f) => f.state !== 'SHADOW' && f.state !== 'MONITORING');
            return html(renderDesk({ items, vertical: rest || null, gaps, calendar: cal, models: mods }), 200, 'public, max-age=120');
          });
        }
        if (!/^[a-z0-9-]{3,160}$/.test(rest)) return html(renderNotFound(`/insights/${rest}`), 404);
        const item = await storyForSlug(store, rest);
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
      return json({ error: 'not_found', routes: ['/v1/health', '/v1/summary', '/v1/preview/desk', '/v1/preview/featured', '/v1/calendar', '/v1/models', '/v1/track-record', '/v1/queue', '/v1/membership'], all_access: ['/v1/desk', '/v1/featured', '/v1/event/:slug', '/v1/contract/:contract_id', '/v1/live/event/:slug', '/v1/premium/*'] }, 404);
    } catch (e) {
      console.error(e.stack || e.message);
      return json({ error: 'internal_error', message: e.message }, 500, 'no-store');
    }
  },
};
