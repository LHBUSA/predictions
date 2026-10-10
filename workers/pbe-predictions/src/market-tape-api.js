// PBE Market Tape API (issue #56): GET /v1/market-tape  ->  contract market-tape/1 (src/market-tape/contract.js).
// One backend for every surface: Signal 10 pages (same-origin /api/market-tape), Members/Terminal (server-to-server or the
// same-origin proxy). Read-only, bounded, entitlement-dependent => always private/no-store/Vary: Cookie.
//
//   public visitors   FEATURED (editorial) securities: identity, session, Robinhood link. No research, no holdings.
//   All Access        + PBE SIGNAL 10 RESEARCH overlay (frozen EOD ranks) + Top 10 (MODEL_RESEARCH) + paper holdings
//                       (SIMULATED_PAPER). Research comes from the immutable snapshots/ledger; nothing here writes.
//   prices            only via a provider whose RIGHTS record permits the audience (contract.quoteProvider). Deployed:
//                       iex-hist (IEX next-day last sales, public + paid, credit line), read from our own snapshot.
import { buildTape, featuredList, researchIndex, rightsState, quoteProvider, PROVIDERS, LIST_KINDS, CONTRACT } from '../../../src/market-tape/contract.js';
import { marketSession, quoteFromBars, quoteTtlSeconds } from '../../../src/market-tape/core.js';
import { fetchChart, restoreState, ACCOUNT } from '../../../src/signal10/forward.js';
import { LATEST_MEMBERS } from '../../../src/signal10/members-latest.js';

// ---------- quote adapters (reachable only when a provider's rights permit the audience) ----------
const ADAPTERS = {
  'yahoo-chart': async (symbol, fetchImpl) => {
    const c = await fetchChart(symbol, { range: '5d', interval: '1d', fetchImpl });
    const q = c.status === 200 ? quoteFromBars(symbol, c.json) : null;
    return q ? { ...q, fetched_at: c.retrieved_at } : null;
  },
};

// Per-isolate memo of PLAIN quote data + per-isolate budget. NOTE: this is a local guard only. Before any provider is
// rights-cleared, a scheduled collector writing one canonical snapshot (global throttle) must replace direct reads.
const MEMO = new Map();
export const TAPE_BUDGET = { perMinute: 40 };
const budget = { minute: 0, used: 0 };
export function _tapeReset() { MEMO.clear(); budget.minute = 0; budget.used = 0; CLOSES.at = 0; CLOSES.rows = null; }
function spend(nowMs) {
  const m = Math.floor(nowMs / 60000);
  if (m !== budget.minute) { budget.minute = m; budget.used = 0; }
  if (budget.used >= TAPE_BUDGET.perMinute) return false;
  budget.used += 1;
  return true;
}
async function quoteFor(provider, symbol, session, now, fetchImpl) {
  const nowMs = Date.parse(now);
  const key = `${provider.id}:${symbol}`;
  const m = MEMO.get(key);
  if (m && m.exp > nowMs) return m.rec ? { ...m.rec } : null;
  if (!spend(nowMs)) return m?.rec ? { ...m.rec } : null;
  const ttl = quoteTtlSeconds(session, now);
  const edgeFetch = (url, init) => fetchImpl(url, { ...init, cf: { cacheTtlByStatus: { '200-299': Math.min(ttl, 300), '300-599': 0 }, cacheEverything: true } });
  const adapter = ADAPTERS[provider.id];
  const rec = adapter ? await adapter(symbol, edgeFetch).catch(() => null) : null;
  MEMO.set(key, { rec, exp: nowMs + (rec ? ttl : 60) * 1000 });
  return rec ? { ...rec } : null;
}
// Next-day providers read our own canonical snapshot (written by the collector lane), never the vendor, per request.
const CLOSES = { at: 0, rows: null }; // per-isolate cache of the snapshot rows (plain data only), 60 s
async function sessionCloses(store, providerId, symbols, now) {
  if (providerId !== 'iex-hist') return new Map();
  const t = Date.parse(now);
  if (!(CLOSES.rows && t - CLOSES.at < 60000 && t >= CLOSES.at)) {
    const since0 = new Date(t - 12 * 86400000).toISOString();
    CLOSES.rows = await store.select('pred_source_observations', { select: 'observation_key,source_id,observed_at,captured_at,value,data', provider: 'eq.iex', source_id: 'like.iex:TOPS:*', observed_at: `gte.${since0}` }, { order: 'observed_at.desc', limit: 2000 });
    CLOSES.at = t;
  }
  return closesFrom(CLOSES.rows, symbols);
}
function closesFrom(rows, symbols) {
  const by = new Map();
  for (const r of rows) {
    const sym = r.source_id.slice('iex:TOPS:'.length);
    if (!symbols.includes(sym)) continue;
    const list = by.get(sym) || []; list.push(r); by.set(sym, list);
  }
  const out = new Map();
  for (const [sym, list] of by) {
    const [cur, prev] = list.sort((a, b) => String(b.data?.session_date).localeCompare(String(a.data?.session_date)));
    out.set(sym, { session_date: cur.data?.session_date, last_price: Number(cur.value), observed_at: cur.observed_at, retrieved_at: cur.captured_at,
      previous_close: prev ? Number(prev.value) : null, previous_session_date: prev?.data?.session_date || null });
  }
  return out;
}
async function pooled(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const closeDay = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}` : String(d || ''); };

// ---------- research (members only; read-only from the immutable Signal 10 tables) ----------
async function research(store) {
  const snaps = await store.select('pred_s10_snapshots', { select: 'd,model_version,frozen_at,eligible,ranks,content_sha256', d: 'not.is.null' }, { limit: 2, order: 'd.desc' });
  const [state] = await store.select('pred_s10_events', { account: `eq.${ACCOUNT}`, type: 'eq.STATE', select: 'seq,d,payload' }, { limit: 1, order: 'seq.desc' });
  const held = [];
  if (state) { const { st } = restoreState(state.payload); for (const [symbol, pos] of Object.entries(st.positions)) held.push({ symbol, name: pos.name || symbol }); }
  const idx = researchIndex(snaps[0], snaps[1], held.map((h) => h.symbol), new Set(LATEST_MEMBERS.tickers));
  return { idx, held };
}

// The payload (a plain object; callers wrap it). member: boolean (already decided by the caller's entitlement check).
export async function marketTape({ env, store, member, now = new Date().toISOString(), fetchImpl = fetch, providers = PROVIDERS, generatedBy = null }) {
  const audience = member ? 'paid' : 'public';
  const rights = rightsState(env, audience, providers);
  const provider = quoteProvider(env, audience, providers);
  const lists = [featuredList()];
  let idx = null;
  if (member) {
    try {
      const r = await research(store);
      idx = r.idx;
      if (idx) lists.push({ key: 'SIGNAL10_TOP10', kind: LIST_KINDS.MODEL_RESEARCH, label: `Top 10 · as of ${closeDay(idx.snapshot.d)} close`, note: 'PBE Signal 10 research: the model’s ranking, set at the close. Not advice.', items: idx.top(10) });
      if (r.held.length) lists.push({ key: 'SIGNAL10_PAPER', kind: LIST_KINDS.SIMULATED_PAPER, label: 'Paper holdings · simulated', note: 'Positions in the SIMULATED $10,000 paper account. Not brokerage holdings.', items: r.held });
    } catch { /* research unavailable: the featured tape still renders, without research */ }
  }
  let quotes = new Map();
  if (provider?.kind === 'SESSION_CLOSE_T1') {
    try { quotes = await sessionCloses(store, provider.id, [...new Set(lists.flatMap((l) => l.items.map((i) => i.symbol)))], now); } catch { quotes = new Map(); }
  } else if (provider) {
    const session = marketSession(now);
    const symbols = [...new Set(lists.flatMap((l) => l.items.map((i) => i.symbol)))];
    const got = await pooled(symbols, 6, (s) => quoteFor(provider, s, session, now, fetchImpl));
    symbols.forEach((s, i) => quotes.set(s, got[i]));
  }
  return buildTape({ now, lists, audience, rights, provider, quotes, research: idx, generatedBy });
}

export async function handleMarketTape({ req, env, p, store, requireAllAccess, privateJson, json, tokenMatches }) {
  const admin = p === '/admin/market-tape';
  if (p !== '/v1/market-tape' && !admin) return null;
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, 'no-store');
  let member;
  if (admin) {
    // read-only verification of the member payload: admin token or the read-only DIAGNOSTICS_TOKEN
    if (!(await tokenMatches(req, env.ADMIN_TOKEN)) && !(await tokenMatches(req, env.DIAGNOSTICS_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
    member = true;
  } else {
    // soft entitlement check: not entitled / unverifiable -> the public payload (the tape itself never errors)
    const g = await requireAllAccess(req, env).catch(() => ({ ok: false }));
    member = !!g.ok;
  }
  const body = await marketTape({ env, store, member, generatedBy: env.CF_VERSION_METADATA?.id ?? null });
  return privateJson(body, 200, { 'x-pbe-contract': CONTRACT });
}
