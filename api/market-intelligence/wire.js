import { requireAllAccess, send } from '../../compare/api/_lib/access.js';
import { marketData } from './_lib/server.cjs';
import { buildWire } from './_lib/wire.js';

export default async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{error:'method_not_allowed'});
  if(!await requireAllAccess(req,res)) return;
  try{
    const data=await marketData(req.query?.stocks,req.query?.crypto);
    return send(res,200,buildWire(data));
  }catch{return send(res,502,{error:'wire_unavailable'});}
}
