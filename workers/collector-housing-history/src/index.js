import { fail, ok } from '../../_shared/contract.js';

const STATE_CODES = Object.freeze([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
]);

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

async function captureState(state, env) {
  const observation = await post(env.HOUSING_HISTORY, '/', { geography: { state }, limit: 8 });
  const persisted = await post(env.LEDGER, '/source', observation);
  return Object.freeze({ state, observationKey: persisted.observationKey, vintage: observation.vintage, capturedAt: observation.capturedAt });
}

async function captureStates(env, states = STATE_CODES) {
  const results = [];
  const failures = [];
  for (let i = 0; i < states.length; i += 8) {
    const batch = states.slice(i, i + 8);
    const settled = await Promise.allSettled(batch.map(state => captureState(state, env)));
    settled.forEach((entry, index) => {
      const state = batch[index];
      if (entry.status === 'fulfilled') results.push(entry.value);
      else failures.push({ state, error: entry.reason?.message || String(entry.reason) });
    });
  }
  return Object.freeze({
    scope: 'state_hpi',
    attempted: states.length,
    captured: results.length,
    failed: failures.length,
    results: Object.freeze(results),
    failures: Object.freeze(failures),
    completedAt: new Date().toISOString()
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json().catch(() => ({}));
      const requested = Array.isArray(body.states) && body.states.length
        ? body.states.map(x => String(x).toUpperCase()).filter(x => STATE_CODES.includes(x))
        : STATE_CODES;
      const result = await captureStates(env, requested);
      const status = result.failed ? 207 : 200;
      return Response.json({ ok: result.failed === 0, data: result, meta: { collector: 'housing-history-state-v1' } }, { status });
    } catch (error) {
      return fail('COLLECTOR_FAILED', error.message, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      captureStates(env).then(result => {
        if (result.failed) console.error('housing history collector partial failure', JSON.stringify(result.failures));
        else console.log(`housing history collector captured ${result.captured} state snapshots`);
      }).catch(error => console.error('housing history collector failed', error))
    );
  }
};

export { STATE_CODES, captureState, captureStates };
