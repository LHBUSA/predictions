// pbe-employment-collector: Employment Tier A collector on Cloudflare Workers (separate from pbe-predictions).
// MODE (var): "shadow" = R2 under shadow/ + Durable Object namespace "shadow", never writes GitHub, never the authoritative
// evidence; "authoritative" = R2 root + namespace "auth" + GitHub mirror of LHBUSA/pbe-employment-evidence; "off" = nothing.
// REHEARSAL (var, optional JSON {id, release}) adds an isolated cutoff-window rehearsal: Kalshi slots only, R2 under
// rehearsal/<id>/, its own namespace, no GitHub, no external alerts.
// Routes: GET /health (public, no secrets); /admin/* with Bearer ADMIN_TOKEN.
import { plan, slotTimes } from '../../../scripts/research/employment/collector/lib.mjs';
import { COLLECTOR_VERSION, indexView, tick } from './collector.js';
import { GitHubMirror } from './github.js';
import { makeGet } from './http.js';
import { kalshiSigner } from './kalshi-auth.js';
import { EvidenceStore } from './store.js';
import { dec, gitBlobSha, iso, sleep } from './util.js';
import { verify } from './verify.js';

export { CollectorState } from './state-do.js';

const NS = { shadow: 'shadow', authoritative: 'auth' };
const PREFIX = { shadow: 'shadow/', authoritative: '' };
const HOST = 'cloudflare-workers:pbe-employment-collector';

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
  const mirror = authoritative && env.GITHUB_TOKEN ? new GitHubMirror({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO || 'LHBUSA/pbe-employment-evidence', fetchImpl }) : null;
  const deliver = mode === 'rehearsal' ? null : async (kind, message) => {
    const title = `${authoritative ? '' : '[SHADOW] '}Employment collector: ${kind}`;
    const results = {};
    if (authoritative || env.SHADOW_ALERTS === 'true') { try { results.webhook = await deliverWebhook(env, title, message); } catch (e) { results.webhook = `failed: ${String(e.message).slice(0, 120)}`; } }
    if (mirror) { try { results.github_issue = await mirror.createIssue(`${title} (${iso(Date.now()).slice(0, 10)})`, `${message}\n\nat ${iso(Date.now())} from ${HOST} (${COLLECTOR_VERSION}, worker version ${env.CF_VERSION_METADATA?.id || 'n/a'})`); } catch (e) { results.github_issue = `failed: ${String(e.message).slice(0, 120)}`; } }
    return results;
  };
  const hc = authoritative ? env.HEALTHCHECK_URL : mode === 'shadow' ? env.SHADOW_HEALTHCHECK_URL : null;
  const healthPing = hc ? async (ok) => { try { await fetch(`${hc}${ok ? '' : '/fail'}`); } catch { /* the dead-man's switch alerts on silence anyway */ } } : null;
  return {
    mode, ns, store: new EvidenceStore(env.EVIDENCE, prefix), state: stateStub(env), get, kalshiBase, now: () => Date.now(), sleep,
    code: { ...codeIdentity(env), kalshi_auth: signer ? 'signed' : authError || 'not_configured' }, host: HOST, mirror, deliver, healthPing,
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

// Cutover: copy the GitHub evidence (head of main) into R2 at the authoritative root, byte-for-byte (git object id checked),
// and seed the "auth" namespace from it. Ledger files are kept under ledger-imported/<head>/ because the mirror keeps
// appending to them in GitHub. Refused once the auth namespace has ticked.
async function importFromGitHub(env) {
  const state = stateStub(env); const st = await state.getState('auth');
  if (st.last_tick_utc) return { error: 'auth namespace already active; import refused' };
  const gh = new GitHubMirror({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO || 'LHBUSA/pbe-employment-evidence' });
  const head = await gh.head(); const store = new EvidenceStore(env.EVIDENCE, '');
  const copied = []; const rows = []; const json = {};
  for (const f of await gh.treeFiles(head)) {
    const bytes = await gh.blob(f.sha);
    if ((await gitBlobSha(bytes)) !== f.sha) return { error: `blob mismatch ${f.path}` };
    const path = /^ledger\/[^/]+\.jsonl$/.test(f.path) ? `ledger-imported/${head}/${f.path}` : f.path;
    await store.put(path, bytes);
    copied.push(path);
    if (/\.json$/.test(f.path)) json[f.path] = JSON.parse(dec.decode(bytes));
  }
  for (const [p, j] of Object.entries(json)) {
    const dir = p.replace(/\/[^/]+$/, '');
    if (j.kind === 'KALSHI_SNAPSHOT') rows.push({ kind: 'KALSHI_SNAPSHOT', key: `${j.release.release_date}/${j.slot}`, ok: j.status === 'OK' && j.completed_before_slot === true, status: j.status, at: j.completed_utc, path: dir });
    if (j.kind === 'MISSED') rows.push({ kind: 'MISSED', key: `${j.release.release_date}/${j.slot}`, ok: false, at: j.detected_utc, path: dir });
    if (j.kind === 'KALSHI_SETTLEMENT') rows.push({ kind: 'KALSHI_SETTLEMENT', key: `${j.release.release_date}/${j.tag}`, ok: true, at: j.captured_utc, path: dir });
    if (j.kind === 'BLS_EMPSIT') rows.push({ kind: j.which === 'current' ? 'BLS_CURRENT' : 'BLS_ARCHIVE', key: j.release.reference_month, ok: j.status === 'OK', at: j.file?.response_completed_utc, path: dir });
    if (j.kind === 'DOL_WEEKLY_CLAIMS') rows.push({ kind: 'DOL_WEEKLY', key: dir.split('/').at(-1), ok: true, at: j.first_seen_utc, path: dir });
    if (j.kind === 'DOL_PRESS_ARCHIVE') rows.push({ kind: 'DOL_PRESS', key: dir.split('/').slice(-2).join('/'), ok: true, at: j.file?.response_completed_utc, path: dir });
  }
  for (const p of copied.filter((x) => /^kalshi\/terms\/[0-9a-f]{64}\.pdf$/.test(x))) rows.push({ kind: 'TERMS', key: p.slice(13, 77), ok: true });
  await state.addIndex('auth', rows);
  const cfg = json['collector.json'];
  await state.putState('auth', { enabled_at: cfg?.enabled_at, calendar: json['calendar/bls-empsit-schedule.json']?.releases || null, last_pushed_head: head, imported: { at_utc: iso(Date.now()), head, files: copied.length, index_rows: rows.length } });
  await state.appendLedger('auth', [{ type: 'IMPORT', at_utc: iso(Date.now()), collector: COLLECTOR_VERSION, mode: 'authoritative', head, files: copied.length, index_rows: rows.length, note: 'Windows-collected evidence copied byte-for-byte from GitHub into R2 at cutover' }]);
  return { head, files: copied.length, index_rows: rows.length, enabled_at: cfg?.enabled_at };
}

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function authorized(req, env) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!env.ADMIN_TOKEN || got.length !== env.ADMIN_TOKEN.length) return false;
  const [a, b] = [new TextEncoder().encode(got), new TextEncoder().encode(env.ADMIN_TOKEN)];
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(a, b) : got === env.ADMIN_TOKEN;
}

export default {
  async scheduled(event, env, ctx) { await runAll(env, event.scheduledTime); },
  async fetch(req, env) {
    const url = new URL(req.url); const mode = env.MODE || 'off'; const ns = url.searchParams.get('ns') || NS[mode] || 'shadow';
    const state = stateStub(env);
    if (url.pathname === '/health') {
      const st = await state.getState(NS[mode] || 'shadow'); const ticks = await state.ticks(NS[mode] || 'shadow', 1);
      const age = st.last_tick_utc ? Math.round((Date.now() - Date.parse(st.last_tick_utc)) / 1000) : null;
      const next = (st.calendar || []).flatMap((r) => slotTimes(r).map((s) => ({ key: `${r.release_date}/${s.slot}`, at: iso(s.at) }))).filter((s) => Date.parse(s.at) > Date.now()).slice(0, 3);
      const pending = (await state.pendingMirror(NS[mode] || 'shadow')).length;
      const healthy = age !== null && age <= 900 && !ticks[0]?.error && pending === 0;
      return json({ worker: 'pbe-employment-collector', mode, healthy, last_tick_utc: st.last_tick_utc || null, last_tick_age_s: age, last_tick: ticks[0] || null, last_error: st.last_error || null, mirror_pending: pending, push_failing_since: st.push_failing_since ? iso(st.push_failing_since) : null, next_slots: next, code: codeIdentity(env) }, healthy ? 200 : 503);
    }
    if (!url.pathname.startsWith('/admin/')) return json({ error: 'not_found' }, 404);
    if (!(await authorized(req, env))) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/admin/status') return json({ ns, state: await state.getState(ns), ticks: await state.ticks(ns, Number(url.searchParams.get('n') || 20)), ledger: await state.ledgerTail(ns, Number(url.searchParams.get('n') || 20)), pending_mirror: await state.pendingMirror(ns), code: codeIdentity(env) });
    if (url.pathname === '/admin/plan') {
      const st = await state.getState(ns); const r = rehearsalOf(env);
      const calendar = ns.startsWith('rehearsal:') ? [r?.release].filter(Boolean) : st.calendar || [];
      const at = url.searchParams.get('at') ? Date.parse(url.searchParams.get('at')) : Date.now();
      return json({ ns, at: iso(at), enabled_at: st.enabled_at || null, actions: plan(at, { calendar, enabledAt: Date.parse(st.enabled_at || iso(Date.now())), have: indexView(await state.index(ns)).have }).map((a) => ({ type: a.type, key: a.key || `${a.release.release_date}/${a.tag || a.type}`, slot_at: a.slot_at ? iso(a.slot_at) : undefined })) });
    }
    if (url.pathname === '/admin/verify') {
      const prefix = ns === 'auth' ? '' : ns === 'shadow' ? 'shadow/' : `rehearsal/${ns.slice('rehearsal:'.length)}/`;
      const st = await state.getState(ns);
      const mirror = ns === 'auth' && env.GITHUB_TOKEN ? new GitHubMirror({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO || 'LHBUSA/pbe-employment-evidence' }) : null;
      return json(await verify({ store: new EvidenceStore(env.EVIDENCE, prefix), state, ns, mirror, lastPushed: st.last_pushed_head, prefix: url.searchParams.get('prefix') || '' }));
    }
    if (url.pathname === '/admin/tick' && req.method === 'POST') return json(await runAll(env, null));
    if (url.pathname === '/admin/import-github' && req.method === 'POST') return json(await importFromGitHub(env));
    if (url.pathname === '/admin/test-alert' && req.method === 'POST') {
      // always exercises the webhook (even in shadow) so the channel itself is proven before cutover
      const msg = 'Validation of off-machine alert delivery (expected; no action needed).';
      let webhook; try { webhook = await deliverWebhook(env, `${mode === 'authoritative' ? '' : '[SHADOW] '}Employment collector: TEST`, msg); } catch (e) { webhook = `failed: ${e.message}`; }
      const hc = env.HEALTHCHECK_URL || env.SHADOW_HEALTHCHECK_URL; let healthcheck = 'not configured';
      if (hc) { try { healthcheck = (await fetch(hc)).status; } catch (e) { healthcheck = `failed: ${e.message}`; } }
      await state.appendLedger(NS[mode] || 'shadow', [{ type: 'ALERT_TEST', at_utc: iso(Date.now()), collector: COLLECTOR_VERSION, mode, results: { webhook, healthcheck } }]);
      return json({ webhook, healthcheck });
    }
    return json({ error: 'not_found' }, 404);
  },
};
