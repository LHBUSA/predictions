// Canonical market service client. Predictions never calls Kalshi itself: every read goes through the
// propsports-markets Worker (service binding MARKETS), which signs the request and owns the shared
// rate-limit backoff. v1 uses its read-only signed passthrough; a scoped read endpoint replaces it once
// the shared Worker can be changed without racing other sessions.

export class MarketsBackoffError extends Error {
  constructor(until) { super(`canonical market service in rate-limit backoff until ${until}`); this.name = 'MarketsBackoffError'; this.until = until; }
}

export class MarketsService {
  constructor({ binding, token }) {
    if (!binding?.fetch) throw new TypeError('MARKETS service binding is required');
    if (!token) throw new TypeError('MARKETS_READ_TOKEN is required');
    this.binding = binding;
    this.token = token;
    this.requests = 0;
  }

  async read(path, params = {}) {
    const url = new URL('https://propsports-markets/admin/kalshi');
    url.searchParams.set('path', path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    this.requests += 1;
    const res = await this.binding.fetch(url.toString(), { headers: { authorization: `Bearer ${this.token}` } });
    const body = await res.json().catch(() => null);
    if (body?.skipped === 'rate_limit_backoff') throw new MarketsBackoffError(body.next_eligible_at);
    if (!res.ok || body?.status !== 200) throw new Error(`market service ${path} -> ${res.status}/${body?.status ?? 'n/a'} ${JSON.stringify(body?.body ?? body?.error ?? '').slice(0, 200)}`);
    return { endpoint: body.endpoint, auth: body.auth, body: body.body };
  }

  async series(ticker) { return (await this.read(`/series/${ticker}`)).body?.series ?? null; }

  async openEvents(seriesTicker) {
    const r = await this.read('/events', { series_ticker: seriesTicker, status: 'open', with_nested_markets: 'true', limit: 50 });
    return { endpoint: r.endpoint, events: r.body?.events ?? [] };
  }

  async marketsByTicker(tickers) {
    const r = await this.read('/markets', { tickers: tickers.join(','), limit: tickers.length });
    return r.body?.markets ?? [];
  }
}
