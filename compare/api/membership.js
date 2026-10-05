import { membership, send } from './_lib/access.js';

export default async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{error:'method_not_allowed'});
  const m=await membership(req);
  return send(res,m.status,m.body);
}
