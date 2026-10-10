// PBE Signal 10 — pure UI helpers (formatting, chart geometry, ledger shaping, access + polling rules).
// ES module, no DOM access at import time. Loaded by every Signal 10 page (<script type="module">) and by
// test/signal10-ui.test.js. The page controller (signal10.js, a classic deferred script) reads them from window.S10Core.
// Money is integer CENTS; returns are fractions (0.0745 = 7.45%). Nothing here invents a value: missing -> '—'.

export const MINUS = '−';
export const DASH = '—';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const group = (v, dp) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

// $ from integer cents. sign: prefix '+' on gains. dp: decimals (default 2; 0 for compact headline values).
export function fmtUSD(cents, { sign = false, dp = 2 } = {}) {
  if (!finite(cents)) return DASH;
  const v = cents / 100;
  const s = group(Math.abs(v), dp);
  if (s === group(0, dp)) return `$${s}`;
  return `${v < 0 ? MINUS : sign ? '+' : ''}$${s}`;
}
// $ from a dollar price (quotes, fills). Prices >= $1 show 2 decimals; sub-dollar 4.
export function fmtPrice(d) {
  if (!finite(d)) return DASH;
  return `$${group(d, Math.abs(d) < 1 ? 4 : 2)}`;
}
// percent from a fraction. sign defaults on (returns); pass sign:false for weights/levels.
export function fmtPct(frac, { sign = true, dp = 1 } = {}) {
  if (!finite(frac)) return DASH;
  const v = frac * 100;
  const s = group(Math.abs(v), dp);
  if (s === group(0, dp)) return `${s}%`;
  return `${v < 0 ? MINUS : sign ? '+' : ''}${s}%`;
}
export function fmtInt(n) { return finite(n) ? group(n, 0) : DASH; }
export function fmtQty(n) { return finite(n) ? group(n, Number.isInteger(n) ? 0 : 4) : DASH; }
export const signCls = (v) => (!finite(v) || v === 0 ? 'flat' : v > 0 ? 'pos' : 'neg');

// ---------- time ----------
const ET = 'America/New_York';
export function etDateTime(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return DASH;
  const s = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  return `${s} ET`;
}
export function etTime(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return DASH;
  return `${new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).format(new Date(iso))} ET`;
}
// "2026-10-08" -> "Oct 8, 2026" (a calendar date, never shifted by time zone)
export function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return d ? String(d) : DASH;
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return `${M} ${Number(m[3])}, ${m[1]}`;
}
export function relTime(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return DASH;
  const s = Math.round((nowMs - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
// A quote is fresh when its own source timestamp is within maxMin minutes of now.
export function isFresh(quoteTime, nowMs = Date.now(), maxMin = 20) {
  const t = Date.parse(quoteTime || '');
  return !Number.isNaN(t) && nowMs - t <= maxMin * 60000 && nowMs - t >= -120000;
}

// ---------- access ----------
// Server statuses -> what the page shows. Never infers entitlement on its own.
export function gateFor(status) {
  if (status === 401) return 'signin';
  if (status === 403) return 'upgrade';
  if (status === 503) return 'retry';
  if (status >= 200 && status < 300) return null;
  return 'error';
}
export function retryAfterMs(header, fallbackS = 5) {
  const n = Number(header);
  const s = Number.isFinite(n) && n > 0 ? Math.min(n, 300) : fallbackS;
  return s * 1000;
}

// ---------- live polling + session ----------
// 20 s while the tab is visible AND the regular session is open; 120 s otherwise; null (paused) when hidden.
export function pollMs(sessionState, visible) {
  if (!visible) return null;
  return sessionState === 'OPEN' ? 20000 : 120000;
}
// The pulsing LIVE badge only when the session is OPEN and at least one quote is fresh. Otherwise the server label.
export function sessionBadge(session, quoteTimes = [], nowMs = Date.now()) {
  const state = session?.state || 'UNKNOWN';
  const fresh = quoteTimes.filter((t) => isFresh(t, nowMs)).length;
  if (state === 'OPEN' && fresh > 0) return { live: true, cls: 'open', text: 'LIVE · U.S. REGULAR SESSION' };
  if (state === 'OPEN') return { live: false, cls: 'stale', text: 'SESSION OPEN · QUOTES DELAYED' };
  if (state === 'CLOSED') return { live: false, cls: 'closed', text: 'MARKET CLOSED · LAST CLOSE' };
  if (state === 'CLOSED_WEEKEND') return { live: false, cls: 'closed', text: 'MARKET CLOSED · WEEKEND · LAST CLOSE' };
  if (state === 'PRE_MARKET') return { live: false, cls: 'closed', text: 'PRE-MARKET · LAST CLOSE SHOWN' };
  return { live: false, cls: 'closed', text: session?.label || 'SESSION UNKNOWN' };
}

// ---------- forward paper account ----------
// The authoritative NAV: the live NAV only when every held price is fresh; otherwise the last end-of-day NAV.
export function navView(fwd) {
  if (!fwd) return null;
  const n = (fwd.positions || []).length;
  const freshN = (fwd.positions || []).filter((p) => p.fresh).length;
  if (fwd.nav?.complete && finite(fwd.nav.cents)) return { cents: fwd.nav.cents, partial: false, freshN, totalN: n, basis: 'live', asOf: null };
  if (fwd.lastEod && finite(fwd.lastEod.nav_cents)) return { cents: fwd.lastEod.nav_cents, partial: true, freshN, totalN: n, basis: 'eod', asOf: fwd.lastEod.d };
  return { cents: null, partial: true, freshN, totalN: n, basis: 'none', asOf: null };
}
export function pnl(cur, base) {
  if (!finite(cur) || !finite(base) || base === 0) return { cents: null, pct: null };
  return { cents: cur - base, pct: cur / base - 1 };
}
export function investedPct(navCents, cashCents) {
  if (!finite(navCents) || !finite(cashCents) || navCents <= 0) return null;
  return Math.max(0, Math.min(1, 1 - cashCents / navCents));
}
export function windowLabel(fillSessions, windowSessions = 10) {
  if (!finite(fillSessions) || fillSessions < 1) return `initial ${windowSessions}-trading-day window not started`;
  if (fillSessions <= windowSessions) return `day ${fillSessions} of initial ${windowSessions}-trading-day window`;
  return null;
}
export function positionRow(p, navCents) {
  const value = finite(p.valueCents) ? p.valueCents : null;
  const u = value === null ? { cents: null, pct: null } : pnl(value, p.costCents);
  const day = finite(p.price) && finite(p.previousClose) && p.previousClose > 0 ? p.price / p.previousClose - 1 : null;
  const dayCents = finite(p.price) && finite(p.previousClose) ? Math.round((p.price - p.previousClose) * p.qty * 100) : null;
  return { ...p, value, unrealCents: u.cents, unrealPct: u.pct, dayPct: day, dayCents, weight: value !== null && finite(navCents) && navCents > 0 ? value / navCents : null };
}
// Symbols whose quote timestamp differs from the last render (only those rows are re-rendered).
export function changedQuotes(prev, rows) {
  const out = new Set();
  for (const r of rows || []) if ((prev.get(r.symbol) ?? null) !== (r.quoteTime ?? null) || !prev.has(r.symbol)) out.add(r.symbol);
  return out;
}

// ---------- ranks ----------
export function rankMove(rank, prevRank) {
  if (!finite(prevRank)) return { dir: 'new', text: 'NEW', delta: null };
  const d = prevRank - rank;
  if (d > 0) return { dir: 'up', text: `▲ ${d}`, delta: d };
  if (d < 0) return { dir: 'down', text: `▼ ${-d}`, delta: d };
  return { dir: 'same', text: '=', delta: 0 };
}

// ---------- ledger ----------
// Forward rows are {seq,type,d,payload,hash,prev_hash,inserted_at}; replay rows are already flat.
export function flattenEvent(e) {
  if (e && e.payload && typeof e.payload === 'object') {
    const { payload, ...rest } = e;
    return { ...payload, ...rest };
  }
  return { ...e };
}
export function filterEvents(rows, { type = '', symbol = '' } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  return rows.filter((r) => (!type || r.type === type) && (!sym || String(r.symbol || '').toUpperCase() === sym || String(r.benchmark || '').toUpperCase() === sym));
}
export function paginate(rows, page, size = 100) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, from: rows.length ? (p - 1) * size + 1 : 0, to: Math.min(p * size, rows.length) };
}
export function eventDetail(r) {
  if (r.reason) return r.reason;
  if (r.action) return `${r.action}${r.reason ? `: ${r.reason}` : ''}`;
  if (r.type === 'DIVIDEND') return `${fmtPrice(r.perShare)}/sh × ${fmtQty(r.qty)} · ${r.basis || ''}`.trim();
  if (r.type === 'SPLIT') return `ratio ${r.ratio} · ${fmtQty(r.qtyBefore)} → ${fmtQty(r.qtyAfter)} sh${r.cashInLieuCents ? ` · cash in lieu ${fmtUSD(r.cashInLieuCents)}` : ''}`;
  if (r.type === 'FUNDING') return r.note || '';
  if (r.type === 'STATE') return `account checkpoint (${r.phase || ''}) · cash ${fmtUSD(r.cashCents)} · ${Object.keys(r.positions || {}).length} positions · ${(r.pending || []).length} queued orders`;
  if (r.type === 'SESSION') return [r.window, r.note].filter(Boolean).join(' · ');
  if (r.type === 'EOD_MARK') return `NAV ${fmtUSD(r.navCents)} · cash ${fmtUSD(r.cashCents)}`;
  if (r.type === 'RANK_SNAPSHOT') return `${r.model || ''} · ${fmtInt(r.eligible)} eligible · top 10 ${(r.top10 || []).map((x) => x[0]).join(' ')}`;
  if (r.type === 'FILL_OPEN_DISCREPANCY') return `fill open ${fmtPrice(r.fillOpen)} vs final bar open ${fmtPrice(r.finalBarOpen)}`;
  if (r.type === 'DELIST_LIQUIDATION') return r.flag || '';
  if (r.flag) return r.flag;
  if (r.note) return r.note;
  return '';
}

// ---------- backtest tables ----------
export function monthlyGrid(monthly) {
  const years = new Map();
  let negatives = 0, worst = null, best = null;
  for (const m of monthly || []) {
    const [y, mo] = String(m.period).split('-');
    if (!years.has(y)) years.set(y, new Array(12).fill(null));
    years.get(y)[Number(mo) - 1] = m;
    if (finite(m.returnPct)) {
      if (m.returnPct < 0) negatives++;
      if (!worst || m.returnPct < worst.returnPct) worst = m;
      if (!best || m.returnPct > best.returnPct) best = m;
    }
  }
  return { years: [...years.entries()].map(([year, months]) => ({ year, months })), negatives, total: (monthly || []).length, worst, best };
}
// Heat level 1..3 by magnitude (for tinting only; the value is always printed).
export const heat = (r) => (!finite(r) ? 0 : Math.abs(r) >= 0.06 ? 3 : Math.abs(r) >= 0.025 ? 2 : 1);

export function verdict(strategy, bench) {
  // plain comparison of ending values, no adjectives
  const out = [];
  for (const [k, b] of Object.entries(bench || {})) {
    if (!b || !finite(b.endCents) || !finite(strategy?.endCents)) continue;
    out.push({ key: k, diffCents: strategy.endCents - b.endCents, under: strategy.endCents < b.endCents });
  }
  return out;
}

// ---------- chart geometry ----------
export function extent(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) if (finite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo === Infinity ? null : [lo, hi];
}
export function niceStep(span, count = 5) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
export function niceTicks(lo, hi, count = 5) {
  if (!finite(lo) || !finite(hi)) return [];
  if (lo === hi) { const pad = Math.abs(lo) * 0.05 || 1; lo -= pad; hi += pad; }
  const step = niceStep(hi - lo, count);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  if (out[0] > lo) out.unshift(out[0] - step);
  if (out.at(-1) < hi) out.push(out.at(-1) + step);
  return out;
}
export function logTicks(lo, hi) {
  if (!(lo > 0) || !(hi > 0)) return [];
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
  return out.length >= 2 ? out : [lo, hi];
}
export function scale(d0, d1, r0, r1, { log = false } = {}) {
  const f = log ? Math.log : (x) => x;
  const a = f(d0), b = f(d1);
  const k = b === a ? 0 : (r1 - r0) / (b - a);
  return (v) => r0 + (f(v) - a) * k;
}
// SVG path straight through each data point (M/L only — no smoothing). A null y breaks the line (new M).
export function linePath(xs, ys, sx, sy) {
  let d = '', pen = false;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (!finite(y)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(y).toFixed(1)}`;
    pen = true;
  }
  return d;
}
// running drawdown from peak (fractions <= 0) and the deepest point
export function drawdowns(values) {
  let peak = -Infinity, peakI = -1, worst = 0, at = { peak: -1, trough: -1 };
  const dd = values.map((v, i) => {
    if (!finite(v)) return null;
    if (v > peak) { peak = v; peakI = i; }
    const x = v / peak - 1;
    if (x < worst) { worst = x; at = { peak: peakI, trough: i }; }
    return x;
  });
  return { dd, max: worst, ...at };
}
// nearest index of x in an ascending numeric array
export function nearest(arr, x) {
  if (!arr.length) return -1;
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m; else hi = m; }
  return Math.abs(arr[hi] - x) < Math.abs(x - arr[lo]) ? hi : lo;
}
export const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
// compact $ axis label from cents: $10k, $12.5k, $1.2M
export function axisUSD(cents, stepCents = 0) {
  const v = cents / 100;
  // fine tick steps (< $1,000): full dollars, so neighbouring ticks never print the same label
  if (stepCents > 0 && stepCents < 100000) return `${v < 0 ? MINUS : ''}$${group(Math.abs(Math.round(v)), 0)}`;
  if (Math.abs(v) >= 1e6) return `$${+(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${+(v / 1e3).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

// ---------- U.S. stock tape (issue #54) ----------
// Next tape fetch in ms, or null (paused while hidden). Open regular session: every 90 s. Just after the bell: ONE more
// read at close + 5 min (the official closing print). Otherwise closed: one wake-up at the next open + 60 s (min 60 s,
// max 6 h). No calendar: 15 min.
export function tapePollMs(session, visible, nowMs = Date.now()) {
  if (!visible) return null;
  const st = session?.state;
  if (st === 'OPEN') return 90000;
  const settle = Date.parse(session?.closes_at || '') + 5 * 60000;
  if (st === 'AFTER_CLOSE' && nowMs < settle) return Math.max(60000, settle - nowMs);
  const next = Date.parse(session?.next_open_at || '');
  if (Number.isNaN(next)) return 15 * 60000;
  return Math.max(60000, Math.min(6 * 3600000, next - nowMs + 60000));
}
const ET_DAY = (iso, o) => new Intl.DateTimeFormat('en-US', { timeZone: ET, ...o }).format(new Date(iso));
// "Fri Oct 9, 4:00 PM ET"
export function etShort(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return DASH;
  return `${ET_DAY(iso, { weekday: 'short', month: 'short', day: 'numeric' })}, ${ET_DAY(iso, { hour: 'numeric', minute: '2-digit' })} ET`;
}
// Head status for the tape. Never "LIVE" unless the session is open AND at least one quote is CURRENT (source time <= 2 min).
export function tapeStatus(session, rows = []) {
  const st = session?.state || 'CALENDAR_UNKNOWN';
  const has = (s) => rows.some((r) => r.status === s);
  if (st === 'OPEN') {
    if (has('CURRENT')) return { cls: 'open', live: true, text: session.early_close ? 'LIVE · MARKET OPEN · CLOSES 1:00 PM ET' : 'LIVE · MARKET OPEN' };
    if (has('DELAYED')) return { cls: 'delayed', live: false, text: 'MARKET OPEN · QUOTES DELAYED' };
    if (has('PRIOR_SESSION')) return { cls: 'open-idle', live: false, text: 'MARKET OPEN · PRIOR-SESSION PRICES' };
    if (has('MEMBERS_ONLY') || has('SOURCE_RIGHTS_HOLD')) return { cls: 'open-idle', live: false, text: 'MARKET OPEN' };
    return { cls: 'stale', live: false, text: 'MARKET OPEN · SOURCE UNAVAILABLE' };
  }
  if (st === 'AFTER_CLOSE' && has('PRIOR_SESSION')) return { cls: 'closed', live: false, text: 'MARKET CLOSED · PRIOR-SESSION PRICES' };
  const closed = st === 'CLOSED_WEEKEND' ? 'MARKET CLOSED · WEEKEND' : st === 'CLOSED_HOLIDAY' ? 'MARKET CLOSED · EXCHANGE HOLIDAY'
    : st === 'PRE_MARKET' ? 'PRE-MARKET · LAST CLOSE' : st === 'AFTER_CLOSE' ? 'MARKET CLOSED · LAST CLOSE' : 'MARKET HOURS UNVERIFIED';
  return { cls: 'closed', live: false, text: closed };
}
// Source trade-time span across priced rows: { min, max } ISO or null.
export function quoteSpan(rows = []) {
  const t = rows.filter((r) => r.price != null && r.price_observed_at).map((r) => Date.parse(r.price_observed_at)).filter((x) => !Number.isNaN(x));
  if (!t.length) return null;
  return { min: new Date(Math.min(...t)).toISOString(), max: new Date(Math.max(...t)).toISOString() };
}

const API = {
  MINUS, DASH, esc, fmtUSD, fmtPrice, fmtPct, fmtInt, fmtQty, signCls, etDateTime, etTime, fmtDate, relTime, isFresh, gateFor, retryAfterMs, pollMs, sessionBadge,
  navView, pnl, investedPct, windowLabel, positionRow, changedQuotes, rankMove, flattenEvent, filterEvents, paginate, eventDetail, monthlyGrid, heat, verdict,
  extent, niceStep, niceTicks, logTicks, scale, linePath, drawdowns, nearest, dayMs, axisUSD,
  tapePollMs, etShort, tapeStatus, quoteSpan
};
if (typeof window !== 'undefined') {
  window.S10Core = API;
  window.dispatchEvent(new Event('s10core'));
}
