// /desk/ — the Intelligence Desk: every tracked event (Kalshi/Polymarket event markets vs PBE forecasts). Public readers get
// /api/preview/desk (prices, close times, model coverage; PBE cells are placeholders). All Access members get the gated
// /api/desk (server-side 401/403/503; never un-gated in the client). Category tabs, views, search and page live in the
// URL. 20 events per page; the evidence ("why") expands in place; multi-venue modes load after the desk is on screen.
const PAGE_SIZE = 20;
let member = false;
let preview = false;
let mvLoaded = false;
const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; const lab = document.querySelector(`label[for="${id}"]`); if (lab) lab.hidden = !on; };
function unlock() {
  preview = false; state.sort = $('sort')?.value || 'div';
  show('desk-gate', false); show('desk-controls', true); show('sort', true); show('hero-member-cta', true);
}
function renderPreview(d) {
  if (member) return;
  preview = true; events = d.events; state.sort = 'close';
  show('desk-controls', true); show('sort', false);
  tape(); cats(); views(); desk();
}
function previewRow(e) {
  const h = e.headline || {}; const modeled = e.outcomes_modeled > 0;
  const mkt = h.market_pct != null ? pctTxt(h.market_pct) : null;
  return `<div class="row-wrap"><a class="card row" href="${esc(e.url)}">
      <div><div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}</div>
      <h3>${esc(e.title)}</h3><div class="sub">${h.label ? `Market favorite: <b>${esc(h.label)}</b> · ` : ''}${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled</div></div>
      <div class="cells">${modeled ? `<div class="cell"><span>PBE</span><strong class="num">${LOCKED}</strong><small class="lock-note">All Access</small></div>` : '<div class="cell mon"><span>PBE</span><strong class="null-state">No PBE model</strong></div>'}<div class="cell"><span>Market</span><strong class="${mkt ? 'num' : 'null-state'}">${esc(mkt || 'Awaiting market')}</strong></div>${modeled ? `<div class="cell"><span>Div.</span><strong class="num">${LOCKED_PTS}</strong><small class="lock-note">All Access</small></div>` : '<div class="cell"><span>Div.</span><strong class="null-state">Not modeled</strong></div>'}</div>
      <div class="when"><b>${untilEl(e.close_time)}</b>to close</div></a></div>`;
}
function renderDesk(d) {
  events = d.events;
  live.sig.tape = JSON.stringify(events.filter((e) => e.headline && e.headline.pbe_pct !== null).map((e) => [e.url, e.headline.pbe_pct, e.headline.market_pct, e.headline.divergence_pts]));
  tape(); cats(); views(); desk();
  // Multi-venue desk: loaded after the desk is on screen so a slow venue read never delays it.
  if (!mvLoaded) { mvLoaded = true; import('/multivenue.js?v=20261004mv4').then((m) => m.ready).then(() => { window.PBE_MV?.addModes(events); desk(); }).catch((e) => fail('multi-venue', e)); }
}
async function loadDesk() {
  try {
    const r = await fetch(`${API}/desk`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return false; // 401/403/503: the gate stays (access.js paints the right action)
    const body = await r.text(); live.sig.desk = body;
    unlock(); renderDesk(JSON.parse(body)); live.last.desk = Date.now();
    return true;
  } catch (e) { fail('desk', e); return false; }
}
function onMembership(m) {
  if (!m?.entitled || member) return;
  member = true;
  $('desk-list').innerHTML = Array.from({ length: 6 }, () => '<div class="card skel" style="height:78px"></div>').join('');
  loadDesk().then((ok) => { if (!ok) { member = false; $('desk-list').innerHTML = ''; if (live.sig.preview) renderPreview(JSON.parse(live.sig.preview)); } });
}
document.addEventListener('pbe:membership', (ev) => onMembership(ev.detail));
let events = [];
const state = { cat: urlState.get('category', 'ALL'), q: urlState.get('q', ''), sort: 'div', view: urlState.get('view', 'ALL'), page: Math.max(1, Number(urlState.get('page', 1)) || 1) };
const go = (patch) => { Object.assign(state, patch); urlState.set({ category: state.cat, view: state.view, q: state.q.trim(), page: state.page }); };

// Desk views. A view chip is offered only when it matches at least one live event (no empty states).
// HIGH CONFIDENCE = PBE's own evidence grade only. LARGE DIVERGENCE = a separate market-comparison state (comparable
// venues only). MARKET MOVING = stored Kalshi observations moved >= 3 pts in 3 h. Divergence is never called "alpha"
// or conviction. "PBE calls" appears only once prediction-decision-v1 is activated (decisions are not public before).
const LARGE_DIV = 10;
const comparableDivs = (h) => [h?.venues?.kalshi, h?.venues?.polymarket].filter((v) => v?.divergence).map((v) => v.divergence.pts);
const within = (iso, ms) => { const m = Date.parse(iso) - Date.now(); return m > 0 && m <= ms; };
const VIEWS = {
  CALLS: { label: 'PBE calls', test: (e) => e.headline?.decision?.official === true && e.headline.decision.state === 'CALL' },
  HIGH: { label: 'High confidence', test: (e) => e.headline?.pbe_pct != null && e.headline?.confidence === 'HIGH' },
  LARGE_DIV: { label: 'Large divergence', test: (e) => comparableDivs(e.headline).some((d) => Math.abs(d) >= LARGE_DIV) },
  MOVING: { label: 'Market moving', test: (e) => e.headline?.market_move?.moving === true },
  CLOSING: { label: 'Closing <24h', test: (e) => within(e.close_time, 24 * 3600000) },
  RESOLVING: { label: 'Resolving soon', test: (e) => within(e.resolves_at || e.close_time, 24 * 3600000) },
  DISAGREE: { label: 'Venue disagreement', test: (e) => e.headline?.venue_gap_pts != null && e.headline.venue_gap_pts >= 5 },
};
function views() {
  const el = $('views'); if (!el) return;
  const avail = Object.entries(VIEWS).map(([k, v]) => [k, v, events.filter(v.test).length]).filter(([, , n]) => n > 0);
  if (state.view !== 'ALL' && !avail.some(([k]) => k === state.view)) state.view = 'ALL';
  el.hidden = !avail.length;
  if (!avail.length) { el.innerHTML = ''; return; }
  const btn = (k, l, n) => `<button class="chip" data-view="${k}" aria-pressed="${state.view === k}">${esc(l)}<small>${n}</small></button>`;
  el.innerHTML = btn('ALL', 'All views', events.length) + avail.map(([k, v, n]) => btn(k, v.label, n)).join('');
  el.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { go({ view: b.dataset.view, page: 1 }); views(); desk(); }));
}
// Semantic null states: say what we know instead of a naked dash.
function marketState(e, h) {
  const k = h.venues?.kalshi;
  if (h.market_pct != null) return { value: pctTxt(h.market_pct), note: k?.freshness === 'stale' ? 'Stale quote' : null };
  if (e.kalshi_url || h.market_observed_at) return { value: null, note: 'No two-sided quote' };
  return { value: null, note: 'Awaiting market' };
}
function divState(h) {
  if (h.pbe_pct == null) return { note: 'No PBE model' };
  if (h.market_pct == null) return { note: 'No comparable market' };
  return { pts: h.divergence_pts };
}
// Divergence hierarchy: subtle heat on the numeric cell only, always paired with sign + magnitude text (never color alone).
const heat = (d) => { const a = Math.abs(d); return a >= 20 ? 'heat-3' : a >= LARGE_DIV ? 'heat-2' : a >= 5 ? 'heat-1' : 'heat-0'; };
function divCell(h) {
  const st = divState(h);
  if (st.note) return `<div class="cell"><span>Div.</span><strong class="null-state">${esc(st.note)}</strong></div>`;
  const d = st.pts;
  const words = Math.abs(d) <= 2 ? 'PBE and market agree' : `PBE ${Math.abs(d)} points ${d > 0 ? 'above' : 'below'} market`;
  return `<div class="cell"><span>Div.</span><strong class="num div-heat ${heat(d)} ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}" title="${esc(words)}"><b aria-hidden="true">${pts(d)}</b><i class="sr-only">${esc(words)}</i></strong></div>`;
}
const venueLine = (h) => {
  const k = h.venues?.kalshi; const p = h.venues?.polymarket;
  if (!k && !p) return '';
  const part = (name, v) => (v ? `${name} <b class="num">${v.mid_pct == null ? 'no two-sided quote' : pctTxt(v.mid_pct)}</b>${v.comparable === false ? ' <span class="note">(related · rules differ)</span>' : ''}` : '');
  return `<span class="v4-line">${[part('Kalshi', k), part('Polymarket', p)].filter(Boolean).join(' · ')}</span>`;
};
const driverLine = (h) => (h.why?.drivers?.length
  ? `<span class="v4-line">Why PBE: <b>${h.why.drivers.slice(0, 3).map((d) => `${esc(d.label)} ${esc(d.display)}${esc(d.unit)}`).join(' · ')}</b></span><span class="v4-line">${h.why.sources.length} source${h.why.sources.length === 1 ? '' : 's'} · cutoff ${utcHM(h.why.data_cutoff_at)}${h.evidence_age_h != null ? ` (${h.evidence_age_h < 1 ? '<1' : Math.round(h.evidence_age_h)} h old)` : ''}</span>`
  : h.driver ? `<span class="v4-line">Strongest driver: <b>${esc(h.driver.label)} ${esc(h.driver.display)}${esc(h.driver.unit)}</b></span>` : '');
// Truthful sparkline (24 h): stored observations only, step lines (a value holds until the next stored one), no
// smoothing/interpolation. PBE holds to now (a forecast stands until replaced); the Kalshi line ends at its last
// stored observation and breaks wherever nothing was stored for longer than the gap limit.
function spark(h) {
  const sp = h.spark; if (!sp) return '';
  const W = 132, H = 30, P = 2; const t0 = Date.parse(sp.from), t1 = Date.parse(sp.to);
  const x = (t) => (P + ((Math.max(t0, Math.min(t1, t)) - t0) / Math.max(1, t1 - t0)) * (W - 2 * P)).toFixed(1);
  const y = (v) => (P + (1 - v / 100) * (H - 2 * P)).toFixed(1);
  const path = (pts, holdTo, gap) => pts.map((p, i) => {
    const tp = Date.parse(p.t);
    const nextT = pts[i + 1] ? Date.parse(pts[i + 1].t) : null;
    const broken = i > 0 && gap && tp - Date.parse(pts[i - 1].t) > gap;
    const until = nextT !== null ? (gap && nextT - tp > gap ? tp : nextT) : (holdTo ?? tp);
    return `${i === 0 || broken ? 'M' : 'L'}${x(tp)},${y(p.v)} H${x(until)}`;
  }).join(' ');
  const k = sp.kalshi; const pb = sp.pbe;
  const lastK = k.at(-1); const lastP = pb.at(-1);
  const label = `Last 24 hours, stored observations only. PBE ${lastP ? `${lastP.v}%` : 'n/a'}; Kalshi ${lastK ? `${lastK.v}% at ${utcHM(lastK.t)}` : 'n/a'}.`;
  return `<div class="spark-wrap"><svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${k.length ? `<path d="${path(k, null, sp.gap_ms)}" class="sp-k"/>` : ''}${pb.length ? `<path d="${path(pb, t1, null)}" class="sp-p"/>` : ''}</svg><span class="spark-key" aria-hidden="true"><i class="k-p"></i>PBE <i class="k-k"></i>Kalshi · 24 h, stored only</span></div>`;
}
// Inline WHY: the deterministic evidence of the headline forecast, opened in place (no LLM text; every value is stored).
function whyPanel(e, h) {
  const w = h.why; if (!w) return '';
  const drivers = w.drivers.map((d) => `<li><span>${esc(d.label)}</span><b class="num">${esc(d.display)}${esc(d.unit)}</b>${d.source ? `<small>${esc(d.source)}${d.available_at ? ` · available ${utcHM(d.available_at)}` : ''}</small>` : ''}</li>`).join('');
  const ledger = w.sources.map((s) => `<li><span>${esc(s.name)}</span><small>${esc([s.provider, s.role, s.available_at && `available ${utcHM(s.available_at)}`, s.issued_at && `issued ${utcHM(s.issued_at)}`].filter(Boolean).join(' · '))}</small></li>`).join('');
  return `<details class="why-row"><summary><span>Why PBE · ${esc(h.label)}</span><small>${w.drivers.length} facts · ${w.sources.length} sources · cutoff ${utcHM(w.data_cutoff_at)}</small></summary>
<div class="why-body"><ul class="why-drivers">${drivers}</ul>
<p class="why-meta">Model <b class="mono">${esc(w.model)}</b> · ${esc((w.model_state || '').toLowerCase())} · confidence <b>${esc(w.confidence || '—')}</b> · published ${utcHM(w.published_at)} · data cutoff ${utcHM(w.data_cutoff_at)}</p>
<details class="why-ledger"><summary>Source ledger (${w.sources.length})</summary><ul>${ledger}</ul></details>
<a class="why-link" href="${esc(w.record_url)}">Full evidence record →</a></div></details>`;
}
function tape() {
  const items = preview
    ? events.filter((e) => e.outcomes_modeled > 0 && e.headline?.market_pct != null).slice(0, 18)
    : events.filter((e) => e.headline && e.headline.pbe_pct !== null).sort((a, b) => b.max_abs_divergence - a.max_abs_divergence).slice(0, 18);
  $('tape').parentElement.hidden = !items.length;
  if (!items.length) return;
  // ONE semantic track + ONE inert visual clone (the seamless loop): the clone is aria-hidden, inert and out of the tab
  // order, so screen readers, text extraction and crawlers see each item once. Reduced motion: no loop, no clone.
  const item = (e, clone) => { const h = e.headline; if (preview) return `<a href="${esc(e.url)}"${clone ? ' aria-hidden="true" tabindex="-1" inert data-tape-clone' : ''}><b>${esc(e.category_label.toUpperCase())}</b> · ${esc(shortTitle(e))} · ${esc(h.label)} · PBE <b class="num">${LOCKED}</b> · MKT <b class="num">${h.market_pct}%</b></a>`; return `<a href="${esc(e.url)}"${clone ? ' aria-hidden="true" tabindex="-1" inert data-tape-clone' : ''}><b>${esc(e.category_label.toUpperCase())}</b> · ${esc(shortTitle(e))} · ${esc(h.label)} · PBE <b class="num">${h.pbe_pct}%</b> · MKT <b class="num">${h.market_pct ?? '—'}${h.market_pct !== null ? '%' : ''}</b>${h.divergence_pts !== null ? ` · <span class="num ${h.divergence_pts >= 0 ? 'pos' : 'neg'}">${pts(h.divergence_pts)}</span>` : ''}</a>`; };
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('tape').innerHTML = items.map((e) => item(e, false)).join('') + (still ? '' : items.map((e) => item(e, true)).join(''));
}

function shortTitle(e) { return e.title.replace(/^(Highest temperature in|Where will it rain on|How (high|low) will the)\s*/i, '').replace(/\?$/, '').slice(0, 48); }
function cats() {
  const counts = {};
  for (const e of events) counts[e.category] = (counts[e.category] || 0) + 1;
  const order = ['WEATHER', 'MACRO', 'RATES', 'FINANCE', 'BUSINESS', 'SCIENCE', 'SPACE', 'PUBLIC_HEALTH', 'ENERGY'];
  const label = Object.fromEntries(events.map((e) => [e.category, e.category_label]));
  const btn = (k, l, n) => `<button class="chip" data-cat="${k}" aria-pressed="${state.cat === k}">${esc(l)}${n !== undefined ? `<small>${n}</small>` : ''}</button>`;
  $('cats').innerHTML = btn('ALL', 'All', events.length) + order.filter((k) => counts[k]).map((k) => btn(k, label[k] || k, counts[k])).join('');
  $('cats').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { go({ cat: b.dataset.cat, page: 1 }); cats(); desk(); }));
}

function modelChoice(e) {
  const choices=(e.outcomes||[]).filter(o=>Number.isFinite(o.pbe_pct));
  if(!choices.length)return '';
  const top=[...choices].sort((a,b)=>b.pbe_pct-a.pbe_pct || String(a.label).localeCompare(String(b.label)))[0];
  // An exclusive bucket distribution permits a single favored outcome.
  // Independent threshold YES contracts do not, so never call one a winner.
  const label=e.kind==='exclusive' && choices.length===e.outcomes.length
    ? 'Model favored outcome' : 'Highest modeled YES probability';
  return '<div class="choice-line"><b>'+esc(label)+': '+esc(top.label)+'</b><span>PBE '+esc(top.pbe_pct)+'% · Forecast only, not an official pick</span></div>';
}
function desk() {
  const openWhy = new Set([...document.querySelectorAll('#desk-list .row-wrap')].filter((w) => w.querySelector('details.why-row')?.open).map((w) => w.querySelector('a.row')?.getAttribute('href')));
  const q = state.q.trim().toLowerCase();
  let rows = events.filter((e) => (state.cat === 'ALL' || e.category === state.cat) && (state.view === 'ALL' || VIEWS[state.view]?.test(e)) && (!q || `${e.title} ${e.category_label} ${(e.outcomes || []).map((o) => o.label).join(' ')}`.toLowerCase().includes(q)));
  if (preview) { rows.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)); rows = paginate(rows); $('desk-list').innerHTML = rows.length ? rows.map(previewRow).join('') : '<div class="card empty-honest">No live events match this filter.</div>'; return; }
  if (state.sort === 'div') rows.sort((a, b) => b.max_abs_divergence - a.max_abs_divergence || Date.parse(a.close_time) - Date.parse(b.close_time));
  if (state.sort === 'close') rows.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  if (state.sort === 'fresh') rows.sort((a, b) => Date.parse(b.headline?.published_at || 0) - Date.parse(a.headline?.published_at || 0));
  if (window.PBE_MV?.handles(state.sort)) rows = window.PBE_MV.order(state.sort, rows); // multi-venue modes (offered only when non-empty)
  rows = paginate(rows);
  if (!rows.length) { $('desk-list').innerHTML = `<div class="card empty-honest">No live events match this filter.</div>`; return; }
  $('desk-list').innerHTML = rows.map((e) => { const h = e.headline || {}; const modeled = h.pbe_pct !== null && h.pbe_pct !== undefined; const m = marketState(e, h);
    const mkt = `<div class="cell"><span>Market</span><strong class="${m.value ? 'num' : 'null-state'}">${esc(m.value || m.note)}</strong>${m.value && m.note ? `<small class="null-note">${esc(m.note)}</small>` : ''}</div>`;
    return `<div class="row-wrap"><a class="card row" href="${esc(e.url)}">
      <div><div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}${modeled && h.confidence ? `<span>${esc(h.confidence.toLowerCase())} data quality</span>` : ''}${modeled ? `<span>${agoEl(h.published_at)}</span>` : ''}</div>
      <h3>${esc(e.title)}</h3><div class="sub">${modeled ? `Headline outcome: <b>${esc(h.label)}</b> · ` : ''}${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled${modeled ? driverLine(h) : ''}${venueLine(h)}</div>${modeled ? modelChoice(e) : ''}${spark(h)}</div>
      <div class="cells">${modeled
        ? `<div class="cell"><span>PBE</span><strong class="num">${pctTxt(h.pbe_pct)}</strong></div>${mkt}${divCell(h)}`
        : `<div class="cell mon"><span>PBE</span><strong class="null-state">No PBE model</strong></div>${mkt}<div class="cell"><span>Div.</span><strong class="null-state">Not modeled</strong></div>`}</div>
      <div class="when"><b>${untilEl(e.close_time)}</b>to close</div></a>${modeled ? whyPanel(e, h) : ''}</div>`; }).join('');
  if (openWhy.size) for (const w of document.querySelectorAll('#desk-list .row-wrap')) if (openWhy.has(w.querySelector('a.row')?.getAttribute('href'))) { const d = w.querySelector('details.why-row'); if (d) d.open = true; }
  window.PBE_MV?.decorate(rows);
}

// One page of results (20). The count line says exactly what is shown out of how many matches.
function paginate(rows) {
  const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE; const shown = rows.slice(start, start + PAGE_SIZE);
  const c = $('desk-count'); if (c) c.textContent = total ? `Showing ${start + 1}–${start + shown.length} of ${total} event${total === 1 ? '' : 's'}` : '';
  pager($('desk-pager'), state.page, pages, (n) => { go({ page: n }); desk(); $('desk-top')?.scrollIntoView({ behavior: 'auto', block: 'start' }); });
  return shown;
}

// datasets: the desk (60 s; members read the gated desk, everyone else the public preview) + the engine summary for the
// header heartbeat (60 s). Nothing else is fetched on this page.
PBE.datasets.desk = { ms: 60e3, run: async () => {
  if (!member) {
    const r = await fetch(`${API}/preview/desk`, { cache: 'no-store' });
    const body = r.ok ? await r.text() : null;
    if (!body || body === live.sig.preview || member) return;
    live.sig.preview = body; renderPreview(JSON.parse(body));
    return;
  }
  const r = await fetch(`${API}/desk`, { credentials: 'same-origin', cache: 'no-store' });
  const body = r.ok ? await r.text() : null;
  if (!body || body === live.sig.desk) return; // unchanged, or a failed read: keep what is on screen
  const d = JSON.parse(body); live.sig.desk = body;
  events = d.events;
  const tapeSig = JSON.stringify(events.filter((e) => e.headline && e.headline.pbe_pct !== null).map((e) => [e.url, e.headline.pbe_pct, e.headline.market_pct, e.headline.divergence_pts]));
  if (tapeSig !== live.sig.tape) { live.sig.tape = tapeSig; tape(); }
  cats(); views(); desk();
} };
PBE.datasets.summary = { ms: 60e3, run: async () => { const v = await sigFetch('summary', 'summary'); if (v) { liveStatus(v); deskSub(v); } } };
function deskSub(s) { const el = $('desk-sub'); if (el) el.textContent = `${s.live_events} events · ${s.live_contracts.toLocaleString()} contracts tracked · ${s.modeled_contracts.toLocaleString()} with a PBE probability · ${s.monitoring_contracts.toLocaleString()} market monitoring`; }

function main() {
  const q = $('q'); if (q) { q.value = state.q; q.addEventListener('input', (e) => { go({ q: e.target.value, page: 1 }); desk(); }); }
  $('sort')?.addEventListener('change', (e) => { state.sort = e.target.value; go({ page: 1 }); desk(); });
  if (window.PBE_MEMBERSHIP) onMembership(window.PBE_MEMBERSHIP); // access.js may have resolved first
  bootLive();
}
main();
