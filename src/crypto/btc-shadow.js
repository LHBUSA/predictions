// BTC 15-minute nowcast — SHADOW (owner decision 2026-10-04). docs/research/CRYPTO_SHADOW_V1.md.
//
// public exchange observations -> OUR derived features -> PBE p(UP) -> Kalshi / Polymarket benchmarks -> Kalshi's
// published result -> designations + scores. Internal only: nothing here is served by any public route.
//
// Frozen for the whole shadow run (no tuning while it runs):
//   model   crypto-threshold-diffusion-baseline@0.1.0 (src/models/crypto-v0.js), exactly as replayed in
//           scripts/research/crypto/replay-v0.mjs: target K = OUR proxy reference at window open (mean of the
//           typical prices of the minute [open-60s, open) on Bitstamp + Coinbase); S = mean close of the last
//           completed minute; sigma = annualized realized vol of the trailing 60 one-minute log returns;
//           horizon = minutes from the data cutoff to close - 0.5; drift / funding 0.
//   designations (crypto-designation/1, reference = close): FIRST_PUBLISHED = first forecast captured >= open;
//           T_MINUS_k (k = 10, 5, 1) = latest forecast captured in [open, close - k min];
//           FINAL_PRE_RESOLUTION = latest forecast captured < close - 60 s (before the settlement averaging window).
//   benchmarks: each venue's observation captured within +-30 s of the designated forecast, else none (no
//           interpolation). Kalshi = SAME_CONTRACT; Polymarket = SAME_WINDOW_DIFFERENT_INDEX (Chainlink stream).
// Rights: raw exchange candles are used in memory and never stored; BRTI is never read (Kalshi's floor_strike and
// expiration_value are ignored, never stored); resolution = Kalshi's published yes / no only.
import { probabilityCryptoAbove, CRYPTO_MODEL } from '../models/crypto-v0.js';
import { buildFeatureVector, assertModelInput } from '../engine/leakage.js';
import { brierScore, logLoss } from '../scoring.js';

export const WINDOW_S = 900;
export const SERIES = 'KXBTC15M';
export const MODEL = Object.freeze({ id: CRYPTO_MODEL.id, version: CRYPTO_MODEL.version, state: 'SHADOW' });
export const DESIGNATION_RULES = 'crypto-designation/1';
export const BENCH_WINDOW_MS = 30e3;
export const MIN_RETURNS = 60;
const MIN_PER_YEAR = 365.25 * 1440;
const UA = 'PropBetEdgePredictions/1.0 research-shadow (+https://predictions.propbetedge.ai; data@propbetedge.ai)';

const iso = (s) => new Date(s * 1000).toISOString();
export const windowId = (openS) => `BTC15M:${iso(openS)}`;
export const windowOpenFor = (nowS) => Math.floor(nowS / WINDOW_S) * WINDOW_S;
export const polymarketSlug = (openS) => `btc-updown-15m-${openS}`;

// ---- underlying (public exchange candles; in memory only) -------------------------------------------------------
export function parseCoinbase(rows) { return new Map((rows || []).map(([t, low, high, open, close]) => [Number(t), { o: +open, h: +high, l: +low, c: +close }])); }
// Coinbase Advanced Trade public candles: the same Coinbase BTC-USD 1-minute bars (identical 60/60 vs the Exchange
// endpoint, 2026-10-04 15:45Z); the Exchange host answers 429 to Cloudflare egress, so it is only the fallback.
export function parseCoinbaseAdvanced(j) { return new Map((j?.candles || []).map((c) => [Number(c.start), { o: +c.open, h: +c.high, l: +c.low, c: +c.close }])); }
export function parseBitstamp(j) { return new Map((j?.data?.ohlc || []).map((c) => [Number(c.timestamp), { o: +c.open, h: +c.high, l: +c.low, c: +c.close }])); }

export async function fetchCandles(fetchImpl, nowS) {
  const end = Math.floor(nowS / 60) * 60;
  const start = end - 80 * 60;
  const get = async (url) => { const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, cache: 'no-store' }); if (!r.ok) throw new Error(`${new URL(url).host} -> ${r.status}`); return r.json(); };
  const coinbase = () => get(`https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?granularity=ONE_MINUTE&start=${start}&end=${end}&limit=90`).then(parseCoinbaseAdvanced)
    .catch(() => get(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso(start)}&end=${iso(end)}`).then(parseCoinbase));
  const [cb, bs] = await Promise.all([
    coinbase(),
    get(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=80`).then(parseBitstamp),
  ]);
  return { cb, bs };
}

const tp = (x) => (x.o + x.h + x.l + x.c) / 4;
/** OUR reference at boundary t (s): mean typical price of the minute [t-60, t) on both exchanges, else null. */
export function proxyRef({ cb, bs }, t) { const a = bs.get(t - 60); const b = cb.get(t - 60); return a && b ? (tp(a) + tp(b)) / 2 : null; }
/** price known at time t (s): mean close of the minute [t-60, t). */
export function closeAt({ cb, bs }, t) { const a = bs.get(t - 60); const b = cb.get(t - 60); return a && b ? (a.c + b.c) / 2 : null; }
export function sigmaAnn(c, t, n = MIN_RETURNS) {
  const r = [];
  for (let k = n; k >= 1; k -= 1) { const p0 = closeAt(c, t - 60 * k); const p1 = closeAt(c, t - 60 * (k - 1)); if (!p0 || !p1) return null; r.push(Math.log(p1 / p0)); }
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt((r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * MIN_PER_YEAR);
}
/** latest minute boundary t <= nowS whose minute [t-60, t) is complete on BOTH exchanges. */
export function dataCutoff(c, nowS) { for (let t = Math.floor(nowS / 60) * 60; t > nowS - 600; t -= 60) if (closeAt(c, t)) return t; return null; }

const SRC = (provider, sourceId) => ({ sourceClass: 'research', provider, sourceId });

/** Pure forecast for one window at time nowS from candles c. { status, ... } — never uses a market value. */
export function forecastWindow(c, openS, nowS) {
  const close = openS + WINDOW_S;
  if (nowS < openS) return { status: 'BEFORE_OPEN' };
  if (nowS >= close - 60) return { status: 'SETTLEMENT_WINDOW' }; // the 60-s averaging window has started
  const K = proxyRef(c, openS);
  if (!K) return { status: 'NO_OPEN_REFERENCE' };
  const cut = dataCutoff(c, nowS);
  if (!cut || cut < openS) return { status: 'NO_DATA_AFTER_OPEN' };
  if (nowS - cut > 150) return { status: 'STALE_UNDERLYING' };
  const S = closeAt(c, cut);
  const sig = sigmaAnn(c, cut);
  if (!S || !sig) return { status: 'INSUFFICIENT_HISTORY' };
  const horizonMin = (close - cut) / 60 - 0.5;
  const input = assertModelInput({ currentPrice: S, annualizedVol: sig });
  const p = probabilityCryptoAbove(input, K, horizonMin / 1440).probability;
  const sig1m = sig / Math.sqrt(MIN_PER_YEAR);
  const src = SRC('Bitstamp + Coinbase public 1-minute candles (derived in memory; raw not stored)', `btcusd-1m:bitstamp+coinbase:${iso(cut)}`);
  const fv = buildFeatureVector([
    { name: 'btc_open_ref_usd', value: +K.toFixed(2), source: src },
    { name: 'btc_spot_usd', value: +S.toFixed(2), source: src },
    { name: 'rv60_annualized', value: +sig.toFixed(6), source: src },
    { name: 'horizon_min', value: +horizonMin.toFixed(3), source: src },
    { name: 'z_distance', value: +(Math.log(S / K) / (sig1m * Math.sqrt(horizonMin))).toFixed(5), source: src },
    { name: 'exchange_gap_usd', value: +Math.abs(c.bs.get(cut - 60).c - c.cb.get(cut - 60).c).toFixed(2), source: src },
  ]);
  return { status: 'OK', p_up: Math.min(1, Math.max(0, p)), K, S, sig, horizonMin, dataCutoffAt: iso(cut), features: fv.features };
}

// ---- benchmarks (venues; never inputs) ---------------------------------------------------------------------
const dollars = (v) => (v == null || v === '' ? null : Number(v));
const midOf = (bid, ask) => (bid != null && ask != null && ask >= bid && ask - bid <= 0.1 ? +((bid + ask) / 2).toFixed(4) : null);

/** Kalshi KXBTC15M market for window open (identity + quote only; strike / expiration value deliberately dropped). */
export function kalshiObs(events, openS, capturedAt) {
  for (const ev of events || []) for (const m of ev.markets || []) {
    if (Date.parse(m.open_time) !== openS * 1000) continue;
    const bid = dollars(m.yes_bid_dollars); const ask = dollars(m.yes_ask_dollars);
    return { venue: 'kalshi', market_id: m.ticker, captured_at: capturedAt, bid, ask, mid: midOf(bid, ask), market_status: m.status ?? null, comparability: 'SAME_CONTRACT' };
  }
  return null;
}

// Gamma's bestBid / bestAsk / outcomePrices lag the book (seen 2026-10-04 15:18Z: gamma 0.47/0.48 vs CLOB 0.70/0.71 on
// the Up token, Kalshi 0.69/0.70). Gamma only identifies the window's Up token; the quote is the CLOB book.
export function polymarketUpToken(event) {
  const m = event?.markets?.[0];
  if (!m) return null;
  let outcomes = m.outcomes; let tokens = m.clobTokenIds;
  try { if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes); if (typeof tokens === 'string') tokens = JSON.parse(tokens); } catch { return null; }
  const i = Array.isArray(outcomes) ? outcomes.findIndex((o) => String(o).toLowerCase() === 'up') : -1;
  return i >= 0 && tokens?.[i] ? { token: String(tokens[i]), market_id: String(m.conditionId || m.id || event.slug), closed: !!m.closed, active: !!m.active } : null;
}

/** Up-token CLOB book -> benchmark row (best bid = max bid, best ask = min ask; order-independent). */
export function polymarketObs(up, book, capturedAt) {
  if (!up || !book) return null;
  const px = (side) => (book[side] || []).map((x) => Number(x.price)).filter((v) => Number.isFinite(v));
  const bids = px('bids'); const asks = px('asks');
  const bid = bids.length ? Math.max(...bids) : null; const ask = asks.length ? Math.min(...asks) : null;
  return { venue: 'polymarket', market_id: up.market_id, captured_at: capturedAt, bid, ask, mid: midOf(bid, ask), market_status: up.closed ? 'closed' : up.active ? 'active' : null, comparability: 'SAME_WINDOW_DIFFERENT_INDEX' };
}

export function polymarketResult(event) {
  const m = event?.markets?.[0];
  if (!m?.closed) return null;
  let px = m.outcomePrices; let oc = m.outcomes;
  try { if (typeof px === 'string') px = JSON.parse(px); if (typeof oc === 'string') oc = JSON.parse(oc); } catch { return null; }
  const i = (px || []).findIndex((v) => Number(v) === 1);
  return i < 0 || !oc?.[i] ? null : String(oc[i]).toLowerCase() === 'up' ? 'up' : 'down';
}

// ---- designations + scoring (pure) -------------------------------------------------------------------------
export function dueDesignations({ openAt, closeAt, forecasts, existing = [] }) {
  const open = Date.parse(openAt); const close = Date.parse(closeAt);
  const have = new Set(existing.map((d) => d.designation));
  const fs = forecasts.filter((f) => Date.parse(f.captured_at) >= open).sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
  const latest = (pred) => fs.filter((f) => pred(Date.parse(f.captured_at))).pop() || null;
  const rules = [
    ['FIRST_PUBLISHED', () => fs[0] || null, () => fs[0]?.captured_at],
    ['T_MINUS_10', () => latest((t) => t <= close - 600e3), () => new Date(close - 600e3).toISOString()],
    ['T_MINUS_5', () => latest((t) => t <= close - 300e3), () => new Date(close - 300e3).toISOString()],
    ['T_MINUS_1', () => latest((t) => t <= close - 60e3), () => new Date(close - 60e3).toISOString()],
    ['FINAL_PRE_RESOLUTION', () => latest((t) => t < close - 60e3), () => new Date(close - 60e3).toISOString()],
  ];
  const out = [];
  for (const [designation, pick, ref] of rules) {
    if (have.has(designation)) continue;
    const f = pick();
    if (f) out.push({ designation, forecast: f, reference_time: ref() });
  }
  return out;
}

export function nearestObs(obs, venue, capturedAt) {
  const t = Date.parse(capturedAt);
  let best = null;
  for (const o of obs) {
    if (o.venue !== venue) continue;
    const d = Math.abs(Date.parse(o.captured_at) - t);
    if (d <= BENCH_WINDOW_MS && (!best || d < best.d)) best = { o, d };
  }
  return best?.o ?? null;
}

export function scoreRows({ designation, forecast, outcome, kalshi, polymarket }) {
  const rows = [];
  for (const [method, fn] of [['brier', brierScore], ['log_loss', logLoss]]) {
    const kp = kalshi?.mid ?? null; const pp = polymarket?.mid ?? null;
    rows.push({ designation_id: designation.designation_id, window_id: designation.window_id, designation: designation.designation, method, outcome,
      pbe_p: Number(forecast.p_up), pbe_score: fn(Number(forecast.p_up), outcome),
      kalshi_p: kp, kalshi_score: kp == null ? null : fn(Number(kp), outcome), polymarket_p: pp, polymarket_score: pp == null ? null : fn(Number(pp), outcome) });
  }
  return rows;
}

async function sha256Hex(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }

// ---- the 1-minute pass --------------------------------------------------------------------------------------
/**
 * One shadow tick: forecast the open window, capture both venues, resolve closed windows from Kalshi's published
 * result, designate and score. Bounded and idempotent (unique keys + ignore-duplicates inserts).
 */
export async function runBtcShadow({ store, mkt, fetchImpl = globalThis.fetch, now = new Date().toISOString(), settlements = false }) {
  const nowS = Math.floor(Date.parse(now) / 1000);
  const openS = windowOpenFor(nowS);
  const wid = windowId(openS);
  const out = { now, window: wid, forecast: null, venues: {}, resolved: 0, designations: 0, scores: 0, errors: [] };

  let candles = null;
  try { candles = await fetchCandles(fetchImpl, nowS); } catch (e) { out.errors.push({ source: 'exchanges', error: e.message }); }
  const f = candles ? forecastWindow(candles, openS, nowS) : { status: 'SOURCE_ERROR' };
  out.forecast = f.status === 'OK' ? { p_up: +f.p_up.toFixed(4), horizon_min: f.horizonMin, cutoff: f.dataCutoffAt } : { status: f.status };

  // venues (benchmarks): captured in the same tick, written only for a known window
  const venueRows = [];
  try {
    const { events } = await mkt.openEvents(SERIES);
    const k = kalshiObs(events, openS, now);
    if (k) venueRows.push(k);
    out.venues.kalshi = k ? { market: k.market_id, mid: k.mid } : 'not_listed';
  } catch (e) { out.errors.push({ source: 'kalshi', error: e.message }); }
  try {
    const r = await fetchImpl(`https://gamma-api.polymarket.com/events?slug=${polymarketSlug(openS)}`, { headers: { 'user-agent': UA, accept: 'application/json' }, cache: 'no-store' });
    const up = r.ok ? polymarketUpToken((await r.json())?.[0]) : null;
    const book = up ? await fetchImpl(`https://clob.polymarket.com/book?token_id=${up.token}`, { headers: { 'user-agent': UA, accept: 'application/json' }, cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)) : null;
    const p = polymarketObs(up, book, now);
    if (p) venueRows.push(p);
    out.venues.polymarket = p ? { market: p.market_id, mid: p.mid } : 'not_listed';
  } catch (e) { out.errors.push({ source: 'polymarket', error: e.message }); }

  // window row (needs our open reference) — written once
  let windowKnown = false;
  if (candles && proxyRef(candles, openS)) {
    await store.write('pred_crypto_windows', { window_id: wid, asset: 'BTC', horizon_min: 15, open_at: iso(openS), close_at: iso(openS + WINDOW_S), settle_rule: 'avg60(close) >= avg60(open); tie UP; missing data DOWN',
      kalshi_market_ticker: venueRows.find((v) => v.venue === 'kalshi')?.market_id ?? null, polymarket_slug: polymarketSlug(openS), proxy_open_usd: +proxyRef(candles, openS).toFixed(2),
      proxy_basis: { rule: 'mean of (o+h+l+c)/4 of the minute [open-60s, open) on Bitstamp + Coinbase', exchanges: ['bitstamp', 'coinbase'], minute: iso(openS - 60) } }, { conflictColumn: 'window_id' });
    windowKnown = true;
  } else {
    // exchange read failed this tick: the window row may already exist from an earlier tick — venue quotes are still
    // captured (benchmarks never depend on the exchange read); only the forecast is skipped
    try { windowKnown = (await store.select('pred_crypto_windows', { select: 'window_id', window_id: `eq.${wid}` }, { limit: 1 })).length > 0; } catch { windowKnown = false; }
  }

  if (windowKnown) {
    if (f.status === 'OK') {
      const featuresSha = await sha256Hex(JSON.stringify({ model: MODEL, features: f.features }));
      await store.write('pred_crypto_forecasts', { window_id: wid, model_id: MODEL.id, model_version: MODEL.version, model_state: 'SHADOW', captured_at: now, data_cutoff_at: f.dataCutoffAt, p_up: +f.p_up.toFixed(6), features: f.features, features_sha256: featuresSha }, { conflictColumn: 'window_id,model_id,captured_at' });
    }
    if (venueRows.length) await store.write('pred_crypto_venue_obs', venueRows.map((v) => ({ window_id: wid, ...v })), { conflictColumn: 'window_id,venue,captured_at' });
    out.written = { window: wid, forecast: f.status === 'OK', venues: venueRows.map((v) => `${v.venue}:${v.mid}`) };
  }

  // resolve + designate + score the recently closed windows (last 2 h)
  try { Object.assign(out, await settleClosed({ store, mkt, fetchImpl, now, candles })); } catch (e) { out.errors.push({ source: 'settle', error: e.message }); }
  // audit-only paths (never touch the frozen resolution / scores): venue settlement observations (sql/010) and the
  // completeness report for the window that just closed (first tick of each new window)
  if (settlements) { try { out.venue_settlements = await captureVenueSettlements({ store, mkt, fetchImpl, now }); } catch (e) { out.errors.push({ source: 'venue_settlements', error: e.message }); } }
  if (nowS - openS < 60) { try { out.completeness = await completenessReport({ store, now, hours: 1 / 60 }); /* only the window that just closed */ } catch (e) { out.errors.push({ source: 'completeness', error: e.message }); } }
  return out;
}

export async function settleClosed({ store, mkt, fetchImpl, now, candles }) {
  const res = { resolved: 0, designations: 0, scores: 0, detail: { designations: [], resolutions: [], scores: [] } };
  const nowMs = Date.parse(now);
  const windows = await store.select('pred_crypto_windows', { select: 'window_id,open_at,close_at,polymarket_slug', close_at: `lte.${now}`, and: `(close_at.gte.${new Date(nowMs - 2 * 3600e3).toISOString()})` });
  if (!windows.length) return res;
  const ids = windows.map((w) => w.window_id);
  const [forecasts, obs, des, resolutions] = await Promise.all([
    store.selectIn('pred_crypto_forecasts', { select: 'forecast_id,window_id,model_id,captured_at,p_up' }, 'window_id', ids),
    store.selectIn('pred_crypto_venue_obs', { select: 'obs_id,window_id,venue,market_id,captured_at,mid' }, 'window_id', ids),
    store.selectIn('pred_crypto_designations', { select: 'designation_id,window_id,model_id,designation,forecast_id,kalshi_obs_id,polymarket_obs_id' }, 'window_id', ids),
    store.selectIn('pred_crypto_resolutions', { select: 'window_id,venue_result' }, 'window_id', ids),
  ]);
  // 1. designations (all reference times have passed once the window closed)
  for (const w of windows) {
    const fs = forecasts.filter((x) => x.window_id === w.window_id);
    if (!fs.length) continue;
    const wobs = obs.filter((o) => o.window_id === w.window_id);
    for (const d of dueDesignations({ openAt: w.open_at, closeAt: w.close_at, forecasts: fs, existing: des.filter((x) => x.window_id === w.window_id) })) {
      const k = nearestObs(wobs, 'kalshi', d.forecast.captured_at); const p = nearestObs(wobs, 'polymarket', d.forecast.captured_at);
      const row = { window_id: w.window_id, model_id: MODEL.id, designation: d.designation, forecast_id: d.forecast.forecast_id, reference_time: d.reference_time, rule_version: DESIGNATION_RULES, kalshi_obs_id: k?.obs_id ?? null, polymarket_obs_id: p?.obs_id ?? null };
      const ins = await store.write('pred_crypto_designations', row, { conflictColumn: 'window_id,model_id,designation', returnRepresentation: true });
      if (ins?.[0]) { des.push(ins[0]); res.designations += 1; res.detail.designations.push({ window: w.window_id, designation: d.designation, captured_at: d.forecast.captured_at, p_up: Number(d.forecast.p_up), kalshi_mid: k?.mid ?? null, polymarket_mid: p?.mid ?? null }); }
    }
  }
  // 2. resolution: Kalshi's published result (yes / no) only
  const resolved = new Map(resolutions.map((r) => [r.window_id, r]));
  const due = windows.filter((w) => !resolved.has(w.window_id) && forecasts.some((x) => x.window_id === w.window_id));
  if (due.length) {
    const tickers = new Map();
    for (const w of due) { const o = obs.find((x) => x.window_id === w.window_id && x.venue === 'kalshi'); if (o) tickers.set(o.market_id, w); }
    const markets = tickers.size ? await mkt.marketsByTicker([...tickers.keys()]) : [];
    for (const m of markets) {
      if (!['yes', 'no'].includes(m.result)) continue;
      const w = tickers.get(m.ticker);
      const openS = Date.parse(w.open_at) / 1000; const closeS = Date.parse(w.close_at) / 1000;
      const pc = candles ? proxyRef(candles, closeS) : null; const po = candles ? proxyRef(candles, openS) : null;
      const proxyResult = pc && po ? (pc >= po ? 'yes' : 'no') : null;
      let pmResult = null;
      try { const r = await fetchImpl(`https://gamma-api.polymarket.com/events?slug=${w.polymarket_slug}`, { headers: { 'user-agent': UA }, cache: 'no-store' }); if (r.ok) pmResult = polymarketResult((await r.json())?.[0]); } catch { /* optional */ }
      const row = { window_id: w.window_id, venue_result: m.result, venue_settled_at: m.settlement_ts ?? null, proxy_close_usd: pc ? +pc.toFixed(2) : null, proxy_result: proxyResult, proxy_agrees: proxyResult ? proxyResult === m.result : null, polymarket_result: pmResult };
      await store.write('pred_crypto_resolutions', row, { conflictColumn: 'window_id' });
      resolved.set(w.window_id, row); res.resolved += 1; res.detail.resolutions.push(row);
    }
  }
  // 3. scores for designations of resolved windows
  const desIds = des.filter((d) => resolved.has(d.window_id) && d.designation_id).map((d) => d.designation_id);
  if (desIds.length) {
    const scored = new Set((await store.selectIn('pred_crypto_scores', { select: 'designation_id' }, 'designation_id', desIds)).map((x) => x.designation_id));
    const byF = new Map(forecasts.map((x) => [x.forecast_id, x])); const byO = new Map(obs.map((o) => [o.obs_id, o]));
    const rows = [];
    for (const d of des) {
      if (!d.designation_id || scored.has(d.designation_id) || !resolved.has(d.window_id)) continue;
      const fc = byF.get(d.forecast_id);
      if (!fc) continue;
      rows.push(...scoreRows({ designation: d, forecast: fc, outcome: resolved.get(d.window_id).venue_result === 'yes' ? 1 : 0, kalshi: byO.get(d.kalshi_obs_id), polymarket: byO.get(d.polymarket_obs_id) }));
    }
    if (rows.length) { await store.write('pred_crypto_scores', rows, { conflictColumn: 'designation_id,method' }); res.scores = rows.length; res.detail.scores = rows.map((r) => ({ window: r.window_id, designation: r.designation, method: r.method, outcome: r.outcome, pbe: +Number(r.pbe_score).toFixed(4), kalshi: r.kalshi_score == null ? null : +Number(r.kalshi_score).toFixed(4), polymarket: r.polymarket_score == null ? null : +Number(r.polymarket_score).toFixed(4) })); }
  }
  return res;
}

// ---- venue settlement observations (sql/010; audit only) ---------------------------------------------------------
/** Polymarket settled state as supplied: needs closed + UMA resolved + a 1/0 outcome price. Timestamps passed through. */
export function polymarketSettlement(event) {
  const m = event?.markets?.[0];
  if (!m?.closed || m.umaResolutionStatus !== 'resolved') return null;
  const result = polymarketResult(event);
  if (!result) return null;
  return {
    market_id: String(m.conditionId || m.id || event.slug), result, direction: result.toUpperCase(), source_settled_at: m.umaEndDate || null,
    source: 'gamma-api events', ref: { umaEndDate: m.umaEndDate ?? null, closedTime: m.closedTime ?? null, umaResolutionStatus: m.umaResolutionStatus, outcomePrices: m.outcomePrices ?? null, resolutionSource: m.resolutionSource ?? null },
  };
}

/** Kalshi settled state: identity + result only — never expiration_value / settlement value (BRTI). */
export function kalshiSettlement(m) {
  if (!m || !['yes', 'no'].includes(m.result)) return null;
  return { market_id: m.ticker, result: m.result, direction: m.result === 'yes' ? 'UP' : 'DOWN', source_settled_at: m.settlement_ts || null, source: 'kalshi markets (via propsports-markets)', ref: { settlement_ts: m.settlement_ts ?? null, status: m.status ?? null } };
}

/** First observation of each venue's settlement for windows closed in the last 48 h; one row per window + venue. */
export async function captureVenueSettlements({ store, mkt, fetchImpl, now, maxPolymarket = 8 }) {
  const out = { kalshi: 0, polymarket: 0, pending: 0 };
  const nowMs = Date.parse(now);
  const windows = await store.select('pred_crypto_windows', { select: 'window_id,open_at,close_at,polymarket_slug,kalshi_market_ticker', close_at: `lte.${now}`, and: `(close_at.gte.${new Date(nowMs - 48 * 3600e3).toISOString()})` });
  if (!windows.length) return out;
  const ids = windows.map((w) => w.window_id);
  const have = new Set((await store.selectIn('pred_crypto_venue_settlements', { select: 'window_id,venue' }, 'window_id', ids)).map((x) => `${x.window_id}|${x.venue}`));
  const obs = await store.selectIn('pred_crypto_venue_obs', { select: 'window_id,venue,market_id' }, 'window_id', ids);
  const rows = [];
  const kTickers = new Map();
  for (const w of windows) {
    if (have.has(`${w.window_id}|kalshi`)) continue;
    const t = w.kalshi_market_ticker || obs.find((o) => o.window_id === w.window_id && o.venue === 'kalshi')?.market_id;
    if (t) kTickers.set(t, w);
  }
  if (kTickers.size) {
    for (const m of await mkt.marketsByTicker([...kTickers.keys()].slice(0, 50))) {
      const st = kalshiSettlement(m);
      if (st) { rows.push({ window_id: kTickers.get(m.ticker).window_id, venue: 'kalshi', observed_at: now, ...st }); out.kalshi += 1; } else out.pending += 1;
    }
  }
  let pm = 0;
  for (const w of windows) {
    if (have.has(`${w.window_id}|polymarket`) || !w.polymarket_slug || pm >= maxPolymarket) continue;
    pm += 1;
    const r = await fetchImpl(`https://gamma-api.polymarket.com/events?slug=${w.polymarket_slug}`, { headers: { 'user-agent': UA, accept: 'application/json' }, cache: 'no-store' });
    const st = r.ok ? polymarketSettlement((await r.json())?.[0]) : null;
    if (st) { rows.push({ window_id: w.window_id, venue: 'polymarket', observed_at: now, ...st }); out.polymarket += 1; } else out.pending += 1;
  }
  if (rows.length) await store.write('pred_crypto_venue_settlements', rows, { conflictColumn: 'window_id,venue' });
  return out;
}

// ---- operational completeness (report only; reads the ledger, writes nothing) -----------------------------------
/** Pure: per window, expected minute ticks (open .. close - 60 s), forecasts written, venue quote misses. */
export function windowCompleteness(w, forecasts, obs) {
  const open = Date.parse(w.open_at) / 1000; const close = Date.parse(w.close_at) / 1000;
  const minutes = [];
  for (let t = open; t < close - 60; t += 60) minutes.push(t);
  const inMinute = (iso, t) => { const x = Date.parse(iso) / 1000; return x >= t && x < t + 60; };
  const fMin = minutes.filter((t) => forecasts.some((f) => inMinute(f.captured_at, t)));
  const quoted = (venue) => minutes.filter((t) => obs.some((o) => o.venue === venue && o.mid != null && inMinute(o.captured_at, t))).length;
  return {
    window: w.window_id, expected_ticks: minutes.length, forecasts_written: fMin.length, forecast_gaps: minutes.length - fMin.length,
    gap_minutes: minutes.filter((t) => !fMin.includes(t)).map((t) => new Date(t * 1000).toISOString().slice(11, 16)),
    kalshi_quote_misses: minutes.length - quoted('kalshi'), polymarket_quote_misses: minutes.length - quoted('polymarket'),
  };
}

export async function completenessReport({ store, now, hours = 24 }) {
  const nowMs = Date.parse(now);
  const windows = await store.select('pred_crypto_windows', { select: 'window_id,open_at,close_at', close_at: `lte.${now}`, and: `(close_at.gte.${new Date(nowMs - hours * 3600e3).toISOString()})` });
  if (!windows.length) return { windows: 0 };
  const ids = windows.map((w) => w.window_id);
  const [forecasts, obs] = await Promise.all([
    store.selectIn('pred_crypto_forecasts', { select: 'window_id,captured_at' }, 'window_id', ids),
    store.selectIn('pred_crypto_venue_obs', { select: 'window_id,venue,captured_at,mid' }, 'window_id', ids),
  ]);
  const per = windows.map((w) => windowCompleteness(w, forecasts.filter((f) => f.window_id === w.window_id), obs.filter((o) => o.window_id === w.window_id)));
  const sum = (k) => per.reduce((a, x) => a + x[k], 0);
  return {
    since: new Date(nowMs - hours * 3600e3).toISOString(), windows: per.length, expected_ticks: sum('expected_ticks'), forecasts_written: sum('forecasts_written'), forecast_gaps: sum('forecast_gaps'),
    kalshi_quote_misses: sum('kalshi_quote_misses'), polymarket_quote_misses: sum('polymarket_quote_misses'), per_window: per,
    note: 'gap reasons (exchange-source error, stale underlying, settlement window) are in each tick btc_shadow log line (Workers observability)',
  };
}
