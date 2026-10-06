import { requireAllAccess, send } from '../../compare/api/_lib/access.js';
import { PERSONAS, marketData, contextFromMarket, askOpenAI, sseHeaders, sendEvent } from '../../src/market-intelligence-server.js';

export default async function handler(req,res){
  if(req.method!=='POST') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res); if(!member) return;
  const topic=String(req.body?.topic||'').trim();
  if(!topic || topic.length>900) return send(res,400,{error:'invalid_topic'});
  try{
    const data=await marketData(req.body?.stock_symbols,req.body?.crypto_symbols);
    const ctx=contextFromMarket(data);
    sseHeaders(res); sendEvent(res,{type:'debate_start',topic});
    const responses={};
    for(const key of ['quant','bull','bear']){
      const p=PERSONAS[key];
      sendEvent(res,{type:'persona_start',persona:key,name:p.name,role:p.role,emoji:key==='bull'?'▲':key==='bear'?'▼':'◆'});
      const prior=Object.entries(responses).map(([k,v])=>PERSONAS[k].name + ': ' + v).join('\n\n');
      const prompt=ctx + '\n\n[DEBATE TOPIC]\n' + topic + (prior ? '\n\n[PRIOR ANALYST READS]\n' + prior : '') + '\n\nGive your independent read. Directly address the strongest conflicting point already raised when applicable.';
      const answer=await askOpenAI({instruction:p.instruction,input:prompt,maxOutput:420});
      responses[key]=answer;
      sendEvent(res,{type:'text',persona:key,text:answer});
      sendEvent(res,{type:'persona_done',persona:key});
    }
    sendEvent(res,{type:'debate_done'}); res.end();
  }catch(e){
    if(!res.headersSent) return send(res,502,{error:'analysis_unavailable'});
    sendEvent(res,{type:'error',message:'Analysis unavailable'}); res.end();
  }
}
