// Signal 10 source normalization (pure, Worker-safe).
// Yahoo chart daily bars: open/high/low/close are SPLIT-adjusted (not dividend-adjusted); adjclose is split+dividend
// adjusted; dividend amounts are split-adjusted. We rebuild UNADJUSTED tradeable prices by multiplying by the product
// of split ratios that occur AFTER each bar, and keep splits/dividends as explicit corporate-action events.
// Feature math uses ratios of adjclose between two dates <= D, which depend only on dividends/splits between those
// dates (all later adjustment factors cancel), so they are point-in-time safe.

const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function nyDate(epochSec, gmtoffsetSec) {
  return new Date((epochSec + gmtoffsetSec) * 1000).toISOString().slice(0, 10);
}

// Returns { symbol, name, exchange, bars:[{d,o,h,l,c,adj,v}] (unadjusted o/h/l/c, raw v), splits:[{d,ratio}],
// dividends:[{d,amount}] (unadjusted per-share cash), issues:[...] } or null when the response has no data.
export function parseYahooChart(json, { cutoffDate } = {}) {
  const res = json?.chart?.result?.[0];
  if (!res || !Array.isArray(res.timestamp)) return null;
  const meta = res.meta || {};
  const off = Number(meta.gmtoffset) || 0;
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose || [];
  const issues = [];
  const ev = res.events || {};
  // splits: ratio = numerator/denominator (2-for-1 => 2). Event date = first session trading on the new basis.
  const splits = Object.values(ev.splits || {}).map((s) => ({
    d: nyDate(s.date, off), ratio: Number(s.numerator) / Number(s.denominator)
  })).filter((s) => s.ratio > 0 && Number.isFinite(s.ratio) && s.ratio !== 1).sort((a, b) => (a.d < b.d ? -1 : 1));
  const factorAfter = (d) => splits.reduce((f, s) => (s.d > d ? f * s.ratio : f), 1);
  const seen = new Set();
  const bars = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    const d = nyDate(res.timestamp[i], off);
    if (cutoffDate && d > cutoffDate) continue;
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i], a = adj[i];
    if (seen.has(d)) { issues.push({ d, issue: 'duplicate_bar' }); continue; }
    if (![o, h, l, c, a].every((x) => typeof x === 'number' && x > 0)) { issues.push({ d, issue: 'incomplete_bar' }); continue; }
    seen.add(d);
    const f = factorAfter(d);
    bars.push({ d, o: r6(o * f), h: r6(h * f), l: r6(l * f), c: r6(c * f), adj: a, v: Math.round((Number(v) || 0) / f) });
  }
  const dividends = Object.values(ev.dividends || {}).map((x) => {
    const d = nyDate(x.date, off);
    return { d, amount: r6(Number(x.amount) * factorAfter(d)) };
  }).filter((x) => x.amount > 0 && (!cutoffDate || x.d <= cutoffDate)).sort((a, b) => (a.d < b.d ? -1 : 1));
  return {
    symbol: meta.symbol, name: meta.longName || meta.shortName || meta.symbol, exchange: meta.fullExchangeName || null,
    instrumentType: meta.instrumentType || null, bars, splits: splits.filter((s) => !cutoffDate || s.d <= cutoffDate), dividends, issues
  };
}
