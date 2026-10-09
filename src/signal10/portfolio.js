// Signal 10 portfolio manager + paper-account accounting (pure, deterministic, Worker-safe).
// Money is integer CENTS. Share quantities are whole shares (cash-in-lieu on fractional reverse-split results).
// NAV = cash + sum(qty x observed unadjusted close). Every state change emits an append-only ledger event.
import { MANAGER, POLICY_VERSION, MODEL_VERSION } from './policy.js';

const cents = (x) => Math.round(x * 100);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function newAccount({ origin, inception, policy = POLICY_VERSION, slippageBps = MANAGER.slippageBps }) {
  if (origin !== 'HISTORICAL_REPLAY' && origin !== 'FORWARD_PAPER' && !/^COMPARATOR_|^BENCHMARK_/.test(origin)) throw new Error('bad origin');
  const st = {
    origin, policy, model: MODEL_VERSION, inception, slippageBps, cashCents: MANAGER.startingCashCents, positions: {},
    realizedCents: 0, dividendsCents: 0, slippageCents: 0, tradedCents: 0, fillSessions: 0, streak: {}, pending: [], seq: 0, events: []
  };
  emit(st, { type: 'FUNDING', d: inception, cashCents: MANAGER.startingCashCents, note: '$10,000.00 simulated cash. No real money.' });
  return st;
}

export function emit(st, ev) { st.seq += 1; const e = { seq: st.seq, origin: st.origin, ...ev }; st.events.push(e); return e; }

// --- corporate actions at the start of session d (before the open) ----------------------------------------------
export function corporateActions(st, d, prepared) {
  for (const [sym, pos] of Object.entries(st.positions)) {
    const p = prepared.get(sym); if (!p) continue;
    for (const s of p.splits) if (s.d === d) {
      const newQty = pos.qty * s.ratio;
      const whole = Math.floor(newQty + 1e-9);
      let lieu = 0;
      if (newQty - whole > 1e-9) { const i = p.idx.get(d); lieu = i == null ? 0 : cents((newQty - whole) * p.o[i]); st.cashCents += lieu; }
      emit(st, { type: 'SPLIT', d, symbol: sym, ratio: s.ratio, qtyBefore: pos.qty, qtyAfter: whole, cashInLieuCents: lieu });
      pos.qty = whole;
      if (!whole) { st.realizedCents += lieu - pos.costCents; delete st.positions[sym]; }
    }
    for (const dv of p.dividends) if (dv.d === d && st.positions[sym]) {
      const amt = cents(pos.qty * dv.amount);
      st.cashCents += amt; st.dividendsCents += amt; pos.dividendsCents = (pos.dividendsCents || 0) + amt;
      emit(st, { type: 'DIVIDEND', d, symbol: sym, perShare: dv.amount, qty: pos.qty, cashCents: amt, basis: 'credited on ex-date (source has no pay date)' });
    }
  }
}

// A held symbol whose source series has ended (no bar for >= N sessions and no later bars): liquidate at last close.
export function delistings(st, d, calIndex, prepared) {
  for (const [sym, pos] of Object.entries(st.positions)) {
    const p = prepared.get(sym);
    const lastD = p.d[p.n - 1];
    if (lastD >= d) continue;
    if (calIndex.get(d) - calIndex.get(lastD) < MANAGER.delistAfterMissingSessions) continue;
    const px = p.c[p.n - 1];
    const proceeds = cents(pos.qty * px);
    st.cashCents += proceeds; st.realizedCents += proceeds - pos.costCents;
    emit(st, { type: 'DELIST_LIQUIDATION', d, symbol: sym, qty: pos.qty, price: px, priceDate: lastD, proceedsCents: proceeds,
      realizedCents: proceeds - pos.costCents, flag: 'ESTIMATE: source series ended; valued at last observed close' });
    delete st.positions[sym];
  }
}

// --- execution at the OPEN of session d: sells first, then buys in priority order ---------------------------------
export function execute(st, d, prepared) {
  const orders = st.pending; st.pending = [];
  if (!orders.length) return [];
  const fills = [];
  const slip = st.slippageBps / 1e4;
  const sorted = [...orders.filter((o) => o.side === 'SELL'), ...orders.filter((o) => o.side === 'BUY')];
  for (const o of sorted) {
    const p = prepared.get(o.symbol);
    const i = p ? p.idx.get(d) : undefined;
    if (i == null || !(p.o[i] > 0)) { emit(st, { type: 'ORDER_EXPIRED', d, symbol: o.symbol, side: o.side, reason: 'no_regular_session_open_observed', orderSeq: o.seq }); continue; }
    const open = p.o[i];
    if (o.side === 'SELL') {
      const pos = st.positions[o.symbol]; if (!pos) continue;
      const qty = Math.min(pos.qty, o.qty ?? pos.qty);
      const px = r4(open * (1 - slip));
      const proceeds = cents(qty * px);
      const costPart = Math.round(pos.costCents * qty / pos.qty);
      st.cashCents += proceeds; st.realizedCents += proceeds - costPart;
      st.slippageCents += cents(qty * (open - px)); st.tradedCents += proceeds;
      pos.qty -= qty; pos.costCents -= costPart;
      const f = emit(st, { type: 'FILL', d, side: 'SELL', symbol: o.symbol, qty, open, price: px, notionalCents: proceeds,
        realizedCents: proceeds - costPart, reason: o.reason, orderSeq: o.seq, priceBasis: 'regular-session open, unadjusted' });
      fills.push(f);
      if (!pos.qty) delete st.positions[o.symbol];
    } else {
      const px = r4(open * (1 + slip));
      const budget = Math.min(o.targetCents, st.cashCents);
      const qty = Math.floor(budget / (px * 100) + 1e-9);
      const notional = cents(qty * px);
      if (qty < 1 || notional < MANAGER.minTradeCents || notional > st.cashCents) {
        emit(st, { type: 'ORDER_UNFILLED', d, symbol: o.symbol, side: 'BUY', reason: 'insufficient_cash_for_minimum_whole_share_order', cashCents: st.cashCents, orderSeq: o.seq });
        continue;
      }
      st.cashCents -= notional; st.slippageCents += cents(qty * (px - open)); st.tradedCents += notional;
      const pos = st.positions[o.symbol] || (st.positions[o.symbol] = { qty: 0, costCents: 0, entryDate: d, peakAdj: p.adj[i], ticker: o.ticker, name: p.name });
      pos.qty += qty; pos.costCents += notional;
      const f = emit(st, { type: 'FILL', d, side: 'BUY', symbol: o.symbol, qty, open, price: px, notionalCents: notional, reason: o.reason, orderSeq: o.seq, priceBasis: 'regular-session open, unadjusted' });
      fills.push(f);
    }
    if (st.cashCents < 0) throw new Error(`negative cash after ${o.side} ${o.symbol} on ${d}`);
  }
  return fills;
}

// --- end-of-day mark --------------------------------------------------------------------------------------------
export function mark(st, d, prepared) {
  let mv = 0; const stale = [];
  const rows = [];
  for (const [sym, pos] of Object.entries(st.positions)) {
    const p = prepared.get(sym);
    let i = p.idx.get(d);
    if (i == null) { // last observed close at or before d (flagged)
      let k = p.n - 1; while (k >= 0 && p.d[k] > d) k--; i = k; stale.push(sym);
    }
    const v = cents(pos.qty * p.c[i]);
    mv += v;
    rows.push({ symbol: sym, qty: pos.qty, close: p.c[i], closeDate: p.d[i], valueCents: v, costCents: pos.costCents });
  }
  const navCents = st.cashCents + mv;
  return { d, navCents, cashCents: st.cashCents, marketValueCents: mv, positions: rows, stale };
}

// --- decision at the close of D -> orders for the next session open ---------------------------------------------
// snap = rankUniverse(...) result, regime = { riskOn, spyAdj, spySma200 }, m = mark(st, D)
export function decide(st, D, snap, regime, m, prepared, { mode = 'MANAGER', variant = {} } = {}) {
  const byS = new Map(snap.ranks.map((r) => [r.symbol, r]));
  const top = snap.ranks.slice(0, MANAGER.entryMaxRank);
  const topSet = new Set(top.map((r) => r.symbol));
  // persistence streaks (consecutive closes in the top 10)
  const streak = {};
  for (const r of top) streak[r.symbol] = (st.streak[r.symbol] || 0) + 1;
  st.streak = streak;
  const nav = m.navCents;
  const orders = [], decisions = [];
  const order = (o) => { const e = emit(st, { type: 'ORDER', d: D, ...o, executeAt: 'next regular-session open' }); orders.push(e); return e; };
  const decision = (x) => decisions.push(emit(st, { type: 'DECISION', d: D, ...x }));
  const exiting = new Set();
  const valueOf = (sym) => (m.positions.find((x) => x.symbol === sym)?.valueCents) || 0;

  // exits / trims
  for (const [sym, pos] of Object.entries(st.positions)) {
    const p = prepared.get(sym); const i = p.idx.get(D);
    if (i == null) { decision({ action: 'HOLD', symbol: sym, reason: 'NO_BAR_TODAY: no observed close; no decision on missing data' }); continue; }
    pos.peakAdj = Math.max(pos.peakAdj || 0, p.adj[i]);
    const r = byS.get(sym);
    const value = valueOf(sym);
    const pnl = value / pos.costCents - 1;
    let why = null;
    if (!r) why = 'NOT_RANKED: left the index or failed eligibility';
    else if (r.rank > MANAGER.exitRank) why = `RANK_EXIT: rank ${r.rank} > ${MANAGER.exitRank}`;
    else if (mode === 'MANAGER' && !variant.noStops && p.adj[i] / pos.peakAdj - 1 <= MANAGER.trailingStop) why = `TRAILING_STOP: ${((p.adj[i] / pos.peakAdj - 1) * 100).toFixed(1)}% from peak`;
    else if (mode === 'MANAGER' && !variant.noStops && pnl <= MANAGER.stopLoss && r.f.adj < r.f.sma50) why = `STOP_LOSS: ${(pnl * 100).toFixed(1)}% vs cost and below SMA50`;
    if (why) { exiting.add(sym); order({ side: 'SELL', symbol: sym, ticker: pos.ticker, qty: pos.qty, reason: why, rank: r?.rank ?? null, score: r?.score ?? null }); continue; }
    if (mode === 'MANAGER' && value / nav > MANAGER.trimAboveWeight) {
      const qty = Math.ceil((value - MANAGER.trimToWeight * nav) / (p.c[i] * 100));
      if (qty > 0 && qty < pos.qty) { order({ side: 'SELL', symbol: sym, ticker: pos.ticker, qty, reason: `TRIM: weight ${(value / nav * 100).toFixed(1)}% > ${MANAGER.trimAboveWeight * 100}%`, rank: r.rank, score: r.score }); continue; }
    }
    decision({ action: 'HOLD', symbol: sym, rank: r.rank, score: r.score, reason: topSet.has(sym) ? 'HOLD: still top 10' : `HOLD: rank ${r.rank} inside the ${MANAGER.exitRank} exit band` });
  }

  const heldAfter = Object.keys(st.positions).filter((s) => !exiting.has(s));
  let slots = MANAGER.maxPositions - heldAfter.length;
  let buys = 0;
  const maxBuys = mode === 'MANAGER' ? MANAGER.maxNewBuysPerSession : Infinity;
  const target = Math.round(MANAGER.targetWeight * nav);
  const expectedCash = st.cashCents + [...exiting].reduce((s, sym) => s + valueOf(sym), 0);
  let budget = expectedCash;

  const qualifies = (r) => {
    if (mode !== 'MANAGER') return { ok: true, trigger: 'IMMEDIATE (comparator)' };
    if (!regime.riskOn && !variant.noRegime) return { ok: false, why: 'WAIT: market regime risk-off (SPY below its 200-day average); no new names' };
    if (!r.f.uptrend) return { ok: false, why: 'WAIT: not in an uptrend (needs close > SMA50 > SMA200)' };
    if (r.f.ret1 <= MANAGER.brokenDayDrop) return { ok: false, why: `WAIT: ${(r.f.ret1 * 100).toFixed(1)}% one-day drop treated as possible broken thesis, not a dip` };
    if (r.f.pullback10 <= MANAGER.dipFrom10dHigh) return { ok: true, trigger: `DIP_ENTRY: ${(r.f.pullback10 * 100).toFixed(1)}% below 10-day high, trend intact` };
    if ((st.streak[r.symbol] || 0) >= MANAGER.persistenceSessions) return { ok: true, trigger: `PERSISTENCE_ENTRY: top 10 for ${st.streak[r.symbol]} consecutive closes` };
    return { ok: false, why: `WAIT: no entry setup (${(r.f.pullback10 * 100).toFixed(1)}% from 10-day high, top-10 streak ${st.streak[r.symbol] || 0}/${MANAGER.persistenceSessions})` };
  };

  const candidates = top.filter((r) => !st.positions[r.symbol]);
  const qualified = [];
  for (const r of candidates) {
    const q = qualifies(r);
    if (!q.ok) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: q.why }); continue; }
    qualified.push({ r, q });
  }
  // rotation: slots full, a qualified top-3 name vs the weakest holding
  if (mode === 'MANAGER' && slots <= 0 && qualified.length) {
    const best = qualified[0];
    const weakest = heldAfter.map((s) => byS.get(s)).filter(Boolean).sort((a, b) => b.rank - a.rank)[0];
    if (best.r.rank <= MANAGER.rotateCandidateMaxRank && weakest && weakest.rank > MANAGER.rotateWeakestMinRank && best.r.score - weakest.score >= MANAGER.rotateMinScoreGap) {
      order({ side: 'SELL', symbol: weakest.symbol, ticker: weakest.ticker, qty: st.positions[weakest.symbol].qty, reason: `ROTATE_OUT: rank ${weakest.rank} (score ${weakest.score}) replaced by rank ${best.r.rank} ${best.r.symbol} (score ${best.r.score})`, rank: weakest.rank, score: weakest.score });
      budget += valueOf(weakest.symbol);
      order({ side: 'BUY', symbol: best.r.symbol, ticker: best.r.ticker, targetCents: Math.min(target, budget), reason: `ROTATE_IN: ${best.q.trigger}`, rank: best.r.rank, score: best.r.score });
      budget -= Math.min(target, budget); buys++;
      qualified.shift();
    }
  }
  for (const { r, q } of qualified) {
    if (slots <= 0) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: 'ROTATION_CANDIDATE: qualifies but all 10 slots are held and the rotation hurdle is not met' }); continue; }
    if (buys >= maxBuys) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: `WAIT: staged entry limit (${maxBuys} new names per session)` }); continue; }
    const amt = Math.min(target, budget);
    if (amt < MANAGER.minTradeCents) { decision({ action: 'WAIT', symbol: r.symbol, rank: r.rank, score: r.score, reason: 'WAIT_CASH: not enough cash for a minimum order' }); continue; }
    order({ side: 'BUY', symbol: r.symbol, ticker: r.ticker, targetCents: amt, reason: `BUY ${q.trigger}`, rank: r.rank, score: r.score });
    budget -= amt; slots--; buys++;
  }
  // adds: an underweight top-10 holding on a qualified dip
  if (mode === 'MANAGER' && (regime.riskOn || variant.noRegime)) for (const sym of heldAfter) {
    const r = byS.get(sym); if (!r || r.rank > MANAGER.entryMaxRank || buys >= maxBuys) continue;
    const w = valueOf(sym) / nav;
    if (w >= MANAGER.addBelowWeight || !r.f.uptrend || r.f.ret1 <= MANAGER.brokenDayDrop || r.f.pullback10 > MANAGER.dipFrom10dHigh) continue;
    const amt = Math.min(target - valueOf(sym), budget);
    if (amt < MANAGER.minTradeCents) continue;
    order({ side: 'BUY', symbol: sym, ticker: r.ticker, targetCents: amt, reason: `ADD: weight ${(w * 100).toFixed(1)}% < ${MANAGER.addBelowWeight * 100}% on a ${(r.f.pullback10 * 100).toFixed(1)}% dip`, rank: r.rank, score: r.score });
    budget -= amt; buys++;
  }
  st.pending = orders;
  return { orders, decisions };
}
