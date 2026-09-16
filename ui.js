const markets = [
  {id:'fed-next',category:'macro',venue:'Kalshi',title:'Federal Reserve decision — next meeting',sub:'Policy decision · model v0.1 research',model:68,market:56,edge:12,updated:4,liquidity:92,resolution:'Federal Reserve · official FOMC decision',sources:['FRED CPI series','FRED unemployment series','Federal Reserve policy data'],status:'research'},
  {id:'cpi-3',category:'macro',venue:'Kalshi',title:'Headline CPI above 3.0%',sub:'Inflation release · research pipeline',model:47,market:41,edge:6,updated:11,liquidity:74,resolution:'U.S. Bureau of Labor Statistics',sources:['BLS CPI','FRED mirror','Release calendar'],status:'research'},
  {id:'home-yoy',category:'housing',venue:'Research',title:'U.S. home prices positive YoY',sub:'Housing intelligence · PropData research track',model:61,market:54,edge:7,updated:19,liquidity:41,resolution:'Declared housing index source',sources:['PropData','FHFA HPI','Market datasets'],status:'research'},
  {id:'atlantic-landfall',category:'weather',venue:'Research',title:'Major Atlantic hurricane landfall',sub:'Weather intelligence · research track',model:32,market:38,edge:-6,updated:27,liquidity:38,resolution:'Declared official weather authority',sources:['NOAA/NHC research inputs','Historical storm archive'],status:'research'}
];

const list=document.querySelector('#market-list');
const sortSelect=document.querySelector('#sort');
let activeCategory='all';

const pct=n=>`${Math.round(n)}%`;
const signed=n=>`${n>0?'+':''}${Number(n).toFixed(1)} pts`;

function filtered(){
  let rows=activeCategory==='all'?[...markets]:markets.filter(m=>m.category===activeCategory);
  const mode=sortSelect?.value||'edge';
  if(mode==='edge')rows.sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge));
  if(mode==='updated')rows.sort((a,b)=>a.updated-b.updated);
  if(mode==='liquidity')rows.sort((a,b)=>b.liquidity-a.liquidity);
  return rows;
}

function render(){
  const rows=filtered();
  list.innerHTML=rows.map(m=>`
    <article class="market-card" data-market="${m.id}" tabindex="0" aria-label="Open intelligence record for ${m.title}">
      <div>
        <div class="market-meta"><span class="tag">${m.category}</span><span class="venue">${m.venue}</span><span class="venue">Updated ${m.updated}m ago</span></div>
        <div class="market-title">${m.title}</div>
        <div class="market-sub">${m.sub}</div>
      </div>
      <div class="prob-grid">
        <div class="prob-box"><span>Model</span><strong>${pct(m.model)}</strong></div>
        <div class="prob-box"><span>Market</span><strong>${pct(m.market)}</strong></div>
        <div class="prob-box edge"><span>Divergence</span><strong>${signed(m.edge)}</strong></div>
      </div>
    </article>`).join('')||'<div class="rail-card">No research markets in this category yet.</div>';
  bindCards();
  updateLargest(rows);
}

function updateLargest(rows){
  const top=[...rows].sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge))[0];
  if(!top)return;
  document.querySelector('#largest-edge').innerHTML=`${top.edge>0?'+':''}${top.edge.toFixed(1)}<span> pts</span>`;
  document.querySelector('#largest-edge-title').textContent=top.title;
}

function bindCards(){
  document.querySelectorAll('[data-market]').forEach(card=>{
    const open=()=>openDrawer(markets.find(m=>m.id===card.dataset.market));
    card.addEventListener('click',open);
    card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
  });
}

function openDrawer(m){
  if(!m)return;
  const drawer=document.querySelector('#event-drawer');
  const content=document.querySelector('#drawer-content');
  content.innerHTML=`
    <div class="drawer-hero">
      <span class="overline">FORECAST RECORD · ${m.category.toUpperCase()}</span>
      <h2>${m.title}</h2>
      <p>${m.sub}</p>
      <div class="drawer-kpis">
        <div><span>Model</span><strong>${pct(m.model)}</strong></div>
        <div><span>Market</span><strong>${pct(m.market)}</strong></div>
        <div><span>Divergence</span><strong>${signed(m.edge)}</strong></div>
      </div>
    </div>
    <div class="drawer-section"><h3>Resolution authority</h3><p>${m.resolution}</p></div>
    <div class="drawer-section"><h3>Evidence ledger</h3><ul>${m.sources.map(s=>`<li>${s}</li>`).join('')}</ul></div>
    <div class="drawer-section"><h3>Research state</h3><p>This is a ${m.status} forecast. It is not presented as validated edge until point-in-time backtesting and calibration are complete.</p></div>
    <div class="drawer-section"><h3>Permanent record concept</h3><p>Production records will preserve model version, market snapshot, feature snapshot, source provenance, capture time, resolution rule and final score.</p></div>`;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden','false');
}

function closeDrawer(){
  const d=document.querySelector('#event-drawer');
  d.classList.remove('open');
  d.setAttribute('aria-hidden','true');
}

document.querySelectorAll('.category').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.category').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active');
  activeCategory=btn.dataset.category;
  render();
}));
sortSelect?.addEventListener('change',render);
document.querySelectorAll('[data-close-drawer]').forEach(el=>el.addEventListener('click',closeDrawer));
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer();});

document.querySelector('#citation-mode')?.addEventListener('click',e=>{
  document.body.classList.toggle('citation-on');
  e.currentTarget.textContent=document.body.classList.contains('citation-on')?'Citation mode on':'Citation mode';
});

document.querySelector('#copy-citation')?.addEventListener('click',async e=>{
  const text='PropBetEdge Predictions, Forecast Record PBE-FED-2026-09-001, Federal Reserve target-rate decision, model v0.1.0, research status.';
  try{await navigator.clipboard.writeText(text);e.currentTarget.textContent='Copied';setTimeout(()=>e.currentTarget.textContent='Copy citation',1400);}catch{e.currentTarget.textContent='Citation ready';}
});

document.querySelectorAll('[data-scroll]').forEach(btn=>btn.addEventListener('click',()=>document.querySelector(btn.dataset.scroll)?.scrollIntoView({behavior:'smooth'})));
document.querySelectorAll('.nav-link').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.nav-link').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active');
  if(btn.dataset.view==='track')document.querySelector('#methodology')?.scrollIntoView({behavior:'smooth'});
  else document.querySelector('#intelligence')?.scrollIntoView({behavior:'smooth'});
}));

render();
