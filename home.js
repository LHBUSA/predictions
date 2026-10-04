// Homepage: renders only stored values from /api (pbe-predictions Worker). No illustrative numbers.
const API = '/api';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const until = (iso) => { const m = Math.round((Date.parse(iso) - Date.now()) / 60000); if (m < 0) return 'closed'; if (m < 60) return `${m} min`; if (m < 1440) return `${Math.round(m / 60)} h`; return `${Math.round(m / 1440)} d`; };
const BADGE = { RESEARCH: 'b-research', VALIDATED: 'b-validated', OFFICIAL: 'b-official', MARKET_MONITORING: 'b-monitoring', MONITORING: 'b-monitoring', SHADOW: 'b-shadow', BACKTESTING: 'b-backtesting' };
const badge = (s) => `<span class="badge ${BADGE[s] || 'b-monitoring'}">${esc(s === 'MARKET_MONITORING' ? 'Market monitoring' : s)}</span>`;
const dcls = (d) => (d > 0 ? 'dpos' : d < 0 ? 'dneg' : '');
const getJSON = async (p) => { const r = await fetch(`${API}/${p}`); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
let deskAccess = { tier: 'free' };
// All Access: the full divergence scanner (every market, search, sort). Free: the largest headline gaps.
function applyAccess() {
  const free = deskAccess.tier !== 'all_access';
  for (const id of ['q', 'sort']) { const el = $(id); if (el) { el.hidden = free; const lab = document.querySelector(`label[for="${id}"]`); if (lab) lab.hidden = free; } }
  let lock = $('desk-lock');
  if (free && deskAccess.total_events > (deskAccess.shown || 0)) {
    if (!lock) { lock = document.createElement('div'); lock.id = 'desk-lock'; lock.className = 'card prem prem-desk'; $('desk-list').after(lock); }
    lock.innerHTML = `<span class="prem-kicker">ALL ACCESS</span><p>Showing the ${deskAccess.shown} largest model-vs-market gaps of <b class="num">${deskAccess.total_events}</b> live events (${deskAccess.total_contracts.toLocaleString()} contracts). The full divergence scanner — every market, search and sorting — is part of All Access.</p><a class="aa-pill" href="https://propbetedge.ai/pro" data-pbe-placement="predictions_desk_unlock">10 sports + PropBetEdge Predictions · $29/month</a> <a class="prem-signin" href="#" data-pbe-signin>Already a member? Sign in</a>`;
  } else if (lock) lock.remove();
}
async function loadPremiumDesk() {
  try {
    const r = await fetch(`${API}/premium/desk`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json(); events = d.events; deskAccess = d.access || { tier: 'all_access' };
    cats(); desk(); applyAccess();
  } catch { /* stays on the free desk */ }
}
document.addEventListener('pbe:membership', (ev) => { if (ev.detail?.entitled) loadPremiumDesk(); });

let events = [];
const state = { cat: new URLSearchParams(location.search).get('category') || 'ALL', q: '', sort: 'div' };

function stats(s) {
  $('s-live').textContent = s.live_contracts.toLocaleString(); $('s-live-sub').textContent = `${s.live_events} events · ${Object.keys(s.by_category).length} categories`;
  $('s-modeled').textContent = s.modeled_contracts.toLocaleString();
  $('s-monitor').textContent = s.monitoring_contracts.toLocaleString();
  $('s-scored').textContent = s.resolved_scored.toLocaleString(); $('s-scored-sub').textContent = s.resolved_scored ? 'contracts with stored scores' : 'first settlements pending';
  $('s-cycle').textContent = ago(s.last_engine_cycle); $('s-cycle-sub').textContent = s.last_engine_cycle ? new Date(s.last_engine_cycle).toISOString().slice(11, 16) + ' UTC · every 15 min' : '';
  $('s-models').textContent = String(s.models_live); $('s-models-sub').textContent = `live research · ${s.models_shadow} shadow (not published)`;
  const stale = s.last_engine_cycle && Date.now() - Date.parse(s.last_engine_cycle) > 45 * 60000;
  if (stale) { $('live-dot').style.background = 'var(--neg-bg)'; $('live-dot').style.color = 'var(--neg)'; $('live-text').textContent = 'Engine delayed'; }
}

function tape() {
  const items = events.filter((e) => e.headline && e.headline.pbe_pct !== null).sort((a, b) => b.max_abs_divergence - a.max_abs_divergence).slice(0, 18);
  if (!items.length) { $('tape').parentElement.hidden = true; return; }
  const html = items.map((e) => { const h = e.headline; return `<a href="${esc(e.url)}"><b>${esc(e.category_label.toUpperCase())}</b> · ${esc(shortTitle(e))} · ${esc(h.label)} · PBE <b class="num">${h.pbe_pct}%</b> · MKT <b class="num">${h.market_pct ?? '—'}${h.market_pct !== null ? '%' : ''}</b>${h.divergence_pts !== null ? ` · <span class="num ${h.divergence_pts >= 0 ? 'pos' : 'neg'}">${sign(h.divergence_pts)}</span>` : ''}</a>`; }).join('');
  $('tape').innerHTML = html + html; // duplicated for a seamless loop
}

function shortTitle(e) { return e.title.replace(/^(Highest temperature in|Where will it rain on|How (high|low) will the)\s*/i, '').replace(/\?$/, '').slice(0, 48); }

function featured() {
  const top = events.filter((e) => e.headline?.divergence_pts !== null && e.headline?.pbe_pct !== null).sort((a, b) => Math.abs(b.headline.divergence_pts) - Math.abs(a.headline.divergence_pts)).slice(0, 3);
  if (!top.length) { $('featured').closest('.section').hidden = true; return; }
  $('featured').innerHTML = top.map((e) => { const h = e.headline; return `<a class="card feat" href="${esc(e.url)}">
    <div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}<span>closes in ${until(e.close_time)}</span></div>
    <h3>${esc(e.title)}</h3><div class="outcome">Outcome: <b>${esc(h.label)}</b> · ${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled</div>
    <div class="trio"><div><span>PBE</span><strong class="num">${h.pbe_pct}%</strong></div><div><span>Market</span><strong class="num">${h.market_pct}%</strong></div><div><span>Divergence</span><strong class="num ${dcls(h.divergence_pts)}">${sign(h.divergence_pts)}</strong></div></div>
    ${miniDist(e)}</a>`; }).join('');
}

function miniDist(e) {
  if (e.kind !== 'exclusive' || e.outcomes.length < 3 || e.outcomes.some((o) => o.pbe_pct === null)) return '';
  const max = Math.max(...e.outcomes.map((o) => Math.max(o.pbe_pct || 0, o.market_pct || 0)), 1);
  return `<div class="minidist" aria-label="PBE vs market distribution">${e.outcomes.map((o) => `<i style="height:${Math.max(4, (o.pbe_pct / max) * 100)}%" title="${esc(o.label)}: PBE ${o.pbe_pct}%"></i><i class="m" style="height:${Math.max(4, ((o.market_pct || 0) / max) * 100)}%" title="${esc(o.label)}: market ${o.market_pct ?? '—'}%"></i>`).join('')}</div>`;
}

function cats() {
  const counts = {};
  for (const e of events) counts[e.category] = (counts[e.category] || 0) + 1;
  const order = ['WEATHER', 'MACRO', 'RATES', 'FINANCE', 'BUSINESS', 'SCIENCE', 'SPACE', 'PUBLIC_HEALTH', 'ENERGY'];
  const label = Object.fromEntries(events.map((e) => [e.category, e.category_label]));
  const btn = (k, l, n) => `<button class="chip" data-cat="${k}" aria-pressed="${state.cat === k}">${esc(l)}${n !== undefined ? `<small>${n}</small>` : ''}</button>`;
  $('cats').innerHTML = btn('ALL', 'All', events.length) + order.filter((k) => counts[k]).map((k) => btn(k, label[k] || k, counts[k])).join('');
  $('cats').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { state.cat = b.dataset.cat; cats(); desk(); }));
}

function desk() {
  const q = state.q.trim().toLowerCase();
  let rows = events.filter((e) => (state.cat === 'ALL' || e.category === state.cat) && (!q || `${e.title} ${e.category_label} ${e.outcomes.map((o) => o.label).join(' ')}`.toLowerCase().includes(q)));
  if (state.sort === 'div') rows.sort((a, b) => b.max_abs_divergence - a.max_abs_divergence || Date.parse(a.close_time) - Date.parse(b.close_time));
  if (state.sort === 'close') rows.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  if (state.sort === 'fresh') rows.sort((a, b) => Date.parse(b.headline?.published_at || 0) - Date.parse(a.headline?.published_at || 0));
  if (window.PBE_MV?.handles(state.sort)) rows = window.PBE_MV.order(state.sort, rows); // multi-venue modes (offered only when non-empty)
  if (!rows.length) { $('desk-list').innerHTML = `<div class="card empty-honest">No live events match this filter.</div>`; return; }
  $('desk-list').innerHTML = rows.map((e) => { const h = e.headline || {}; const modeled = h.pbe_pct !== null && h.pbe_pct !== undefined;
    return `<a class="card row" href="${esc(e.url)}">
      <div><div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}${e.kalshi_url ? '<span>Kalshi</span>' : ''}${modeled ? `<span>${esc(h.confidence?.toLowerCase() || '')} data quality · ${ago(h.published_at)}</span>` : ''}</div>
      <h3>${esc(e.title)}</h3><div class="sub">${modeled ? `Headline outcome: <b>${esc(h.label)}</b> · ` : ''}${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled</div></div>
      <div class="cells">${modeled
        ? `<div class="cell"><span>PBE</span><strong class="num">${h.pbe_pct}%</strong></div><div class="cell"><span>Market</span><strong class="num">${h.market_pct ?? '—'}${h.market_pct !== null ? '%' : ''}</strong></div><div class="cell"><span>Div.</span><strong class="num ${dcls(h.divergence_pts)}">${h.divergence_pts !== null ? sign(h.divergence_pts) : '—'}</strong></div>`
        : `<div class="cell mon" style="grid-column:span 2"><span>PBE</span><strong>Market monitoring</strong></div><div class="cell"><span>Market</span><strong class="num">${h.market_pct ?? '—'}${h.market_pct !== null && h.market_pct !== undefined ? '%' : ''}</strong></div>`}</div>
      <div class="when"><b>${until(e.close_time)}</b>to close</div></a>`; }).join('');
  window.PBE_MV?.decorate(rows);
}

function calendar(c) {
  const rows = c.events.slice(0, 14);
  $('cal').innerHTML = rows.length ? rows.map((e) => `<tr><td class="num">${new Date(e.close_time).toISOString().slice(0, 16).replace('T', ' ')} UTC</td><td><a href="${esc(e.url)}">${esc(e.title)}</a></td><td>${esc(e.category_label)}</td><td>${badge(e.state)}</td><td class="num">${e.outcomes_total}</td></tr>`).join('') : '<tr><td colspan="5" class="note">No tracked event closes in the next three weeks.</td></tr>';
}

function trackRecord(t) {
  const g = (d, m) => t.groups.find((x) => x.designation === d && x.method === m);
  const b = g('FINAL_PRE_RESOLUTION', 'brier'); const l = g('FINAL_PRE_RESOLUTION', 'log_loss');
  const enough = t.resolved_contracts >= t.min_for_claims;
  $('tr').innerHTML = `
    <div class="stat"><span>Resolved forecasts</span><strong class="num">${t.resolved_contracts ? t.resolved_contracts : 'Building'}</strong><small>${t.resolved_contracts ? 'contracts scored' : 'first settlements pending'}</small></div>
    <div class="stat"><span>Brier (final pre-resolution)</span><strong class="num">${b && enough ? b.pbe_mean.toFixed(3) : 'Pending'}</strong><small>${b ? `market ${b.market_mean?.toFixed(3) ?? '—'} · n=${b.n}${enough ? '' : ` (needs ${t.min_for_claims})`}` : 'lower is better'}</small></div>
    <div class="stat"><span>Log loss</span><strong class="num">${l && enough ? l.pbe_mean.toFixed(3) : 'Pending'}</strong><small>${l ? `market ${l.market_mean?.toFixed(3) ?? '—'}` : 'lower is better'}</small></div>
    <div class="stat"><span>Calibration</span><strong>${enough ? 'Measurable' : 'Pending'}</strong><small>${enough ? 'see the research board' : `claims start at ${t.min_for_claims} resolved`}</small></div>`;
}

function registry(m) {
  $('reg').innerHTML = m.families.map((f) => `<tr><td><b>${esc(f.name)}</b></td><td>${esc(f.category_label)}</td><td>${badge(f.state)}</td><td class="num">${f.contracts_tracked || '—'}</td><td class="num">${f.live_forecasts || '—'}</td><td class="num">${f.resolved ?? '—'}</td><td class="note">${esc(f.calibration_state)}</td></tr>`).join('');
}

function fail(where, e) { console.error(where, e); }

async function main() {
  $('q').addEventListener('input', (e) => { state.q = e.target.value; desk(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; desk(); });
  $('desk-list').innerHTML = Array.from({ length: 6 }, () => '<div class="card skel" style="height:78px"></div>').join('');
  const [s, d, c, t, m] = await Promise.allSettled([getJSON('summary'), getJSON('desk'), getJSON('calendar'), getJSON('track-record'), getJSON('models')]);
  if (s.status === 'fulfilled') stats(s.value); else fail('summary', s.reason);
  if (d.status === 'fulfilled') { events = d.value.events; deskAccess = d.value.access || { tier: 'free' }; tape(); featured(); cats(); desk(); applyAccess(); if (window.PBE_MEMBERSHIP?.entitled) loadPremiumDesk(); }
  // Multi-venue desk (no URL flag): loaded after the desk is on screen so a slow venue read never delays it;
  // the desk re-renders once with venue lines. Polymarket appears only when the shared Worker returns it.
  if (d.status === 'fulfilled') import('./multivenue.js?v=20261004mv3').then((m) => m.ready).then(() => { window.PBE_MV?.addModes(events); desk(); }).catch((e) => fail('multi-venue', e));
  else { $('desk-list').innerHTML = '<div class="card empty-honest">The live desk could not be loaded right now. Stored records are unaffected; try again shortly.</div>'; fail('desk', d.reason); }
  if (c.status === 'fulfilled') calendar(c.value);
  if (t.status === 'fulfilled') trackRecord(t.value);
  if (m.status === 'fulfilled') registry(m.value);
}
main();
