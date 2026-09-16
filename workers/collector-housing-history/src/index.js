import { fail } from '../../_shared/contract.js';

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

async function captureBulk(env, scope) {
  if (!['states', 'metros'].includes(scope)) throw new TypeError('scope must be states or metros');
  const observations = await post(env.HOUSING_HISTORY, '/', {
    bulk: scope,
    quarters: 5,
    ...(scope === 'metros' ? { pageSize: 1000, maxPages: 6 } : {})
  });
  if (!Array.isArray(observations) || !observations.length) throw new Error(`No ${scope} HPI observations returned`);
  const persisted = await post(env.LEDGER, '/sources', { observations });
  return Object.freeze({
    scope: `${scope === 'states' ? 'state' : 'metro'}_hpi`,
    attempted: observations.length,
    captured: persisted.count,
    observationKeys: Object.freeze([...(persisted.observationKeys || [])]),
    vintages: Object.freeze([...new Set(observations.map((observation) => observation.vintage).filter(Boolean))]),
    capturedAtMin: observations.map((observation) => observation.capturedAt).sort()[0] || null,
    capturedAtMax: observations.map((observation) => observation.capturedAt).sort().at(-1) || null,
    completedAt: new Date().toISOString()
  });
}

async function captureAll(env) {
  const [states, metros] = await Promise.all([
    captureBulk(env, 'states'),
    captureBulk(env, 'metros')
  ]);
  return Object.freeze({
    states,
    metros,
    totalCaptured: states.captured + metros.captured,
    completedAt: new Date().toISOString()
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json().catch(() => ({}));
      const scope = body.scope || 'all';
      const result = scope === 'states'
        ? await captureBulk(env, 'states')
        : scope === 'metros'
          ? await captureBulk(env, 'metros')
          : scope === 'all'
            ? await captureAll(env)
            : null;
      if (!result) return fail('INVALID_SCOPE', 'scope must be states, metros, or all', 422);
      return Response.json({ ok: true, data: result, meta: { collector: 'housing-history-bulk-v2' } });
    } catch (error) {
      return fail('COLLECTOR_FAILED', error.message, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      captureAll(env)
        .then((result) => console.log(`housing history collector captured ${result.totalCaptured} national HPI snapshots`))
        .catch((error) => console.error('housing history collector failed', error))
    );
  }
};

export { captureBulk, captureAll };
