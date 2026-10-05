const MEMBERSHIP_URL = 'https://pbe-predictions.sales-fd3.workers.dev/v1/membership';
export const MARKET_DESK_URL = 'https://propsports-markets.sales-fd3.workers.dev/v1/market-desk';

const PRIVATE = {
  'cache-control': 'private, no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'vary': 'Cookie'
};

export function send(res, status, body) {
  for (const [k,v] of Object.entries(PRIVATE)) res.setHeader(k,v);
  res.status(status).send(JSON.stringify(body));
}

export async function membership(req) {
  try {
    const r = await fetch(MEMBERSHIP_URL, {
      headers: { accept: 'application/json', cookie: req.headers.cookie || '' },
      cache: 'no-store'
    });
    const body = await r.json().catch(()=>({}));
    if (!r.ok || !body?.membership?.state) {
      return { status:503, body:{ authenticated:false, reason:'membership_unavailable', membership:{ state:'unverified', entitled:false, label:'Access Check' } } };
    }
    return { status:200, body };
  } catch {
    return { status:503, body:{ authenticated:false, reason:'membership_unavailable', membership:{ state:'unverified', entitled:false, label:'Access Check' } } };
  }
}

export async function requireAllAccess(req,res) {
  const m = await membership(req);
  if (m.status !== 200) { send(res,m.status,m.body); return null; }
  const mm = m.body.membership;
  if (mm?.entitled !== true || !['all_access','owner'].includes(mm.state)) {
    send(res,403,m.body);
    return null;
  }
  return m.body;
}
