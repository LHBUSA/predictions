// pbe-employment-collector: Employment Tier A collector on Cloudflare Workers (separate from pbe-predictions).
// Cloudflare-native: R2 is the authoritative evidence archive (write-once, sha256-verified, bucket-locked), a SQLite
// Durable Object holds scheduling state and the capture index, and a hash-chained audit ledger in R2 + the Durable Object
// seals every tick. No GitHub, git or SSH at runtime. The historical GitHub evidence repo is kept intact and read-only.
// MODE (var): "shadow" = R2 under shadow/ + namespace "shadow", never the authoritative archive; "authoritative" = R2 root
// + namespace "auth" (only after the owner approves the cutover); "off" = nothing.
// REHEARSAL (var, optional JSON {id, release}) adds an isolated cutoff-window rehearsal: Kalshi slots only, R2 under
// rehearsal/<id>/, its own namespace, no external alerts.
// Routes: GET /health (public, no secrets); /admin/* with Bearer ADMIN_TOKEN.
import { plan, slotTimes } from '../../../scripts/research/employment/collector/lib.mjs';
import { COLLECTOR_VERSION, indexView, kalshiSnapshot, tick } from './collector.js';
import { makeGet } from './http.js';
import { kalshiSigner } from './kalshi-auth.js';
import { chainEntries } from './ledger.js';
import { EvidenceStore } from './store.js';
import { dec, iso, sha256, sleep } from './util.js';
import { verify } from './verify.js';

export { CollectorState } from './state-do.js';

const NS = { shadow: 'shadow', authoritative: 'auth' };
const PREFIX = { shadow: 'shadow/', authoritative: '' };
const HOST = 'cloudflare-workers:pbe-employment-collector';
const prefixOf = (ns) => (ns === 'auth' ? '' : ns === 'shadow' ? 'shadow/' : `rehearsal/${ns.slice('rehearsal:'.length)}/`);

const stateStub = (env) => env.STATE.get(env.STATE.idFromName('employment-collector'));
export function codeIdentity(env) {
  return { version: COLLECTOR_VERSION, worker: 'pbe-employment-collector', commit: env.CODE_COMMIT || null, files: env.CODE_FILES || null, worker_version_id: env.CF_VERSION_METADATA?.id || null, worker_version_tag: env.CF_VERSION_METADATA?.tag || null, rules: 'scripts/research/employment/collector/lib.mjs (shared with the Windows collector)' };
}
function rehearsalOf(env) { try { return env.REHEARSAL ? JSON.parse(env.REHEARSAL) : null; } catch { return null; } }

async function deliverWebhook(env, title, message) {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return 'not configured';
  const ntfy = /^https:\/\/ntfy\.sh\/[A-Za-z0-9_-]+$/.test(url);
  const r = await fetch(url, ntfy
    ? { method: 'POST', headers: { Title: title, Priority: 'high', Tags: 'warning' }, body: message }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${title}: ${message}` }) });
  return r.status;
}

export async function makeContext(env, { mode, ns, prefix, calendarOverride = null, onlyKalshi = false, scheduledTime = null, fetchImpl = fetch }) {
  let signer = null; let authError = null;
  try { signer = await kalshiSigner(env); } catch (e) { authError = e.message; }
  const kalshiBase = env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
  const rawGet = makeGet({ fetchImpl, signer, kalshiBase });
  const metas = [];
  const get = async (u, o) => { const r = await rawGet(u, o); metas.push(r.meta); return r; };
  const authoritative = mode === 'authoritative';
  const deliver = mode === 'rehearsal' ? null : async (kind, message) => {
    if (!authoritative && env.SHADOW_ALERTS !== 'true') return { webhook: 'shadow: suppressed (SHADOW_ALERTS != true)' };
    try { return { webhook: await deliverWebhook(env, `${authoritative ? '' : '[SHADOW] '}Employment collector: ${kind}`, message) }; } catch (e) { return { webhook: `failed: ${String(e.message).slice(0, 120)}` }; }
  };
  const hc = authoritative ? env.HEALTHCHECK_URL : mode === 'shadow' ? env.SHADOW_HEALTHCHECK_URL : null;
  const healthPing = hc ? async (ok) => { try { await fetch(`${hc}${ok ? '' : '/fail'}`); } catch { /* the dead-man's switch alerts on silence anyway */ } } : null;
  return {
    mode, ns, store: new EvidenceStore(env.EVIDENCE, prefix), state: stateStub(env), get, kalshiBase, now: () => Date.now(), sleep,
    code: { ...codeIdentity(env), kalshi_auth: signer ? 'signed' : authError || 'not_configured' }, host: HOST, deliver, healthPing,
    calendarOverride, onlyKalshi, scheduledTime, lastFiles: () => metas,
  };
}

async function runAll(env, scheduledTime) {
  const out = {};
  const mode = env.MODE || 'off';
  if (NS[mode]) out[mode] = await tick(await makeContext(env, { mode, ns: NS[mode], prefix: PREFIX[mode], scheduledTime }));
  const r = rehearsalOf(env);
  if (r && Date.now() < Date.parse(r.release.release_at)) out.rehearsal = await tick(await makeContext(env, { mode: 'rehearsal', ns: `rehearsal:${r.id}`, prefix: `rehearsal/${r.id}/`, calendarOverride: [r.release], onlyKalshi: true, scheduledTime }));
  return out;
}

// Cutover step (owner-approved only): the historical Windows evidence is first uploaded byte-for-byte into the R2 root by
// scripts/upload-historical.mjs (from the git-verified clone; each object's sha256 checked by R2). This route then seeds
// the "auth" namespace FROM R2 (index, enabled_at, calendar) and opens the auth ledger chain with an IMPORT entry that
// seals every imported object's sha256. Refused once the auth namespace has ticked or been seeded.
async function seedAuthFromR2(env) {
  const state = stateStub(env); const st = await state.getState('auth');
  if (st.last_tick_utc || st.chain) return { error: 'auth namespace already active or seeded; refused' };
  const store = new EvidenceStore(env.EVIDENCE, '');
  const objects = (await store.list('')).filter((o) => !/^(shadow|rehearsal)\//.test(o.path));
  if (!objects.length) return { error: 'no historical evidence in the R2 root: run scripts/upload-historical.mjs first' };
  const rows = []; let cfg = null; let cal = null;
  for (const o of objects.filter((x) => x.path.endsWith('.json'))) {
    const j = JSON.parse(dec.decode(await store.getBytes(o.path))); const dir = o.path.replace(/\/[^/]+$/, '');
    if (o.path === 'collector.json') cfg = j;
    if (o.path === 'calendar/bls-empsit-schedule.json') cal = j;
    if (j.kind === 'KALSHI_SNAPSHOT') rows.push({ kind: 'KALSHI_SNAPSHOT', key: `${j.release.release_date}/${j.slot}`, ok: j.status === 'OK' && j.completed_before_slot === true, status: j.status, at: j.completed_utc, path: dir });
    if (j.kind === 'MISSED') rows.push({ kind: 'MISSED', key: `${j.release.release_date}/${j.slot}`, ok: false, at: j.detected_utc, path: dir });
    if (j.kind === 'KALSHI_SETTLEMENT') rows.push({ kind: 'KALSHI_SETTLEMENT', key: `${j.release.release_date}/${j.tag}`, ok: true, at: j.captured_utc, path: dir });
    if (j.kind === 'BLS_EMPSIT') rows.push({ kind: j.which === 'current' ? 'BLS_CURRENT' : 'BLS_ARCHIVE', key: j.release.reference_month, ok: j.status === 'OK', at: j.file?.response_completed_utc, path: dir });
    if (j.kind === 'DOL_WEEKLY_CLAIMS') rows.push({ kind: 'DOL_WEEKLY', key: dir.split('/').at(-1), ok: true, at: j.first_seen_utc, path: dir });
    if (j.kind === 'DOL_PRESS_ARCHIVE') rows.push({ kind: 'DOL_PRESS', key: dir.split('/').slice(-2).join('/'), ok: true, at: j.file?.response_completed_utc, path: dir });
  }
  for (const o of objects.filter((x) => /^kalshi\/terms\/[0-9a-f]{64}\.pdf$/.test(x.path))) rows.push({ kind: 'TERMS', key: o.path.slice(13, 77), ok: true });
  if (!cfg?.enabled_at) return { error: 'collector.json with enabled_at not found in the R2 root' };
  await state.addIndex('auth', rows);
  const { out, chain } = await chainEntries([{ type: 'IMPORT', at_utc: iso(Date.now()), collector: COLLECTOR_VERSION, mode: 'authoritative', note: 'Windows-collected evidence (historical GitHub repo, git-verified) uploaded byte-for-byte to the R2 root at cutover', index_rows: rows.length, files: objects.map((o) => ({ path: o.path, sha256: o.sha256, r2_uploaded_utc: o.uploaded })) }], null);
  const key = `ledger-ticks/${iso(Date.now()).slice(0, 7)}/${iso(Date.now()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_import.jsonl`;
  await store.put(key, out.map((x) => JSON.stringify(x)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'application/x-ndjson');
  await state.appendLedger('auth', out);
  await state.putState('auth', { enabled_at: cfg.enabled_at, calendar: cal?.releases || null, chain, last_ledger_key: key, seeded: { at_utc: iso(Date.now()), objects: objects.length, index_rows: rows.length } });
  return { objects: objects.length, index_rows: rows.length, enabled_at: cfg.enabled_at, chain };
}

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function authorized(req, env) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!env.ADMIN_TOKEN || got.length !== env.ADMIN_TOKEN.length) return false;
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(got), new TextEncoder().encode(env.ADMIN_TOKEN));
}

export default {
  async scheduled(event, env) { await runAll(env, event.scheduledTime); },
  async fetch(req, env) {
    const url = new URL(req.url); const mode = env.MODE || 'off'; const ns = url.searchParams.get('ns') || NS[mode] || 'shadow';
    const state = stateStub(env);
    if (url.pathname === '/health') {
      const hns = NS[mode] || 'shadow';
      const st = await state.getState(hns); const ticks = await state.ticks(hns, 1);
      const age = st.last_tick_utc ? Math.round((Date.now() - Date.parse(st.last_tick_utc)) / 1000) : null;
      const next = (st.calendar || []).flatMap((r) => slotTimes(r).map((s) => ({ key: `${r.release_date}/${s.slot}`, at: iso(s.at) }))).filter((s) => Date.parse(s.at) > Date.now()).slice(0, 3);
      const healthy = age !== null && age <= 900 && !ticks[0]?.error && !(st.unsealed || []).length;
      return json({ worker: 'pbe-employment-collector', mode, healthy, last_tick_utc: st.last_tick_utc || null, last_tick_age_s: age, last_tick: ticks[0] || null, last_error: st.last_error || null, ledger_chain: st.chain ? { seq: st.chain.seq, head: st.chain.head.slice(0, 16) } : null, unsealed_entries: (st.unsealed || []).length, next_slots: next, code: codeIdentity(env) }, healthy ? 200 : 503);
    }
    if (!url.pathname.startsWith('/admin/')) return json({ error: 'not_found' }, 404);
    if (!(await authorized(req, env))) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/admin/status') return json({ ns, state: await state.getState(ns), ticks: await state.ticks(ns, Number(url.searchParams.get('n') || 20)), ledger: await state.ledgerTail(ns, Number(url.searchParams.get('n') || 20)), code: codeIdentity(env) });
    if (url.pathname === '/admin/plan') {
      const st = await state.getState(ns); const r = rehearsalOf(env);
      const calendar = ns.startsWith('rehearsal:') ? [r?.release].filter(Boolean) : st.calendar || [];
      const at = url.searchParams.get('at') ? Date.parse(url.searchParams.get('at')) : Date.now();
      return json({ ns, at: iso(at), enabled_at: st.enabled_at || null, actions: plan(at, { calendar, enabledAt: Date.parse(st.enabled_at || iso(Date.now())), have: indexView(await state.index(ns)).have }).map((a) => ({ type: a.type, key: a.key || `${a.release.release_date}/${a.tag || a.type}`, slot_at: a.slot_at ? iso(a.slot_at) : undefined })) });
    }
    if (url.pathname === '/admin/verify') {
      const st = await state.getState(ns);
      return json(await verify({ store: new EvidenceStore(env.EVIDENCE, prefixOf(ns)), state, ns, chain: st.chain, prefix: url.searchParams.get('prefix') || '' }));
    }
    if (url.pathname === '/admin/tick' && req.method === 'POST') return json(await runAll(env, null));
    // Cutover step 1 (owner-approved only): one historical evidence file, byte-for-byte, into the R2 root. The body's sha256
    // must equal x-content-sha256; write-once like every other evidence write. Refused outside shadow mode, after seeding,
    // and for any path inside the shadow, rehearsal or live-ledger namespaces.
    if (url.pathname === '/admin/historical' && req.method === 'PUT') {
      if (mode !== 'shadow') return json({ error: 'historical upload only while MODE=shadow' }, 409);
      if ((await state.getState('auth')).chain) return json({ error: 'auth namespace already seeded' }, 409);
      const path = url.searchParams.get('path') || '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(path) || path.includes('..') || /^(shadow|rehearsal|ledger-ticks)\//.test(path)) return json({ error: 'path_not_allowed' }, 400);
      const bytes = new Uint8Array(await req.arrayBuffer());
      const got = await sha256(bytes);
      if (got !== req.headers.get('x-content-sha256')) return json({ error: 'sha256 mismatch: nothing written', got }, 422);
      const r = await new EvidenceStore(env.EVIDENCE, '').put(path, bytes);
      return json({ path: r.path, sha256: r.sha256, existed: r.existed });
    }
    if (url.pathname === '/admin/seed-auth' && req.method === 'POST') {
      if (mode !== 'shadow') return json({ error: 'seed only while MODE=shadow (before the authoritative deploy)' }, 409);
      return json(await seedAuthFromR2(env));
    }
    // labelled ADHOC capture of the next release, SHADOW namespace only (live side-by-side comparison; never a slot)
    if (url.pathname === '/admin/adhoc' && req.method === 'POST') {
      const c = await makeContext(env, { mode: 'shadow', ns: 'shadow', prefix: 'shadow/' });
      const st = await state.getState('shadow'); const rel = (st.calendar || []).find((r) => Date.parse(r.release_at) > Date.now());
      if (!rel) return json({ error: 'no calendar yet: wait for the first shadow tick' }, 409);
      c.ledger = () => {}; c.alert = async () => {};
      const s = await kalshiSnapshot(c, rel, 'ADHOC', null);
      return json({ dir: `shadow/kalshi/${rel.release_date}/ADHOC`, status: s.status, started_utc: s.started_utc, completed_utc: s.completed_utc, series: Object.fromEntries(Object.entries(s.series).map(([k, v]) => [k, { status: v.status, markets: v.markets_listed, orderbooks_ok: v.orderbooks_ok, fee: v.fee }])), kalshi_auth: c.code.kalshi_auth, files_written: c.store.written.length });
    }
    if (url.pathname === '/admin/test-alert' && req.method === 'POST') {
      // always exercises the webhook (even in shadow) so the channel itself is proven before cutover
      const msg = 'Validation of off-machine alert delivery (expected; no action needed).';
      let webhook; try { webhook = await deliverWebhook(env, `${mode === 'authoritative' ? '' : '[SHADOW] '}Employment collector: TEST`, msg); } catch (e) { webhook = `failed: ${e.message}`; }
      const hc = mode === 'authoritative' ? env.HEALTHCHECK_URL : env.SHADOW_HEALTHCHECK_URL; let healthcheck = 'not configured';
      if (hc) { try { healthcheck = (await fetch(hc)).status; } catch (e) { healthcheck = `failed: ${e.message}`; } }
      return json({ webhook, healthcheck });
    }
    return json({ error: 'not_found' }, 404);
  },
};
