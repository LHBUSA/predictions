import { upstreamJson } from '../../compare/api/_lib/access.js';
import { safeSymbols } from './_lib/server.mjs';

const LEGACY_MARKETS='https://markets-proptechusa.sales-fd3.workers.dev/market';
const ROBINHOOD='https://pbe-predictions.sales-fd3.workers.dev/v1/crypto/live-prices';

function publicSend(res,status,body,maxAge=5){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control',`public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=20`);
  res.setHeader('x-content-type-options','nosniff');
  res.status(status).send(JSON.stringify(body));
}

function mergeRobinhood(body,rh){
  if(!body || !rh?.ok || !Array.isArray(rh.symbols)) return body;
  const byAsset=Object.fromEntries(rh.symbols.map((x)=>[String(x.symbol||'').replace(/-USD$/,'').toUpperCase(),x]));
  const coins=Array.isArray(body?.crypto?.coins) ? body.crypto.coins.map((coin)=>{
    const asset=String(coin?.symbol||'').toUpperCase();
    const q=byAsset[asset];
    if(!q?.mark) return coin;
    return {
      ...coin,
      current_price:Number(q.mark),
      robinhood_mark:Number(q.mark),
      robinhood_bid:q.raw_bid==null?null:Number(q.raw_bid),
      robinhood_ask:q.raw_ask==null?null:Number(q.raw_ask),
      robinhood_timestamp:q.timestamp||null,
      price_source:'Robinhood Crypto'
    };
  }) : [];
  return {
    ...body,
    crypto:{...(body.crypto||{}),coins},
    robinhood:{
      ok:true,
      source:'Robinhood Crypto',
      generated_at:rh.generated_at||null,
      count:rh.count||rh.symbols.length,
      symbols:rh.symbols
    }
  };
}

export default async function handler(req,res){
  if(req.method!=='GET') return publicSend(res,405,{error:'method_not_allowed'},0);
  const stocks=safeSymbols(req.query?.stocks,'SPY,QQQ,DIA,IWM,VIX,AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,PLTR,COIN',20);
  const crypto=safeSymbols(req.query?.crypto,'BTC,ETH,SOL,BNB,XRP,ADA,DOGE,LINK',20);
  const u=new URL(LEGACY_MARKETS);u.searchParams.set('stocks',stocks);u.searchParams.set('crypto',crypto);
  const [market,rh]=await Promise.all([
    upstreamJson(u.toString(),{timeoutMs:10000}),
    upstreamJson(ROBINHOOD,{timeoutMs:7000})
  ]);
  if(!market.ok) return publicSend(res,502,{error:'market_data_unavailable',upstream_status:market.status},2);
  return publicSend(res,200,mergeRobinhood(market.body,rh.ok?rh.body:null),3);
}
