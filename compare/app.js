const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SPORTS=new Set(['nfl','nba','nhl','mlb','wnba']);
let all=[],liveItems=[],view='gaps',marketTimer=0,scoreTimer=0,loadingMarkets=false,loadingScores=false;
const qs=new URLSearchParams(location.search),selectedEvent=qs.get('event')||'',selectedMarket=qs.get('market')||'',initialScope=(qs.get('scope')||'').toLowerCase();

const pct=bp=>bp==null?'—':(bp/100).toFixed(bp%100?1:0)+'%';
const signed=n=>n>0?'+'+n.toFixed(1):n<0?'−'+Math.abs(n).toFixed(1):'0.0';
const age=iso=>{const ms=Date.now()-Date.parse(iso||'');if(!Number.isFinite(ms)||ms<0)return'';if(ms<60000)return Math.max(1,Math.round(ms/1000))+'s ago';if(ms<3600000)return Math.round(ms/60000)+'m ago';return Math.round(ms/3600000)+'h ago'};
const freshest=c=>Math.max(0,...(c.venues||[]).map(v=>Date.parse(v.observed_at||'')||0));
const pbeDivergence=c=>Math.max(0,...(c.comparison?.pbe_vs_venues_pts||[]).map(Math.abs));
const keyFor=c=>c.canonical_contract_id||c.label||c.event_title;
const rowId=c=>'m-'+btoa(unescape(encodeURIComponent(keyFor(c)))).replace(/[^a-zA-Z0-9]/g,'').slice(0,50);
const currentSport=()=>SPORTS.has($('#scope').value)?$('#scope').value:null;

async function member(){const r=await fetch('/api/membership',{credentials:'include',cache:'no-store'});return r.json()}
function clearMarketTimer(){window.clearTimeout(marketTimer);marketTimer=0}
function clearScoreTimer(){window.clearTimeout(scoreTimer);scoreTimer=0}
function clearTimers(){clearMarketTimer();clearScoreTimer()}
function scheduleMarket(){clearMarketTimer();marketTimer=window.setTimeout(()=>{void loadMarkets(true)},document.hidden?120000:60000)}
function scheduleScore(){clearScoreTimer();if(currentSport())scoreTimer=window.setTimeout(()=>{void loadScores(true)},document.hidden?60000:15000)}
function normalizeTitle(s){return String(s||'').toLowerCase().replace(/(vs|v|at)/g,' ').replace(/[^a-z0-9]+/g,' ').trim()}
function liveFor(c){
  const id=String(c.canonical_event_id||'');
  let x=liveItems.find(e=>String(e.source_id)===id);
  if(x)return x;
  const t=normalizeTitle(c.event_title);
  return liveItems.find(e=>normalizeTitle(e.title)===t)||null;
}
function scoreHtml(ev){
  if(!ev)return'';
  if(ev.score?.away&&ev.score?.home)return '<div class="market-score"><span class="score-pill"><span>'+esc(ev.score.away.abbr)+'</span><b>'+esc(ev.score.away.score??'—')+'</b></span><span class="score-pill"><span>'+esc(ev.score.home.abbr)+'</span><b>'+esc(ev.score.home.score??'—')+'</b></span><span class="tag game-live">'+esc(ev.status_label||ev.status)+'</span></div>';
  if(ev.summary)return '<div class="market-score"><span class="score-pill"><span>'+esc(ev.summary.label||'LIVE')+'</span><b>'+esc(ev.summary.value||'—')+'</b></span><span class="tag game-live">'+esc(ev.status_label||ev.status)+'</span></div>';
  return '<div class="market-score"><span class="tag game-live">'+esc(ev.status_label||ev.status)+'</span></div>';
}
function deepLink(c){const u=new URL('https://compare.propbetedge.ai/');u.searchParams.set('scope',$('#scope').value);if(c.canonical_event_id)u.searchParams.set('event',c.canonical_event_id);if(c.canonical_contract_id)u.searchParams.set('market',c.canonical_contract_id);return u.toString()}
function freshnessTags(c){return(c.venues||[]).map(v=>{const f=String(v.freshness||'unknown').toLowerCase(),cls=f==='live'?'live':f==='stale'?'stale':'';return '<span class="tag '+cls+'">'+esc(v.venue)+' '+esc(f.toUpperCase())+(v.observed_at?' · '+esc(age(v.observed_at)):'')+'</span>'}).join('')}

async function loadMarkets(fromTimer=false){
  if(loadingMarkets)return;loadingMarkets=true;
  try{
    const v=$('#scope').value,u=v==='nonsports'?'/api/desk?domain=nonsports&limit=200':'/api/desk?sport='+encodeURIComponent(v)+'&limit=200';
    const r=await fetch(u,{credentials:'include',cache:'no-store'});
    if(r.ok){const d=await r.json();all=(d.events||[]).flatMap(e=>(e.contracts||[]).map(c=>({...c,canonical_event_id:c.canonical_event_id||e.canonical_event_id||e.id||'',event_title:e.title||e.label||e.question||'',destination:e.destination,start_at:e.start_at||e.close_time||null})));render()}
  }finally{loadingMarkets=false;if(fromTimer)scheduleMarket()}
}
async function loadScores(fromTimer=false){
  const sport=currentSport();if(!sport){liveItems=[];renderLiveRail();return}
  if(loadingScores)return;loadingScores=true;
  try{
    const r=await fetch('/api/live?sport='+encodeURIComponent(sport),{credentials:'include',cache:'no-store'});
    if(r.ok){const d=await r.json();liveItems=d.items||[];render();renderLiveRail(d)}
  }finally{loadingScores=false;if(fromTimer)scheduleScore()}
}
async function refreshAll(){clearTimers();await Promise.all([loadMarkets(false),loadScores(false)]);scheduleMarket();scheduleScore()}

function renderLiveRail(board){
  const rail=$('#live-rail'),box=$('#live-games'),live=liveItems.filter(x=>x.status==='live');
  $('#livegames').textContent=live.length;
  if(!currentSport()){rail.hidden=true;return}
  rail.hidden=false;
  $('#live-source').textContent=(board?.generated_at?'Scores '+age(board.generated_at):'Live score feed')+' · markets refresh ~1m';
  const show=[...live,...liveItems.filter(x=>x.status==='scheduled').slice(0,4)].slice(0,8);
  box.innerHTML=show.map(ev=>'<a class="live-game" href="'+esc(ev.pbecast_url||ev.href)+'"><header><span class="sport">'+esc(ev.sport.toUpperCase())+'</span><span class="state">'+esc(ev.status==='live'?'● LIVE':ev.status_label||ev.status)+'</span></header><h3>'+esc(ev.title)+'</h3>'+(ev.score?.away&&ev.score?.home?'<div class="score"><span>'+esc(ev.score.away.abbr)+'</span><b>'+esc(ev.score.away.score??'—')+'</b><span>'+esc(ev.score.home.abbr)+'</span><b>'+esc(ev.score.home.score??'—')+'</b></div>':'<small>'+esc(ev.detail||ev.summary?.value||'Coverage available')+'</small>')+'</a>').join('')||'<div class="empty">No live or upcoming games returned by this sport feed.</div>';
}
function rowHtml(c){
  const kv=(c.venues||[]).find(v=>v.venue==='kalshi'),pm=(c.venues||[]).find(v=>v.venue==='polymarket'),cmp=c.comparison,pbe=c.pbe?.probability!=null?Math.round(c.pbe.probability*100)+'%':'—',rel=(c.related||[])[0],outside=cmp&&/^outside/.test(cmp.pbe_position||''),gap=cmp?.venue_gap_pts??null,div=pbeDivergence(c),title=c.event_title||c.label||'Market',ev=liveFor(c),selected=selectedMarket&&c.canonical_contract_id===selectedMarket;
  const command=new URL('https://members.propbetedge.ai/');command.searchParams.set('add',deepLink(c));command.searchParams.set('title',title+(c.label&&c.label!==title?' · '+c.label:''));
  return '<article class="row '+(ev?.status==='live'?'live-row':'')+'" id="'+rowId(c)+'"'+(selected?' data-selected="true"':'')+'><div class="row-main"><div class="market"><div class="title">'+esc(title)+'</div>'+(c.label&&c.label!==title?'<div class="label">'+esc(c.label)+'</div>':'')+scoreHtml(ev)+'<div class="sub"><span class="tag">'+esc(cmp?.match_class||(rel?rel.match:'NO COMPARISON'))+'</span>'+(outside?'<span class="tag outside">PBE OUTSIDE BOTH</span>':'')+(rel?'<span class="tag related">RELATED · RULES DIFFER</span>':'')+'<span class="freshness">'+freshnessTags(c)+'</span></div></div><div class="metric"><span>PBE</span><strong class="gold">'+pbe+'</strong><small>'+esc(c.pbe?.state||'')+'</small></div><div class="metric"><span>Kalshi</span><strong>'+pct(kv?.mid_bp)+'</strong><small>'+esc(kv?.observed_at?age(kv.observed_at):'')+'</small></div><div class="metric"><span>Polymarket</span><strong>'+pct(pm?.mid_bp)+'</strong><small>'+esc(pm?.observed_at?age(pm.observed_at):'')+'</small></div><div class="metric"><span>Venue gap</span><strong class="'+(gap!=null&&gap>=5?'red':'green')+'">'+(gap!=null?gap.toFixed(1)+' pts':'—')+'</strong></div><div class="metric"><span>Game</span><strong class="'+(ev?.status==='live'?'green':'')+'">'+esc(ev?.status_label||'—')+'</strong><small>'+esc(ev?.detail||'')+'</small></div></div><div class="row-actions">'+(ev?'<a class="action primary" href="'+esc(ev.pbecast_url||ev.href)+'">OPEN LIVE COVERAGE ↗</a>':'')+(c.canonical_event_id&&c.canonical_contract_id?'<button class="action" type="button" data-history="'+esc(rowId(c))+'" data-event="'+esc(c.canonical_event_id)+'" data-market="'+esc(c.canonical_contract_id)+'">24H OBSERVED MOVE</button>':'')+'<a class="action" href="'+esc(command.toString())+'">+ COMMAND CENTER</a>'+(kv?.market_url?'<a class="action" href="'+esc(kv.market_url)+'" target="_blank" rel="noopener nofollow">KALSHI ↗</a>':'')+(pm?.market_url?'<a class="action" href="'+esc(pm.market_url)+'" target="_blank" rel="noopener nofollow">POLYMARKET ↗</a>':'')+'<a class="action" href="'+esc(deepLink(c))+'">SHARE</a></div><div class="history" data-history-box="'+esc(rowId(c))+'"></div></article>';
}
function filteredRows(){
  const q=$('#q').value.toLowerCase().trim();let rows=all.filter(c=>(c.event_title+' '+(c.label||'')).toLowerCase().includes(q));
  if(view==='live')rows=rows.filter(c=>liveFor(c)?.status==='live');
  if(view==='outside')rows=rows.filter(c=>/^outside/.test(c.comparison?.pbe_position||''));
  if(view==='gaps')rows=rows.filter(c=>c.comparison);
  const sort=$('#sort').value;rows.sort((a,b)=>sort==='pbe'?pbeDivergence(b)-pbeDivergence(a):sort==='fresh'?freshest(b)-freshest(a):(b.comparison?.venue_gap_pts||0)-(a.comparison?.venue_gap_pts||0));return rows
}
function render(){
  const rows=filteredRows(),comparable=all.filter(c=>c.comparison).length,outside=all.filter(c=>/^outside/.test(c.comparison?.pbe_position||'')).length,max=Math.max(0,...all.map(c=>c.comparison?.venue_gap_pts||0));
  $('#exact').textContent=comparable;$('#outside').textContent=outside;$('#maxgap').textContent=max?max.toFixed(1)+' pts':'—';$('#live-count').textContent=comparable;$('#livegames').textContent=liveItems.filter(x=>x.status==='live').length;$('#heartbeat').textContent=(currentSport()?'Scores ~15s · markets ~1m':'Markets refresh automatically')+(document.hidden?' · paused in background':'');
  $('#rows').innerHTML=rows.map(rowHtml).join('')||'<div class="gate empty">No markets match this view right now.</div>';bindHistory();renderLiveRail()
}
function summarizeMoves(series){return(series||[]).map(s=>{const p=(s.segments||[]).flat();if(p.length<2)return{source:s.source,label:s.label,move:null,n:p.length};return{source:s.source,label:s.label,move:(p.at(-1).v-p[0].v)/100,n:p.length}})}
function bindHistory(){document.querySelectorAll('[data-history]').forEach(button=>button.addEventListener('click',async()=>{const box=document.querySelector('[data-history-box="'+button.dataset.history+'"]');if(!box)return;if(box.classList.contains('open')){box.classList.remove('open');return}box.classList.add('open');box.innerHTML='<div class="loading-line">Loading stored observations…</div>';try{const r=await fetch('/api/series?event='+encodeURIComponent(button.dataset.event)+'&market='+encodeURIComponent(button.dataset.market)+'&hours=24',{credentials:'include',cache:'no-store'});if(!r.ok)throw new Error();const d=await r.json(),moves=summarizeMoves(d.series);box.innerHTML='<div class="moves">'+moves.map(m=>'<div class="move"><small>'+esc(m.label||m.source)+' · '+m.n+' observations</small><b class="'+(m.move>0?'green':m.move<0?'red':'')+'">'+(m.move==null?'Not enough observations':signed(m.move)+' pts')+'</b></div>').join('')+'</div><p class="loading-line">Observed points only. No interpolation or reconstructed moves.</p>'}catch{box.innerHTML='<div class="loading-line">Observed history is unavailable right now.</div>'}}))}
async function init(){
  if(initialScope&&[...$('#scope').options].some(o=>o.value===initialScope))$('#scope').value=initialScope;if(selectedMarket)view='all';
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  const m=await member();$('#acct').textContent=m.membership?.label||'Account';
  if(m.membership?.entitled){$('#gate').hidden=true;$('#app').hidden=false;await refreshAll();if(selectedMarket)requestAnimationFrame(()=>document.getElementById(rowId({canonical_contract_id:selectedMarket}))?.scrollIntoView({block:'center'}))}else $('#gate').hidden=false
}
$('#scope').addEventListener('change',()=>{view=currentSport()?'live':'gaps';document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));void refreshAll()});
$('#sort').addEventListener('change',render);$('#q').addEventListener('input',render);
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));render()}));
document.addEventListener('visibilitychange',()=>{clearTimers();if(!document.hidden)void refreshAll();else{scheduleMarket();scheduleScore()}});
window.addEventListener('pagehide',clearTimers,{once:true});
init();