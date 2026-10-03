// Full-cycle harness for the leakage regression (owner 2026-10-03): every live model lane (rain v1/v1.1, max temp
// v1/v1.1, Fed SHADOW, rates path) runs on the captured fixtures while BOTH venues' prices are rewritten.
// Kalshi: every bid/ask/last/volume/open-interest/liquidity field. Polymarket: a venue service + gamma/clob
// endpoints serving radically different prices, and venue fields injected onto each Kalshi market row.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runCycle } from '../../workers/pbe-predictions/src/cycle.js';

const dir = new URL('../fixtures/', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, dir)));
const readText = (p) => readFileSync(new URL(p, dir), 'utf8');

export const NOW = '2026-10-03T18:30:00.000Z';
export const KALSHI = Object.fromEntries(readdirSync(new URL('kalshi/', dir)).map((f) => { const j = readJson(`kalshi/${f}`); return [j.series.ticker, j]; }));
export const ENV = Object.freeze({
  WEATHER_SERIES: 'KXRAIN,KXHIGHNY,KXHIGHCHI,KXHIGHMIA',
  MACRO_SERIES: 'KXFEDDECISION',
  RATES_SERIES: 'KX10YRDIRHM,KX10YRDIRLM',
});

const PRICE_KEY = /(bid|ask|price|volume|open_interest|liquidity)/i;

// price(dollars, key, ticker) -> new dollars. Applied to every venue price/size field of every Kalshi market.
export function fakeMarkets(price, polymarket = null) {
  return {
    requests: 0,
    polymarketRequests: 0,
    async series(t) { this.requests += 1; return KALSHI[t].series; },
    async openEvents(t) {
      this.requests += 1;
      const f = KALSHI[t];
      const markets = f.markets.map((m) => {
        const out = { ...m };
        for (const [k, v] of Object.entries(m)) if (PRICE_KEY.test(k) && v != null && v !== '') out[k] = price(Number(v), k, m.ticker);
        if (polymarket) Object.assign(out, polymarket.inline(m.ticker));
        return out;
      });
      return { events: [{ ...f.event, markets }] };
    },
    async marketsByTicker() { return []; },
    // a multi-venue markets service would expose this; a model must never call it
    async polymarketOutcomes(ticker) { this.polymarketRequests += 1; return polymarket ? polymarket.outcomes(ticker) : []; },
  };
}

export function polymarketVenue(p) {
  return {
    inline: (ticker) => ({ polymarket_best_bid: p, polymarket_best_ask: Math.min(1, p + 0.01), polymarket_midpoint: p + 0.005, polymarket_token_id: `tok-${ticker}`, polymarket_volume: 1e6 * p, venue_consensus_prob: p }),
    outcomes: (ticker) => [{ token_id: `tok-${ticker}`, best_bid: p, best_ask: p + 0.01, midpoint: p + 0.005, spread: 0.01, last_trade_price: p, liquidity: 5e5 }],
    gamma: () => ({ markets: [{ clobTokenIds: '["tok"]', outcomePrices: `["${p}","${1 - p}"]`, bestBid: p, bestAsk: p + 0.01, volume: 1e6, liquidity: 5e5 }] }),
    book: () => ({ bids: [{ price: String(p), size: '1000' }], asks: [{ price: String(p + 0.01), size: '1000' }] }),
  };
}

export function fakeFetch(polymarket = null, { nbm = true } = {}) {
  const urls = [];
  const fn = (input) => {
    const u = String(input);
    urls.push(u);
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const csv = (text) => Promise.resolve(new Response(text, { status: 200, headers: { 'content-type': 'text/csv' } }));
    const miss = () => Promise.resolve(new Response('{}', { status: 404 }));
    if (/gamma-api\.polymarket\.com/.test(u)) return polymarket ? json(polymarket.gamma()) : miss();
    if (/clob\.polymarket\.com/.test(u)) return polymarket ? json(polymarket.book()) : miss();
    let m = /mos\.json\?station=([A-Z]{4})&model=([A-Z]+)/.exec(u);
    if (m) {
      if (m[2] === 'NBS' && !nbm) return json({ data: [] }); // v1 tiers: IEM has no usable National Blend run
      const file = m[2] === 'NBS' ? `weather/nbs-${m[1]}.json` : `weather/mos-${m[1]}.json`;
      try { return json(readJson(file)); } catch { return miss(); }
    }
    if (/api\.weather\.gov\/points\//.test(u)) return json({ properties: { gridId: 'MFL', gridX: 105, gridY: 51, forecastGridData: 'https://api.weather.gov/gridpoints/MFL/105,51' } });
    if (/gridpoints\/MFL/.test(u)) return json(readJson('weather/grid-MFL-105-51.json'));
    m = /fredgraph\.csv\?id=([A-Z0-9]+)/.exec(u);
    if (m) { try { return csv(readText(`fred/${m[1]}.csv`)); } catch { return miss(); } }
    m = /daily-treasury-rates\.csv\/(\d{4})\//.exec(u);
    if (m) { try { return csv(readText(`treasury/treasury-par-${m[1]}.csv`)); } catch { return miss(); } }
    return miss();
  };
  fn.urls = urls;
  return fn;
}

// The PBE side of a forecast row: everything the model produced. Market columns are excluded on purpose.
export const MARKET_COLUMNS = ['market_probability', 'market_snapshot_key', 'market_observed_at'];
export function pbeSide(f) {
  return Object.fromEntries(Object.entries(f).filter(([k]) => !MARKET_COLUMNS.includes(k)));
}

export async function runAllLanes({ price = (v) => v, polymarket = null, nbm = true } = {}) {
  const markets = fakeMarkets(price, polymarket);
  const fetchImpl = fakeFetch(polymarket, { nbm });
  const { summary, writes } = await runCycle(ENV, { markets, fetchImpl, now: NOW, dryRun: true });
  return { summary, writes, markets, fetchUrls: fetchImpl.urls };
}

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// Canonical model-side snapshot used for the golden comparison: per forecast, the published probability,
// the raw model probability, the feature hash and a hash over the ENTIRE PBE side of the row + its feature row.
export function modelSnapshot({ writes }) {
  return writes.forecasts.map((f) => {
    const fs = writes.features.find((x) => x.snapshot_id === f.feature_snapshot_id);
    return {
      record_id: f.record_id, model: `${f.model_id}@${f.model_version}`, probability: f.probability, raw_probability: f.explanation.raw_probability,
      features_sha256: f.features_sha256, pbe_row_sha256: sha(pbeSide(f)), feature_row_sha256: sha(fs),
    };
  });
}
