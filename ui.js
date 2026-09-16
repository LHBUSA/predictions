const markets = [
  { category:'macro', venue:'Kalshi', title:'Federal Reserve decision — next meeting', sub:'Policy decision · research model v0.1', model:68, market:56, edge:+12 },
  { category:'macro', venue:'Kalshi', title:'Headline CPI above 3.0%', sub:'Inflation release · illustrative shell data', model:47, market:41, edge:+6 },
  { category:'housing', venue:'Research', title:'U.S. home prices positive YoY', sub:'Housing intelligence · PropData research track', model:61, market:54, edge:+7 },
  { category:'weather', venue:'Research', title:'Major Atlantic hurricane landfall', sub:'Weather intelligence · research track', model:32, market:38, edge:-6 }
];

const list = document.querySelector('#market-list');

function pct(n){ return `${Math.round(n)}%`; }
function signed(n){ return `${n>0?'+':''}${n.toFixed(1)} pts`; }

function render(category='all'){
  const rows = category==='all' ? markets : markets.filter(m=>m.category===category);
  list.innerHTML = rows.map(m => `
    <article class="market-card">
      <div>
        <div class="market-meta"><span class="tag">${m.category}</span><span class="venue">${m.venue}</span></div>
        <div class="market-title">${m.title}</div>
        <div class="market-sub">${m.sub}</div>
      </div>
      <div class="prob-grid">
        <div class="prob-box"><span>Model</span><strong>${pct(m.model)}</strong></div>
        <div class="prob-box"><span>Market</span><strong>${pct(m.market)}</strong></div>
        <div class="prob-box edge"><span>Divergence</span><strong>${signed(m.edge)}</strong></div>
      </div>
    </article>`).join('') || '<div class="panel">No V1 markets in this category yet.</div>';
}

render();

document.querySelectorAll('.chip').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active');
  render(btn.dataset.category);
}));

document.querySelectorAll('.nav-link').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.nav-link').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active');
}));
