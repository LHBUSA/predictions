import { requireAllAccess, send, upstreamJson } from '../../compare/api/_lib/access.js';

const UPSTREAM='https://markets-technicals.sales-fd3.workers.dev/data';

export default async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res); if(!member) return;
  const symbol=String(req.query?.symbol||'SPY').trim().toUpperCase();
  if(!/^[A-Z0-9.-]{1,10}$/.test(symbol)) return send(res,400,{error:'invalid_symbol'});
  const u=new URL(UPSTREAM); u.searchParams.set('symbol',symbol);
  const out=await upstreamJson(u.toString(),{timeoutMs:10000});
  if(!out.ok) return send(res,out.status===404?404:502,{error:'technicals_unavailable',symbol});
  return send(res,200,out.body);
}
