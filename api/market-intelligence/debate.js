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
      const stance = key==='bull'
        ? [
            '[DEBATE ROLE — AFFIRMATIVE]',
            'Take the strongest defensible YES / CONSTRUCTIVE side.',
            'Your job is not to summarize uncertainty. Your job is to prove why the subject can be attractive at the current evidence/price.',
            'Use at least three subject-specific facts. Explicitly rebut the strongest point from Data and, if present, Bramer.',
            'Do not use the word "Mixed" as your verdict.'
          ].join('\n')
        : key==='bear'
        ? [
            '[DEBATE ROLE — NEGATIVE]',
            'Take the strongest defensible NO / WAIT side.',
            'Your job is not to summarize uncertainty. Your job is to prove why the subject can be unattractive, overextended, too expensive, too risky, or premature at the current evidence/price.',
            'Use at least three subject-specific facts. Explicitly rebut Tim\'s strongest point.',
            'Do not use the word "Mixed" as your verdict.'
          ].join('\n')
        : [
            '[DEBATE ROLE — NEUTRAL DATA]',
            'Do not take Tim or Bramer\'s side.',
            'Rank the strongest evidence for and against the subject, then identify the deciding variable.'
          ].join('\n');

      const prompt=[
        ctx,
        '',
        '[DEBATE TOPIC]',
        topic,
        '',
        stance,
        prior ? '\n[PRIOR ANALYST READS]\n'+prior : '',
        '',
        'Use the resolved subject packet as the primary evidence. Broad market context is secondary.',
        'Directly address the strongest conflicting point already raised when applicable.',
        'Do not issue a personalized trade instruction.'
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
