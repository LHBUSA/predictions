import { PERSONAS, buildResearchContext, askOpenAI } from './_lib/server.js';

export default async function handler(req,res){
  if(process.env.VERCEL_ENV!=='preview') return res.status(404).json({error:'not_found'});
  const topic=String(req.query?.q||'').trim();
  if(!topic) return res.status(400).json({error:'missing_q'});
  try{
    const research=await buildResearchContext(topic,'SPY,QQQ,DIA,IWM,VIX,AAPL,MSFT,NVDA,TSLA','BTC,ETH,SOL');
    const {resolved,context:ctx}=research;
    const responses={};
    for(const key of ['quant','bull','bear']){
      const p=PERSONAS[key];
      const prior=Object.entries(responses).map(([k,v])=>PERSONAS[k].name+': '+v).join('\n\n');
      const stance = key==='bull'
        ? '[DEBATE ROLE — AFFIRMATIVE]\nTake the strongest defensible YES / CONSTRUCTIVE side. Use at least three subject-specific facts. Explicitly rebut the strongest point already raised. Do not use Mixed as your verdict.'
        : key==='bear'
        ? '[DEBATE ROLE — NEGATIVE]\nTake the strongest defensible NO / WAIT side. Use at least three subject-specific facts. Explicitly rebut Tim. Do not use Mixed as your verdict.'
        : '[DEBATE ROLE — NEUTRAL DATA]\nRank the strongest evidence for and against the subject and identify the deciding variable.';
      const prompt=[ctx,'','[DEBATE TOPIC]',topic,'',stance,prior?'\n[PRIOR ANALYST READS]\n'+prior:'','','Use the resolved subject packet as primary evidence.'].join('\n');
      responses[key]=await askOpenAI({instruction:p.instruction,input:prompt,maxOutput:500});
    }
    res.setHeader('cache-control','no-store');
    res.status(200).json({resolved,responses});
  }catch(e){res.status(500).json({error:String(e?.message||e)});}
}
