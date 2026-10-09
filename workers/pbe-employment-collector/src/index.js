// pbe-employment-collector: Employment Tier A collector on Cloudflare Workers (separate from pbe-predictions).
// Cloudflare-native: R2 is the authoritative evidence archive (write-once, sha256-verified, bucket-locked), a SQLite
// Durable Object holds scheduling state and the capture index, and a hash-chained audit ledger in R2 + the Durable Object
// seals every tick. No GitHub, git or SSH at runtime. The historical GitHub evidence repo is kept intact and read-only.
// MODE (var): "shadow" = R2 under shadow/ + namespace "shadow", never the authoritative archive; "authoritative" = R2 root
// + namespace "auth" (only after the owner approves the cutover); "off" = nothing.
// REHEARSAL (var, optional JSON {id, release}) adds an isolated cutoff-window rehearsal: Kalshi slots only, R2 under
// rehearsal/<id>/, its own namespace, no external alerts.
// Scheduling: a Durable Object alarm every 5 minutes is the primary trigger (runner.js / state-do.js); the Cron Trigger is
// a backup that also re-arms the alarm. Each tick records its trigger; one tick per 5-minute bucket at most.
// Routes: GET /health (public, no secrets; also re-arms the alarm); /admin/* with Bearer ADMIN_TOKEN.
import { plan, slotTimes } from '../../../scripts/research/employment/collector/lib.mjs';
import { COLLECTOR_VERSION, indexView, kalshiSnapshot, tick } from './collector.js';
import { genesis, preflight } from './genesis.js';
import { anchor } from './tsa.js';
import { NS, codeIdentity, deliverAll, makeContext, rehearsalOf, runAll, stateStub } from './runner.js';
import { EvidenceStore } from './store.js';
import { iso } from './util.js';
import { verify } from './verify.js';

export { CollectorState } from './state-do.js';

const prefixOf = (ns) => (ns === 'auth' ? '' : ns === 'shadow' ? 'shadow/' : `rehearsal/${ns.slice('rehearsal:'.length)}/`);

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function authorized(req, env) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!env.ADMIN_TOKEN || got.length !== env.ADMIN_TOKEN.length) return false;
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(got), new TextEncoder().encode(env.ADMIN_TOKEN));
}

export default {
  async scheduled(event, env) { await stateStub(env).ensureAlarm(); await runAll(env, { trigger: 'cron', scheduledTime: event.scheduledTime }); },
  async fetch(req, env) {
    const url = new URL(req.url); const mode = env.MODE || 'off'; const ns = url.searchParams.get('ns') || NS[mode] || 'shadow';
    const state = stateStub(env);
    if (url.pathname === '/health') {
      const hns = NS[mode] || 'shadow';
      const st = await state.getState(hns); const ticks = await state.ticks(hns, 1);
      const age = st.last_tick_utc ? Math.round((Date.now() - Date.parse(st.last_tick_utc)) / 1000) : null;
      const next = (st.calendar || []).flatMap((r) => slotTimes(r).map((s) => ({ key: `${r.release_date}/${s.slot}`, at: iso(s.at) }))).filter((s) => Date.parse(s.at) > Date.now()).slice(0, 3);
      const nextAlarm = await state.ensureAlarm();
      const healthy = age !== null && age <= 900 && !ticks[0]?.error && !(st.unsealed || []).length;
      return json({ worker: 'pbe-employment-collector', mode, healthy, last_tick_utc: st.last_tick_utc || null, last_tick_age_s: age, last_tick: ticks[0] || null, last_error: st.last_error || null, next_alarm_utc: nextAlarm, ledger_chain: st.chain ? { seq: st.chain.seq, head: st.chain.head.slice(0, 16) } : null, unsealed_entries: (st.unsealed || []).length, next_slots: next, code: codeIdentity(env) }, healthy ? 200 : 503);
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
    if (url.pathname === '/admin/tick' && req.method === 'POST') return json(await runAll(env, { trigger: 'manual' }));
    // FAULT DRILL: a real tick in the isolated 'drill' namespace (R2 drill/, never shadow or authoritative) with every
    // outbound request failing, so the collector's own failure paths raise and deliver real alerts.
    if (url.pathname === '/admin/drill' && req.method === 'POST') {
      const fail = () => Promise.reject(new Error('DRILL: injected network failure'));
      const c = await makeContext(env, { mode: 'shadow', ns: 'drill', prefix: 'drill/', trigger: 'manual', fetchImpl: fail });
      c.anchor = async () => ({ ok: false, errors: ['DRILL: injected TSA failure'] });
      const st = await state.getState('drill'); delete st.last_bucket; delete st.alerts; delete st.calendar; delete st.schedule_day; await state.putState('drill', st);
      return json({ drill: true, tick: await tick(c) });
    }
    if (url.pathname === '/admin/start' && req.method === 'POST') return json({ next_alarm_utc: await state.ensureAlarm() });
    // GENESIS of the authoritative ledger (owner adoption of B3 + cloud-only cutover, Issue #3 comment 6082392799).
    // Only while MODE=shadow (before the authoritative deploy); fails closed unless the auth namespace and R2 root are empty
    // and the genesis record is RFC 3161-anchored. No legacy import.
    if (url.pathname === '/admin/genesis-preflight') return json(await preflight({ store: new EvidenceStore(env.EVIDENCE, ''), state }));
    if (url.pathname === '/admin/genesis' && req.method === 'POST') {
      if (mode !== 'shadow') return json({ error: 'genesis only while MODE=shadow (before the authoritative deploy)' }, 409);
      const body = await req.json().catch(() => ({}));
      const r = await genesis({ store: new EvidenceStore(env.EVIDENCE, ''), state, anchor: (hh) => anchor(hh), now: () => Date.now(), code: codeIdentity(env), approval: 'https://github.com/LHBUSA/pbe-employment-evidence/issues/3#issuecomment-6082392799 (OWNER, 2026-10-09T13:57:42Z): adopt Amendment B3; immediate cloud-only cutover; fresh genesis; no legacy import', windows: body.windows || null });
      return json(r, r.error ? 409 : 200);
    }
    // labelled ADHOC capture of the next release, SHADOW namespace only (live side-by-side comparison; never a slot)
    if (url.pathname === '/admin/adhoc' && req.method === 'POST') {
      const c = await makeContext(env, { mode: 'shadow', ns: 'shadow', prefix: 'shadow/', trigger: 'manual' });
      const st = await state.getState('shadow'); const rel = (st.calendar || []).find((r) => Date.parse(r.release_at) > Date.now());
      if (!rel) return json({ error: 'no calendar yet: wait for the first shadow tick' }, 409);
      c.ledger = () => {}; c.alert = async () => {};
      const s = await kalshiSnapshot(c, rel, 'ADHOC', null);
      return json({ dir: `shadow/kalshi/${rel.release_date}/ADHOC`, status: s.status, started_utc: s.started_utc, completed_utc: s.completed_utc, series: Object.fromEntries(Object.entries(s.series).map(([k, v]) => [k, { status: v.status, markets: v.markets_listed, orderbooks_ok: v.orderbooks_ok, fee: v.fee }])), kalshi_auth: c.code.kalshi_auth, files_written: c.store.written.length });
    }
    if (url.pathname === '/admin/test-alert' && req.method === 'POST') {
      // exercises every configured channel (even in shadow) and records the result in the ledger
      const results = await deliverAll(env, `${mode === 'authoritative' ? '' : '[SHADOW] '}Employment collector: TEST`, 'Validation of alert delivery (expected; no action needed). No research data is included in alerts.');
      await state.appendLedger(NS[mode] || 'shadow', [{ type: 'ALERT_TEST', at_utc: iso(Date.now()), collector: COLLECTOR_VERSION, mode, results }]);
      return json(results);
    }
    return json({ error: 'not_found' }, 404);
  },
};
