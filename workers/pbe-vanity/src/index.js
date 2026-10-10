// PBE Predictions branded entry points (LHBUSA/predictions#66). One redirect-only Worker for the vanity subdomains of
// propbetedge.ai. Each host is a marketing address for ONE canonical Predictions page on predictions.propbetedge.ai:
// no content, no auth, no cookies, no proxying, no second website. A host is ACTIVE only once its canonical page is
// real and live; inactive or unknown hosts answer 404 (and only hosts attached as custom domains ever reach this Worker).
//
//   GET/HEAD  -> 308 (permanent; REDIRECT_STATUS=307 while proving a route) to the exact canonical URL, query kept (UTM)
//   other     -> 405 (a POST is never redirected)
// Responses carry X-Robots-Tag: noindex so the vanity hosts never compete with the canonical pages in search.

export const CANONICAL = 'https://predictions.propbetedge.ai';
export const HOSTS = Object.freeze({
  'crypto.propbetedge.ai': { path: '/crypto/', active: true },
  // activated one by one, each after its canonical destination is live and verified (#66 phase 2;
  // gold/silver/platinum pages live via #75 52f84d7, verified 2026-10-10)
  'gold.propbetedge.ai': { path: '/commodities/gold/', active: true, proving: true },
  'silver.propbetedge.ai': { path: '/commodities/silver/', active: true, proving: true },
  'platinum.propbetedge.ai': { path: '/commodities/platinum/', active: true, proving: true },
  'futures.propbetedge.ai': { path: '/markets/futures/', active: false },
});

export function targetFor(url, hosts = HOSTS) {
  const h = hosts[url.hostname.toLowerCase()];
  if (!h || !h.active) return null;
  return `${CANONICAL}${h.path}${url.search}`;
}
// a newly activated host answers 307 (`proving: true`) until it is verified over HTTPS; then the flag is removed -> 308
const proving = (url, hosts) => !!hosts[url.hostname.toLowerCase()]?.proving;

const base = { 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };

export function handle(request, env = {}, hosts = HOSTS) {
  const url = new URL(request.url);
  const to = targetFor(url, hosts);
  if (!to) return new Response('Not found', { status: 404, headers: { ...base, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { ...base, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const status = env.REDIRECT_STATUS === '307' || proving(url, hosts) ? 307 : 308;
  return new Response(null, { status, headers: { ...base, location: to, 'cache-control': status === 308 ? 'public, max-age=3600' : 'no-store' } });
}

export default { fetch: (request, env) => handle(request, env) };
