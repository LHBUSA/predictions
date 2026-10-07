// Kalshi partner CTA config (kalshi-partner/1) read from the canonical market service over the MARKETS binding.
// The partner URL lives ONLY in propsports-markets (KALSHI_PARTNER_URL); this Worker learns enabled/disabled and links
// to the first-party /go/kalshi router (Vercel rewrite on predictions.propbetedge.ai). Fails closed: no answer = no CTA.
import { normalizeConfig, PARTNER_DISABLED } from './vendor/kalshi-partner.js';

const OK_MS = 5 * 60 * 1000;
const FAIL_MS = 60 * 1000;
const TIMEOUT_MS = 1500;
let memo = null; // { at, ttl, cfg }

export async function partnerConfigFor(env, now = Date.now()) {
  if (memo && now - memo.at < memo.ttl) return memo.cfg;
  let cfg = PARTNER_DISABLED; let ttl = FAIL_MS;
  try {
    if (env?.MARKETS?.fetch) {
      const r = await env.MARKETS.fetch('https://propsports-markets/v1/partner/kalshi', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) { cfg = normalizeConfig(await r.json()); ttl = OK_MS; }
    }
  } catch { /* disabled */ }
  memo = { at: now, ttl, cfg };
  return cfg;
}
export function _resetPartnerMemo() { memo = null; }
