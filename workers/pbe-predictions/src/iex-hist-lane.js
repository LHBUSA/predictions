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
import { createTopsParser, topsEntry, IEX_HIST_INDEX, IEX_ATTRIBUTION, IEX_TERMS_URL } from '../../../src/market-tape/iex-hist.js';
import { FEATURED, nyParts, nyInstant, isTradingDay, closeMinutes, covered, prevTradingDay } from '../../../src/market-tape/core.js';
import { restoreState, ACCOUNT } from '../../../src/signal10/forward.js';

export const IEX_PARSER = 'iex-hist-tops/1';
const OPEN_MIN = 9 * 60 + 30;

export function iexDue(minuteIso) {
  const d = new Date(minuteIso);
  return d.getUTCMinutes() === 7 && d.getUTCHours() >= 4 && d.getUTCHours() <= 13;
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

export async function tapeUniverse(store) {
  const syms = new Set(FEATURED.map((f) => f.symbol));
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
  const res = await fetchImpl(entry.link.includes('alt=media') ? entry.link : `${entry.link}&alt=media`);
  if (!res.ok || !res.body) throw new Error(`iex-hist: file HTTP ${res.status}`);
  const reader = res.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parser.feed(value); }
  const aggs = parser.finish();
  const captured = now();
  const rows = aggs.filter((a) => a.last_regular_price != null && a.last_regular_at).map((a) => ({
    observation_key: `iex:TOPS:${ymd(session)}:${a.symbol}`,
    provider: 'iex', source_id: `iex:TOPS:${a.symbol}`, source_class: 'official',
    observed_at: a.last_regular_at, available_at: captured, captured_at: captured,
    value: a.last_regular_price, units: 'USD',
    data: { ...a, session_date: session, basis: 'IEX_LAST_SALE_REGULAR_SESSION', scope: 'IEX venue only; next-day (T+1)', attribution: IEX_ATTRIBUTION },
    provenance: { index: `${IEX_HIST_INDEX}?date=${ymd(session)}`, file: entry.link, file_size: entry.size, feed: 'TOPS', version: entry.version, protocol: entry.protocol, parser: IEX_PARSER, terms: IEX_TERMS_URL },
  }));
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
