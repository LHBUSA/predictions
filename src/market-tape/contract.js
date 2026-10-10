// PBE Market Tape read contract `market-tape/1` (issue #56). Pure assembly: one canonical payload for every PropBetEdge
// surface (Signal 10 pages, Members, Terminal). Source-independent: a quote provider is an adapter with a RIGHTS record, and
// prices reach a payload only when that record permits the requesting audience. Environment flags cannot widen rights.
//
// Never: price-derived values without rights (null for EVERY audience), our poll/cache time presented as an observation
// time, a featured/editorial symbol presented as a model pick or a simulated holding, or a security joined to an unrelated
// earlier use of the same ticker.
import { FEATURED, robinhoodUrl, tapeRow, marketSession, prevTradingDay } from './core.js';
import { IEX_ATTRIBUTION } from './iex-hist.js';

export const CONTRACT = 'market-tape/1';

// ---------- security identity ----------
// Stable identity = symbol + MIC (+ listing date where the ticker was previously used by another issuer). Exchange per the
// listing venue (Yahoo meta 2026-10-10: NMS/NGM = Nasdaq, PCX = NYSE Arca). SPCX: Space Exploration Technologies Corp.,
// Class A, CUSIP 84615Q103, Nasdaq initial listing 2026-06-12 (Nasdaq DTN2026-8); earlier unrelated SPCX records never join.
export const IDENTITY = Object.freeze({
  SPCX: { legal_name: 'Space Exploration Technologies Corp.', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON', share_class: 'A', cusip: '84615Q103', listed_on: '2026-06-12' },
  SPY: { legal_name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE ARCA', mic: 'ARCX', type: 'ETF' },
  QQQ: { legal_name: 'Invesco QQQ Trust, Series 1', exchange: 'NASDAQ', mic: 'XNAS', type: 'ETF' },
  NVDA: { legal_name: 'NVIDIA Corporation', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON' },
  MSFT: { legal_name: 'Microsoft Corporation', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON' },
  AAPL: { legal_name: 'Apple Inc.', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON' },
  AMZN: { legal_name: 'Amazon.com, Inc.', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON' },
  GOOGL: { legal_name: 'Alphabet Inc.', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON', share_class: 'A' },
  META: { legal_name: 'Meta Platforms, Inc.', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON', share_class: 'A' },
  TSLA: { legal_name: 'Tesla, Inc.', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON' },
  HOOD: { legal_name: 'Robinhood Markets, Inc.', exchange: 'NASDAQ', mic: 'XNAS', type: 'COMMON', share_class: 'A' },
});
export function securityId(symbol) {
  const i = IDENTITY[symbol];
  if (!i) return `${symbol}:US`;
  return i.listed_on ? `${symbol}:${i.mic}:${i.listed_on}` : `${symbol}:${i.mic}`;
}

// ---------- providers and rights ----------
// rights.public / rights.paid: may this source's prices be DISPLAYED to that audience (true only with written terms on file
// in docs/signal10/TAPE.md). A paywall is access control, not redistribution permission.
export const PROVIDERS = Object.freeze({
  'yahoo-chart': Object.freeze({
    id: 'yahoo-chart', name: 'Yahoo Finance chart endpoint', rights: Object.freeze({ public: false, paid: false }),
    rights_note: 'Yahoo Finance: no redistribution (help.yahoo.com SLN2310); non-commercial APIs may not be incorporated into paywalled products (legal.yahoo.com YDN guidelines).',
    attribution: null, quote_delay_known: false,
  }),
  // IEX Historical Data (TOPS, next-day): exchange-originated, free, display permitted to everyone with the credit line.
  // "IEX does not require an IEX Data Subscriber Agreement from any Person who receives, uses, or distributes IEX
  // Historical Data" (IEX Market Data Policies §15). Scope: IEX-venue trades only, published the next morning (T+1).
  'iex-hist': Object.freeze({
    id: 'iex-hist', name: 'IEX Historical Data (TOPS)', rights: Object.freeze({ public: true, paid: true }),
    rights_note: 'IEX Market Data Policies §15: no Data Subscriber Agreement to receive, use or distribute IEX Historical Data; credit line required.',
    attribution: IEX_ATTRIBUTION, quote_delay_known: true, kind: 'SESSION_CLOSE_T1', delay: 'T+1 (published the next morning)', venue_scope: 'IEX_ONLY', basis: 'IEX_LAST_SALE',
  }),
});
// The provider that may serve `audience` ('public' | 'paid') right now, or null. Quotes need BOTH the operator switch
// (MARKET_TAPE_QUOTES === 'on') AND a provider whose rights record permits that audience.
export function quoteProvider(env, audience, providers = PROVIDERS) {
  if (env?.MARKET_TAPE_QUOTES !== 'on') return null;
  const p = providers[env?.MARKET_TAPE_PROVIDER];
  return p && p.rights?.[audience] === true ? p : null;
}
export function rightsState(env, audience, providers = PROVIDERS) {
  const p = quoteProvider(env, audience, providers);
  if (p) return { state: 'CLEARED', provider: p.id, scope: audience === 'paid' ? 'PAID' : 'PUBLIC', note: null };
  const named = providers[env?.MARKET_TAPE_PROVIDER];
  return { state: 'SOURCE_RIGHTS_HOLD', provider: named?.id || null, scope: 'NONE',
    note: env?.MARKET_TAPE_QUOTES !== 'on' ? 'Quote display is switched off until a source with written display rights is on file.' : `${named ? named.name : 'No provider'} has no display rights for this audience.` };
}

// ---------- lists ----------
export const LIST_KINDS = Object.freeze({ EDITORIAL: 'EDITORIAL', MODEL_RESEARCH: 'MODEL_RESEARCH', SIMULATED_PAPER: 'SIMULATED_PAPER' });
export function featuredList() {
  return { key: 'FEATURED', kind: LIST_KINDS.EDITORIAL, label: 'Featured', note: 'Editorial watchline. Not Signal 10 picks; never in the model or the simulated account.',
    items: FEATURED.map((f) => ({ symbol: f.symbol, name: f.name, pinned: !!f.pinned })) };
}

// ---------- Signal 10 research overlay (genuine model evidence only) ----------
// From the two latest frozen EOD snapshots (pred_s10_snapshots) + the paper state. Rank/score are the model's 0-100 rank
// index on its own S&P 500 point-in-time universe; a symbol outside that universe gets in_universe:false, never a rank.
// Snapshots store the TOP 50 only: rank null + in_universe true = outside the stored top 50; move NEW = new to that top 50.
export function researchIndex(cur, prev, heldSymbols = [], universe = null) {
  if (!cur?.ranks?.length) return null;
  const prevRank = new Map((prev?.ranks || []).map((r) => [r.symbol, r.rank]));
  const by = new Map();
  for (const r of cur.ranks) {
    const p = prevRank.get(r.symbol) ?? null;
    // no previous snapshot (the first frozen day) -> no move at all, never a wall of NEW
    const move = !prev?.ranks?.length ? null : p == null ? 'NEW' : r.rank < p ? 'UP' : r.rank > p ? 'DOWN' : 'SAME';
    by.set(r.symbol, { rank: r.rank, prev_rank: p, move, score: Number.isFinite(r.score) ? r.score : null });
  }
  const held = new Set(heldSymbols);
  return {
    snapshot: { d: cur.d, frozen_at: cur.frozen_at || null, model: cur.model_version || null, content_sha256: cur.content_sha256 || null, eligible: cur.eligible ?? cur.ranks.length, prev_d: prev?.d || null },
    of(symbol) {
      const r = by.get(symbol);
      const inUniverse = r ? true : universe ? universe.has(symbol) : false;
      return { label: 'PBE SIGNAL 10 RESEARCH', snapshot_d: cur.d, in_universe: inUniverse, rank: r?.rank ?? null, prev_rank: r?.prev_rank ?? null, move: r?.move ?? null, score: r?.score ?? null,
        paper_held: held.has(symbol), paper_label: held.has(symbol) ? 'SIMULATED PAPER POSITION' : null };
    },
    top(n = 10) { return cur.ranks.slice(0, n).filter((r) => r.symbol).map((r) => ({ symbol: r.symbol, name: r.name || r.symbol })); },
  };
}

// ---------- one security row ----------
const STATE_OF = { CURRENT: 'LIVE_QUOTES', DELAYED: 'DELAYED', LAST_CLOSE: 'LAST_CLOSE', STALE: 'STALE', SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE' };
export function securityRow(item, { session, now, quote = null, provider = null, research = null }) {
  const id = IDENTITY[item.symbol] || {};
  const base = {
    symbol: item.symbol, name: item.name, security_id: securityId(item.symbol), legal_name: id.legal_name || null, exchange: id.exchange || null, mic: id.mic || null,
    type: id.type || null, share_class: id.share_class || null, cusip: id.cusip || null, listed_on: id.listed_on || null, pinned: !!item.pinned,
    robinhood_url: robinhoodUrl(item.symbol),
    market_session: session.state, session_open_at: session.opens_at, session_close_at: session.closes_at, next_open_at: session.next_open_at, last_close_at: session.last_close_at,
    source: null, observed_at: null, retrieved_at: null, quote_delay_known: false,
    state: 'SOURCE_RIGHTS_HOLD', last_price: null, previous_regular_close: null, change_abs: null, change_pct: null, attribution: null, rights_scope: 'NONE',
    price_session_date: null, price_basis: null, venue_scope: null,
  };
  if (research) base.research = research;
  if (!provider) return base;
  if (provider.kind === 'SESSION_CLOSE_T1') return { ...base, ...sessionCloseFields(quote, session, provider) };
  const r = tapeRow({ symbol: item.symbol, name: item.name }, quote, session, now);
  const priced = r.price != null;
  return { ...base, source: provider.id, attribution: provider.attribution, quote_delay_known: provider.quote_delay_known, rights_scope: provider.scope,
    state: STATE_OF[r.status] || 'SOURCE_UNAVAILABLE', observed_at: r.price_observed_at, retrieved_at: quote?.fetched_at || null,
    last_price: priced ? r.price : null, previous_regular_close: priced ? r.previous_close : null, change_abs: priced ? r.change_abs : null, change_pct: priced ? r.change_pct : null };
}

// ---------- next-day session-close providers (IEX HIST) ----------
// quote: { session_date, last_price, observed_at, retrieved_at, previous_close, previous_session_date }. The price is the
// last regular-session sale ON THAT VENUE for `session_date`, never presented as current:
//   LAST_CLOSE     market closed and the price is from the latest completed session
//   PRIOR_SESSION  the price is from the latest completed session (market open / pre-market), or one session older while
//                  the newest day is not yet published
//   STALE          anything older -> no price
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
export function sessionCloseFields(q, session, provider) {
  const out = { source: provider.id, attribution: provider.attribution, quote_delay_known: true, rights_scope: provider.scope, venue_scope: provider.venue_scope, price_basis: provider.basis,
    state: 'SOURCE_UNAVAILABLE', observed_at: null, retrieved_at: null, last_price: null, previous_regular_close: null, change_abs: null, change_pct: null, price_session_date: null };
  if (!q || !(q.last_price > 0) || !q.session_date || !session.last_session) return out;
  const latest = session.last_session;
  const closed = session.state !== 'OPEN' && session.state !== 'PRE_MARKET';
  let state;
  if (q.session_date === latest) state = closed ? 'LAST_CLOSE' : 'PRIOR_SESSION';
  else if (q.session_date === prevTradingDay(latest)) state = 'PRIOR_SESSION';
  else return { ...out, state: 'STALE', observed_at: q.observed_at || null, price_session_date: q.session_date };
  const pc = q.previous_close > 0 && q.previous_session_date === prevTradingDay(q.session_date) ? q.previous_close : null;
  return { ...out, state, observed_at: q.observed_at || null, retrieved_at: q.retrieved_at || null, last_price: q.last_price, price_session_date: q.session_date,
    previous_regular_close: pc, change_abs: pc ? round(q.last_price - pc, 4) : null, change_pct: pc ? round((q.last_price - pc) / pc, 6) : null };
}

// ---------- the payload ----------
// lists: [{ key, kind, label, note, items:[{symbol,name,pinned?}] }]; quotes: Map(symbol -> quote record) (only consulted
// when `provider` is non-null); research: researchIndex(...) or null (attached only to member payloads by the caller).
export function buildTape({ now, lists, audience, rights, provider = null, quotes = new Map(), research = null, generatedBy = null }) {
  const session = marketSession(now);
  const out = lists.map((l) => ({ key: l.key, kind: l.kind, label: l.label, note: l.note,
    securities: l.items.map((it) => securityRow(it, { session, now, quote: quotes.get(it.symbol) || null, provider: provider ? { ...provider, scope: rights.scope } : null, research: research ? research.of(it.symbol) : null })) }));
  const all = out.flatMap((l) => l.securities);
  const observed = all.map((s) => s.observed_at).filter(Boolean).sort();
  return {
    contract: CONTRACT, generated_at: now, generated_by: generatedBy, audience,
    session: { state: session.state, label: session.label, date: session.date, early_close: session.early_close, session_open_at: session.opens_at, session_close_at: session.closes_at,
      next_open_at: session.next_open_at, last_session: session.last_session, last_close_at: session.last_close_at, calendar: 'NYSE published holidays + early closes 2026-2028, America/New_York' },
    rights,
    diagnostics: { securities: all.length, priced: all.filter((s) => s.last_price != null).length, last_observed_at: observed.at(-1) || null, refresh_hint_seconds: session.state === 'OPEN' && provider?.kind !== 'SESSION_CLOSE_T1' ? 90 : null,
      price_sessions: [...new Set(all.map((s) => s.price_session_date).filter(Boolean))].sort() },
    research_snapshot: research ? research.snapshot : null,
    lists: out,
  };
}
