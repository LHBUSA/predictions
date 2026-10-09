const API='/api';
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=(v)=>v==null||!Number.isFinite(Number(v))?'—':`${(Number(v)*100).toFixed(1)}%`;
const usd=(v,d=2)=>v==null?'—':Number(v).toLocaleString(undefined,{style:'currency',currency:'USD',minimumFractionDigits:d,maximumFractionDigits:d});
const ago=(iso)=>{if(!iso)return'—';const sec=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));return sec<10?'just now':sec<60?`${sec}s ago`:sec<3600?`${Math.round(sec/60)}m ago`:`${Math.round(sec/3600)}h ago`;};
const hms=(t)=>new Date(t).toISOString().slice(11,19);
const hm=(t)=>new Date(t).toISOString().slice(11,16);
const digits=(v)=>{const n=Math.abs(Number(v));return n>=1000?2:n>=1?4:n>=.01?5:8};
// Simple Icons no longer publishes avalanche, aave, uniswap, shiba-inu, arbitrum, ethereumclassic (404 on 2026-10-09):
// those coins use the text badge directly instead of a failing request.
const COIN_BRAND={
  BTC:['bitcoin','F7931A'],ETH:['ethereum','627EEA'],SOL:['solana','14F195'],DOGE:['dogecoin','C2A633'],
  XRP:['xrp','25A768'],ADA:['cardano','0D1E30'],LINK:['chainlink','375BD2'],
  LTC:['litecoin','345D9D'],BCH:['bitcoincash','8DC351'],
  DOT:['polkadot','E6007A'],XLM:['stellar','7D00FF'],
  OP:['optimism','FF0420']
};
function coinLogo(asset){
  const x=COIN_BRAND[String(asset||'').toUpperCase()];
  return x ? 'https://cdn.simpleicons.org/'+x[0]+'/'+x[1] : '';
}
function coinMark(asset,size='md'){
  const a=String(asset||'').toUpperCase(),src=coinLogo(a);
  const img=src ? '<img src="'+src+'" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'">' : '';
  return '<span class="cx-coin-logo '+size+'">'+img+'<span class="cx-coin-fallback"'+(src?' style="display:none"':'')+'>'+esc(a.slice(0,3))+'</span></span>';
}
async function get(p,signal){const r=await fetch(`${API}/${p}`,{cache:'no-store',signal});if(!r.ok){const e=new Error(`${p} ${r.status}`);e.status=r.status;throw e;}return r.json();}

let marketRows=[];
let marketQuery='';
let marketLast=new Map();
const marketHistory=new Map();

// ===================== Nowcast V3 (issue #51): the 15-minute probability race =====================
// Evidence rules. Every drawn value is a stored observation: a value holds (step) until the next stored one and the line
// BREAKS where nothing was stored for MAX_GAP (or the stored value is null) — never a straight line across missing data.
// Inspection reads the last observation AT OR BEFORE the cursor and only within MAX_GAP, with its own observed time.
// The PBE-vs-Kalshi gap is shown only for a numeric, fresh, SAME_CONTRACT Kalshi quote against a fresh forecast;
// Polymarket settles on a different price index and is never compared or blended.
const MAX_GAP=150e3;            // owner rule: 'live' = observation <= 2.5 min old; also the line-break threshold
const MODEL_FRESH=180e3;        // the model publishes about once a minute
const SERIES=[['pbe','PBE','p_up'],['kalshi','Kalshi','mid'],['poly','Polymarket','mid']];
const num=(v)=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;

// rows sorted by time, value present or null (null breaks the line)
function seriesOf(n){
  const norm=(rows,key)=>(rows||[]).map(r=>({t:Date.parse(r.t),v:num(r[key])})).filter(r=>Number.isFinite(r.t)).sort((a,b)=>a.t-b.t);
  return {pbe:norm(n.forecast_path,'p_up'),kalshi:norm(n.venue_path?.kalshi,'mid'),poly:norm(n.venue_path?.polymarket,'mid')};
}
// last observation at or before t, within maxAge; null when none (never the nearest future point)
function asOf(rows,t,maxAge=MAX_GAP){
  let best=null;for(const r of rows){if(r.t<=t)best=r;else break;}
  if(!best||best.v==null||t-best.t>maxAge)return null;
  return best;
}
// step path in chart coordinates; `end` = the latest time a held value may reach (now, capped at the window close)
function stepPath(rows,x,y,end,maxGap=MAX_GAP){
  let d='',open=false;
  for(let i=0;i<rows.length;i++){
    const r=rows[i];
    if(r.v==null){open=false;continue;}
    const next=rows[i+1];
    d+=open?` V${y(r.v).toFixed(1)}`:` M${x(r.t).toFixed(1)},${y(r.v).toFixed(1)}`;
    const holdTo=Math.min(next?next.t:end,r.t+maxGap,end);
    if(holdTo>r.t)d+=` H${x(holdTo).toFixed(1)}`;
    open=!!next&&next.v!=null&&next.t-r.t<=maxGap;
  }
  return d.trim();
}
// gap state: {ok, pts} or {ok:false, label, reason}
function gapState(f,k,now){
  if(!f||num(f.p_up)==null)return{ok:false,label:'No forecast',reason:'waiting for the first forecast'};
  if(now-Date.parse(f.data_cutoff_at||f.captured_at)>MODEL_FRESH)return{ok:false,label:'Model stale',reason:`last forecast ${hms(f.captured_at)} UTC`};
  if(!k||num(k.mid)==null)return{ok:false,label:'No quote',reason:'no Kalshi quote stored for this window'};
  if(k.comparability&&k.comparability!=='SAME_CONTRACT')return{ok:false,label:'Not comparable',reason:String(k.comparability).toLowerCase().replace(/_/g,' ')};
  if(now-Date.parse(k.captured_at)>MAX_GAP)return{ok:false,label:'Stale quote',reason:`last Kalshi quote ${hms(k.captured_at)} UTC`};
  return{ok:true,pts:(num(f.p_up)-num(k.mid))*100};
}
// observed feature changes between two stored forecasts (no causal claims)
function driverRows(prev,cur){
  const a=prev?.features||{},b=cur?.features||{};
  const dist=(f)=>num(f.btc_spot_usd)!=null&&num(f.btc_open_ref_usd)!=null?num(f.btc_spot_usd)-num(f.btc_open_ref_usd):null;
  const rows=[
    ['P(up)',num(prev?.p_up),num(cur?.p_up),(v)=>pct(v),(d)=>`${d>=0?'+':'−'}${Math.abs(d*100).toFixed(1)} pts`],
    ['BTC vs open reference',dist(a),dist(b),(v)=>`${v>=0?'+':'−'}${usd(Math.abs(v),2)}`,(d)=>`${d>=0?'+':'−'}${usd(Math.abs(d),2)}`],
    ['Distance (z)',num(a.z_distance),num(b.z_distance),(v)=>v.toFixed(3),(d)=>`${d>=0?'+':'−'}${Math.abs(d).toFixed(3)}`],
    ['Realized vol (60 m, ann.)',num(a.rv60_annualized),num(b.rv60_annualized),(v)=>`${(v*100).toFixed(1)}%`,(d)=>`${d>=0?'+':'−'}${Math.abs(d*100).toFixed(2)} pts`],
    ['Time left in model',num(a.horizon_min),num(b.horizon_min),(v)=>`${v.toFixed(1)} min`,(d)=>`${d>=0?'+':'−'}${Math.abs(d).toFixed(1)} min`],
  ];
  return rows.filter(r=>r[2]!=null).map(([label,from,to,fmt,fmtD])=>({label,from:from==null?null:fmt(from),to:fmt(to),delta:from==null?null:fmtD(to-from),raw:from==null?null:to-from}));
}

const S={seq:0,applied:0,ctrl:null,n:null,rh:null,windowId:null,lastOk:null,err:null,cursor:null,pinned:false,raf:0,rolloverTimer:0,lastNowX:-1};
const WIDE={W:1200,H:440,PL:58,PR:26,PT:26,PB:46,ticks:[0,3,6,9,12,15]},NARROW={W:420,H:330,PL:40,PR:12,PT:28,PB:34,ticks:[0,5,10,15]};
// phones get their own geometry (readable 12-13 px labels) instead of a scaled-down desktop chart
const pickDims=()=>(($('cx-chart-box')?.clientWidth||1200)<640?NARROW:WIDE);
let C=WIDE;

function chartGeom(n){
  const open=Date.parse(n.window.open_at),close=Date.parse(n.window.close_at);
  const x=(t)=>C.PL+(Math.max(open,Math.min(close,t))-open)/(close-open)*(C.W-C.PL-C.PR);
  const y=(v)=>C.PT+(1-v)*(C.H-C.PT-C.PB);
  const tAt=(px)=>open+(px-C.PL)/(C.W-C.PL-C.PR)*(close-open);
  return{open,close,x,y,tAt};
}
function chartSkeleton(n){
  const svg=$('prob-chart'); C=pickDims(); svg.setAttribute('viewBox',`0 0 ${C.W} ${C.H}`); svg.dataset.dims=C===NARROW?'narrow':'wide'; const g=chartGeom(n);
  const grid=[0,.25,.5,.75,1].map(v=>`<line x1="${C.PL}" y1="${g.y(v)}" x2="${C.W-C.PR}" y2="${g.y(v)}" class="cx3-grid${v===.5?' mid':''}"/><text x="${C.PL-10}" y="${g.y(v)+4}" text-anchor="end" class="cx3-axis">${Math.round(v*100)}%</text>`).join('');
  const ticks=C.ticks.map(m=>{const t=g.open+m*60e3;return `<line x1="${g.x(t)}" x2="${g.x(t)}" y1="${C.H-C.PB}" y2="${C.H-C.PB+5}" class="cx3-tick"/><text x="${g.x(t)}" y="${C.H-C.PB+21}" text-anchor="${m===0?'start':m===15?'end':'middle'}" class="cx3-axis">${hm(t)}</text>`;}).join('');
  const even=C===WIDE?`<text x="${C.W-C.PR}" y="${g.y(.5)-6}" text-anchor="end" class="cx3-axis cx3-even">50% · even</text>`:'';
  svg.innerHTML=`<defs><filter id="cx3glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
    <pattern id="cx3hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" class="cx3-hatch"/></pattern></defs>
    <g class="cx3-static">${grid}${ticks}${even}</g>
    <rect id="cx-future" class="cx3-future" x="${C.PL}" y="${C.PT}" width="0" height="${C.H-C.PT-C.PB}"/>
    <text id="cx-future-label" class="cx3-future-label" y="${C.PT+18}">not yet observed</text>
    <g id="cx-gapband"></g>
    <g class="cx3-series"><path id="cx-p-poly" class="cx3-path poly"/><path id="cx-p-kalshi" class="cx3-path kalshi"/><path id="cx-p-pbe-glow" class="cx3-path pbe glow" filter="url(#cx3glow)"/><path id="cx-p-pbe" class="cx3-path pbe"/></g>
    <g id="cx-obs" class="cx3-obs"></g>
    <g id="cx-now" class="cx3-now"><line y1="${C.PT-6}" y2="${C.H-C.PB}" class="cx3-now-line"/><rect class="cx3-now-tag" x="-34" y="${C.PT-22}" width="68" height="18" rx="9"/><text id="cx-now-text" class="cx3-now-text" y="${C.PT-9}" text-anchor="middle">NOW</text></g>
    <g class="cx3-last"><circle id="cx-l-poly" class="cx3-dot poly" r="5" cx="-20" cy="-20"/><circle id="cx-l-kalshi" class="cx3-dot kalshi" r="5.5" cx="-20" cy="-20"/><circle id="cx-l-pbe" class="cx3-dot pbe" r="7" cx="-20" cy="-20"/></g>
    <g id="cx-cross" class="cx3-cross" visibility="hidden"><line id="cx-cross-line" y1="${C.PT}" y2="${C.H-C.PB}"/><circle id="cx-c-pbe" r="5" class="pbe"/><circle id="cx-c-kalshi" r="4.5" class="kalshi"/><circle id="cx-c-poly" r="4.5" class="poly"/></g>
    <rect class="cx3-hit" x="${C.PL}" y="${C.PT}" width="${C.W-C.PL-C.PR}" height="${C.H-C.PT-C.PB}" fill="transparent"/>`;
}

function renderChart(n){
  const g=chartGeom(n); const s=seriesOf(n); const now=Date.now(); const end=Math.min(now,g.close);
  if(S.windowId!==n.window.window_id){ // rollover: a new canvas, nothing carried from the previous window
    chartSkeleton(n); S.windowId=n.window.window_id; S.cursor=null; S.pinned=false; S.lastNowX=-1;
  }
  const set=(id,attr,val)=>{const e=$(id);if(e)e.setAttribute(attr,val);};
  set('cx-p-pbe','d',stepPath(s.pbe,g.x,g.y,end)); set('cx-p-pbe-glow','d',stepPath(s.pbe,g.x,g.y,end));
  set('cx-p-kalshi','d',stepPath(s.kalshi,g.x,g.y,end)); set('cx-p-poly','d',stepPath(s.poly,g.x,g.y,end));
  $('cx-obs').innerHTML=SERIES.map(([k])=>s[k].filter(r=>r.v!=null).map(r=>`<circle cx="${g.x(r.t).toFixed(1)}" cy="${g.y(r.v).toFixed(1)}" r="2.2" class="cx3-ob ${k}"/>`).join('')).join('');
  for(const [k] of SERIES){ // last-sample indicator; only while that sample is still within MAX_GAP of now
    const last=[...s[k]].reverse().find(r=>r.v!=null); const dot=$(`cx-l-${k}`); if(!dot)continue;
    const live=last&&now-last.t<=MAX_GAP;
    if(!last){dot.setAttribute('visibility','hidden');continue;}
    dot.setAttribute('visibility','visible'); dot.classList.toggle('is-stale',!live);
    const cx=g.x(last.t).toFixed(1),cy=g.y(last.v).toFixed(1);
    if(dot.getAttribute('cy')!==cy&&dot.getAttribute('cx')!=='-20'){dot.classList.remove('pulse');void dot.getBBox?.();dot.classList.add('pulse');}
    dot.setAttribute('cx',cx); dot.setAttribute('cy',cy);
  }
  const gs=gapState(n.latest_forecast,n.markets?.kalshi,now); const lp=asOf(s.pbe,end,MODEL_FRESH),lk=asOf(s.kalshi,end);
  $('cx-gapband').innerHTML=gs.ok&&lp&&lk?`<rect x="${(g.x(end)+10).toFixed(1)}" width="6" rx="3" y="${Math.min(g.y(lp.v),g.y(lk.v)).toFixed(1)}" height="${Math.max(2,Math.abs(g.y(lp.v)-g.y(lk.v))).toFixed(1)}" class="cx3-band"/><text x="${(g.x(end)+22).toFixed(1)}" y="${((g.y(lp.v)+g.y(lk.v))/2+4).toFixed(1)}" class="cx3-band-label">${gs.pts>=0?'+':'−'}${Math.abs(gs.pts).toFixed(1)}</text>`:'';
  const total=s.pbe.length+s.kalshi.length+s.poly.length;
  const msg=$('cx-chart-msg'); msg.hidden=total>0; if(!total)msg.textContent=n.active?'Waiting for the first stored observation of this window.':'No observations were stored for this window.';
  moveNow(true); renderReadout(); renderTable(n,s);
}

// NOW ruler + future canvas: moved in place (no re-render); rAF only while visible, 1 s steps for reduced motion
function moveNow(force){
  const n=S.n; if(!n?.window||!$('cx-now'))return;
  const g=chartGeom(n); const now=Date.now(); const nx=g.x(Math.min(now,g.close));
  if(!force&&Math.abs(nx-S.lastNowX)<.4)return; S.lastNowX=nx;
  $('cx-now').setAttribute('transform',`translate(${nx.toFixed(1)},0)`);
  $('cx-now-text').textContent=now>=g.close?'CLOSED':`NOW ${hms(now)}`;
  const f=$('cx-future'); f.setAttribute('x',nx.toFixed(1)); f.setAttribute('width',Math.max(0,C.W-C.PR-nx).toFixed(1));
  const fl=$('cx-future-label'); fl.setAttribute('x',(nx+12).toFixed(1)); fl.setAttribute('visibility',C===WIDE&&C.W-C.PR-nx>150?'visible':'hidden');
  const p=$('cx-progress'); if(p)p.style.width=`${Math.min(100,Math.max(0,(now-g.open)/(g.close-g.open)*100)).toFixed(2)}%`;
}
const reduced=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function frame(){S.raf=0;if(document.hidden)return;moveNow(false);if(!reduced())S.raf=requestAnimationFrame(frame);}
function startFrames(){if(!S.raf&&!document.hidden&&!reduced()&&window.requestAnimationFrame)S.raf=requestAnimationFrame(frame);}

// ---- inspection: hover (mouse), sticky tap (touch/pen), keyboard (← → Home End Esc)
function obsTimes(){const s=S.n?seriesOf(S.n):null;return s?[...new Set([...s.pbe,...s.kalshi,...s.poly].filter(r=>r.v!=null).map(r=>r.t))].sort((a,b)=>a-b):[];}
function renderReadout(){
  const n=S.n; const el=$('cx-readout'); if(!n?.window||!el)return;
  const s=seriesOf(n); const g=chartGeom(n); const now=Date.now();
  const t=S.cursor??Math.min(now,g.close); const live=S.cursor==null;
  const cross=$('cx-cross');
  if(cross){cross.setAttribute('visibility',live?'hidden':'visible'); if(!live){const cl=$('cx-cross-line');cl.setAttribute('x1',g.x(t));cl.setAttribute('x2',g.x(t));}}
  const cell=([k,label])=>{const o=asOf(s[k],t,k==='pbe'?MODEL_FRESH:MAX_GAP);const c=$(`cx-c-${k}`);
    if(c){if(o&&!live){c.setAttribute('cx',g.x(t));c.setAttribute('cy',g.y(o.v));c.setAttribute('visibility','visible');}else c.setAttribute('visibility','hidden');}
    return `<div class="cx3-ro ${k}"><span>${label}${k==='poly'?' <em>different index</em>':''}</span>${o?`<b class="num">${pct(o.v)}</b><small>observed ${hms(o.t)} UTC · ${Math.round((t-o.t)/1000)} s ${live?'ago':'before'}</small>`:`<b class="cx3-none">No observation</b><small>none stored within ${k==='pbe'?3:2.5} min</small>`}</div>`;};
  el.innerHTML=`<div class="cx3-ro-time"><span>${live?'Live':S.pinned?'Pinned':'Inspecting'}</span><b class="num">${hms(t)} UTC</b>${live?'':'<button type="button" id="cx-ro-clear">Back to live</button>'}</div>${SERIES.map(cell).join('')}`;
  $('cx-ro-clear')?.addEventListener('click',()=>{S.cursor=null;S.pinned=false;renderReadout();});
}
function bindChart(){
  const svg=$('prob-chart'); if(!svg||svg.dataset.bound)return; svg.dataset.bound='1';
  const toT=(ev)=>{const r=svg.getBoundingClientRect();const g=chartGeom(S.n);const px=(ev.clientX-r.left)/r.width*C.W;return Math.max(g.open,Math.min(Math.min(Date.now(),g.close),g.tAt(px)));};
  svg.addEventListener('pointermove',(ev)=>{if(!S.n?.window||ev.pointerType!=='mouse'||S.pinned)return;S.cursor=toT(ev);renderReadout();});
  svg.addEventListener('pointerleave',(ev)=>{if(ev.pointerType==='mouse'&&!S.pinned){S.cursor=null;renderReadout();}});
  svg.addEventListener('pointerdown',(ev)=>{if(!S.n?.window)return;if(ev.pointerType==='mouse'){S.pinned=!S.pinned;S.cursor=S.pinned?toT(ev):null;}else{S.pinned=true;S.cursor=toT(ev);}renderReadout();});
  svg.addEventListener('keydown',(ev)=>{
    if(!S.n?.window)return; const ts=obsTimes(); if(!ts.length&&ev.key!=='Escape')return;
    const cur=S.cursor??Infinity; let t=null;
    if(ev.key==='ArrowLeft')t=[...ts].reverse().find(x=>x<cur)??ts[0];
    else if(ev.key==='ArrowRight')t=S.cursor==null?null:(ts.find(x=>x>cur)??null);
    else if(ev.key==='Home')t=ts[0]; else if(ev.key==='End')t=ts.at(-1);
    else if(ev.key==='Escape'){S.cursor=null;S.pinned=false;renderReadout();return;} else return;
    ev.preventDefault(); S.cursor=t; S.pinned=t!=null; renderReadout();
  });
}
function renderTable(n,s){
  const el=$('cx-table'); if(!el)return;
  const rows=[...SERIES.flatMap(([k,label])=>s[k].map(r=>({t:r.t,k,label,v:r.v})))].sort((a,b)=>b.t-a.t);
  el.innerHTML=rows.length?`<table class="tbl cx3-tbl"><caption class="sr-only">Stored observations, newest first</caption><thead><tr><th scope="col">Observed (UTC)</th><th scope="col">Series</th><th scope="col">P(up)</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="num">${hms(r.t)}</td><td>${esc(r.label)}${r.k==='poly'?' (different index)':''}</td><td class="num">${r.v==null?'no value stored':pct(r.v)}</td></tr>`).join('')}</tbody></table>`:'<p class="cx3-note">No observations stored for this window yet.</p>';
}

// ---- HUD, drivers, status
function setStatus(state,text){const s=$('cx-status');if(s){s.dataset.state=state;$('cx-status-text').textContent=text;}const live=$('crypto-live');if(live){live.dataset.state=state;const sp=live.querySelector('span');if(sp)sp.textContent=text;}}
function tickCountdown(){
  const n=S.n; const el=$('countdown'); if(!el)return;
  if(!n?.window){el.textContent='--:--';return;}
  const left=Date.parse(n.window.close_at)-Date.now();
  if(left<=0){el.textContent='00:00';
    if(n.active){setStatus('closed','Window closed · waiting for the next window');if(!S.rolloverTimer)S.rolloverTimer=setTimeout(()=>{S.rolloverTimer=0;loadCore();},3000);}
    return;}
  const s=Math.floor(left/1000); el.textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}
function renderHud(n,rh){
  const now=Date.now(); const f=n.latest_forecast; const k=n.markets?.kalshi; const pm=n.markets?.polymarket;
  const fAge=f?now-Date.parse(f.data_cutoff_at||f.captured_at):Infinity;
  $('hero-pbe-up').textContent=f?pct(f.p_up):'—';
  $('hero-pbe-up').classList.toggle('is-stale',fAge>MODEL_FRESH);
  $('model-meta').textContent=f?`${f.model_id}@${f.model_version} · ${String(f.model_state||'').toLowerCase()} · data ${hms(f.data_cutoff_at)} UTC`:'waiting for first forecast';
  const kFresh=k&&num(k.mid)!=null&&now-Date.parse(k.captured_at)<=MAX_GAP;
  $('hero-kalshi').textContent=k&&num(k.mid)!=null?pct(k.mid):'—';
  $('hero-kalshi').classList.toggle('is-stale',!!k&&!kFresh);
  $('kalshi-meta').textContent=k?`same contract · ${kFresh?'observed':'stale since'} ${hms(k.captured_at)} UTC · bid ${pct(k.bid)} ask ${pct(k.ask)}`:'market observation unavailable';
  const gs=gapState(f,k,now);
  const gapEl=$('hero-gap');
  gapEl.textContent=gs.ok?`${gs.pts>=0?'+':'−'}${Math.abs(gs.pts).toFixed(1)} pts`:gs.label;
  gapEl.className=`num ${gs.ok?(gs.pts>0?'dpos':gs.pts<0?'dneg':''):'cx3-watch'}`;
  $('gap-meta').textContent=gs.ok?(gs.pts>=0?'PBE above Kalshi · same contract, fresh':'PBE below Kalshi · same contract, fresh'):`Watch · ${gs.reason}`;
  const pmFresh=pm&&num(pm.mid)!=null&&now-Date.parse(pm.captured_at)<=MAX_GAP;
  $('hero-poly').textContent=pm&&num(pm.mid)!=null?pct(pm.mid):'—';
  $('hero-poly').classList.toggle('is-stale',!!pm&&!pmFresh);
  $('poly-meta').textContent=pm?`different settlement index · ${pmFresh?'observed':'stale since'} ${hms(pm.captured_at)} UTC`:'market observation unavailable';
  // BTC vs reference: Robinhood read-only quote (labelled with its own time) or the model's stored proxy
  const btc=(rh?.symbols||[]).find(x=>x.symbol==='BTC-USD'); const target=num(n.window.proxy_open_usd);
  const fm=f?.features||{}; const spot=num(btc?.mid)??num(fm.btc_spot_usd);
  const spotSrc=btc?.mid!=null?`Robinhood mid · ${ago(btc.timestamp)}`:fm.btc_spot_usd!=null?`model proxy at ${hms(f.data_cutoff_at)} UTC`:'unavailable';
  $('hero-spot').textContent=usd(spot,2); $('hero-reference').textContent=usd(target,2); $('hero-price-age').textContent=spotSrc;
  if(spot!=null&&target>0){const d=spot-target;$('chart-distance').textContent=`${d>=0?'+':'−'}${usd(Math.abs(d),2)}`;$('chart-distance-sub').textContent=`${(d/target*100).toFixed(3)}% · ${spotSrc}`;}
  else{$('chart-distance').textContent='—';$('chart-distance-sub').textContent='price unavailable';}
  $('window-times').textContent=`${hm(n.window.open_at)}–${hm(n.window.close_at)} UTC · ${esc(n.window.kalshi_market_ticker||'')}`;
  // lower panels (unchanged contract)
  $('mkt-kalshi')&&($('mkt-kalshi').textContent=k&&num(k.mid)!=null?pct(k.mid):'—');
  $('mkt-poly')&&($('mkt-poly').textContent=pm&&num(pm.mid)!=null?pct(pm.mid):'—');
}
function renderDrivers(n){
  const el=$('cx-drivers'); if(!el)return;
  const cur=n.latest_forecast, prev=n.previous_forecast||null;
  if(!cur){el.innerHTML='<p class="cx3-note">Waiting for the first forecast of this window.</p>';return;}
  const rows=driverRows(prev,cur);
  const head=prev?`<p class="cx3-span num">${hms(prev.captured_at)} → ${hms(cur.captured_at)} UTC</p>`:`<p class="cx3-span">First stored forecast of this window (${hms(cur.captured_at)} UTC). No earlier forecast to compare.</p>`;
  const same=prev&&Math.abs(num(cur.p_up)-num(prev.p_up))<.0005?`<p class="cx3-note cx3-unchanged">Model probability unchanged since ${hms(prev.captured_at)} UTC.</p>`:'';
  el.innerHTML=head+same+`<ul class="cx3-drv">${rows.map(r=>`<li><span>${esc(r.label)}</span><b class="num">${esc(r.to)}</b>${r.delta!=null?`<small class="num ${r.raw>0?'up':r.raw<0?'down':''}">${esc(r.delta)} <em>from ${esc(r.from)}</em></small>`:''}</li>`).join('')}</ul>`;
}
function renderEvidence(n,rh){
  const f=n.latest_forecast; const fm=f?.features||{}; const target=num(n.window.proxy_open_usd);
  const age=f?Date.now()-Date.parse(f.data_cutoff_at):Infinity;
  const fr=$('freshness'); if(fr){fr.textContent=!f?'no forecast':age<=MODEL_FRESH?'current':age<300000?'delayed':'stale';fr.className=`fresh ${!f||age>300000?'fresh-stale':age<=MODEL_FRESH?'fresh-current':'fresh-delayed'}`;}
  const ev=[['Current proxy',fm.btc_spot_usd!=null?usd(fm.btc_spot_usd,2):'—'],['Open reference',fm.btc_open_ref_usd!=null?usd(fm.btc_open_ref_usd,2):usd(target,2)],['Distance (z)',fm.z_distance!=null?Number(fm.z_distance).toFixed(3):'—'],['Realized vol (60m)',fm.rv60_annualized!=null?`${(Number(fm.rv60_annualized)*100).toFixed(1)}% ann.`:'—'],['Horizon',fm.horizon_min!=null?`${Number(fm.horizon_min).toFixed(1)} min`:'—'],['Exchange gap',fm.exchange_gap_usd!=null?usd(fm.exchange_gap_usd,2):'—']];
  const el=$('evidence'); if(el)el.innerHTML=ev.map(([a,b])=>`<div><span>${esc(a)}</span><strong class="num">${esc(b)}</strong></div>`).join('');
}
function renderRecord(r){
  const el=$('record'); if(!el)return;
  if(!r){el.innerHTML='<div class="empty-honest">No scored record yet.</div>';return;}
  const f=v=>v==null?'—':Number(v).toFixed(4);
  el.innerHTML=`
    <div><span>Resolved scored</span><strong class="num">${Math.max(r.brier_n||0,r.log_loss_n||0)}</strong></div>
    <div><span>PBE Brier</span><strong class="num">${f(r.pbe_brier)}</strong><small>Kalshi ${f(r.kalshi_brier)}</small></div>
    <div><span>PBE log loss</span><strong class="num">${f(r.pbe_log_loss)}</strong><small>Kalshi ${f(r.kalshi_log_loss)}</small></div>`;
}
function renderNowcast(n,rh){
  S.n=n; S.rh=rh;
  if(n.state==='NO_WINDOW'||!n.window){setStatus('idle','No window open · waiting for the next window');return;}
  const f=n.latest_forecast; const fAge=f?Date.now()-Date.parse(f.data_cutoff_at||f.captured_at):Infinity;
  if(!n.active)setStatus('closed',n.resolution?`Last window resolved ${String(n.resolution.venue_result||n.resolution.proxy_result||'').toUpperCase()}`:'Window closed · waiting for the next window');
  else if(!f)setStatus('waiting','Live window · waiting for first forecast');
  else if(fAge>MODEL_FRESH)setStatus('stale',`Model stale since ${hms(f.data_cutoff_at)} UTC`);
  else setStatus('live','Live nowcast');
  tickCountdown(); renderHud(n,rh); renderChart(n); renderDrivers(n); renderEvidence(n,rh); renderRecord(n.record);
}
// a failed read never leaves old numbers wearing a LIVE badge
function renderUnavailable(err){
  S.err={at:Date.now(),status:err?.status??null};
  const since=S.lastOk?` · showing data as of ${hms(S.lastOk)} UTC`:'';
  setStatus('error',`Nowcast temporarily unavailable${since}`);
  document.querySelector('.cx3-race')?.classList.add('is-unavailable');
  if(!S.n){const m=$('cx-chart-msg');if(m){m.hidden=false;m.textContent='The nowcast is temporarily unavailable. Retrying automatically.';}}
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
  const rows=marketRows;
  if(!rows.length){tape.innerHTML='';return;}
  const items=rows.map(x=>{
    const prior=marketLast.get(x.symbol);
    const delta=prior==null||x.mark==null?null:Number(x.mark)-Number(prior);
    const cls=delta==null?'':delta>0?'up':delta<0?'down':'';
    const move=delta==null?'LIVE':delta>0?'▲':delta<0?'▼':'•';
    const asset=x.symbol.replace('-USD','');
    return `<a class="cx-tape-item ${cls}" href="https://robinhood.com/us/en/crypto/${encodeURIComponent(asset)}/" target="_blank" rel="noopener">${coinMark(asset,'sm')}<span class="cx-tape-copy"><b>${esc(asset)}</b><span class="num">${usd(x.mark,digits(x.mark))}</span><small>${move} · ${x.raw_quote_crossed?'RAW BOOK CROSSED':'ROBINHOOD'}</small></span></a>`;
  }).join('');
  const duration=Math.max(44,rows.length*3.2);
  const phase=(Date.now()/1000)%duration;
  tape.style.setProperty('--ticker-duration',`${duration}s`);
  tape.style.setProperty('--ticker-offset',`-${phase.toFixed(2)}s`);
  tape.innerHTML=`<div class="cx-tape-track" aria-label="${rows.length} live Robinhood crypto prices"><div class="cx-tape-set">${items}</div><div class="cx-tape-set" aria-hidden="true">${items}</div></div>`;
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
      <div class="cx-coin-id">${coinMark(asset,'lg')}<div><b>${esc(asset)}</b><small>${esc(x.symbol)}</small></div></div>
      <div class="cx-coin-price"><strong class="num">${usd(x.mark,digits(x.mark))}</strong><small class="${move==null?'':move>=0?'up':'down'}">${move==null?'collecting…':`${move>=0?'+':''}${move.toFixed(3)}% since page opened`}</small></div>
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

const inflight={fast:false,slow:false};
async function loadFast(){
  if(inflight.fast)return;inflight.fast=true;
  try{renderLivePrices(await get('crypto/live-prices'));}catch(e){console.error('live prices',e);}finally{inflight.fast=false;}
}
// core read: one request at a time per sequence; an older response (or an older window) never overwrites a newer one
async function loadCore(){
  S.ctrl?.abort(); const ctrl=window.AbortController?new AbortController():null; S.ctrl=ctrl;
  const my=++S.seq;
  const [n,rh]=await Promise.allSettled([get('crypto/nowcast',ctrl?.signal),get('crypto/markets',ctrl?.signal)]);
  if(my<S.applied||ctrl?.signal.aborted)return;
  const rv=rh.status==='fulfilled'?rh.value:null;
  if(n.status!=='fulfilled'){if(n.reason?.name==='AbortError')return;renderUnavailable(n.reason);renderRobinhood(rv);return;}
  const nv=n.value;
  if(!nv?.ok){renderUnavailable({status:null});renderRobinhood(rv);return;}
  if(S.n?.window&&nv.window&&Date.parse(nv.window.open_at)<Date.parse(S.n.window.open_at))return; // stale window response
  S.applied=my; S.lastOk=Date.now(); S.err=null; document.querySelector('.cx3-race')?.classList.remove('is-unavailable');
  renderNowcast(nv,rv); renderRobinhood(rv);
}
async function loadSlow(){
  if(inflight.slow)return;inflight.slow=true;
  try{const [l,u]=await Promise.allSettled([get('crypto/execution-ladder'),get('crypto/universe')]);
  renderLadder(l.status==='fulfilled'?l.value:null);renderUniverse(u.status==='fulfilled'?u.value:null);}finally{inflight.slow=false;}
}
$('coin-search')?.addEventListener('input',e=>{marketQuery=e.target.value;renderMarketBoard();});
bindChart();
window.addEventListener('resize',()=>{if(S.n?.window&&pickDims()!==C){S.windowId=null;renderChart(S.n);}});
loadFast();loadCore();loadSlow();startFrames();
setInterval(()=>{if(!document.hidden)loadFast();},5000);
setInterval(()=>{if(!document.hidden)loadCore();},15000);
setInterval(()=>{if(!document.hidden)loadSlow();},60000);
setInterval(()=>{if(document.hidden)return;tickCountdown();if(reduced())moveNow(false);if(S.n&&S.cursor==null)renderReadout();},1000);
// hidden: no frames, no reads; visible again: reconcile immediately
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(S.raf){cancelAnimationFrame(S.raf);S.raf=0;}return;}loadCore();loadFast();startFrames();});
