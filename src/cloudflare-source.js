function requireFetchTarget(target, label) {
  if (!target || typeof target.fetch !== 'function') {
    throw new TypeError(`${label} must expose fetch()`);
  }
  return target;
}

function addQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function parseJsonResponse(response) {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`upstream returned non-JSON response (${response.status})`);
    }
  }
  if (typeof response.json === 'function') return response.json();
  throw new TypeError('upstream response must expose text() or json()');
}

export class CloudflareSourceTransport {
  constructor({ serviceBinding = null, baseUrl = null, apiKey = null, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    if (!serviceBinding && !baseUrl) throw new TypeError('serviceBinding or baseUrl is required');
    if (!serviceBinding && typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.serviceBinding = serviceBinding;
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/$/, '') : 'https://source.internal';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', query = {}, headers = {}, body = null } = {}) {
    if (!String(path).startsWith('/')) throw new TypeError('path must begin with /');
    const url = addQuery(new URL(`${this.baseUrl}${path}`), query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestHeaders = {
      accept: 'application/json',
      ...headers
    };
    if (this.apiKey) requestHeaders['x-api-key'] = this.apiKey;
    if (body !== null && requestHeaders['content-type'] === undefined) requestHeaders['content-type'] = 'application/json';

    try {
      const init = {
        method,
        headers: requestHeaders,
        signal: controller.signal,
        ...(body !== null ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
      };
      const response = this.serviceBinding
        ? await requireFetchTarget(this.serviceBinding, 'serviceBinding').fetch(url.toString(), init)
        : await this.fetchImpl(url, init);
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        const message = data?.error || data?.message || `upstream request failed: ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.upstream = data;
        throw error;
      }
      return Object.freeze({
        data,
        fetchedAt: new Date().toISOString(),
        route: path,
        transport: this.serviceBinding ? 'cloudflare_service_binding' : 'https'
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
