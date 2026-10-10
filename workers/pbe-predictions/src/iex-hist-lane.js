// PBE Market Tape first-party collector: IEX HIST (TOPS 1.6, T+1) -> pred_source_observations (issue #56).
// IEX publishes each trading day's complete TOPS capture the next morning (free; no subscriber agreement; attribution
// required). Once per hour in the overnight window (UTC hours 4-13, minute :07) the FAST cron checks the latest three U.S.
// trading sessions, newest first, and processes ONE missing session: stream the gzip pcapng from IEX's public storage,
// decode only trade reports for the tape universe (featured + Signal 10 snapshot names + paper holdings), and write one
// immutable observation per symbol: the last regular-session, last-sale-eligible IEX trade with its own exchange timestamp.
//
// Idempotent: observation_key = iex:TOPS:<YYYYMMDD>:<SYMBOL> (insert ignores duplicates); a session with rows is never
// re-processed. Time-gated (one start per hour), so runs never overlap. Fail loud: a stream/parse error writes nothing.
// Not a price feed for trading: IEX venue only (not the consolidated tape), next-day.
import { createTopsParser, topsEntry, IEX_HIST_INDEX, IEX_ATTRIBUTION, IEX_TERMS_URL, b64e, b64d } from '../../../src/market-tape/iex-hist.js';
import { createInflater, parseGzipHeader, GzipHeaderIncomplete } from '../../../src/market-tape/inflate.js';
import { METAL_ETF_SYMBOLS } from '../../../src/market-tape/metals.js';
import { FEATURED, nyParts, nyInstant, isTradingDay, closeMinutes, covered, prevTradingDay } from '../../../src/market-tape/core.js';
import { restoreState, ACCOUNT } from '../../../src/signal10/forward.js';

export const IEX_PARSER = 'iex-hist-tops/1';
const OPEN_MIN = 9 * 60 + 30;

// Resumable lane (sql/017): every minute in the overnight window UTC 03:30-13:29 (IEX publishes ~03:30 UTC; done before the open).
export function iexDue(minuteIso) {
  const d = new Date(minuteIso);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 3 * 60 + 30 && m < 13 * 60 + 30;
}
// latest `n` completed trading sessions strictly before today's New York date, newest first
export function recentSessions(nowIso, n = 3) {
  const today = nyParts(Date.parse(nowIso)).date;
  const out = [];
  let d = today;
  for (let i = 0; i < 15 && out.length < n; i++) { d = prevTradingDay(d); if (covered(d) && isTradingDay(d)) out.push(d); }
  return out;
}
const ymd = (d) => d.replaceAll('-', '');
export function observationRow(session, a, captured, file) {
  const { recent, ...agg } = a; // the break ring is parser state, not part of the observation
  return {
    observation_key: `iex:TOPS:${ymd(session)}:${a.symbol}`,
    provider: 'iex', source_id: `iex:TOPS:${a.symbol}`, source_class: 'official',
    observed_at: a.last_regular_at, available_at: captured, captured_at: captured,
    value: a.last_regular_price, units: 'USD',
    data: { ...agg, session_date: session, basis: 'IEX_LAST_SALE_REGULAR_SESSION', scope: 'IEX venue only; next-day (T+1)', attribution: IEX_ATTRIBUTION },
    provenance: { index: `${IEX_HIST_INDEX}?date=${ymd(session)}`, file: file.link, file_size: file.size, feed: 'TOPS', version: file.version, protocol: 'IEXTP1', parser: IEX_PARSER, terms: IEX_TERMS_URL },
  };
}

export async function tapeUniverse(store) {
  // + the precious-metal ETF proxies for the metals tracker (#63): IEX-venue next-day prices, display-permitted with credit
  const syms = new Set([...FEATURED.map((f) => f.symbol), ...METAL_ETF_SYMBOLS]);
  try {
    const [snap] = await store.select('pred_s10_snapshots', { select: 'd,ranks', d: 'not.is.null' }, { limit: 1, order: 'd.desc' });
    for (const r of snap?.ranks || []) if (r.symbol) syms.add(r.symbol);
    const [state] = await store.select('pred_s10_events', { account: `eq.${ACCOUNT}`, type: 'eq.STATE', select: 'payload' }, { limit: 1, order: 'seq.desc' });
    if (state) for (const s of Object.keys(restoreState(state.payload).st.positions)) syms.add(s);
  } catch { /* featured list alone is still a valid universe */ }
  return [...syms].filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s));
}

// Process one session. Returns a summary; throws on any stream/parse failure (nothing written in that case).
export async function collectSession({ store, session, symbols, fetchImpl = fetch, now = () => new Date().toISOString() }) {
  const idxRes = await fetchImpl(`${IEX_HIST_INDEX}?date=${ymd(session)}`, { headers: { accept: 'application/json', 'user-agent': 'PropBetEdge-MarketTape/1.0 (+https://predictions.propbetedge.ai/markets/signal-10/methodology/)' } });
  if (!idxRes.ok) return { session, status: 'INDEX_UNAVAILABLE', http: idxRes.status };
  const entry = topsEntry(await idxRes.json());
  if (!entry) return { session, status: 'NOT_PUBLISHED' };
  const openNs = nyInstant(session, OPEN_MIN) * 1e6;
  const closeNs = nyInstant(session, closeMinutes(session)) * 1e6;
  const parser = createTopsParser(symbols, { sessionCloseNs: closeNs, sessionOpenNs: openNs });
  const started = Date.now();
  const res = await fetchImpl(entry.link.includes('alt=media') ? entry.link : `${entry.link}${entry.link.includes('?') ? '&' : '?'}alt=media`);
  if (!res.ok || !res.body) throw new Error(`iex-hist: file HTTP ${res.status}`);
  const reader = res.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parser.feed(value); }
  const aggs = parser.finish();
  const captured = now();
  const rows = aggs.filter((a) => a.last_regular_price != null && a.last_regular_at).map((a) => observationRow(session, a, captured, { link: entry.link, size: entry.size, version: entry.version }));
  if (rows.length) await store.write('pred_source_observations', rows, { conflictColumn: 'observation_key' });
  return { session, status: 'WRITTEN', rows: rows.length, symbols: symbols.length, matched_trades: parser.stats.matched, decompressed_mb: Math.round(parser.stats.bytes / 1048576), seconds: Math.round((Date.now() - started) / 1000) };
}

// Cron entry: one missing session per run (newest first).
export async function iexHistTick({ store, nowIso, fetchImpl = fetch }) {
  const sessions = recentSessions(nowIso, 3);
  for (const s of sessions) {
    const have = await store.select('pred_source_observations', { select: 'observation_key', observation_key: `like.iex:TOPS:${ymd(s)}:*` }, { limit: 1 });
    if (have.length) continue;
    const symbols = await tapeUniverse(store);
    const r = await collectSession({ store, session: s, symbols, fetchImpl });
    if (r.status === 'WRITTEN') return r;
    // not yet published / index unavailable: try the next older missing session
    if (s === sessions.at(-1)) return r;
  }
  return { status: 'UP_TO_DATE', sessions };
}

// ---------------- resumable steps (sql/017 pred_market_tape_jobs) ----------------
// One step per FAST-cron minute: claim the session's job (atomic lease), range-read the gzip from the checkpoint byte,
// decode ~STEP_OUT bytes with the resumable inflater (pause at a DEFLATE block boundary), feed the TOPS parser, and save
// the exact resume point. The final block writes the immutable observations (same rows as collectSession) and marks DONE.
export const STEP_OUT = 768 * 1048576; // ~768 MiB of decompressed pcapng per step (~5-8 s CPU; the FAST invocation is shared)
const LEASE_S = 240;
const MAX_ATTEMPTS = 6;

async function rest(store, path, init = {}) {
  const r = await store.fetchImpl(`${store.url}/rest/v1/${path}`, { ...init, headers: { apikey: store.serviceKey, authorization: `Bearer ${store.serviceKey}`, 'content-type': 'application/json', accept: 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`iex-hist store ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
// every write is fenced by the lease holder: a step that outlived its lease can never overwrite a newer checkpoint or a DONE job
const patchJob = (store, session, holder, fields) => rest(store, `pred_market_tape_jobs?session_date=eq.${session}&lease_holder=eq.${encodeURIComponent(holder)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }) });

// newest recent session without observations; creates its job row when the file is published
async function targetJob(store, nowIso, fetchImpl) {
  for (const s of recentSessions(nowIso, 3)) {
    const have = await store.select('pred_source_observations', { select: 'observation_key', observation_key: `like.iex:TOPS:${ymd(s)}:*` }, { limit: 1 });
    if (have.length) continue;
    const [job] = await store.select('pred_market_tape_jobs', { select: 'session_date,status', session_date: `eq.${s}` }, { limit: 1 });
    if (job?.status === 'FAILED' || job?.status === 'DONE') continue; // DONE with 0 rows never blocks older sessions
    if (job) return s;
    const idx = await fetchImpl(`${IEX_HIST_INDEX}?date=${ymd(s)}`, { headers: { accept: 'application/json' } });
    if (!idx.ok) continue;
    const e = topsEntry(await idx.json());
    if (!e) continue; // not published yet
    const symbols = await tapeUniverse(store);
    await store.write('pred_market_tape_jobs', [{ session_date: s, file_link: e.link, file_size: Number(e.size) || 1, file_version: String(e.version || ''), symbols, status: 'RUNNING' }], { conflictColumn: 'session_date' });
    return s;
  }
  return null;
}

export async function iexHistStep({ store, nowIso, fetchImpl = fetch, stepOut = STEP_OUT, holder = `step:${nowIso}:${Math.random().toString(36).slice(2, 8)}`, now = () => new Date().toISOString() }) {
  const session = await targetJob(store, nowIso, fetchImpl);
  if (!session) return { status: 'UP_TO_DATE' };
  const claimed = await rest(store, 'rpc/pred_market_tape_claim', { method: 'POST', body: JSON.stringify({ p_session: session, p_holder: holder, p_ttl_seconds: LEASE_S }) });
  const job = Array.isArray(claimed) ? claimed[0] : null;
  if (!job) return { status: 'LEASE_HELD', session };
  // count the attempt at CLAIM time: a step killed by the runtime (CPU/memory/eviction) never reaches `catch`
  const attempt = (job.attempts || 0) + 1;
  if (attempt > MAX_ATTEMPTS) { await patchJob(store, session, holder, { status: 'FAILED', last_error: job.last_error || 'too many interrupted steps', lease_holder: null, lease_until: null }); return { status: 'FAILED', session }; }
  await patchJob(store, session, holder, { attempts: attempt });
  try {
    const closeNs = nyInstant(session, closeMinutes(session)) * 1e6, openNs = nyInstant(session, OPEN_MIN) * 1e6;
    const parser = createTopsParser(job.symbols, { sessionCloseNs: closeNs, sessionOpenNs: openNs, state: job.parser_state || null });
    const link = job.file_link.includes('alt=media') ? job.file_link : `${job.file_link}${job.file_link.includes('?') ? '&' : '?'}alt=media`;
    let byte = Number(job.byte_offset), bit = job.bit_offset;
    let out = 0;
    const inf = createInflater({ window: job.window_b64 ? b64d(job.window_b64) : null, bitOffset: bit, onOutput: (c) => { parser.feed(c); out += c.length; if (out >= stepOut) inf.requestStop(); } });
    let head = byte === 0 ? new Uint8Array(0) : null; // byte 0: buffer until the whole gzip header has arrived
    const res = await fetchImpl(link, { headers: { range: `bytes=${byte}-` } });
    if (!(res.status === 206 || (res.status === 200 && byte === 0)) || !res.body) throw new Error(`iex-hist: range HTTP ${res.status}`);
    const reader = res.body.getReader();
    let paused = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (head) {
        const all = new Uint8Array(head.length + chunk.length); all.set(head); all.set(chunk, head.length);
        let h;
        try { h = parseGzipHeader(all); } catch (e) { if (e instanceof GzipHeaderIncomplete) { head = all; continue; } throw e; }
        chunk = all.subarray(h); byte += h; head = null;
      }
      inf.push(chunk);
      if (inf.done) break;
      if (out >= stepOut && inf.atBoundary) { paused = true; break; }
    }
    await reader.cancel().catch(() => {});
    const decompressed = Number(job.decompressed_bytes) + out;
    if (inf.done) {
      // integrity: the gzip trailer's ISIZE (output length mod 2^32) must match what we decoded, and the trailer must
      // end exactly at the end of the file. Any resume/decoder fault fails here instead of writing rows.
      const endBit = byte * 8 + inf.consumedBits();
      const trailerAt = Math.ceil(endBit / 8);
      const tr = await fetchImpl(link, { headers: { range: `bytes=${trailerAt}-${trailerAt + 7}` } });
      const tb = new Uint8Array(await tr.arrayBuffer());
      if (tr.status !== 206 || tb.length !== 8) throw new Error(`iex-hist: trailer read HTTP ${tr.status} (${tb.length} bytes)`);
      const isize = (tb[4] | (tb[5] << 8) | (tb[6] << 16) | (tb[7] << 24)) >>> 0;
      if (isize !== decompressed % 4294967296) throw new Error(`iex-hist: gzip ISIZE ${isize} != decoded ${decompressed % 4294967296}`);
      if (trailerAt + 8 !== Number(job.file_size)) throw new Error(`iex-hist: trailer ends at ${trailerAt + 8}, file size ${job.file_size}`);
      const aggs = parser.finish();
      const captured = now();
      const rows = aggs.filter((a) => a.last_regular_price != null && a.last_regular_at).map((a) => observationRow(session, a, captured, { link: job.file_link, size: job.file_size, version: job.file_version }));
      if (rows.length) await store.write('pred_source_observations', rows, { conflictColumn: 'observation_key' });
      await patchJob(store, session, holder, { status: 'DONE', finished_at: captured, rows_written: rows.length, steps: job.steps + 1, decompressed_bytes: decompressed, window_b64: null, parser_state: null, lease_holder: null, lease_until: null, last_error: null });
      return { status: 'DONE', session, rows: rows.length, steps: job.steps + 1, decompressed_mb: Math.round(decompressed / 1048576) };
    }
    if (!paused) throw new Error('iex-hist: stream ended before the final block');
    const abs = byte * 8 + inf.consumedBits(); // consumedBits counts from `byte` (including the initial skipped bits)
    await patchJob(store, session, holder, { byte_offset: Math.floor(abs / 8), bit_offset: abs % 8, window_b64: b64e(inf.window()), parser_state: parser.exportState(), steps: job.steps + 1, attempts: 0, decompressed_bytes: decompressed, lease_holder: null, lease_until: null, last_error: null });
    return { status: 'STEP', session, steps: job.steps + 1, decompressed_mb: Math.round(decompressed / 1048576), byte_offset: Math.floor(abs / 8) };
  } catch (e) {
    await patchJob(store, session, holder, { last_error: String(e.message || e).slice(0, 500), lease_holder: null, lease_until: null, ...(attempt >= MAX_ATTEMPTS ? { status: 'FAILED' } : {}) }).catch(() => {});
    throw e;
  }
}
