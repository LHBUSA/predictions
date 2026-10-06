(() => {
const $=(s)=>document.querySelector(s), $$=(s)=>[...document.querySelectorAll(s)];
const DEFAULT_STOCKS=['SPY','QQQ','DIA','IWM','VIX','AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AMD','PLTR','COIN'];
const DEFAULT_CRYPTO=['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','LINK'];
const NAMES={SPY:'S&P 500',QQQ:'Nasdaq 100',DIA:'Dow Jones',IWM:'Russell 2000',VIX:'Volatility',AAPL:'Apple',MSFT:'Microsoft',NVDA:'Nvidia',AMZN:'Amazon',META:'Meta',GOOGL:'Alphabet',TSLA:'Tesla',AMD:'AMD',PLTR:'Palantir',COIN:'Coinbase'};
let stocks=loadList('pbe_market_stocks',DEFAULT_STOCKS,20);
let crypto=loadList('pbe_market_crypto',DEFAULT_CRYPTO,12);
let mode='debate',persona='bull',busy=false,market=null,chartData='',isMember=false,focus='SPY',followOutput=true;

function loadList(key,fallback,max){
  try{
    const v=JSON.parse(localStorage.getItem(key)||'null');
    if(Array.isArray(v)&&v.length)return v.map(x=>String(x).toUpperCase()).filter(x=>/^[A-Z0-9.-]{1,10}$/.test(x)).slice(0,max);
  }catch{}
  return [...fallback];
}
function saveLists(){try{localStorage.setItem('pbe_market_stocks',JSON.stringify(stocks));localStorage.setItem('pbe_market_crypto',JSON.stringify(crypto))}catch{}}
const fmt=(v,d=2)=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(v)=>v==null||!Number.isFinite(Number(v))?'—':(Number(v)>0?'+':'')+Number(v).toFixed(2)+'%';
const cls=(v)=>Number(v)>0?'up':Number(v)<0?'dn':'flat';
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function inlineMd(s){
  return esc(s).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
}
function md(text){
  const lines=String(text||'').replace(/\r/g,'').split('\n');
  let html='',list=null;
  const close=()=>{if(list){html+='</'+list+'>';list=null}};
  for(const raw of lines){
    const line=raw.trimEnd();
    if(!line.trim()){close();continue}
    let m;
    if((m=line.match(/^(#{1,3})\s+(.+)$/))){close();const n=m[1].length;html+='<h'+n+'>'+inlineMd(m[2])+'</h'+n+'>';continue}
    if((m=line.match(/^\s*[-*]\s+(.+)$/))){if(list!=='ul'){close();list='ul';html+='<ul>'}html+='<li>'+inlineMd(m[1])+'</li>';continue}
    if((m=line.match(/^\s*\d+\.\s+(.+)$/))){if(list!=='ol'){close();list='ol';html+='<ol>'}html+='<li>'+inlineMd(m[1])+'</li>';continue}
    if(line.startsWith('> ')){close();html+='<p><em>'+inlineMd(line.slice(2))+'</em></p>';continue}
    close();html+='<p>'+inlineMd(line)+'</p>';
  }
  close();return html;
}

async function membership(){
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),4500);
  try{
    const r=await fetch('/api/membership',{credentials:'same-origin',cache:'no-store',signal:ctrl.signal});
    const b=await r.json().catch(()=>({}));clearTimeout(timer);
    if(r.ok&&b?.membership)return {...b.membership,authenticated:Boolean(b.authenticated)};
  }catch{}
  clearTimeout(timer);return {state:'unverified',entitled:false,authenticated:false};
}
function signIn(){
  const email=prompt('Email for your PropBetEdge sign-in link:');if(!email)return;
  fetch('https://auth.propbetedge.ai/magic/request',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({email,return_to:location.href})})
    .then(()=>alert('Check your inbox for the PropBetEdge sign-in link.')).catch(()=>alert('Sign-in is unavailable right now.'));
}
function lockedAction(){document.querySelector('#accessbar')?.scrollIntoView({behavior:'smooth',block:'nearest'})}
function renderPreview(){
  $('#equities').innerHTML=stocks.map(s=>rowHtml(s,NAMES[s]||'Equity',null,null,true)).join('');
  $('#crypto').innerHTML=crypto.slice(0,8).map(s=>rowHtml(s,'Crypto',null,null,false)).join('');
  $('#macro').innerHTML=['FED FUNDS','CPI','UNEMPLOYMENT','30Y MORTGAGE','10Y TREASURY','10Y−2Y'].map(k=>'<div class="row"><div class="row-left"><small>'+k+'</small></div><div class="row-right"><b>•.••</b></div></div>').join('');
  $('#fg-num').textContent='••';$('#fg-label').textContent='Locked';$('#fg-needle').style.left='50%';
  renderTickerPreview();renderFocus();renderLockedRight();bindRows();
}
function applyMembership(m){
  isMember=Boolean(m?.entitled&&(m.state==='all_access'||m.state==='owner'));
  document.body.classList.toggle('is-member',isMember);document.body.classList.toggle('is-preview',!isMember);
  $('#access-chip').textContent=isMember?'ALL ACCESS ACTIVE':(m?.authenticated?'ALL ACCESS REQUIRED':'PREVIEW');
  if(isMember)loadMarket();else renderPreview();
}
async function boot(){renderPreview();applyMembership(await membership())}

function rowHtml(symbol,name,price,change,isStock){
  const active=symbol===focus?' active':'';
  const val=price==null?'$•••••':'$'+fmt(price,price<10?3:2);
  const ch=change==null?'+•.••%':pct(change);
  return '<div class="row'+active+'" data-symbol="'+esc(symbol)+'" data-kind="'+(isStock?'stock':'crypto')+'"><div class="row-left"><b>'+esc(symbol)+'</b><small>'+esc(name||'')+'</small></div><div class="row-right"><b>'+val+'</b><small class="'+(change==null?'flat':cls(change))+'">'+ch+'</small></div></div>';
}
function bindRows(){$$('.row[data-symbol]').forEach(r=>r.onclick=()=>setFocus(r.dataset.symbol,r.dataset.kind))}
function renderRows(){
  const q=market?.stocks?.quotes||[];
  $('#equities').innerHTML=stocks.map(s=>{const x=q.find(v=>v.symbol===s);return rowHtml(s,NAMES[s]||'Equity',x?.price,x?.pct,true)}).join('');
  const coins=market?.crypto?.coins||[];
  $('#crypto').innerHTML=crypto.slice(0,10).map(s=>{const x=coins.find(v=>String(v.symbol||'').toUpperCase()===s);return rowHtml(s,x?.name||'Crypto',x?.current_price,x?.price_change_percentage_24h,false)}).join('');
  const m=market?.macro?.indicators||{},yc=market?.macro?.yieldCurve;
  const mr=[['FED FUNDS',m.fedfunds?.current?.value,'%'],['CPI',m.cpi?.current?.value,''],['UNEMPLOYMENT',m.unemployment?.current?.value,'%'],['30Y MORTGAGE',m.rate30?.current?.value,'%'],['10Y TREASURY',m.treasury10y?.current?.value,'%'],['10Y−2Y',yc?.spread,'%']];
  $('#macro').innerHTML=mr.map(([k,v,u])=>'<div class="row"><div class="row-left"><small>'+k+'</small></div><div class="row-right"><b>'+fmt(v,2)+u+'</b></div></div>').join('');
  const fg=market?.sentiment?.current;if(fg){const n=parseInt(fg.value);$('#fg-num').textContent=n;$('#fg-label').textContent=fg.value_classification||'—';$('#fg-needle').style.left=Math.max(0,Math.min(100,n))+'%'}
  const t=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});$('#eq-time').textContent=t;$('#crypto-time').textContent=t;
  const status=market?.stocks?.marketStatus;$('#market-session').textContent=status?.isOpen?'US OPEN':'US CLOSED';
  $('#market-mood').textContent=String(market?.mood?.label||market?.mood?.mood||'Market').toUpperCase();
  bindRows();renderFocus();renderRightRail();
}
function renderTickerPreview(){
  $('#ticker').innerHTML=[...stocks.slice(0,9),...crypto.slice(0,4)].map(s=>'<button data-symbol="'+s+'"><span>'+s+'</span> <b>•••••</b> <em class="flat">+•.••%</em></button>').join('');
  bindTicker();
}
function renderTicker(){
  const q=market?.stocks?.quotes||[],coins=market?.crypto?.coins||[],items=[];
  stocks.slice(0,12).forEach(s=>{const x=q.find(v=>v.symbol===s);if(x)items.push({s,p:x.price,c:x.pct,k:'stock'})});
  crypto.slice(0,6).forEach(s=>{const x=coins.find(v=>String(v.symbol||'').toUpperCase()===s);if(x)items.push({s,p:x.current_price,c:x.price_change_percentage_24h,k:'crypto'})});
  $('#ticker').innerHTML=items.map(x=>'<button class="'+(x.s===focus?'active':'')+'" data-symbol="'+x.s+'" data-kind="'+x.k+'"><span>'+x.s+'</span><b>$'+fmt(x.p,x.p<10?3:2)+'</b><em class="'+cls(x.c)+'">'+pct(x.c)+'</em></button>').join('');
  bindTicker();
}
function bindTicker(){$$('#ticker button').forEach(b=>b.onclick=()=>setFocus(b.dataset.symbol,b.dataset.kind||(crypto.includes(b.dataset.symbol)?'crypto':'stock')))}
async function loadMarket(){
  try{
    const r=await fetch('/api/market-intelligence/market?stocks='+encodeURIComponent(stocks.join(','))+'&crypto='+encodeURIComponent(crypto.join(',')),{credentials:'same-origin',cache:'no-store'});
    if(r.status===401||r.status===403){isMember=false;document.body.classList.remove('is-member');document.body.classList.add('is-preview');renderPreview();return}
    if(!r.ok)throw new Error(r.status);
    market=await r.json();renderRows();renderTicker();if(!crypto.includes(focus))loadTechnicals(focus);
  }catch{$('#ticker').innerHTML='<span style="padding:0 14px">Market feed temporarily unavailable</span>'}
}
function addSymbol(){
  const el=$('#add-symbol'),sym=el.value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g,'');if(!sym)return;
  if(!stocks.includes(sym)){stocks=[...stocks,sym].slice(-20);saveLists();renderPreview();if(isMember)loadMarket()}
  el.value='';setFocus(sym,'stock');
}
$('#add-symbol-btn').onclick=addSymbol;$('#add-symbol').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addSymbol()}});

function setFocus(symbol,kind='stock'){
  focus=String(symbol||'SPY').toUpperCase();
  $$('.row[data-symbol]').forEach(r=>r.classList.toggle('active',r.dataset.symbol===focus));
  $$('#ticker button').forEach(r=>r.classList.toggle('active',r.dataset.symbol===focus));
  renderFocus();
  if(kind==='stock'&&!crypto.includes(focus))loadTechnicals(focus);else renderCryptoFocus(focus);
}
function renderFocus(){
  $('#focus-symbol').textContent=focus;$('#tech-symbol').textContent=focus;
  const q=market?.stocks?.quotes||[],coins=market?.crypto?.coins||[];
  const sx=q.find(x=>x.symbol===focus),cx=coins.find(x=>String(x.symbol||'').toUpperCase()===focus);
  if(sx){
    $('#focus-name').textContent=NAMES[focus]||'Equity';
    $('#focus-price').textContent='$'+fmt(sx.price,sx.price<10?3:2);$('#focus-change').textContent=pct(sx.pct);$('#focus-change').className=cls(sx.pct);
    $('#focus-range').textContent='H '+fmt(sx.high,2)+' · L '+fmt(sx.low,2);
  }else if(cx){
    $('#focus-name').textContent=cx.name||'Crypto';
    $('#focus-price').textContent='$'+fmt(cx.current_price,cx.current_price<10?3:2);$('#focus-change').textContent=pct(cx.price_change_percentage_24h);$('#focus-change').className=cls(cx.price_change_percentage_24h);
    $('#focus-range').textContent='24H · 7D '+pct(cx.price_change_percentage_7d_in_currency);
  }else{
    $('#focus-name').textContent=NAMES[focus]||'Market';$('#focus-price').textContent='$—';$('#focus-change').textContent='—';$('#focus-range').textContent='H — · L —';
  }
}
function renderCryptoFocus(){
  $('#technicals').innerHTML='<div class="tech-card wide"><span>CRYPTO FOCUS</span><b>'+esc(focus)+'</b><small>Equity technical indicators are available when a stock or ETF is selected.</small></div>';
}
async function loadTechnicals(symbol){
  $('#tech-symbol').textContent=symbol;
  if(!isMember){renderLockedTechnicals();return}
  $('#technicals').innerHTML='<div class="tech-card wide"><span>LOADING</span><b>'+esc(symbol)+'</b><small>Reading technical structure…</small></div>';
  try{
    const r=await fetch('/api/market-intelligence/technicals?symbol='+encodeURIComponent(symbol),{credentials:'same-origin',cache:'no-store'});
    const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error();
    const rsi=d?.rsi?.rsi14,macd=d?.macd?.histogram,ema=d?.emas?.ema50,vol=d?.volume?.ratio,range=d?.range;
    $('#technicals').innerHTML=[
      techCard('RSI 14',fmt(rsi,1),d?.rsi?.signal14||'—',rsi>70?'dn':rsi<30?'up':'flat'),
      techCard('MACD',fmt(macd,3),d?.macd?.bias||'—',d?.macd?.bias==='bullish'?'up':'dn'),
      techCard('EMA 50','$'+fmt(ema,2),d?.emas?.trend==='above50'?'Price above':'Price below',d?.emas?.trend==='above50'?'up':'dn'),
      techCard('VOLUME',fmt(vol,2)+'×',d?.volume?.signal||'—','flat'),
      '<div class="tech-card wide"><span>52W RANGE</span><b>$'+fmt(range?.low52w,2)+' → $'+fmt(range?.high52w,2)+'</b><small>'+pct(range?.pctFromHigh)+' from high · ATR '+fmt(range?.atr,2)+'</small></div>'
    ].join('');
  }catch{$('#technicals').innerHTML='<div class="tech-card wide"><span>TECHNICALS</span><b>'+esc(symbol)+'</b><small>Technical data unavailable for this symbol.</small></div>'}
}
function techCard(label,val,note,c){return '<div class="tech-card"><span>'+label+'</span><b class="'+c+'">'+val+'</b><small>'+esc(note)+'</small></div>'}
function renderLockedTechnicals(){
  $('#technicals').innerHTML=['RSI 14','MACD','EMA 50','VOLUME'].map(x=>'<div class="tech-card"><span>'+x+'</span><b>•••</b><small>Locked</small></div>').join('')+'<div class="tech-card wide"><span>52W RANGE</span><b>••••• → •••••</b><small>All Access</small></div>';
}
function renderLockedRight(){
  renderLockedTechnicals();
  $('#market-pulse').innerHTML=['BTC dominance','Analyst consensus','Yield curve','Market mood','BTC mempool','BTC hashrate'].map(x=>'<div><span>'+x+'</span><b>••••</b></div>').join('');
  $('#news-list').innerHTML='<div class="news-item locked-copy">Live headlines unlock with All Access.</div>';
  $('#earnings-list').innerHTML='<div class="earning locked-copy">Live earnings calendar unlocks with All Access.</div>';
}
function renderRightRail(){
  const s=market?.options?.summary||{},yc=market?.macro?.yieldCurve,btc=market?.onchain?.btc;
  $('#market-pulse').innerHTML=[
    ['BTC dominance',fmt(market?.crypto?.btcDominance,1)+'%'],
    ['Analyst consensus',String(s.sentiment||'—').toUpperCase()+' · '+(s.bullish??0)+'B / '+(s.bearish??0)+'S'],
    ['Yield curve',fmt(yc?.spread,3)+'%'+(yc?.inverted?' · INVERTED':'')],
    ['Market mood',String(market?.mood?.label||market?.mood?.mood||'—').toUpperCase()],
    ['BTC mempool',btc?.mempool_transactions!=null?Number(btc.mempool_transactions).toLocaleString()+' tx':'—'],
    ['BTC hashrate',btc?.hashrate_24h?(Number(btc.hashrate_24h)/1e18).toFixed(1)+' EH/s':'—']
  ].map(([a,b])=>'<div><span>'+a+'</span><b>'+esc(b)+'</b></div>').join('');
  const news=market?.news?.news||[];
  $('#news-list').innerHTML=news.length?news.slice(0,9).map(n=>'<a class="news-item" href="'+esc(n.url||'#')+'" target="_blank" rel="noopener"><small>'+esc(n.source||'MARKET')+'</small><b>'+esc(n.headline||'')+'</b></a>').join(''):'<div class="news-item locked-copy">No headlines available.</div>';
  const earn=market?.news?.earnings||[];
  $('#earnings-list').innerHTML=earn.length?earn.slice(0,10).map(e=>'<div class="earning"><div><b>'+esc(e.symbol||'—')+'</b><span>'+(e.epsEstimate!=null?'EPS est '+esc(e.epsEstimate):'Estimate unavailable')+'</span></div><span>'+esc(e.hour||'')+'</span></div>').join(''):'<div class="earning locked-copy">No earnings in the current window.</div>';
}

function setMode(m){
  mode=m;$$('.mode').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  $('#persona-tabs').hidden=m!=='consult';$('#trade-lab').hidden=m!=='trade';$('#feed-wrap').hidden=m==='trade';$('.composer').hidden=m==='trade';
  if(m==='debate'){$('#prompt').placeholder='Throw a market question into the debate…';$('#mode-label').textContent='DEBATE MODE'}
  else if(m==='consult'){$('#prompt').placeholder='Ask '+persona.toUpperCase()+' for a market read…';$('#mode-label').textContent='CONSULT · '+persona.toUpperCase()}
}
function setPersona(p){persona=p;$$('.persona').forEach(b=>b.classList.toggle('active',b.dataset.persona===p));setMode('consult')}
$$('.mode').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));$$('.persona').forEach(b=>b.onclick=()=>setPersona(b.dataset.persona));

const feed=$('#feed'),jump=$('#jump-latest');
function nearBottom(){return feed.scrollHeight-feed.scrollTop-feed.clientHeight<120}
function scrollBottom(force=false){if(force||followOutput){feed.scrollTo({top:feed.scrollHeight,behavior:force?'smooth':'auto'});jump.hidden=true}}
feed.addEventListener('scroll',()=>{followOutput=nearBottom();jump.hidden=followOutput});
jump.onclick=()=>{followOutput=true;scrollBottom(true)};

function addTopic(t){$('#welcome')?.remove();const d=document.createElement('div');d.className='topic';d.textContent=t;$('#messages').appendChild(d);followOutput=true;scrollBottom()}
function addBlock(key,name,role){const d=document.createElement('div');d.className='block '+key;d.innerHTML='<div class="block-head"><b>'+esc(name)+'</b><span>'+esc(role||'')+'</span></div><div class="answer markdown"><p>Reading live market context…</p></div>';$('#messages').appendChild(d);scrollBottom();return d.querySelector('.answer')}
function addUser(t){$('#welcome')?.remove();const d=document.createElement('div');d.className='msg user-msg';d.innerHTML='<div class="msg-head"><b>YOU</b></div><div class="answer">'+esc(t)+'</div>';$('#messages').appendChild(d);followOutput=true;scrollBottom()}
async function parseSSE(res,onEvent){
  const reader=res.body.getReader(),dec=new TextDecoder();let buf='';
  while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split('\n');buf=lines.pop()||'';for(const line of lines){if(!line.startsWith('data: '))continue;try{onEvent(JSON.parse(line.slice(6)))}catch{}}}
}
async function runDebate(t){
  addTopic('DEBATE · '+t);const blocks={};
  const r=await fetch('/api/market-intelligence/debate',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({topic:t,stock_symbols:stocks.join(','),crypto_symbols:crypto.join(',')})});
  if(!r.ok)throw new Error(r.status);
  await parseSSE(r,e=>{if(e.type==='persona_start')blocks[e.persona]=addBlock(e.persona,e.name,e.role);if(e.type==='text'&&blocks[e.persona]){blocks[e.persona].innerHTML=md(e.text);scrollBottom()}if(e.type==='error')throw new Error(e.message||'analysis_error')});
}
async function runConsult(t){
  addUser(t);const box=addBlock(persona,persona.toUpperCase(),persona==='bull'?'The Bull Case':persona==='bear'?'The Bear Case':'The Data Read');
  const r=await fetch('/api/market-intelligence/stream',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({message:t,persona,stock_symbols:stocks.join(','),crypto_symbols:crypto.join(',')})});
  if(!r.ok)throw new Error(r.status);
  await parseSSE(r,e=>{if(e.type==='text'){box.innerHTML=md(e.text);scrollBottom()}});
}
async function send(){
  if(!isMember){lockedAction();return}
  const t=$('#prompt').value.trim();if(!t||busy)return;busy=true;$('#send').disabled=true;$('#prompt').value='';followOutput=true;
  try{if(mode==='debate')await runDebate(t);else await runConsult(t)}
  catch{const d=document.createElement('div');d.className='topic';d.textContent='Analysis unavailable. Please try again.';$('#messages').appendChild(d)}
  finally{busy=false;$('#send').disabled=false;$('#prompt').focus();scrollBottom()}
}
$$('.quick button').forEach(b=>b.onclick=()=>{if(!isMember){lockedAction();return}$('#prompt').value=b.dataset.q;send()});
$('#send').onclick=send;$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
$('#prompt').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(120,e.target.scrollHeight)+'px'});

function fileToData(file){return new Promise((resolve,reject)=>{const rd=new FileReader();rd.onload=()=>resolve(String(rd.result||''));rd.onerror=reject;rd.readAsDataURL(file)})}
async function useChart(file){
  if(!isMember){lockedAction();return}
  if(!file||!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>4_500_000){alert('Use a PNG, JPG or WEBP chart under 4.5 MB.');return}
  chartData=await fileToData(file);const img=$('#chart-preview'),empty=$('#chart-empty');img.src=chartData;img.hidden=false;empty.hidden=true;
}
const drop=$('#chart-drop'),file=$('#chart-file');
$('#choose-chart').onclick=e=>{e.preventDefault();if(!isMember){lockedAction();return}file.click()};
drop.addEventListener('click',e=>{if(!isMember){lockedAction();return}if(e.target.id!=='choose-chart'&&e.target.tagName!=='IMG')file.click()});
file.addEventListener('change',()=>useChart(file.files?.[0]));
for(const ev of ['dragenter','dragover'])drop.addEventListener(ev,e=>{e.preventDefault();if(isMember)drop.classList.add('drag')});
for(const ev of ['dragleave','drop'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag')});
drop.addEventListener('drop',e=>useChart(e.dataTransfer?.files?.[0]));
$('#analyze-chart').onclick=async()=>{
  if(!isMember){lockedAction();return}if(!chartData){alert('Add a chart screenshot first.');return}
  const btn=$('#analyze-chart'),out=$('#trade-result');btn.disabled=true;btn.textContent='READING CHART…';out.hidden=false;out.textContent='Reading chart structure and live market context…';
  try{
    const r=await fetch('/api/market-intelligence/chart',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({image:chartData,symbol:$('#trade-symbol').value||focus,direction:$('#trade-direction').value,entry:$('#trade-entry').value,stop:$('#trade-stop').value,target:$('#trade-target').value,thesis:$('#trade-thesis').value})});
    const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error();out.innerHTML=md(b.analysis||'No analysis returned.');
  }catch{out.textContent='Trade Lab could not complete this chart review. Please try again.'}
  finally{btn.disabled=false;btn.textContent='READ THE CHART'}
};
$('#market-signin').onclick=signIn;
boot();setInterval(()=>{if(isMember)loadMarket()},60000);
})();