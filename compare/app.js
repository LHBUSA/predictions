// PropBetEdge Compare — member surface (hubs). Data truth lives in core.js; lifecycle in poller.js.
//   ALL SPORTS  = overview hub: live rail, biggest spreads, one section per sport (top tiles + OPEN HUB)
//   <sport>     = sport hub: stats, date tabs, view chips, paged tile grid
//   any tile    = detail drawer (board stays put; ?open=<key>, back/forward closes it)
import {
  SPORTS, SPORT_KEYS, BADGES, VIEWS, WHEN, reasonText, fmtCents, fmtPct, ageText, normalizeEvent, rankEvents, scoreIndex,
  moves, fmtMove, WINDOWS, membershipState, screenNotices, boardEmpty, participantMedia, whenOf, inWhen, hubStats,
  CROSS_TOOLTIP, ruleTermsView, ruleTermsSummary, keyDifferences
} from './core.js';
import { createLifecycle } from './poller.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PRO = 'https://propbetedge.ai/pro';
const MEMBERS = 'https://members.propbetedge.ai/';
const MARKET_MS = 60e3, SCORE_LIVE_MS = 15e3, SCORE_IDLE_MS = 60e3, PAGE = 12;
const SCOPES = [{ key: 'sports', label: 'ALL SPORTS' }, ...SPORTS.map((s) => ({ key: s.key, label: s.label.toUpperCase() })), { key: 'nonsports', label: 'PREDICTIONS' }];
const LABEL = Object.fromEntries(SCOPES.map((s) => [s.key, s.label]));
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const VENUE = { kalshi: { name: 'Kalshi', icon: '/assets/kalshi.png' }, polymarket: { name: 'Polymarket', icon: '/assets/polymarket.png' } };

const life = createLifecycle({ doc: document });
window.__compareLedger = life.ledger;

const S = {
  scope: 'sports', view: 'top', when: 'all', page: 1, open: '', focusMarket: '',
  member: null, memberState: 'loading',
  desk: null, deskStatus: 'loading', deskAt: 0,
  live: null, liveStatus: null, liveAt: 0,
  events: [], detail: new Map(), mounted: false
};

// ---------------------------------------------------------------------------------------------------------
// URL state (back/forward safe). Legacy links (?scope=nhl&event=<id>&market=<contract id>, ?open=a,b) still open.
function readUrl() {
  const q = new URLSearchParams(location.search);
  const scope = (q.get('scope') || 'sports').toLowerCase();
  S.scope = SCOPES.some((s) => s.key === scope) ? scope : 'sports';
  S.view = VIEWS[q.get('view')] ? q.get('view') : 'top';
  S.when = WHEN.some((w) => w.key === q.get('when')) ? q.get('when') : 'all';
  S.page = Math.max(1, Math.min(50, Number(q.get('page')) || 1));
  const ev = q.get('event');
  S.open = (q.get('open') || '').split(',')[0] || (ev ? `*:${ev}` : '');
  S.focusMarket = q.get('market') || '';
}
function writeUrl(push = true) {
  const q = new URLSearchParams();
  if (S.scope !== 'sports') q.set('scope', S.scope);
  if (S.view !== 'top') q.set('view', S.view);
  if (S.when !== 'all') q.set('when', S.when);
  if (S.page > 1) q.set('page', String(S.page));
  if (S.open) q.set('open', S.open);
  const url = `${location.pathname}${q.toString() ? `?${q}` : ''}`;
  if (url === `${location.pathname}${location.search}`) return;
  history[push ? 'pushState' : 'replaceState']({ compare: 1 }, '', url);
}
const isOpen = (e) => !!S.open && (S.open === e.key || S.open === `*:${e.canonical_event_id}`);
const openEvent = () => S.events.find(isOpen) || null;

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
  const e = openEvent();
  if (e) await loadDetail(e, signal);
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

function rebuild() {
  const idx = scoreIndex(S.live?.items || []);
  S.events = rankEvents((S.desk?.events || []).map((e) => normalizeEvent(e, idx)));
}

// ---------------------------------------------------------------------------------------------------------
// Lifecycle: mount = (re)start both pollers for the current scope; unmount = stop everything.
function mount() {
  unmount();
  S.mounted = true;
  life.poller('markets', { run: loadDesk, interval: () => MARKET_MS }).start();
  if (scopeLiveSports().length) {
    life.poller('scores', { run: loadLive, interval: () => (S.events.some((e) => e.live) || (S.live?.live_count > 0) ? SCORE_LIVE_MS : SCORE_IDLE_MS) }).start();
  }
}
function unmount() { life.stopAll(); stopMarquee(); S.mounted = false; }
window.addEventListener('pagehide', unmount);
// Back/forward-cache restore (e.g. returning from Command Center): pollers were stopped on pagehide; remount once.
window.addEventListener('pageshow', (ev) => { if (ev.persisted && S.memberState === 'entitled' && !S.mounted) { readUrl(); mount(); } });

// ---------------------------------------------------------------------------------------------------------
// Small render helpers
const timeOf = (iso) => { const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''; const d = new Date(t); return (new Date().toDateString() === d.toDateString() ? 'Today ' : `${dayFmt.format(d)} · `) + timeFmt.format(d); };
const badge = (code, extra = '') => `<span class="badge b-${code.toLowerCase().replace('_', '-')}" title="${esc(BADGES[code] || '')}">${esc(code.replace('_', ' '))}${extra}</span>`;
const venueHead = (v) => `<span class="vh" title="${VENUE[v].name} YES price"><img src="${VENUE[v].icon}" alt="" width="14" height="14">${v === 'polymarket' ? 'POLY' : 'KALSHI'}</span>`;
function sideFor(e, c) {
  const s = e.join.score?.score;
  if (!s) return null;
  if (c.role === 'away' || c.role === 'home') return s[c.role] || null;
  return [s.away, s.home].find((x) => x && String(x.abbr).toUpperCase() === String(c.label).toUpperCase()) || null;
}
function avatar(e, c, size = 'md') {
  const m = participantMedia(e.sport, c, sideFor(e, c));
  const inner = m.src ? `<img src="${esc(m.src)}" alt="" loading="lazy" decoding="async" data-initials="${esc(m.initials)}">` : `<i>${esc(m.initials)}</i>`;
  return `<span class="av av-${m.kind} av-${size}" aria-hidden="true">${inner}</span>`;
}
// A broken logo/photo becomes initials (one capture listener for every image, registered once).
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img?.tagName === 'IMG' && img.dataset.initials !== undefined) { const i = document.createElement('i'); i.textContent = img.dataset.initials; img.replaceWith(i); }
}, true);

function statusChip(e) {
  const s = e.join.score;
  if (e.join.state === 'UNMATCHED') return `<span class="join" title="${esc(e.join.reason || BADGES.UNMATCHED)}">SCORE UNMATCHED</span>`;
  if (s?.status === 'live') return `<span class="st st-live"><i></i>${esc(s.detail || s.status_label || 'LIVE')}</span>`;
  if (s?.status === 'final') return `<span class="st">${esc(s.status_label || 'FINAL')}</span>`;
  if (s && ['suspended', 'delayed', 'postponed'].includes(s.status)) return `<span class="st st-warn">${esc(s.status_label || s.status.toUpperCase())}</span>`;
  return `<span class="when">${esc(timeOf(e.start_at))}</span>`;
}
const scoreOf = (e, c) => { const side = sideFor(e, c); const st = e.join.score?.status; return side && (st === 'live' || st === 'final') && side.score != null ? `<b class="pts">${esc(side.score)}</b>` : ''; };
const pmFor = (c) => c.polymarket || c.related.find((r) => r.venue === 'polymarket') || c.listed.find((x) => x?.venue === 'polymarket') || null;
function px(v, { rel = false, small = false } = {}) {
  if (!v || v.mid_bp == null) return `<span class="px px-none">—</span>`;
  const cls = ['px', rel ? 'px-rel' : '', v.freshness === 'stale' ? 'px-stale' : ''].join(' ');
  return `<span class="${cls}" title="${esc(`${rel ? 'Rules differ: not compared. ' : ''}YES ${fmtCents(v.yes_bp)} · NO ${fmtCents(v.no_bp)}${v.bid_bp != null ? ` · bid/ask ${fmtCents(v.bid_bp)}–${fmtCents(v.ask_bp)}` : ''} · observed ${ageText(v.observed_at) || '?'}`)}"><b>${fmtCents(v.yes_bp)}</b>${small ? '' : `<small>NO ${fmtCents(v.no_bp)}</small>`}</span>`;
}
// MID GAP = informational market disagreement (mid vs mid). The TOP-OF-BOOK CROSS is a separate, differently styled
// line so a 3¢ mid gap can never read as a 3¢ executable price. RULE_MISMATCH / single venue: neither.
function crossLine(c) {
  if (!c.cross) return '';
  if (c.cross.state === 'CROSS') return `<small class="xc on" title="${esc(CROSS_TOOLTIP)}">CROSS +${(c.cross.bp / 100).toFixed(1)}¢</small>`;
  return `<small class="xc" title="${esc(CROSS_TOOLTIP)}">${c.cross.state === 'NO_BOOK' ? 'NO BOOK' : 'NO CROSS'}</small>`;
}
function gapCell(c) {
  if (c.gap_pts != null) return `<span class="gap${c.gap_pts >= 5 ? ' hot' : c.gap_pts >= 2 ? ' warm' : ''}" title="Mid-price gap: market disagreement between the two mids. Not an executable price."><b>${c.gap_pts.toFixed(1)}¢</b>${crossLine(c)}</span>`;
  return `<span class="gap none"><b>—</b><small>${c.note === 'NOT_ALIGNED' ? 'not aligned' : c.badge === 'SINGLE_VENUE' ? 'one venue' : 'not compared'}</small></span>`;
}
function badgeFor(e) {
  const disc = e.contracts.map((c) => c.comparison?.disclosure || c.polymarket?.disclosure).find(Boolean);
  const tip = e.badge === 'RULE_MISMATCH' ? (e.contracts.map((c) => ruleTermsSummary(c.rule_terms)).find(Boolean) || BADGES.RULE_MISMATCH) : e.badge === 'COMPARABLE' && disc ? `${BADGES.COMPARABLE} ${disc}` : BADGES[e.badge] || '';
  return `<span class="badge b-${e.badge.toLowerCase().replace('_', '-')}" title="${esc(tip)}">${esc(e.badge.replace('_', ' '))}${e.badge_note === 'NOT_ALIGNED' ? ' · NOT ALIGNED' : ''}</span>`;
}
function freshLine(e) {
  const ages = [];
  const k = e.contracts.map((c) => c.kalshi?.observed_at).filter(Boolean).sort().at(-1);
  const p = e.contracts.map((c) => pmFor(c)?.observed_at).filter(Boolean).sort().at(-1);
  if (k) ages.push(`K ${ageText(k)}`);
  if (p) ages.push(`P ${ageText(p)}`);
  return ages.join(' · ');
}
function pbeLine(e) {
  const c = e.contracts.find((x) => x.pbe);
  return c ? `<span class="pbe-chip" title="PropBetEdge probability (${esc((c.pbe.state || '').toLowerCase())})">PBE ${esc(c.label)} ${fmtPct(c.pbe.probability)}</span>` : '<span class="pbe-none">No active PBE call</span>';
}

// ---------------------------------------------------------------------------------------------------------
// Tile (compact market card, Kalshi-style grid). Whole tile opens the drawer.
// 3-way (soccer 90-minute result): one market with three outcomes; each venue's book sum shown as its own number.
const BOOK_TIP = 'Book sum: the three outcome YES mids on one venue added up. 100¢ means the three prices are internally consistent; it is not a probability and never compares venues.';
const threeWayChip = (e) => (e.three_way ? '<span class="tw" title="One market, three outcomes: home win, draw, away win after 90 minutes plus stoppage time (no extra time or penalties).">3-WAY · 90 MIN</span>' : '');
function bookLine(e) {
  const b = e.three_way.book;
  const v = (k, n) => (b[k] ? `${n} ${fmtCents(b[k].sum_bp)}` : `${n} —`);
  return `<span class="bk" title="${esc(BOOK_TIP)}">BOOK ${v('kalshi', 'K')} · ${v('polymarket', 'P')}</span>`;
}
function distribution(e) {
  if (!e.three_way) return '';
  const names = ['home', 'draw', 'away'].map((r) => e.contracts.find((c) => c.role === r)?.label || r);
  const bar = (venue, label) => {
    const b = e.three_way.book[venue];
    if (!b) return `<div class="dist"><span class="dist-h"><img src="${VENUE[venue].icon}" alt="" width="14" height="14">${label}</span><span class="dist-none">Not all three outcomes priced</span></div>`;
    return `<div class="dist"><span class="dist-h"><img src="${VENUE[venue].icon}" alt="" width="14" height="14">${label}<em title="${esc(BOOK_TIP)}">book ${fmtCents(b.sum_bp)}</em></span><span class="dist-bar">${b.mids_bp.map((m, i) => `<i class="seg s${i}" style="flex:${Math.max(1, m)}" title="${esc(names[i])} ${fmtCents(m)}"><b>${esc(['H', 'D', 'A'][i])} ${fmtCents(m)}</b></i>`).join('')}</span></div>`;
  };
  return `<section class="dists" aria-label="Three-outcome price distribution per venue"><p class="small">${esc(names.join(' · '))}: each venue's own three prices. ${e.badge === 'COMPARABLE' ? '' : 'Rules differ: shown side by side, never compared.'}</p>${bar('kalshi', 'Kalshi')}${bar('polymarket', 'Polymarket')}</section>`;
}
const fieldChip = (e) => (e.field ? `<span class="tw" title="Tournament winner: one market per golfer. Top golfers by venue price shown; open for the full field.">FIELD · ${e.field.n}</span>` : '');
function tile(e) {
  const rows = e.contracts.slice(0, e.field ? 5 : 3).map((c) => {
    const p = pmFor(c), rel = !c.polymarket && !!p;
    return `<div class="tr"><span class="who">${avatar(e, c)}<span class="nm">${esc(c.label || '—')}</span>${scoreOf(e, c)}</span>${px(c.kalshi, { small: true })}${px(p, { rel, small: true })}${e.field ? '<span></span>' : gapCell(c)}</div>`;
  }).join('');
  return `<button type="button" class="tile tier-${e.tier}${e.live ? ' is-live' : ''}${isOpen(e) ? ' is-open' : ''}" data-open="${esc(e.key)}" aria-label="${esc(`${e.title}: open details`)}">
    <span class="th"><span class="sport">${esc(e.sport ? e.sport.toUpperCase() : 'PREDICTION')}</span>${statusChip(e)}${threeWayChip(e)}${fieldChip(e)}<span class="flex"></span>${badgeFor(e)}</span>
    <span class="tt">${esc(e.title)}</span>
    <span class="tg"><span class="tr thd"><span></span>${venueHead('kalshi')}${venueHead('polymarket')}${e.field ? '<span></span>' : '<span class="vh" title="Mid-price gap (informational). The CROSS line is the top-of-book executable cross.">MID GAP</span>'}</span>${rows}</span>
    <span class="tf">${e.three_way ? `${e.has_pbe ? pbeLine(e) : ''}${bookLine(e)}` : pbeLine(e)}<span class="flex"></span><span class="age">${esc(freshLine(e))}</span></span>
  </button>`;
}
const tiles = (list) => `<div class="tiles">${list.map(tile).join('')}</div>`;

// ---------------------------------------------------------------------------------------------------------
// Chrome: account chip, hub nav, health, notices, gate
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
function renderNav() {
  const lane = new Map((S.desk?.lanes || []).map((l) => [l.lane, l]));
  const counts = new Map();
  if (S.scope === 'sports') for (const e of S.events) if (e.active) counts.set(e.sport, (counts.get(e.sport) || 0) + 1);
  $('#hubs').innerHTML = SCOPES.map((s) => {
    const l = lane.get(s.key), off = l?.state === 'not_connected';
    const n = s.key === 'sports' ? S.events.filter((e) => e.active).length : counts.get(s.key);
    const live = s.key !== 'sports' && S.events.some((e) => e.sport === s.key && e.live);
    return `<button type="button" role="tab" data-scope="${s.key}" aria-selected="${S.scope === s.key}" class="${off ? 'off' : ''}"${off ? ' title="Comparison lane not connected yet"' : ''}>${live ? '<i class="dot-live"></i>' : ''}${esc(s.label)}${n ? `<em>${n}</em>` : off ? '<small>SOON</small>' : ''}</button>`;
  }).join('');
}
function renderHealth() {
  const dot = $('#hb-dot'), hb = $('#hb'), st = S.memberState;
  if (st === 'loading') { hb.textContent = 'Checking access…'; dot.dataset.level = 'info'; return; }
  if (st !== 'entitled') { hb.textContent = st === 'unverified' || st === 'network_error' ? 'Access could not be verified · retrying' : 'All Access required'; dot.dataset.level = st === 'unverified' ? 'warn' : 'auth'; return; }
  const parts = [S.deskAt ? `Markets read ${ageText(new Date(S.deskAt).toISOString())} · every 60s` : 'Loading markets…'];
  if (scopeLiveSports().length) {
    const src = S.live?.sources || [], okN = src.filter((x) => x.state === 'ok').length;
    if (S.liveStatus && S.liveStatus !== 200) parts.push('Score feed unavailable');
    else if (!S.liveAt) parts.push('Loading scores…');
    else if (src.length && !okN) parts.push('Score sources unavailable');
    else parts.push(`Scores read ${ageText(new Date(S.liveAt).toISOString())} · every ${S.events.some((e) => e.live) ? 15 : 60}s${okN < src.length ? ` · ${src.length - okN} of ${src.length} sources down` : ''}`);
  }
  if (document.hidden) parts.push('paused while hidden');
  hb.textContent = parts.join('  ·  ');
  dot.dataset.level = (S.desk?.lanes || []).some((l) => l.state === 'unavailable') || (S.liveStatus && S.liveStatus !== 200) || (S.live?.sources || []).some((x) => x.state !== 'ok') ? 'warn' : 'ok';
}
function renderNotices() {
  const list = S.memberState === 'entitled' ? screenNotices({ desk: S.desk, deskStatus: S.deskStatus, live: S.live, liveStatus: S.liveStatus, scope: S.scope, events: S.events }) : [];
  $('#notices').innerHTML = list.filter((n) => n.code !== 'loading').map((n) => `<div class="notice n-${n.level}" data-code="${esc(n.code)}">${esc(n.text)}</div>`).join('');
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

// ---------------------------------------------------------------------------------------------------------
// Live rail (any scope with live games)
function liveCard(e) {
  const s = e.join.score;
  const lines = e.contracts.slice(0, 2).map((c) => {
    const k = c.kalshi, p = pmFor(c), rel = !c.polymarket && !!p;
    return `<span class="lc-row">${avatar(e, c, 'sm')}<b>${esc(c.label)}</b>${scoreOf(e, c)}
      <span class="lc-bar k"><i style="width:${k?.mid_bp != null ? k.mid_bp / 100 : 0}%"></i><em><img src="${VENUE.kalshi.icon}" alt="" width="10" height="10">${fmtCents(k?.mid_bp)}</em></span>
      <span class="lc-bar p${rel ? ' rel' : ''}"><i style="width:${p?.mid_bp != null ? p.mid_bp / 100 : 0}%"></i><em><img src="${VENUE.polymarket.icon}" alt="" width="10" height="10">${fmtCents(p?.mid_bp)}${rel ? '*' : ''}</em></span>
      <span class="lc-gap">${c.gap_pts != null ? `${c.gap_pts.toFixed(1)}¢` : '—'}</span></span>`;
  }).join('');
  const rel = e.contracts.some((c) => !c.polymarket && c.related.some((r) => r.venue === 'polymarket'));
  return `<button type="button" class="lc" data-open="${esc(e.key)}">
    <span class="lc-h"><span class="sport">${esc(e.sport.toUpperCase())}</span><span class="st st-live"><i></i>${esc(s?.detail || s?.status_label || 'LIVE')}</span></span>
    ${lines}${rel ? '<small class="lc-rel">* Polymarket rules differ · not compared</small>' : ''}
    <small class="lc-age">${esc(['score ' + (ageText(s?.updated_at || S.live?.generated_at) || ''), freshLine(e)].filter(Boolean).join(' · '))}</small>
  </button>`;
}
function renderLive() {
  const sec = $('#live');
  const linked = S.events.filter((e) => e.live);
  const liveItems = (S.live?.items || []).filter((x) => x.status === 'live');
  const ids = new Set(linked.map((e) => `${e.sport}:${e.canonical_event_id}`));
  const unlinked = liveItems.filter((x) => !ids.has(`${x.sport}:${x.source_id}`));
  sec.hidden = S.memberState !== 'entitled' || (!linked.length && !unlinked.length);
  if (sec.hidden) return;
  $('#live-meta').textContent = `${liveItems.length} live · ${linked.length} with linked markets`;
  const cards = linked.map(liveCard).concat(unlinked.slice(0, 8).map((x) => `<a class="lc lc-plain" href="${esc(x.pbecast_url || x.href || '#')}">
    <span class="lc-h"><span class="sport">${esc(x.sport.toUpperCase())}</span><span class="st st-live"><i></i>${esc(x.detail || x.status_label || 'LIVE')}</span></span>
    <span class="lc-score">${x.score?.away ? `${x.score.away.logo ? `<img src="${esc(x.score.away.logo)}" alt="" width="22" height="22">` : ''}<span>${esc(x.score.away.abbr)}</span><b>${esc(x.score.away.score ?? '—')}</b>${x.score.home.logo ? `<img src="${esc(x.score.home.logo)}" alt="" width="22" height="22">` : ''}<span>${esc(x.score.home.abbr)}</span><b>${esc(x.score.home.score ?? '—')}</b>` : `<span>${esc(x.title)}</span>`}</span>
    <small class="lc-age">${esc(['nfl', 'nba', 'mlb', 'nhl'].includes(x.sport) ? 'No comparison market linked to this game' : 'Score shown separately · market link UNMATCHED')}</small></a>`));
  liveRail(cards);
}

// Live rail: more than MARQUEE_MIN games -> a slow continuous scroll (owner 2026-10-05), never a scrollbar.
// The cards are rendered twice (the copy is aria-hidden and out of the tab order) and moved by an offset that
// survives the 15-60 s re-renders, so new scores never make the rail jump. Pauses on hover / keyboard focus;
// reduced-motion users get a static rail they can swipe (scrollbar still hidden).
const MARQUEE_MIN = 6, MARQUEE_PX_S = 26;
const mq = { raf: 0, x: 0, last: 0, paused: false, bound: false };
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function liveRail(cards) {
  const box = $('#live-cards');
  if (!mq.bound) {
    mq.bound = true;
    const pause = (v) => () => { mq.paused = v; };
    box.addEventListener('pointerenter', pause(true)); box.addEventListener('pointerleave', pause(false));
    box.addEventListener('focusin', pause(true)); box.addEventListener('focusout', pause(false));
  }
  const on = cards.length >= MARQUEE_MIN && !reducedMotion();
  box.classList.toggle('marquee', on);
  if (!on) { stopMarquee(); box.innerHTML = cards.join(''); return; }
  const copy = cards.map((h) => h.replace(/^<(a|button)\b/, '<$1 tabindex="-1" aria-hidden="true" data-copy'));
  box.innerHTML = `<div class="lc-track">${cards.join('')}${copy.join('')}</div>`;
  box.dataset.n = String(cards.length);
  if (!mq.raf) { mq.last = 0; mq.raf = requestAnimationFrame(stepMarquee); } else stepMarquee.apply_(); // keep offset
}
function stepMarquee(t) {
  const box = $('#live-cards'), track = box?.querySelector('.lc-track');
  if (!track) { mq.raf = 0; return; }
  const dt = mq.last ? Math.min(100, t - mq.last) / 1000 : 0;
  mq.last = t;
  const first = track.children[Number(box.dataset.n) || 0];
  const loop = first ? first.offsetLeft - track.children[0].offsetLeft : 0;
  if (!mq.paused && loop > 0) { mq.x += dt * MARQUEE_PX_S; if (mq.x >= loop) mq.x -= loop; }
  track.style.transform = `translate3d(${-mq.x.toFixed(1)}px,0,0)`;
  mq.raf = requestAnimationFrame(stepMarquee);
}
stepMarquee.apply_ = () => { const track = $('#live-cards .lc-track'); if (track) track.style.transform = `translate3d(${-mq.x.toFixed(1)}px,0,0)`; };
function stopMarquee() { if (mq.raf) cancelAnimationFrame(mq.raf); mq.raf = 0; mq.last = 0; }

// ---------------------------------------------------------------------------------------------------------
// Overview hub (ALL SPORTS) and sport hubs
function skeleton(n = 6) { return `<div class="tiles">${Array.from({ length: n }, () => '<span class="tile skel" aria-hidden="true"></span>').join('')}</div>`; }
function stat(label, value, cls = '') { return `<span class="stat ${cls}"><small>${esc(label)}</small><b>${value}</b></span>`; }

function renderOverview(box) {
  const active = S.events.filter((e) => e.active);
  const top = active.filter((e) => e.best_gap != null).slice(0, 6);
  const st = hubStats(S.events);
  let html = `<header class="hub-head"><div><p class="eyebrow">ALL SPORTS</p><h1>Market command center</h1></div>
    <div class="stats">${stat('LIVE', st.live, st.live ? 'live' : '')}${stat('ACTIVE MARKETS', st.active)}${stat('COMPARABLE', st.comparable)}${stat('RULES DIFFER', st.mismatch)}${stat('BIGGEST MID GAP', st.best ? `${st.best.best_gap.toFixed(1)}¢` : '—', 'gold')}${stat('TOP-OF-BOOK CROSSES', st.crosses)}</div></header>`;
  html += `<section class="sec"><div class="sec-head"><h2>BIGGEST MID-PRICE GAPS</h2><small>market disagreement between comparable contracts (mids, aligned within 120 s), not executable prices; each tile shows its top-of-book cross separately</small></div>${top.length ? tiles(top) : '<div class="empty"><b>No aligned comparable mid-price gaps right now.</b></div>'}</section>`;
  const crosses = active.filter((e) => e.contracts.some((c) => c.cross?.state === 'CROSS')).slice(0, 6);
  if (crosses.length) html += `<section class="sec"><div class="sec-head"><h2>TOP-OF-BOOK CROSSES</h2><small title="${esc(CROSS_TOOLTIP)}">best displayed bid above the other venue's best displayed ask · before fees · size not measured</small></div>${tiles(crosses)}</section>`;
  const pbe = S.events.filter((e) => e.has_pbe && e.active).slice(0, 3);
  if (pbe.length) html += `<section class="sec"><div class="sec-head"><h2>PBE CALLS</h2><small>PropBetEdge probability next to both venues</small></div>${tiles(pbe)}</section>`;
  const order = SPORTS.map((s) => s.key).map((k) => ({ k, list: active.filter((e) => e.sport === k) })).filter((x) => x.list.length).sort((a, b) => b.list.length - a.list.length);
  for (const { k, list } of order) {
    const hs = hubStats(S.events.filter((e) => e.sport === k));
    html += `<section class="sec sport-sec"><div class="sec-head"><h2>${esc(LABEL[k])}</h2><small>${hs.active} active · ${hs.comparable} comparable${hs.live ? ` · ${hs.live} live` : ''}${hs.best ? ` · top ${hs.best.best_gap.toFixed(1)}¢` : ''}</small><span class="flex"></span><button type="button" class="act" data-scope="${k}">OPEN ${esc(LABEL[k])} HUB →</button></div>${tiles(list.slice(0, 4))}</section>`;
  }
  const off = (S.desk?.lanes || []).filter((l) => l.state === 'not_connected').map((l) => LABEL[l.lane] || l.lane.toUpperCase());
  if (off.length) html += `<section class="sec"><div class="soon"><b>NOT CONNECTED YET</b><span>${off.map(esc).join(' · ')}</span><small>No Kalshi ↔ Polymarket comparison lane exists for these sports yet. Their live scores still appear in the live rail.</small></div></section>`;
  box.innerHTML = html;
}

function renderHub(box) {
  const k = S.scope;
  const evs = S.events;
  const hs = hubStats(evs);
  const lane = (S.desk?.lanes || [])[0];
  let html = `<header class="hub-head"><div><p class="eyebrow">${k === 'nonsports' ? 'PREDICTION MARKETS' : 'SPORT HUB'}</p><h1>${esc(LABEL[k])}</h1></div>
    <div class="stats">${k !== 'nonsports' ? stat('LIVE', hs.live, hs.live ? 'live' : '') : ''}${stat('ACTIVE', hs.active)}${stat('COMPARABLE', hs.comparable)}${stat('RULES DIFFER', hs.mismatch)}${k === 'golf' ? '' : `${stat('BIGGEST MID GAP', hs.best ? `${hs.best.best_gap.toFixed(1)}¢` : '—', 'gold')}${stat('TOP-OF-BOOK CROSSES', hs.crosses)}`}</div></header>`;
  if (lane?.state === 'not_connected') { box.innerHTML = html + `<div class="empty"><b>${esc(boardEmpty({ desk: S.desk, viewKey: S.view, events: [] })?.text || 'Not connected yet.')}</b>${upcomingHint()}</div>`; return; }
  const viewList = evs.filter(VIEWS[S.view].filter);
  const whenTabs = k === 'nonsports' ? '' : `<div class="when" role="tablist" aria-label="Date">${WHEN.map((w) => { const n = viewList.filter((e) => inWhen(e, w.key)).length; return `<button type="button" role="tab" data-when="${w.key}" aria-selected="${S.when === w.key}"${!n && w.key !== 'all' ? ' disabled' : ''}>${w.label}<em>${n}</em></button>`; }).join('')}</div>`;
  const chips = `<div class="chips">${Object.entries(VIEWS).filter(([v]) => v !== 'live').map(([v, d]) => `<button type="button" data-view="${v}" aria-pressed="${S.view === v}">${esc(d.label)}<em>${evs.filter(d.filter).length}</em></button>`).join('')}</div>`;
  const rows = viewList.filter((e) => inWhen(e, S.when));
  const shown = rows.slice(0, S.page * PAGE);
  html += `<div class="hub-bar">${whenTabs}${chips}</div>`;
  if (!rows.length) {
    const empty = boardEmpty({ desk: S.desk, viewKey: S.when === 'live' ? 'live' : S.view, events: rows, scope: S.scope, liveItems: S.live?.items || [] });
    html += `<div class="empty${empty?.failure ? ' empty-fail' : ''}"><b>${esc(empty?.text || 'Nothing in this view.')}</b>${!empty?.failure && (S.view !== 'all' || S.when !== 'all') ? '<button type="button" class="act" data-reset>SHOW ALL MARKETS</button>' : ''}${upcomingHint()}</div>`;
  } else {
    html += tiles(shown);
    html += `<div class="more"><small>${shown.length} of ${rows.length} · ranked by valid Kalshi ↔ Polymarket spread; stale, final and unmatched last${lane?.capped ? ` · first ${S.desk.page_limit} events from the upstream desk` : ''}</small>${rows.length > shown.length ? `<button type="button" class="act" data-more>SHOW ${Math.min(PAGE, rows.length - shown.length)} MORE</button>` : ''}</div>`;
  }
  box.innerHTML = html;
}
function upcomingHint() {
  const up = (S.live?.items || []).filter((x) => x.status === 'scheduled' && (S.scope === 'sports' || x.sport === S.scope)).slice(0, 6);
  return up.length ? `<div class="next"><small>NEXT GAMES</small>${up.map((x) => `<span>${esc(x.sport.toUpperCase())} ${esc(x.title)} · ${esc(timeOf(x.starts_at))}</span>`).join('')}</div>` : '';
}

function renderBoard() {
  const box = $('#board');
  box.hidden = S.memberState !== 'entitled';
  if (box.hidden) return;
  const scoresPending = scopeLiveSports().length && S.liveStatus === null;
  if (!S.desk || scoresPending) {
    box.innerHTML = S.deskStatus === 'loading' || (S.desk && scoresPending) ? skeleton() : '<div class="empty empty-fail"><b>The market desk did not answer. See the status above; retrying automatically.</b></div>';
    return;
  }
  const allDown = (S.desk.lanes || []).length && S.desk.lanes.every((l) => l.state === 'unavailable');
  if (allDown) { box.innerHTML = `<div class="empty empty-fail"><b>${esc(boardEmpty({ desk: S.desk, viewKey: 'top', events: [] }).text)}</b>${upcomingHint()}</div>`; return; }
  if (S.scope === 'sports') renderOverview(box); else renderHub(box);
}

// ---------------------------------------------------------------------------------------------------------
// Drawer (detail)
function spark(series, now) {
  const all = series.flatMap((s) => s.points.map((p) => [Date.parse(p.t), p.v])).filter(([t]) => t >= now - 86400e3);
  if (all.length < 2) return '';
  const t0 = Math.max(now - 86400e3, Math.min(...all.map((p) => p[0]))), t1 = now;
  const vs = all.map((p) => p[1]); const lo = Math.max(0, Math.min(...vs) - 300), hi = Math.min(10000, Math.max(...vs) + 300);
  const W = 1200, H = 150, x = (t) => 8 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 16), y = (v) => 8 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - 16);
  const path = (pts) => { const ps = pts.filter(([t]) => t >= t0); if (!ps.length) return ''; return ps.map(([t, v], i) => `${i ? 'H' + x(t).toFixed(1) + ' V' : 'M' + x(t).toFixed(1) + ','}${y(v).toFixed(1)}`).join(' ') + ` H${x(t1).toFixed(1)}`; };
  const lines = series.map((s) => `<path d="${path(s.points.map((p) => [Date.parse(p.t), p.v]).sort((a, b) => a[0] - b[0]))}" class="ln ln-${s.key}"/>`).join('');
  return `<figure class="spark-fig"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark" role="img" aria-label="Stored observations, last 24 hours, ${(lo / 100).toFixed(0)} to ${(hi / 100).toFixed(0)} cents">${lines}</svg>
    <figcaption><span>${esc(timeOf(new Date(t0).toISOString()))}</span><span>range ${(lo / 100).toFixed(0)}–${(hi / 100).toFixed(0)}¢</span><span>now</span></figcaption></figure>`;
}
function termsBlock(rt) {
  const v = ruleTermsView(rt);
  if (!v) return '';
  const col = (venue, name) => `<div class="wt"><span class="wt-h"><img src="${VENUE[venue].icon}" alt="" width="14" height="14">${name}</span>${v[venue].lines.map((l) => `<span class="wt-l${l.differs ? ' d' : ''}">${esc(l.text)}</span>`).join('')}${v[venue].unknown ? '<span class="wt-l u">Not confidently parsed (some clauses)</span>' : ''}${!v[venue].lines.length && !v[venue].unknown ? '<span class="wt-l">No edge-case clauses stated</span>' : ''}</div>`;
  return `<div class="wts">${col('kalshi', 'Kalshi')}${col('polymarket', 'Polymarket')}</div>`;
}
function whyDiffer(e) {
  const c = e.contracts.find((x) => x.rule_terms) || null;
  const mismatch = e.badge === 'RULE_MISMATCH' || e.badge === 'WITHDRAWN';
  const notes = [];
  for (const x of e.contracts) if (x.note === 'NOT_ALIGNED') { notes.push(`<p class="small">${esc(BADGES.NOT_ALIGNED)}</p>`); break; }
  if (e.badge === 'SINGLE_VENUE') return `<details class="why why-ok"><summary>Settlement terms</summary><p class="small">${esc(BADGES.SINGLE_VENUE)}</p></details>`;
  if (!c) {
    const r = e.contracts.flatMap((x) => x.related)[0];
    return `<details class="why${mismatch ? '' : ' why-ok'}"${mismatch ? ' open' : ''}><summary>${mismatch ? 'Why these differ' : 'Settlement terms'}</summary><p class="small">${esc(r?.reason || e.contracts.find((x) => x.comparison?.disclosure)?.comparison.disclosure || 'Per-venue settlement terms are not available for this market.')}</p>${notes.join('')}</details>`;
  }
  const head = mismatch
    ? `<p class="small">${esc(e.contracts.flatMap((x) => x.related)[0]?.reason || 'Settlement rules differ between venues.')}. Highlighted lines differ; prices are shown side by side and never compared.</p>`
    : `<p class="small">${esc(e.contracts.map((x) => x.comparison?.disclosure || x.polymarket?.disclosure).find(Boolean) || 'Approved comparable contract: the outcome is identical; only the highlighted edge cases settle differently (owner-approved exception).')} The comparison is withdrawn if the game is not played as scheduled.</p>`;
  const keys = keyDifferences(c.rule_terms);
  const keyHtml = keys.length ? `<p class="keydiff">${keys.map(esc).join('<br>')}</p>` : '';
  return `<details class="why${mismatch ? '' : ' why-ok'}"${mismatch || keys.length ? ' open' : ''}><summary>${mismatch ? 'Why these differ' : 'Settlement terms'}</summary>${head}${keyHtml}${termsBlock(c.rule_terms)}${notes.join('')}<p class="small muted">Only clauses parsed from each venue's published rules are shown.</p></details>`;
}
function movesPanel(e) {
  const d = S.detail.get(e.key);
  if (!d || (d.loading && !d.body)) return '<p class="muted">Loading stored observations…</p>';
  const now = Date.now();
  const table = (rows) => `<table class="mv"><thead><tr><th></th>${WINDOWS.map((w) => `<th>${w.key}</th>`).join('')}</tr></thead><tbody>${rows.map(([name, pts]) => { const m = moves(pts, now); return `<tr><th>${name}</th>${WINDOWS.map((w) => `<td class="${m[w.key]?.delta_bp > 0 ? 'up' : m[w.key]?.delta_bp < 0 ? 'dn' : ''}">${pts?.length ? esc(fmtMove(m[w.key]).replace('Not enough observations', '—')) : '—'}</td>`).join('')}</tr>`; }).join('')}</tbody></table>`;
  if (e.sport) {
    if (d.status !== 200 || !d.body) return `<p class="muted">Observed history is unavailable right now (HTTP ${d.status || 'network'}). Prices above remain current.</p>`;
    return d.body.contracts.map((c) => {
      const vol = c.kalshi ? [c.kalshi.volume_24h != null ? `24h volume ${Math.round(c.kalshi.volume_24h).toLocaleString()}` : null, c.kalshi.open_interest != null ? `open interest ${Math.round(c.kalshi.open_interest).toLocaleString()}` : null].filter(Boolean).join(' · ') : '';
      return `<div class="mv-block"><h4>${esc(c.label)} · 24H OBSERVED MOVE</h4>${table([[`<img src="${VENUE.kalshi.icon}" alt="" width="12" height="12"> Kalshi`, c.kalshi?.points], [`<img src="${VENUE.polymarket.icon}" alt="" width="12" height="12"> Polymarket`, c.polymarket?.points]])}${vol ? `<p class="small">Kalshi ${esc(vol)}</p>` : ''}${spark([{ key: 'k', points: c.kalshi?.points || [] }, { key: 'p', points: c.polymarket?.points || [] }], now)}</div>`;
    }).join('') + '<p class="small legend"><i class="lg lg-k"></i>Kalshi <i class="lg lg-p"></i>Polymarket · Stored observations only, drawn as steps. “—” = not enough observations for that window, never zero.</p>';
  }
  if (d.status === 200 && d.body?.series) {
    const sers = d.body.series.map((s) => ({ key: s.source === 'kalshi' ? 'k' : s.source === 'polymarket' ? 'p' : 'b', label: s.label, points: (s.segments || []).flat().map((p) => ({ t: p.t, v: p.v })) }));
    return table(sers.map((s) => [esc(s.label), s.points])) + spark(sers, now);
  }
  return `<p class="muted">${d.status === 404 ? 'No stored observation series for this contract yet.' : `Observed history is unavailable right now (HTTP ${d.status || 'network'}).`}</p>`;
}
function deepLink(e) { const u = new URL('https://compare.propbetedge.ai/'); if (S.scope !== 'sports') u.searchParams.set('scope', S.scope); u.searchParams.set('open', e.key); return u.toString(); }
function drawerContract(e, c) {
  const p = pmFor(c), rel = !c.polymarket && !!p;
  const venue = (name, v, isRel) => `<div class="dv"><span class="dv-h"><img src="${VENUE[name].icon}" alt="" width="16" height="16">${VENUE[name].name}${isRel ? '<span class="mini">RULES DIFFER</span>' : ''}</span>${v && v.mid_bp != null ? `<b>${fmtCents(v.yes_bp)}</b><span class="dv-no">NO ${fmtCents(v.no_bp)}</span><div class="bar ${name}"><i style="width:${v.yes_bp / 100}%"></i></div><small>${v.bid_bp != null ? `bid/ask ${fmtCents(v.bid_bp)}–${fmtCents(v.ask_bp)} · ` : ''}observed ${esc(ageText(v.observed_at) || '?')}${v.freshness === 'stale' ? ' · STALE' : v.freshness === 'delayed' ? ' · delayed' : ''}</small>${v.market_url ? `<a class="ext" href="${esc(v.market_url)}" target="_blank" rel="noopener nofollow">Open on ${VENUE[name].name} ↗</a>` : ''}` : '<b class="none">—</b><small>not listed</small>'}</div>`;
  return `<div class="dc${S.focusMarket === c.id ? ' focus' : ''}">
    <div class="dc-h">${avatar(e, c, 'lg')}<div><b>${esc(c.label)}</b>${scoreOf(e, c)}</div><span class="flex"></span>${gapCell(c)}</div>
    <div class="dc-v">${venue('kalshi', c.kalshi, false)}${venue('polymarket', p, rel)}</div>
    ${metricsBox(c)}
    <div class="dc-pbe">${c.pbe ? `<b>PBE ${fmtPct(c.pbe.probability)}</b><small>${esc((c.pbe.state || '').replace(/_/g, ' ').toLowerCase())}${c.pbe.issued_at ? ` · issued ${esc(timeOf(c.pbe.issued_at))}` : ''}${c.pbe_vs_venues ? ` · vs venues ${c.pbe_vs_venues.map((x) => (x > 0 ? '+' : '') + x.toFixed(1)).join(' / ')} pts` : ''}</small>` : '<small>No active PBE call</small>'}</div>
  </div>`;
}
// Field events: one compact row per golfer (each venue at its own price); never a shared spread.
function fieldTable(e) {
  const cell = (v, rel) => (v && v.mid_bp != null ? `<td class="num">${fmtCents(v.yes_bp)}${v.market_url ? ` <a href="${esc(v.market_url)}" rel="noopener" target="_blank" aria-label="Open on ${rel ? 'Polymarket' : 'Kalshi'}">↗</a>` : ''}</td>` : '<td class="num muted">—</td>');
  const rows = e.contracts.map((c) => { const p = pmFor(c); return `<tr><th><span class="ft-g">${avatar(e, c, 'sm')}<span>${esc(c.label || '—')}</span></span></th>${cell(c.kalshi, false)}${cell(p, true)}</tr>`; }).join('');
  return `<section class="field" aria-label="Field"><p class="small">${esc(`${e.field.n} golfers`)} · YES price on each venue. Settlement rules differ, so the two prices are shown side by side and never compared.</p>
    <table class="ft"><thead><tr><th>Golfer</th><th class="num"><img src="${VENUE.kalshi.icon}" alt="" width="12" height="12"> Kalshi</th><th class="num"><img src="${VENUE.polymarket.icon}" alt="" width="12" height="12"> Polymarket</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
function metricsBox(c) {
  if (c.badge !== 'COMPARABLE') return `<div class="dm dm-off"><span><small>SHARED SPREAD</small><b>Not compared</b><em>${esc(c.badge === 'RULE_MISMATCH' ? 'Settlement rules differ: each venue is shown at its own price only.' : c.badge === 'WITHDRAWN' ? BADGES.WITHDRAWN : BADGES.SINGLE_VENUE)}</em></span></div>`;
  if (c.gap_pts == null) return `<div class="dm dm-off"><span><small>SHARED SPREAD</small><b>Not aligned</b><em>${esc(BADGES.NOT_ALIGNED)}</em></span></div>`;
  const x = c.cross;
  const vn = (v) => (v === 'kalshi' ? 'Kalshi' : 'Polymarket');
  const xs = x?.state === 'CROSS' ? `<b class="pos">+${(x.bp / 100).toFixed(1)}¢</b><em>${vn(x.bid_venue)} bid ${fmtCents(x.bid_bp)} vs ${vn(x.ask_venue)} ask ${fmtCents(x.ask_bp)}</em>`
    : x?.state === 'NO_CROSS' ? `<b>NO EXECUTABLE CROSS</b><em>Closest: ${vn(x.bid_venue)} bid ${fmtCents(x.bid_bp)} vs ${vn(x.ask_venue)} ask ${fmtCents(x.ask_bp)} (${(x.bp / 100).toFixed(1)}¢)</em>`
    : '<b>NO BOOK</b><em>One venue has no two-sided top of book.</em>';
  return `<div class="dm"><span class="dm-mid" title="Difference between the two venues' mid prices. Informational market disagreement, not an executable price."><small>MID-PRICE GAP</small><b>${c.gap_pts.toFixed(1)}¢</b><em>${c.gap_rel_pct != null ? `${c.gap_rel_pct.toFixed(1)}% relative · ` : ''}market disagreement, informational</em></span>
    <span class="dm-x" title="${esc(CROSS_TOOLTIP)}"><small>TOP-OF-BOOK EXECUTABLE CROSS</small>${xs}<em class="fine">${esc(CROSS_TOOLTIP)}</em></span></div>`;
}
function renderDrawer() {
  const dr = $('#drawer'), e = S.memberState === 'entitled' ? openEvent() : null;
  dr.hidden = !e;
  document.body.classList.toggle('drawer-open', !!e);
  if (!e) return;
  const cast = e.join.score?.pbecast_url || e.join.score?.href || e.destination;
  const cmd = new URL(MEMBERS); cmd.searchParams.set('add', deepLink(e)); cmd.searchParams.set('title', `${e.title} · Compare`);
  const keepScroll = $('#drawer-body')?.scrollTop || 0;
  $('#drawer-in').innerHTML = `<header class="dh"><span class="sport">${esc(e.sport ? e.sport.toUpperCase() : 'PREDICTION')}</span>${statusChip(e)}${threeWayChip(e)}<span class="flex"></span>${badgeFor(e)}<button type="button" class="x" data-close aria-label="Close details">✕</button></header>
    <div class="drawer-body" id="drawer-body"><h2>${esc(e.title)}</h2>
      ${distribution(e)}
      ${e.field ? `${whyDiffer(e)}${fieldTable(e)}` : e.contracts.map((c) => drawerContract(e, c)).join('')}
      <div class="acts">${cast ? `<a class="act" href="${esc(cast)}">${e.join.score?.pbecast_url ? 'PBECAST ↗' : 'GAME PAGE ↗'}</a>` : ''}<a class="act" href="${esc(cmd.toString())}">+ COMMAND CENTER</a></div>
      ${e.field ? '' : `<section class="dsec">${movesPanel(e)}</section>`}
      ${e.field ? '' : whyDiffer(e)}
      <p class="small muted">${esc(S.detail.get(e.key)?.at ? `History read ${ageText(new Date(S.detail.get(e.key).at).toISOString())}` : '')}</p>
    </div>`;
  $('#drawer-body').scrollTop = keepScroll;
}

function render() {
  renderAccount(); renderNav(); renderHealth(); renderNotices(); renderGate(); renderLive(); renderBoard(); renderDrawer();
}

// ---------------------------------------------------------------------------------------------------------
// Events (delegated once; never re-bound per render)
function setScope(k) {
  if (S.scope === k) return;
  S.scope = k; S.view = 'top'; S.when = 'all'; S.page = 1; S.open = '';
  S.desk = null; S.live = null; S.deskStatus = 'loading'; S.liveStatus = null; S.deskAt = S.liveAt = 0; S.events = [];
  writeUrl(); render(); mount(); window.scrollTo({ top: 0 });
}
function openDrawer(key) {
  const e = S.events.find((x) => x.key === key);
  if (!e) return;
  S.open = key; writeUrl(); render();
  loadDetail(e).then(render, () => {});
  setTimeout(() => $('#drawer [data-close]')?.focus(), 0);
}
function closeDrawer() { if (!S.open) return; S.open = ''; writeUrl(); render(); }
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-scope],[data-view],[data-when],[data-open],[data-close],[data-more],[data-reset],[data-retry],#acct,#drawer-bg');
  if (!t) return;
  if (t.matches('#acct') && (S.memberState === 'unverified' || S.memberState === 'network_error')) { ev.preventDefault(); boot(); return; }
  if (t.matches('[data-retry]')) { boot(); return; }
  if (t.matches('#drawer-bg') || t.matches('[data-close]')) { closeDrawer(); return; }
  if (t.dataset.scope) { setScope(t.dataset.scope); return; }
  if (t.dataset.view) { S.view = t.dataset.view; S.page = 1; writeUrl(); render(); return; }
  if (t.dataset.when) { S.when = t.dataset.when; S.page = 1; writeUrl(); render(); return; }
  if (t.matches('[data-more]')) { S.page += 1; writeUrl(false); render(); return; }
  if (t.matches('[data-reset]')) { S.view = 'all'; S.when = 'all'; S.page = 1; writeUrl(); render(); return; }
  if (t.dataset.open) { openDrawer(t.dataset.open); }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && S.open) closeDrawer(); });
window.addEventListener('popstate', () => {
  const prevScope = S.scope;
  readUrl();
  if (S.memberState !== 'entitled') { render(); return; }
  if (S.scope !== prevScope) { S.desk = null; S.live = null; S.deskStatus = 'loading'; S.liveStatus = null; S.events = []; render(); mount(); return; }
  render();
  const e = openEvent();
  if (e && !S.detail.get(e.key)) loadDetail(e).then(render, () => {});
});
// Health ages tick without network: one renderHealth per 15 s while visible (no fetch).
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
