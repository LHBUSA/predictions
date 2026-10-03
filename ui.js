// Intelligence desk — live records only. Every number is a stored Kalshi observation (linked back to Kalshi)
// or a stored, versioned PBE forecast from /api (pbe-predictions Worker). Contracts without a model are
// MARKET MONITORING with no PBE number. Nothing here is illustrative.
const API = '/api';
const list = document.querySelector('#market-list');
const sortSelect = document.querySelector('#sort');
let activeDomain = 'all';
let rows = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);
const pts = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${n} pts`);
const ago = (iso) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
const recordUrl = (id) => `/record/?id=${encodeURIComponent(id)}`;

function flatten(board) {
  const out = [];
  for (const e of board.events || []) {
    for (const c of e.contracts) {
      const live = c.market && !['CLOSED', 'SETTLED'].includes(c.market.lifecycle);
      if (!live) continue;
      if (c.mode !== 'MODELED' && e.model_state !== 'MARKET_MONITORING') continue; // modeled family without a pre-window forecast is not listed
      out.push({ ...c, question: e.canonical_question, domain: e.domain, close_time: e.close_time });
    }
  }
  return out;
}

function sorted() {
  const r = activeDomain === 'all' ? [...rows] : rows.filter((x) => x.domain === activeDomain);
  const mode = sortSelect?.value || 'edge';
  if (mode === 'edge') r.sort((a, b) => Math.abs(b.divergence_pts ?? -1) - Math.abs(a.divergence_pts ?? -1));
  if (mode === 'closing') r.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  if (mode === 'updated') r.sort((a, b) => Date.parse(b.pbe?.published_at || 0) - Date.parse(a.pbe?.published_at || 0));
  return r;
}

function card(c) {
  const kalshi = c.market?.kalshi_url ? `<a class="venue" href="${esc(c.market.kalshi_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Kalshi ↗</a>` : '<span class="venue">Kalshi</span>';
  const probs = c.mode === 'MODELED'
    ? `<div class="prob-box"><span>PBE model</span><strong>${pct(c.pbe.probability_pct)}</strong></div>
       <div class="prob-box"><span>Market</span><strong>${pct(c.market?.probability_pct)}</strong></div>
       <div class="prob-box edge"><span>Divergence</span><strong>${pts(c.divergence_pts)}</strong></div>`
    : `<div class="prob-box monitoring"><span>PBE model</span><strong>Market monitoring</strong></div>
       <div class="prob-box"><span>Market</span><strong>${pct(c.market?.probability_pct)}</strong></div>`;
  return `
    <article class="market-card" data-id="${esc(c.contract_id)}" tabindex="0" aria-label="Open forecast record">
      <div>
        <div class="market-meta"><span class="tag">${esc(c.domain.toLowerCase())}</span>${kalshi}${c.pbe ? `<span class="venue">PBE ${esc(c.pbe.model_state.toLowerCase())} · ${esc(c.pbe.confidence.toLowerCase())} data quality · ${ago(c.pbe.published_at)}</span>` : ''}</div>
        <div class="market-title">${esc(c.question)}</div>
        <div class="market-sub"><b>${esc(c.label)}</b> · ${esc(c.station || '')} ${esc(c.station_name || '')}${c.window ? ` · climate day ${esc(c.window.start.slice(0, 10))}` : ''}</div>
      </div>
      <div class="prob-grid">${probs}</div>
    </article>`;
}

function render() {
  const r = sorted();
  list.innerHTML = r.slice(0, 60).map(card).join('');
  document.querySelector('#desk-count').textContent = r.length ? `${r.length} live contracts · ${r.filter((x) => x.mode === 'MODELED').length} with a PBE forecast` : '';
  list.querySelectorAll('[data-id]').forEach((el) => {
    const open = () => { location.href = recordUrl(el.dataset.id); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  featured(r);
}

function featured(r) {
  const top = [...r].filter((x) => x.divergence_pts !== null).sort((a, b) => Math.abs(b.divergence_pts) - Math.abs(a.divergence_pts))[0];
  const rail = document.querySelector('#largest-card');
  const ref = document.querySelector('#reference-live');
  if (!top) { rail.hidden = true; ref.hidden = true; return; }
  rail.hidden = false;
  document.querySelector('#largest-edge').innerHTML = `${top.divergence_pts > 0 ? '+' : ''}${top.divergence_pts}<span> pts</span>`;
  document.querySelector('#largest-edge-title').textContent = `${top.question} — ${top.label}`;
  document.querySelector('#largest-bars').innerHTML = `
    <div><span>PBE model</span><div><b style="width:${top.pbe.probability_pct}%"></b></div><strong>${top.pbe.probability_pct}%</strong></div>
    <div><span>Market price</span><div><b style="width:${top.market.probability_pct}%"></b></div><strong>${top.market.probability_pct}%</strong></div>`;
  document.querySelector('#largest-link').href = recordUrl(top.contract_id);
  ref.hidden = false;
  document.querySelector('#ref-code').textContent = top.market_id;
  document.querySelector('#ref-title').textContent = `${top.question} — ${top.label}`;
  document.querySelector('#ref-probs').innerHTML = `<div><span>PBE model</span><strong>${top.pbe.probability_pct}%</strong></div><div><span>Market</span><strong>${top.market.probability_pct}%</strong></div><div><span>Divergence</span><strong>${pts(top.divergence_pts)}</strong></div>`;
  document.querySelector('#ref-meta').innerHTML = `<span>${esc(top.pbe.model)}</span><span>Published ${esc(new Date(top.pbe.published_at).toISOString().slice(0, 16).replace('T', ' '))} UTC</span><span>${esc(top.pbe.model_state)}</span>`;
  document.querySelector('#ref-open').href = recordUrl(top.contract_id);
}

async function trackRecord() {
  try {
    const t = await (await fetch(`${API}/track-record`)).json();
    if (!t.resolved_contracts) return; // keep the pre-declared "Building / Pending" states until real resolutions exist
    const g = (d, m) => t.groups.find((x) => x.designation === d && x.method === m);
    const b = g('FINAL_PRE_RESOLUTION', 'brier');
    const l = g('FINAL_PRE_RESOLUTION', 'log_loss');
    document.querySelector('#tr-resolved').textContent = String(t.resolved_contracts);
    if (b) document.querySelector('#tr-brier').textContent = `${b.pbe_mean.toFixed(3)} (market ${b.market_mean?.toFixed(3) ?? '—'}, n=${b.n})`;
    if (l) document.querySelector('#tr-logloss').textContent = `${l.pbe_mean.toFixed(3)} (market ${l.market_mean?.toFixed(3) ?? '—'})`;
  } catch {}
}

async function load() {
  try {
    const board = await (await fetch(`${API}/board`)).json();
    rows = flatten(board);
  } catch { rows = []; }
  render();
}

document.querySelectorAll('.category').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.category').forEach((x) => x.classList.remove('active'));
  btn.classList.add('active');
  activeDomain = btn.dataset.category;
  render();
}));
sortSelect?.addEventListener('change', render);
document.querySelector('#citation-mode')?.addEventListener('click', (e) => {
  document.body.classList.toggle('citation-on');
  e.currentTarget.textContent = document.body.classList.contains('citation-on') ? 'Citation mode on' : 'Citation mode';
});
document.querySelectorAll('[data-scroll]').forEach((btn) => btn.addEventListener('click', () => document.querySelector(btn.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' })));
document.querySelectorAll('.nav-link').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach((x) => x.classList.remove('active'));
  btn.classList.add('active');
  document.querySelector(btn.dataset.view === 'track' ? '#methodology' : '#intelligence')?.scrollIntoView({ behavior: 'smooth' });
}));

load();
trackRecord();
setInterval(load, 120000);
