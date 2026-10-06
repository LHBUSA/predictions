import { requireAllAccess, send } from '../../compare/api/_lib/access.js';
import { PERSONAS, buildResearchContext, askOpenAI, sseHeaders, sendEvent } from './_lib/server.js';

export default async function handler(req,res){
  if(req.method!=='POST') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res); if(!member) return;
  const topic=String(req.body?.topic||'').trim();
  if(!topic || topic.length>900) return send(res,400,{error:'invalid_topic'});
  try{
    const research=await buildResearchContext(topic,req.body?.stock_symbols,req.body?.crypto_symbols);
    const {resolved,context:ctx}=research;
    sseHeaders(res);
    sendEvent(res,{type:'debate_start',topic,resolved:{
      subject:resolved.subject,
      symbol:resolved.symbol,
      asset_type:resolved.asset_type,
      public_status:resolved.public_status,
      exchange:resolved.exchange,
      confidence:resolved.confidence,
      research:resolved.research
    }});
    sendEvent(res,{type:'research',resolved:{
      subject:resolved.subject,
      symbol:resolved.symbol,
      public_status:resolved.public_status,
      exchange:resolved.exchange,
      confidence:resolved.confidence
    }});
    const responses={};
    for(const key of ['quant','bull','bear']){
      const p=PERSONAS[key];
      sendEvent(res,{type:'persona_start',persona:key,name:p.name,role:p.role,emoji:key==='bull'?'▲':key==='bear'?'▼':'◆'});
      const prior=Object.entries(responses).map(([k,v])=>PERSONAS[k].name + ': ' + v).join('\n\n');
      const prompt=[
        ctx,
        '',
        '[DEBATE TOPIC]',
        topic,
        prior ? '\n[PRIOR ANALYST READS]\n'+prior : '',
        '',
        'Give your independent read on the resolved subject. Directly address the strongest conflicting point already raised when applicable.',
        'For "good buy" questions, end with a clear evidence status such as Constructive / Mixed / Weak, plus the specific fact that would most change your view. Do not issue a personalized trade instruction.'
      ].join('\n');
      const answer=await askOpenAI({instruction:p.instruction,input:prompt,maxOutput:500});
      responses[key]=answer;
      sendEvent(res,{type:'text',persona:key,text:answer});
      sendEvent(res,{type:'persona_done',persona:key});
    }
    sendEvent(res,{type:'debate_done',resolved:{subject:resolved.subject,symbol:resolved.symbol}});res.end();
  }catch(e){
    if(!res.headersSent) return send(res,502,{error:'analysis_unavailable'});
    sendEvent(res,{type:'error',message:'Analysis unavailable'});res.end();
  }
}
