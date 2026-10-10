// PBE Market Tape core (issues #54, #56; network-wide). Pure logic: the NYSE/Nasdaq regular-session calendar, the featured
// watchline with its Robinhood stock-page handoffs, and quote rows built ONLY from source fields.
//
// Boundaries (never cross them):
//   * FEATURED is editorial placement. It is not the model's ranking, not in the S&P 500 model universe, never an input to
//     src/signal10/rank.js, and never touches the $10,000 paper account or its ledger.
//   * A Robinhood link is an external brokerage handoff (a public stock page). No order, account link or partnership.
//   * price / previous_close / price_observed_at come from the source response; our fetch time is reported separately.

// ---------- featured watchline (owner order, #54 amendment 2026-10-10: SpaceX first) ----------
// Robinhood pages verified 2026-10-10: each https://robinhood.com/us/en/stocks/<SYM>/ answered 200 with the company title
// (a bogus symbol answers 404 "Page not found"). SPCX = Space Exploration Technologies Corp., Nasdaq listing 2026-06-12
// (Class A CUSIP 84615Q103); no earlier, unrelated SPCX history is ever joined to it.
export const FEATURED = Object.freeze([
  { symbol: 'SPCX', name: 'SpaceX', listed: '2026-06-12', pinned: true },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
  { symbol: 'QQQ', name: 'Invesco QQQ' },
  { symbol: 'NVDA', name: 'NVIDIA' },
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'AAPL', name: 'Apple' },
  { symbol: 'AMZN', name: 'Amazon' },
  { symbol: 'GOOGL', name: 'Alphabet' },
  { symbol: 'META', name: 'Meta' },
  { symbol: 'TSLA', name: 'Tesla' },
  { symbol: 'HOOD', name: 'Robinhood' },
].map((x) => Object.freeze(x)));

// Robinhood stock detail page for a U.S. equity ticker, or null when the symbol is not a plain listed-equity ticker
// (share classes keep the dot: BRK.B -> /stocks/BRK.B/, verified 200).
const TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;
export function robinhoodUrl(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  return TICKER.test(s) ? `https://robinhood.com/us/en/stocks/${s}/` : null;
}

// ---------- America/New_York calendar ----------
// NYSE published holidays + 1:00 p.m. early closes (nyse.com/markets/hours-calendars, read 2026-10-10). Nasdaq observes
// the same days. Federal holidays that are trading days (Columbus Day 2026-10-12, Veterans Day) are NOT listed here.
export const CALENDAR_THROUGH = '2028-12-31';
export const HOLIDAYS = Object.freeze(new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]));
export const EARLY_CLOSES = Object.freeze(new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']));
const OPEN_MIN = 9 * 60 + 30, CLOSE_MIN = 16 * 60, EARLY_MIN = 13 * 60;

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
export function nyParts(ms) {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), seconds: Number(p.second), weekday: p.weekday };
}
// UTC instant of a New York wall-clock time (DST-correct: solve with the zone's offset at that instant).
export function nyInstant(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = nyParts(t);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const wall = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    t += guess - wall;
  }
  return t;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekend = (date) => { const w = new Date(`${date}T12:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
export const covered = (date) => date >= '2026-01-01' && date <= CALENDAR_THROUGH;
export function isTradingDay(date) { return !weekend(date) && !HOLIDAYS.has(date); }
export function closeMinutes(date) { return EARLY_CLOSES.has(date) ? EARLY_MIN : CLOSE_MIN; }
const nextTradingDay = (date) => { let d = addDays(date, 1); for (let i = 0; i < 10 && !isTradingDay(d); i++) d = addDays(d, 1); return d; };
export const prevTradingDay = (date) => { let d = addDays(date, -1); for (let i = 0; i < 10 && !isTradingDay(d); i++) d = addDays(d, -1); return d; };
const iso = (ms) => new Date(ms).toISOString();

// The regular session at an instant. state: OPEN | PRE_MARKET | AFTER_CLOSE | CLOSED_WEEKEND | CLOSED_HOLIDAY | CALENDAR_UNKNOWN.
// last_session = the latest session whose close has passed (its close is the "last close" a closed tape shows).
export function marketSession(nowIso) {
  const now = Date.parse(nowIso);
  const c = nyParts(now);
  const base = { date: c.date, early_close: EARLY_CLOSES.has(c.date) };
  if (!covered(c.date)) return { ...base, state: 'CALENDAR_UNKNOWN', label: 'MARKET HOURS UNVERIFIED', opens_at: null, closes_at: null, next_open_at: null, last_session: null, last_close_at: null };
  // beyond the published calendar a date is never claimed as a session (fail closed: null)
  const sessionOf = (d) => (covered(d) ? { opens_at: iso(nyInstant(d, OPEN_MIN)), closes_at: iso(nyInstant(d, closeMinutes(d))) } : { opens_at: null, closes_at: null });
  const lastBefore = (d) => { const p = prevTradingDay(d); return { last_session: p, last_close_at: sessionOf(p).closes_at }; };
  if (!isTradingDay(c.date)) {
    const n = nextTradingDay(c.date);
    return { ...base, state: weekend(c.date) ? 'CLOSED_WEEKEND' : 'CLOSED_HOLIDAY', label: weekend(c.date) ? 'MARKET CLOSED' : 'MARKET HOLIDAY',
      opens_at: null, closes_at: null, next_open_at: sessionOf(n).opens_at, ...lastBefore(c.date) };
  }
  const today = sessionOf(c.date);
  const close = closeMinutes(c.date);
  if (c.minutes < OPEN_MIN) return { ...base, state: 'PRE_MARKET', label: 'MARKET CLOSED', ...today, next_open_at: today.opens_at, ...lastBefore(c.date) };
  if (c.minutes < close) return { ...base, state: 'OPEN', label: base.early_close ? 'MARKET OPEN · EARLY CLOSE 1:00 PM ET' : 'MARKET OPEN', ...today, next_open_at: sessionOf(nextTradingDay(c.date)).opens_at, ...lastBefore(c.date) };
  return { ...base, state: 'AFTER_CLOSE', label: 'MARKET CLOSED', ...today, next_open_at: sessionOf(nextTradingDay(c.date)).opens_at, last_session: c.date, last_close_at: today.closes_at };
}

// ---------- quotes ----------
// From a Yahoo chart response (range=5d, interval=1d): the last regular-session trade and its own timestamp, and the
// previous REGULAR close = the close of the last daily bar dated before the trade's session date (never chartPreviousClose,
// which is the close before the requested window).
export function quoteFromBars(symbol, json) {
  const r = json?.chart?.result?.[0];
  const m = r?.meta;
  if (!m || !(Number.isFinite(m.regularMarketPrice) && m.regularMarketPrice > 0) || !Number.isFinite(m.regularMarketTime)) return null;
  if (m.symbol && String(m.symbol).toUpperCase() !== String(symbol).toUpperCase().replace(/\./g, '-')) return null;
  const observedMs = m.regularMarketTime * 1000;
  const session = nyParts(observedMs).date;
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  let prev = null;
  for (let i = 0; i < ts.length; i++) {
    const d = nyParts(ts[i] * 1000).date;
    if (d < session && Number.isFinite(closes[i]) && closes[i] > 0) prev = { d, close: closes[i] };
  }
  // only the immediately preceding regular session counts (a missing bar never silently falls back to an older close)
  if (prev && covered(session) && prev.d !== prevTradingDay(session)) prev = null;
  return { symbol, price: m.regularMarketPrice, price_observed_at: iso(observedMs), session_date: session,
    previous_close: prev ? prev.close : null, previous_close_date: prev ? prev.d : null, exchange: m.fullExchangeName || m.exchangeName || null,
    long_name: m.longName || m.shortName || null, first_trade_at: Number.isFinite(m.firstTradeDate) ? iso(m.firstTradeDate * 1000) : null };
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
export const MAX_OPEN_AGE_MIN = 20;

// One tape row. status: CURRENT (in-session, fresh) | DELAYED (in-session, older than 2 min but within 20) |
// LAST_CLOSE (session closed and the quote is that session's close) | STALE | SOURCE_UNAVAILABLE. Fail closed: STALE and
// SOURCE_UNAVAILABLE carry no price and no change.
export function tapeRow(meta, q, session, nowIso) {
  const out = { symbol: meta.symbol, name: meta.name, robinhood_url: robinhoodUrl(meta.symbol), group: meta.group || 'FEATURED', pinned: !!meta.pinned,
    price: null, previous_close: null, change_abs: null, change_pct: null, price_observed_at: null, session_date: null, status: 'SOURCE_UNAVAILABLE' };
  if (!q || !(q.price > 0) || !q.price_observed_at) return out;
  const now = Date.parse(nowIso), t = Date.parse(q.price_observed_at);
  if (!(t <= now + 120000)) return { ...out, status: 'STALE', price_observed_at: q.price_observed_at };
  let status;
  if (session.state === 'OPEN') {
    const ageMin = (now - t) / 60000;
    if (q.session_date !== session.date || ageMin > MAX_OPEN_AGE_MIN) status = 'STALE';
    else status = ageMin > 2 ? 'DELAYED' : 'CURRENT';
  } else if (session.last_session) {
    status = q.session_date === session.last_session ? 'LAST_CLOSE' : 'STALE';
  } else status = 'STALE';
  if (status === 'STALE') return { ...out, status, price_observed_at: q.price_observed_at, session_date: q.session_date };
  const pc = q.previous_close > 0 ? q.previous_close : null;
  return { ...out, status, price: q.price, previous_close: pc, price_observed_at: q.price_observed_at, session_date: q.session_date,
    change_abs: pc ? round(q.price - pc, 4) : null, change_pct: pc ? round((q.price - pc) / pc, 6) : null };
}

// Edge-cache lifetime for one symbol's quote: short while the session is open (browser polls every 90 s), otherwise held
// until shortly after the next open so a closed market causes no repeated vendor requests (capped at 6 h).
export function quoteTtlSeconds(session, nowIso) {
  if (session.state === 'OPEN') return 45;
  // the first ten minutes after the bell: the official closing print can arrive after the last in-session trade
  if (session.state === 'AFTER_CLOSE' && Date.parse(nowIso) - Date.parse(session.closes_at) < 10 * 60000) return 60;
  if (!session.next_open_at) return 900;
  // expires AT the next open, so the first in-session read is a new source quote
  const s = Math.floor((Date.parse(session.next_open_at) - Date.parse(nowIso)) / 1000);
  return Math.max(60, Math.min(6 * 3600, s));
}
