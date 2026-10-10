// Event-level skill for exhaustive MAX_TEMP_BUCKET events (temp-skill/1). Pure: no I/O, no market input to any model.
// One event = one settled set of mutually exclusive buckets (low tail, 2 °F buckets, high tail) with exactly one winner.
// The top-bucket hit count is descriptive; what it should be compared with is its expectation, the sum of the chosen
// buckets' probabilities (a calibrated forecaster whose favourite is 35% likely hits ~35% of the time). Full-distribution
// skill uses the multiclass log loss and Brier over the whole bucket set.
export const TEMP_SKILL_RULES = 'temp-skill/1';
export const LL_FLOOR = 0.001; // probability floor for the multiclass log loss (bucket probabilities are clamped >= 0.01)

const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// Integer range [lo, hi] of a bucket (CLI whole degrees): 'less' cap C -> < C ; 'greater' floor F -> > F.
export function bucketRange(c) {
  const lo = num(c.threshold_low); const hi = num(c.threshold_high);
  if (c.comparator === 'less' && hi !== null) return [-Infinity, hi - 1];
  if (c.comparator === 'greater' && lo !== null) return [lo + 1, Infinity];
  if (c.comparator === 'between' && lo !== null && hi !== null) return [lo, hi];
  return null;
}

// Orders an event's buckets low -> high and checks they partition the integers (no gap, no overlap, both tails).
export function orderBuckets(contracts) {
  const withR = contracts.map((c) => ({ c, r: bucketRange(c) }));
  if (withR.some((x) => !x.r)) return { ok: false, reason: 'UNPARSEABLE_BUCKET', buckets: [] };
  withR.sort((a, b) => a.r[0] - b.r[0]);
  if (withR.length < 2 || withR[0].r[0] !== -Infinity || withR.at(-1).r[1] !== Infinity) return { ok: false, reason: 'MISSING_TAIL', buckets: withR.map((x) => x.c) };
  for (let i = 1; i < withR.length; i += 1) if (withR[i].r[0] !== withR[i - 1].r[1] + 1) return { ok: false, reason: 'PARTITION_GAP_OR_OVERLAP', buckets: withR.map((x) => x.c) };
  return { ok: true, reason: null, buckets: withR.map((x) => x.c), ranges: withR.map((x) => x.r) };
}

export const bucketIndexOf = (ranges, value) => ranges.findIndex(([lo, hi]) => value >= lo && value <= hi);

// Modal bucket: highest probability; ties -> the lower bucket (deterministic, never outcome-dependent).
export function modalIndex(probs) {
  let k = -1;
  probs.forEach((p, i) => { if (p !== null && (k < 0 || p > probs[k])) k = i; });
  return k;
}

// Multiclass scores for one event. probs: one probability per ordered bucket (renormalised to sum 1, since bucket
// probabilities are computed and clamped per contract); win: index of the settled bucket.
export function eventScores(probs, win) {
  if (!probs.length || probs.some((p) => p === null || !(p >= 0)) || !(win >= 0 && win < probs.length)) return null;
  const s = probs.reduce((a, b) => a + b, 0);
  if (!(s > 0)) return null;
  const q = probs.map((p) => p / s);
  const k = modalIndex(q);
  return {
    modal: k, hit: k === win ? 1 : 0, p_modal: q[k], p_win: q[win], raw_sum: s,
    log_loss: -Math.log(Math.max(LL_FLOOR, q[win])),
    brier: q.reduce((a, p, i) => a + (p - (i === win ? 1 : 0)) ** 2, 0),
    // Ranked probability score: distance-aware (a near miss costs less than a far miss).
    rps: q.reduce((acc, _, i) => { const F = q.slice(0, i + 1).reduce((a, b) => a + b, 0); return acc + (F - (i >= win ? 1 : 0)) ** 2; }, 0) / Math.max(1, q.length - 1),
  };
}

// Distribution of the number of hits for independent Bernoulli(p_i) (Poisson-binomial), exact DP.
export function poissonBinomial(ps) {
  let d = [1];
  for (const p of ps) { const n = new Array(d.length + 1).fill(0); d.forEach((v, i) => { n[i] += v * (1 - p); n[i + 1] += v * p; }); d = n; }
  return d;
}
export function hitTail(ps, hits) {
  const d = poissonBinomial(ps);
  const le = d.slice(0, hits + 1).reduce((a, b) => a + b, 0); const ge = d.slice(hits).reduce((a, b) => a + b, 0);
  return { p_at_most: le, p_at_least: ge };
}

// Deterministic PRNG (same generator as the intraday shadow report).
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Cluster bootstrap of a mean difference. items: [{ cluster, a, b }] (b optional). Returns mean(a), mean(b), mean(a-b)
// and the percentile CI of mean(a-b) resampling whole clusters (e.g. climate dates: same-day stations share weather).
export function clusterBootstrap(items, { boot = 2000, seed = 20261010, level = 0.95 } = {}) {
  const keys = [...new Set(items.map((x) => x.cluster))].sort();
  const idx = new Map(keys.map((k, i) => [k, i]));
  const n = new Float64Array(keys.length); const A = new Float64Array(keys.length); const B = new Float64Array(keys.length);
  for (const x of items) { const i = idx.get(x.cluster); n[i] += 1; A[i] += x.a; B[i] += x.b ?? 0; }
  const N = n.reduce((u, v) => u + v, 0);
  const meanA = N ? A.reduce((u, v) => u + v, 0) / N : null; const meanB = N ? B.reduce((u, v) => u + v, 0) / N : null;
  const r = rng(seed); const ds = [];
  for (let b = 0; b < boot && keys.length; b += 1) {
    let nn = 0; let aa = 0; let bb = 0;
    for (let j = 0; j < keys.length; j += 1) { const k = Math.floor(r() * keys.length); nn += n[k]; aa += A[k]; bb += B[k]; }
    ds.push(nn ? (aa - bb) / nn : 0);
  }
  ds.sort((u, v) => u - v);
  const lo = (1 - level) / 2;
  return { n: N, clusters: keys.length, mean_a: meanA, mean_b: meanB, diff: N ? meanA - meanB : null,
    ci: ds.length ? [ds[Math.floor(lo * ds.length)], ds[Math.min(ds.length - 1, Math.ceil((1 - lo) * ds.length) - 1)]] : null };
}

// Market distribution from same-time venue quotes: stored mid, else a no-bid tail valued at half its ask (bounded
// between 0 and the ask). Returns null when any bucket has no usable quote. Never used as a model input.
export function marketDistribution(quotes) {
  const out = []; let approx = 0;
  for (const q of quotes) {
    const mid = num(q?.mid);
    if (mid !== null) { out.push(mid); continue; }
    const ask = num(q?.ask); const bid = num(q?.bid);
    if ((bid === null || bid === 0) && ask !== null && ask <= 0.05) { out.push(ask / 2); approx += 1; continue; }
    return null;
  }
  return { probs: out, approximated_tails: approx };
}

// Summary over scored events. events: [{ date, station, pbe: eventScores, market: eventScores|null }].
export function temperatureSkillSummary(events, { boot = 2000, seed = 20261010 } = {}) {
  const ps = events.map((e) => e.pbe.p_modal);
  const hits = events.reduce((a, e) => a + e.pbe.hit, 0);
  const expected = ps.reduce((a, b) => a + b, 0);
  const paired = events.filter((e) => e.market);
  const m = (arr, f) => (arr.length ? arr.reduce((a, e) => a + f(e), 0) / arr.length : null);
  const boot2 = (f, g) => clusterBootstrap(paired.map((e) => ({ cluster: e.date, a: f(e), b: g(e) })), { boot, seed });
  return {
    rules: TEMP_SKILL_RULES, events: events.length, dates: new Set(events.map((e) => e.date)).size,
    stations: new Set(events.map((e) => e.station)).size,
    top_bucket: { hits, expected, ...hitTail(ps, hits), mean_p_modal: m(events, (e) => e.pbe.p_modal) },
    pbe: { log_loss: m(events, (e) => e.pbe.log_loss), brier: m(events, (e) => e.pbe.brier), rps: m(events, (e) => e.pbe.rps) },
    market_paired: paired.length ? {
      events: paired.length, dates: new Set(paired.map((e) => e.date)).size,
      pbe_hits: paired.reduce((a, e) => a + e.pbe.hit, 0), pbe_expected: paired.reduce((a, e) => a + e.pbe.p_modal, 0),
      market_hits: paired.reduce((a, e) => a + e.market.hit, 0), market_expected: paired.reduce((a, e) => a + e.market.p_modal, 0),
      same_modal: paired.filter((e) => e.pbe.modal === e.market.modal).length,
      // pbe - market: negative = PBE better (lower loss). CI resamples whole climate dates.
      log_loss: boot2((e) => e.pbe.log_loss, (e) => e.market.log_loss),
      brier: boot2((e) => e.pbe.brier, (e) => e.market.brier),
      rps: boot2((e) => e.pbe.rps, (e) => e.market.rps),
    } : null,
  };
}
