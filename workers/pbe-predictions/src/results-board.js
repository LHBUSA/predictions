// Read-only, member-gated Predictions scorecard. This is NOT the public
// track record or an official-pick publisher. There is no model retraining,
// resettlement, backfilling, or promotion of the FROZEN_PROSPECTIVE policy.
// Event-level favorite is the highest-probability *designated* temperature
// bucket (one event => one hit/miss), not a tally of easy NO contracts.
const num = x => x === null || x === undefined ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const valid = x => num(x) !== null && num(x) >= 0 && num(x) <= 1;
const key = x => String(x ?? '');
const txt = x => typeof x === 'string' ? x.slice(0, 230) : '';

export function assembleScorecard({ scores = [], forecasts = [], contracts = [], events = [], decisions = [] } = {}) {
  const fs = new Map(forecasts.map(f => [key(f.forecast_id), f]));
  const cs = new Map(contracts.map(c => [key(c.contract_id), c]));
  const evs = new Map(events.map(e => [key(e.event_id), e]));
  const scored = new Map();
  for (const s of scores) {
    if (s.designation !== 'FINAL_PRE_RESOLUTION' || s.scoring_method !== 'brier' || ![0, 1].includes(Number(s.outcome))) continue;
    const f = fs.get(key(s.forecast_id)); const c = cs.get(key(s.contract_id));
    if (!f || !c || f.model_state === 'SHADOW' || !valid(f.probability) || key(f.contract_id) !== key(s.contract_id)) continue;
    const prior = scored.get(key(s.contract_id));
    if (!prior || key(s.scored_at) > key(prior.s.scored_at)) scored.set(key(s.contract_id), { s, f, c });
  }

  const byEvent = new Map();
  for (const row of scored.values()) {
    if (row.c.event_type !== 'MAX_TEMP_BUCKET') continue;
    const id = key(row.c.event_id);
    if (!byEvent.has(id)) byEvent.set(id, []);
    byEvent.get(id).push(row);
  }
  const temperature = [];
  for (const [id, rows] of byEvent) {
    // One winner, at least two mutually exclusive outcomes, all the studied
    // outcomes settled. Never label independent rain or Treasury contracts as
    // a single event-level win.
    if (rows.length < 2 || rows.filter(r => Number(r.s.outcome) === 1).length !== 1) continue;
    const sorted = [...rows].sort((a,b) => num(b.f.probability) - num(a.f.probability) ||
      key(a.c.market_id).localeCompare(key(b.c.market_id)));
    const favorite = sorted[0], winner = rows.find(r => Number(r.s.outcome) === 1);
    const ev = evs.get(id);
    if (!ev || !ev.slug) continue;
    temperature.push({
      event_id: id, slug: txt(ev.slug), title: txt(ev.canonical_question),
      category: txt(ev.category), picked: txt(favorite.c.outcome_label),
      actual: txt(winner.c.outcome_label), probability_pct: Math.round(num(favorite.f.probability) * 100),
      forecast_at: favorite.f.captured_at || null, scored_at: favorite.s.scored_at || null,
      result: key(favorite.c.contract_id) === key(winner.c.contract_id) ? 'MATCHED' : 'MISSED',
      classification: 'DESCRIPTIVE_TOP_OUTCOME_NOT_OFFICIAL_PICK'
    });
  }
  temperature.sort((a,b)=>key(b.scored_at).localeCompare(key(a.scored_at)) || a.slug.localeCompare(b.slug));
  const matched = temperature.filter(r => r.result === 'MATCHED').length;

  // Only calls the prospective policy actually froze. A PASS/WAIT is never
  // counted as a call; a corrected record supersedes the original one.
  const corrected = new Set(decisions.filter(d=>d.correction_of).map(d=>key(d.correction_of)));
  const calls = [];
  for (const d of decisions) {
    if (d.state !== 'CALL' || !['YES','NO'].includes(d.side) || corrected.has(key(d.decision_id))) continue;
    const c = cs.get(key(d.contract_id));
    const ev = c ? evs.get(key(c.event_id)) : null;
    const s = scored.get(key(d.contract_id));
    // Grade ONLY the actual forecast locked by this decision and subsequently
    // scored; another model's forecast for the same contract cannot be reused.
    const out = s && key(s.f.forecast_id) === key(d.forecast_id) ? Number(s.s.outcome) : null;
    const correct = out === null ? null : (d.side === 'YES') === (out === 1);
    calls.push({
      slug: txt(ev?.slug), title: txt(ev?.canonical_question),
      label: txt(c?.outcome_label), side: d.side, probability_pct: valid(d.probability) ? Math.round(num(d.probability)*100) : null,
      decided_at: d.decision_as_of || null,
      official: d.official_at_decision === true && d.policy_status === 'OFFICIAL',
      policy_status: txt(d.policy_status),
      result: correct === null ? 'PENDING' : correct ? 'MATCHED' : 'MISSED',
      actual: out === null ? null : out === 1 ? 'YES' : 'NO'
    });
  }
  calls.sort((a,b)=>key(b.decided_at).localeCompare(key(a.decided_at)));
  const active = calls.filter(x=>x.official), research = calls.filter(x=>!x.official);
  const count = arr => ({
    calls: arr.length,
    matched: arr.filter(x=>x.result==='MATCHED').length,
    missed: arr.filter(x=>x.result==='MISSED').length,
    pending: arr.filter(x=>x.result==='PENDING').length
  });
  return {
    schema: 'pbe-scorecard/1', generated_at: new Date().toISOString(),
    unit: 'completed_temperature_events',
    top_outcome: { ...count(temperature), events: temperature.length, rows: temperature.slice(0, 30) },
    official: { ...count(active), rows: active.slice(0, 30) },
    prospective: { ...count(research), rows: research.slice(0, 30) },
    disclaimers: [
      'Top outcome is the largest locked model probability in each completed temperature event, evaluated against the actual winning bucket. It is not an official decision or a bet.',
      'Prospective CALL records were frozen before resolution for research. They are NOT official PBE Picks; PASS records are excluded.',
      'Independent rain and rate thresholds are not counted as event-level weather-bucket wins. No backfilled picks or win claims.'
    ]
  };
}

let cache = null, pending = null;
const TTL = 60_000;
export async function memberScorecard(store, { fresh = false, now = Date.now } = {}) {
  if (!fresh && cache && now() - cache.at < TTL) return cache.result;
  if (!fresh && pending) return pending;
  const work = (async () => {
    const [scores, decisions] = await Promise.all([
      store.select('pred_scores', {
        select: 'contract_id,forecast_id,designation,scoring_method,outcome,scored_at',
        designation: 'eq.FINAL_PRE_RESOLUTION', scoring_method: 'eq.brier'
      }, { order: 'scored_at.desc' }), // no row cap: the hit/miss totals must cover every graded row (store pages in 1000s)
      store.select('pred_decisions', {
        select: 'decision_id,contract_id,forecast_id,state,side,probability,decision_as_of,policy_status,official_at_decision,correction_of',
        state: 'eq.CALL'
      }) // no row cap: every frozen CALL is counted
    ]);
    const cids = [...new Set([...scores, ...decisions].map(x=>x.contract_id).filter(Boolean))];
    const fids = [...new Set([...scores, ...decisions].map(x=>x.forecast_id).filter(Boolean))];
    if (!cids.length) return assembleScorecard();
    const [contracts, forecasts] = await Promise.all([
      store.selectIn('pred_contracts', { select: 'contract_id,event_id,market_id,outcome_label,event_type' }, 'contract_id', cids, { chunkSize: 75 }),
      store.selectIn('pred_forecasts', { select: 'forecast_id,contract_id,probability,captured_at,model_state' }, 'forecast_id', fids, { chunkSize: 75 })
    ]);
    const eventIds = [...new Set(contracts.map(c=>c.event_id).filter(Boolean))];
    const events = eventIds.length ? await store.selectIn('pred_events', {select: 'event_id,slug,canonical_question,category'}, 'event_id', eventIds, {chunkSize: 75}) : [];
    return assembleScorecard({ scores, decisions, contracts, forecasts, events });
  })();
  pending = work;
  try {
    const result = await work;
    cache = {at:now(),result};
    return result;
  } finally { if(pending===work)pending=null; }
}
