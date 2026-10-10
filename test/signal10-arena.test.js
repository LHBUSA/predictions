// Signal 10 Strategy Arena (issue #62): control untouched, challengers isolated, preregistration frozen, caps enforced,
// ledgers verifiable, fail-closed source handling, no writes before T0, idempotent + concurrent-safe runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FakeStore, fakeSource, CAL, priceAt } from './helpers/s10-fakes.js';
import { LATEST_MEMBERS } from '../src/signal10/members-latest.js';
import { TECH, DIVERSIFIED, CHALLENGERS, STARTING_CASH_CENTS } from '../src/signal10/arena/policies.js';
import { runArenaEod, runArenaOpen, loadHead, verifyChain, policyHash, universes, restore, arenaDue, T } from '../src/signal10/arena/forward.js';
import { rankStrategy, decideDiversified, decideTech, exposures, newChallenger, prepareSeries } from '../src/signal10/arena/engine.js';
import { sectorOfSic, isTechSic, TAXONOMY_VERSION } from '../src/signal10/arena/taxonomy.js';
import { METAL_ETFS, etfEligibility, SPOT, SPOT_HOLD } from '../src/market-tape/metals.js';
import CLASSIFICATION from '../data/signal10/arena/classification.json' with { type: 'json' };

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------------- 1. the ORIGINAL / CONTROL is byte-for-byte the deployed V1 ----------------
// Captured from main (58f24a7..8857bda) on 2026-10-10. Any byte change to the control fails here: a control change is a
// new version with owner approval, never a side effect of challenger work.
const V1_GOLDEN = {
  'src/signal10/policy.js': '747adcde9094e6db691da4fe5745aca285e894736cfa385e9bd3764dad9ae232',
  'src/signal10/rank.js': '16d329262a39cdd6c62415919e1b57b099060225480411c658e33c537570a836',
  'src/signal10/portfolio.js': 'bc475f4d41365649d2554af5e54ab8f59296c51b0448ed12ca77432bb97e6c96',
  // src/signal10/forward.js (the V1 state/ledger writer) is pinned by its own versioned writer tests (#69, PR #71);
  // the V1 investment algorithm is policy.js + rank.js + portfolio.js and the data layer below.
  'src/signal10/data.js': '6969e6a9c94a05a247837e2b501227db04eee810dc45472fadf0b324da1f35c9',
  'src/signal10/universe.js': '82c258da9dd4de2476e13b9315dd69fbd3cbbb3c7bcd4be696e1e0c0027e91ed',
  'src/signal10/aliases.js': '4a23301e8f3deff157d8c10696381df376fc70c90196444bf7bac3390569bee4',
  'src/signal10/members-latest.js': '18747f8aed3c3416964b76ad393d1f77b2c3017e774359ad3da704b510c103d1',
  'sql/016_signal10_forward.sql': '6301cc1a2adb85c8a8a9e5530395762c8e39459e1ca20ecaca493278fa8a3b23',
};
test('CONTROL: every V1 engine file and the V1 schema are byte-identical to the deployed version', () => {
  for (const [f, h] of Object.entries(V1_GOLDEN)) assert.equal(sha(read(f)), h, `${f} changed — the Original/Control must stay untouched`);
});

test('CONTROL: arena code never references the control account, its tables or its kill switch for writing', () => {
  for (const f of ['src/signal10/arena/forward.js', 'src/signal10/arena/engine.js', 'src/signal10/arena/policies.js']) {
    const src = read(f).toString();
    assert.doesNotMatch(src, /['"`]pred_s10_(runs|events|snapshots|marks)['"`]/, `${f} names a control table`);
    assert.doesNotMatch(src, /S10-FWD-1/, `${f} names the control account`);
    assert.doesNotMatch(src, /env\.SIGNAL10\b(?!_ARENA)/, `${f} reads the control kill switch`);
  }
});

// ---------------- 2. preregistration is frozen and matches the document ----------------
test('PREREGISTRATION.md carries the exact policy hashes, versions and classification snapshot hash', async () => {
  const doc = read('docs/signal10/strategy-arena/PREREGISTRATION.md').toString();
  for (const S of CHALLENGERS) {
    assert.ok(doc.includes(await policyHash(S)), `${S.strategy} policy sha256 recorded`);
    assert.ok(doc.includes(S.model) && doc.includes(S.policy) && doc.includes(S.account));
  }
  assert.ok(doc.includes(CLASSIFICATION.content_sha256));
  assert.ok(doc.includes(TAXONOMY_VERSION));
});

test('ORIGINAL is the V1 algorithm itself (imported objects, not a copy) on a brand-new account', async () => {
  const V1 = await import('../src/signal10/policy.js');
  const { ORIGINAL } = await import('../src/signal10/arena/policies.js');
  assert.equal(ORIGINAL.rank, V1.RANK, 'same object'); assert.equal(ORIGINAL.manager, V1.MANAGER, 'same object');
  assert.equal(ORIGINAL.model, V1.MODEL_VERSION); assert.equal(ORIGINAL.policy, V1.POLICY_VERSION);
  assert.equal(ORIGINAL.account, 'S10-ARENA-ORIG-1'); assert.notEqual(ORIGINAL.account, 'S10-FWD-1');
});

test('ORIGINAL decides exactly like the legacy V1 lane on identical inputs (every ORDER and DECISION over 8 sessions)', async () => {
  const { runEod: v1Eod, runOpen: v1Open } = await import('../src/signal10/forward.js');
  const { ORIGINAL } = await import('../src/signal10/arena/policies.js');
  const SH = { QQQ: { from: 400, factor: 1.3 }, SPY: { from: 400, factor: 1.3 } };
  const v1Store = new FakeStore(); const arStore = new FakeStore();
  const days = CAL.filter((d) => d >= D0).slice(0, 8);
  for (const [k, d] of days.entries()) {
    const at = (t) => fakeSource({ today: d, at: `${d}T${t}`, shock: SH });
    if (k) { await v1Open({ store: v1Store, now: `${d}T13:50:00Z`, fetchImpl: at('13:50:00Z') }); await runArenaOpen({ store: arStore, now: `${d}T13:50:00Z`, fetchImpl: at('13:50:00Z'), t0: D0 }); }
    await v1Eod({ store: v1Store, now: `${d}T20:25:00Z`, fetchImpl: at('20:00:00Z'), startDate: D0 });
    await runArenaEod({ store: arStore, now: eodAt(d), fetchImpl: at('20:00:00Z'), t0: D0, classification: FIX_CLS });
  }
  const pick = (rows) => rows.filter((e) => ['ORDER', 'DECISION', 'FILL'].includes(e.type)).map((e) => ({ d: e.d, type: e.type, side: e.payload.side ?? null, action: e.payload.action ?? null, symbol: e.payload.symbol, qty: e.type === 'FILL' ? e.payload.qty : null, targetCents: e.payload.targetCents ?? null, reason: e.payload.reason ?? null }));
  const v1 = pick(v1Store.rows('pred_s10_events').sort((a, b) => a.seq - b.seq));
  const ar = pick(await events(arStore, ORIGINAL.account));
  assert.ok(v1.filter((x) => x.type === 'FILL').length >= 1, 'fixture: V1 trades within 8 sessions');
  assert.deepEqual(ar, v1);
});

test('TECH and DIVERSIFIED are genuinely distinct algorithms (not relabelled copies of the V1 rules)', async () => {
  const { RANK: V1R, MANAGER: V1M } = await import('../src/signal10/policy.js');
  assert.notDeepEqual(Object.keys(TECH.rank.weights).sort(), Object.keys(V1R.weights).sort());
  assert.notDeepEqual(Object.keys(DIVERSIFIED.rank.weights).sort(), Object.keys(V1R.weights).sort());
  assert.ok(!('lowVol63' in TECH.rank.weights), 'Tech has no low-volatility tilt');
  assert.notEqual(TECH.manager.maxPositions, V1M.maxPositions);
  assert.equal(TECH.manager.regimeSymbol, 'QQQ');
  assert.equal(DIVERSIFIED.manager.maxHoldingWeight, 0.10);
  assert.equal(DIVERSIFIED.manager.maxSectorWeight, 0.25);
  assert.equal(DIVERSIFIED.manager.maxMetalsWeight, 0.20);
  assert.notEqual(await policyHash(TECH), await policyHash(DIVERSIFIED));
  assert.equal(new Set(CHALLENGERS.map((S) => S.account)).size, 3);
  assert.equal(new Set(await Promise.all(CHALLENGERS.map((S) => policyHash(S)))).size, 3);
});

// ---------------- 3. taxonomy + classification snapshot ----------------
test('SEC SIC taxonomy: technology ranges, sector rules, unknowns are UNCLASSIFIED', () => {
  assert.equal(sectorOfSic('3674'), 'TECHNOLOGY'); assert.ok(isTechSic('7372')); assert.ok(isTechSic('3559'));
  assert.equal(sectorOfSic('2834'), 'HEALTH_CARE'); assert.equal(sectorOfSic('6021'), 'FINANCIALS'); assert.equal(sectorOfSic('6798'), 'REAL_ESTATE');
  assert.equal(sectorOfSic('5331'), 'CONSUMER_STAPLES'); assert.equal(sectorOfSic('5961'), 'CONSUMER_DISCRETIONARY'); assert.equal(sectorOfSic('4953'), 'INDUSTRIALS');
  assert.equal(sectorOfSic('2911'), 'ENERGY'); assert.equal(sectorOfSic('4911'), 'UTILITIES'); assert.equal(sectorOfSic(null), 'UNCLASSIFIED'); assert.equal(sectorOfSic('6770'), 'UNCLASSIFIED');
  assert.ok(!isTechSic('5961') && !isTechSic('6798'));
});
test('classification snapshot: sourced, hashed, every SIC re-derives to the stored sector', () => {
  assert.equal(CLASSIFICATION.taxonomy, TAXONOMY_VERSION);
  assert.match(CLASSIFICATION.content_sha256, /^[0-9a-f]{64}$/);
  assert.ok(CLASSIFICATION.counts.members >= 500 && CLASSIFICATION.counts.tech >= 50);
  for (const [t, r] of Object.entries(CLASSIFICATION.rows)) {
    if (r.sic) { assert.equal(r.sector, sectorOfSic(r.sic), t); assert.equal(r.tech, isTechSic(r.sic), t); }
    else assert.equal(r.sector, 'UNCLASSIFIED', t);
  }
  for (const t of ['NVDA', 'MSFT', 'AAPL', 'AVGO']) assert.equal(CLASSIFICATION.rows[t].tech, true, t);
  for (const t of ['JPM', 'XOM', 'LLY', 'AMZN']) assert.equal(CLASSIFICATION.rows[t].tech, false, t);
});

// ---------------- fixtures ----------------
// Synthetic classification over the bundled member list: deterministic sectors, ~1/4 technology.
const SECTORS11 = ['TECHNOLOGY', 'COMMUNICATION', 'CONSUMER_DISCRETIONARY', 'CONSUMER_STAPLES', 'ENERGY', 'FINANCIALS', 'HEALTH_CARE', 'INDUSTRIALS', 'MATERIALS', 'REAL_ESTATE', 'UTILITIES'];
const FIX_CLS = { taxonomy: TAXONOMY_VERSION, effective_from: '2025-01-01', content_sha256: 'f'.repeat(64),
  rows: Object.fromEntries(LATEST_MEMBERS.tickers.map((t, i) => { const s = i % 4 === 0 ? 'TECHNOLOGY' : SECTORS11[1 + (i % 10)]; return [t, { sector: s, tech: s === 'TECHNOLOGY' }]; })) };
const D0 = '2026-09-03', D1 = '2026-09-04', D2 = '2026-09-08';
const eodAt = (d) => `${d}T20:35:00Z`;
// QQQ lifted above its 200-day average so the Tech regime is risk-on (the raw synthetic QQQ is risk-off; Tech then
// correctly buys nothing — covered by the WAIT path, not this fixture).
const BULL = { QQQ: { from: 400, factor: 1.3 } };
const src = (d, o = {}) => fakeSource({ today: d, at: `${d}T20:00:00Z`, shock: BULL, ...o });
const openSrc = (d) => fakeSource({ today: d, at: `${d}T13:50:00Z`, shock: BULL });
const runEod = (store, d, o = {}) => runArenaEod({ store, now: eodAt(d), fetchImpl: src(d, o), t0: o.t0 ?? D0, classification: FIX_CLS });
const events = (store, account) => store.select(T.events, { account: `eq.${account}` }, { order: 'seq.asc' });

// ---------------- 4. lane: T0, funding, isolation, chains, idempotency ----------------
test('no challenger record before T0; funding at the first eligible EOD; control tables untouched', async () => {
  const store = new FakeStore();
  assert.deepEqual(await runEod(store, D0, { t0: D1 }), { skipped: 'before_t0' });
  assert.equal(store.writes.length, 0);
  const r = await runEod(store, D0);
  assert.equal(r.TECH.ok, true, JSON.stringify(r)); assert.equal(r.DIVERSIFIED.ok, true, JSON.stringify(r));
  assert.ok(r.TECH.funded && r.DIVERSIFIED.funded);
  for (const S of CHALLENGERS) {
    const ev = await events(store, S.account);
    assert.equal(ev[0].type, 'FUNDING'); assert.equal(ev[0].d, D0); assert.equal(ev[0].payload.cashCents, STARTING_CASH_CENTS);
    assert.equal(ev[0].payload.policySha256, await policyHash(S)); assert.equal(ev[0].policy_sha256, await policyHash(S));
    assert.ok(ev.every((e) => e.account === S.account && e.strategy === S.strategy && e.origin === 'ARENA_FORWARD_PAPER'));
    assert.equal(ev.filter((e) => e.type === 'FILL').length, 0, 'no fills on the funding day');
    assert.equal((await verifyChain(ev)).ok, true);
  }
  assert.ok(store.writes.every((t) => t.startsWith('pred_s10a_')), 'only challenger tables written');
  assert.equal(store.rows(T.snapshots).length, CHALLENGERS.length);
  assert.equal(store.rows(T.marks).length, CHALLENGERS.length);
  assert.equal(CHALLENGERS.length, 3);
});

test('one shared market fetch serves both challengers (no per-account upstream fan-out)', async () => {
  const store = new FakeStore(); const calls = [];
  await runArenaEod({ store, now: eodAt(D0), fetchImpl: src(D0, { calls }), t0: D0, classification: FIX_CLS });
  const charts = calls.filter((u) => u.includes('/chart/'));
  const perSymbol = {}; for (const u of charts) { const s = u.match(/chart\/([^?]+)/)[1]; perSymbol[s] = (perSymbol[s] || 0) + 1; }
  assert.ok(Object.entries(perSymbol).every(([s, n]) => n === 1 || (s === 'SPY' && n === 2)), JSON.stringify(Object.entries(perSymbol).filter(([, n]) => n > 1)));
});

test('reruns, duplicate claims and concurrent EODs never double-write', async () => {
  const store = new FakeStore();
  await runEod(store, D0);
  const n = store.rows(T.events).length;
  assert.deepEqual(await runEod(store, D0), { skipped: 'eod_done' });
  assert.equal(store.rows(T.events).length, n);
  // next session: open, then two concurrent EODs
  const o = await runArenaOpen({ store, now: `${D1}T13:50:00Z`, fetchImpl: openSrc(D1), t0: D0 });
  assert.ok(o.TECH.ok && o.DIVERSIFIED.ok, JSON.stringify(o));
  const [a, b] = await Promise.all([runEod(store, D1), runEod(store, D1)]);
  for (const S of CHALLENGERS) {
    const oks = [a[S.strategy], b[S.strategy]].filter((x) => x?.ok).length;
    assert.ok(oks <= 1, `${S.strategy} wrote twice`);
    const ev = await events(store, S.account);
    assert.equal((await verifyChain(ev)).ok, true);
    assert.equal(ev.filter((e) => e.type === 'EOD_MARK' && e.d === D1).length, oks);
  }
});

test('OPEN fills only at the next session open; benchmarks bought at the same open; Tech holds technology only', async () => {
  const store = new FakeStore();
  await runEod(store, D0);
  await runArenaOpen({ store, now: `${D1}T13:50:00Z`, fetchImpl: openSrc(D1), t0: D0 });
  const tech = await events(store, TECH.account);
  const fills = tech.filter((e) => e.type === 'FILL');
  assert.ok(fills.length >= 1 && fills.length <= TECH.manager.maxNewBuysPerSession);
  for (const f of fills) { assert.equal(f.d, D1); assert.equal(FIX_CLS.rows[f.payload.symbol]?.tech ?? FIX_CLS.rows[Object.keys(FIX_CLS.rows).find((k) => k.replace(/\./g, '-') === f.payload.symbol)]?.tech, true, f.payload.symbol); }
  assert.ok(!fills.some((f) => METAL_ETFS.some((x) => x.symbol === f.payload.symbol)), 'Tech never buys metals');
  assert.equal(tech.filter((e) => e.type === 'BENCHMARK_FILL').length, 2);
  const st = restore(tech.filter((e) => e.type === 'STATE').at(-1).payload).st;
  assert.ok(st.cashCents >= 0); assert.equal(st.fillSessions, 1);
  assert.deepEqual(await runArenaOpen({ store, now: `${D1}T14:10:00Z`, fetchImpl: fakeSource({ today: D1, at: `${D1}T14:10:00Z`, shock: BULL }), t0: D0 }), { skipped: 'nothing_due' });
});

test('EOD after a missed OPEN books the fills once (no duplicate ledger events)', async () => {
  const store = new FakeStore();
  await runEod(store, D0);
  const r = await runEod(store, D1); // no OPEN run on D1
  assert.equal(r.TECH.ok, true);
  const ev = await events(store, TECH.account);
  const fillsD1 = ev.filter((e) => e.type === 'FILL' && e.d === D1);
  assert.equal(new Set(fillsD1.map((e) => e.payload.orderSeq)).size, fillsD1.length, 'each order filled once');
  assert.equal(ev.filter((e) => e.type === 'SESSION' && e.d === D1).length, 1);
  assert.equal((await verifyChain(ev)).ok, true);
});

const heldOf = async (store, S) => restore((await events(store, S.account)).filter((e) => e.type === 'STATE').at(-1).payload).st.positions;
test('per-account fail closed: a missing held series with no persisted close blocks ONLY that account (no claim, no invented mark)', async () => {
  const store = new FakeStore();
  await runEod(store, D0);
  await runArenaOpen({ store, now: `${D1}T13:50:00Z`, fetchImpl: openSrc(D1), t0: D0 });
  const techHeld = Object.keys(await heldOf(store, TECH)); const divHeld = new Set(Object.keys(await heldOf(store, DIVERSIFIED)));
  const sym = techHeld.find((s) => !divHeld.has(s));
  assert.ok(sym, 'fixture: a Tech-only holding');
  const r = await runEod(store, D1, { drop: new Set([sym]) });
  assert.equal(r.TECH.skipped, 'held_symbol_unavailable'); assert.deepEqual(r.TECH.missingHeld, [sym]);
  assert.equal(r.DIVERSIFIED.ok, true, 'the other challenger is not blocked');
  assert.ok(!store.rows(T.runs).some((x) => x.run_key === `${TECH.account}:EOD:${D1}`), 'no Tech claim');
});

test('a held series that disappears after a persisted mark: held stale at its last close (NOT AVAILABLE NAV), then delisted after 3 sessions', async () => {
  const store = new FakeStore();
  await runEod(store, D0);
  await runArenaOpen({ store, now: `${D1}T13:50:00Z`, fetchImpl: openSrc(D1), t0: D0 });
  await runEod(store, D1);
  const sym = Object.keys(await heldOf(store, TECH))[0];
  const days = CAL.filter((d) => d > D1).slice(0, 4);
  for (const d of days) await runEod(store, d, { drop: new Set([sym]) });
  const ev = await events(store, TECH.account);
  assert.ok(ev.some((e) => e.type === 'SERIES_UNAVAILABLE' && e.payload.symbol === sym));
  const marks = store.rows(T.marks).filter((m) => m.account === TECH.account && m.d > D1);
  assert.equal(marks[0].nav_cents, null, 'NOT AVAILABLE while the holding has no observed close');
  const liq = ev.find((e) => e.type === 'DELIST_LIQUIDATION' && e.payload.symbol === sym);
  assert.ok(liq, 'liquidated at the last observed close after 3 missing sessions'); assert.match(liq.payload.flag, /ESTIMATE/);
  assert.equal((await verifyChain(ev)).ok, true);
});

test('holiday / non-final close: no claim, no events', async () => {
  const store = new FakeStore();
  assert.equal((await runArenaEod({ store, now: eodAt('2026-09-07'), fetchImpl: fakeSource({ today: '2026-09-07', at: '2026-09-07T20:00:00Z', holiday: true }), t0: D0, classification: FIX_CLS })).skipped, 'no_session_today');
  assert.equal(store.writes.length, 0);
  assert.equal(arenaDue('2026-09-08T20:31:00Z').eod, true); assert.equal(arenaDue('2026-09-08T20:32:00Z').eod, false); assert.equal(arenaDue('2026-09-12T20:31:00Z').eod, false);
});

test('tamper evidence: changing any stored field breaks the chain', async () => {
  const store = new FakeStore();
  await runEod(store, D0);
  const ev = await events(store, DIVERSIFIED.account);
  ev[1].payload.reason = 'edited';
  assert.equal((await verifyChain(ev)).ok, false);
});

// ---------------- 5. Diversified caps (deterministic enforcement incl. post-drift) ----------------
function market(symbols, D, shock) {
  const cal = CAL.filter((d) => d <= D); const calIndex = new Map(cal.map((d, i) => [d, i]));
  const prepared = new Map(symbols.map((s) => [s, prepareSeries({ symbol: s, name: s, bars: cal.map((d, i) => { const c = +priceAt(s, i, shock).toFixed(4); return { d, o: c, h: c, l: c, c, adj: c, v: 5e6 }; }), splits: [], dividends: [] }, calIndex)]));
  return { prepared, calIndex };
}
test('Diversified entries never breach 10% holding, 25% sector or 20% metals; max 2 names per sector', () => {
  const syms = LATEST_MEMBERS.tickers.slice(0, 160).map((t) => t.replace(/\./g, '-'));
  const { prepared } = market([...syms, 'SPY', 'GLD', 'SLV', 'PPLT'], D0);
  const uni = syms.map((s, i) => ({ ticker: s, symbol: s, sector: SECTORS11[i % 11] }));
  const snap = rankStrategy(DIVERSIFIED, D0, uni, prepared);
  const st = newChallenger(DIVERSIFIED, D0, 'x');
  const metals = METAL_ETFS.map((e) => ({ symbol: e.symbol, verified: true, hold: null, f: { eligible: true, adj: 2, sma200: 1, mom6: 0.1, vol63: 0.05 } }));
  const m = { navCents: st.cashCents, cashCents: st.cashCents, marketValueCents: 0, positions: [], stale: [] };
  const { orders } = decideDiversified(st, D0, snap, metals, { regime: { riskOn: true }, prepared, m });
  const buys = orders.filter((o) => o.side === 'BUY');
  assert.ok(buys.length <= DIVERSIFIED.manager.maxNewBuysPerSession);
  const bySector = {}; let metalsW = 0; const names = {};
  for (const o of buys) {
    const w = o.targetCents / m.navCents; assert.ok(w <= 0.10 + 1e-9, `${o.symbol} ${w}`);
    if (o.kind === 'METAL_ETF') metalsW += w; else { bySector[o.sector] = (bySector[o.sector] || 0) + w; names[o.sector] = (names[o.sector] || 0) + 1; }
  }
  for (const [s, w] of Object.entries(bySector)) { assert.ok(w <= 0.25 + 1e-9, s); assert.ok(names[s] <= 2, s); }
  assert.ok(metalsW <= 0.20 + 1e-9);
});

test('Diversified post-drift: holding > 10% -> trim to 9%; sector > 25% -> trim to 24%; metals > 20% -> trim to 19%', () => {
  const { prepared } = market(['AAA', 'BBB', 'CCC', 'GLD', 'SLV', 'SPY'], D0);
  const px = (s) => prepared.get(s).c[prepared.get(s).idx.get(D0)];
  const st = newChallenger(DIVERSIFIED, D0, 'x');
  const nav = 1_000_000; // $10,000
  // AAA 18% (holding breach), AAA+BBB 30% in TECHNOLOGY (sector breach), GLD 14% + SLV 12% = 26% metals (sleeve breach)
  const want = { AAA: [0.18, 'TECHNOLOGY', 'EQUITY'], BBB: [0.12, 'TECHNOLOGY', 'EQUITY'], CCC: [0.05, 'ENERGY', 'EQUITY'], GLD: [0.14, 'PRECIOUS_METALS', 'METAL_ETF'], SLV: [0.12, 'PRECIOUS_METALS', 'METAL_ETF'] };
  const positions = [];
  let mv = 0;
  for (const [s, [w, sector, kind]] of Object.entries(want)) {
    const qty = Math.floor(w * nav / (px(s) * 100)); const v = Math.round(qty * px(s) * 100); mv += v;
    st.positions[s] = { qty, costCents: v, peakAdj: px(s), ticker: s, sector, kind }; positions.push({ symbol: s, qty, close: px(s), valueCents: v });
  }
  st.cashCents = nav - mv;
  const m = { navCents: nav, cashCents: st.cashCents, marketValueCents: mv, positions, stale: [] };
  const ranks = ['AAA', 'BBB', 'CCC'].map((s, i) => ({ symbol: s, ticker: s, rank: i + 1, score: 99, sector: want[s][1], f: { adj: px(s), sma200: 0, sma50: 0, ret1: 0, vol63: 0.2 } }));
  const metals = ['GLD', 'SLV'].map((s) => ({ symbol: s, verified: true, f: { eligible: true, adj: px(s), sma200: 0, mom6: 0.1, vol63: 0.1 } }));
  const { orders } = decideDiversified(st, D0, { ranks }, metals, { regime: { riskOn: true }, prepared, m });
  const sells = Object.fromEntries(orders.filter((o) => o.side === 'SELL').map((o) => [o.symbol, o]));
  const after = (s) => (st.positions[s].qty - (sells[s]?.qty || 0)) * px(s) * 100 / nav;
  assert.match(sells.AAA.reason, /CAP_(HOLDING|SECTOR)/);
  assert.ok(after('AAA') <= 0.10 + 1e-3, `AAA ${after('AAA')}`);
  assert.ok(after('AAA') + after('BBB') <= 0.25 + 1e-3, 'technology sector back under 25%');
  assert.ok(after('GLD') + after('SLV') <= 0.20 + 1e-3, 'metals back under 20%');
  assert.ok(!sells.CCC, 'no trim without a breach');
  const ex = exposures(st, m);
  assert.ok(ex.metals > 0.2 && ex.sectors.TECHNOLOGY > 0.25, 'the fixture really breached the caps');
});

test('Tech: trailing-stop exit sets a cooldown that blocks the re-buy (the control’s whipsaw)', () => {
  const syms = LATEST_MEMBERS.tickers.slice(0, 60).map((t) => t.replace(/\./g, '-'));
  const { prepared } = market([...syms, 'QQQ'], D0);
  const uni = syms.map((s) => ({ ticker: s, symbol: s, sector: 'TECHNOLOGY' }));
  const snap = rankStrategy(TECH, D0, uni, prepared);
  const top = snap.ranks[0];
  const st = newChallenger(TECH, D0, 'x');
  st.positions[top.symbol] = { qty: 10, costCents: 100000, peakAdj: top.f.adj / 0.7, ticker: top.symbol, sector: 'TECHNOLOGY', kind: 'EQUITY' };
  const m = { navCents: 1_000_000, cashCents: 900_000, marketValueCents: 100_000, positions: [{ symbol: top.symbol, valueCents: 100_000 }], stale: [] };
  const r1 = decideTech(st, D0, snap, { regime: { riskOn: true }, prepared, m });
  assert.match(r1.orders.find((o) => o.symbol === top.symbol).reason, /TRAILING_STOP/);
  assert.equal(st.cooldown[top.symbol], TECH.manager.cooldownSessions);
  delete st.positions[top.symbol];
  const r2 = decideTech(st, D0, snap, { regime: { riskOn: true }, prepared, m: { ...m, positions: [] } });
  assert.ok(!r2.orders.some((o) => o.symbol === top.symbol && o.side === 'BUY'));
  assert.match(r2.decisions.find((d) => d.symbol === top.symbol).reason, /WAIT_COOLDOWN/);
});

// ---------------- 6. precious metals contract (#63) ----------------
test('metals: spot and ETF identities never collide; spot is SOURCE_RIGHTS_HOLD; unregistered corporate action holds the sleeve', () => {
  const ids = [...SPOT.map((x) => x.id), ...METAL_ETFS.map((x) => x.id)];
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(SPOT.every((x) => x.unit === 'USD per troy ounce' && x.kind === 'SPOT'));
  assert.equal(SPOT_HOLD.state, 'SOURCE_RIGHTS_HOLD');
  for (const e of METAL_ETFS) { assert.match(e.sec_cik, /^\d{10}$/); assert.equal(e.mic, 'ARCX'); }
  const { prepared } = market(['SLV', 'GLD'], D0);
  assert.equal(etfEligibility(METAL_ETFS[0], prepared.get('GLD'), D0).verified, true);
  const slv = { ...prepared.get('SLV'), splits: [{ d: CAL[300], ratio: 2 }] };
  assert.match(etfEligibility(METAL_ETFS[1], slv, D0).hold, /unregistered_corporate_action/);
  assert.equal(etfEligibility(METAL_ETFS[0], null, D0).hold, 'no_price_series');
});

test('universes: Tech = technology names only; Diversified = every classified name; unclassified listed, never traded', () => {
  const cls = { rows: { NVDA: { sector: 'TECHNOLOGY', tech: true }, JPM: { sector: 'FINANCIALS', tech: false }, PSKY: { sector: 'UNCLASSIFIED', tech: false } } };
  const U = universes(['NVDA', 'JPM', 'PSKY', 'ZZZZ'], D0, cls);
  assert.deepEqual(U.tech.map((u) => u.ticker), ['NVDA']);
  assert.deepEqual(U.div.map((u) => u.ticker).sort(), ['JPM', 'NVDA']);
  assert.deepEqual(U.unclassified.sort(), ['PSKY', 'ZZZZ']);
});

// ---------------- 7. regressions from the independent review (2026-10-10) ----------------
test('review #1/#2: five sessions through a JSON store — chains verify, STATE keeps seq/origin, every FILL links to its ORDER', async () => {
  const store = new FakeStore(); // JSON round trip, like PostgREST + jsonb
  await runEod(store, D0);
  const days = CAL.filter((d) => d > D0).slice(0, 5);
  for (const [k, d] of days.entries()) {
    if (k % 2 === 0) await runArenaOpen({ store, now: `${d}T13:50:00Z`, fetchImpl: openSrc(d), t0: D0 }); // odd days: late open at EOD
    await runEod(store, d);
  }
  for (const S of CHALLENGERS) {
    const ev = await events(store, S.account);
    assert.deepEqual(await verifyChain(ev), { ok: true, events: ev.length, head: ev.at(-1).hash }, S.strategy);
    const st = restore(ev.filter((e) => e.type === 'STATE').at(-1).payload).st;
    assert.ok(Number.isInteger(st.seq) && st.seq > 0 && st.origin === 'ARENA_FORWARD_PAPER', 'STATE round-trips seq/origin');
    const orders = new Map(ev.filter((e) => e.type === 'ORDER').map((e) => [e.payload.local_seq, e]));
    const fills = ev.filter((e) => e.type === 'FILL');
    assert.ok(fills.length > 0);
    for (const f of fills) { const o = orders.get(f.payload.orderSeq); assert.ok(o, `fill ${f.seq} links to an order`); assert.equal(o.payload.symbol, f.payload.symbol); assert.ok(o.d < f.d, 'order frozen before its fill'); }
    const bench = ev.filter((e) => e.type.startsWith('BENCHMARK_'));
    assert.ok(bench.length > 0 && bench.every((e) => e.payload.orderSeq === undefined && e.payload.local_seq === undefined), 'benchmark events never reuse account-local numbers');
  }
});

test('review #4: a full exit filling on a split date sells the whole post-split position; a trim scales by the ratio', async () => {
  const { openSession } = await import('../src/signal10/arena/engine.js');
  const { prepared } = market(['AAA', 'BBB'], D1);
  for (const s of ['AAA', 'BBB']) prepared.get(s).splits.push({ d: D1, ratio: 2 });
  const st = newChallenger(TECH, D0, 'x');
  st.positions.AAA = { qty: 10, costCents: 100000, peakAdj: 1, ticker: 'AAA' }; st.positions.BBB = { qty: 10, costCents: 100000, peakAdj: 1, ticker: 'BBB' };
  st.pending = [{ seq: 50, side: 'SELL', symbol: 'AAA', qty: 10, full: true, reason: 'RANK_EXIT' }, { seq: 51, side: 'SELL', symbol: 'BBB', qty: 4, reason: 'TRIM' }];
  const evs = openSession(st, D1, prepared);
  assert.equal(st.positions.AAA, undefined, 'nothing left of a full exit');
  assert.equal(st.positions.BBB.qty, 12, '20 post-split shares minus a trim of 8');
  assert.ok(evs.some((e) => e.type === 'ORDER_SPLIT_ADJUSTED' && e.symbol === 'BBB' && e.qtyAfter === 8));
});

test('review #3: positions that are exiting never trigger trims of the holdings that stay', () => {
  const { prepared } = market(['AAA', 'BBB', 'CCC', 'GLD', 'SLV', 'SPY'], D0);
  const px = (s) => prepared.get(s).c[prepared.get(s).idx.get(D0)];
  const st = newChallenger(DIVERSIFIED, D0, 'x'); const nav = 1_000_000; const positions = []; let mv = 0;
  const want = { AAA: [0.09, 'TECHNOLOGY', 'EQUITY'], BBB: [0.09, 'TECHNOLOGY', 'EQUITY'], CCC: [0.09, 'TECHNOLOGY', 'EQUITY'], GLD: [0.17, 'PRECIOUS_METALS', 'METAL_ETF'], SLV: [0.09, 'PRECIOUS_METALS', 'METAL_ETF'] };
  for (const [s, [w, sector, kind]] of Object.entries(want)) { const qty = Math.floor(w * nav / (px(s) * 100)); const v = Math.round(qty * px(s) * 100); mv += v; st.positions[s] = { qty, costCents: v, peakAdj: px(s), ticker: s, sector, kind }; positions.push({ symbol: s, qty, close: px(s), valueCents: v }); }
  st.cashCents = nav - mv;
  const m = { navCents: nav, cashCents: st.cashCents, marketValueCents: mv, positions, stale: [] };
  // AAA leaves the ranking (RANK_EXIT, full sale) and GLD is no longer verified (full sale): sector 27% -> ~18%, metals 26% -> ~9%
  const ranks = ['BBB', 'CCC'].map((s, i) => ({ symbol: s, ticker: s, rank: i + 1, score: 99, sector: 'TECHNOLOGY', f: { adj: px(s), sma200: 0, sma50: 0, ret1: 0, vol63: 0.2 } }));
  const metals = [{ symbol: 'GLD', verified: false, hold: 'test' }, { symbol: 'SLV', verified: true, f: { eligible: true, adj: px('SLV'), sma200: 0, mom6: 0.1, vol63: 0.1 } }];
  const { orders } = decideDiversified(st, D0, { ranks }, metals, { regime: { riskOn: false }, prepared, m });
  const sells = Object.fromEntries(orders.filter((o) => o.side === 'SELL').map((o) => [o.symbol, o]));
  assert.ok(sells.AAA?.full && sells.GLD?.full, 'the exits are full sales');
  assert.equal(sells.BBB, undefined); assert.equal(sells.CCC, undefined); assert.equal(sells.SLV, undefined);
});

test('review #6: the cohort funds together — if one challenger fails its gate on day one, neither is funded', async () => {
  const store = new FakeStore();
  const techSyms = Object.entries(FIX_CLS.rows).filter(([, r]) => r.tech).map(([t]) => t.replace(/\./g, '-'));
  const r = await runEod(store, D0, { drop: new Set(techSyms.slice(0, Math.ceil(techSyms.length * 0.2))) });
  assert.equal(r.skipped, 'cohort_not_ready');
  assert.equal(store.writes.length, 0, 'no claim, no funding for either');
  const r2 = await runEod(store, D0);
  assert.ok(r2.TECH.funded && r2.DIVERSIFIED.funded);
});

test('review #7: a missing regime series never counts as risk-off and never buys', () => {
  const syms = LATEST_MEMBERS.tickers.slice(0, 40).map((t) => t.replace(/\./g, '-'));
  const { prepared } = market(syms, D0);
  const snap = rankStrategy(TECH, D0, syms.map((s) => ({ ticker: s, symbol: s, sector: 'TECHNOLOGY' })), prepared);
  const st = newChallenger(TECH, D0, 'x'); st.riskOffStreak = 9;
  const m = { navCents: 1_000_000, cashCents: 1_000_000, marketValueCents: 0, positions: [], stale: [] };
  const r = decideTech(st, D0, snap, { regime: { symbol: 'QQQ', riskOn: false, reason: 'insufficient_history' }, prepared, m });
  assert.equal(st.riskOffStreak, 9, 'streak frozen');
  assert.equal(r.orders.length, 0);
  assert.match(r.decisions[0].reason, /regime unavailable/);
});

test('review #12: the metals sleeve really enters (risk-off for equities) and stays within 20% / 10% per ETF; cooldown expires', () => {
  const { prepared } = market(['SPY', 'GLD', 'SLV', 'PPLT'], D0);
  const st = newChallenger(DIVERSIFIED, D0, 'x');
  const metals = ['GLD', 'SLV', 'PPLT'].map((s) => ({ symbol: s, verified: true, hold: null, f: { eligible: true, adj: 2, sma200: 1, mom6: 0.1, vol63: 0.04 } }));
  const m = { navCents: 1_000_000, cashCents: 1_000_000, marketValueCents: 0, positions: [], stale: [] };
  const { orders } = decideDiversified(st, D0, { ranks: [] }, metals, { regime: { riskOn: false }, prepared, m });
  const buys = orders.filter((o) => o.side === 'BUY');
  assert.equal(buys.length, 2, 'two ETFs at 10% fill the 20% sleeve; the third waits on the cap');
  assert.ok(buys.every((o) => o.kind === 'METAL_ETF' && o.targetCents <= 100_000));
  assert.ok(buys.reduce((s, o) => s + o.targetCents, 0) <= 200_000);
  st.cooldown.GLD = DIVERSIFIED.manager.cooldownSessions;
  for (let k = 0; k < DIVERSIFIED.manager.cooldownSessions; k++) decideDiversified(st, D0, { ranks: [] }, [], { regime: { riskOn: false }, prepared, m });
  assert.equal(st.cooldown.GLD, undefined);
});

// ---------------- 8. re-verification regressions (N1 / N2 / N4) ----------------
test('re-review N1: a PENDING order whose symbol loses its series expires; the account keeps running', async () => {
  const store = new FakeStore();
  await runEod(store, D0); // funding day: orders queued for D1's open
  const pend = restore((await events(store, TECH.account)).filter((e) => e.type === 'STATE').at(-1).payload).st.pending.filter((o) => o.side === 'BUY');
  assert.ok(pend.length, 'fixture: Tech queued buys');
  const sym = pend[0].symbol;
  const r = await runEod(store, D1, { drop: new Set([sym]) }); // OPEN never ran: late open at EOD with the symbol missing
  assert.equal(r.TECH.ok, true, JSON.stringify(r.TECH));
  const ev = await events(store, TECH.account);
  assert.ok(ev.some((e) => e.type === 'ORDER_EXPIRED' && e.payload.symbol === sym && e.d === D1));
  assert.equal((await verifyChain(ev)).ok, true);
});

test('re-review N4: admin rerun needs an integer >= 2 and a dead original run', async () => {
  const store = new FakeStore();
  await runEod(store, D0);
  assert.equal((await runArenaEod({ store, now: eodAt(D1), fetchImpl: src(D1), t0: D0, classification: FIX_CLS, rerun: 'x' })).skipped, 'bad_rerun');
  assert.equal((await runArenaEod({ store, now: eodAt(D1), fetchImpl: src(D1), t0: D0, classification: FIX_CLS, rerun: '1' })).skipped, 'bad_rerun');
  // the original claim exists but is fresh: a rerun must not race it
  for (const S of CHALLENGERS) store.rows(T.runs).push({ run_key: `${S.account}:EOD:${D1}`, account: S.account, kind: 'EOD', d: D1, claimed_at: `${D1}T20:30:00Z` });
  const fresh = await runArenaEod({ store, now: `${D1}T20:35:00Z`, fetchImpl: src(D1), t0: D0, classification: FIX_CLS, rerun: '2' });
  assert.equal(fresh.TECH.skipped, 'original_run_may_be_live');
  const later = await runArenaEod({ store, now: `${D1}T21:05:00Z`, fetchImpl: src(D1), t0: D0, classification: FIX_CLS, rerun: '2' });
  assert.equal(later.TECH.ok, true, JSON.stringify(later.TECH));
  assert.ok(store.rows(T.runs).some((x) => x.run_key === `${TECH.account}:EOD:${D1}#2`));
  assert.equal((await verifyChain(await events(store, TECH.account))).ok, true);
});

test('metal ETF registry: PPLT 10-for-1 split of 2026-05-18 (SEC 8-K) is registered, so a real series carrying it verifies', () => {
  const pplt = METAL_ETFS.find((e) => e.symbol === 'PPLT');
  assert.deepEqual(pplt.splits, [{ d: '2026-05-18', ratio: 10 }]);
  const { prepared } = market(['PPLT'], D0);
  const s = { ...prepared.get('PPLT'), splits: [{ d: CAL[CAL.indexOf(D0) - 60], ratio: 10 }] };
  assert.match(etfEligibility(pplt, s, D0).hold, /unregistered_corporate_action/, 'an unknown split still holds');
});
