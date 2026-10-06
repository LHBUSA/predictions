const API='/api';
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=(v)=>v==null?'—':`${(Number(v)*100).toFixed(1)}%`;
const usd=(v,d=2)=>v==null?'—':Number(v).toLocaleString(undefined,{style:'currency',currency:'USD',minimumFractionDigits:d,maximumFractionDigits:d});
const ago=(iso)=>{if(!iso)return'—';const sec=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));return sec<10?'just now':sec<60?`${sec}s ago`:sec<3600?`${Math.round(sec/60)}m ago`:`${Math.round(sec/3600)}h ago`;};
const digits=(v)=>{const n=Math.abs(Number(v));return n>=1000?2:n>=1?4:n>=.01?5:8};
async function get(p){const r=await fetch(`${API}/${p}`,{cache:'no-store'});if(!r.ok)throw new Error(`${p} ${r.status}`);return r.json();}

let closeAt=null;
let marketRows=[];
let marketQuery='';
let marketLast=new Map();
const marketHistory=new Map();

function tickCountdown(){
  if(!closeAt){$('countdown').textContent='--:--';return;}
  const s=Math.max(0,Math.floor((Date.parse(closeAt)-Date.now())/1000));
  $('countdown').textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function featureMap(f){return f&&typeof f==='object'?f:{};}

function renderNowcast(n,rh){
  const live=$('crypto-live');
  if(!n?.ok||!n.window){live.querySelector('span').textContent='Nowcast unavailable';return;}
  live.querySelector('span').textContent=n.active?'Live nowcast':'Last window';
  closeAt=n.window.close_at;
  tickCountdown();
  const f=n.latest_forecast;
  const fm=featureMap(f?.features);
  const btc=(rh?.symbols||[]).find(x=>x.symbol==='BTC-USD');
  const target=Number(n.window.proxy_open_usd);
  const spot=btc?.mid??fm.btc_spot_usd??null;
  $('target').textContent=usd(target,2);
  $('spot').textContent=usd(spot,2);
  $('hero-spot').textContent=usd(spot,2);
  if(spot!=null&&target>0){
    const d=spot-target,p=d/target*100;
    $('distance').textContent=`${d>=0?'+':''}${usd(d,2)}`;
    $('distance-sub').textContent=`${p>=0?'+':''}${p.toFixed(3)}% from reference`;
  }
  $('pbe-up').textContent=f?pct(f.p_up):'—';
  $('hero-pbe-up').textContent=f?pct(f.p_up):'—';
  $('hero-meter').style.width=f?`${Math.max(0,Math.min(100,Number(f.p_up)*100))}%`:'0%';
  $('model-meta').textContent=f?`${f.model_id}@${f.model_version} · ${ago(f.data_cutoff_at)}`:'awaiting forecast';
  const k=n.markets?.kalshi;
  const pm=n.markets?.polymarket;
  $('kalshi-up').textContent=k?.mid==null?'—':pct(k.mid);
  $('hero-kalshi').textContent=k?.mid==null?'—':pct(k.mid);
  $('kalshi-meta').textContent=k?`${k.market_status||'market'} · ${ago(k.captured_at)}`:'same contract benchmark';
  $('mkt-kalshi').textContent=k?.mid==null?'—':pct(k.mid);
  $('mkt-poly').textContent=pm?.mid==null?'—':pct(pm.mid);
  if(f&&k?.mid!=null){
    const gap=(Number(f.p_up)-Number(k.mid))*100;
    $('divergence').textContent=`${gap>=0?'+':''}${gap.toFixed(1)} pts`;
    $('chart-gap').textContent=`${gap>=0?'+':''}${gap.toFixed(1)} pts`;
    $('hero-signal-copy').textContent=Math.abs(gap)>=10?`PBE differs from Kalshi by ${Math.abs(gap).toFixed(1)} pts`:gap>=0?'PBE is above the market':'PBE is below the market';
  } else {
    $('divergence').textContent='—';
    $('chart-gap').textContent='—';
    $('hero-signal-copy').textContent='Waiting for market benchmark';
  }
  $('chart-pbe').textContent=f?pct(f.p_up):'—';
  $('chart-kalshi').textContent=k?.mid==null?'—':pct(k.mid);
  $('window-times').textContent=`${new Date(n.window.open_at).toISOString().slice(11,16)}–${new Date(n.window.close_at).toISOString().slice(11,16)} UTC`;
  const age=f?Date.now()-Date.parse(f.data_cutoff_at):Infinity;
  const fr=$('freshness'); fr.textContent=age<120000?'current':age<300000?'delayed':'stale'; fr.className=`fresh ${age<120000?'fresh-current':age<300000?'fresh-delayed':'fresh-stale'}`;
  const evidence=[
    ['Current proxy',fm.btc_spot_usd!=null?usd(fm.btc_spot_usd,2):'—'],
    ['Open reference',fm.btc_open_ref_usd!=null?usd(fm.btc_open_ref_usd,2):usd(target,2)],
    ['Distance (z)',fm.z_distance!=null?Number(fm.z_distance).toFixed(3):'—'],
    ['Realized vol (60m)',fm.rv60_annualized!=null?`${(Number(fm.rv60_annualized)*100).toFixed(1)}% ann.`:'—'],
    ['Horizon',fm.horizon_min!=null?`${Number(fm.horizon_min).toFixed(1)} min`:'—'],
    ['Exchange gap',fm.exchange_gap_usd!=null?usd(fm.exchange_gap_usd,2):'—']
  ];
  $('evidence').innerHTML=evidence.map(([a,b])=>`<div><span>${esc(a)}</span><strong class="num">${esc(b)}</strong></div>`).join('');
  renderChart(n);
  renderRecord(n.record);
}

function renderChart(n){
  const svg=$('prob-chart'); const tip=$('chart-tooltip');
  const W=900,H=360,PL=50,PR=22,PT=38,PB=42;
  const open=Date.parse(n.window.open_at),close=Date.parse(n.window.close_at);
  const x=t=>PL+(Date.parse(t)-open)/(close-open)*(W-PL-PR);
  const y=v=>PT+(1-Number(v))*(H-PT-PB);
  const rowsP=(n.forecast_path||[]).filter(r=>r.p_up!=null);
  const rowsK=(n.venue_path?.kalshi||[]).filter(r=>r.mid!=null);
  const rowsM=(n.venue_path?.polymarket||[]).filter(r=>r.mid!=null);
  const path=(rows,key)=>rows.map((r,i)=>`${i?'L':'M'}${x(r.t).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const p=path(rowsP,'p_up'),k=path(rowsK,'mid'),m=path(rowsM,'mid');
  const pArea=rowsP.length?`${p} L ${x(rowsP.at(-1).t).toFixed(1)},${H-PB} L ${x(rowsP[0].t).toFixed(1)},${H-PB} Z`:'';
  const grid=[0,.25,.5,.75,1].map(v=>`<line x1="${PL}" y1="${y(v)}" x2="${W-PR}" y2="${y(v)}" class="cx-grid"/><text x="8" y="${y(v)+4}" class="cx-axis">${Math.round(v*100)}%</text>`).join('');
  const ticks=[0,.25,.5,.75,1].map(q=>{const t=open+(close-open)*q;return `<text x="${PL+(W-PL-PR)*q}" y="${H-13}" text-anchor="${q===0?'start':q===1?'end':'middle'}" class="cx-axis">${new Date(t).toISOString().slice(11,16)}</text>`;}).join('');
  const nowX=Math.max(PL,Math.min(W-PR,x(new Date().toISOString())));
  const latestP=rowsP.at(-1), latestK=rowsK.at(-1), latestM=rowsM.at(-1);
  const dots=[
    latestP?`<circle cx="${x(latestP.t)}" cy="${y(latestP.p_up)}" r="5" class="cx-dot pbe"/>`:'',
    latestK?`<circle cx="${x(latestK.t)}" cy="${y(latestK.mid)}" r="4" class="cx-dot kalshi"/>`:'',
    latestM?`<circle cx="${x(latestM.t)}" cy="${y(latestM.mid)}" r="4" class="cx-dot poly"/>`:''
  ].join('');
  svg.innerHTML=`<defs>
    <linearGradient id="pbeArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#69a9ff" stop-opacity=".24"/><stop offset="100%" stop-color="#69a9ff" stop-opacity="0"/></linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  ${grid}${ticks}
  <line x1="${nowX}" y1="${PT}" x2="${nowX}" y2="${H-PB}" class="cx-now-line"/><text x="${Math.min(nowX+6,W-70)}" y="${PT+12}" class="cx-now-label">NOW</text>
  ${pArea?`<path d="${pArea}" class="cx-area"/>`:''}
  ${p?`<path d="${p}" class="cx-path pbe" filter="url(#glow)"/>`:''}
  ${k?`<path d="${k}" class="cx-path kalshi"/>`:''}
  ${m?`<path d="${m}" class="cx-path poly"/>`:''}
  ${dots}
  <rect x="${PL}" y="${PT}" width="${W-PL-PR}" height="${H-PT-PB}" fill="transparent" class="cx-hit"/>`;

  const allTimes=[...rowsP.map(r=>Date.parse(r.t)),...rowsK.map(r=>Date.parse(r.t)),...rowsM.map(r=>Date.parse(r.t))].sort((a,b)=>a-b);
  const nearest=(rows,key,t)=>rows.reduce((best,r)=>Math.abs(Date.parse(r.t)-t)<Math.abs(Date.parse(best?.t??0)-t)?r:best,null);
  svg.onmousemove=(ev)=>{
    if(!allTimes.length)return;
    const rect=svg.getBoundingClientRect();
    const px=(ev.clientX-rect.left)/rect.width*W;
    const t=open+(px-PL)/(W-PL-PR)*(close-open);
    const rp=nearest(rowsP,'p_up',t), rk=nearest(rowsK,'mid',t), rm=nearest(rowsM,'mid',t);
    const tt=Math.max(open,Math.min(close,t));
    tip.hidden=false;
    tip.style.left=`${Math.max(8,Math.min(rect.width-180,ev.clientX-rect.left+12))}px`;
    tip.style.top=`${Math.max(8,ev.clientY-rect.top-72)}px`;
    tip.innerHTML=`<b>${new Date(tt).toISOString().slice(11,19)} UTC</b><span>PBE ${rp?pct(rp.p_up):'—'}</span><span>Kalshi ${rk?pct(rk.mid):'—'}</span><span>Polymarket ${rm?pct(rm.mid):'—'}</span>`;
  };
  svg.onmouseleave=()=>{tip.hidden=true;};
}

function renderRecord(r){
  if(!r){$('record').innerHTML='<div class="empty-honest">No scored record yet.</div>';return;}
  const f=v=>v==null?'—':Number(v).toFixed(4);
  $('record').innerHTML=`
    <div><span>Resolved scored</span><strong class="num">${Math.max(r.brier_n||0,r.log_loss_n||0)}</strong></div>
    <div><span>PBE Brier</span><strong class="num">${f(r.pbe_brier)}</strong><small>Kalshi ${f(r.kalshi_brier)}</small></div>
    <div><span>PBE log loss</span><strong class="num">${f(r.pbe_log_loss)}</strong><small>Kalshi ${f(r.kalshi_log_loss)}</small></div>`;
}

function renderRobinhood(rh){
  const btc=(rh?.symbols||[]).find(x=>x.symbol==='BTC-USD');
  if(!btc){$('rh-status').textContent='unavailable';$('rh-card').innerHTML='<div class="empty-honest">No BTC execution quote.</div>';return;}
  $('rh-status').textContent=btc.api_tradable?'API tradable':'not tradable';
  const fee=btc.fee_ratio==null?'—':`${(Number(btc.fee_ratio)*100).toFixed(2)}%`;
  $('rh-card').innerHTML=`<div class="cx-rh-price"><span>Fee-adjusted midpoint</span><strong class="num">${usd(btc.mid,2)}</strong></div>
  <div class="cx-rh-grid"><div><span>Net sell</span><b class="num">${usd(btc.bid,2)}</b></div><div><span>Gross buy</span><b class="num">${usd(btc.ask,2)}</b></div><div><span>Total friction</span><b class="num">${btc.spread_bps==null?'—':Number(btc.spread_bps).toFixed(2)+' bps'}</b></div></div>
  <div class="cx-rh-meta"><span>fee ${fee}</span><span>${btc.raw_quote_crossed?'raw book crossed':'raw book clean'}</span><span>${ago(btc.timestamp)}</span></div>`;
}

function spark(points){
  if(!points||points.length<2)return '<svg viewBox="0 0 90 26" class="cx-spark"><path d="M2 13 L88 13" class="flat"/></svg>';
  const vals=points.map(x=>x.v),min=Math.min(...vals),max=Math.max(...vals),span=Math.max(1e-12,max-min);
  const d=points.map((p,i)=>`${i?'L':'M'}${(2+i*(86/(points.length-1))).toFixed(1)} ${(23-(p.v-min)/span*20).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 90 26" class="cx-spark"><path d="${d}"/></svg>`;
}

function recordMarketHistory(rows){
  const now=Date.now();
  for(const x of rows){
    if(x.mark==null)continue;
    const arr=marketHistory.get(x.symbol)||[];
    arr.push({t:now,v:Number(x.mark)});
    while(arr.length>36)arr.shift();
    marketHistory.set(x.symbol,arr);
  }
}

function renderTape(){
  const tape=$('price-tape'); if(!tape)return;
  const rows=marketRows.slice(0,12);
  tape.innerHTML=rows.map(x=>{
    const prior=marketLast.get(x.symbol);
    const delta=prior==null||x.mark==null?null:Number(x.mark)-Number(prior);
    const cls=delta==null?'':delta>0?'up':delta<0?'down':'';
    return `<a class="cx-tape-item ${cls}" href="https://robinhood.com/us/en/crypto/${encodeURIComponent(x.symbol.replace('-USD',''))}/" target="_blank" rel="noopener"><b>${esc(x.symbol.replace('-USD',''))}</b><span class="num">${usd(x.mark,digits(x.mark))}</span><small>${x.raw_quote_crossed?'crossed raw book':'live'}</small></a>`;
  }).join('');
}

function renderMarketBoard(){
  const q=marketQuery.trim().toUpperCase();
  const rows=marketRows.filter(x=>!q||x.symbol.includes(q));
  $('board-count').textContent=`${rows.length} shown · ${marketRows.length} live`;
  $('market-board').innerHTML=rows.map(x=>{
    const asset=x.symbol.replace('-USD','');
    const hist=marketHistory.get(x.symbol)||[];
    const first=hist[0]?.v,last=hist.at(-1)?.v;
    const move=first&&last?((last-first)/first*100):null;
    const prior=marketLast.get(x.symbol);
    const tick=prior==null||x.mark==null?0:Number(x.mark)-Number(prior);
    const tickClass=tick>0?'tick-up':tick<0?'tick-down':'';
    return `<article class="cx-coin ${tickClass}">
      <div class="cx-coin-id"><span class="cx-coin-badge">${esc(asset.slice(0,4))}</span><div><b>${esc(asset)}</b><small>${esc(x.symbol)}</small></div></div>
      <div class="cx-coin-price"><strong class="num">${usd(x.mark,digits(x.mark))}</strong><small class="${move==null?'':move>=0?'up':'down'}">${move==null?'collecting…':`${move>=0?'+':''}${move.toFixed(3)}% session`}</small></div>
      <div class="cx-coin-spark">${spark(hist)}</div>
      <div class="cx-coin-book"><span>Bid <b class="num">${usd(x.raw_bid,digits(x.raw_bid))}</b></span><span>Ask <b class="num">${usd(x.raw_ask,digits(x.raw_ask))}</b></span></div>
      <div class="cx-coin-state">${x.raw_quote_crossed?'<span class="rail-flag">raw crossed</span>':'<span class="rail-good">book clean</span>'}<small>${ago(x.timestamp)}</small></div>
      <a class="cx-coin-trade" href="https://robinhood.com/us/en/crypto/${encodeURIComponent(asset)}/" target="_blank" rel="noopener noreferrer">Trade ↗</a>
    </article>`;
  }).join('')||'<div class="empty-honest">No live Robinhood pairs match that search.</div>';
}

function renderLivePrices(p){
  if(!p?.ok||!Array.isArray(p.symbols))return;
  for(const x of marketRows) if(x.mark!=null) marketLast.set(x.symbol,x.mark);
  marketRows=p.symbols;
  recordMarketHistory(marketRows);
  renderTape();
  renderMarketBoard();
  $('price-updated').textContent=`updated ${ago(p.generated_at)} · ${p.count} live pairs`;
}

function renderLadder(l){
  const el=$('ladders');
  if(!l?.ok){el.innerHTML='<div class="empty-honest">Execution ladder unavailable.</div>';return;}
  const names={'BTC-USD':'BTC','ETH-USD':'ETH','SOL-USD':'SOL'};
  el.innerHTML=Object.entries(l.ladders||{}).map(([s,rows])=>`<section class="card cx-ladder"><h3>${names[s]||s}</h3><table class="tbl"><thead><tr><th>Size</th><th>Net sell</th><th>Gross buy</th><th>Friction</th></tr></thead><tbody>${rows.map(r=>`<tr><td>$${r.usd}</td><td class="num">${usd(r.net_sell,s==='SOL-USD'?4:2)}</td><td class="num">${usd(r.gross_buy,s==='SOL-USD'?4:2)}</td><td class="num">${r.total_friction_bps==null?'—':Number(r.total_friction_bps).toFixed(2)+' bps'}</td></tr>`).join('')}</tbody></table></section>`).join('');
}
function renderUniverse(u){
  if(!u?.ok){$('universe-count').textContent='Universe unavailable';return;}
  $('universe-count').textContent=`${u.count} API-tradable pairs`;
  $('universe-summary').textContent=`(${u.count})`;
  $('universe').innerHTML=`<div class="cx-universe-chips">${u.symbols.map(x=>`<span>${esc(x.symbol)}</span>`).join('')}</div>`;
}

async function loadFast(){
  try{renderLivePrices(await get('crypto/live-prices'));}catch(e){console.error('live prices',e);}
}
async function loadCore(){
  const [n,rh]=await Promise.allSettled([get('crypto/nowcast'),get('crypto/markets')]);
  const nv=n.status==='fulfilled'?n.value:null,rv=rh.status==='fulfilled'?rh.value:null;
  renderNowcast(nv,rv);renderRobinhood(rv);
}
async function loadSlow(){
  const [l,u]=await Promise.allSettled([get('crypto/execution-ladder'),get('crypto/universe')]);
  renderLadder(l.status==='fulfilled'?l.value:null);renderUniverse(u.status==='fulfilled'?u.value:null);
}
$('coin-search')?.addEventListener('input',e=>{marketQuery=e.target.value;renderMarketBoard();});
loadFast();loadCore();loadSlow();
setInterval(()=>{if(!document.hidden)loadFast();},5000);
setInterval(()=>{if(!document.hidden)loadCore();},15000);
setInterval(()=>{if(!document.hidden)loadSlow();},60000);
setInterval(tickCountdown,1000);
