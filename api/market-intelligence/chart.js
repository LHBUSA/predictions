import { requireAllAccess, send } from '../../compare/api/_lib/access.js';
import { marketData, contextFromMarket } from './_lib/server.cjs';

const MODEL='gpt-5.4-mini';

export default async function handler(req,res){
  if(req.method!=='POST') return send(res,405,{error:'method_not_allowed'});
  const member=await requireAllAccess(req,res); if(!member) return;
  const image=String(req.body?.image||'');
  const symbol=String(req.body?.symbol||'').trim().toUpperCase().slice(0,12);
  const direction=String(req.body?.direction||'').trim().toLowerCase().slice(0,12);
  const entry=String(req.body?.entry||'').trim().slice(0,32);
  const stop=String(req.body?.stop||'').trim().slice(0,32);
  const target=String(req.body?.target||'').trim().slice(0,32);
  const thesis=String(req.body?.thesis||'').trim().slice(0,1000);
  if(!/^data:image\/(png|jpeg|webp);base64,/.test(image) || image.length>6000000) return send(res,400,{error:'invalid_chart'});
  if(!process.env.OPENAI_API_KEY) return send(res,503,{error:'analysis_not_configured'});
  try{
    const market=await marketData(symbol || 'SPY,QQQ,DIA,IWM,VIX','BTC,ETH,SOL');
    const ctx=contextFromMarket(market);
    const details=[
      'Symbol: '+(symbol||'not supplied'),
      'Direction stated by user: '+(direction||'not supplied'),
      'Entry stated by user: '+(entry||'not supplied'),
      'Stop stated by user: '+(stop||'not supplied'),
      'Target stated by user: '+(target||'not supplied'),
      'User thesis: '+(thesis||'not supplied')
    ].join('\n');
    const instructions=[
      'You are the PropBetEdge Trade Lab chart analyst.',
      'Analyze the uploaded chart as an informational risk review, not personalized financial advice.',
      'Do not tell the user to buy, sell, enter, exit, size a position, or risk a specific dollar amount.',
      'You may evaluate the user-supplied entry, stop and target structurally, calculate or discuss risk/reward if the values are legible, identify support/resistance visible in the chart, flag contradictions with live market context, and state what evidence would invalidate the setup.',
      'Never invent a price, indicator value, time frame, support level or chart annotation you cannot actually see.',
      'Return concise markdown with exactly these headings: Chart Read, Live Context, Bull Case, Bear Case, Risk Flags, What Would Change The Read.'
    ].join(' ');
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+process.env.OPENAI_API_KEY},
      body:JSON.stringify({
        model:MODEL,
        reasoning:{effort:'none'},
        instructions,
        input:[{
          role:'user',
          content:[
            {type:'input_text',text:ctx+'\n\n[USER-SUPPLIED SETUP]\n'+details},
            {type:'input_image',image_url:image}
          ]
        }],
        max_output_tokens:950
      }),
      signal:AbortSignal.timeout(45000)
    });
    const body=await r.json().catch(()=>null);
    if(!r.ok||!body) return send(res,502,{error:'chart_analysis_failed'});
    const text=(body.output||[]).flatMap((x)=>x?.content||[]).filter((x)=>x?.type==='output_text').map((x)=>x.text||'').join('').trim();
    if(!text) return send(res,502,{error:'empty_chart_analysis'});
    return send(res,200,{analysis:text,model:MODEL});
  }catch(e){ return send(res,502,{error:'chart_analysis_failed'}); }
}
