// Read-only, member-gated Predictions scorecard. Official PBE Picks (activated 2026-10-09) are graded here as
// RIGHT (stored key MATCHED) / MISSED / PENDING / VOID from their own locked forecast only. There is no model
// retraining, resettlement or backfilling: a research call made before activation never becomes official.
// Event-level favorite is the highest-probability *designated* temperature
// bucket (one event => one hit/miss), not a tally of easy NO contracts.
import { DECISION_POLICY } from '../../../src/engine/decision.js';
import { orderBuckets, eventScores, temperatureSkillSummary, marketDistribution, TEMP_SKILL_RULES } from '../../../src/weather/temp-skill.js';

const P = DECISION_POLICY;
export const OFFICIAL_POLICY = Object.freeze({ status: P.status, activated_at: P.activated_at, candidate: P.candidate, version: P.version, official_policy: P.official_policy,
  scope: 'Rain YES/NO (pbe-weather-precip): HIGH-grade forecast, PBE >= 70% YES or <= 30% NO, no YES calls Jun-Sep, nothing near-certain (>= 97%), evidence <= 12 h old' });
const num = x => x === null || x === undefined ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const valid = x => num(x) !== null && num(x) >= 0 && num(x) <= 1;
const key = x => String(x ?? '');
const txt = x => typeof x === 'string' ? x.slice(0, 230) : '';

// Temperature skill (issue #64): an event counts only if its whole ladder (low tail, 2 °F buckets, high tail) partitions
// the integers and every bucket has a designated, scored forecast with exactly one winner. The hit count is set against
// its own expectation (sum of the chosen buckets' probabilities) and against the market's favourite at the SAME capture
// (the venue snapshot stored with the forecast; no-bid tails valued at half their ask). Full-distribution scores
// compare the whole ladder. Verdicts need >= MIN_SKILL_DAYS independent climate dates.
export const MIN_SKILL_DAYS = 10;
const evidenceValue = (ev, label) => { const x = Array.isArray(ev) ? ev.find((e) => String(e?.label || '').startsWith(label)) : null; return x && Number.isFinite(Number(x.value)) ? Number(x.value) : null; };

// requireLadder (the member route): an event whose ladder was not found is excluded (NO_LADDER), never counted on its
// scored rows alone.
export function assembleScorecard({ scores = [], forecasts = [], contracts = [], events = [], decisions = [], voids = [], ladders = [], resolutions = [], quotes = [], requireLadder = false } = {}) {
  const voided = new Set(voids.filter((r) => String(r.venue_result).toLowerCase() === 'void').map((r) => key(r.contract_id)));
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
  const temperature = []; const skillEvents = []; const excluded = {};
  const ladderBy = new Map(); for (const c of ladders) { const k = key(c.event_id); if (!ladderBy.has(k)) ladderBy.set(k, []); ladderBy.get(k).push(c); }
  const resBy = new Map(resolutions.map((r) => [key(r.contract_id), r]));
  const quoteBy = new Map(quotes.map((q) => [key(q.snapshot_key), q]));
  const exclude = (why) => { excluded[why] = (excluded[why] || 0) + 1; };
  for (const [id, rows] of byEvent) {
    // One winner, at least two mutually exclusive outcomes, all the studied
    // outcomes settled. Never label independent rain or Treasury contracts as
    // a single event-level win.
    if (rows.length < 2 || rows.filter(r => Number(r.s.outcome) === 1).length !== 1) { exclude('NOT_ONE_WINNER_OR_TOO_FEW'); continue; }
    const ev = evs.get(id);
    if (!ev || !ev.slug) { exclude('NO_EVENT'); continue; }
    const lad = ladderBy.get(id);
    if (!lad && requireLadder) { exclude('NO_LADDER'); continue; }
    let ordered = null;
    if (lad) {
      const ob = orderBuckets(lad);
      if (!ob.ok) { exclude(ob.reason); continue; }
      const byC = new Map(rows.map((r) => [key(r.c.contract_id), r]));
      ordered = ob.buckets.map((c) => byC.get(key(c.contract_id)));
      if (ordered.some((r) => !r)) { exclude('INCOMPLETE_LADDER'); continue; } // an unscored bucket could have been the favourite or the winner
    }
    const sorted = [...rows].sort((a,b) => num(b.f.probability) - num(a.f.probability) ||
      key(a.c.market_id).localeCompare(key(b.c.market_id)));
    const winner = rows.find(r => Number(r.s.outcome) === 1);
    // With a ladder the favourite is the skill block's modal bucket (ties -> the lower bucket), so both counts agree.
    const pbeOrdered = ordered ? eventScores(ordered.map((r) => num(r.f.probability)), ordered.indexOf(winner)) : null;
    const favorite = pbeOrdered ? ordered[pbeOrdered.modal] : sorted[0];
    const row = {
      event_id: id, slug: txt(ev.slug), title: txt(ev.canonical_question),
      category: txt(ev.category), picked: txt(favorite.c.outcome_label),
      actual: txt(winner.c.outcome_label), probability_pct: Math.round(num(favorite.f.probability) * 100),
      forecast_at: favorite.f.captured_at || null, scored_at: favorite.s.scored_at || null,
      result: key(favorite.c.contract_id) === key(winner.c.contract_id) ? 'MATCHED' : 'MISSED',
      classification: 'DESCRIPTIVE_TOP_OUTCOME_NOT_OFFICIAL_PICK'
    };
    if (ordered) {
      const win = ordered.indexOf(winner);
      const pbe = pbeOrdered;
      const q = ordered.map((r) => { const z = quoteBy.get(key(r.f.market_snapshot_key)); return { mid: valid(r.f.market_probability) ? num(r.f.market_probability) : null, bid: z ? num(z.bid) : null, ask: z ? num(z.ask) : null, active: z ? z.market_status === 'active' : true }; });
      const md = q.every((x) => x.mid !== null || x.active) ? marketDistribution(q) : null;
      // same [0.01, 0.99] bounds as PBE's bucket probabilities, so a 0.5 c tail cannot tilt the log loss
      const market = md ? eventScores(md.probs.map((p) => Math.min(0.99, Math.max(0.01, p))), win) : null;
      const official = num(resBy.get(key(winner.c.contract_id))?.official_value);
      const nbm = evidenceValue(favorite.f.evidence, 'National Blend');
      Object.assign(row, { expected_pct: pbe ? Math.round(pbe.p_modal * 100) : null,
        market_picked: market ? txt(ordered[market.modal].c.outcome_label) : null, market_pct: market ? Math.round(market.p_modal * 100) : null,
        market_result: market ? (market.hit ? 'MATCHED' : 'MISSED') : null,
        official_f: official, nbm_f: nbm, error_f: official !== null && nbm !== null ? official - nbm : null, confidence: txt(favorite.f.confidence) || null });
      if (pbe) skillEvents.push({ date: txt(favorite.c.climate_date || favorite.c.detail?.climate_date) || key(id), station: txt(favorite.c.station_id), city: txt(favorite.c.city_label || favorite.c.detail?.city_label) || txt(favorite.c.station_id), error_f: row.error_f, pbe, market });
    }
    temperature.push(row);
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
      result: voided.has(key(d.contract_id)) ? 'VOID' : correct === null ? 'PENDING' : correct ? 'MATCHED' : 'MISSED',
      actual: voided.has(key(d.contract_id)) ? 'VOID' : out === null ? null : out === 1 ? 'YES' : 'NO'
    });
  }
  calls.sort((a,b)=>key(b.decided_at).localeCompare(key(a.decided_at)));
  const active = calls.filter(x=>x.official), research = calls.filter(x=>!x.official);
  const count = arr => ({
    calls: arr.length,
    matched: arr.filter(x=>x.result==='MATCHED').length,
    missed: arr.filter(x=>x.result==='MISSED').length,
    pending: arr.filter(x=>x.result==='PENDING').length,
    void: arr.filter(x=>x.result==='VOID').length
  });
  const temperatureSkill = skillEvents.length ? (() => {
    const sum = temperatureSkillSummary(skillEvents);
    const cities = new Map(); for (const e of skillEvents) { if (!cities.has(e.city)) cities.set(e.city, []); cities.get(e.city).push(e); }
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null); const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
    const verdict = (b) => (!b || b.clusters < MIN_SKILL_DAYS ? 'TOO_FEW_DAYS' : b.ci[1] < 0 ? 'PBE_AHEAD' : b.ci[0] > 0 ? 'MARKET_AHEAD' : 'NOT_ESTABLISHED');
    return { rules: TEMP_SKILL_RULES, product: 'pre-window temperature (FINAL_PRE_RESOLUTION, model v1.x)', events: sum.events, dates: sum.dates, stations: sum.stations, excluded,
      top_bucket: sum.top_bucket, pbe: sum.pbe, market: sum.market_paired ? { ...sum.market_paired, verdict_log_loss: verdict(sum.market_paired.log_loss), verdict_brier: verdict(sum.market_paired.brier) } : null,
      min_days_for_verdict: MIN_SKILL_DAYS,
      by_city: [...cities].map(([city, list]) => { const errs = list.map((e) => e.error_f).filter((x) => x !== null);
        return { city, events: list.length, nbm_bias_f: r1(mean(errs)), nbm_mae_f: r1(mean(errs.map(Math.abs))), expected_hits: Math.round(list.reduce((a, e) => a + e.pbe.p_modal, 0) * 10) / 10, hits: list.reduce((a, e) => a + e.pbe.hit, 0) }; })
        .sort((a, b) => a.city.localeCompare(b.city)) };
  })() : null;
  return {
    schema: 'pbe-scorecard/1', generated_at: new Date().toISOString(),
    unit: 'completed_temperature_events',
    top_outcome: { ...count(temperature), events: temperature.length, rows: temperature },
    temperature_skill: temperatureSkill,
    official: { ...count(active), rows: active, policy: OFFICIAL_POLICY },
    prospective: { ...count(research), rows: research },
    disclaimers: [
      'Top outcome is the largest locked model probability in each completed temperature event, evaluated against the actual winning bucket. It is not an official decision or a bet.',
      'Official PBE Picks: rain YES/NO calls by the frozen rain-v1 policy whose forecast was locked at/after activation (2026-10-09 21:15 UTC). RIGHT/MISSED from the venue settlement; VOID when the venue cancelled the contract (excluded from the record).',
      'Prospective CALL records frozen before activation stay research. They are NOT official PBE Picks; PASS records are excluded.',
      'Independent rain and rate thresholds are not counted as event-level weather-bucket wins. No backfilled picks or win claims.'
    ]
  };
}

let cache = null; // a plain result object (never a Response or a promise shared across requests)
const TTL = 60_000;
// Display window: counts always cover every row; `limit` only trims the row lists (homepage preview asks for 5).
export function limitRows(card, limit) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : null;
  if (!n) return card;
  const cut = (g) => (g ? { ...g, rows: (g.rows || []).slice(0, n) } : g);
  return { ...card, top_outcome: cut(card.top_outcome), official: cut(card.official), prospective: cut(card.prospective) };
}

export async function memberScorecard(store, { fresh = false, now = Date.now } = {}) {
  if (!fresh && cache && now() - cache.at < TTL) return cache.result;
  const work = async () => {
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
    const callIds = [...new Set(decisions.map(x=>x.contract_id).filter(Boolean))];
    const fids = [...new Set([...scores, ...decisions].map(x=>x.forecast_id).filter(Boolean))];
    if (!cids.length) return assembleScorecard();
    const [contracts, forecasts, voids] = await Promise.all([
      store.selectIn('pred_contracts', { select: 'contract_id,event_id,market_id,outcome_label,event_type,station_id,climate_date:detail->>climate_date,city_label:detail->>city_label' }, 'contract_id', cids, { chunkSize: 75 }),
      store.selectIn('pred_forecasts', { select: 'forecast_id,contract_id,probability,captured_at,model_state,market_probability,market_snapshot_key,confidence,evidence:explanation->evidence' }, 'forecast_id', fids, { chunkSize: 75 }),
      callIds.length ? store.selectIn('pred_resolutions', { select: 'contract_id,venue_result', venue_result: 'eq.void' }, 'contract_id', callIds, { chunkSize: 75 }) : []
    ]);
    const eventIds = [...new Set(contracts.map(c=>c.event_id).filter(Boolean))];
    // Temperature ladders: every NORMALIZED bucket of each scored temperature event (to prove exhaustiveness; one row per
    // market, newest normalisation), the official value, and the exact venue snapshot each temperature forecast stored
    // (only for no-bid tails without a mid).
    const tempEvents = [...new Set(contracts.filter((c) => c.event_type === 'MAX_TEMP_BUCKET').map((c) => c.event_id))];
    const [events, ladderRows] = await Promise.all([
      eventIds.length ? store.selectIn('pred_events', {select: 'event_id,slug,canonical_question,category'}, 'event_id', eventIds, {chunkSize: 75}) : [],
      tempEvents.length ? store.selectIn('pred_contracts', { select: 'contract_id,event_id,market_id,comparator,threshold_low,threshold_high,normalized_at', normalization_status: 'eq.NORMALIZED' }, 'event_id', tempEvents, { chunkSize: 75 }) : []
    ]);
    const latest = new Map(); for (const c of ladderRows) { const k = `${c.event_id}|${c.market_id}`; const p = latest.get(k); if (!p || String(c.normalized_at) > String(p.normalized_at)) latest.set(k, c); }
    const ladders = [...latest.values()];
    const tempIds = ladders.map((c) => c.contract_id); const tempSet = new Set(tempIds);
    const keys = [...new Set(forecasts.filter((f) => tempSet.has(f.contract_id) && f.market_snapshot_key && (f.market_probability === null || f.market_probability === undefined)).map((f) => f.market_snapshot_key))];
    const [resolutions, quotes] = await Promise.all([
      tempIds.length ? store.selectIn('pred_resolutions', { select: 'contract_id,official_value' }, 'contract_id', tempIds, { chunkSize: 75 }) : [],
      keys.length ? store.selectIn('pred_venue_snapshots', { select: 'snapshot_key,bid,ask,market_status' }, 'snapshot_key', keys, { chunkSize: 40 }) : []
    ]);
    return assembleScorecard({ scores, decisions, contracts, forecasts, events, voids, ladders, resolutions, quotes, requireLadder: true });
  };
  const result = await work();
  cache = { at: now(), result };
  return result;
}
