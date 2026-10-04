// Engine run ledger + scheduler lanes (owner 2026-10-04, Predictions Phases 2-3; sql/011).
// Three lanes dispatched by cron IDENTITY so their responsibilities cannot drift back together:
//   FAST     '* * * * *'  HOT weather lane, intraday weather, BTC SHADOW (unchanged)
//   CORE     CORE_CRON    core engine runCycle only (no newsroom call)
//   NEWSROOM newsroom only, consuming the latest SUCCESSFUL core run (never triggers another engine run)
// Every core/newsroom run claims an atomic DB lease (pred_engine_claim): a tick that cannot claim records
// SKIPPED_OVERLAP and stops, so two core engines never run concurrently. Transitions are append-only.
export const CRONS = Object.freeze({ FAST: '* * * * *', CORE: '*/15 * * * *', NEWSROOM: '7,22,37,52 * * * *' });
export const CORE_CADENCE_MIN = cadenceMinutes(CRONS.CORE);
export const LEASE_TTL_S = Object.freeze({ core: 600, newsroom: 600 }); // > any observed run; a crashed run frees itself
export const NEWSROOM_MAX_CORE_AGE_MIN = 30;

export function cadenceMinutes(cron) {
  const m = /^\*\/(\d+) /.exec(cron); if (m) return Number(m[1]);
  return cron.startsWith('* ') ? 1 : 15;
}
export function laneFor(cron) {
  return cron === CRONS.FAST ? 'fast' : cron === CRONS.CORE ? 'core' : cron === CRONS.NEWSROOM ? 'newsroom' : null;
}

// Counting wrappers: Supabase requests/writes (store fetch) and market-service requests (service binding).
export function countingFetch(base = globalThis.fetch) {
  const c = { requests: 0, writes: 0, errors: 0, rate_limited: 0 };
  const f = async (input, init) => {
    c.requests += 1; if (init?.method && init.method !== 'GET') c.writes += 1;
    try { const r = await base(input, init); if (!r.ok) { c.errors += 1; if (r.status === 429) c.rate_limited += 1; } return r; } catch (e) { c.errors += 1; throw e; }
  };
  return { fetch: f, counts: c };
}
export function countingBinding(binding) {
  const c = { requests: 0, errors: 0, rate_limited: 0 };
  return { binding: { fetch: async (...a) => { c.requests += 1; const r = await binding.fetch(...a); if (!r.ok) { c.errors += 1; if (r.status === 429) c.rate_limited += 1; } return r; } }, counts: c };
}

async function rpc(store, fn, args) {
  const res = await store.fetchImpl(new URL(`${store.url}/rest/v1/rpc/${fn}`), { method: 'POST', headers: { apikey: store.serviceKey, authorization: `Bearer ${store.serviceKey}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`rpc ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
const transition = (store, row) => store.write('pred_engine_runs', row, { conflictColumn: 'run_id,transition' });

// Run one lane under the lease with STARTED -> COMPLETED|FAILED transitions (or a lone SKIPPED_OVERLAP).
// work() returns { counts } ; its exceptions become FAILED. Returns { run_id, transition, duration_ms, counts }.
export async function runLane({ store, lane, cron, scheduledAt, workerVersion = null, work, now = () => new Date(), rand = () => Math.random().toString(36).slice(2, 8) }) {
  const run_id = `${lane}:${scheduledAt}:${rand()}`;
  const base = { run_id, lane, scheduled_at: scheduledAt, cron, worker_version: workerVersion };
  let claimed;
  try { claimed = await rpc(store, 'pred_engine_claim', { p_lane: lane, p_run_id: run_id, p_ttl_seconds: LEASE_TTL_S[lane] }); } catch (e) {
    // cannot prove the lane is free -> never run (fail closed); best-effort record
    await transition(store, { ...base, transition: 'FAILED', duration_ms: 0, error: `lease unavailable: ${String(e.message).slice(0, 300)}` }).catch(() => {});
    return { run_id, transition: 'FAILED', error: 'lease unavailable' };
  }
  if (claimed !== true) {
    await transition(store, { ...base, transition: 'SKIPPED_OVERLAP', duration_ms: 0 });
    return { run_id, transition: 'SKIPPED_OVERLAP' };
  }
  const t0 = now().getTime();
  try {
    await transition(store, { ...base, transition: 'STARTED', at: new Date(t0).toISOString() });
    let out = null; let err = null;
    try { out = await work(); } catch (e) { err = e; }
    const duration_ms = now().getTime() - t0;
    const row = { ...base, transition: err ? 'FAILED' : 'COMPLETED', duration_ms, counts: out?.counts || {}, error: err ? String(err.stack || err.message).slice(0, 1000) : null };
    await transition(store, row);
    return { run_id, transition: row.transition, duration_ms, counts: row.counts, error: row.error };
  } finally {
    await rpc(store, 'pred_engine_release', { p_lane: lane, p_run_id: run_id }).catch(() => {});
  }
}

export function coreCounts(summary, supa, mkt) {
  const s = summary || {};
  const errs = s.errors || [];
  return {
    events: s.events ?? 0, contracts: Object.values(s.contracts || {}).reduce((a, b) => a + b, 0), forecasts: s.forecasts ?? 0,
    venue_snapshots: s.venue_snapshots ?? 0, designations: s.designations ?? 0, resolutions: s.resolutions ?? 0, scores: s.scores ?? 0,
    errors: errs.length, market_backoff_errors: errs.filter((e) => /backoff/i.test(JSON.stringify(e))).length,
    market_requests: mkt?.requests ?? null, market_http_errors: mkt?.errors ?? null, market_rate_limited: mkt?.rate_limited ?? null,
    supabase_requests: supa?.requests ?? null, supabase_writes: supa?.writes ?? null, supabase_http_errors: supa?.errors ?? null, supabase_rate_limited: supa?.rate_limited ?? null,
  };
}

// Engine health for /api/summary from the run ledger + lease.
export async function engineHealth(store, { now = new Date().toISOString() } = {}) {
  const rows = await store.select('pred_engine_runs', { lane: 'eq.core', select: 'run_id,transition,scheduled_at,at,worker_version,duration_ms,counts,error' }, { limit: 40, order: 'transition_id.desc' });
  const lease = (await store.select('pred_engine_lease', { lane: 'eq.core', select: 'holder,claimed_at,expires_at' }, { limit: 1, order: 'lane.asc' }))[0] || null;
  return healthFrom(rows, lease, now);
}
export function healthFrom(rows, lease, now) {
  const ok = rows.find((r) => r.transition === 'COMPLETED') || null;
  const terminal = rows.find((r) => r.transition === 'COMPLETED' || r.transition === 'FAILED') || null;
  const running = !!(lease?.holder && Date.parse(lease.expires_at) > Date.parse(now));
  const ageMin = ok ? (Date.parse(now) - Date.parse(ok.at)) / 60000 : Infinity;
  const state = running ? 'running' : terminal?.transition === 'FAILED' ? 'failed' : ageMin > CORE_CADENCE_MIN * 2 + 5 ? 'delayed' : 'healthy';
  const recent = rows.filter((r) => r.transition !== 'STARTED');
  return {
    state, cadence_minutes: CORE_CADENCE_MIN,
    last_success: ok ? { run_id: ok.run_id, scheduled_at: ok.scheduled_at, completed_at: ok.at, duration_ms: ok.duration_ms, worker_version: ok.worker_version, counts: ok.counts } : null,
    last_failure: rows.find((r) => r.transition === 'FAILED') ? (({ at, error }) => ({ at, error: String(error || '').slice(0, 200) }))(rows.find((r) => r.transition === 'FAILED')) : null,
    running_since: running ? lease.claimed_at : null,
    recent: { completed: recent.filter((r) => r.transition === 'COMPLETED').length, failed: recent.filter((r) => r.transition === 'FAILED').length, skipped_overlap: recent.filter((r) => r.transition === 'SKIPPED_OVERLAP').length, window_runs: recent.length },
  };
}
