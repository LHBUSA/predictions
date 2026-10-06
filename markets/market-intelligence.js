(() => {
const $=(s)=>document.querySelector(s), $$=(s)=>[...document.querySelectorAll(s)];
let mode='debate', persona='bull', busy=false, market=null, chartData='', isMember=false;
const stocks=['SPY','QQQ','DIA','IWM','VIX'];
const crypto=['BTC','ETH','SOL','BNB','XRP','ADA'];
const names={SPY:'S&P 500',QQQ:'Nasdaq 100',DIA:'Dow',IWM:'Russell 2000',VIX:'Volatility'};
const fmt=(v,d=2)=>v==null?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(v)=>v==null?'—':(Number(v)>0?'+':'')+Number(v).toFixed(2)+'%';
const cls=(v)=>Number(v)>0?'up':Number(v)<0?'dn':'flat';
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function membership(){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),4500);
  try{
    const r=await fetch('/api/membership',{credentials:'same-origin',cache:'no-store',signal:ctrl.signal});
    const b=await r.json().catch(()=>({}));
    clearTimeout(timer);
    if(r.ok&&b?.membership) return {...b.membership,authenticated:Boolean(b.authenticated)};
  }catch{}
  clearTimeout(timer);
  return {state:'unverified',entitled:false,authenticated:false};
}
function signIn(){
  const email=prompt('Email for your PropBetEdge sign-in link:');
  if(!email)return;
  fetch('https://auth.propbetedge.ai/magic/request',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({email,return_to:location.href})})
    .then(()=>alert('Check your inbox for the PropBetEdge sign-in link.')).catch(()=>alert('Sign-in is unavailable right now.'));
}
function renderPreview(){
  const eq=[['SPY','S&P 500'],['QQQ','Nasdaq 100'],['DIA','Dow'],['IWM','Russell 2000'],['VIX','Volatility']];
  $('#equities').innerHTML=eq.map(([s,n])=>'<div class="row"><div class="row-left"><b>'+s+'</b><small>'+n+'</small></div><div class="row-right"><b>$•••••</b><small>+•.••%</small></div></div>').join('');
  const cc=[['BTC','Bitcoin'],['ETH','Ethereum'],['SOL','Solana'],['BNB','BNB Chain']];
  $('#crypto').innerHTML=cc.map(([s,n])=>'<div class="row"><div class="row-left"><b>'+s+'</b><small>'+n+'</small></div><div class="row-right"><b>$•••••</b><small>+•.••%</small></div></div>').join('');
  const mm=['FED FUNDS','30Y MORTGAGE','UNEMPLOYMENT','10Y TREASURY','10Y−2Y'];
  $('#macro').innerHTML=mm.map(k=>'<div class="row"><div class="row-left"><small>'+k+'</small></div><div class="row-right"><b>•.••%</b></div></div>').join('');
  $('#fg-num').textContent='••'; $('#fg-label').textContent='Locked'; $('#fg-needle').style.left='50%';
}
function applyMembership(m){
  isMember=Boolean(m?.entitled&&(m.state==='all_access'||m.state==='owner'));
  document.body.classList.toggle('is-member',isMember);
  document.body.classList.toggle('is-preview',!isMember);
  const chip=$('#access-chip');
  if(isMember){
    if(chip) chip.textContent='ALL ACCESS ACTIVE';
    loadMarket();
    return;
  }
  if(chip) chip.textContent=m?.authenticated?'ALL ACCESS REQUIRED':'PREVIEW';
  renderPreview();
}
async function boot(){
  renderPreview();
  const m=await membership();
  applyMembership(m);
}
function renderRows(){
  const q=market?.stocks?.quotes||[];
  $('#equities').innerHTML=stocks.map(s=>{const x=q.find(v=>v.symbol===s);if(!x)return'';return '<div class="row"><div class="row-left"><b>'+s+'</b><small>'+names[s]+'</small></div><div class="row-right"><b>$'+fmt(x.price)+'</b><small class="'+cls(x.pct)+'">'+pct(x.pct)+'</small></div></div>'}).join('');
  const coins=market?.crypto?.coins||[];
  $('#crypto').innerHTML=crypto.slice(0,4).map(s=>{const x=coins.find(v=>String(v.symbol||'').toUpperCase()===s);if(!x)return'';return '<div class="row"><div class="row-left"><b>'+s+'</b><small>'+esc(x.name||'Crypto')+'</small></div><div class="row-right"><b>$'+fmt(x.current_price,x.current_price<100?2:0)+'</b><small class="'+cls(x.price_change_percentage_24h)+'">'+pct(x.price_change_percentage_24h)+'</small></div></div>'}).join('');
  const m=market?.macro?.indicators||{}, yc=market?.macro?.yieldCurve;
  const mr=[['FED FUNDS',m.fedfunds?.current?.value,'%'],['30Y MORTGAGE',m.rate30?.current?.value,'%'],['UNEMPLOYMENT',m.unemployment?.current?.value,'%'],['10Y TREASURY',m.treasury10y?.current?.value,'%'],['10Y−2Y',yc?.spread,'%']];
  $('#macro').innerHTML=mr.map(([k,v,u])=>'<div class="row"><div class="row-left"><small>'+k+'</small></div><div class="row-right"><b>'+fmt(v,2)+u+'</b></div></div>').join('');
  const fg=market?.sentiment?.current;if(fg){const n=parseInt(fg.value);$('#fg-num').textContent=n;$('#fg-label').textContent=fg.value_classification||'—';$('#fg-needle').style.left=n+'%';}
  const t=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});$('#eq-time').textContent=t;$('#crypto-time').textContent=t;
  const mood=market?.mood?.label||'Market';$('#market-mood').textContent=mood.toUpperCase();
}
function renderTicker(){
  const q=market?.stocks?.quotes||[], coins=market?.crypto?.coins||[];
  const items=[];
  for(const s of ['SPY','QQQ','DIA','IWM','VIX']){const x=q.find(v=>v.symbol===s);if(x)items.push([s,'$'+fmt(x.price),pct(x.pct),cls(x.pct)]);}
  for(const s of ['BTC','ETH','SOL']){const x=coins.find(v=>String(v.symbol||'').toUpperCase()===s);if(x)items.push([s,'$'+fmt(x.current_price,x.current_price<100?2:0),pct(x.price_change_percentage_24h),cls(x.price_change_percentage_24h)]);}
  $('#ticker').innerHTML=items.map(i=>'<span>'+i[0]+' <b>'+i[1]+'</b> <em class="'+i[3]+'">'+i[2]+'</em></span>').join('');
}
async function loadMarket(){
  try{
    const r=await fetch('/api/market-intelligence/market?stocks='+stocks.join(',')+'&crypto='+crypto.join(','),{credentials:'same-origin',cache:'no-store'});
    if(r.status===401||r.status===403){location.reload();return}
    if(!r.ok)throw new Error(r.status);
    market=await r.json();renderRows();renderTicker();
  }catch(e){$('#ticker').innerHTML='<span>Market feed temporarily unavailable</span>'}
}
function setMode(m){
  mode=m; document.querySelectorAll('.mode').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  $('#persona-tabs').hidden=m!=='consult';
  $('#trade-lab').hidden=m!=='trade';
  $('#feed').hidden=m==='trade';
  $('.composer').hidden=m==='trade';
  if(m==='debate'){$('#prompt').placeholder='Throw a market question into the debate…';$('#mode-label').textContent='DEBATE MODE';}
  else if(m==='consult'){$('#prompt').placeholder='Ask '+persona.toUpperCase()+' for a market read…';$('#mode-label').textContent='CONSULT · '+persona.toUpperCase();}
}
function setPersona(p){persona=p;$$('.persona').forEach(b=>b.classList.toggle('active',b.dataset.persona===p));setMode('consult')}
function addTopic(t){$('#welcome')?.remove();const d=document.createElement('div');d.className='topic';d.textContent=t;$('#messages').appendChild(d);scroll()}
function scroll(){const f=$('#feed');f.scrollTop=f.scrollHeight}
function addBlock(key,name,role){const d=document.createElement('div');d.className='block '+key;d.innerHTML='<div class="block-head"><b>'+esc(name)+'</b><span>'+esc(role||'')+'</span></div><div class="answer">Reading live market context…</div>';$('#messages').appendChild(d);scroll();return d.querySelector('.answer')}
function addUser(t){$('#welcome')?.remove();const d=document.createElement('div');d.className='msg user-msg';d.innerHTML='<div class="msg-head"><b>YOU</b></div><div class="answer">'+esc(t)+'</div>';$('#messages').appendChild(d);scroll()}
async function parseSSE(res,onEvent){
  const reader=res.body.getReader(), dec=new TextDecoder();let buf='';
  while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split('\n');buf=lines.pop()||'';for(const line of lines){if(!line.startsWith('data: '))continue;try{onEvent(JSON.parse(line.slice(6)))}catch{}}}
}
async function runDebate(t){
  addTopic('DEBATE · '+t);const blocks={};
  const r=await fetch('/api/market-intelligence/debate',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({topic:t,stock_symbols:stocks.join(','),crypto_symbols:crypto.join(',')})});
  if(!r.ok)throw new Error(r.status);
  await parseSSE(r,e=>{
    if(e.type==='persona_start')blocks[e.persona]=addBlock(e.persona,e.name,e.role);
    if(e.type==='text'&&blocks[e.persona])blocks[e.persona].textContent=e.text;
    if(e.type==='error')throw new Error(e.message||'analysis_error');
  });
}
async function runConsult(t){
  addUser(t);const box=addBlock(persona,persona.toUpperCase(),persona==='bull'?'The Bull Case':persona==='bear'?'The Bear Case':'The Data Read');
  const r=await fetch('/api/market-intelligence/stream',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({message:t,persona,stock_symbols:stocks.join(','),crypto_symbols:crypto.join(',')})});
  if(!r.ok)throw new Error(r.status);
  await parseSSE(r,e=>{if(e.type==='text')box.textContent=e.text});
}
async function send(){
  if(!isMember){document.querySelector('#accessbar')?.scrollIntoView({behavior:'smooth',block:'nearest'});return}
  const t=$('#prompt').value.trim();if(!t||busy)return;busy=true;$('#send').disabled=true;$('#prompt').value='';
  try{if(mode==='debate')await runDebate(t);else await runConsult(t)}catch{const d=document.createElement('div');d.className='topic';d.textContent='Analysis unavailable. Please try again.';$('#messages').appendChild(d)}
  finally{busy=false;$('#send').disabled=false;$('#prompt').focus()}
}
document.querySelectorAll('.mode').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));document.querySelectorAll('.persona').forEach(b=>b.onclick=()=>setPersona(b.dataset.persona));

function fileToData(file){
  return new Promise((resolve,reject)=>{
    const rd=new FileReader();rd.onload=()=>resolve(String(rd.result||''));rd.onerror=reject;rd.readAsDataURL(file);
  });
}
async function useChart(file){
  if(!file||!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>4_500_000){alert('Use a PNG, JPG or WEBP chart under 4.5 MB.');return}
  chartData=await fileToData(file);
  const img=$('#chart-preview'), empty=$('#chart-empty');img.src=chartData;img.hidden=false;empty.hidden=true;
}
const drop=$('#chart-drop'), file=$('#chart-file');
$('#choose-chart').onclick=(e)=>{e.preventDefault();if(!isMember){document.querySelector('#accessbar')?.scrollIntoView({behavior:'smooth',block:'nearest'});return}file.click()};
drop.addEventListener('click',(e)=>{if(!isMember){document.querySelector('#accessbar')?.scrollIntoView({behavior:'smooth',block:'nearest'});return}if(e.target.id!=='choose-chart'&&e.target.tagName!=='IMG')file.click()});
file.addEventListener('change',()=>useChart(file.files?.[0]));
for(const ev of ['dragenter','dragover'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('drag')});
for(const ev of ['dragleave','drop'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag')});
drop.addEventListener('drop',e=>useChart(e.dataTransfer?.files?.[0]));

$('#analyze-chart').onclick=async()=>{
  if(!isMember){document.querySelector('#accessbar')?.scrollIntoView({behavior:'smooth',block:'nearest'});return}
  if(!chartData){alert('Add a chart screenshot first.');return}
  const btn=$('#analyze-chart'), out=$('#trade-result');btn.disabled=true;btn.textContent='READING CHART…';out.hidden=false;out.textContent='Reading chart structure and live market context…';
  try{
    const r=await fetch('/api/market-intelligence/chart',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({
      image:chartData,
      symbol:$('#trade-symbol').value,
      direction:$('#trade-direction').value,
      entry:$('#trade-entry').value,
      stop:$('#trade-stop').value,
      target:$('#trade-target').value,
      thesis:$('#trade-thesis').value
    })});
    const b=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(b.error||r.status);
    out.textContent=b.analysis||'No analysis returned.';
  }catch(e){out.textContent='Trade Lab could not complete this chart review. Please try again.'}
  finally{btn.disabled=false;btn.textContent='READ THE CHART'}
};
$$('.quick button').forEach(b=>b.onclick=()=>{$('#prompt').value=b.dataset.q;send()});
$('#send').onclick=send;$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
$('#prompt').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(120,e.target.scrollHeight)+'px'});
$('#market-signin').onclick=signIn;boot();setInterval(()=>{if(isMember)loadMarket()},90000);
})();