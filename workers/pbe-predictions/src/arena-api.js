// PBE Signal 10 STRATEGY ARENA + PRECIOUS METALS API (issues #62 / #63).
//   GET /v1/signal10/arena/proof   PUBLIC  versions, policy hashes, T0, ledger heads, snapshot hashes. No NAV, no holdings.
//   GET /v1/signal10/arena         ALL ACCESS  three-way head-to-head: NAV since T0 (Original indexed to $10,000 at T0, plus
//                                  its real lifetime record), metrics, holdings, exposures, latest decisions, comparators.
//   GET /v1/signal10/arena/ledger  ALL ACCESS  ?account=S10-ARENA-TECH-1|S10-ARENA-DIV-1 every row (recompute the chain)
//   GET /v1/metals                 PUBLIC + member extras  metals/1: spot identity + rights state, ETF proxies with
//                                  rights-cleared IEX next-day observations only, Diversified sleeve state for members.
// Reads only. The control tables (pred_s10_*) are read, never written. Raw source prices from the paper-account data
// source are never returned: members see derived portfolio values (weights, NAV, returns), as for the control.
import { ACCOUNT as CONTROL_ACCOUNT, restoreState } from '../../../src/signal10/forward.js';
import { MODEL_VERSION as CONTROL_MODEL, POLICY_VERSION as CONTROL_POLICY } from '../../../src/signal10/policy.js';
import { CHALLENGERS, TECH, DIVERSIFIED, ARENA_VERSION, DISCLOSURE } from '../../../src/signal10/arena/policies.js';
import { T, restore, policyHash, runArenaEod, runArenaOpen } from '../../../src/signal10/arena/forward.js';
import { indexSeries, seriesMetrics, turnover, SHARPE_MIN_OBS } from '../../../src/signal10/arena/metrics.js';
import { SECTOR_LABEL, TAXONOMY_VERSION } from '../../../src/signal10/arena/taxonomy.js';
import { METALS_CONTRACT, SPOT, METAL_ETFS, SPOT_HOLD, observation } from '../../../src/market-tape/metals.js';
import { rightsState, quoteProvider } from '../../../src/market-tape/contract.js';
import { IEX_ATTRIBUTION } from '../../../src/market-tape/iex-hist.js';
import { marketSession } from '../../../src/market-tape/core.js';
import CLASSIFICATION from '../../../data/signal10/arena/classification.json' with { type: 'json' };

export const THESIS = {
  ORIGINAL: 'The control. S&P 500 momentum with a low-volatility tilt, dip and persistence entries, 10 slots. Pre-registered 2026-10-09 and never changed.',
  TECH: 'Concentrated conviction in technology leaders: pure momentum, buys strength, 8 slots, a QQQ regime filter and a stop cooldown.',
  DIVERSIFIED: 'Cross-sector risk discipline: risk-adjusted trend, inverse-volatility sizing, hard caps of 10% per holding, 25% per sector and 20% in precious-metal ETFs. Cash allowed.',
};
const CARD = [
  { key: 'ORIGINAL', label: 'Original', sub: 'Control', account: CONTROL_ACCOUNT, model: CONTROL_MODEL, policy: CONTROL_POLICY },
  { key: 'TECH', label: TECH.label, sub: 'Challenger', account: TECH.account, model: TECH.model, policy: TECH.policy },
  { key: 'DIVERSIFIED', label: DIVERSIFIED.label, sub: 'Challenger', account: DIVERSIFIED.account, model: DIVERSIFIED.model, policy: DIVERSIFIED.policy },
];

const sectorOfTicker = (sym) => { const r = CLASSIFICATION.rows[sym] || CLASSIFICATION.rows[String(sym).replace(/-/g, '.')]; return r?.sector || 'UNCLASSIFIED'; };
const slimEvent = (e) => { const p = e.payload || {}; return { seq: e.seq, type: e.type, d: e.d, action: p.action || (e.type === 'ORDER' ? p.side : null), symbol: p.symbol ?? null, qty: p.qty ?? null, targetCents: p.targetCents ?? null, reason: p.reason ?? null, rank: p.rank ?? null, score: p.score ?? null }; };

async function challengerHead(store, account) {
  const [state] = await store.select(T.events, { account: `eq.${account}`, type: 'eq.STATE', select: 'seq,d,payload,hash' }, { limit: 1, order: 'seq.desc' });
  const [last] = await store.select(T.events, { account: `eq.${account}`, select: 'seq,hash,inserted_at' }, { limit: 1, order: 'seq.desc' });
  const [fund] = await store.select(T.events, { account: `eq.${account}`, type: 'eq.FUNDING', select: 'd,hash,inserted_at,policy_sha256' }, { limit: 1, order: 'seq.asc' });
  return { state: state || null, seq: last?.seq || 0, head: last?.hash || null, headAt: last?.inserted_at || null, funding: fund || null };
}

// ---------------- public proof ----------------
export async function arenaProof(store) {
  const strategies = [];
  for (const S of CHALLENGERS) {
    const h = await challengerHead(store, S.account).catch(() => null);
    const [snap] = h ? await store.select(T.snapshots, { account: `eq.${S.account}`, select: 'd,model_version,content_sha256,frozen_at,eligible' }, { limit: 1, order: 'd.desc' }).catch(() => []) : [];
    strategies.push({ key: S.strategy, label: S.label, account: S.account, model: S.model, policy: S.policy, policy_sha256: await policyHash(S),
      status: !h ? 'UNAVAILABLE' : h.funding ? 'RUNNING' : 'AWAITING_T0', inception: h?.funding?.d ?? null, funding_hash: h?.funding?.hash ?? null,
      ledger_events: h?.seq ?? 0, ledger_head_hash: h?.head ?? null, ledger_head_at: h?.headAt ?? null,
      latest_snapshot: snap ? { d: snap.d, model: snap.model_version, content_sha256: snap.content_sha256, frozen_at: snap.frozen_at, eligible: snap.eligible } : null });
  }
  const t0 = strategies.map((s) => s.inception).filter(Boolean).sort()[0] || null;
  return { product: 'PBE Signal 10 · Strategy Arena', arena: ARENA_VERSION, t0, preregistration: 'https://github.com/LHBUSA/predictions/blob/main/docs/signal10/strategy-arena/PREREGISTRATION.md',
    control: { key: 'ORIGINAL', account: CONTROL_ACCOUNT, model: CONTROL_MODEL, policy: CONTROL_POLICY, note: 'Unchanged and never reset; compared indexed to $10,000 at T0.' },
    strategies, taxonomy: { version: TAXONOMY_VERSION, effective_from: CLASSIFICATION.effective_from, content_sha256: CLASSIFICATION.content_sha256 }, disclosure: DISCLOSURE };
}

// ---------------- member head-to-head ----------------
function holdingsFrom(positions, navCents, stPositions, sectorFn) {
  return (positions || []).map((x) => {
    const pos = stPositions?.[x.symbol] || {};
    const value = x.valueCents ?? null;
    return { symbol: x.symbol, name: pos.name || null, sector: pos.kind === 'METAL_ETF' ? 'PRECIOUS_METALS' : (pos.sector || sectorFn(x.symbol)), kind: pos.kind || 'EQUITY', qty: x.qty,
      weight: navCents && value != null ? value / navCents : null, cost_cents: x.costCents ?? pos.costCents ?? null, value_cents: value,
      pnl_pct: value != null && (x.costCents ?? pos.costCents) ? value / (x.costCents ?? pos.costCents) - 1 : null, entry_date: pos.entryDate || null };
  }).sort((a, b) => (b.value_cents || 0) - (a.value_cents || 0));
}
function exposureOf(holdings, navCents, cashCents) {
  const sectors = {}; let metals = 0; let maxPos = 0;
  for (const h of holdings) { if (h.weight == null) continue; maxPos = Math.max(maxPos, h.weight); if (h.kind === 'METAL_ETF') metals += h.weight; else sectors[h.sector] = (sectors[h.sector] || 0) + h.weight; }
  return { sectors: Object.entries(sectors).map(([k, w]) => ({ key: k, label: SECTOR_LABEL[k] || k, weight: w })).sort((a, b) => b.weight - a.weight), metals, cash: navCents ? cashCents / navCents : null, max_position: maxPos };
}

export async function arenaPayload(store) {
  const heads = Object.fromEntries(await Promise.all(CHALLENGERS.map(async (S) => [S.strategy, await challengerHead(store, S.account)])));
  const t0 = [heads.TECH.funding?.d, heads.DIVERSIFIED.funding?.d].filter(Boolean).sort()[0] || null;
  const out = { product: 'PBE Signal 10 · Strategy Arena', arena: ARENA_VERSION, t0, status: t0 ? 'RUNNING' : 'AWAITING_T0', sharpe_min_observations: SHARPE_MIN_OBS, strategies: [], comparators: null, disclosure: DISCLOSURE };

  // ORIGINAL / CONTROL (read-only)
  const cMarks = await store.select('pred_s10_marks', { account: `eq.${CONTROL_ACCOUNT}`, kind: 'eq.EOD_CLOSE', select: 'd,nav_cents,cash_cents,positions,benchmarks' }, { order: 'd.asc' });
  const [cState] = await store.select('pred_s10_events', { account: `eq.${CONTROL_ACCOUNT}`, type: 'eq.STATE', select: 'seq,d,payload' }, { limit: 1, order: 'seq.desc' });
  const [cFund] = await store.select('pred_s10_events', { account: `eq.${CONTROL_ACCOUNT}`, type: 'eq.FUNDING', select: 'd' }, { limit: 1, order: 'seq.asc' });
  const cSt = cState ? restoreState(cState.payload).st : null;
  const cLife = cMarks.map((m) => ({ d: m.d, nav: m.nav_cents }));
  const cSince = t0 ? cLife.filter((p) => p.d >= t0) : [];
  const cBase = t0 ? (cLife.filter((p) => p.d <= t0 && p.nav != null).at(-1)?.nav ?? null) : null;
  const cLast = cMarks.at(-1) || null;
  const cHold = holdingsFrom(cLast?.positions, cLast?.nav_cents, cSt?.positions, sectorOfTicker);
  out.strategies.push({ ...CARD[0], thesis: THESIS.ORIGINAL, status: cFund ? 'RUNNING' : 'NOT_STARTED', inception: cFund?.d ?? null,
    index_base: t0 ? { d: t0, nav_cents: cBase, note: 'Display-only normalization: Original NAV ÷ its NAV at T0 × $10,000. Its real ledger is unchanged.' } : null,
    series: t0 ? indexSeries(cSince, cBase) : [], lifetime: indexSeries(cLife, 1_000_000), metrics: seriesMetrics(cSince), metrics_lifetime: seriesMetrics(cLife),
    nav: { cents: cLast?.nav_cents ?? null, d: cLast?.d ?? null }, cash_cents: cLast?.cash_cents ?? null, holdings: cHold, exposure: exposureOf(cHold, cLast?.nav_cents, cLast?.cash_cents ?? 0),
    turnover: turnover(cSt, cLife), pre_existing_at_t0: t0 ? { note: 'The Original was already invested when the cohort started; its positions at T0 are part of its comparison.' } : null,
    pending: (cSt?.pending || []).map((o) => ({ side: o.side, symbol: o.symbol, qty: o.qty ?? null, targetCents: o.targetCents ?? null, reason: o.reason })), decisions: [] });

  // challengers
  for (const S of CHALLENGERS) {
    const h = heads[S.strategy];
    const card = CARD.find((c) => c.key === S.strategy);
    const base = { ...card, thesis: THESIS[S.strategy], policy_sha256: await policyHash(S), status: h.funding ? 'RUNNING' : 'AWAITING_T0', inception: h.funding?.d ?? null,
      ledger: { events: h.seq, head_hash: h.head } };
    if (!h.state) { out.strategies.push({ ...base, series: [], metrics: seriesMetrics([]), holdings: [], exposure: null, decisions: [], pending: [] }); continue; }
    const { st } = restore(h.state.payload);
    const marks = await store.select(T.marks, { account: `eq.${S.account}`, select: 'd,nav_cents,cash_cents,coverage,positions,exposures,benchmarks' }, { order: 'd.asc' });
    const pts = marks.map((m) => ({ d: m.d, nav: m.nav_cents }));
    const last = marks.at(-1) || null;
    const hold = holdingsFrom(last?.positions, last?.nav_cents, st.positions, (s) => st.positions[s]?.sector || 'UNCLASSIFIED');
    const lastD = last?.d || null;
    const evs = lastD ? await store.select(T.events, { account: `eq.${S.account}`, d: `eq.${lastD}`, select: 'seq,type,d,payload' }, { order: 'seq.asc' }) : [];
    out.strategies.push({ ...base, series: indexSeries(pts), metrics: seriesMetrics(pts), nav: { cents: last?.nav_cents ?? null, d: lastD, coverage: last?.coverage ?? null },
      cash_cents: st.cashCents, holdings: hold, exposure: exposureOf(hold, last?.nav_cents, last?.cash_cents ?? st.cashCents), turnover: turnover(st, pts),
      decisions: evs.filter((e) => e.type === 'ORDER' || e.type === 'DECISION').map(slimEvent), pending: st.pending.map((o) => ({ side: o.side, symbol: o.symbol, qty: o.qty ?? null, targetCents: o.targetCents ?? null, reason: o.reason })),
      cooldown: st.cooldown || {} });
    if (S === TECH && marks.length) {
      const bench = (k) => indexSeries(marks.map((m) => ({ d: m.d, nav: m.benchmarks?.[k] ?? null })), 1_000_000);
      out.comparators = { note: 'SPY and QQQ buy-and-hold, $10,000 each, bought at the same first open as the challengers (dividends reinvested as cash).', SPY: bench('SPY'), QQQ: bench('QQQ') };
    }
  }
  out.sample = { first_d: t0, last_d: out.strategies.map((s) => s.nav?.d).filter(Boolean).sort().at(-1) || null, sessions: out.strategies.find((s) => s.key === 'TECH')?.series?.length || 0 };
  return out;
}

// ---------------- precious metals (metals/1) ----------------
async function etfObservations(store) {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const rows = await store.select('pred_source_observations', { select: 'source_id,observed_at,captured_at,value,data', provider: 'eq.iex', source_id: 'like.iex:TOPS:*', observed_at: `gte.${since}` }, { order: 'observed_at.desc', limit: 2000 });
  const by = {};
  for (const r of rows) { const sym = r.source_id.split(':').at(-1); if (METAL_ETFS.some((e) => e.symbol === sym)) (by[sym] ||= []).push(r); }
  for (const k of Object.keys(by)) by[k].sort((a, b) => String(b.data?.session_date).localeCompare(String(a.data?.session_date)));
  return by;
}

export async function metalsPayload({ env, store, member, now = new Date().toISOString() }) {
  const audience = member ? 'paid' : 'public';
  const rights = rightsState(env, audience);
  const provider = quoteProvider(env, audience);
  const obs = provider?.id === 'iex-hist' ? await etfObservations(store).catch(() => ({})) : {};
  const spot = SPOT.map((x) => ({ ...x, quote: { ...observation({ instrument: x }), state: SPOT_HOLD.state, label: SPOT_HOLD.label } }));
  const etfs = METAL_ETFS.map((e) => {
    const [cur, prev] = obs[e.symbol] || [];
    const o = observation({ instrument: e, value: cur ? Number(cur.value) : null, observed_at: cur?.observed_at ?? null, session_date: cur?.data?.session_date ?? null,
      source: cur ? 'IEX Historical Data (TOPS)' : null, rights: cur ? rights.scope : null, delay: cur ? 'T+1 (published the next morning)' : null, basis: cur ? 'IEX-venue last sale (not consolidated, not spot)' : null });
    const prevV = prev ? Number(prev.value) : null;
    return { ...e, quote: { ...o, state: !provider ? 'SOURCE_RIGHTS_HOLD' : cur ? 'NEXT_DAY' : 'AWAITING_FIRST_OBSERVATION',
      previous: prev ? { value: prevV, session_date: prev.data?.session_date ?? null } : null,
      change_pct: o.value != null && prevV ? o.value / prevV - 1 : null } };
  });
  const out = { contract: METALS_CONTRACT, generated_at: now, session: marketSession(now), audience: member ? 'member' : 'public', rights: { spot: SPOT_HOLD, etf: rights },
    attribution: provider?.id === 'iex-hist' ? IEX_ATTRIBUTION : null, spot, etfs,
    sources: [
      { source: 'LBMA Gold / Silver Price, LBMA Platinum Price (ICE Benchmark Administration)', internal: 'licence required', paid: 'licence required', public: 'licence required (delayed public display also licensed)', used: false },
      { source: 'IEX Historical Data (TOPS), GLD / SLV / PPLT', internal: 'permitted', paid: 'permitted with credit line', public: 'permitted with credit line', used: true, note: 'IEX-venue trades only, T+1; an ETF share price, never a spot price' },
      { source: 'FRED (St. Louis Fed)', internal: 'n/a', paid: 'n/a', public: 'n/a', used: false, note: 'LBMA gold/silver series removed 2022-01-31' },
      { source: 'COMEX futures (CME Group)', internal: 'licence', paid: 'licence', public: 'fee-bearing website licence', used: false, note: 'futures are not spot' },
      { source: 'Yahoo Finance chart endpoint', internal: 'terms restrict automated / commercial use', paid: 'no', public: 'no', used: false, note: 'never displayed' },
    ],
    disclosure: 'Research and education, not investment advice. ETF prices are not spot metal prices; an ETF carries fees and tracking differences.' };
  if (member) {
    const [snap] = await store.select(T.snapshots, { account: `eq.${DIVERSIFIED.account}`, select: 'd,metals' }, { limit: 1, order: 'd.desc' }).catch(() => []);
    const [mk] = await store.select(T.marks, { account: `eq.${DIVERSIFIED.account}`, select: 'd,exposures' }, { limit: 1, order: 'd.desc' }).catch(() => []);
    out.diversified_sleeve = { cap: DIVERSIFIED.manager.maxMetalsWeight, as_of: snap?.d ?? null, candidates: snap?.metals ?? [], weight: mk?.exposures?.metals ?? null,
      holdings: mk ? Object.entries(mk.exposures?.holdings || {}).filter(([s]) => METAL_ETFS.some((e) => e.symbol === s)).map(([symbol, weight]) => ({ symbol, weight })) : [] };
  }
  return out;
}

// ---------------- router ----------------
export async function handleArena({ req, env, p, url, store, requireAllAccess, privateJson, json, tokenMatches }) {
  // admin: manual run / rerun after a failed claimed run (?rerun=2 claims <ACCOUNT>:EOD:<date>#2). Never bypasses the kill
  // switch or T0, never touches the control.
  if (p === '/admin/signal10/arena/run' && req.method === 'POST') {
    if (!(await tokenMatches(req, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, 'no-store');
    if (env.SIGNAL10_ARENA !== 'true') return json({ skipped: 'kill_switch_off' }, 200, 'no-store');
    const now = url.searchParams.get('now') || new Date().toISOString();
    const args = { store, now, workerVersion: env.CF_VERSION_METADATA?.id ?? null, t0: env.SIGNAL10_ARENA_T0 };
    const kind = url.searchParams.get('kind');
    const r = kind === 'EOD' ? await runArenaEod({ ...args, rerun: url.searchParams.get('rerun') }) : kind === 'OPEN' ? await runArenaOpen(args) : { error: 'kind must be OPEN|EOD' };
    return json(r, 200, 'no-store');
  }
  if (p === '/v1/signal10/arena/proof') {
    try { return json(await arenaProof(store), 200, 'public, max-age=60'); } catch { return json({ product: 'PBE Signal 10 · Strategy Arena', status: 'UNAVAILABLE', disclosure: DISCLOSURE }, 503, 'no-store'); }
  }
  if (p === '/v1/metals') {
    const g = await requireAllAccess(req, env).catch(() => ({ ok: false }));
    const body = await metalsPayload({ env, store, member: !!g.ok });
    return g.ok ? privateJson({ ...body, access: { tier: g.m.membership.state } }) : json(body, 200, 'public, max-age=60');
  }
  if (p !== '/v1/signal10/arena' && p !== '/v1/signal10/arena/ledger') return null;
  const g = await requireAllAccess(req, env); if (!g.ok) return g.res;
  const access = { tier: g.m.membership.state };
  if (p === '/v1/signal10/arena') return privateJson({ ...(await arenaPayload(store)), access });
  const account = url.searchParams.get('account');
  const S = CHALLENGERS.find((x) => x.account === account);
  if (!S) return privateJson({ error: `account must be ${CHALLENGERS.map((x) => x.account).join(' or ')}` }, 400);
  const q = { account: `eq.${S.account}`, select: 'seq,type,d,payload,hash,prev_hash,model_version,policy_version,policy_sha256,strategy,origin,inserted_at' };
  const since = Number.parseInt(url.searchParams.get('since') || '', 10); if (Number.isFinite(since) && since > 0) q.seq = `gt.${since}`;
  const limit = Math.min(5000, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '2000', 10) || 2000));
  const rows = await store.select(T.events, q, { order: 'seq.asc', limit });
  return privateJson({ account: S.account, strategy: S.strategy, verify: 'hash = sha256(prev_hash + canonical({account,origin,strategy,seq,type,d,payload,model_version,policy_version,policy_sha256})), canonical = JSON with sorted keys', events: rows.map((r) => ({ ...r, account: S.account })), access });
}
