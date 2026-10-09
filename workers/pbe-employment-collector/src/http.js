// One HTTP GET exactly as the Windows collector did it: original response bytes, per-request UTC timestamps, server Date /
// Last-Modified / ETag, sha256, bounded retries on 429/5xx. Kalshi trade-API requests are ALWAYS signed: unsigned requests
// from Cloudflare egress are rate-limited (proven 2026-10-03) and must never be sent, so without a key they fail closed
// with KALSHI_AUTH_NOT_CONFIGURED and no request leaves the Worker.
import { iso, sha256, sleep as realSleep } from './util.js';

export const UA = 'Mozilla/5.0 (compatible; research-bot)';

export function makeGet({ fetchImpl = fetch, signer = null, kalshiBase, now = () => Date.now(), sleep = realSleep, timeoutMs = 25000 }) {
  return async function get(url, { tries = 3 } = {}) {
    const signed = url.startsWith(kalshiBase);
    for (let i = 1; ; i++) {
      const started = now();
      if (signed && !signer) return { ok: false, body: null, meta: { url, error: 'KALSHI_AUTH_NOT_CONFIGURED', attempt: i, request_started_utc: iso(started), response_completed_utc: iso(started) } };
      try {
        const headers = { 'user-agent': UA, accept: '*/*', ...(signed ? await signer('GET', url) : {}) };
        const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        const body = new Uint8Array(await r.arrayBuffer());
        const end = now();
        const meta = { url, status: r.status, attempt: i, signed, request_started_utc: iso(started), response_completed_utc: iso(end), server_date: r.headers.get('date'), last_modified: r.headers.get('last-modified'), etag: r.headers.get('etag'), content_type: r.headers.get('content-type'), bytes: body.length, sha256: await sha256(body) };
        if ((r.status === 429 || r.status >= 500) && i < tries) { await sleep(1500 * i); continue; }
        return { ok: r.status === 200, body, meta };
      } catch (e) {
        if (i < tries) { await sleep(1500 * i); continue; }
        return { ok: false, body: null, meta: { url, error: String(e?.message || e), attempt: i, signed, request_started_utc: iso(started), response_completed_utc: iso(now()) } };
      }
    }
  };
}

// Independent clock check: the Workers clock is Cloudflare's NTP-disciplined host clock (no SNTP from a Worker: no UDP).
// Every response's server Date header (1 s resolution) is compared with our completion time; the median difference is
// recorded and alerted if it exceeds 2 s.
export function clockCheck(files) {
  const d = files.filter((f) => f.server_date && f.response_completed_utc).map((f) => Date.parse(f.server_date) - Date.parse(f.response_completed_utc)).filter(Number.isFinite).sort((a, b) => a - b);
  return { samples: d.length, median_server_minus_worker_ms: d.length ? d[Math.floor(d.length / 2)] : null, note: 'server Date headers have 1 s resolution: |median| < 1000 ms is expected for a synchronized clock' };
}
