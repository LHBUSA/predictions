// PropBetEdge Predictions — shared client core (loaded before each page controller: home.js, desk.js,
// track-record.js, calendar.js). Renders only stored values from /api (pbe-predictions Worker); no illustrative numbers.
// Predictions is included with PropBetEdge All Access: paid numbers come only from gated routes (server-side 401/403/503);
// a non-member never receives them, so the locked cells below are placeholders, never blurred real values.
const API = '/api';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
const pts = (n) => `${n > 0 ? '+' : n < 0 ? '\u2212' : ''}${Math.abs(n)} pts`;
const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const until = (iso) => { const m = Math.round((Date.parse(iso) - Date.now()) / 60000); if (m < 0) return 'closed'; if (m < 60) return `${m} min`; if (m < 1440) return `${Math.round(m / 60)} h`; return `${Math.round(m / 1440)} d`; };
const agoEl = (iso) => `<span data-ago="${esc(iso || '')}">${ago(iso)}</span>`;
const untilEl = (iso) => `<span data-until="${esc(iso || '')}">${until(iso)}</span>`;
const BADGE = { RESEARCH: 'b-research', VALIDATED: 'b-validated', OFFICIAL: 'b-official', MARKET_MONITORING: 'b-monitoring', MONITORING: 'b-monitoring', SHADOW: 'b-shadow', BACKTESTING: 'b-backtesting' };
const badge = (s) => `<span class="badge ${BADGE[s] || 'b-monitoring'}">${esc(s === 'MARKET_MONITORING' ? 'Market monitoring' : s)}</span>`;
const dcls = (d) => (d > 0 ? 'dpos' : d < 0 ? 'dneg' : '');
const pctTxt = (v) => (v == null ? null : v < 1 ? '<1%' : v > 99 ? '>99%' : `${v}%`);
const utcHM = (iso) => (iso ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : '—');
const getJSON = async (p) => { const r = await fetch(`${API}/${p}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
function fail(where, e) { console.error(where, e); }
// Placeholder for a members-only number (nothing to un-blur: the server never sent the value).
const LOCKED = '<span class="locked-num" title="Included with PropBetEdge All Access"><i aria-hidden="true">00</i>%<span class="sr-only">PBE probability included with All Access</span></span>';
const LOCKED_PTS = '<span class="locked-num" title="Included with PropBetEdge All Access"><i aria-hidden="true">+00</i> pts<span class="sr-only">Divergence included with All Access</span></span>';
const AA_URL = 'https://propbetedge.ai/pro';

// Engine heartbeat in the shared header (every page): healthy -> the page's own wording; delayed/failed said plainly.
function liveStatus(s) {
  const eng = s?.engine || null;
  const engState = eng?.state || null;
  const stale = engState ? engState === 'delayed' || engState === 'failed' : !!(s?.last_engine_cycle && Date.now() - Date.parse(s.last_engine_cycle) > 45 * 60000);
  const staleText = engState === 'failed' ? 'Engine cycle failed' : 'Engine delayed';
  const dot = $('live-dot'); const txt = $('live-text');
  if (dot && txt) {
    if (!('liveText' in dot.dataset)) dot.dataset.liveText = txt.textContent;
    dot.style.background = stale ? 'var(--neg-bg)' : ''; dot.style.color = stale ? 'var(--neg)' : '';
    txt.textContent = stale ? staleText : dot.dataset.liveText;
  }
}

// ---- LIVE REFRESH (owner P4 2026-10-04): no reloads. Each page registers ONLY the datasets it shows
// (PBE.datasets[name] = { ms, run }). While the tab is visible, a dataset refreshes when its interval is due; hidden tab:
// no network at all; on return, everything due is fetched immediately. One timer and one visibility listener for the
// page's life; at most one in-flight request per dataset; run() re-renders only when its payload changed (sigFetch).
const live = { last: {}, inflight: new Set(), sig: {}, requests: 0, timer: null, listener: false };
const PBE = { datasets: {} };
// fetch + change detection: resolves to the parsed body when it changed, null when unchanged or refused.
async function sigFetch(name, path, init = {}) {
  const r = await fetch(`${API}/${path}`, { cache: 'no-store', ...init });
  if (!r.ok) return null;
  const body = await r.text();
  if (body === live.sig[name]) return null;
  live.sig[name] = body;
  return JSON.parse(body);
}
async function pull(name) {
  const d = PBE.datasets[name];
  if (!d || document.hidden || live.inflight.has(name)) return;
  live.inflight.add(name); live.last[name] = Date.now(); live.requests += 1;
  try { await d.run(); } catch (e) { fail(`live ${name}`, e); } finally { live.inflight.delete(name); }
}
function tickAges() {
  for (const el of document.querySelectorAll('[data-ago]')) if (el.dataset.ago) el.textContent = ago(el.dataset.ago);
  for (const el of document.querySelectorAll('[data-until]')) if (el.dataset.until) el.textContent = until(el.dataset.until);
}
function liveTick() {
  if (document.hidden) return; // paused: zero requests while hidden
  const now = Date.now();
  for (const [name, d] of Object.entries(PBE.datasets)) if (now - (live.last[name] || 0) >= d.ms) pull(name);
  tickAges();
}
function startLive(seeded) {
  Object.assign(live.last, seeded);
  if (live.timer === null) live.timer = setInterval(liveTick, 10e3); // one timer for the page's lifetime
  if (!live.listener) { live.listener = true; document.addEventListener('visibilitychange', () => { if (!document.hidden) liveTick(); }); }
}
// first load: run every registered dataset once (in parallel), then hand over to the timer
async function bootLive() {
  const names = Object.keys(PBE.datasets);
  await Promise.allSettled(names.map((n) => pull(n)));
  const t0 = Date.now();
  startLive(Object.fromEntries(names.map((n) => [n, live.last[n] || t0])));
}
window.PBE_LIVE = { stats: () => ({ requests: live.requests, inflight: [...live.inflight], timer: live.timer !== null, listener: live.listener, last: { ...live.last } }) };

// URL state for filters/tabs (shareable; survives reload, back and forward)
const urlState = {
  get: (k, d) => new URLSearchParams(location.search).get(k) ?? d,
  set(obj) {
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(obj)) { if (v === null || v === undefined || v === '' || v === 'ALL' || (k === 'page' && Number(v) === 1)) q.delete(k); else q.set(k, String(v)); }
    const s = q.toString();
    history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}${location.hash}`);
  },
};
// Numbered pager (keyboard reachable buttons). Calls onPage(n).
function pager(el, page, pages, onPage) {
  if (!el) return;
  if (pages <= 1) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const btn = (n, label, cur) => `<button type="button" class="pg" data-page="${n}"${cur ? ' aria-current="page"' : ''}${n < 1 || n > pages ? ' disabled' : ''}>${label}</button>`;
  const nums = []; for (let n = 1; n <= pages; n++) if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n); else if (nums.at(-1) !== '…') nums.push('…');
  el.innerHTML = btn(page - 1, '‹ Prev') + nums.map((n) => (n === '…' ? '<span class="pg-gap">…</span>' : btn(n, n, n === page))).join('') + btn(page + 1, 'Next ›') + `<span class="pg-note">Page ${page} of ${pages}</span>`;
  el.querySelectorAll('button[data-page]:not([disabled])').forEach((b) => b.addEventListener('click', () => onPage(Number(b.dataset.page))));
}
