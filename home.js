// Homepage: renders only stored values from /api (pbe-predictions Worker). No illustrative numbers.
// Predictions is a premium product included with PropBetEdge All Access. Public (owner 2026-10-05): the product shell,
// engine/aggregate stats, calendar, track record, model registry and a PREVIEW of the desk (/api/preview/desk: what is
// tracked, close times, venue prices, whether a PBE model covers it) with the PBE numbers shown blurred. The blur covers
// a placeholder: real PBE numbers never reach a non-member (the server never sends them). All Access / owner: the full
// desk (/api/desk, gated server-side), tape and featured divergences.
const API = '/api';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
// Visible model-vs-market gaps always carry their unit (percentage POINTS, never a % return or an accuracy figure).
const pts = (n) => `${n > 0 ? '+' : n < 0 ? '\u2212' : ''}${Math.abs(n)} pts`;
const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const agoEl = (iso) => `<span data-ago="${esc(iso || '')}">${ago(iso)}</span>`;
const untilEl = (iso) => `<span data-until="${esc(iso || '')}">${until(iso)}</span>`;
const until = (iso) => { const m = Math.round((Date.parse(iso) - Date.now()) / 60000); if (m < 0) return 'closed'; if (m < 60) return `${m} min`; if (m < 1440) return `${Math.round(m / 60)} h`; return `${Math.round(m / 1440)} d`; };
const BADGE = { RESEARCH: 'b-research', VALIDATED: 'b-validated', OFFICIAL: 'b-official', MARKET_MONITORING: 'b-monitoring', MONITORING: 'b-monitoring', SHADOW: 'b-shadow', BACKTESTING: 'b-backtesting' };
const badge = (s) => `<span class="badge ${BADGE[s] || 'b-monitoring'}">${esc(s === 'MARKET_MONITORING' ? 'Market monitoring' : s)}</span>`;
const dcls = (d) => (d > 0 ? 'dpos' : d < 0 ? 'dneg' : '');
const getJSON = async (p) => { const r = await fetch(`${API}/${p}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
// All Access / owner only (access.js resolves membership; the server enforces it). The gate stays for everyone else.
let member = false;
let preview = false;
let mvLoaded = false;
const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; const lab = document.querySelector(`label[for="${id}"]`); if (lab) lab.hidden = !on; };
function unlock() {
  preview = false; state.sort = $('sort')?.value || 'div';
  show('desk-gate', false); show('desk-controls', true); show('sort', true); show('hero-member-cta', true);
}
// Blurred stand-in for a members-only number (a placeholder, not the value: nothing to un-blur).
const LOCKED = '<span class="locked-num" title="Included with PropBetEdge All Access"><i aria-hidden="true">00</i>%<span class="sr-only">PBE probability included with All Access</span></span>';
const LOCKED_PTS = '<span class="locked-num" title="Included with PropBetEdge All Access"><i aria-hidden="true">+00</i> pts<span class="sr-only">Divergence included with All Access</span></span>';
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
  tape(); featured(); cats(); views(); desk();
  // Multi-venue desk: loaded after the desk is on screen so a slow venue read never delays it.
  if (!mvLoaded) { mvLoaded = true; import('./multivenue.js?v=20261004mv4').then((m) => m.ready).then(() => { window.PBE_MV?.addModes(events); desk(); }).catch((e) => fail('multi-venue', e)); }
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
  loadDesk().then((ok) => { if (!ok) { member = false; $('desk-list').innerHTML = ''; } });
}
document.addEventListener('pbe:membership', (ev) => onMembership(ev.detail));

let events = [];
const state = { cat: new URLSearchParams(location.search).get('category') || 'ALL', q: '', sort: 'div', view: 'ALL' };

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
  el.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; views(); desk(); }));
}
const pctTxt = (v) => (v == null ? null : v < 1 ? '<1%' : v > 99 ? '>99%' : `${v}%`);
const utcHM = (iso) => (iso ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : '—');
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

function stats(s) {
  $('s-live').textContent = s.live_contracts.toLocaleString(); $('s-live-sub').textContent = `${s.live_events} events · ${Object.keys(s.by_category).length} categories`;
  $('s-modeled').textContent = s.modeled_contracts.toLocaleString();
  $('s-monitor').textContent = s.monitoring_contracts.toLocaleString();
  $('s-scored').textContent = s.resolved_scored.toLocaleString(); $('s-scored-sub').textContent = s.resolved_scored ? 'contracts with stored scores' : 'first settlements pending';
  // Engine heartbeat (pred_engine_runs, goodl-97 sql/011): last_engine_cycle = completed_at of the latest SUCCESSFUL core
  // run; the cadence shown is the scheduler's own engine.cadence_minutes (never a constant in copy).
  const eng = s.engine || null;
  const cad = eng && Number.isFinite(eng.cadence_minutes) ? eng.cadence_minutes : null;
  // No-empty-state rule: with no successful recorded run yet, the engine card is not rendered at all (no
  // "not yet" placeholder); it appears with the first completed core run.
  const cycleCard = $('s-cycle').closest?.('.stat');
  if (cycleCard) cycleCard.hidden = !s.last_engine_cycle;
  $('s-cycle').dataset.ago = s.last_engine_cycle || '';
  $('s-cycle').textContent = s.last_engine_cycle ? ago(s.last_engine_cycle) : '';
  $('s-cycle-sub').textContent = s.last_engine_cycle ? `${new Date(s.last_engine_cycle).toISOString().slice(11, 16)} UTC${cad ? ` · core every ${cad} min` : ''}` : '';
  $('s-models').textContent = String(s.models_live); $('s-models-sub').textContent = `live research · ${s.models_shadow} shadow (not published)`;
  // healthy / running -> the page's own live wording; delayed / failed -> said plainly. No heartbeat block (ledger
  // unreadable) -> the previous age rule.
  const engState = eng?.state || null;
  const stale = engState ? engState === 'delayed' || engState === 'failed' : !!(s.last_engine_cycle && Date.now() - Date.parse(s.last_engine_cycle) > 45 * 60000);
  const staleText = engState === 'failed' ? 'Engine cycle failed' : 'Engine delayed';
  const dot = $('live-dot'); const txt = $('live-text');
  if (dot && txt) {
    if (!('liveText' in dot.dataset)) dot.dataset.liveText = txt.textContent; // the page's own healthy wording
    dot.style.background = stale ? 'var(--neg-bg)' : ''; dot.style.color = stale ? 'var(--neg)' : '';
    txt.textContent = stale ? staleText : dot.dataset.liveText;
  }
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

function featured() {
  const top = events.filter((e) => e.headline?.divergence_pts !== null && e.headline?.pbe_pct !== null).sort((a, b) => Math.abs(b.headline.divergence_pts) - Math.abs(a.headline.divergence_pts)).slice(0, 3);
  $('featured').closest('.section').hidden = !top.length;
  if (!top.length) return;
  $('featured').innerHTML = top.map((e) => { const h = e.headline; return `<a class="card feat" href="${esc(e.url)}">
    <div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}<span>closes in ${untilEl(e.close_time)}</span></div>
    <h3>${esc(e.title)}</h3><div class="outcome">Outcome: <b>${esc(h.label)}</b> · ${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled</div>
    <div class="trio"><div><span>PBE</span><strong class="num">${h.pbe_pct}%</strong></div><div><span>Market</span><strong class="num">${h.market_pct}%</strong></div><div><span>Divergence</span><strong class="num ${dcls(h.divergence_pts)}">${pts(h.divergence_pts)}</strong></div></div>
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
  const openWhy = new Set([...document.querySelectorAll('#desk-list .row-wrap')].filter((w) => w.querySelector('details.why-row')?.open).map((w) => w.querySelector('a.row')?.getAttribute('href')));
  const q = state.q.trim().toLowerCase();
  let rows = events.filter((e) => (state.cat === 'ALL' || e.category === state.cat) && (state.view === 'ALL' || VIEWS[state.view]?.test(e)) && (!q || `${e.title} ${e.category_label} ${(e.outcomes || []).map((o) => o.label).join(' ')}`.toLowerCase().includes(q)));
  if (preview) { rows.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)); $('desk-list').innerHTML = rows.length ? rows.map(previewRow).join('') : '<div class="card empty-honest">No live events match this filter.</div>'; return; }
  if (state.sort === 'div') rows.sort((a, b) => b.max_abs_divergence - a.max_abs_divergence || Date.parse(a.close_time) - Date.parse(b.close_time));
  if (state.sort === 'close') rows.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  if (state.sort === 'fresh') rows.sort((a, b) => Date.parse(b.headline?.published_at || 0) - Date.parse(a.headline?.published_at || 0));
  if (window.PBE_MV?.handles(state.sort)) rows = window.PBE_MV.order(state.sort, rows); // multi-venue modes (offered only when non-empty)
  if (!rows.length) { $('desk-list').innerHTML = `<div class="card empty-honest">No live events match this filter.</div>`; return; }
  $('desk-list').innerHTML = rows.map((e) => { const h = e.headline || {}; const modeled = h.pbe_pct !== null && h.pbe_pct !== undefined; const m = marketState(e, h);
    const mkt = `<div class="cell"><span>Market</span><strong class="${m.value ? 'num' : 'null-state'}">${esc(m.value || m.note)}</strong>${m.value && m.note ? `<small class="null-note">${esc(m.note)}</small>` : ''}</div>`;
    return `<div class="row-wrap"><a class="card row" href="${esc(e.url)}">
      <div><div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}${modeled && h.confidence ? `<span>${esc(h.confidence.toLowerCase())} data quality</span>` : ''}${modeled ? `<span>${agoEl(h.published_at)}</span>` : ''}</div>
      <h3>${esc(e.title)}</h3><div class="sub">${modeled ? `Headline outcome: <b>${esc(h.label)}</b> · ` : ''}${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled${modeled ? driverLine(h) : ''}${venueLine(h)}</div>${spark(h)}</div>
      <div class="cells">${modeled
        ? `<div class="cell"><span>PBE</span><strong class="num">${pctTxt(h.pbe_pct)}</strong></div>${mkt}${divCell(h)}`
        : `<div class="cell mon"><span>PBE</span><strong class="null-state">No PBE model</strong></div>${mkt}<div class="cell"><span>Div.</span><strong class="null-state">Not modeled</strong></div>`}</div>
      <div class="when"><b>${untilEl(e.close_time)}</b>to close</div></a>${modeled ? whyPanel(e, h) : ''}</div>`; }).join('');
  if (openWhy.size) for (const w of document.querySelectorAll('#desk-list .row-wrap')) if (openWhy.has(w.querySelector('a.row')?.getAttribute('href'))) { const d = w.querySelector('details.why-row'); if (d) d.open = true; }
  window.PBE_MV?.decorate(rows);
}

function cryptoMarkets(c) {
  const status = $('crypto-rail-status'); const grid = $('crypto-grid');
  if (!status || !grid) return;
  if (!c?.ok || !Array.isArray(c.symbols)) {
    status.textContent = 'Feed unavailable';
    status.classList.add('bad');
    grid.innerHTML = '<div class="card empty-honest">Robinhood market data is temporarily unavailable.</div>';
    return;
  }
  status.classList.remove('bad');
  status.textContent = 'Robinhood connected';
  const fmt = (n, symbol) => {
    if (n == null) return '—';
    const d = symbol === 'BTC-USD' ? 2 : symbol === 'ETH-USD' ? 2 : 4;
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const names = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana' };
  grid.innerHTML = c.symbols.map((x) => {
    const friction = x.spread_bps == null ? '—' : `${Number(x.spread_bps).toFixed(2)} bps`;
    const stamp = x.timestamp ? ago(x.timestamp) : '—';
    const rawState = x.raw_quote_crossed ? '<span class="rail-flag">raw book crossed</span>' : '<span class="rail-good">raw book clean</span>';
    const fee = x.fee_ratio == null ? '—' : `${(Number(x.fee_ratio) * 100).toFixed(2)}%`;
    const asset = x.symbol.replace('-USD','');
    const tradeUrl = `https://robinhood.com/us/en/crypto/${encodeURIComponent(asset)}/`;
    return `<article class="card crypto-card">
      <div class="crypto-card-head"><div><span class="crypto-symbol">${esc(asset)}</span><span class="crypto-name">${esc(names[x.symbol] || x.symbol)}</span></div>${x.api_tradable ? '<span class="rail-good">API tradable</span>' : '<span class="rail-flag">not API tradable</span>'}</div>
      <div class="crypto-price-label">Fee-adjusted midpoint</div>
      <div class="crypto-mid num">${fmt(x.mid, x.symbol)}</div>
      <div class="crypto-book"><span>Net sell <b class="num">${fmt(x.bid, x.symbol)}</b></span><span>Gross buy <b class="num">${fmt(x.ask, x.symbol)}</b></span><span>Total friction <b class="num">${friction}</b></span></div>
      <div class="crypto-foot"><span class="rail-good">fee-adjusted</span><span>Fee ${fee}</span><span>Size ${esc(String(x.estimate_quantity || '—'))}</span>${rawState}<span>${stamp}</span></div>
      <div class="crypto-actions"><a class="crypto-trade-btn" href="${tradeUrl}" target="_blank" rel="noopener noreferrer">Trade ${esc(asset)} on Robinhood <span aria-hidden="true">↗</span></a><span class="crypto-action-note">Opens Robinhood to review and place the order</span></div>
    </article>`;
  }).join('');
}
function cryptoExecutionLab(ladder, universe) {
  const ladders = $('crypto-ladders');
  const count = $('crypto-universe-count');
  const summary = $('crypto-universe-summary');
  const chips = $('crypto-universe-chips');
  if (!ladders || !count || !summary || !chips) return;

  const fmt = (n, symbol) => {
    if (n == null) return '—';
    const d = symbol === 'BTC-USD' || symbol === 'ETH-USD' ? 2 : 4;
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const names = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana' };

  if (ladder?.ok && ladder.ladders) {
    const order = ['BTC-USD','ETH-USD','SOL-USD'];
    ladders.innerHTML = order.map((symbol) => {
      const rows = ladder.ladders[symbol] || [];
      return `<section class="crypto-ladder-card"><div class="crypto-ladder-title"><b>${esc(symbol.replace('-USD',''))}</b><span>${esc(names[symbol] || symbol)}</span></div>
        <div class="tbl-wrap"><table class="tbl crypto-ladder-table"><thead><tr><th>USD size</th><th>Net sell</th><th>Gross buy</th><th>Friction</th></tr></thead><tbody>
        ${rows.length ? rows.map((r) => `<tr><td class="num">${Number(r.usd).toFixed(0)}</td><td class="num">${fmt(r.net_sell, symbol)}</td><td class="num">${fmt(r.gross_buy, symbol)}</td><td class="num">${r.total_friction_bps == null ? '—' : Number(r.total_friction_bps).toFixed(2) + ' bps'}</td></tr>`).join('') : '<tr><td colspan="4">No estimate available</td></tr>'}
        </tbody></table></div></section>`;
    }).join('');
  } else {
    ladders.innerHTML = '<div class="empty-honest">Execution ladder temporarily unavailable.</div>';
  }

  if (universe?.ok && Array.isArray(universe.symbols)) {
    count.textContent = `${universe.count} API-tradable pairs`;
    summary.textContent = `(${universe.count})`;
    chips.innerHTML = universe.symbols.map((x) => `<span class="crypto-universe-chip">${esc(x.symbol)}</span>`).join('');
  } else {
    count.textContent = 'Universe unavailable';
    summary.textContent = '';
    chips.innerHTML = '<span class="note">Robinhood universe temporarily unavailable.</span>';
  }
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
    <div class="stat"><span>Resolved contracts</span><strong class="num">${t.resolved_contracts ? t.resolved_contracts : 'Building'}</strong><small>${t.resolved_contracts ? 'contracts scored' : 'first settlements pending'}</small></div>
    <div class="stat"><span>Brier (final pre-resolution)</span><strong class="num">${b && enough ? b.pbe_mean.toFixed(3) : 'Pending'}</strong><small>${b ? `market ${b.market_mean?.toFixed(3) ?? '—'} · n=${b.n}${enough ? '' : ` (needs ${t.min_for_claims})`}` : 'lower is better'}</small></div>
    <div class="stat"><span>Log loss</span><strong class="num">${l && enough ? l.pbe_mean.toFixed(3) : 'Pending'}</strong><small>${l ? `market ${l.market_mean?.toFixed(3) ?? '—'}` : 'lower is better'}</small></div>
    <div class="stat"><span>Calibration</span><strong>${enough ? 'Measurable' : 'Pending'}</strong><small>${enough ? 'see the research board' : `claims start at ${t.min_for_claims} resolved`}</small></div>`;
}

function registry(m) {
  $('reg').innerHTML = m.families.map((f) => `<tr><td><b>${esc(f.name)}</b></td><td>${esc(f.category_label)}</td><td>${badge(f.state)}</td><td class="num">${f.contracts_tracked || '—'}</td><td class="num">${f.live_forecasts || '—'}</td><td class="num">${f.resolved ?? '—'}</td><td class="note">${esc(f.calibration_state)}</td></tr>`).join('');
}

function fail(where, e) { console.error(where, e); }

// ---- LIVE REFRESH (owner P4 2026-10-04): no reloads. While the tab is visible: summary + desk every 60 s, calendar
// every 2 min, track record + models every 5 min (or at once when the summary's scored count moves). Hidden tab: no
// network at all; on return, everything due is fetched immediately. One timer, one visibility listener, at most one
// in-flight request per dataset; a dataset re-renders only when its payload changed (no tape restart, no CLS).
// The desk refreshes only for members; a failed read keeps what is on screen (never a downgrade, never a free payload).
const LIVE_MS = { summary: 60e3, desk: 60e3, crypto: 15e3, cryptoLab: 60e3, calendar: 120e3, track: 300e3, models: 300e3 };
const live = { last: {}, inflight: new Set(), sig: {}, requests: 0, timer: null, listener: false };
async function pull(name) {
  if (document.hidden || live.inflight.has(name)) return;
  live.inflight.add(name); live.last[name] = Date.now(); live.requests += 1;
  try {
    if (name === 'desk' && !member) {
      const r = await fetch(`${API}/preview/desk`, { cache: 'no-store' });
      const body = r.ok ? await r.text() : null;
      if (!body || body === live.sig.preview || member) return;
      live.sig.preview = body; renderPreview(JSON.parse(body));
      return;
    }
    if (name === 'desk') {
      const r = await fetch(`${API}/desk`, { credentials: 'same-origin', cache: 'no-store' });
      const body = r.ok ? await r.text() : null;
      if (!body || body === live.sig.desk) return; // unchanged, or a failed read: keep what is on screen
      const d = JSON.parse(body); live.sig.desk = body;
      events = d.events;
      const tapeSig = JSON.stringify(events.filter((e) => e.headline && e.headline.pbe_pct !== null).map((e) => [e.url, e.headline.pbe_pct, e.headline.market_pct, e.headline.divergence_pts]));
      if (tapeSig !== live.sig.tape) { live.sig.tape = tapeSig; tape(); }
      featured(); cats(); views(); desk();
      return;
    }
    const path = { summary: 'summary', crypto: 'crypto/markets', calendar: 'calendar', track: 'track-record', models: 'models' }[name];
    if (name === 'cryptoLab') {
      const [ladder, universe] = await Promise.allSettled([getJSON('crypto/execution-ladder'), getJSON('crypto/universe')]);
      cryptoExecutionLab(ladder.status === 'fulfilled' ? ladder.value : null, universe.status === 'fulfilled' ? universe.value : null);
      return;
    }
    const r = await fetch(`${API}/${path}`, { cache: 'no-store' });
    if (!r.ok) return;
    const body = await r.text();
    if (body === live.sig[name]) return;
    live.sig[name] = body;
    const v = JSON.parse(body);
    if (name === 'summary') {
      const scoredMoved = live.scored !== undefined && v.resolved_scored !== live.scored;
      live.scored = v.resolved_scored; stats(v);
      if (scoredMoved) { live.last.track = 0; live.last.models = 0; } // newly resolved/scored state -> refresh now
    } else if (name === 'crypto') cryptoMarkets(v);
    else if (name === 'calendar') calendar(v);
    else if (name === 'track') trackRecord(v);
    else if (name === 'models') registry(v);
  } catch (e) { fail(`live ${name}`, e); } finally { live.inflight.delete(name); }
}
function tickAges() {
  for (const el of document.querySelectorAll('[data-ago]')) if (el.dataset.ago) el.textContent = ago(el.dataset.ago);
  for (const el of document.querySelectorAll('[data-until]')) if (el.dataset.until) el.textContent = until(el.dataset.until);
}
function liveTick() {
  if (document.hidden) return; // paused: zero requests while hidden
  const now = Date.now();
  for (const [name, ms] of Object.entries(LIVE_MS)) if (now - (live.last[name] || 0) >= ms) pull(name);
  tickAges();
}
function startLive(seeded) {
  Object.assign(live.last, seeded);
  if (live.timer === null) live.timer = setInterval(liveTick, 10e3); // one timer for the page's lifetime
  if (!live.listener) { live.listener = true; document.addEventListener('visibilitychange', () => { if (!document.hidden) liveTick(); }); }
}
window.PBE_LIVE = { stats: () => ({ requests: live.requests, inflight: [...live.inflight], timer: live.timer !== null, listener: live.listener, last: { ...live.last } }) };

async function main() {
  $('q').addEventListener('input', (e) => { state.q = e.target.value; desk(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; desk(); });
  if (window.PBE_MEMBERSHIP) onMembership(window.PBE_MEMBERSHIP); // access.js may have resolved first
  const [s, c, t, m, pv, cr, cl, cu] = await Promise.allSettled([getJSON('summary'), getJSON('calendar'), getJSON('track-record'), getJSON('models'), getJSON('preview/desk'), getJSON('crypto/markets'), getJSON('crypto/execution-ladder'), getJSON('crypto/universe')]);
  if (pv.status === 'fulfilled' && !member) { live.sig.preview = JSON.stringify(pv.value); renderPreview(pv.value); }
  if (s.status === 'fulfilled') stats(s.value); else fail('summary', s.reason);
  if (c.status === 'fulfilled') calendar(c.value);
  if (t.status === 'fulfilled') trackRecord(t.value);
  if (m.status === 'fulfilled') registry(m.value);
  if (cr.status === 'fulfilled') cryptoMarkets(cr.value); else cryptoMarkets({ ok: false });
  cryptoExecutionLab(cl.status === 'fulfilled' ? cl.value : null, cu.status === 'fulfilled' ? cu.value : null);
  if (s.status === 'fulfilled') live.scored = s.value.resolved_scored;
  const t0 = Date.now();
  startLive({ summary: t0, desk: live.last.desk || t0, crypto: t0, cryptoLab: t0, calendar: t0, track: t0, models: t0 });
}
main();
