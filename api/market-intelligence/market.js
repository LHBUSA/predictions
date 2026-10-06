import { requireAllAccess, send, upstreamJson } from '../../compare/api/_lib/access.js';
import { safeSymbols } from './_lib/server.js';

const UPSTREAM='https://markets-proptechusa.sales-fd3.workers.dev/market';

export default async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res); if(!member) return;
  const stocks=safeSymbols(req.query?.stocks,'SPY,QQQ,DIA,IWM,VIX',20);
  const crypto=safeSymbols(req.query?.crypto,'BTC,ETH,SOL,BNB,XRP,ADA',20);
  const u=new URL(UPSTREAM); u.searchParams.set('stocks',stocks); u.searchParams.set('crypto',crypto);
  const out=await upstreamJson(u.toString(),{timeoutMs:10000});
  if(!out.ok) return send(res,502,{error:'market_data_unavailable'});
  return send(res,200,out.body);
}
