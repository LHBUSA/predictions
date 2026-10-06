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
  if(spot!=null&&target>0){
    const d=spot-target,p=d/target*100;
    $('distance').textContent=`${d>=0?'+':''}${usd(d,2)}`;
    $('distance-sub').textContent=`${p>=0?'+':''}${p.toFixed(3)}% from reference`;
  }
  $('pbe-up').textContent=f?pct(f.p_up):'—';
  $('model-meta').textContent=f?`${f.model_id}@${f.model_version} · ${ago(f.data_cutoff_at)}`:'awaiting forecast';
  const k=n.markets?.kalshi;
  const pm=n.markets?.polymarket;
  $('kalshi-up').textContent=k?.mid==null?'—':pct(k.mid);
  $('kalshi-meta').textContent=k?`${k.market_status||'market'} · ${ago(k.captured_at)}`:'same contract benchmark';
  $('mkt-kalshi').textContent=k?.mid==null?'—':pct(k.mid);
  $('mkt-poly').textContent=pm?.mid==null?'—':pct(pm.mid);
  if(f&&k?.mid!=null){
    const gap=(Number(f.p_up)-Number(k.mid))*100;
    $('divergence').textContent=`${gap>=0?'+':''}${gap.toFixed(1)} pts`;
  } else $('divergence').textContent='—';
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
  const svg=$('prob-chart'); const W=900,H=330,P=44;
  const open=Date.parse(n.window.open_at),close=Date.parse(n.window.close_at);
  const x=t=>P+(Date.parse(t)-open)/(close-open)*(W-2*P);
  const y=v=>P+(1-Number(v))*(H-2*P);
  const path=(rows,key)=>rows.filter(r=>r[key]!=null).map((r,i)=>`${i?'L':'M'}${x(r.t).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const grid=[.25,.5,.75].map(v=>`<line x1="${P}" y1="${y(v)}" x2="${W-P}" y2="${y(v)}" class="cx-grid"/><text x="8" y="${y(v)+4}" class="cx-axis">${Math.round(v*100)}%</text>`).join('');
  const p=path(n.forecast_path||[],'p_up');
  const k=path(n.venue_path?.kalshi||[],'mid');
  const m=path(n.venue_path?.polymarket||[],'mid');
  svg.innerHTML=`${grid}<line x1="${P}" y1="${H-P}" x2="${W-P}" y2="${H-P}" class="cx-axis-line"/>${p?`<path d="${p}" class="cx-path pbe"/>`:''}${k?`<path d="${k}" class="cx-path kalshi"/>`:''}${m?`<path d="${m}" class="cx-path poly"/>`:''}`;
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
