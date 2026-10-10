// All Non-Sports Markets explorer (#79). ES module. Renders ONLY what /api/market-catalog (market-catalog/1) returns:
// the browser never calls a venue, never invents a price, and never labels a partial index "ALL".
import { VENUES, VENUE_LABEL, CATEGORIES, CATEGORY_LABEL, SORTS, STATUSES, stateFromSearch, searchFromState, apiQuery, coverage, stateText,
  priceView, freshness, closesIn, compact, signedPts, mergeRows, venueLink } from './explorer-core.js?v=20261011am1';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('am-app');
let S = stateFromSearch(location.search);
let rows = []; let cursor = null; let last = null; let seq = 0; let timer = null;
const POLL_MS = 60000;

function controls(d) {
  const cats = d?.categories || {};
  const tab = (v) => `<button type="button" role="tab" class="am-tab" data-venue="${v}" aria-selected="${S.venue === v}" tabindex="${S.venue === v ? 0 : -1}">${esc(VENUE_LABEL[v])}</button>`;
  const chip = (c) => `<button type="button" class="am-chip" data-category="${c ?? ''}" aria-pressed="${S.category === c}">${esc(c ? CATEGORY_LABEL[c] : 'All categories')}${c && Number.isFinite(cats[c]?.count) ? ` <span class="num">${compact(cats[c].count)}</span>` : ''}</button>`;
  return `<div class="am-venues" role="tablist" aria-label="Venue">${VENUES.map(tab).join('')}</div>
<div class="am-filters">
  <label class="sr-only" for="am-q">Search markets</label><input id="am-q" class="am-search" type="search" placeholder="Search questions, tickers, slugs…" value="${esc(S.search)}" autocomplete="off">
  <label class="sr-only" for="am-sort">Sort</label><select id="am-sort" class="am-select">${SORTS.map(([k, l]) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
  <div class="am-status" role="group" aria-label="Status">${STATUSES.map(([k, l]) => `<button type="button" class="am-chip" data-status="${k}" aria-pressed="${S.status === k}">${esc(l)}</button>`).join('')}</div>
</div>
<div class="am-cats" role="group" aria-label="Category">${[null, ...CATEGORIES].map(chip).join('')}</div>`;
}

function banner(d) {
  const cov = coverage(d.venues, S.venue);
  const items = cov.rows.map((r) => `<li class="am-v am-${r.state.toLowerCase()}"><b>${esc(r.label)}</b> <span>${esc(stateText(r))}</span>${Number.isFinite(r.indexed_markets) && r.contributes ? ` · <span class="num">${compact(r.indexed_markets)}</span> markets indexed` : ''}${r.last_full_sync_at ? ` · last full sync ${esc(new Date(r.last_full_sync_at).toUTCString().slice(5, 22))} UTC` : ''}${r.error ? ` · <span class="am-err">${esc(r.error)}</span>` : ''}</li>`).join('');
  return `<section class="am-coverage${cov.complete ? ' is-complete' : ' is-partial'}" aria-labelledby="am-cov-h"><h2 id="am-cov-h" class="am-cov-h">${esc(cov.label)}</h2>
${cov.complete ? '' : '<p class="am-cov-note">The catalog is still being built or a source is limited, so this list is not yet every market. Counts below cover only what is indexed now.</p>'}
<ul class="am-cov-list">${items}</ul></section>`;
}

function row(m) {
  const p = priceView(m.quote); const link = venueLink(m); const fr = freshness(m.quote); const cl = closesIn(m.close_time);
  const price = p.kind === 'outcomes'
    ? `<ul class="am-outs">${p.items.map((o) => `<li><span>${esc(o.label)}</span><b class="num">${esc(o.text)}</b></li>`).join('')}${p.more ? `<li class="am-more">+${p.more} more</li>` : ''}</ul>`
    : `<p class="am-price"><b class="num">${esc(p.text)}</b>${p.kind === 'yes' ? '<span class="am-yes">YES</span>' : ''}${p.detail ? `<small>${esc(p.detail)}</small>` : ''}</p>`;
  return `<li class="am-row"><article aria-labelledby="am-${esc(m.id).replace(/[^a-z0-9]/gi, '-')}">
<div class="am-meta"><span class="am-venue am-${esc(m.venue)}">${esc(VENUE_LABEL[m.venue] || m.venue)}</span><span class="am-cat">${esc(CATEGORY_LABEL[m.category] || m.category_native || 'Other')}</span><span class="am-st">${esc(m.status)}</span>${cl ? `<span class="am-close">${esc(cl)}</span>` : ''}</div>
<h3 id="am-${esc(m.id).replace(/[^a-z0-9]/gi, '-')}" class="am-title">${esc(m.event_title || m.title)}</h3>
${m.event_title && m.title && m.title !== m.event_title ? `<p class="am-sub">${esc(m.outcome_label || m.title)}</p>` : ''}
<div class="am-body">${price}<dl class="am-kv"><dt>24h move</dt><dd class="num">${esc(signedPts(m.quote?.change_24h))}</dd><dt>24h volume</dt><dd class="num">${esc(compact(m.volume_24h))}</dd>${m.open_interest != null ? `<dt>Open interest</dt><dd class="num">${esc(compact(m.open_interest))}</dd>` : ''}</dl></div>
<p class="am-foot"><span class="am-id">${esc(m.market_id)}</span>${fr ? `<span class="am-fresh">${esc(fr)}</span>` : ''}${link ? `<a class="am-link" href="${esc(link)}" target="_blank" rel="noopener">Open on ${esc(VENUE_LABEL[m.venue])} <span aria-hidden="true">↗</span></a>` : ''}</p>
</article></li>`;
}

function render() {
  const d = last;
  if (!d) return;
  const cov = coverage(d.venues, S.venue);
  document.title = `${cov.complete ? 'All Non-Sports Markets' : 'Non-Sports Markets (partial catalog)'} · Kalshi & Polymarket | PropBetEdge Predictions`;
  app.dataset.state = 'ready';
  app.innerHTML = `${banner(d)}${controls(d)}
<p class="am-count" role="status" aria-live="polite"><b class="num">${compact(d.total)}</b> ${d.total === 1 ? 'market' : 'markets'}${cov.complete ? '' : ' indexed so far'}${S.search ? ` matching “${esc(S.search)}”` : ''} · showing <span class="num">${rows.length}</span></p>
${rows.length ? `<ol class="am-list">${rows.map(row).join('')}</ol>` : `<p class="am-empty">${cov.rows.some((r) => r.contributes) ? 'No indexed market matches these filters.' : 'No venue index is available yet for this view — see the status above.'}</p>`}
${d.has_next && cursor ? '<button type="button" class="am-load" id="am-load">Load more markets</button>' : ''}
<p class="am-note">Prices are the venues’ own listing prices as probabilities, with when we read them; most refresh with each full sweep, the most active with a faster cycle. Never live. Market data only: a PBE forecast exists only for events on the <a href="/desk/">Intelligence Desk</a>. Links open the venue’s own market page.</p>`;
  wire();
}

function fail(kind, status) {
  app.dataset.state = 'unavailable';
  app.innerHTML = `<section class="am-coverage is-partial" role="status"><h2 class="am-cov-h">CATALOG UNAVAILABLE</h2><p class="am-cov-note">${kind === 'net' ? 'The market catalog could not be reached.' : `The market catalog returned an error (HTTP ${status}).`} No markets are shown rather than an incomplete or stale list. Retrying in 60 s.</p></section>`;
}

async function load({ more = false } = {}) {
  const my = ++seq;
  let r;
  try { r = await fetch(apiQuery(S, more ? cursor : null), { headers: { accept: 'application/json' }, cache: 'no-store' }); } catch { if (my === seq) { fail('net'); schedule(); } return; }
  if (my !== seq) return; // a newer query superseded this one
  if (!r.ok) { fail('http', r.status); schedule(); return; }
  const d = await r.json().catch(() => null);
  if (!d || d.schema !== 'market-catalog/1') { fail('http', 'bad payload'); schedule(); return; }
  last = d; cursor = d.next_cursor || null;
  rows = more ? mergeRows(rows, d.markets || []) : (d.markets || []);
  render(); schedule();
}
// Poll the first page for fresh quotes/coverage while the tab is visible and the reader has not paged further.
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { if (document.visibilityState === 'visible' && rows.length <= 50) load(); else schedule(); }, POLL_MS);
}
function setState(patch) {
  S = { ...S, ...patch };
  history.replaceState(null, '', location.pathname + searchFromState(S));
  rows = []; cursor = null; load();
}
let qTimer = null;
function wire() {
  app.querySelectorAll('[data-venue]').forEach((b) => b.addEventListener('click', () => setState({ venue: b.dataset.venue })));
  const tabs = [...app.querySelectorAll('[role=tab]')];
  tabs.forEach((b, i) => b.addEventListener('keydown', (e) => { const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1; if (n >= 0) { e.preventDefault(); setState({ venue: tabs[n].dataset.venue }); } }));
  app.querySelectorAll('[data-category]').forEach((b) => b.addEventListener('click', () => setState({ category: b.dataset.category || null })));
  app.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => setState({ status: b.dataset.status })));
  $('am-sort')?.addEventListener('change', (e) => setState({ sort: e.target.value }));
  const q = $('am-q');
  q?.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { const v = q.value.trim().slice(0, 120); if (v !== S.search) { setState({ search: v }); } }, 350); });
  $('am-load')?.addEventListener('click', () => load({ more: true }));
  // keep focus in the search box across re-renders
  if (document.activeElement === document.body && S.search && q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && last && rows.length <= 50) load(); });
load();
