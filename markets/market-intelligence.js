(() => {
const $=(s)=>document.querySelector(s), $$=(s)=>[...document.querySelectorAll(s)];
let mode='debate', persona='bull', busy=false, market=null;
const stocks=['SPY','QQQ','DIA','IWM','VIX'];
const crypto=['BTC','ETH','SOL','BNB','XRP','ADA'];
const names={SPY:'S&P 500',QQQ:'Nasdaq 100',DIA:'Dow',IWM:'Russell 2000',VIX:'Volatility'};
const fmt=(v,d=2)=>v==null?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(v)=>v==null?'—':(Number(v)>0?'+':'')+Number(v).toFixed(2)+'%';
const cls=(v)=>Number(v)>0?'up':Number(v)<0?'dn':'flat';
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function membership(){
  try{
    const r=await fetch('/api/membership',{credentials:'same-origin',cache:'no-store'});
    const b=await r.json().catch(()=>({}));
    if(r.ok&&b?.membership) return {...b.membership,authenticated:Boolean(b.authenticated)};
  }catch{}
  return {state:'unverified',entitled:false,authenticated:false};
}
function gate(m){
  const state=$('#gate-state'), actions=$('#gate-actions');
  if(m.entitled&&(m.state==='all_access'||m.state==='owner')){
    $('#gate').hidden=true; $('#terminal').hidden=false; loadMarket(); return;
  }
  if(m.state==='anonymous'||!m.authenticated){
    state.textContent='Sign in with the same PropBetEdge account used for All Access.';
    actions.innerHTML='<button class="primary" id="signin">Sign in</button><a href="https://propbetedge.ai/pro">Get All Access</a>';
    $('#signin').onclick=signIn;
  }else if(m.state==='signed_in'){
    state.textContent='You are signed in, but this account does not currently include All Access.';
    actions.innerHTML='<a class="primary" href="https://propbetedge.ai/pro">Upgrade to All Access</a>';
  }else{
    state.textContent='Membership could not be verified right now. Nothing premium is loaded until access is confirmed.';
    actions.innerHTML='<button class="primary" id="retry">Check again</button>';
    $('#retry').onclick=boot;
  }
}
function signIn(){
  const email=prompt('Email for your PropBetEdge sign-in link:');
  if(!email)return;
  fetch('https://auth.propbetedge.ai/magic/request',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({email,return_to:location.href})})
    .then(()=>alert('Check your inbox for the PropBetEdge sign-in link.')).catch(()=>alert('Sign-in is unavailable right now.'));
}
async function boot(){ $('#gate-state').textContent='Checking membership…'; $('#gate-actions').innerHTML=''; gate(await membership()); }

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
  mode=m; $$('.mode').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  $('#persona-tabs').hidden=m!=='consult';
  $('#prompt').placeholder=m==='debate'?'Throw a market question into the debate…':'Ask '+persona.toUpperCase()+' for a market read…';
  $('#mode-label').textContent=m==='debate'?'DEBATE MODE':'CONSULT · '+persona.toUpperCase();
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
  const t=$('#prompt').value.trim();if(!t||busy)return;busy=true;$('#send').disabled=true;$('#prompt').value='';
  try{if(mode==='debate')await runDebate(t);else await runConsult(t)}catch{const d=document.createElement('div');d.className='topic';d.textContent='Analysis unavailable. Please try again.';$('#messages').appendChild(d)}
  finally{busy=false;$('#send').disabled=false;$('#prompt').focus()}
}
$$('.mode').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));$$('.persona').forEach(b=>b.onclick=()=>setPersona(b.dataset.persona));
$$('.quick button').forEach(b=>b.onclick=()=>{$('#prompt').value=b.dataset.q;send()});
$('#send').onclick=send;$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
$('#prompt').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(120,e.target.scrollHeight)+'px'});
boot();setInterval(()=>{if(!$('#terminal').hidden)loadMarket()},90000);
})();