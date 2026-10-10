// Strategy Arena head-to-head metrics (pure). Every series is EOD NAV marks on the same session dates since T0.
// A NULL mark (NOT AVAILABLE) is a gap: never interpolated, never counted as a return observation.
export const SHARPE_MIN_OBS = 60;

// points: [{ d, nav }] (nav in cents or null), ascending. base: the nav that maps to $10,000 (defaults to the first point).
export function indexSeries(points, base = null) {
  const b = base ?? points.find((p) => p.nav != null)?.nav ?? null;
  return points.map((p) => ({ d: p.d, nav: p.nav, indexed: b && p.nav != null ? Math.round(p.nav / b * 1_000_000) / 100 : null }));
}

export function seriesMetrics(points) {
  const valid = points.filter((p) => p.nav != null && p.nav > 0);
  const out = { observations: valid.length, first_d: valid[0]?.d ?? null, last_d: valid.at(-1)?.d ?? null, total_return: null, max_drawdown: null, max_drawdown_from: null, max_drawdown_to: null,
    volatility: null, sharpe: null, sharpe_note: `shown after ${SHARPE_MIN_OBS} daily observations` };
  if (valid.length < 2) return out;
  out.total_return = valid.at(-1).nav / valid[0].nav - 1;
  let peak = valid[0], mdd = 0, from = null, to = null;
  for (const p of valid) { if (p.nav > peak.nav) peak = p; const dd = p.nav / peak.nav - 1; if (dd < mdd) { mdd = dd; from = peak.d; to = p.d; } }
  Object.assign(out, { max_drawdown: mdd, max_drawdown_from: from, max_drawdown_to: to });
  // daily log returns only between ADJACENT valid marks (a NOT AVAILABLE day breaks the pair)
  const rets = [];
  for (let i = 1; i < points.length; i++) { const a = points[i - 1].nav, b = points[i].nav; if (a > 0 && b > 0) rets.push(Math.log(b / a)); }
  if (rets.length >= 2) {
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
    out.volatility = Math.sqrt(v) * Math.sqrt(252);
    if (rets.length >= SHARPE_MIN_OBS && v > 0) { out.sharpe = (m / Math.sqrt(v)) * Math.sqrt(252); out.sharpe_note = 'annualized, 0% risk-free rate'; }
  }
  return out;
}

// Turnover since inception: traded notional / average NAV; cost = slippage paid (commission is $0 by policy).
export function turnover(st, points) {
  const navs = points.map((p) => p.nav).filter((x) => x > 0);
  const avg = navs.length ? navs.reduce((s, x) => s + x, 0) / navs.length : null;
  return { traded_cents: st?.tradedCents ?? 0, trading_cost_cents: st?.slippageCents ?? 0, turnover: avg ? (st?.tradedCents ?? 0) / avg : null };
}
