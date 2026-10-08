// Employment Tier A collector: pure planning and derivation rules (no network).
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveBook, etWallToUtcMs, eventTicker, parseBlsSchedule, plan, slotTimes, takerFee } from '../scripts/research/employment/collector/lib.mjs';

const REL = { reference_month: '2026-10', release_date: '2026-11-06', release_time_et: '08:30', release_at: '2026-11-06T13:30:00.000Z' };
const none = { slotOk: () => false, missed: () => false, settlement: () => false, blsCurrent: () => false, blsArchive: () => false };
const ENABLED = Date.parse('2026-10-08T17:00:00Z');

test('slot times follow America/New_York across the 2026-11-01 DST change', () => {
  const s = Object.fromEntries(slotTimes(REL).map((x) => [x.slot, new Date(x.at).toISOString()]));
  assert.equal(s['T-7D'], '2026-10-31T00:00:00.000Z'); // Fri Oct 30 20:00 EDT
  assert.equal(s['T-3D'], '2026-11-04T01:00:00.000Z'); // Tue Nov 3 20:00 EST
  assert.equal(s['T-1D'], '2026-11-06T01:00:00.000Z'); // Thu Nov 5 20:00 EST = pre-registered cutoff
  assert.equal(etWallToUtcMs('2026-03-08', 20, 0), Date.parse('2026-03-09T00:00:00Z'));
});

test('BLS schedule rows parse to ET release instants', () => {
  const html = '<table><tr><th>Reference Month</th><th>Release Date</th><th>Release Time</th></tr><tr><td><p>October 2026</p></td><td><p>Nov. 06, 2026</p></td><td><p>08:30 AM</p></td></tr><tr><td>May 2026</td><td>Jun. 05, 2026</td><td>08:30 AM</td></tr></table>';
  assert.deepEqual(parseBlsSchedule(html), [
    { reference_month: '2026-10', release_date: '2026-11-06', release_time_et: '08:30', release_at: '2026-11-06T13:30:00.000Z' },
    { reference_month: '2026-05', release_date: '2026-06-05', release_time_et: '08:30', release_at: '2026-06-05T12:30:00.000Z' },
  ]);
  assert.equal(eventTicker('KXU3', '2026-10'), 'KXU3-26OCT');
});

test('snapshots only inside [slot - 15 min, slot); a closed window is MISSED, never backfilled', () => {
  const t1 = Date.parse('2026-11-06T01:00:00Z');
  const earlierDone = { ...none, slotOk: (k) => !k.endsWith('T-1D') };
  const at = (ms) => plan(ms, { calendar: [REL], enabledAt: ENABLED, have: earlierDone }).map((a) => `${a.type} ${a.slot || ''}`.trim());
  assert.deepEqual(at(t1 - 16 * 60000), []);
  assert.deepEqual(at(t1 - 15 * 60000), ['KALSHI_SNAPSHOT T-1D']);
  assert.deepEqual(at(t1 - 1000), ['KALSHI_SNAPSHOT T-1D']);
  assert.deepEqual(at(t1), ['MISSED T-1D']); // the cutoff instant itself is already too late
  const ok = plan(t1 + 3600000, { calendar: [REL], enabledAt: ENABLED, have: { ...none, slotOk: (k) => k === '2026-11-06/T-1D' } });
  assert.ok(!ok.some((a) => a.type === 'KALSHI_SNAPSHOT'));
  assert.ok(!ok.some((a) => a.key === '2026-11-06/T-1D'));
  // T-7D and T-3D, unsatisfied by then, are reported MISSED as well
  assert.deepEqual(ok.filter((a) => a.type === 'MISSED').map((a) => a.slot).sort(), ['T-3D', 'T-7D']);
});

test('slots that closed before collection was enabled are not reported missed', () => {
  const late = plan(Date.parse('2026-11-06T02:00:00Z'), { calendar: [REL], enabledAt: Date.parse('2026-11-05T00:00:00Z'), have: none });
  assert.deepEqual(late.filter((a) => a.type === 'MISSED').map((a) => a.slot), ['T-1D']);
});

test('BLS capture is due from release + 30 s; settlement from +1 day', () => {
  const r = Date.parse(REL.release_at);
  const types = (ms) => plan(ms, { calendar: [REL], enabledAt: ENABLED, have: { ...none, slotOk: () => true } }).map((a) => a.type);
  assert.deepEqual(types(r + 10000), []);
  assert.deepEqual(types(r + 60000), ['BLS_CURRENT', 'BLS_ARCHIVE']);
  assert.ok(types(r + 86400000 + 1).includes('KALSHI_SETTLEMENT'));
});

test('order book: best bid is the highest price; YES ask is 1 - best NO bid with its size', () => {
  const b = deriveBook({ orderbook_fp: { yes_dollars: [['0.0100', '2000.00'], ['0.0600', '2334.00']], no_dollars: [['0.1100', '6.00'], ['0.9100', '105.00'], ['0.9000', '18010.00']] } });
  assert.equal(b.best_yes_bid, 0.06); assert.equal(b.best_yes_bid_size, 2334);
  assert.equal(b.best_yes_ask, 0.09); assert.equal(b.best_yes_ask_size, 105);
  assert.equal(b.mid, 0.075); assert.equal(b.spread, 0.03);
  assert.equal(deriveBook({ orderbook_fp: { yes_dollars: null, no_dollars: [['0.5', '1']] } }).two_sided, false);
});

test('quadratic taker fee rounds up to the cent; unknown fee types fail closed', () => {
  assert.equal(takerFee('quadratic_with_maker_fees', 1, 0.5), 0.02); // 0.07 * 0.25 = 0.0175 -> 0.02
  assert.equal(takerFee('quadratic', 1, 0.09), 0.01);
  assert.equal(takerFee('quadratic', 1, 0.5, 100), 1.75);
  assert.equal(takerFee('flat', 1, 0.5), null);
  assert.equal(takerFee(undefined, 1, 0.5), null);
});
