import { requireAllAccess, send } from '../lib/access.js';

const LIVE_URL = 'https://members.propbetedge.ai/api/live';
const SPORTS = new Set(['mlb','nfl','nba','wnba','nhl','ufc','tennis','soccer','golf','f1']);

export default async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res);
  if(!member) return;

  const sport=typeof req.query.sport==='string' ? req.query.sport.toLowerCase() : '';
  if(sport && !SPORTS.has(sport)) return send(res,400,{error:'unknown_sport'});

  const url=new URL(LIVE_URL);
  if(sport) url.searchParams.set('sports',sport);

  try{
    const r=await fetch(url,{
      headers:{accept:'application/json',cookie:req.headers.cookie || ''},
      cache:'no-store'
    });
    const body=await r.json().catch(()=>({}));
    if(r.status===401 || r.status===403) return send(res,r.status,body);
    if(!r.ok) return send(res,502,{error:'live_board_unavailable',upstream_status:r.status});
    return send(res,200,body);
  }catch{
    return send(res,502,{error:'live_board_unavailable'});
  }
}
