// Shared run logic for every trigger: the Durable Object alarm (primary scheduler), the Cron Trigger (backup) and the
// token-gated manual tick. Each tick records which trigger ran it; the per-5-minute idempotency key in collector.tick
// guarantees that two triggers in the same 5-minute bucket never produce two ticks (so never duplicate captures).
// Alerts: Cloudflare Email Routing (send_email binding EMAIL -> the owner's already-verified destination, address held in
// the ALERT_EMAIL_TO secret, never in source) and an optional webhook. Messages carry only alert kind, slot keys, counts
// and error text: no prices, no credentials.
import { EmailMessage } from 'cloudflare:email';
import { COLLECTOR_VERSION, tick } from './collector.js';
import { makeGet } from './http.js';
import { kalshiSigner } from './kalshi-auth.js';
import { EvidenceStore } from './store.js';
import { anchor } from './tsa.js';
import { iso, sleep } from './util.js';

export const NS = { shadow: 'shadow', authoritative: 'auth' };
export const PREFIX = { shadow: 'shadow/', authoritative: '' };
export const HOST = 'cloudflare-workers:pbe-employment-collector';
export const FIVE_MIN = 5 * 60000;

export const stateStub = (env) => env.STATE.get(env.STATE.idFromName('employment-collector'));
export function codeIdentity(env) {
  return { version: COLLECTOR_VERSION, worker: 'pbe-employment-collector', commit: env.CODE_COMMIT || null, files: env.CODE_FILES || null, worker_version_id: env.CF_VERSION_METADATA?.id || null, worker_version_tag: env.CF_VERSION_METADATA?.tag || null, rules: 'scripts/research/employment/collector/lib.mjs (shared with the Windows collector)' };
}
export function rehearsalOf(env) { try { return env.REHEARSAL ? JSON.parse(env.REHEARSAL) : null; } catch { return null; } }

export async function sendEmail(env, subject, text) {
  if (!env.EMAIL || !env.ALERT_EMAIL_TO) return 'not configured';
  const from = env.ALERT_EMAIL_FROM || 'employment-collector@propbetedge.ai';
  const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 180);
  const raw = [`From: Employment Collector <${from}>`, `To: <${env.ALERT_EMAIL_TO}>`, `Subject: ${clean(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@propbetedge.ai>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', String(text).slice(0, 4000)].join('\r\n');
  await env.EMAIL.send(new EmailMessage(from, env.ALERT_EMAIL_TO, raw));
  return 'sent';
}
export async function sendWebhook(env, title, message) {
  if (!env.ALERT_WEBHOOK_URL) return 'not configured';
  const r = await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${title}: ${message}` }) });
  return r.status;
}
export async function deliverAll(env, title, message) {
  const out = {};
  try { out.email = await sendEmail(env, title, `${message}\n\nWorker pbe-employment-collector (${COLLECTOR_VERSION}, version ${env.CF_VERSION_METADATA?.id || 'n/a'})\nHealth: https://pbe-employment-collector.sales-fd3.workers.dev/health\nat ${iso(Date.now())}`); } catch (e) { out.email = `failed: ${String(e?.message || e).slice(0, 120)}`; }
  try { out.webhook = await sendWebhook(env, title, message); } catch (e) { out.webhook = `failed: ${String(e?.message || e).slice(0, 120)}`; }
  return out;
}

export async function makeContext(env, { mode, ns, prefix, state, trigger, calendarOverride = null, onlyKalshi = false, scheduledTime = null, fetchImpl = fetch }) {
  let signer = null; let authError = null;
  try { signer = await kalshiSigner(env); } catch (e) { authError = e.message; }
  const kalshiBase = env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
  const rawGet = makeGet({ fetchImpl, signer, kalshiBase });
  const metas = [];
  const get = async (u, o) => { const r = await rawGet(u, o); metas.push(r.meta); return r; };
  const authoritative = mode === 'authoritative';
  const deliver = mode === 'rehearsal' ? null : async (kind, message) => {
    if (!authoritative && env.SHADOW_ALERTS !== 'true') return { external: 'shadow: suppressed (SHADOW_ALERTS != true)' };
    return deliverAll(env, `${authoritative ? '' : '[SHADOW] '}Employment collector: ${kind}`, message);
  };
  const daily = mode === 'rehearsal' ? null : async (summary) => deliverAll(env, `${authoritative ? '' : '[SHADOW] '}Employment collector daily OK`, summary);
  const hc = authoritative ? env.HEALTHCHECK_URL : mode === 'shadow' ? env.SHADOW_HEALTHCHECK_URL : null;
  const healthPing = hc ? async (ok) => { try { await fetch(`${hc}${ok ? '' : '/fail'}`); } catch { /* optional */ } } : null;
  return {
    mode, ns, store: new EvidenceStore(env.EVIDENCE, prefix), state: state || stateStub(env), get, kalshiBase, now: () => Date.now(), sleep,
    code: { ...codeIdentity(env), kalshi_auth: signer ? `signed:${signer.keyType}` : authError || 'not_configured' }, host: HOST, deliver, daily, healthPing, anchor: env.TSA_ANCHOR === 'false' ? null : (h) => anchor(h, { fetchImpl }),
    calendarOverride, onlyKalshi, scheduledTime, trigger, lastFiles: () => metas,
  };
}

// trigger: 'alarm' | 'cron' | 'manual'; state: the Durable Object itself when called from its alarm (no RPC hop)
export async function runAll(env, { trigger, scheduledTime = null, state = null }) {
  const out = {};
  const mode = env.MODE || 'off';
  if (NS[mode]) out[mode] = await tick(await makeContext(env, { mode, ns: NS[mode], prefix: PREFIX[mode], state, trigger, scheduledTime }));
  const r = rehearsalOf(env);
  if (r && Date.now() < Date.parse(r.release.release_at)) out.rehearsal = await tick(await makeContext(env, { mode: 'rehearsal', ns: `rehearsal:${r.id}`, prefix: `rehearsal/${r.id}/`, state, trigger, calendarOverride: [r.release], onlyKalshi: true, scheduledTime }));
  return out;
}

// next alarm: 3 s after the next 5-minute boundary (slot windows get ticks at :45:03, :50:03, :55:03 ET)
export const nextBoundary = (now) => Math.floor(now / FIVE_MIN) * FIVE_MIN + FIVE_MIN + 3000;
