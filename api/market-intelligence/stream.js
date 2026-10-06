import { requireAllAccess, send } from '../../compare/api/_lib/access.js';
import { PERSONAS, buildResearchContext, askOpenAI, sseHeaders, sendEvent } from './_lib/server.js';

export default async function handler(req,res){
  if(req.method!=='POST') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res); if(!member) return;
  const message=String(req.body?.message||'').trim();
  const personaKey=String(req.body?.persona||'bull').toLowerCase();
  const persona=PERSONAS[personaKey];
  if(!message || message.length>1200) return send(res,400,{error:'invalid_message'});
  if(!persona) return send(res,400,{error:'unknown_persona'});
  try{
    const research=await buildResearchContext(message,req.body?.stock_symbols,req.body?.crypto_symbols);
    const {resolved,context:ctx}=research;
    const reply=await askOpenAI({
      instruction:persona.instruction,
      input:[
        ctx,
        '',
        '[USER QUESTION]',
        message,
        '',
        'Answer the question about the resolved subject. For "good buy" questions, end with a clear evidence status such as Constructive / Mixed / Weak and the specific fact that would most change the read. Do not issue a personalized trade instruction.'
      ].join('\n'),
      maxOutput:700
    });
    sseHeaders(res);
    sendEvent(res,{type:'session',persona:personaKey,name:persona.name,role:persona.role});
    sendEvent(res,{type:'research',resolved:{
      subject:resolved.subject,
      symbol:resolved.symbol,
      public_status:resolved.public_status,
      exchange:resolved.exchange,
      confidence:resolved.confidence
    }});
    sendEvent(res,{type:'text',text:reply});
    sendEvent(res,{type:'done',resolved:{subject:resolved.subject,symbol:resolved.symbol}});
    res.end();
  }catch(e){return send(res,502,{error:'analysis_unavailable'});}
}
