// Employment Tier A research collector: pure helpers (no I/O). Owner-approved 2026-10-08, data and prices only:
// no model fitting, no forecasts, no trading. Never imported by the Worker.
export const COLLECTOR_VERSION = 'employment-collector/2';
export const ET = 'America/New_York';
export const SERIES = ['KXU3', 'KXPAYROLLS'];
// Kalshi snapshot slots: N days before the release date, 20:00 America/New_York (T-1D 20:00 = the pre-registered cutoff)
export const SLOT_DAYS = { 'T-7D': 7, 'T-3D': 3, 'T-1D': 1 };
export const SLOT_WINDOW_MS = 15 * 60 * 1000; // a snapshot counts for a slot only if it completes in [slot - 15 min, slot)
export const SETTLE_AFTER_DAYS = { 'SETTLE+1D': 1, 'SETTLE+3D': 3 };
export const TICK_GAP_MS = 15 * 60 * 1000; // ticks run every 5 min; a longer silence is an offline gap
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const p2 = (n) => String(n).padStart(2, '0');

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' });
// wall-clock parts of an instant in America/New_York
export function etParts(ms) {
  const o = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hh: Number(o.hour), mm: Number(o.minute), weekday: o.weekday };
}
// the UTC instant of an America/New_York wall time (DST resolved by the named zone, never by a fixed offset)
export function etWallToUtcMs(ymd, hh, mm) {
  const [y, m, d] = ymd.split('-').map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, hh + off, mm);
    const e = etParts(t);
    if (e.date === ymd && e.hh === hh && e.mm === mm) return t;
  }
  throw new Error(`no America/New_York instant for ${ymd} ${hh}:${mm}`);
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}
export const eventTicker = (series, refMonth) => `${series}-${refMonth.slice(2, 4)}${MON[Number(refMonth.slice(5, 7)) - 1]}`;
export const compactUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// BLS "Schedule of Releases for the Employment Situation": rows "October 2026 | Nov. 06, 2026 | 08:30 AM"
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function parseBlsSchedule(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 3) continue;
    const ref = /^([A-Za-z]+) (\d{4})$/.exec(cells[0]);
    const rel = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(cells[1]);
    const tm = /^(\d{1,2}):(\d{2}) (AM|PM)$/i.exec(cells[2]);
    if (!ref || !rel || !tm || !MONTHS[ref[1].slice(0, 3).toLowerCase()] || !MONTHS[rel[1].toLowerCase()]) continue;
    const hh = (Number(tm[1]) % 12) + (tm[3].toUpperCase() === 'PM' ? 12 : 0);
    const releaseDate = `${rel[3]}-${p2(MONTHS[rel[1].toLowerCase()])}-${p2(rel[2])}`;
    out.push({ reference_month: `${ref[2]}-${p2(MONTHS[ref[1].slice(0, 3).toLowerCase()])}`, release_date: releaseDate, release_time_et: `${p2(hh)}:${tm[2]}`, release_at: new Date(etWallToUtcMs(releaseDate, hh, Number(tm[2]))).toISOString() });
  }
  return out;
}

export function slotTimes(release) {
  return Object.entries(SLOT_DAYS).map(([slot, n]) => {
    const at = etWallToUtcMs(addDays(release.release_date, -n), 20, 0);
    return { slot, at, window_start: at - SLOT_WINDOW_MS };
  });
}

// Kalshi order book -> executable top of book. Arrays are [price_dollars, quantity] sorted ascending by price; the best
// bid is the last element. A YES ask is the complement of the best NO bid (and its size is that bid's size).
export function deriveBook(ob) {
  const b = ob?.orderbook_fp || ob?.orderbook || {};
  const parse = (xs) => (xs || []).map(([pr, q]) => [Number(pr), Number(q)]).filter(([pr, q]) => Number.isFinite(pr) && Number.isFinite(q) && q > 0).sort((x, y) => y[0] - x[0]);
  const yes = parse(b.yes_dollars); const no = parse(b.no_dollars);
  const bid = yes[0]?.[0] ?? null; const askFromNo = no[0] ? +(1 - no[0][0]).toFixed(4) : null;
  return {
    yes_bids_desc: yes, no_bids_desc: no,
    best_yes_bid: bid, best_yes_bid_size: yes[0]?.[1] ?? null,
    best_yes_ask: askFromNo, best_yes_ask_size: no[0]?.[1] ?? null,
    two_sided: bid !== null && askFromNo !== null,
    mid: bid !== null && askFromNo !== null ? +((bid + askFromNo) / 2).toFixed(4) : null,
    spread: bid !== null && askFromNo !== null ? +(askFromNo - bid).toFixed(4) : null,
    depth_yes_bid_contracts: yes.reduce((a, [, q]) => a + q, 0), depth_no_bid_contracts: no.reduce((a, [, q]) => a + q, 0),
  };
}
// Kalshi quadratic taker fee for C contracts at price P, rounded up to the cent (fee_type quadratic*, multiplier m).
// Unknown fee types return null: the protocol treats that contract as NO_PRICE for the executable test.
export function takerFee(feeType, multiplier, P, C = 1) {
  if (!/^quadratic/.test(String(feeType || '')) || !Number.isFinite(Number(multiplier)) || P === null) return null;
  if (P <= 0 || P >= 1) return 0;
  return Math.ceil(100 * 0.07 * Number(multiplier) * C * P * (1 - P) - 1e-9) / 100;
}

// What one tick must do at instant `now`. `have` reports what the evidence repo already holds; the plan never schedules
// a Kalshi snapshot for a slot whose window has closed (no backfill): such a slot becomes MISSED.
export function plan(now, { calendar, enabledAt, have }) {
  const actions = [];
  for (const rel of calendar) {
    const relAt = Date.parse(rel.release_at);
    for (const s of slotTimes(rel)) {
      const key = `${rel.release_date}/${s.slot}`;
      if (now >= s.window_start && now < s.at) actions.push({ type: 'KALSHI_SNAPSHOT', release: rel, slot: s.slot, slot_at: s.at, key });
      else if (now >= s.at && s.window_start >= enabledAt && !have.slotOk(key) && !have.missed(key)) actions.push({ type: 'MISSED', release: rel, slot: s.slot, slot_at: s.at, key });
    }
    for (const [tag, n] of Object.entries(SETTLE_AFTER_DAYS)) {
      const due = relAt + n * 86400000;
      if (now >= due && now < relAt + 30 * 86400000 && relAt >= enabledAt && !have.settlement(`${rel.release_date}/${tag}`)) actions.push({ type: 'KALSHI_SETTLEMENT', release: rel, tag, due });
    }
    if (now >= relAt + 30000 && now < relAt + 3 * 86400000 && relAt >= enabledAt && !have.blsCurrent(rel.reference_month)) actions.push({ type: 'BLS_CURRENT', release: rel, late: now > relAt + 2 * 3600000 });
    if (now >= relAt + 30000 && now < relAt + 7 * 86400000 && relAt >= enabledAt && !have.blsArchive(rel.reference_month)) actions.push({ type: 'BLS_ARCHIVE', release: rel });
  }
  return actions;
}
