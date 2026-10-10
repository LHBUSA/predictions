// Signal 10 Strategy Arena FORWARD PAPER lane (origin ARENA_FORWARD_PAPER, issue #62). Two challenger accounts:
//   S10-ARENA-TECH-1 (Tech Conviction) and S10-ARENA-DIV-1 (Diversified Risk Discipline), each $10,000 simulated from T0.
// Isolation from the ORIGINAL / CONTROL account: separate tables (pred_s10a_*, sql/018), account-scoped claim
// keys, separate hash chains, separate kill switch (SIGNAL10_ARENA) and start (SIGNAL10_ARENA_T0). The control's modules
// are imported read-only for shared pure helpers; nothing here writes pred_s10_* or changes the control's behaviour.
// Upstream reads: ONE history fetch per session serves both challengers (control 1x + arena 1x; never one per account).
//   OPEN (>= 09:45 ET)  fills for orders frozen at the previous close, at D's regular-session open
//   EOD  (>= 16:31 ET, odd minutes, after the control's EOD window opens) freeze ranks, mark, enforce caps, decide D+1
import { parseYahooChart } from '../data.js';
import { emit } from '../portfolio.js';
import { loadComponents } from '../universe.js';
import { resolveSymbol } from '../aliases.js';
import { LATEST_MEMBERS } from '../members-latest.js';
import { nyClock, fetchChart, quoteFromChart, sha256Hex, canonical, COMPONENTS_URL } from '../forward.js';
import { ORIGINAL, TECH, DIVERSIFIED, CHALLENGERS, ARENA_VERSION } from './policies.js';
import { prepareSeries, rankStrategy, rankOriginal, decideOriginal, regimeOf, newChallenger, openSession, decideTech, decideDiversified, exposures, arenaFeatures, mark, delistings, ORIGIN } from './engine.js';
import { TAXONOMY_VERSION } from './taxonomy.js';
import { METAL_ETFS, etfEligibility } from '../../market-tape/metals.js';
import { closeMinutes } from '../../market-tape/core.js';
import CLASSIFICATION from '../../../data/signal10/arena/classification.json' with { type: 'json' };

export { ORIGIN };
export const T = Object.freeze({ runs: 'pred_s10a_runs', events: 'pred_s10a_events', snapshots: 'pred_s10a_snapshots', marks: 'pred_s10a_marks' });
const UA = 'Mozilla/5.0 (compatible; PropBetEdge-Signal10-Arena/1.0; +https://predictions.propbetedge.ai/markets/signal-10/arena/)';

export async function policyHash(S) { return sha256Hex(canonical({ arena: ARENA_VERSION, strategy: S.strategy, account: S.account, model: S.model, policy: S.policy, universe: S.universe, rank: S.rank, manager: S.manager })); }

export function arenaDue(iso) {
  const c = nyClock(iso);
  if (['Sat', 'Sun'].includes(c.weekday)) return { ...c, open: false, eod: false };
  return { ...c, open: c.minutes >= 9 * 60 + 45 && c.minutes < 16 * 60, eod: c.minutes >= 16 * 60 + 31 && c.minutes < 23 * 60 + 30 && c.minutes % 2 === 1 };
}

// ---------- state <-> events ----------
export function serialize(st, bench) {
  const { events, ...rest } = st; // eslint-disable-line no-unused-vars
  return { ...rest, bench: Object.fromEntries(Object.entries(bench || {}).map(([k, v]) => { const { events: _e, ...r } = v; return [k, r]; })) };
}
// STATE events carry the whole account under payload.state (review fix: a flat payload lost st.seq / st.origin, because
// the ledger row keeps seq and origin as its own columns).
export function restore(payload) {
  const { bench, ...st } = structuredClone(payload.state ?? payload); st.events = [];
  return { st, bench: Object.fromEntries(Object.entries(bench || {}).map(([k, v]) => [k, { ...v, events: [] }])) };
}
export async function loadHead(store, account) {
  const [state] = await store.select(T.events, { account: `eq.${account}`, type: 'eq.STATE', select: 'seq,d,payload,hash' }, { limit: 1, order: 'seq.desc' });
  const [last] = await store.select(T.events, { account: `eq.${account}`, select: 'seq,hash' }, { limit: 1, order: 'seq.desc' });
  return { state: state || null, lastSeq: last?.seq || 0, lastHash: last?.hash || '0'.repeat(64) };
}
export function eventHashBody(r) { return { account: r.account, origin: r.origin, strategy: r.strategy, seq: r.seq, type: r.type, d: r.d, payload: r.payload, model_version: r.model_version, policy_version: r.policy_version, policy_sha256: r.policy_sha256 }; }
// The payload is normalised through JSON BEFORE hashing (review fix): the store persists JSON, which drops undefined
// values, so the hash must cover exactly the bytes a verifier will read back. `local_seq` is the account-local event
// number that ORDER/FILL events use to link (FILL.orderSeq = ORDER.local_seq).
const stored = (v) => JSON.parse(JSON.stringify(v));
async function appendEvents(store, head, S, pSha, events) {
  let prev = head.lastHash, seq = head.lastSeq; const rows = [];
  for (const e of events) {
    seq += 1;
    const { seq: localSeq, origin: _o, type, d, ...rest } = e;
    const payload = stored(localSeq ? { local_seq: localSeq, ...rest } : rest);
    const body = { account: S.account, origin: ORIGIN, strategy: S.strategy, seq, type, d, payload, model_version: S.model, policy_version: S.policy, policy_sha256: pSha };
    const hash = await sha256Hex(prev + canonical(body));
    rows.push({ event_key: `${S.account}:${seq}`, ...body, prev_hash: prev, hash }); prev = hash;
  }
  if (rows.length) await store.insertMany(T.events, rows, 'event_key');
  return { lastSeq: seq, lastHash: prev, rows };
}
// Verify an account's full chain (any reader can do the same with the member ledger API).
export async function verifyChain(rows) {
  let prev = '0'.repeat(64);
  for (const [k, r] of rows.entries()) {
    if (r.seq !== k + 1) return { ok: false, at: r.seq, why: 'seq_gap' };
    if (r.prev_hash !== prev) return { ok: false, at: r.seq, why: 'prev_hash' };
    if (await sha256Hex(prev + canonical(eventHashBody(r))) !== r.hash) return { ok: false, at: r.seq, why: 'hash' };
    prev = r.hash;
  }
  return { ok: true, events: rows.length, head: prev };
}
export async function claim(store, runKey, account, kind, d, workerVersion) {
  const out = await store.write(T.runs, [{ run_key: runKey, account, kind, d, worker_version: workerVersion }], { conflictColumn: 'run_key', returnRepresentation: true });
  return Array.isArray(out) && out.length === 1;
}

// ---------- universe + market ----------
export function classificationFor(D, snapshot = CLASSIFICATION) {
  return snapshot.effective_from <= D ? snapshot : null; // a snapshot never classifies a date before it existed
}
export function universes(tickers, D, cls) {
  const all = tickers.map((t) => { const c = cls.rows[t]; return { ticker: t, symbol: resolveSymbol(t, D), sector: c?.sector || 'UNCLASSIFIED', tech: !!c?.tech }; });
  // orig = the V1 universe: every member, classified or not (V1 has no taxonomy)
  return { orig: all.map(({ ticker, symbol }) => ({ ticker, symbol })), sectorOf: Object.fromEntries(all.filter((u) => u.symbol).map((u) => [u.symbol, u.sector])),
    tech: all.filter((u) => u.tech), div: all.filter((u) => u.sector !== 'UNCLASSIFIED'), unclassified: all.filter((u) => u.sector === 'UNCLASSIFIED').map((u) => u.ticker) };
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
export async function buildMarket(symbols, D, fetchImpl, range) {
  const charts = await pool([...new Set(symbols)], 12, (s) => fetchChart(s, { range, fetchImpl }));
  const series = {}; const digest = {};
  for (const c of charts) {
    const s = c.status === 200 ? parseYahooChart(c.json, { cutoffDate: D }) : null;
    digest[c.symbol] = { status: c.status, sha256: c.sha256, retrieved_at: c.retrieved_at, lastBar: s?.bars.at(-1)?.d || null, regularMarketTime: c.json?.chart?.result?.[0]?.meta?.regularMarketTime ?? null };
    if (s && s.bars.length) series[c.symbol] = s;
  }
  if (!series.SPY) return { ok: false, reason: 'SPY unavailable', digest };
  const calendar = series.SPY.bars.map((b) => b.d);
  const calIndex = new Map(calendar.map((d, i) => [d, i]));
  return { ok: true, calendar, calIndex, prepared: new Map(Object.entries(series).map(([k, s]) => [k, prepareSeries(s, calIndex)])), digest };
}
async function currentMembers(fetchImpl) {
  try {
    const r = await fetchImpl(COMPONENTS_URL, { headers: { 'user-agent': UA } });
    if (r.ok) { const csv = await r.text(); const row = loadComponents(csv).at(-1); if (row && row.tickers.length >= 450) return { date: row.date, tickers: row.tickers, source: 'fja05680/sp500 live', sha256: await sha256Hex(csv) }; }
  } catch { /* fall back */ }
  return { date: LATEST_MEMBERS.date, tickers: [...LATEST_MEMBERS.tickers], source: 'bundled copy', sha256: null };
}
export function metalCandidates(prepared, D, calIndex) {
  const spyCal = new Set(calIndex.keys());
  return METAL_ETFS.map((etf) => {
    const p = prepared.get(etf.symbol) || null;
    const el = etfEligibility(etf, p, D, { spyCal });
    const f = p ? arenaFeatures(p, p.idx.get(D), DIVERSIFIED.rank) : { eligible: false, reason: 'no_price_series' };
    return { ...el, f };
  });
}

const r6 = (x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x);
const slimRank = (r) => ({ rank: r.rank, symbol: r.symbol, ticker: r.ticker, name: r.name, sector: r.sector, score: r.score, f: Object.fromEntries(Object.entries(r.f).map(([k, v]) => [k, r6(v)])) });

// ---------- runs ----------
function openBoth(states, D, mkt, late) {
  const out = {};
  for (const [acct, { st, bench }] of Object.entries(states)) {
    const evs = openSession(st, D, mkt.prepared);
    for (const [k, b] of Object.entries(bench)) { const n0 = b.events.length; openSession(b, D, mkt.prepared); for (const { seq: _bs, orderSeq: _bo, ...e } of b.events.slice(n0)) evs.push({ ...e, type: `BENCHMARK_${e.type}`, d: D, benchmark: k }); b.events = []; }
    evs.push({ type: 'SESSION', d: D, fillSession: st.fillSessions, note: late ? 'fills booked at end of day from the session OPEN in the final daily bar (open run did not complete intraday)' : 'fills at the session OPEN as reported by the source' });
    out[acct] = evs;
  }
  return out;
}

export async function runArenaOpen({ store, now, fetchImpl = fetch, workerVersion = null, t0 }) {
  const D = nyClock(now).date;
  if (!t0) return { skipped: 'no_t0' };
  const states = {}; const heads = {};
  for (const S of CHALLENGERS) {
    const h = await loadHead(store, S.account); if (!h.state) continue;
    const s = restore(h.state.payload); if (s.st.lastOpen >= D || s.st.inception >= D) continue;
    states[S.account] = s; heads[S.account] = h;
  }
  if (!Object.keys(states).length) return { skipped: 'nothing_due' };
  const spy0 = quoteFromChart(await fetchChart('SPY', { range: '1d', fetchImpl }));
  if (!spy0 || nyClock(spy0.quoteTime).date !== D) return { skipped: 'no_session_today' };
  const syms = new Set(['SPY', 'QQQ']);
  for (const { st, bench } of Object.values(states)) for (const a of [st, ...Object.values(bench)]) { Object.keys(a.positions).forEach((s) => syms.add(s)); a.pending.forEach((o) => syms.add(o.symbol)); }
  const mkt = await buildMarket([...syms], D, fetchImpl, '3mo');
  if (!mkt.ok) return { skipped: mkt.reason };
  if (mkt.calendar.at(-1) !== D) return { skipped: 'no_session_today' };
  const result = {};
  for (const S of CHALLENGERS) {
    if (!states[S.account]) continue;
    if (!(await claim(store, `${S.account}:OPEN:${D}`, S.account, 'OPEN', D, workerVersion))) { result[S.strategy] = { skipped: 'claimed' }; continue; }
    const { st, bench } = states[S.account];
    const evs = openBoth({ [S.account]: states[S.account] }, D, mkt, false)[S.account];
    const w = await appendEvents(store, heads[S.account], S, st.policySha256, [...evs, { type: 'STATE', d: D, phase: 'OPEN', state: serialize(st, bench) }]);
    result[S.strategy] = { ok: true, events: w.rows.length, fills: evs.filter((e) => e.type === 'FILL').length };
  }
  return { d: D, ...result };
}

// EOD for both challengers from ONE market build. t0 = earliest date a challenger may be funded (SIGNAL10_ARENA_T0).
export async function runArenaEod({ store, now, fetchImpl = fetch, workerVersion = null, t0, classification = CLASSIFICATION, rerun = null }) {
  let keySuffix = '';
  if (rerun != null && rerun !== '') {
    const n = Number(rerun);
    if (!Number.isInteger(n) || n < 2) return { skipped: 'bad_rerun', note: 'rerun must be an integer >= 2' };
    keySuffix = `#${n}`;
  }
  const D = nyClock(now).date;
  if (!t0 || D < t0) return { skipped: 'before_t0' };
  const cls = classificationFor(D, classification);
  if (!cls) return { skipped: 'no_classification_snapshot_for_date' };
  const heads = {}, states = {}; const due = [];
  for (const S of CHALLENGERS) {
    const h = await loadHead(store, S.account); heads[S.account] = h;
    if (h.state) { states[S.account] = restore(h.state.payload); if (states[S.account].st.lastEod >= D) continue; }
    due.push(S);
  }
  if (!due.length) return { skipped: 'eod_done' };
  const spy0 = quoteFromChart(await fetchChart('SPY', { range: '5d', fetchImpl }));
  if (!spy0) return { skipped: 'SPY unavailable' };
  const sc = nyClock(spy0.quoteTime);
  if (sc.date !== D) return { skipped: 'no_session_today' };
  // early-close sessions (NYSE calendar in market-tape/core.js) finalize at 13:00 ET, regular sessions at 16:00 ET
  if (sc.minutes < closeMinutes(D)) return { skipped: 'close_not_final' };
  const members = await currentMembers(fetchImpl);
  const U = universes(members.tickers, D, cls);
  const held = Object.values(states).flatMap(({ st, bench }) => [st, ...Object.values(bench)].flatMap((a) => [...Object.keys(a.positions), ...a.pending.map((o) => o.symbol)])); // fetched; only positions can block
  const mkt = await buildMarket(['SPY', 'QQQ', ...U.orig.map((u) => u.symbol).filter(Boolean), ...METAL_ETFS.map((x) => x.symbol), ...held], D, fetchImpl, '2y');
  if (!mkt.ok) return { skipped: mkt.reason };
  if (mkt.calendar.at(-1) !== D) return { skipped: 'no_session_today' };
  const spyTime = mkt.digest.SPY.regularMarketTime;
  if (!spyTime || nyClock(new Date(spyTime * 1000).toISOString()).minutes < closeMinutes(D)) return { skipped: 'close_not_final' };
  // A held symbol without any series: per account (review fix: one account's data gap never blocks the other). The last
  // persisted EOD mark supplies its last observed close so the shared delist rule can liquidate it after 3 missing
  // sessions (flagged ESTIMATE); with no persisted close the account fails closed for the day (never an invented mark).
  const blocked = {};
  for (const S of due) {
    const s0 = states[S.account]; if (!s0) continue;
    // only HELD positions can block (re-review N1): a pending order whose symbol has no series expires at the open
    const mine = [s0.st, ...Object.values(s0.bench)].flatMap((a) => Object.keys(a.positions));
    const missing = [...new Set(mine)].filter((x) => !mkt.prepared.has(x));
    if (!missing.length) continue;
    const [lastMark] = await store.select(T.marks, { account: `eq.${S.account}`, select: 'd,positions' }, { limit: 1, order: 'd.desc' });
    const unresolved = [];
    for (const sym of missing) {
      const pm = lastMark?.positions?.find((x) => x.symbol === sym);
      if (!pm || !(pm.close > 0) || !mkt.calIndex.has(pm.closeDate)) { unresolved.push(sym); continue; }
      mkt.prepared.set(sym, { symbol: sym, name: sym, n: 1, d: [pm.closeDate], c: [pm.close], o: [pm.close], adj: [pm.close], idx: new Map([[pm.closeDate, 0]]), splits: [], dividends: [], seriesUnavailable: true });
    }
    if (unresolved.length) blocked[S.strategy] = unresolved;
  }
  const cover = (list) => list.filter((u) => u.symbol && mkt.prepared.get(u.symbol)?.idx.has(D)).length / Math.max(1, list.length);
  const coverage = { ORIGINAL: cover(U.orig), TECH: cover(U.tech), DIVERSIFIED: cover(U.div) };
  const metals = metalCandidates(mkt.prepared, D, mkt.calIndex);
  const regimes = { QQQ: regimeOf(mkt.prepared, 'QQQ', D), SPY: regimeOf(mkt.prepared, 'SPY', D) };
  const result = {};
  // The cohort funds TOGETHER (preregistration §6): while neither challenger is funded, both gates must pass the same day.
  const funding = due.filter((S) => !states[S.account]);
  if (funding.length && funding.length === CHALLENGERS.length && funding.some((S) => coverage[S.strategy] < 0.9 || blocked[S.strategy])) {
    return { d: D, skipped: 'cohort_not_ready', coverage };
  }
  for (const S of due) {
    if (blocked[S.strategy]) { result[S.strategy] = { skipped: 'held_symbol_unavailable', missingHeld: blocked[S.strategy] }; continue; }
    if (coverage[S.strategy] < 0.9) { result[S.strategy] = { skipped: 'coverage_below_90pct', coverage: coverage[S.strategy] }; continue; }
    if (keySuffix) { // a rerun never races a live run: the base claim must exist and be > 20 min old (beyond any invocation)
      const [base] = await store.select(T.runs, { run_key: `eq.${S.account}:EOD:${D}`, select: 'claimed_at' }, { limit: 1 });
      if (!base) { result[S.strategy] = { skipped: 'no_failed_run_to_rerun' }; continue; }
      if (Date.parse(now) - Date.parse(base.claimed_at) < 20 * 60000) { result[S.strategy] = { skipped: 'original_run_may_be_live' }; continue; }
    }
    if (!(await claim(store, `${S.account}:EOD:${D}${keySuffix}`, S.account, 'EOD', D, workerVersion))) { result[S.strategy] = { skipped: 'claimed' }; continue; }
    const pSha = await policyHash(S);
    let st, bench;
    if (!states[S.account]) {
      st = newChallenger(S, D, pSha);
      Object.assign(st.events[0], { classification: { taxonomy: TAXONOMY_VERSION, effective_from: cls.effective_from, content_sha256: cls.content_sha256 },
        metalsRegistrySha256: await sha256Hex(canonical(METAL_ETFS)), arena: ARENA_VERSION });
      bench = { SPY: newChallenger({ ...S, account: `${S.account}:SPY`, strategy: 'BENCHMARK_SPY' }, D, null), QQQ: newChallenger({ ...S, account: `${S.account}:QQQ`, strategy: 'BENCHMARK_QQQ' }, D, null) };
      for (const [sym, b] of Object.entries(bench)) { b.pending = [emit(b, { type: 'ORDER', d: D, side: 'BUY', symbol: sym, ticker: sym, targetCents: b.cashCents, reason: 'BENCHMARK buy-and-hold at the first fill-session open' })]; b.events = []; b.meta[sym] = { sector: 'BENCHMARK', kind: 'ETF' }; }
      st.lastOpen = D;
    } else {
      ({ st, bench } = states[S.account]);
      // OPEN did not run intraday: book fills now from D's daily-bar open. openSession already emitted the account's own
      // events into st.events; only the benchmark + SESSION events are new here (never push an event twice).
      if (st.lastOpen < D) for (const e of openBoth({ [S.account]: states[S.account] }, D, mkt, true)[S.account]) if (!st.events.includes(e)) st.events.push({ seq: 0, origin: ORIGIN, ...e });
    }
    // intraday OPEN fills vs the final daily-bar open (review fix: read the ledger's FILL rows; never restated)
    const fillsToday = states[S.account] ? await store.select(T.events, { account: `eq.${S.account}`, type: 'eq.FILL', d: `eq.${D}`, select: 'payload' }) : [];
    for (const { payload: f } of fillsToday) {
      const p = mkt.prepared.get(f.symbol); const i = p?.idx.get(D);
      if (i != null && f.open > 0 && Math.abs(p.o[i] / f.open - 1) > 0.001) st.events.push({ seq: 0, origin: ORIGIN, type: 'FILL_OPEN_DISCREPANCY', d: D, symbol: f.symbol, fillOpen: f.open, finalBarOpen: p.o[i] });
    }
    for (const [sym, p] of mkt.prepared) if (p.seriesUnavailable && st.positions[sym]) st.events.push({ seq: 0, origin: ORIGIN, type: 'SERIES_UNAVAILABLE', d: D, symbol: sym, lastClose: p.c[0], lastCloseDate: p.d[0], note: 'source series missing; held at the last observed close (stale) until the delist rule applies' });
    delistings(st, D, mkt.calIndex, mkt.prepared);
    const universe = S === ORIGINAL ? U.orig : S === TECH ? U.tech : U.div;
    const snap = S === ORIGINAL ? rankOriginal(D, universe, mkt.prepared) : rankStrategy(S, D, universe, mkt.prepared);
    const m = mark(st, D, mkt.prepared);
    let regime;
    if (S === ORIGINAL) {
      ({ regime } = decideOriginal(st, D, snap, { prepared: mkt.prepared, m }));
      // display metadata only (sector for the exposure view); never an input to the V1 rules
      for (const o of st.pending) if (o.side === 'BUY' && !st.meta[o.symbol]) st.meta[o.symbol] = { sector: U.sectorOf[o.symbol] || 'UNCLASSIFIED', kind: 'EQUITY' };
    } else if (S === TECH) { regime = regimes.QQQ; decideTech(st, D, snap, { regime, prepared: mkt.prepared, m }); }
    else { regime = regimes.SPY; decideDiversified(st, D, snap, metals, { regime, prepared: mkt.prepared, m }); }
    st.lastEod = D;
    const exp = exposures(st, m);
    const bm = Object.fromEntries(Object.entries(bench).map(([k, b]) => [k, mark(b, D, mkt.prepared).navCents]));
    const top = snap.ranks.slice(0, 40).map(slimRank);
    const snapRow = { snapshot_key: `${S.model}:${D}`, account: S.account, d: D, model_version: S.model, origin: ORIGIN, frozen_at: new Date().toISOString(),
      eligible: snap.eligible, excluded: snap.excluded, ranks: top, regime, metals: S === DIVERSIFIED ? metals.map((x) => ({ symbol: x.symbol, verified: x.verified, hold: x.hold, f: x.f?.eligible ? { adj: r6(x.f.adj), sma200: r6(x.f.sma200), mom6: r6(x.f.mom6), vol63: r6(x.f.vol63) } : { eligible: false, reason: x.f?.reason } })) : [],
      members: { date: members.date, source: members.source, sha256: members.sha256, count: members.tickers.length },
      classification: { taxonomy: TAXONOMY_VERSION, effective_from: cls.effective_from, content_sha256: cls.content_sha256, universe: universe.length, unclassified: U.unclassified },
      source_digest: Object.fromEntries(Object.entries(mkt.digest).filter(([k]) => universe.some((u) => u.symbol === k) || ['SPY', 'QQQ', ...METAL_ETFS.map((x) => x.symbol)].includes(k) || st.positions[k])),
      data_cutoff: `${D} regular-session close` };
    snapRow.content_sha256 = await sha256Hex(canonical({ d: D, model: S.model, ranks: top }));
    st.events.push({ seq: 0, origin: ORIGIN, type: 'RANK_SNAPSHOT', d: D, model: S.model, snapshotKey: snapRow.snapshot_key, contentSha256: snapRow.content_sha256, top: top.slice(0, 10).map((r) => [r.symbol, r.score]), eligible: snap.eligible, coverage: coverage[S.strategy] });
    st.events.push({ seq: 0, origin: ORIGIN, type: 'EOD_MARK', d: D, navCents: m.navCents, cashCents: m.cashCents, marketValueCents: m.marketValueCents, positions: m.positions, exposures: exp, benchmarks: bm, stale: m.stale });
    const w = await appendEvents(store, heads[S.account], S, pSha, [...st.events, { type: 'STATE', d: D, phase: 'EOD', state: serialize(st, bench) }]);
    await store.insertMany(T.snapshots, [snapRow], 'snapshot_key');
    await store.insertMany(T.marks, [{ mark_key: `${S.account}:EOD:${D}`, account: S.account, d: D, kind: 'EOD_CLOSE', observed_at: new Date(spyTime * 1000).toISOString(),
      nav_cents: m.stale.length ? null : m.navCents, cash_cents: m.cashCents, coverage: m.stale.length ? 1 - m.stale.length / Math.max(1, m.positions.length) : 1,
      positions: m.positions, exposures: exp, benchmarks: bm }], 'mark_key');
    result[S.strategy] = { ok: true, events: w.rows.length, nav: m.navCents, orders: st.pending.length, funded: !states[S.account] };
  }
  return { d: D, ...result };
}

export async function arenaTick(env, minuteAt) {
  if (env.SIGNAL10_ARENA !== 'true') return {}; // kill switch (also checked by the caller): challenger writes only
  const store = env.__store; const d = arenaDue(minuteAt); const out = {};
  const args = { store, now: minuteAt, workerVersion: env.CF_VERSION_METADATA?.id ?? null, t0: env.SIGNAL10_ARENA_T0 };
  if (d.open) out.open = await runArenaOpen(args).catch((e) => ({ error: e.message }));
  if (d.eod) out.eod = await runArenaEod(args).catch((e) => ({ error: e.message }));
  return out;
}
