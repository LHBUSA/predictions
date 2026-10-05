import { requireAllAccess, send } from '../lib/access.js';

const UPSTREAM = 'https://propsports-markets.sales-fd3.workers.dev/v1/market-desk/series';

export default async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res);
  if(!member) return;

  const event=typeof req.query.event==='string' ? req.query.event : '';
  const market=typeof req.query.market==='string' ? req.query.market : '';
  const hours=Math.max(1,Math.min(168,Number(req.query.hours)||24));
  if(!event || !market) return send(res,400,{error:'event_and_market_required'});

  const url=new URL(UPSTREAM);
  url.searchParams.set('event',event);
  url.searchParams.set('market',market);
  url.searchParams.set('hours',String(hours));

  try{
    const r=await fetch(url,{headers:{accept:'application/json'},cache:'no-store'});
    const body=await r.json().catch(()=>({}));
    if(!r.ok) return send(res,502,{error:'series_unavailable',upstream_status:r.status});
    return send(res,200,body);
  }catch{
    return send(res,502,{error:'series_unavailable'});
  }
}
