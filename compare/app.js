// PropBetEdge Compare — member surface. Data truth lives in core.js; lifecycle in poller.js.
import {
  SPORTS, SPORT_KEYS, BADGES, VIEWS, reasonText, fmtCents, fmtPct, ageText, normalizeEvent, rankEvents, scoreIndex,
  moves, fmtMove, WINDOWS, membershipState, screenNotices, boardEmpty
} from './core.js';
import { createLifecycle } from './poller.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PRO = 'https://propbetedge.ai/pro';
const MEMBERS = 'https://members.propbetedge.ai/';
const MARKET_MS = 60e3, SCORE_LIVE_MS = 15e3, SCORE_IDLE_MS = 60e3;
const SCOPES = [{ key: 'sports', label: 'ALL SPORTS' }, ...SPORTS.map((s) => ({ key: s.key, label: s.label.toUpperCase() })), { key: 'nonsports', label: 'PREDICTION MARKETS' }];
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const life = createLifecycle({ doc: document });
window.__compareLedger = life.ledger;

const S = {
  scope: 'sports', view: 'top', expanded: new Set(), focusMarket: '',
  member: null, memberState: 'loading',
  desk: null, deskStatus: 'loading', deskAt: 0,
  live: null, liveStatus: null, liveAt: 0,
  events: [], detail: new Map(), mounted: false
};

// ---------------------------------------------------------------------------------------------------------
// URL state (back/forward safe). Legacy deep links (?scope=nhl&event=<id>&market=<contract id>) still open.
function readUrl() {
  const q = new URLSearchParams(location.search);
  const scope = (q.get('scope') || 'sports').toLowerCase();
  S.scope = SCOPES.some((s) => s.key === scope) ? scope : 'sports';
  S.view = VIEWS[q.get('view')] ? q.get('view') : 'top';
  S.expanded = new Set((q.get('open') || '').split(',').filter(Boolean));
  const ev = q.get('event');
  if (ev) S.expanded.add(`*:${ev}`); // legacy link: any sport, this canonical event id
  S.focusMarket = q.get('market') || '';
  if (ev && S.view === 'top') S.view = 'all';
}
function writeUrl(push = true) {
  const q = new URLSearchParams();
  if (S.scope !== 'sports') q.set('scope', S.scope);
  if (S.view !== 'top') q.set('view', S.view);
  if (S.expanded.size) q.set('open', [...S.expanded].join(','));
  const url = `${location.pathname}${q.toString() ? `?${q}` : ''}`;
  if (url === `${location.pathname}${location.search}`) return;
  history[push ? 'pushState' : 'replaceState']({ compare: 1 }, '', url);
}
const isExpanded = (e) => S.expanded.has(e.key) || S.expanded.has(`*:${e.canonical_event_id}`);

// ---------------------------------------------------------------------------------------------------------
async function getJson(url, signal) {
  try {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { status: 0, body: null };
  }
}
const scopeLiveSports = () => (S.scope === 'nonsports' ? [] : S.scope === 'sports' ? SPORT_KEYS : [S.scope]);

async function loadMembership() {
  const r = await getJson('/api/membership');
  S.member = r.body; S.memberState = membershipState(r.status, r.body);
}
async function loadDesk(signal) {
  const r = await getJson(`/api/desk?scope=${encodeURIComponent(S.scope)}`, signal);
  S.deskStatus = r.status === 200 || (r.status === 502 && r.body?.lanes) ? 200 : r.status;
  if (r.body?.lanes) { S.desk = r.body; S.deskAt = Date.now(); }
  else if (r.status === 401 || r.status === 403) { S.desk = null; S.memberState = r.status === 401 ? 'anonymous' : 'forbidden'; render(); unmount(); return; }
  rebuild();
  await refreshDetails(signal);
  render();
}
async function loadLive(signal) {
  const sports = scopeLiveSports();
  if (!sports.length) { S.live = null; S.liveStatus = null; return; }
  const r = await getJson(`/api/live?sports=${sports.join(',')}`, signal);
  S.liveStatus = r.status;
  if (r.status === 200 && r.body) { S.live = r.body; S.liveAt = Date.now(); }
  else if (r.status === 401 || r.status === 403) { S.memberState = r.status === 401 ? 'anonymous' : 'forbidden'; render(); unmount(); return; }
  rebuild(); render();
}
async function loadDetail(e, signal) {
  const cur = S.detail.get(e.key) || {};
  S.detail.set(e.key, { ...cur, loading: true });
  let r;
  if (e.sport) r = await getJson(`/api/event?sport=${e.sport}&event=${encodeURIComponent(e.canonical_event_id)}`, signal);
  else {
    const c = e.contracts.find((x) => x.kalshi) || e.contracts[0];
    r = c ? await getJson(`/api/series?event=${encodeURIComponent(e.canonical_event_id)}&market=${encodeURIComponent(c.kalshi?.venue_market_id || c.id)}&hours=24`, signal) : { status: 404, body: null };
  }
  S.detail.set(e.key, { loading: false, status: r.status, body: r.body, at: Date.now() });
}
async function refreshDetails(signal) {
  const open = S.events.filter(isExpanded).slice(0, 4);
  await Promise.all(open.map((e) => loadDetail(e, signal)));
}

function rebuild() {
  const idx = scoreIndex(S.live?.items || []);
  S.events = rankEvents((S.desk?.events || []).map((e) => normalizeEvent(e, idx)));
}

// ---------------------------------------------------------------------------------------------------------
// Lifecycle: mount = (re)start both pollers for the current scope; unmount = stop everything.
let markets = null, scores = null;
function mount() {
  unmount();
  S.mounted = true;
  markets = life.poller('markets', { run: loadDesk, interval: () => MARKET_MS });
  markets.start();
  if (scopeLiveSports().length) {
    scores = life.poller('scores', { run: loadLive, interval: () => (S.events.some((e) => e.live) || (S.live?.live_count > 0) ? SCORE_LIVE_MS : SCORE_IDLE_MS) });
    scores.start();
  }
}
function unmount() { life.stopAll(); markets = scores = null; S.mounted = false; }
window.addEventListener('pagehide', unmount);
// Back/forward-cache restore (e.g. returning from Command Center): pollers were stopped on pagehide; remount once.
window.addEventListener('pageshow', (ev) => { if (ev.persisted && S.memberState === 'entitled' && !S.mounted) { readUrl(); mount(); } });

// ---------------------------------------------------------------------------------------------------------
// Rendering
const timeOf = (iso) => { const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''; const d = new Date(t); return (new Date().toDateString() === d.toDateString() ? 'Today ' : `${dayFmt.format(d)} · `) + timeFmt.format(d); };
const badge = (code, extra = '') => `<span class="badge b-${code.toLowerCase().replace('_', '-')}" title="${esc(BADGES[code] || '')}" tabindex="0">${esc(code.replace('_', ' '))}${extra}</span>`;

function renderChrome() {
  $('#views').innerHTML = Object.entries(VIEWS).map(([k, v]) => {
    const n = S.events.filter(v.filter).length;
    return `<button role="tab" type="button" data-view="${k}" aria-selected="${S.view === k}">${esc(v.label)}${S.desk ? `<i>${n}</i>` : ''}</button>`;
  }).join('');
  const laneState = new Map((S.desk?.lanes || []).map((l) => [l.lane, l.state]));
  $('#scopes').innerHTML = SCOPES.map((s) => {
    const st = laneState.get(s.key);
    const off = st === 'not_connected';
    return `<button type="button" data-scope="${s.key}" aria-pressed="${S.scope === s.key}" class="${off ? 'off' : ''}" title="${off ? 'Comparison lane not connected yet' : ''}">${esc(s.label)}${off ? '<small>not connected</small>' : ''}</button>`;
  }).join('');
}

function renderAccount() {
  const a = $('#acct'), st = S.memberState, mm = S.member?.membership || {};
  a.dataset.state = st;
  const map = {
    loading: ['Account', MEMBERS], entitled: [mm.state === 'owner' ? 'VERIFIED OWNER' : '◆ PLATINUM · All Access', MEMBERS],
    anonymous: ['Sign in', MEMBERS], forbidden: ['Get All Access', PRO], unverified: ['Access Check', '#'], network_error: ['Access Check', '#']
  };
  const [t, h] = map[st] || map.loading;
  a.textContent = t; a.href = h;
}

function renderHealth() {
  const dot = $('#hb-dot'), hb = $('#hb');
  const st = S.memberState;
  if (st !== 'entitled') { $('#lanes').innerHTML = ''; }
  if (st === 'loading') { hb.textContent = 'Checking access…'; dot.dataset.level = 'info'; return; }
  if (st !== 'entitled') { hb.textContent = st === 'unverified' || st === 'network_error' ? 'Access could not be verified · retrying' : 'All Access required'; dot.dataset.level = st === 'unverified' ? 'warn' : 'auth'; return; }
  const parts = [];
  parts.push(S.deskAt ? `Markets read ${ageText(new Date(S.deskAt).toISOString())} · every 60s` : 'Loading markets…');
  if (scopeLiveSports().length) parts.push(S.liveAt ? `Scores read ${ageText(new Date(S.liveAt).toISOString())} · every ${S.events.some((e) => e.live) ? 15 : 60}s` : (S.liveStatus && S.liveStatus !== 200 ? 'Score feed unavailable' : 'Loading scores…'));
  if (document.hidden) parts.push('paused while this tab is hidden');
  hb.textContent = parts.join('  ·  ');
  const bad = (S.desk?.lanes || []).some((l) => l.state === 'unavailable') || (S.liveStatus && S.liveStatus !== 200);
  dot.dataset.level = bad ? 'warn' : 'ok';
  const src = new Map((S.live?.sources || []).map((s) => [s.key, s]));
  $('#lanes').innerHTML = (S.desk?.lanes || []).map((l) => {
    const s = src.get(l.lane);
    const mk = l.state === 'ok' ? `${l.events}${l.capped ? '+' : ''} events` : l.state === 'not_connected' ? 'not connected' : 'unavailable';
    const sc = !s ? '' : s.state === 'ok' ? ` · scores ${s.count}` : ' · scores down';
    return `<span class="lane l-${l.state}${s && s.state !== 'ok' ? ' l-score-down' : ''}" title="${esc(`${l.lane.toUpperCase()} market lane: ${l.state}${l.upstream_status ? ` (HTTP ${l.upstream_status})` : ''}${s ? `; score feed ${s.state}${s.error ? ` (${s.error})` : ''}` : ''}`)}"><b>${esc(l.lane === 'nonsports' ? 'PREDICTION' : l.lane.toUpperCase())}</b>${esc(mk + sc)}</span>`;
  }).join('');
}

function renderNotices() {
  const list = S.memberState === 'entitled'
    ? screenNotices({ desk: S.desk, deskStatus: S.deskStatus, live: S.live, liveStatus: S.liveStatus, scope: S.scope, events: S.events })
    : [];
  $('#notices').innerHTML = list.map((n) => `<div class="notice n-${n.level}" data-code="${esc(n.code)}">${esc(n.text)}</div>`).join('');
}

function renderGate() {
  const g = $('#gate'), st = S.memberState;
  const show = st !== 'entitled' && st !== 'loading';
  g.hidden = !show;
  if (!show) return;
  const t = $('#gate-title'), p = $('#gate-text'), a = $('#gate-actions');
  if (st === 'anonymous') {
    t.textContent = 'One screen for the game, Kalshi, Polymarket and PropBetEdge.';
    p.textContent = 'Compare lines up venue prices on the same contract, shows how far apart they are, how fresh each quote is, and where the settlement rules differ. It is included with PropBetEdge All Access.';
    a.innerHTML = `<a class="btn primary" href="${PRO}">Get All Access</a><a class="btn" href="${MEMBERS}">Sign in at Members</a><small>Signed in elsewhere on PropBetEdge? Your session works here too; refresh after signing in.</small>`;
  } else if (st === 'forbidden') {
    t.textContent = 'Compare is part of All Access.';
    p.textContent = 'You are signed in, but this account does not include PropBetEdge All Access ($29/month: ten sports plus PropBetEdge Predictions and Compare).';
    a.innerHTML = `<a class="btn primary" href="${PRO}">Get All Access</a><a class="btn" href="${MEMBERS}">Use another account</a>`;
  } else {
    t.textContent = 'We could not verify your access.';
    p.textContent = 'The membership service did not answer. This is not a statement about your subscription. No comparison data is shown until access is verified.';
    a.innerHTML = '<button class="btn primary" type="button" data-retry>Check again</button>';
  }
}

function priceCell(v, { muted = false, tag = '' } = {}) {
  if (!v || v.mid_bp == null) return `<div class="px px-none"><span class="px-v">—</span><small>${v ? 'no two-sided quote' : 'not listed'}</small></div>`;
  const stale = v.freshness === 'stale';
  return `<div class="px${muted ? ' px-muted' : ''}${stale ? ' px-stale' : ''}">
    <div class="px-top"><span class="px-v">${fmtCents(v.yes_bp)}</span><span class="px-no">NO ${fmtCents(v.no_bp)}</span>${tag}</div>
    <div class="bar"><i style="width:${Math.max(0, Math.min(100, v.yes_bp / 100))}%"></i></div>
    <small>${v.bid_bp != null && v.ask_bp != null ? `${fmtCents(v.bid_bp)}–${fmtCents(v.ask_bp)} · ` : ''}${esc(ageText(v.observed_at) || '')}${stale ? ' · STALE' : v.freshness === 'delayed' ? ' · delayed' : ''}</small>
  </div>`;
}

function contractRow(c) {
  const k = c.kalshi;
  const pmRel = c.related.find((r) => r.venue === 'polymarket');
  const p = c.polymarket || c.listed.find((x) => x?.venue === 'polymarket') || null;
  const pCell = p ? priceCell(p) : pmRel ? priceCell(pmRel, { muted: true, tag: `<span class="mini">${pmRel.withdrawn ? 'WITHDRAWN' : 'RULES DIFFER'}</span>` }) : priceCell(null);
  const kCell = k ? priceCell(k) : (c.related.find((r) => r.venue === 'kalshi') ? priceCell(c.related.find((r) => r.venue === 'kalshi'), { muted: true }) : priceCell(null));
  let spread;
  if (c.gap_pts != null) spread = `<div class="sp${c.gap_pts >= 5 ? ' sp-hot' : c.gap_pts >= 2 ? ' sp-warm' : ''}"><b>${c.gap_pts.toFixed(1)}¢</b><small>${c.gap_rel_pct != null ? `${c.gap_rel_pct.toFixed(1)}% rel.` : ''}</small></div>`;
  else spread = `<div class="sp sp-none"><b>—</b><small>${c.note === 'NOT_ALIGNED' ? 'not aligned' : c.badge === 'SINGLE_VENUE' ? 'one venue' : 'not compared'}</small></div>`;
  const pbe = c.pbe
    ? `<div class="pbe"><b>${fmtPct(c.pbe.probability)}</b><small>${esc(c.pbe.state === 'FROZEN_AT_LOCK' ? 'frozen at lock' : (c.pbe.state || '').toLowerCase())}${c.pbe.issued_at ? ` · ${esc(timeFmt.format(new Date(c.pbe.issued_at)))}` : ''}</small></div>`
    : '<div class="pbe pbe-none"><small>No active PBE call</small></div>';
  return `<div class="ct${S.focusMarket && S.focusMarket === c.id ? ' ct-focus' : ''}">
    <div class="ct-label"><b>${esc(c.label || '—')}</b>${c.note === 'EXACT' ? '<small>exact rules</small>' : ''}</div>
    ${kCell}${pCell}${spread}${pbe}
  </div>`;
}

function scoreBlock(e) {
  const s = e.join.score;
  if (e.join.state === 'UNMATCHED') return `<span class="join j-unmatched" title="${esc(e.join.reason || BADGES.UNMATCHED)}" tabindex="0">SCORE UNMATCHED</span>`;
  if (!s || (s.status !== 'live' && s.status !== 'final' && !['suspended', 'delayed', 'postponed'].includes(s.status))) return '';
  const st = s.status === 'live' ? `<span class="st st-live">● ${esc(s.detail || s.status_label || 'LIVE')}</span>` : s.status === 'final' ? `<span class="st">${esc(s.status_label || 'FINAL')}</span>` : `<span class="st">${esc(s.status_label || '')}</span>`;
  const sc = s.score?.away && s.score?.home && (s.status === 'live' || s.status === 'final')
    ? `<span class="sc"><span>${esc(s.score.away.abbr)} <b>${esc(s.score.away.score ?? '—')}</b></span><span>${esc(s.score.home.abbr)} <b>${esc(s.score.home.score ?? '—')}</b></span></span>` : '';
  return `${sc}${st}<span class="upd">${esc(ageText(s.updated_at || S.live?.generated_at) ? `score ${ageText(s.updated_at || S.live?.generated_at)}` : '')}</span>`;
}

function deepLink(e) {
  const u = new URL('https://compare.propbetedge.ai/');
  if (S.scope !== 'sports') u.searchParams.set('scope', S.scope);
  u.searchParams.set('open', e.key);
  return u.toString();
}
function actions(e) {
  const k = e.contracts.map((c) => c.kalshi?.market_url).find(Boolean);
  const p = e.contracts.map((c) => c.polymarket?.market_url || c.related.find((r) => r.venue === 'polymarket')?.market_url).find(Boolean);
  const cast = e.join.score?.pbecast_url || e.join.score?.href || e.destination;
  const cmd = new URL(MEMBERS); cmd.searchParams.set('add', deepLink(e)); cmd.searchParams.set('title', `${e.title} · Compare`);
  return `<div class="acts">
    <button type="button" class="act" data-expand="${esc(e.key)}" aria-expanded="${isExpanded(e)}">${isExpanded(e) ? 'CLOSE' : 'MOVES & RULES'}</button>
    ${cast ? `<a class="act" href="${esc(cast)}">${e.join.score?.pbecast_url ? 'PBECAST ↗' : 'GAME PAGE ↗'}</a>` : ''}
    <a class="act" href="${esc(cmd.toString())}">+ COMMAND CENTER</a>
    ${k ? `<a class="act ext" href="${esc(k)}" target="_blank" rel="noopener nofollow">KALSHI ↗</a>` : ''}
    ${p ? `<a class="act ext" href="${esc(p)}" target="_blank" rel="noopener nofollow">POLYMARKET ↗</a>` : ''}
  </div>`;
}

function spark(series, now) {
  const all = series.flatMap((s) => s.points.map((p) => [Date.parse(p.t), p.v])).filter(([t]) => t >= now - 86400e3);
  if (all.length < 2) return '';
  const t0 = Math.max(now - 86400e3, Math.min(...all.map((p) => p[0]))), t1 = now;
  const vs = all.map((p) => p[1]); const lo = Math.max(0, Math.min(...vs) - 300), hi = Math.min(10000, Math.max(...vs) + 300);
  const W = 1200, H = 150, x = (t) => 8 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 16), y = (v) => 8 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - 28);
  const path = (pts) => { const ps = pts.filter(([t]) => t >= t0); if (!ps.length) return ''; return ps.map(([t, v], i) => `${i ? 'H' + x(t).toFixed(1) + ' V' : 'M' + x(t).toFixed(1) + ','}${y(v).toFixed(1)}`).join(' ') + ` H${x(t1).toFixed(1)}`; };
  const lines = series.map((s) => `<path d="${path(s.points.map((p) => [Date.parse(p.t), p.v]).sort((a, b) => a[0] - b[0]))}" class="ln ln-${s.key}"/>`).join('');
  return `<figure class="spark-fig"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark" role="img" aria-label="Stored observations, last 24 hours, ${(lo / 100).toFixed(0)} to ${(hi / 100).toFixed(0)} cents">${lines}</svg>
    <figcaption><span>${esc(timeOf(new Date(t0).toISOString()))}</span><span>range ${(lo / 100).toFixed(0)}–${(hi / 100).toFixed(0)}¢</span><span>now</span></figcaption></figure>`;
}

function whyDiffer(e) {
  const items = [];
  for (const c of e.contracts) {
    if (c.comparison?.disclosure) items.push(`<li><b>${esc(c.label)}</b>: compared as <em>${esc(c.comparison.match_class === 'EXACT_MATCH' ? 'exact match' : 'comparable')}</em>. ${esc(c.comparison.disclosure)}.</li>`);
    for (const r of c.related) {
      const codes = (r.reasons || []).map((x) => reasonText(x)).filter(Boolean);
      items.push(`<li><b>${esc(c.label)}</b> · ${esc(r.venue)} ${r.title ? `“${esc(r.title)}”` : ''}: <em>${esc((r.match || '').replace(/_/g, ' ').toLowerCase())}</em>. ${esc(r.reason || '')}${codes.length ? `<ul>${codes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${r.summary ? `<p class="small">${esc(typeof r.summary === 'string' ? r.summary : JSON.stringify(r.summary))}</p>` : ''}</li>`);
    }
    if (c.note === 'NOT_ALIGNED') items.push(`<li><b>${esc(c.label)}</b>: ${esc(BADGES.NOT_ALIGNED)}</li>`);
  }
  if (!items.length) items.push(`<li>${esc(e.badge === 'SINGLE_VENUE' ? BADGES.SINGLE_VENUE : 'Both venues are compared under approved rules with no recorded exceptions.')}</li>`);
  return `<details class="why"${e.badge !== 'COMPARABLE' ? ' open' : ''}><summary>Why these differ</summary><ul>${items.join('')}</ul><p class="small">Badges: ${['COMPARABLE', 'RULE_MISMATCH', 'WITHDRAWN', 'SINGLE_VENUE', 'UNMATCHED'].map((b) => `<b>${b.replace('_', ' ')}</b> ${esc(BADGES[b])}`).join(' ')}</p></details>`;
}

function detailPanel(e) {
  const d = S.detail.get(e.key);
  if (!d || (d.loading && !d.body)) return '<div class="detail"><p class="muted">Loading stored observations…</p></div>';
  const now = Date.now();
  let body = '';
  if (e.sport) {
    if (d.status !== 200 || !d.body) body = `<p class="muted">Observed history is unavailable right now (HTTP ${d.status || 'network'}). Prices above remain current.</p>`;
    else {
      const rows = d.body.contracts.map((c) => {
        const km = moves(c.kalshi?.points, now), pm = moves(c.polymarket?.points, now);
        const vol = c.kalshi ? [c.kalshi.volume_24h != null ? `24h vol ${Math.round(c.kalshi.volume_24h).toLocaleString()}` : null, c.kalshi.open_interest != null ? `OI ${Math.round(c.kalshi.open_interest).toLocaleString()}` : null].filter(Boolean).join(' · ') : '';
        return `<div class="mv-block"><h4>${esc(c.label)}</h4>
          <table class="mv"><thead><tr><th></th>${WINDOWS.map((w) => `<th>${w.key}</th>`).join('')}</tr></thead><tbody>
          <tr><th>Kalshi</th>${WINDOWS.map((w) => `<td class="${km[w.key]?.delta_bp > 0 ? 'up' : km[w.key]?.delta_bp < 0 ? 'dn' : ''}">${c.kalshi?.points?.length ? esc(fmtMove(km[w.key]).replace('Not enough observations', '—')) : '—'}</td>`).join('')}</tr>
          <tr><th>Polymarket</th>${WINDOWS.map((w) => `<td class="${pm[w.key]?.delta_bp > 0 ? 'up' : pm[w.key]?.delta_bp < 0 ? 'dn' : ''}">${c.polymarket?.points?.length ? esc(fmtMove(pm[w.key]).replace('Not enough observations', '—')) : '—'}</td>`).join('')}</tr>
          </tbody></table>
          ${vol ? `<p class="small">Kalshi ${esc(vol)}</p>` : ''}
          ${spark([{ key: 'k', points: c.kalshi?.points || [] }, { key: 'p', points: c.polymarket?.points || [] }], now)}
        </div>`;
      }).join('');
      body = `${rows}<p class="small legend"><i class="lg lg-k"></i>Kalshi <i class="lg lg-p"></i>Polymarket · Stored observations only, drawn as steps (a value holds until the next stored change). “—” = not enough observations for that window, never zero.</p>`;
    }
  } else if (d.status === 200 && d.body?.series) {
    const sers = d.body.series.map((s) => ({ key: s.source === 'kalshi' ? 'k' : s.source === 'polymarket' ? 'p' : 'b', label: s.label, points: (s.segments || []).flat().map((p) => ({ t: p.t, v: p.v })) }));
    body = `<table class="mv"><thead><tr><th></th>${WINDOWS.map((w) => `<th>${w.key}</th>`).join('')}</tr></thead><tbody>${sers.map((s) => { const m = moves(s.points, now); return `<tr><th>${esc(s.label)}</th>${WINDOWS.map((w) => `<td>${esc(fmtMove(m[w.key]).replace('Not enough observations', '—'))}</td>`).join('')}</tr>`; }).join('')}</tbody></table>${spark(sers, now)}`;
  } else body = `<p class="muted">${d.status === 404 ? 'No stored observation series for this contract yet.' : `Observed history is unavailable right now (HTTP ${d.status || 'network'}).`}</p>`;
  return `<div class="detail">${body}${whyDiffer(e)}<p class="small muted">History read ${esc(ageText(new Date(d.at).toISOString()) || '')}.</p></div>`;
}

function card(e) {
  return `<article class="card tier-${e.tier}${e.live ? ' is-live' : ''}" id="ev-${esc(e.key.replace(/[^a-zA-Z0-9]/g, '-'))}">
    <header class="card-h">
      <span class="sport">${esc(e.sport ? e.sport.toUpperCase() : 'PREDICTION')}</span>
      <span class="when">${esc(e.status === 'live' ? '' : timeOf(e.start_at))}</span>
      ${scoreBlock(e)}
      <span class="sp-flex"></span>
      ${badge(e.badge, e.badge_note === 'NOT_ALIGNED' ? ' · NOT ALIGNED' : '')}
    </header>
    <h3>${esc(e.title)}</h3>
    <div class="ct ct-head" aria-hidden="true"><span></span><span>KALSHI · YES</span><span>POLYMARKET · YES</span><span>SPREAD</span><span>PBE</span></div>
    ${e.contracts.map(contractRow).join('')}
    ${actions(e)}
    ${isExpanded(e) ? detailPanel(e) : ''}
  </article>`;
}

function liveCard(e) {
  const s = e.join.score;
  const lines = e.contracts.slice(0, 2).map((c) => {
    const k = c.kalshi, rel = !c.polymarket && c.related.find((r) => r.venue === 'polymarket'), p = c.polymarket || rel;
    return `<div class="lc-row"><b>${esc(c.label)}</b>
      <span class="lc-bar k"><i style="width:${k?.mid_bp != null ? k.mid_bp / 100 : 0}%"></i><em>K ${fmtCents(k?.mid_bp)}</em></span>
      <span class="lc-bar p${rel ? ' rel' : ''}"${rel ? ` title="${esc(BADGES.RULE_MISMATCH)}"` : ''}><i style="width:${p?.mid_bp != null ? p.mid_bp / 100 : 0}%"></i><em>P ${fmtCents(p?.mid_bp)}${rel ? '*' : ''}</em></span>
      <span class="lc-gap">${c.gap_pts != null ? `${c.gap_pts.toFixed(1)}¢` : '—'}</span></div>`;
  }).join('');
  const relNote = e.contracts.some((c) => !c.polymarket && c.related.some((r) => r.venue === 'polymarket')) ? '<small class="lc-rel">* Polymarket rules differ · not compared</small>' : '';
  return `<button type="button" class="lc" data-jump="${esc(e.key)}">
    <div class="lc-h"><span class="sport">${esc(e.sport.toUpperCase())}</span><span class="st st-live">● ${esc(s?.detail || s?.status_label || 'LIVE')}</span></div>
    <div class="lc-score"><span>${esc(s?.score?.away?.abbr || '')}</span><b>${esc(s?.score?.away?.score ?? '—')}</b><span>${esc(s?.score?.home?.abbr || '')}</span><b>${esc(s?.score?.home?.score ?? '—')}</b></div>
    ${lines}${relNote}
    <small>${esc(['score ' + (ageText(s?.updated_at || S.live?.generated_at) || ''), e.freshest_at ? 'market ' + ageText(e.freshest_at) : ''].filter(Boolean).join(' · '))}</small>
  </button>`;
}

function renderLive() {
  const sec = $('#live');
  const linked = S.events.filter((e) => e.live);
  const liveItems = (S.live?.items || []).filter((x) => x.status === 'live');
  const linkedIds = new Set(linked.map((e) => `${e.sport}:${e.canonical_event_id}`));
  const unlinked = liveItems.filter((x) => !linkedIds.has(`${x.sport}:${x.source_id}`));
  sec.hidden = S.memberState !== 'entitled' || (!linked.length && !unlinked.length);
  if (sec.hidden) return;
  $('#live-meta').textContent = `${liveItems.length} live · ${linked.length} with linked markets`;
  $('#live-cards').innerHTML = linked.map(liveCard).join('') + unlinked.slice(0, 8).map((x) => `<a class="lc lc-plain" href="${esc(x.pbecast_url || x.href || '#')}">
    <div class="lc-h"><span class="sport">${esc(x.sport.toUpperCase())}</span><span class="st st-live">● ${esc(x.detail || x.status_label || 'LIVE')}</span></div>
    <div class="lc-score">${x.score?.away ? `<span>${esc(x.score.away.abbr)}</span><b>${esc(x.score.away.score ?? '—')}</b><span>${esc(x.score.home.abbr)}</span><b>${esc(x.score.home.score ?? '—')}</b>` : `<span>${esc(x.title)}</span>`}</div>
    <small>${esc(ID_NOTE(x))}</small></a>`).join('');
}
const ID_NOTE = (x) => (['nfl', 'nba', 'mlb', 'nhl'].includes(x.sport) ? 'No comparison market linked to this game' : 'Score shown separately · market link UNMATCHED');

function renderBoard() {
  const sec = $('#board');
  sec.hidden = S.memberState !== 'entitled';
  if (sec.hidden) return;
  const v = VIEWS[S.view];
  $('#board-title').textContent = v.label;
  const rows = S.events.filter(v.filter);
  const box = $('#cards');
  // Hold the skeleton until the first score answer (or failure) too, so the LIVE rail never pushes the board.
  const scoresPending = scopeLiveSports().length && S.liveStatus === null;
  if (!S.desk || scoresPending) {
    box.innerHTML = S.deskStatus === 'loading' || (S.desk && scoresPending) ?Array.from({ length: 4 }, () => '<div class="card skel" aria-hidden="true"></div>').join('') : '<div class="empty">The market desk did not answer. See the status above; retrying automatically.</div>';
    $('#board-meta').textContent = '';
    return;
  }
  const empty = boardEmpty({ desk: S.desk, viewKey: S.view, events: rows, scope: S.scope, liveItems: S.live?.items || [] });
  $('#board-meta').textContent = `${rows.length} event${rows.length === 1 ? '' : 's'} · ranked by valid Kalshi ↔ Polymarket spread; stale, final and unmatched demoted`;
  box.innerHTML = rows.length ? rows.map(card).join('') : `<div class="empty${empty?.failure ? ' empty-fail' : ''}"><b>${esc(empty?.text || 'Nothing in this view.')}</b>${S.view !== 'all' && !empty?.failure && empty?.code !== 'not_connected' ? '<button type="button" class="act" data-view="all">SHOW ALL MARKETS</button>' : ''}${upcomingHint()}</div>`;
}
function upcomingHint() {
  const up = (S.live?.items || []).filter((x) => x.status === 'scheduled').slice(0, 6);
  return up.length ? `<div class="next"><small>NEXT GAMES</small>${up.map((x) => `<span>${esc(x.sport.toUpperCase())} ${esc(x.title)} · ${esc(timeOf(x.starts_at))}</span>`).join('')}</div>` : '';
}

function render() {
  renderAccount(); renderChrome(); renderHealth(); renderNotices(); renderGate(); renderLive(); renderBoard();
}

// ---------------------------------------------------------------------------------------------------------
// Events (delegated once; never re-bound per render)
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-view],[data-scope],[data-expand],[data-jump],[data-retry],#acct');
  if (!t) return;
  if (t.matches('#acct') && (S.memberState === 'unverified' || S.memberState === 'network_error')) { ev.preventDefault(); boot(); return; }
  if (t.dataset.retry !== undefined && t.matches('[data-retry]')) { boot(); return; }
  if (t.dataset.view) { S.view = t.dataset.view; writeUrl(); render(); return; }
  if (t.dataset.scope) { if (S.scope === t.dataset.scope) return; S.scope = t.dataset.scope; S.view = 'top'; S.expanded.clear(); S.desk = null; S.live = null; S.deskStatus = 'loading'; S.liveStatus = null; S.deskAt = S.liveAt = 0; S.events = []; writeUrl(); render(); mount(); return; }
  if (t.dataset.expand) {
    const key = t.dataset.expand;
    const e = S.events.find((x) => x.key === key);
    if (!e) return;
    if (isExpanded(e)) { S.expanded.delete(key); S.expanded.delete(`*:${e.canonical_event_id}`); render(); writeUrl(); return; }
    S.expanded.add(key); writeUrl(); render();
    loadDetail(e).then(render, () => {});
    return;
  }
  if (t.dataset.jump) {
    const e = S.events.find((x) => x.key === t.dataset.jump);
    if (!e) return;
    if (!VIEWS[S.view].filter(e)) S.view = 'live';
    S.expanded.add(e.key); writeUrl(); render(); loadDetail(e).then(render, () => {});
    requestAnimationFrame(() => document.getElementById(`ev-${e.key.replace(/[^a-zA-Z0-9]/g, '-')}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
});
window.addEventListener('popstate', () => {
  const prevScope = S.scope;
  readUrl();
  if (S.memberState !== 'entitled') { render(); return; }
  if (S.scope !== prevScope) { S.desk = null; S.live = null; S.deskStatus = 'loading'; S.events = []; render(); mount(); }
  else { render(); refreshDetails().then(render, () => {}); }
});
// Health line ages tick without network: one render per 15 s while visible (no fetch).
let ageTimer = 0;
function ageTick() { clearTimeout(ageTimer); if (document.hidden) return; ageTimer = setTimeout(() => { renderHealth(); ageTick(); }, 15e3); }
document.addEventListener('visibilitychange', () => { renderHealth(); ageTick(); });

async function boot() {
  unmount();
  readUrl();
  S.memberState = 'loading'; render();
  await loadMembership();
  render();
  if (S.memberState === 'entitled') mount();
  ageTick();
}
boot();
