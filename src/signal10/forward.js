// PBE Signal 10 FORWARD PAPER account (origin=FORWARD_PAPER). Same rank model + manager policy as the historical replay;
// separate capital, separate ledger, separate tables. Runs inside pbe-predictions on the existing one-minute cron:
//   OPEN  (trading day, >= 09:45 ET)   corporate actions for D, then fills of orders frozen at the previous close, at D's
//                                      regular-session OPEN as reported by the source (reconciled against the final bar at EOD)
//   EOD   (trading day, >= 16:20 ET)   freeze the D snapshot (ranks), mark NAV at the close, decide orders for D+1's open
//   MARK  (trading day, 09:30-16:05 ET, every 5 min) persisted intraday marks from timestamped quotes (no synthetic motion)
// Idempotency: a run claims pred_s10_runs(run_key) BEFORE writing; events are hash-chained and append-only.
import { parseYahooChart } from './data.js';
import { prepareSeries, rankUniverse } from './rank.js';
import { newAccount, corporateActions, execute, mark, decide, emit } from './portfolio.js';
import { loadComponents } from './universe.js';
import { resolveSymbol } from './aliases.js';
import { LATEST_MEMBERS } from './members-latest.js';
import { MODEL_VERSION, POLICY_VERSION, MANAGER } from './policy.js';
import { closeMinutes } from '../market-tape/core.js';

export const ACCOUNT = 'S10-FWD-1';
export const ORIGIN = 'FORWARD_PAPER';
// Ledger writer version (issue #69). writer/1 (2026-10-09..10-10) wrote a FLAT STATE payload from which appendEvents
// removed the account's `seq`/`origin` (they are row columns), so a restored account emitted orders with
// origin=undefined / seq=NaN and hashed `"origin":undefined`, which jsonb cannot store -> those rows could not be
// re-verified. writer/2 changes ONLY persistence: (1) payloads are JSON-normalised before hashing (exactly the stored
// value; a no-op for every row writer/1 wrote correctly), (2) STATE nests the account under payload.state with the
// writer version, (3) every restore re-bases st.seq on the ledger head and st.origin on ORIGIN, so an event's local
// seq IS its ledger seq (FILL.orderSeq = the ORDER row's seq), (4) the first restore of a legacy flat STATE records a
// LEDGER_WRITER_UPGRADE event with per-pending-order link evidence (VERIFIED / UNVERIFIED, never invented).
// Model, policy, ranking, sizing and fills are untouched (policy.js / rank.js / portfolio.js are byte-identical).
export const LEDGER_WRITER = 'signal10-ledger-writer/2';
export const LEGACY_WRITER = 'signal10-ledger-writer/1';
// Scheduling compatibility (issue #69 item 4): the EOD final-close gates use the NYSE calendar's close for D (13:00 ET on
// early-close sessions, 16:00 ET otherwise; market-tape/core.js) instead of a fixed 16:00. The EOD window itself still
// opens at 16:20 ET, after the official close of every session. Nothing else in scheduling changes.
export const SCHEDULE_VERSION = 'signal10-schedule/2';
export const COMPONENTS_URL = 'https://raw.githubusercontent.com/fja05680/sp500/master/S%26P%20500%20Historical%20Components%20%26%20Changes%20(Updated).csv';
const UA = 'Mozilla/5.0 (compatible; PropBetEdge-Signal10/1.0; +https://predictions.propbetedge.ai/markets/signal-10/methodology/)';

// ---------- time (America/New_York, DST-correct via Intl) ----------
export function nyClock(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: parts.weekday };
}
export const isWeekday = (c) => !['Sat', 'Sun'].includes(c.weekday);
export function due(iso) {
  const c = nyClock(iso);
  if (!isWeekday(c)) return { ...c, open: false, eod: false, mark: false };
  return { ...c, open: c.minutes >= 9 * 60 + 45 && c.minutes < 16 * 60, eod: c.minutes >= 16 * 60 + 20 && c.minutes < 23 * 60 + 30,
    mark: c.minutes >= 9 * 60 + 30 && c.minutes <= 16 * 60 + 5 && c.minutes % 5 === 0 };
}

// ---------- hashing ----------
export async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---------- source ----------
export async function fetchChart(symbol, { range = '2y', interval = '1d', fetchImpl = fetch } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.replace(/\./g, '-'))}?range=${range}&interval=${interval}&events=div%2Csplit&includeAdjustedClose=true`;
  const retrieved_at = new Date().toISOString();
  try {
    const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch { /* not json */ }
    return { symbol, url, status: r.status, retrieved_at, sha256: await sha256Hex(body), json };
  } catch (e) { return { symbol, url, status: -1, retrieved_at, sha256: null, json: null, error: String(e.message || e) }; }
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

// Quote from the chart meta: price + the source's own trade timestamp (never our fetch time).
export function quoteFromChart(c) {
  const m = c?.json?.chart?.result?.[0]?.meta;
  if (!m || !(m.regularMarketPrice > 0) || !m.regularMarketTime) return null;
  return { symbol: c.symbol, price: m.regularMarketPrice, quoteTime: new Date(m.regularMarketTime * 1000).toISOString(), previousClose: m.chartPreviousClose ?? m.previousClose ?? null,
    dayHigh: m.regularMarketDayHigh ?? null, dayLow: m.regularMarketDayLow ?? null, name: m.longName || m.shortName || null, retrievedAt: c.retrieved_at, sourceSha256: c.sha256 };
}

// ---------- state <-> events ----------
export function serializeState(st, bench) {
  const { events, phase: _phase, ...rest } = st; // eslint-disable-line no-unused-vars
  const b = Object.fromEntries(Object.entries(bench || {}).map(([k, v]) => { const { events: _e, ...r } = v; return [k, r]; }));
  return { ...rest, bench: b };
}
// Reads a writer/2 STATE (payload.state) or a legacy writer/1 flat STATE. `legacy` tells the lane to record the upgrade.
export function restoreState(payload) {
  const legacy = !(payload && typeof payload.state === 'object' && payload.state);
  const { bench, ...st } = structuredClone(legacy ? payload : payload.state);
  st.events = [];
  const b = Object.fromEntries(Object.entries(bench || {}).map(([k, v]) => [k, { ...v, events: [] }]));
  return { st, bench: b, legacy };
}
export const stateEvent = (st, bench, D, phase) => ({ type: 'STATE', d: D, phase, writer: LEDGER_WRITER, state: serializeState(st, bench) });

// Re-base a restored account on the ledger head (writer/2): the next emitted event gets local seq lastSeq + 1, which is
// exactly the ledger seq appendEvents will give it (events are appended in emission order right after the head).
export async function rebase(store, st, head, legacy, D, bench = {}) {
  st.seq = head.lastSeq; st.origin = ORIGIN;
  if (!legacy) return;
  const orders = await store.select('pred_s10_events', { account: `eq.${ACCOUNT}`, type: 'eq.ORDER', select: 'seq,d,payload' }, { limit: 500, order: 'seq.desc' });
  const bySeq = new Map(orders.map((r) => [r.seq, r]));
  const links = (st.pending || []).map((o) => {
    const r = Number.isInteger(o.seq) ? bySeq.get(o.seq) : null;
    const ok = !!r && r.payload?.symbol === o.symbol && r.payload?.side === o.side;
    return { orderSeq: Number.isInteger(o.seq) ? o.seq : null, symbol: o.symbol, side: o.side, link: ok ? 'VERIFIED' : 'UNVERIFIED', ledgerSeq: ok ? r.seq : null, ledgerD: ok ? r.d : null };
  });
  // review #71 F4: an UNVERIFIED link never travels on into a FILL (its stored seq could point at an unrelated row)
  for (const [k, o] of (st.pending || []).entries()) if (links[k].link !== 'VERIFIED') o.seq = null;
  // review #71 F3: benchmark orders carry benchmark-local numbers and were never ledger rows — recorded as such, then
  // cleared so a BENCHMARK_FILL can never appear to reference an unrelated ledger row
  const benchmarkLinks = Object.entries(bench || {}).flatMap(([k, b]) => (b.pending || []).map((o) => {
    const x = { benchmark: k, symbol: o.symbol, side: o.side, localSeq: Number.isInteger(o.seq) ? o.seq : null, link: 'UNVERIFIED', note: 'benchmark-local sequence; benchmark orders are not ledger rows' };
    o.seq = null; return x;
  }));
  emit(st, { type: 'LEDGER_WRITER_UPGRADE', d: D, from: LEGACY_WRITER, to: LEDGER_WRITER, legacyStateSeq: head.state.seq, legacyStateD: head.state.d,
    restored: { seq: head.lastSeq, origin: ORIGIN }, pendingLinks: links, benchmarkLinks,
    note: 'Persistence-only upgrade: model, policy and every economic value are unchanged. Earlier rows are never rewritten.' });
}

export async function loadHead(store) {
  const rows = await store.select('pred_s10_events', { account: `eq.${ACCOUNT}`, type: 'eq.STATE', select: 'seq,d,payload,hash' }, { limit: 1, order: 'seq.desc' });
  const last = await store.select('pred_s10_events', { account: `eq.${ACCOUNT}`, select: 'seq,hash' }, { limit: 1, order: 'seq.desc' });
  return { state: rows[0] || null, lastSeq: last[0]?.seq || 0, lastHash: last[0]?.hash || '0'.repeat(64) };
}

async function appendEvents(store, head, events) {
  let prev = head.lastHash; let seq = head.lastSeq;
  const rows = [];
  for (const e of events) {
    seq += 1;
    const { seq: _s, origin: _o, type, d, ...rest } = e;
    const payload = JSON.parse(JSON.stringify(rest)); // writer/2: hash exactly what jsonb stores (no undefined, NaN -> null)
    const body = { account: ACCOUNT, origin: ORIGIN, seq, type, d, payload, model_version: MODEL_VERSION, policy_version: POLICY_VERSION };
    const hash = await sha256Hex(prev + canonical(body));
    rows.push({ event_key: `${ACCOUNT}:${seq}`, ...body, prev_hash: prev, hash });
    prev = hash;
  }
  if (rows.length) await store.insertMany('pred_s10_events', rows, 'event_key');
  return { lastSeq: seq, lastHash: prev, rows };
}

export async function claim(store, runKey, kind, d, workerVersion) {
  const out = await store.write('pred_s10_runs', [{ run_key: runKey, account: ACCOUNT, kind, d, worker_version: workerVersion }], { conflictColumn: 'run_key', returnRepresentation: true });
  return Array.isArray(out) && out.length === 1;
}

// ---------- market build from live source ----------
async function buildMarket(symbols, D, fetchImpl, range = '2y') {
  const charts = await pool([...new Set(symbols)], 12, (s) => fetchChart(s, { range, fetchImpl }));
  const series = {}; const digest = {}; const failures = [];
  for (const c of charts) {
    const s = c.status === 200 ? parseYahooChart(c.json, { cutoffDate: D }) : null;
    digest[c.symbol] = { status: c.status, sha256: c.sha256, retrieved_at: c.retrieved_at, lastBar: s?.bars.at(-1)?.d || null, regularMarketTime: c.json?.chart?.result?.[0]?.meta?.regularMarketTime ?? null };
    if (s && s.bars.length) series[c.symbol] = s; else failures.push(c.symbol);
  }
  const spy = series.SPY;
  if (!spy) return { ok: false, reason: 'SPY unavailable', digest };
  const calendar = spy.bars.map((b) => b.d);
  const calIndex = new Map(calendar.map((d, i) => [d, i]));
  const prepared = new Map(Object.entries(series).map(([k, s]) => [k, prepareSeries(s, calIndex)]));
  return { ok: true, calendar, calIndex, prepared, digest, failures, charts };
}

function regime(prepared, D) {
  const p = prepared.get('SPY'); const i = p.idx.get(D);
  if (i == null || i < 199) return { riskOn: false };
  const s200 = (p.ps[i + 1] - p.ps[i - 199]) / 200;
  return { riskOn: p.adj[i] >= s200, spyAdj: p.adj[i], spySma200: s200 };
}

async function currentMembers(fetchImpl) {
  try {
    const r = await fetchImpl(COMPONENTS_URL, { headers: { 'user-agent': UA } });
    if (r.ok) {
      const csv = await r.text(); const comps = loadComponents(csv); const row = comps.at(-1);
      if (row && row.tickers.length >= 450) return { date: row.date, tickers: row.tickers, source: 'fja05680/sp500 live', sha256: await sha256Hex(csv) };
    }
  } catch { /* fall back */ }
  return { date: LATEST_MEMBERS.date, tickers: [...LATEST_MEMBERS.tickers], source: 'bundled copy', sha256: null };
}

// OPEN phase for session D (shared by the OPEN run and by EOD when OPEN did not run).
function openPhase(st, bench, D, mkt, { late = false } = {}) {
  const evs0 = st.events.length;
  corporateActions(st, D, mkt.prepared);
  execute(st, D, mkt.prepared);
  st.fillSessions += 1;
  st.lastOpen = D;
  for (const [k, b] of Object.entries(bench)) {
    const n0 = b.events.length;
    corporateActions(b, D, mkt.prepared); execute(b, D, mkt.prepared);
    for (const e of b.events.slice(n0)) emit(st, { ...e, type: `BENCHMARK_${e.type}`, d: D, benchmark: k });
    b.events = [];
  }
  emit(st, { type: 'SESSION', d: D, fillSession: st.fillSessions, window: st.fillSessions <= MANAGER.initialWindowSessions ? `day ${st.fillSessions} of ${MANAGER.initialWindowSessions}` : 'post-window',
    note: late ? 'fills booked at the end of day from the session OPEN in the final daily bar (open run did not complete intraday)' : 'fills at the session OPEN as reported by the source' });
  return st.events.slice(evs0);
}

// ---------- runs ----------
export async function runOpen({ store, now, fetchImpl = fetch, workerVersion = null }) {
  const c = nyClock(now); const D = c.date;
  const head = await loadHead(store);
  if (!head.state) return { skipped: 'not_funded' };
  const { st, bench, legacy } = restoreState(head.state.payload);
  if (st.lastOpen >= D || st.inception >= D) return { skipped: 'open_done' };
  const spy0 = quoteFromChart(await fetchChart('SPY', { range: '1d', fetchImpl }));
  if (!spy0 || nyClock(spy0.quoteTime).date !== D) return { skipped: 'no_session_today' };
  const symbols = [...new Set(['SPY', 'QQQ', ...Object.keys(st.positions), ...st.pending.map((o) => o.symbol), ...Object.values(bench).flatMap((b) => [...Object.keys(b.positions), ...b.pending.map((o) => o.symbol)])])];
  const mkt = await buildMarket(symbols, D, fetchImpl, '3mo');
  if (!mkt.ok) return { skipped: mkt.reason };
  if (mkt.calendar.at(-1) !== D) return { skipped: 'no_session_today' }; // holiday: SPY has no bar dated today
  if (!(await claim(store, `OPEN:${D}`, 'OPEN', D, workerVersion))) return { skipped: 'claimed' };
  await rebase(store, st, head, legacy, D, bench);
  const pre = st.events.slice(); // LEDGER_WRITER_UPGRADE (first restore of a legacy STATE only)
  const evs = openPhase(st, bench, D, mkt);
  const w = await appendEvents(store, head, [...pre, ...evs, stateEvent(st, bench, D, 'OPEN')]);
  return { ok: true, d: D, events: w.rows.length, fills: evs.filter((e) => e.type === 'FILL').length };
}

export async function runEod({ store, now, fetchImpl = fetch, workerVersion = null, startDate }) {
  const c = nyClock(now); const D = c.date;
  if (startDate && D < startDate) return { skipped: 'before_start' };
  const head = await loadHead(store);
  let st, bench, legacy = false;
  if (head.state) ({ st, bench, legacy } = restoreState(head.state.payload));
  if (st && st.lastEod >= D) return { skipped: 'eod_done' };
  // cheap gate before the ~500-symbol fetch: SPY must show a FINAL bar dated today (holidays/early ticks stop here)
  const spy0 = quoteFromChart(await fetchChart('SPY', { range: '5d', fetchImpl }));
  if (!spy0) return { skipped: 'SPY unavailable' };
  const spyClock = nyClock(spy0.quoteTime);
  if (spyClock.date !== D) return { skipped: 'no_session_today' };
  if (spyClock.minutes < closeMinutes(D)) return { skipped: 'close_not_final' };
  const members = await currentMembers(fetchImpl);
  const universe = members.tickers.map((t) => ({ ticker: t, symbol: resolveSymbol(t, D) }));
  const held = st ? [...Object.keys(st.positions)] : [];
  const mkt = await buildMarket(['SPY', 'QQQ', ...universe.map((u) => u.symbol).filter(Boolean), ...held], D, fetchImpl, '2y');
  if (!mkt.ok) return { skipped: mkt.reason };
  if (mkt.calendar.at(-1) !== D) return { skipped: 'no_session_today' };
  const spyTime = mkt.digest.SPY.regularMarketTime;
  if (!spyTime || nyClock(new Date(spyTime * 1000).toISOString()).minutes < closeMinutes(D)) return { skipped: 'close_not_final' };
  const withBar = universe.filter((u) => u.symbol && mkt.prepared.get(u.symbol)?.idx.has(D)).length;
  if (withBar / universe.length < 0.9) return { skipped: 'coverage_below_90pct', withBar };
  if (!(await claim(store, `EOD:${D}`, 'EOD', D, workerVersion))) return { skipped: 'claimed' };
  if (st) await rebase(store, st, head, legacy, D, bench);

  const out = [];
  if (!st) {
    st = newAccount({ origin: ORIGIN, inception: D });
    bench = { SPY: newAccount({ origin: 'BENCHMARK_SPY', inception: D }), QQQ: newAccount({ origin: 'BENCHMARK_QQQ', inception: D }) };
    for (const [sym, b] of Object.entries(bench)) b.pending = [emit(b, { type: 'ORDER', d: D, side: 'BUY', symbol: sym, ticker: sym, targetCents: b.cashCents, reason: 'BENCHMARK buy-and-hold at the first fill-session open' })];
    st.lastOpen = D;
  } else if (st.lastOpen < D) {
    // OPEN did not run during the session: book fills now from D's official daily-bar open (same basis as the backtest)
    openPhase(st, bench, D, mkt, { late: true });
  }
  // reconcile any intraday fills against the final daily-bar open (never restated; discrepancy is its own event)
  for (const e of st.events) if (e.type === 'FILL' && e.d === D) {
    const p = mkt.prepared.get(e.symbol); const i = p?.idx.get(D);
    if (i != null && Math.abs(p.o[i] / e.open - 1) > 0.001) emit(st, { type: 'FILL_OPEN_DISCREPANCY', d: D, symbol: e.symbol, fillOpen: e.open, finalBarOpen: p.o[i] });
  }
  const snap = rankUniverse(D, universe, mkt.prepared);
  const m = mark(st, D, mkt.prepared);
  decide(st, D, snap, regime(mkt.prepared, D), m, mkt.prepared);
  st.lastEod = D;
  const bm = Object.fromEntries(Object.entries(bench).map(([k, b]) => [k, mark(b, D, mkt.prepared).navCents]));
  const top = snap.ranks.slice(0, 50).map((r) => ({ rank: r.rank, symbol: r.symbol, ticker: r.ticker, name: r.name, score: r.score,
    f: Object.fromEntries(Object.entries(r.f).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v])) }));
  const heldRanks = Object.keys(st.positions).map((s) => snap.ranks.find((r) => r.symbol === s)).filter(Boolean).map((r) => ({ rank: r.rank, symbol: r.symbol, score: r.score }));
  const snapRow = { snapshot_key: `${MODEL_VERSION}:${D}`, d: D, model_version: MODEL_VERSION, origin: ORIGIN, frozen_at: new Date().toISOString(),
    eligible: snap.eligible, excluded: snap.excluded, ranks: top, held_ranks: heldRanks, regime: regime(mkt.prepared, D),
    members: { date: members.date, source: members.source, sha256: members.sha256, count: members.tickers.length },
    source_digest: mkt.digest, data_cutoff: `${D} regular-session close` };
  snapRow.content_sha256 = await sha256Hex(canonical({ d: D, model: MODEL_VERSION, ranks: top }));
  await store.insertMany('pred_s10_snapshots', [snapRow], 'snapshot_key');
  emit(st, { type: 'RANK_SNAPSHOT', d: D, model: MODEL_VERSION, snapshotKey: snapRow.snapshot_key, contentSha256: snapRow.content_sha256, top10: top.slice(0, 10).map((r) => [r.symbol, r.score]), eligible: snap.eligible });
  emit(st, { type: 'EOD_MARK', d: D, navCents: m.navCents, cashCents: m.cashCents, marketValueCents: m.marketValueCents, positions: m.positions, benchmarks: bm, stale: m.stale });
  out.push(...st.events);
  const w = await appendEvents(store, head, [...out, stateEvent(st, bench, D, 'EOD')]);
  await store.insertMany('pred_s10_marks', [{ mark_key: `${ACCOUNT}:EOD:${D}`, account: ACCOUNT, d: D, kind: 'EOD_CLOSE', observed_at: new Date(spyTime * 1000).toISOString(),
    nav_cents: m.navCents, cash_cents: m.cashCents, coverage: m.stale.length ? 1 - m.stale.length / Math.max(1, m.positions.length) : 1,
    positions: m.positions, benchmarks: bm }], 'mark_key');
  return { ok: true, d: D, events: w.rows.length, nav: m.navCents, top10: top.slice(0, 10).map((r) => r.symbol), orders: st.pending.length };
}

// Persisted intraday mark: held quotes + SPY/QQQ with their own source timestamps; partial coverage is stored as such.
export async function runMark({ store, now, fetchImpl = fetch }) {
  const c = nyClock(now);
  const head = await loadHead(store);
  if (!head.state) return { skipped: 'not_funded' };
  const { st, bench } = restoreState(head.state.payload);
  const syms = [...new Set([...Object.keys(st.positions), 'SPY', 'QQQ'])];
  const quotes = (await pool(syms, 8, (s) => fetchChart(s, { range: '1d', interval: '1d', fetchImpl }))).map(quoteFromChart);
  const nav = navFromQuotes(st, quotes, now);
  const bm = Object.fromEntries(Object.entries(bench).map(([k, b]) => [k, navFromQuotes(b, quotes, now)]));
  const bucket = `${c.date}T${String(Math.floor(c.minutes / 60)).padStart(2, '0')}:${String(c.minutes % 60).padStart(2, '0')}`;
  await store.insertMany('pred_s10_marks', [{ mark_key: `${ACCOUNT}:INTRADAY:${bucket}`, account: ACCOUNT, d: c.date, kind: 'INTRADAY', observed_at: now,
    nav_cents: nav.complete ? nav.navCents : null, cash_cents: st.cashCents, coverage: nav.coverage, positions: nav.positions,
    benchmarks: Object.fromEntries(Object.entries(bm).map(([k, v]) => [k, v.complete ? v.navCents : null])) }], 'mark_key');
  return { ok: true, bucket, nav: nav.navCents, coverage: nav.coverage };
}

// NAV from timestamped quotes. A quote older than maxAgeMin while the session is open (or missing) makes the NAV PARTIAL:
// we report coverage and never present a complete live NAV built on a stale/missing price.
export function navFromQuotes(st, quotes, nowIso, { maxAgeMin = 20 } = {}) {
  const by = new Map(quotes.filter(Boolean).map((q) => [q.symbol, q]));
  const c = nyClock(nowIso);
  const sessionOpen = isWeekday(c) && c.minutes >= 9 * 60 + 30 && c.minutes < 16 * 60;
  let mv = 0, covered = 0; const positions = [];
  for (const [sym, pos] of Object.entries(st.positions)) {
    const q = by.get(sym);
    const ageMin = q ? (Date.parse(nowIso) - Date.parse(q.quoteTime)) / 60000 : null;
    const fresh = q && (!sessionOpen || ageMin <= maxAgeMin);
    if (fresh) { mv += Math.round(pos.qty * q.price * 100); covered++; }
    positions.push({ symbol: sym, qty: pos.qty, costCents: pos.costCents, price: q?.price ?? null, quoteTime: q?.quoteTime ?? null, previousClose: q?.previousClose ?? null,
      valueCents: q ? Math.round(pos.qty * q.price * 100) : null, fresh: !!fresh });
  }
  const n = Object.keys(st.positions).length;
  return { navCents: st.cashCents + mv, cashCents: st.cashCents, positions, coverage: n ? covered / n : 1, complete: covered === n, sessionOpen };
}
