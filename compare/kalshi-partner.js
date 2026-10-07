/**
 * Kalshi partner CTA — shared, framework-free (contract kalshi-partner/1).
 * CANONICAL SOURCE: propbetedge-workers/workers/propsports-markets/client/kalshi-partner.js
 * Products vendor this file unchanged (Compare, Members, Predictions; sports via kalshi-market-ui.js).
 *
 *   loadPartnerConfig(url)        GET /v1/partner/kalshi once per page (5 min session cache); any failure -> disabled
 *   partnerHref(cfg, ctx, base)   first-party /go/kalshi?placement=…&sport=…&event=…&contract=…&page=… or null
 *   partnerCta(cfg, ctx, opts)    one quiet "New to Kalshi? Get started ↗" line + disclosure, or '' when disabled
 *
 * Rules (owner, 2026-10-07):
 *  - the canonical market link ("Open on Kalshi") is never touched: no parameters, no redirect;
 *  - the CTA never carries a destination: /go/kalshi (propsports-markets) answers 302 to the one configured partner
 *    URL, so the partner link changes in ONE Worker var, with no product deploy;
 *  - disabled / unreachable / malformed config renders nothing (no placeholder, no empty box);
 *  - no bonus amount in copy (Kalshi reward amounts and qualifying activity vary by program);
 *  - rel="sponsored noopener noreferrer"; disclosure sits next to the link;
 *  - one CTA per logical market surface (the caller decides where; this helper never repeats itself).
 */
export const PARTNER_CONTRACT = 'kalshi-partner/1'
export const PARTNER_PATH = '/go/kalshi'
export const PARTNER_LABEL = 'New to Kalshi? Get started'
export const PARTNER_DISCLOSURE = 'PropBetEdge may receive compensation for eligible new Kalshi customers. Terms and eligibility apply.'
export const PARTNER_REL = 'sponsored noopener noreferrer'
export const PARTNER_DISABLED = Object.freeze({ contract: PARTNER_CONTRACT, enabled: false })

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ID_RE = /^[A-Za-z0-9:|._-]{1,128}$/
const PAGE_RE = /^\/[A-Za-z0-9/_.-]{0,159}$/
const BASE_RE = /^(https:\/\/[a-z0-9.-]+)?$/

// Only a config that names exactly the first-party route is honoured; anything else is "disabled".
export function normalizeConfig(body) {
  return body && body.contract === PARTNER_CONTRACT && body.enabled === true && body.path === PARTNER_PATH
    ? { contract: PARTNER_CONTRACT, enabled: true, path: PARTNER_PATH }
    : PARTNER_DISABLED
}

// ctx = { placement, sport, event, contract, page }. base = '' (same-origin rewrite) or an https origin.
export function partnerHref(cfg, ctx = {}, base = '') {
  if (!cfg || cfg.enabled !== true || cfg.path !== PARTNER_PATH || !BASE_RE.test(base)) return null
  const q = new URLSearchParams()
  if (ctx.placement) q.set('placement', String(ctx.placement))
  if (ctx.sport) q.set('sport', String(ctx.sport))
  if (ctx.event && ID_RE.test(String(ctx.event))) q.set('event', String(ctx.event))
  if (ctx.contract && ID_RE.test(String(ctx.contract))) q.set('contract', String(ctx.contract))
  if (ctx.page && PAGE_RE.test(String(ctx.page))) q.set('page', String(ctx.page))
  const qs = q.toString()
  return `${base}${PARTNER_PATH}${qs ? `?${qs}` : ''}`
}

// opts: { base, cls ('kxp' default; caller styles it), disclosure (true default) }
export function partnerCta(cfg, ctx = {}, opts = {}) {
  const href = partnerHref(cfg, ctx, opts.base || '')
  if (!href) return ''
  const cls = /^[a-z][a-z0-9_-]{0,30}$/i.test(opts.cls || '') ? opts.cls : 'kxp'
  const disc = opts.disclosure === false ? '' : `<small class="${cls}__d">${esc(PARTNER_DISCLOSURE)}</small>`
  return `<span class="${cls}"><a class="${cls}__a" href="${esc(href)}" target="_blank" rel="${PARTNER_REL}" data-kxp-placement="${esc(ctx.placement || '')}">${esc(PARTNER_LABEL)} <span aria-hidden="true">↗</span></a>${disc}</span>`
}

const CACHE_KEY = 'pbe:kalshi-partner:1'
const CACHE_MS = 5 * 60 * 1000
let pending = null
// One read per page; sessionStorage keeps navigation inside a product from re-reading for 5 min.
export function loadPartnerConfig(url, { fetchImpl = typeof fetch === 'function' ? fetch : null, storage = safeStorage(), now = Date.now } = {}) {
  if (pending) return pending
  try {
    const hit = storage && JSON.parse(storage.getItem(CACHE_KEY) || 'null')
    if (hit && now() - hit.at < CACHE_MS) return (pending = Promise.resolve(normalizeConfig(hit.cfg)))
  } catch { /* storage unavailable */ }
  if (!fetchImpl || !url) return (pending = Promise.resolve(PARTNER_DISABLED))
  pending = Promise.resolve()
    .then(() => fetchImpl(url, { credentials: 'omit' }))
    .then((r) => (r && r.ok ? r.json() : null))
    .then((body) => {
      const cfg = normalizeConfig(body)
      // cache only a real answer; a failed read is retried on the next page
      if (body) try { storage && storage.setItem(CACHE_KEY, JSON.stringify({ at: now(), cfg })) } catch { /* ignore */ }
      return cfg
    })
    .catch(() => PARTNER_DISABLED)
  return pending
}
export function _resetPartnerConfig() { pending = null }

function safeStorage() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null } catch { return null }
}
