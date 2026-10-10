// Signal 10 Strategy Arena — challenger ranking + portfolio managers (pure, deterministic, Worker-safe). Issue #62.
// Accounting (fills at the open, splits, dividends, delist liquidation, EOD mark) reuses the control's pure functions from
// ../portfolio.js BY IMPORT ONLY: those conventions are shared on purpose so the head-to-head is fair. Selection, sizing,
// regime, exits and caps are challenger-specific and live here. Every feature at decision date D reads bars dated <= D.
import { prepareSeries, percentiles } from '../rank.js';
import { corporateActions, execute, mark, delistings, emit } from '../portfolio.js';
import { TECH, DIVERSIFIED, STARTING_CASH_CENTS } from './policies.js';

export { prepareSeries };
export const ORIGIN = 'ARENA_FORWARD_PAPER';

const sma = (p, i, len) => (p.ps[i + 1] - p.ps[i + 1 - len]) / len;
function vol(p, i, len) {
  const s = p.lr[i + 1] - p.lr[i + 1 - len], s2 = p.lr2[i + 1] - p.lr2[i + 1 - len];
  const m = s / len; const v = Math.max(0, s2 / len - m * m) * len / (len - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
function median(arr) { const a = Array.from(arr).sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
const r6 = (x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x);

// Features for prepared series p at bar i under eligibility rules R (the strategy's `rank` block).
export function arenaFeatures(p, i, R) {
  if (i == null || i < 0) return { eligible: false, reason: 'no_bar' };
  if (i + 1 < R.minHistory) return { eligible: false, reason: 'insufficient_history' };
  const j = i - (R.minHistory - 1);
  if (p.cal[i] < 0 || p.cal[j] < 0) return { eligible: false, reason: 'off_calendar' };
  if (p.cal[i] - p.cal[j] - (R.minHistory - 1) > R.maxCalendarGap) return { eligible: false, reason: 'trading_gap' };
  if (p.c[i] < R.minPrice) return { eligible: false, reason: 'price_below_min' };
  const mdv = median(p.dv.subarray(i - 62, i + 1));
  if (!(mdv >= R.minMedianDollarVolume)) return { eligible: false, reason: 'illiquid' };
  let hi252 = 0; for (let k = i - 251; k <= i; k++) hi252 = Math.max(hi252, p.adj[k]);
  const mom12_1 = p.adj[i - 21] / p.adj[i - 252] - 1;
  const v252 = vol(p, i, 252), v63 = vol(p, i, 63);
  const s50 = sma(p, i, 50), s200 = sma(p, i, 200);
  return {
    eligible: true, mom12_1, mom6: p.adj[i] / p.adj[i - 126] - 1, mom3: p.adj[i] / p.adj[i - 63] - 1,
    trend50: p.adj[i] / s50 - 1, trend200: p.adj[i] / s200 - 1, high252: p.adj[i] / hi252 - 1, resilience252: p.adj[i] / hi252 - 1,
    riskAdjMom: v252 > 0 ? mom12_1 / v252 : 0, lowVol63: -v63, vol63: v63, sma50: s50, sma200: s200, adj: p.adj[i], close: p.c[i],
    ret1: p.adj[i] / p.adj[i - 1] - 1, medianDollarVolume: mdv,
  };
}

// Rank one strategy's universe at D. universe: [{ ticker, symbol, sector }] (symbol null = uncovered).
export function rankStrategy(S, date, universe, prepared) {
  const rows = [], excluded = {}; const seen = new Set();
  for (const u of universe) {
    if (!u.symbol) { excluded.uncovered = (excluded.uncovered || 0) + 1; continue; }
    if (seen.has(u.symbol)) continue; seen.add(u.symbol);
    const p = prepared.get(u.symbol);
    if (!p) { excluded.no_price_history = (excluded.no_price_history || 0) + 1; continue; }
    const f = arenaFeatures(p, p.idx.get(date), S.rank);
    if (!f.eligible) { excluded[f.reason] = (excluded[f.reason] || 0) + 1; continue; }
    rows.push({ ticker: u.ticker, symbol: u.symbol, name: p.name, sector: u.sector, f });
  }
  const W = S.rank.weights; const keys = Object.keys(W);
  const pct = Object.fromEntries(keys.map((k) => [k, percentiles(rows.map((r) => r.f[k]))]));
  rows.forEach((r, k) => { r.composite = keys.reduce((s, key) => s + W[key] * pct[key][k], 0); });
  const cp = percentiles(rows.map((r) => r.composite));
  rows.forEach((r, k) => { r.score = Math.round(cp[k] * 1000) / 10; });
  rows.sort((a, b) => b.composite - a.composite || (a.symbol < b.symbol ? -1 : 1));
  rows.forEach((r, k) => { r.rank = k + 1; });
  return { date, model: S.model, eligible: rows.length, excluded, ranks: rows };
}

export function regimeOf(prepared, symbol, D) {
  const p = prepared.get(symbol); const i = p?.idx.get(D);
  if (i == null || i < 199) return { symbol, riskOn: false, reason: 'insufficient_history' };
  const s200 = sma(p, i, 200);
  return { symbol, riskOn: p.adj[i] >= s200, adj: r6(p.adj[i]), sma200: r6(s200) };
}

// ---------------- account ----------------
export function newChallenger(S, inception, policySha256) {
  const st = { account: S.account, strategy: S.strategy, origin: ORIGIN, policy: S.policy, model: S.model, policySha256, inception,
    slippageBps: S.manager.slippageBps, cashCents: STARTING_CASH_CENTS, positions: {}, meta: {}, cooldown: {}, riskOffStreak: 0,
    realizedCents: 0, dividendsCents: 0, slippageCents: 0, tradedCents: 0, fillSessions: 0, eodSessions: 0, pending: [], seq: 0, events: [] };
  emit(st, { type: 'FUNDING', d: inception, cashCents: STARTING_CASH_CENTS, strategy: S.strategy, model: S.model, policy: S.policy, policySha256,
    note: '$10,000.00 simulated cash. No real money. Prospective Strategy Arena cohort start (T0).' });
  return st;
}

// Fills at D's open for orders frozen at the previous close (shared accounting), then tag new positions with their meta.
// Review fix (pre-T0): SELL quantities were set at the decision close; a split effective at this open changes the share
// count first. Full exits (order.full) sell the whole post-split position; partial trims scale by the split ratio.
export function openSession(st, D, prepared) {
  const n0 = st.events.length;
  corporateActions(st, D, prepared);
  for (const o of st.pending) {
    if (o.side !== 'SELL') continue;
    const ratio = (prepared.get(o.symbol)?.splits || []).filter((x) => x.d === D).reduce((f, x) => f * x.ratio, 1);
    if (o.full) o.qty = st.positions[o.symbol]?.qty ?? o.qty;
    else if (ratio !== 1 && o.qty != null) { const q = Math.floor(o.qty * ratio + 1e-9); emit(st, { type: 'ORDER_SPLIT_ADJUSTED', d: D, symbol: o.symbol, orderSeq: o.seq, qtyBefore: o.qty, qtyAfter: q, ratio }); o.qty = q; }
  }
  execute(st, D, prepared);
  for (const [sym, pos] of Object.entries(st.positions)) if (st.meta[sym]) Object.assign(pos, { sector: st.meta[sym].sector, kind: st.meta[sym].kind });
  for (const sym of Object.keys(st.meta)) if (!st.positions[sym]) delete st.meta[sym];
  st.fillSessions += 1; st.lastOpen = D;
  return st.events.slice(n0);
}

function tickCooldowns(st) {
  for (const k of Object.keys(st.cooldown)) { st.cooldown[k] -= 1; if (st.cooldown[k] <= 0) delete st.cooldown[k]; }
}

function common(st, D, m) {
  const nav = m.navCents;
  const valueOf = (sym) => m.positions.find((x) => x.symbol === sym)?.valueCents || 0;
  const orders = [], decisions = [];
  const order = (o) => { const e = emit(st, { type: 'ORDER', d: D, ...o, executeAt: 'next regular-session open' }); orders.push(e); if (o.side === 'BUY') st.meta[o.symbol] = { sector: o.sector, kind: o.kind || 'EQUITY' }; return e; };
  const decision = (x) => decisions.push(emit(st, { type: 'DECISION', d: D, ...x }));
  return { nav, valueOf, orders, decisions, order, decision };
}

// ---------------- TECH manager ----------------
export function decideTech(st, D, snap, { regime, prepared, m }) {
  const M = TECH.manager;
  tickCooldowns(st); st.eodSessions += 1;
  // a missing / short regime series is NOT a risk-off close: the streak is frozen (no new buys that session either)
  if (!regime.reason) st.riskOffStreak = regime.riskOn ? 0 : st.riskOffStreak + 1;
  const { nav, valueOf, orders, decisions, order, decision } = common(st, D, m);
  const byS = new Map(snap.ranks.map((r) => [r.symbol, r]));
  const exiting = new Set(); const trimmed = new Set();
  for (const [sym, pos] of Object.entries(st.positions)) {
    const p = prepared.get(sym); const i = p?.idx.get(D);
    if (i == null) { decision({ action: 'HOLD', symbol: sym, reason: 'NO_BAR_TODAY: no observed close; no decision on missing data' }); continue; }
    pos.peakAdj = Math.max(pos.peakAdj || 0, p.adj[i]);
    const r = byS.get(sym);
    const s200 = i >= 199 ? sma(p, i, 200) : null;
    let why = null, cool = false;
    if (!r) why = 'NOT_RANKED: left the technology universe or failed eligibility';
    else if (r.rank > M.exitRank) why = `RANK_EXIT: rank ${r.rank} > ${M.exitRank}`;
    else if (p.adj[i] / pos.peakAdj - 1 <= M.trailingStop) { why = `TRAILING_STOP: ${((p.adj[i] / pos.peakAdj - 1) * 100).toFixed(1)}% from peak`; cool = true; }
    else if (st.riskOffStreak >= M.deriskAfterRiskOffCloses && s200 != null && p.adj[i] < s200) { why = `DERISK: QQQ below its 200-day average for ${st.riskOffStreak} closes and the holding is below its own 200-day average`; cool = true; }
    if (why) {
      exiting.add(sym); if (cool) st.cooldown[sym] = M.cooldownSessions;
      order({ side: 'SELL', symbol: sym, ticker: pos.ticker, qty: pos.qty, full: true, reason: why, rank: r?.rank ?? null, score: r?.score ?? null });
      continue;
    }
    const value = valueOf(sym);
    if (value / nav > M.trimAboveWeight) {
      const qty = Math.ceil((value - M.trimToWeight * nav) / (p.c[i] * 100));
      if (qty > 0 && qty < pos.qty) { trimmed.add(sym); order({ side: 'SELL', symbol: sym, ticker: pos.ticker, qty, reason: `TRIM: weight ${(value / nav * 100).toFixed(1)}% > ${M.trimAboveWeight * 100}%`, rank: r.rank, score: r.score }); continue; }
    }
    decision({ action: 'HOLD', symbol: sym, rank: r.rank, score: r.score, reason: r.rank <= M.entryMaxRank ? 'HOLD: still a top-8 technology name' : `HOLD: rank ${r.rank} inside the ${M.exitRank} exit band` });
  }
  const heldAfter = Object.keys(st.positions).filter((s) => !exiting.has(s));
  let slots = M.maxPositions - heldAfter.length, buys = 0;
  let budget = st.cashCents + [...exiting].reduce((s, sym) => s + valueOf(sym), 0);
  const target = Math.round(M.targetWeight * nav);
  const qualified = [];
  for (const r of snap.ranks.slice(0, M.entryMaxRank)) {
    if (st.positions[r.symbol]) continue;
    let why = null;
    if (regime.reason) why = `WAIT: technology regime unavailable (${regime.reason}); no new names on missing data`;
    else if (!regime.riskOn) why = 'WAIT: technology regime risk-off (QQQ below its 200-day average); no new names';
    else if (st.cooldown[r.symbol]) why = `WAIT_COOLDOWN: stopped out recently; ${st.cooldown[r.symbol]} sessions left`;
    else if (!(r.f.adj > r.f.sma50)) why = 'WAIT: below its 50-day average (no short-term uptrend)';
    else if (r.f.ret1 <= M.brokenDayDrop) why = `WAIT: ${(r.f.ret1 * 100).toFixed(1)}% one-day drop treated as a possible broken thesis`;
    if (why) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: why }); continue; }
    qualified.push(r);
  }
  if (slots <= 0 && qualified.length) {
    const best = qualified[0];
    const weakest = heldAfter.filter((s) => !trimmed.has(s)).map((s) => byS.get(s)).filter(Boolean).sort((a, b) => b.rank - a.rank)[0];
    if (best.rank <= M.rotateCandidateMaxRank && weakest && weakest.rank > M.rotateWeakestMinRank && Math.min(target, budget + valueOf(weakest.symbol)) >= M.minTradeCents) {
      order({ side: 'SELL', symbol: weakest.symbol, ticker: weakest.ticker, qty: st.positions[weakest.symbol].qty, full: true, reason: `ROTATE_OUT: rank ${weakest.rank} replaced by rank ${best.rank} ${best.symbol}`, rank: weakest.rank, score: weakest.score });
      budget += valueOf(weakest.symbol);
      const amt = Math.min(target, budget);
      order({ side: 'BUY', symbol: best.symbol, ticker: best.ticker, sector: best.sector, targetCents: amt, reason: `ROTATE_IN: rank ${best.rank}, momentum leader in an uptrend`, rank: best.rank, score: best.score });
      budget -= amt; buys++; qualified.shift();
    }
  }
  for (const r of qualified) {
    if (slots <= 0) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: 'ROTATION_CANDIDATE: all 8 slots held and the rotation hurdle is not met' }); continue; }
    if (buys >= M.maxNewBuysPerSession) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: `WAIT: ${M.maxNewBuysPerSession} new names per session` }); continue; }
    const amt = Math.min(target, budget);
    if (amt < M.minTradeCents) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: 'WAIT_CASH: not enough cash for a minimum order' }); continue; }
    order({ side: 'BUY', symbol: r.symbol, ticker: r.ticker, sector: r.sector, targetCents: amt, reason: `BUY MOMENTUM_ENTRY: rank ${r.rank}, above its 50-day average`, rank: r.rank, score: r.score });
    budget -= amt; slots--; buys++;
  }
  st.pending = orders;
  return { orders, decisions };
}

// ---------------- DIVERSIFIED manager ----------------
// metals: [{ symbol, verified, f (arenaFeatures or {eligible:false}) }] from the metal ETF registry.
export function exposures(st, m) {
  const nav = m.navCents; const sectors = {}; let metals = 0; const holdings = {};
  for (const x of m.positions) {
    const pos = st.positions[x.symbol]; const w = nav > 0 ? x.valueCents / nav : 0;
    holdings[x.symbol] = w;
    if (pos?.kind === 'METAL_ETF') metals += w; else { const s = pos?.sector || 'UNCLASSIFIED'; sectors[s] = (sectors[s] || 0) + w; }
  }
  return { nav, sectors, metals, holdings, cash: nav > 0 ? st.cashCents / nav : 1 };
}

export function decideDiversified(st, D, snap, metals, { regime, prepared, m }) {
  const M = DIVERSIFIED.manager;
  tickCooldowns(st); st.eodSessions += 1;
  if (!regime.reason) st.riskOffStreak = regime.riskOn ? 0 : st.riskOffStreak + 1;
  const { nav, valueOf, orders, decisions, order, decision } = common(st, D, m);
  const byS = new Map(snap.ranks.map((r) => [r.symbol, r]));
  const metalBy = new Map(metals.map((x) => [x.symbol, x]));
  const exiting = new Set(); const sellQty = {};
  const closeOf = (sym) => { const p = prepared.get(sym); const i = p?.idx.get(D); return i == null ? null : p.c[i]; };

  // 1. exits
  for (const [sym, pos] of Object.entries(st.positions)) {
    const p = prepared.get(sym); const i = p?.idx.get(D);
    if (i == null) { decision({ action: 'HOLD', symbol: sym, reason: 'NO_BAR_TODAY: no observed close; no decision on missing data' }); continue; }
    pos.peakAdj = Math.max(pos.peakAdj || 0, p.adj[i]);
    const s200 = i >= 199 ? sma(p, i, 200) : null;
    let why = null, cool = false; let r = null;
    if (pos.kind === 'METAL_ETF') {
      const mt = metalBy.get(sym);
      if (!mt || !mt.verified) why = 'METAL_UNVERIFIED: instrument no longer passes the ETF identity/source registry';
      else if (s200 != null && p.adj[i] < s200) { why = 'METAL_TREND_EXIT: ETF below its 200-day average'; cool = true; }
      else if (p.adj[i] / pos.peakAdj - 1 <= M.trailingStop) { why = `TRAILING_STOP: ${((p.adj[i] / pos.peakAdj - 1) * 100).toFixed(1)}% from peak`; cool = true; }
    } else {
      r = byS.get(sym);
      if (!r) why = 'NOT_RANKED: left the universe or failed eligibility';
      else if (r.rank > M.exitRank) why = `RANK_EXIT: rank ${r.rank} > ${M.exitRank}`;
      else if (M.exitBelowSma200 && s200 != null && p.adj[i] < s200) { why = 'TREND_EXIT: below its 200-day average'; cool = true; }
      else if (p.adj[i] / pos.peakAdj - 1 <= M.trailingStop) { why = `TRAILING_STOP: ${((p.adj[i] / pos.peakAdj - 1) * 100).toFixed(1)}% from peak`; cool = true; }
    }
    if (why) {
      exiting.add(sym); if (cool) st.cooldown[sym] = M.cooldownSessions; sellQty[sym] = { qty: pos.qty, full: true, reason: why, rank: r?.rank ?? null, score: r?.score ?? null };
    }
  }

  // 2. post-drift cap enforcement on what remains AFTER the exits above (review fix: exiting positions no longer count
  // toward a sector or the metals sleeve, so they never trigger trims of the holdings that stay)
  const keep = Object.keys(st.positions).filter((s) => !exiting.has(s) && closeOf(s) != null);
  const ex = exposures(st, { ...m, positions: m.positions.filter((x) => keep.includes(x.symbol)) });
  const noted = new Set();
  const trim = (sym, valueToSell, why) => {
    const px = closeOf(sym); const pos = st.positions[sym];
    const qty = Math.min(pos.qty, Math.ceil(valueToSell / (px * 100)));
    if (qty <= 0) return;
    if (qty * px * 100 < M.minTradeCents) { if (!noted.has(sym)) decision({ action: 'HOLD', symbol: sym, reason: `CAP_DRIFT_BELOW_MIN_ORDER: ${why} (excess under the $100 minimum order)` }); noted.add(sym); return; }
    if (!sellQty[sym] || sellQty[sym].qty < qty) sellQty[sym] = { qty, reason: why };
  };
  for (const sym of keep) {
    const w = ex.holdings[sym] || 0;
    if (w > M.maxHoldingWeight) trim(sym, valueOf(sym) - M.trimHoldingTo * nav, `CAP_HOLDING: ${(w * 100).toFixed(1)}% > ${M.maxHoldingWeight * 100}% -> ${M.trimHoldingTo * 100}%`);
  }
  for (const [sector, w] of Object.entries(ex.sectors)) {
    if (w <= M.maxSectorWeight) continue;
    let excess = (w - M.trimSectorTo) * nav;
    const inSector = keep.filter((s) => st.positions[s].kind !== 'METAL_ETF' && (st.positions[s].sector || 'UNCLASSIFIED') === sector).sort((a, b) => valueOf(b) - valueOf(a) || (a < b ? -1 : 1));
    for (const sym of inSector) { if (excess <= 0) break; const take = Math.min(excess, valueOf(sym)); trim(sym, take, `CAP_SECTOR: ${sector} ${(w * 100).toFixed(1)}% > ${M.maxSectorWeight * 100}% -> ${M.trimSectorTo * 100}%`); excess -= take; }
  }
  if (ex.metals > M.maxMetalsWeight) {
    const scale = 1 - M.trimMetalsTo / ex.metals;
    for (const sym of keep.filter((s) => st.positions[s].kind === 'METAL_ETF')) trim(sym, valueOf(sym) * scale, `CAP_METALS: precious-metal ETFs ${(ex.metals * 100).toFixed(1)}% > ${M.maxMetalsWeight * 100}% -> ${M.trimMetalsTo * 100}%`);
  }
  for (const [sym, s] of Object.entries(sellQty).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const pos = st.positions[sym];
    order({ side: 'SELL', symbol: sym, ticker: pos.ticker, qty: s.qty, ...(s.full || s.qty >= pos.qty ? { full: true } : {}), reason: s.reason, rank: s.rank ?? byS.get(sym)?.rank ?? null, score: s.score ?? byS.get(sym)?.score ?? null });
  }
  for (const sym of keep) if (!sellQty[sym] && !noted.has(sym)) { const r = byS.get(sym); decision({ action: 'HOLD', symbol: sym, rank: r?.rank ?? null, score: r?.score ?? null, reason: st.positions[sym].kind === 'METAL_ETF' ? 'HOLD: metal ETF trend intact' : `HOLD: rank ${r?.rank} inside the ${M.exitRank} exit band and above its 200-day average` }); }

  // 3. projected book after sells (valued at today's close)
  const projVal = {};
  for (const sym of Object.keys(st.positions)) {
    const px = closeOf(sym); const pos = st.positions[sym];
    const q = pos.qty - (sellQty[sym]?.qty || 0);
    projVal[sym] = px == null ? valueOf(sym) : Math.max(0, q) * px * 100;
  }
  const sectorW = {}; let metalsW = 0; let equities = 0; const sectorNames = {};
  for (const [sym, v] of Object.entries(projVal)) {
    if (v <= 0) continue; const pos = st.positions[sym];
    if (pos.kind === 'METAL_ETF') metalsW += v / nav;
    else { const s = pos.sector || 'UNCLASSIFIED'; sectorW[s] = (sectorW[s] || 0) + v / nav; sectorNames[s] = (sectorNames[s] || 0) + 1; equities++; }
  }
  let budget = st.cashCents + Object.entries(sellQty).reduce((s, [sym, x]) => s + (closeOf(sym) || 0) * x.qty * 100, 0);
  let buys = 0;
  const sizeOf = (f) => Math.min(M.maxHoldingWeight, M.volBudget / Math.max(f.vol63, 1e-6));

  // 4a. equity entries
  for (const r of snap.ranks.slice(0, M.entryMaxRank)) {
    if (st.positions[r.symbol]) continue;
    const s = r.sector || 'UNCLASSIFIED';
    let why = null;
    if (regime.reason) why = `WAIT: market regime unavailable (${regime.reason}); no new equity names on missing data`;
    else if (!regime.riskOn) why = 'WAIT: market regime risk-off (SPY below its 200-day average); no new equity names';
    else if (st.cooldown[r.symbol]) why = `WAIT_COOLDOWN: exited on a stop or trend break; ${st.cooldown[r.symbol]} sessions left`;
    else if (!(r.f.adj > r.f.sma200)) why = 'WAIT: below its 200-day average';
    else if (r.f.ret1 <= M.brokenDayDrop) why = `WAIT: ${(r.f.ret1 * 100).toFixed(1)}% one-day drop treated as a possible broken thesis`;
    else if (equities >= M.maxEquityPositions) why = `WAIT: ${M.maxEquityPositions} equity holdings already`;
    else if ((sectorNames[s] || 0) >= M.maxNamesPerSector) why = `WAIT_SECTOR_LIMIT: ${M.maxNamesPerSector} names already in ${s}`;
    else if (buys >= M.maxNewBuysPerSession) why = `WAIT: ${M.maxNewBuysPerSession} new names per session`;
    let w = 0;
    if (!why) {
      w = Math.min(sizeOf(r.f), M.maxSectorWeight - (sectorW[s] || 0));
      if (w * nav < M.minTradeCents) why = `WAIT_SECTOR_CAP: ${s} at ${((sectorW[s] || 0) * 100).toFixed(1)}% of the ${M.maxSectorWeight * 100}% cap`;
    }
    if (!why) { w = Math.min(w, budget / nav); if (w * nav < M.minTradeCents) why = 'WAIT_CASH: not enough cash for a minimum order'; }
    if (why) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: why }); continue; }
    const amt = Math.floor(w * nav);
    order({ side: 'BUY', symbol: r.symbol, ticker: r.ticker, sector: s, kind: 'EQUITY', targetCents: amt, reason: `BUY RISK_BUDGET_ENTRY: rank ${r.rank}, inverse-volatility weight ${(w * 100).toFixed(1)}% (63-day vol ${(r.f.vol63 * 100).toFixed(0)}%)`, rank: r.rank, score: r.score });
    budget -= amt; buys++; equities++; sectorW[s] = (sectorW[s] || 0) + w; sectorNames[s] = (sectorNames[s] || 0) + 1;
  }
  // 4b. precious-metal ETF sleeve (allowed in either regime; cash when unverified or the rule does not qualify)
  for (const mt of metals) {
    if (st.positions[mt.symbol]) continue;
    let why = null;
    if (!mt.verified) why = `METAL_SLEEVE_HOLD: ${mt.symbol} not verified in the ETF registry (${mt.hold || 'source/identity pending'})`;
    else if (!mt.f?.eligible) why = `WAIT: ${mt.symbol} ineligible (${mt.f?.reason || 'no data'})`;
    else if (st.cooldown[mt.symbol]) why = `WAIT_COOLDOWN: ${st.cooldown[mt.symbol]} sessions left`;
    else if (!(mt.f.adj > mt.f.sma200 && mt.f.mom6 > 0)) why = 'WAIT: metal ETF not in an uptrend (needs adj > SMA200 and positive 6-month momentum)';
    else if (buys >= M.maxNewBuysPerSession) why = `WAIT: ${M.maxNewBuysPerSession} new names per session`;
    let w = 0;
    if (!why) { w = Math.min(sizeOf(mt.f), M.maxMetalsWeight - metalsW, budget / nav); if (w * nav < M.minTradeCents) why = metalsW >= M.maxMetalsWeight - 1e-9 ? 'WAIT_METALS_CAP: sleeve at its 20% cap' : 'WAIT_CASH: not enough cash for a minimum order'; }
    if (why) { decision({ action: 'WAIT', symbol: mt.symbol, reason: why }); continue; }
    const amt = Math.floor(w * nav);
    order({ side: 'BUY', symbol: mt.symbol, ticker: mt.symbol, sector: 'PRECIOUS_METALS', kind: 'METAL_ETF', targetCents: amt, reason: `BUY METAL_SLEEVE_ENTRY: ${mt.symbol} above its 200-day average with positive 6-month momentum, weight ${(w * 100).toFixed(1)}%` });
    budget -= amt; buys++; metalsW += w;
  }
  st.pending = orders;
  return { orders, decisions };
}

export { mark, delistings };
