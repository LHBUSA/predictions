import { fail } from '../../_shared/contract.js';

const STATES = Object.freeze([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
]);
const PERMIT_SHARDS = 7;
const LEDGER_BATCH_SIZE = 500;

async function post(binding, path, body) {
  if (!binding || typeof binding.fetch !== 'function') throw new TypeError(`${path} binding is required`);
  const response = await binding.fetch(`https://internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message || payload?.error || `${path} failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

function chunks(items, size = LEDGER_BATCH_SIZE) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function persist(env, observations) {
  if (!Array.isArray(observations) || !observations.length) {
    return Object.freeze({ submitted: 0, observationKeys: Object.freeze([]), ledgerBatches: 0 });
  }
  const keys = [];
  const batches = chunks(observations);
  for (const batch of batches) {
    const persisted = await post(env.LEDGER, '/sources', { observations: batch });
    keys.push(...(persisted.observationKeys || []));
  }
  return Object.freeze({
    submitted: observations.length,
    observationKeys: Object.freeze(keys),
    ledgerBatches: batches.length
  });
}

async function captureMortgage(env) {
  const observation = await post(env.SOURCE_MACRO, '/', {
    seriesKey: 'mortgage30',
    limit: 8,
    outputUnits: 'percent'
  });
  const persisted = await persist(env, [observation]);
  return Object.freeze({
    source: 'mortgage30',
    vintage: observation.vintage || null,
    revision: observation.revision || null,
    ...persisted
  });
}

async function captureZoriScope(env, scope) {
  if (!['states', 'metros'].includes(scope)) throw new TypeError('ZORI scope must be states or metros');
  const observations = await post(env.SOURCE_ZORI, '/', { bulk: scope });
  if (!Array.isArray(observations) || !observations.length) throw new Error(`No ${scope} ZORI observations returned`);
  const persisted = await persist(env, observations);
  return Object.freeze({
    source: `zori_${scope}`,
    returned: observations.length,
    vintages: Object.freeze([...new Set(observations.map((item) => item.vintage).filter(Boolean))]),
    ...persisted
  });
}

async function captureZoriAll(env) {
  const [states, metros] = await Promise.all([
    captureZoriScope(env, 'states'),
    captureZoriScope(env, 'metros')
  ]);
  return Object.freeze({
    source: 'zori_all',
    states,
    metros,
    submitted: states.submitted + metros.submitted
  });
}

function permitStatesForShard(shard) {
  const index = Number(shard);
  if (!Number.isInteger(index) || index < 0 || index >= PERMIT_SHARDS) {
    throw new TypeError(`permit shard must be an integer from 0 to ${PERMIT_SHARDS - 1}`);
  }
  return STATES.filter((_, position) => position % PERMIT_SHARDS === index);
}

async function capturePermitStates(env, states) {
  const requested = [...new Set((states || []).map((state) => String(state).trim().toUpperCase()).filter(Boolean))];
  if (!requested.length) throw new TypeError('at least one permit state is required');
  const settled = await Promise.allSettled(requested.map((state) => post(env.SOURCE_PERMITS, '/', {
    geography: { state },
    maxProbeMonths: 5
  })));
  const observations = [];
  const failures = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') observations.push(result.value);
    else failures.push(Object.freeze({ state: requested[index], error: result.reason?.message || String(result.reason) }));
  });
  const persisted = await persist(env, observations);
  return Object.freeze({
    source: 'permits_states',
    attempted: requested.length,
    returned: observations.length,
    failed: failures.length,
    failures: Object.freeze(failures),
    vintages: Object.freeze([...new Set(observations.map((item) => item.vintage).filter(Boolean))]),
    ...persisted
  });
}

function scheduledPermitShard(scheduledTime = Date.now()) {
  return new Date(scheduledTime).getUTCDay();
}

async function settle(name, promise, healthy = () => true) {
  try {
    const data = await promise;
    if (!healthy(data)) {
      return Object.freeze({
        name,
        ok: false,
        data,
        error: `${name} completed with ${data?.failed ?? 'partial'} failed source requests`
      });
    }
    return Object.freeze({ name, ok: true, data });
  } catch (error) {
    return Object.freeze({ name, ok: false, error: error?.message || String(error) });
  }
}

async function captureScheduledSignals(env, scheduledTime = Date.now()) {
  const permitShard = scheduledPermitShard(scheduledTime);
  const permitStates = permitStatesForShard(permitShard);
  const results = await Promise.all([
    settle('mortgage30', captureMortgage(env)),
    settle('zori_all', captureZoriAll(env)),
    settle('permits_states', capturePermitStates(env, permitStates), (data) => data.failed === 0)
  ]);
  return Object.freeze({
    permitShard,
    permitStates: Object.freeze(permitStates),
    results: Object.freeze(results),
    ok: results.every((item) => item.ok),
    completedAt: new Date().toISOString()
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json().catch(() => ({}));
      const scope = body.scope || 'all';
      if (scope === 'mortgage') return Response.json({ ok: true, data: await captureMortgage(env) });
      if (scope === 'zori_states') return Response.json({ ok: true, data: await captureZoriScope(env, 'states') });
      if (scope === 'zori_metros') return Response.json({ ok: true, data: await captureZoriScope(env, 'metros') });
      if (scope === 'zori_all') return Response.json({ ok: true, data: await captureZoriAll(env) });
      if (scope === 'permits') {
        const states = Array.isArray(body.states)
          ? body.states
          : permitStatesForShard(body.shard ?? scheduledPermitShard());
        return Response.json({ ok: true, data: await capturePermitStates(env, states) });
      }
      if (scope === 'all') {
        const result = await captureScheduledSignals(env, body.scheduledTime || Date.now());
        return Response.json({ ok: result.ok, data: result }, { status: result.ok ? 200 : 207 });
      }
      return fail('INVALID_SCOPE', 'scope must be mortgage, zori_states, zori_metros, zori_all, permits, or all', 422);
    } catch (error) {
      return fail('COLLECTOR_FAILED', error.message, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      captureScheduledSignals(env, event?.scheduledTime || Date.now())
        .then((result) => {
          const level = result.ok ? 'log' : 'error';
          console[level](`housing signals collector completed: ${JSON.stringify(result)}`);
        })
        .catch((error) => console.error('housing signals collector failed', error))
    );
  }
};

export {
  STATES,
  PERMIT_SHARDS,
  LEDGER_BATCH_SIZE,
  captureMortgage,
  captureZoriScope,
  captureZoriAll,
  capturePermitStates,
  captureScheduledSignals,
  permitStatesForShard,
  scheduledPermitShard
};
