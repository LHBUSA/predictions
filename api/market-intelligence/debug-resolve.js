import { resolveAndResearchSubject, buildResearchContext } from './_lib/server.js';

export default async function handler(req,res){
  if(process.env.VERCEL_ENV!=='preview'){
    res.status(404).send('not_found'); return;
  }
  const q=String(req.query?.q||'').trim();
  if(!q){res.status(400).json({error:'missing_q'});return;}
  try{
    const result=await buildResearchContext(q,'SPY,QQQ,DIA,IWM,VIX,AAPL,MSFT,NVDA,TSLA','BTC,ETH,SOL');
    res.setHeader('cache-control','no-store');
    res.status(200).json({
      resolved:result.resolved,
      subject_quote:(result.data?.stocks?.quotes||[]).find(x=>x.symbol===result.resolved?.symbol)||null,
      technical:result.technical||null,
      context_preview:String(result.context||'').slice(0,5000)
    });
  }catch(e){
    res.status(500).json({error:String(e?.message||e)});
  }
}
