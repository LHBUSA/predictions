import { requireAllAccess, send } from '../../compare/api/_lib/access.js';
import { PERSONAS, marketData, contextFromMarket, askOpenAI, sseHeaders, sendEvent } from '../../src/market-intelligence-server.js';

export default async function handler(req,res){
  if(req.method!=='POST') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res); if(!member) return;
  const message=String(req.body?.message||'').trim();
  const personaKey=String(req.body?.persona||'bull').toLowerCase();
  const persona=PERSONAS[personaKey];
  if(!message || message.length>1200) return send(res,400,{error:'invalid_message'});
  if(!persona) return send(res,400,{error:'unknown_persona'});
  try{
    const data=await marketData(req.body?.stock_symbols,req.body?.crypto_symbols);
    const ctx=contextFromMarket(data);
    const reply=await askOpenAI({
      instruction: persona.instruction,
      input: ctx + '\n\n[USER QUESTION]\n' + message,
      maxOutput: 650
    });
    sseHeaders(res);
    sendEvent(res,{type:'session',persona:personaKey,name:persona.name,role:persona.role});
    sendEvent(res,{type:'text',text:reply});
    sendEvent(res,{type:'done'});
    res.end();
  }catch(e){ return send(res,502,{error:'analysis_unavailable'}); }
}
