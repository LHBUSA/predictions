// IEX HIST adapter (issue #56): streaming parser for IEX's free T+1 historical TOPS files (pcapng, IEX-TP v1, TOPS 1.6).
// Exchange-originated and display-permitted at zero cost: "IEX does not require an IEX Data Subscriber Agreement from any
// Person who receives, uses, or distributes IEX Historical Data" (IEX Market Data Policies §15). Required credit (verbatim):
//   "Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use."
// Scope, always disclosed with any value: IEX-venue trades only (not the consolidated market), next-day (T+1).
//
// Pure + streaming: feed(Uint8Array) as decompressed bytes arrive; works on Node and Workers (no Buffer). Only trade
// reports ('T') and trade breaks ('B') for the requested symbols are decoded; everything else is skipped by length.
export const IEX_HIST_INDEX = 'https://iextrading.com/api/1.0/hist';
export const IEX_ATTRIBUTION = 'Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use.';
export const IEX_TERMS_URL = 'https://exchange.iex.io/products/market-data-connectivity/hist-terms/';

const T_TRADE = 0x54, T_BREAK = 0x42;
// TOPS 1.6 sale condition flags (byte 1 of a trade report): 0x80 intermarket sweep, 0x40 extended hours, 0x20 odd lot,
// 0x10 trade-through exempt, 0x08 single-price cross (auction). Odd lots never set last sale; extended hours never set the
// regular-session last sale.
const F_EXT = 0x40, F_ODD = 0x20, F_CROSS = 0x08;
const CROSS_GRACE_NS = 2e9; // a closing-cross print can be stamped just after the bell

const enc = new TextEncoder();
export function b64e(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
export function b64d(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
const symKey = (s) => s.toUpperCase().padEnd(8, ' ');

// symbols: iterable of tickers as IEX lists them (BRK.B style). returns { feed, finish, stats }
// state: optional exportState() output from an earlier step (resumable collection across Worker invocations).
export function createTopsParser(symbols, { sessionCloseNs = null, sessionOpenNs = null, state = null } = {}) {
  const want = new Map(); // 8-byte key -> symbol
  for (const s of symbols) want.set(symKey(s), s.toUpperCase());
  const keys = [...want.keys()].map((k) => enc.encode(k));
  const out = new Map(); // symbol -> aggregate (plain JSON: safe to checkpoint)
  const stats = { blocks: 0, packets: 0, messages: 0, trades: 0, matched: 0, breaks: 0, bytes: 0 };
  let buf = new Uint8Array(0), le = true, started = false;
  if (state) {
    for (const a of state.aggs || []) out.set(a.symbol, a);
    Object.assign(stats, state.stats || {});
    le = state.le !== false; started = !!state.started;
    if (state.buf) buf = b64d(state.buf);
  }

  function matchSym(p, o) {
    // o = offset of the 8-byte symbol field
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]; let ok = true;
      for (let i = 0; i < 8; i++) if (p[o + i] !== key[i]) { ok = false; break; }
      if (ok) return k;
    }
    return -1;
  }
  const keyList = [...want.values()];
  const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; // ns since epoch < 2^63 (fits in double to ~256 ns)
  const i64price = (dv, o) => (dv.getUint32(o, true) + dv.getInt32(o + 4, true) * 4294967296) / 10000;

  function onTrade(dv, p, o, isBreak) {
    stats.trades++;
    const k = matchSym(p, o + 10);
    if (k < 0) return;
    stats.matched++;
    const sym = keyList[k];
    const flags = p[o + 1];
    const ts = u64(dv, o + 2);
    const size = dv.getUint32(o + 18, true);
    const price = i64price(dv, o + 22);
    let a = out.get(sym);
    if (!a) out.set(sym, a = { symbol: sym, trades: 0, volume: 0, breaks: 0, first: null, last: null, lastRegular: null, recent: [], high: null, low: null });
    const tradeId = u64(dv, o + 30);
    if (isBreak) {
      // a trade break voids that print: drop it from the recent eligible trades and fall back to the previous one
      a.breaks++; stats.breaks++;
      const i = a.recent.findIndex((x) => x.id === tradeId);
      if (i >= 0) { a.recent.splice(i, 1); a.lastRegular = a.recent.at(-1) || null; }
      return;
    }
    a.trades++; a.volume += size;
    const ext = (flags & F_EXT) !== 0;
    const eligible = (flags & F_ODD) === 0;
    const rec = { ts_ns: ts, price, size, flags, id: tradeId };
    if (!a.first) a.first = rec;
    a.last = rec;
    const closeOk = sessionCloseNs == null || ts <= sessionCloseNs || ((flags & F_CROSS) !== 0 && ts <= sessionCloseNs + CROSS_GRACE_NS);
    if (eligible && !ext && closeOk && (sessionOpenNs == null || ts >= sessionOpenNs)) {
      a.lastRegular = rec;
      a.recent.push(rec); if (a.recent.length > 8) a.recent.shift();
      a.high = a.high == null || price > a.high ? price : a.high;
      a.low = a.low == null || price < a.low ? price : a.low;
    }
  }

  function parsePacket(p, dv, off, len) {
    // Ethernet(14) + IPv4 (IHL) + UDP(8) -> IEX-TP. dv is the caller's DataView over the same bytes (no per-packet alloc).
    if (len < 42) return;
    const ihl = (p[off + 14] & 0x0f) * 4;
    let o = off + 14 + ihl + 8;
    const end = off + len;
    if (o + 40 > end) return;
    const mcount = p[o + 14] | (p[o + 15] << 8);
    o += 40;
    for (let m = 0; m < mcount && o + 2 <= end; m++) {
      const ml = p[o] | (p[o + 1] << 8); o += 2;
      if (o + ml > end) break;
      stats.messages++;
      const t = p[o];
      if (t === T_TRADE && ml >= 38) onTrade(dv, p, o, false);
      else if (t === T_BREAK && ml >= 38) onTrade(dv, p, o, true);
      o += ml;
    }
    stats.packets++;
  }

  function feed(chunk) {
    stats.bytes += chunk.length;
    if (buf.length) { const n = new Uint8Array(buf.length + chunk.length); n.set(buf); n.set(chunk, buf.length); buf = n; } else buf = chunk;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    while (o + 12 <= buf.length) {
      const type = dv.getUint32(o, le);
      if (!started) {
        if (type !== 0x0a0d0d0a) throw new Error('iex-hist: not a pcapng stream');
        const bom = dv.getUint32(o + 8, true); le = bom === 0x1a2b3c4d; started = true;
      }
      const blen = dv.getUint32(o + 4, le);
      if (blen < 12) throw new Error('iex-hist: corrupt pcapng block');
      if (o + blen > buf.length) break;
      stats.blocks++;
      if (type === 6) { // Enhanced Packet Block
        const cap = dv.getUint32(o + 20, le);
        parsePacket(buf, dv, o + 28, cap);
      } else if (type === 3) { // Simple Packet Block
        parsePacket(buf, dv, o + 12, blen - 16);
      }
      o += blen;
    }
    buf = buf.subarray(o);
  }

  function finish() {
    const nsIso = (ns) => (ns == null ? null : new Date(Math.floor(ns / 1e6)).toISOString());
    return [...out.values()].map((a) => ({
      symbol: a.symbol, venue: 'IEX', trades: a.trades, volume: a.volume, breaks: a.breaks,
      last_regular_price: a.lastRegular?.price ?? null, last_regular_at: nsIso(a.lastRegular?.ts_ns), last_regular_size: a.lastRegular?.size ?? null,
      first_trade_at: nsIso(a.first?.ts_ns), last_trade_at: nsIso(a.last?.ts_ns), high: a.high, low: a.low,
    }));
  }
  // everything needed to continue in a later invocation: aggregates, stats, byte order, and the partial pcapng block
  function exportState() { return { v: 1, aggs: [...out.values()], stats: { ...stats }, le, started, buf: buf.length ? b64e(buf) : null }; }
  return { feed, finish, stats, exportState };
}

// The HIST index for one date -> the TOPS file entry ({ link, size, version }) or null.
export function topsEntry(indexJson) {
  const list = Array.isArray(indexJson) ? indexJson : [];
  return list.filter((x) => x?.feed === 'TOPS' && x?.protocol === 'IEXTP1' && typeof x.link === 'string').sort((a, b) => String(b.version).localeCompare(String(a.version)))[0] || null;
}
