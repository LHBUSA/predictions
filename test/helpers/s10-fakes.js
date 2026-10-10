// Shared Signal 10 test fakes: an append-only PostgREST-like store and a deterministic Yahoo-chart source.
// (Same semantics as the harness inside test/signal10-forward.test.js, which is left untouched.)
export class FakeStore {
  constructor() { this.t = {}; this.writes = []; }
  rows(t) { return (this.t[t] ||= []); }
  async select(table, q = {}, { limit = Infinity, order = null } = {}) {
    let r = this.rows(table).filter((row) => Object.entries(q).every(([k, v]) => {
      if (k === 'select') return true;
      const [op, ...rest] = String(v).split('.'); const val = rest.join('.');
      if (op === 'eq') return String(row[k]) === val;
      if (op === 'neq') return String(row[k]) !== val;
      if (op === 'gt') return row[k] > (Number.isFinite(+val) ? +val : val);
      if (op === 'gte') return row[k] >= val;
      if (op === 'lte') return row[k] <= val;
      if (op === 'in') return val.slice(1, -1).split(',').includes(String(row[k]));
      throw new Error('op ' + op);
    }));
    if (order) { const [c, dir] = order.split('.'); r = [...r].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
    return structuredClone(r.slice(0, limit));
  }
  async write(table, rows, { conflictColumn, returnRepresentation } = {}) {
    const out = [];
    for (const row of [].concat(rows)) {
      this.writes.push(table);
      if (conflictColumn && this.rows(table).some((x) => x[conflictColumn] === row[conflictColumn])) continue;
      this.rows(table).push(structuredClone(row)); out.push(row);
    }
    return returnRepresentation ? out : null;
  }
  insertMany(table, rows, conflictColumn) { return this.write(table, rows, { conflictColumn }); }
}

export function weekdays(from, n) { const out = []; let t = Date.parse(from + 'T00:00:00Z'); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; }
export const CAL = weekdays('2025-01-02', 460).filter((d) => d !== '2026-09-07');
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 2 ** 32; }
export function priceAt(sym, i, shock = null) {
  const k = hash(sym); let p = (20 + 200 * k) * Math.exp(i * (0.0015 * k - 0.0003) + 0.02 * Math.sin(i / 4 + k * 10));
  if (shock && shock[sym] && i >= shock[sym].from) p *= shock[sym].factor;
  return p;
}
// opts.shock: { SYM: { from: <bar index>, factor } } multiplies prices from a bar on (to force drift / stops).
// opts.splits: { SYM: [{ d, numerator, denominator }] }; opts.drop: Set of symbols that return 404.
export function fakeSource({ today, at, holiday = false, shock = null, splits = {}, drop = new Set(), calls = null }) {
  const cal = CAL.filter((d) => d <= today && !(holiday && d === today));
  return async (url) => {
    const u = String(url);
    if (calls) calls.push(u);
    if (u.includes('githubusercontent')) return new Response('nope', { status: 503 });
    const sym = decodeURIComponent(u.match(/chart\/([^?]+)/)[1]).replace(/-/g, '.');
    if (drop.has(sym)) return new Response('{}', { status: 404 });
    const ts = cal.map((d) => Date.parse(d + 'T13:30:00Z') / 1000);
    const close = cal.map((_, i) => +priceAt(sym, i, shock).toFixed(4));
    const open = close.map((c, i) => +(i ? close[i - 1] * (1 + 0.001 * Math.sin(i)) : c).toFixed(4));
    const lastTime = holiday ? Date.parse(cal.at(-1) + 'T20:00:00Z') / 1000 : Math.floor(Date.parse(at) / 1000);
    const ev = {}; for (const s of splits[sym] || []) ev[String(Date.parse(s.d + 'T13:30:00Z') / 1000)] = { date: Date.parse(s.d + 'T13:30:00Z') / 1000, numerator: s.numerator, denominator: s.denominator };
    const body = { chart: { result: [{ meta: { symbol: sym, longName: `${sym} Corp`, gmtoffset: -14400, regularMarketPrice: close.at(-1), regularMarketTime: lastTime, chartPreviousClose: close.at(-2) },
      timestamp: ts, events: { splits: ev }, indicators: { quote: [{ open, high: close.map((c) => c * 1.01), low: close.map((c) => c * 0.99), close, volume: close.map(() => 5e6) }], adjclose: [{ adjclose: close }] } }] } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
