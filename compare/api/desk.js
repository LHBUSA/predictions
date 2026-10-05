import { MARKET_DESK_URL, requireAllAccess, send } from '../lib/access.js';

const SPORTS=['nfl','nba','nhl','mlb','wnba','soccer','tennis','ufc','golf','f1'];

export default async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res);
  if(!member) return;

  const sport=typeof req.query.sport==='string' ? req.query.sport.toLowerCase() : '';
  const domain=typeof req.query.domain==='string' ? req.query.domain.toLowerCase() : '';
  const limit=Math.max(1,Math.min(250,Number(req.query.limit)||100));

  const url=new URL(MARKET_DESK_URL);
  if(sport && SPORTS.includes(sport)) url.searchParams.set('sport',sport);
  else url.searchParams.set('domain', domain==='nonsports' ? 'nonsports' : 'nonsports');
  url.searchParams.set('limit',String(limit));

  try{
    const r=await fetch(url,{headers:{accept:'application/json'},cache:'no-store'});
    const body=await r.json().catch(()=>({}));
    if(!r.ok) return send(res,502,{error:'market_desk_unavailable',upstream_status:r.status});
    return send(res,200,body);
  }catch{
    return send(res,502,{error:'market_desk_unavailable'});
  }
}
