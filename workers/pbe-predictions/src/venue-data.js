// Venue reads for the event record (benchmarks only — never a model or decision input). Predictions does NOT ingest
// Polymarket: it consumes the shared venue-neutral layer written by propsports-markets on the same database
// (market_contract_pairs_current = semantic gate, market_venue_contracts = rule text/hash + URL,
// market_venue_quotes_v2 = observations, market_training_batches = observer tick manifest / coverage).
const PM_TICK_GAP_MS = 15 * 60000; // a benchmark needs an observer tick within 15 min at or before T

// opts.since: only observations at/after this time (desk = latest quote only); opts.coverage=false skips the tick manifest
export async function polymarketForContracts(store, tickers, eventId, { since = null, coverage = true } = {}) {
  const empty = { byTicker: new Map(), related: [], ticks: [] };
  if (!tickers.length) return empty;
  let pairs;
  try {
    pairs = await store.selectIn('market_contract_pairs_current', { select: 'pair_key,a_venue,a_venue_market_id,a_outcome_id,b_venue,b_venue_market_id,b_outcome_id,canonical_event_id,canonical_contract_id,state,reasons,a_rule_sha256,b_rule_sha256,evaluated_at', b_venue: 'eq.kalshi', a_venue: 'eq.polymarket' }, 'b_venue_market_id', tickers, { order: 'id.asc' });
  } catch { return empty; } // the shared layer unavailable -> Kalshi-only record, never a broken page
  const eventPairs = eventId ? await store.select('market_contract_pairs_current', { select: 'a_venue_market_id,a_outcome_id,state,reasons,canonical_contract_id', canonical_event_id: `eq.${eventId}`, a_venue: 'eq.polymarket', state: 'eq.SAME_EVENT_DIFFERENT_OUTCOME' }, { order: 'id.asc' }).catch(() => []) : [];
  const attached = pairs.filter((p) => ['EXACT_MATCH', 'COMPARABLE_EXCEPT_EXCEPTIONS', 'RULE_MISMATCH', 'UNVERIFIED'].includes(p.state));
  const pmIds = [...new Set([...attached.map((p) => p.a_venue_market_id), ...eventPairs.map((p) => p.a_venue_market_id)])];
  if (!pmIds.length) return empty;
  const [contracts, quotes] = await Promise.all([
    store.selectIn('market_venue_contracts', { select: 'venue_market_id,outcome_id,outcome_label,title,market_url,rule_sha256,family,first_seen_at', venue: 'eq.polymarket' }, 'venue_market_id', pmIds, { order: 'id.asc' }),
    store.selectIn('market_venue_quotes_v2', { select: 'venue_market_id,outcome_id,observed_at,bid_bp,ask_bp,comparable_mid_bp,market_state,resolution_value_bp,observation_ref,archive_object_key', venue: 'eq.polymarket', ...(since ? { observed_at: `gte.${since}` } : {}) }, 'venue_market_id', pmIds, { order: 'observed_at.asc' }),
  ]);
  const meta = (id, out) => contracts.filter((c) => c.venue_market_id === id && (!out || c.outcome_id === out)).sort((a, b) => String(b.first_seen_at).localeCompare(String(a.first_seen_at)))[0] || null;
  const q = (id, out) => quotes.filter((r) => r.venue_market_id === id && r.outcome_id === out);
  const byTicker = new Map();
  for (const p of attached) {
    const m = meta(p.a_venue_market_id, p.a_outcome_id);
    const rows = q(p.a_venue_market_id, p.a_outcome_id);
    // stale gate result: the rule text we hold now differs from the text the gate read -> not comparable
    const rulesChanged = m?.rule_sha256 && p.a_rule_sha256 && m.rule_sha256 !== p.a_rule_sha256;
    byTicker.set(p.b_venue_market_id, { pair: p, state: rulesChanged ? 'UNVERIFIED' : p.state, reasons: rulesChanged ? [...(p.reasons || []), 'rules_changed_since_gate'] : (p.reasons || []), market_id: p.a_venue_market_id, outcome_id: p.a_outcome_id, url: m?.market_url ?? null, rules_sha256: m?.rule_sha256 ?? p.a_rule_sha256, title: m?.title ?? null, family: m?.family ?? null, rows, coverage_from: rows[0]?.observed_at ?? null });
  }
  const related = [];
  const seen = new Set();
  for (const p of eventPairs) {
    const k = `${p.a_venue_market_id}|${p.a_outcome_id}`;
    if (seen.has(k)) continue; seen.add(k);
    const m = meta(p.a_venue_market_id, p.a_outcome_id);
    const last = q(p.a_venue_market_id, p.a_outcome_id).at(-1);
    if (!m || !last) continue;
    related.push({ venue: 'polymarket', market_id: p.a_venue_market_id, title: m.title, outcome_label: m.outcome_label, url: m.market_url, semantic_class: p.state, reasons: p.reasons || [], native_mid_pct: last.comparable_mid_bp === null ? null : Math.round(Number(last.comparable_mid_bp) / 100), observed_at: last.observed_at });
  }
  // observer tick manifest across the record's time span (coverage check for at-or-before benchmarks)
  let ticks = [];
  const allRows = [...byTicker.values()].flatMap((v) => v.rows);
  if (coverage && allRows.length) {
    const from = allRows.reduce((a, r) => (r.observed_at < a ? r.observed_at : a), allRows[0].observed_at);
    ticks = (await store.select('market_training_batches', { select: 'observed_at', source: 'eq.polymarket', lane: 'in.(pm-tick,pm-canary)', observed_at: `gte.${from}` }, { order: 'observed_at.asc' }).catch(() => [])).map((r) => Date.parse(r.observed_at));
  }
  return { byTicker, related: related.slice(0, 12), ticks };
}

// coverageAt(T): an observer tick in [T - 15 min, T]. Before the tick manifest existed nothing is claimed.
export function coverageFromTicks(ticks) {
  if (!ticks.length) return null;
  return (T) => {
    const tt = Date.parse(T);
    let lo = 0; let hi = ticks.length - 1; let best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ticks[mid] <= tt) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 && tt - ticks[best] <= PM_TICK_GAP_MS;
  };
}
