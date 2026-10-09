// /track-record/ — the flagship scoreboard (issue #50). Three records that are never mixed:
//   1. Contracts scored (public aggregate /api/track-record): Brier / log loss vs the market, denominated in contracts —
//      never a win rate and never a trade return.
//   2. Temperature event outcomes (members, /api/premium/results-board): retrospective, one result per settled event:
//      the model's top bucket vs the winning bucket.
//   3. Research calls (members): prospectively frozen YES/NO calls, not official picks; PASS excluded.
// Official picks are NOT activated and are said so. Losses stay on the record. Paid rows come only from the gated route.
const PAGE_SIZE = 20;
let member = false;
let board = null;
const state = { tab: urlState.get('tab', 'temperature'), result: urlState.get('result', 'ALL'), page: Math.max(1, Number(urlState.get('page', 1)) || 1) };
const go = (patch) => { Object.assign(state, patch); urlState.set({ tab: state.tab === 'temperature' ? null : state.tab, result: state.result, page: state.page }); };

function scoring(t) {
  const g = (d, m) => t.groups.find((x) => x.designation === d && x.method === m);
  const b = g('FINAL_PRE_RESOLUTION', 'brier'); const l = g('FINAL_PRE_RESOLUTION', 'log_loss');
  const enough = t.resolved_contracts >= t.min_for_claims;
  $('tr').innerHTML = `
    <div class="stat"><span>Resolved contracts</span><strong class="num">${t.resolved_contracts ? t.resolved_contracts : 'Building'}</strong><small>${t.resolved_contracts ? 'contracts scored (not wins)' : 'first settlements pending'}</small></div>
    <div class="stat"><span>Forecast accuracy score (Brier)</span><strong class="num">${b && enough ? b.pbe_mean.toFixed(3) : 'Pending'}</strong><small>${b ? `market ${b.market_mean?.toFixed(3) ?? '—'} · n=${b.n}${enough ? '' : ` (needs ${t.min_for_claims})`}` : 'Lower is better; not win percentage'}</small></div>
    <div class="stat"><span>Log loss</span><strong class="num">${l && enough ? l.pbe_mean.toFixed(3) : 'Pending'}</strong><small>${l ? `market ${l.market_mean?.toFixed(3) ?? '—'}` : 'lower is better'}</small></div>
    <div class="stat"><span>Statistical evidence</span><strong>${enough ? 'Measurable' : 'Pending'}</strong><small>${enough ? 'see the research board' : `claims start at ${t.min_for_claims} resolved`}</small></div>`;
}

function overview(data) {
  const top = data.top_outcome || { matched: 0, missed: 0, events: 0 };
  const pro = data.prospective || { matched: 0, missed: 0, pending: 0, calls: 0 };
  const off = data.official || { matched: 0, missed: 0, pending: 0, calls: 0 };
  const card = (label, value, detail, kind = '') => `<div class="card result-stat ${kind}"><span>${esc(label)}</span><strong class="num">${esc(value)}</strong><small>${esc(detail)}</small></div>`;
  $('results-overview').innerHTML = card('Temperature outcomes matched', top.matched, `Out of ${top.events} settled events · top modeled bucket`)
    + card('Temperature outcomes missed', top.missed, 'Same event-level rule, not individual NO contracts', 'result-stat--miss')
    + card('Research calls', `${pro.matched}–${pro.missed}`, `${pro.pending} pending · ${pro.calls} frozen prospective calls`)
    + card('Official picks', off.calls ? `${off.matched}–${off.missed}` : 'Not activated', off.calls ? `${off.pending} pending` : 'No official result or win claim');
}

const TABS = { temperature: 'Temperature outcomes', calls: 'Research calls', official: 'Official picks' };
function ledger() {
  if (!board) return;
  const src = { temperature: board.top_outcome, calls: board.prospective, official: board.official }[state.tab] || board.top_outcome;
  const all = src?.rows || [];
  const tabs = Object.entries(TABS).map(([k, l]) => `<button type="button" class="chip" data-tab="${k}" aria-pressed="${state.tab === k}">${esc(l)}<small>${({ temperature: board.top_outcome, calls: board.prospective, official: board.official }[k]?.rows || []).length}</small></button>`).join('');
  const filters = ['ALL', 'MATCHED', 'MISSED', 'PENDING'].filter((k) => k === 'ALL' || all.some((r) => r.result === k));
  if (!filters.includes(state.result)) state.result = 'ALL';
  const fl = { ALL: 'All results', MATCHED: 'Right', MISSED: 'Missed', PENDING: 'Pending' };
  $('rec-tabs').innerHTML = tabs;
  $('rec-filters').innerHTML = filters.map((k) => `<button type="button" class="chip" data-result="${k}" aria-pressed="${state.result === k}">${fl[k]}<small>${k === 'ALL' ? all.length : all.filter((r) => r.result === k).length}</small></button>`).join('');
  $('rec-tabs').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { go({ tab: b.dataset.tab, result: 'ALL', page: 1 }); ledger(); }));
  $('rec-filters').querySelectorAll('[data-result]').forEach((b) => b.addEventListener('click', () => { go({ result: b.dataset.result, page: 1 }); ledger(); }));
  const rows = all.filter((r) => state.result === 'ALL' || r.result === state.result);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE; const shown = rows.slice(start, start + PAGE_SIZE);
  const note = { temperature: 'Retrospective · one result per settled event: the model’s highest-probability bucket vs the winning bucket.', calls: 'Prospective research calls frozen before resolution. Not official PBE picks; PASS decisions are excluded.', official: 'Official picks are not activated. No official result or win claim exists.' }[state.tab];
  $('rec-note').textContent = note;
  $('rec-count').textContent = rows.length ? `Showing ${start + 1}–${start + shown.length} of ${rows.length}` : '';
  const type = state.tab === 'temperature' ? 'temperature' : 'calls';
  $('results-ledger').innerHTML = shown.length ? `<div class="result-table-wrap"><table class="result-table"><thead><tr><th>Result</th><th>Event</th><th>Model forecast</th><th>Actual outcome</th><th>Evidence</th></tr></thead><tbody>${
    shown.map((r) => `<tr><td><span class="result-pill ${r.result === 'MATCHED' ? 'result-pill--hit' : r.result === 'MISSED' ? 'result-pill--miss' : 'result-pill--pending'}">${esc(r.result === 'MATCHED' ? 'RIGHT' : r.result === 'MISSED' ? 'MISSED' : 'PENDING')}</span></td><td><b>${esc(r.title)}</b><small>${esc(type === 'calls' ? (r.official ? 'Official decision' : 'Prospective research call') : 'Retrospective top outcome')}${r.scored_at || r.decided_at ? ` · ${esc(String(r.scored_at || r.decided_at).slice(0, 10))}` : ''}</small></td><td><b>${esc(type === 'calls' ? `${r.side} · ${r.label}` : r.picked)}</b><small>${esc(r.probability_pct == null ? 'Probability not available' : `${r.probability_pct}% forecast probability`)}</small></td><td><b>${esc(r.actual || 'Not settled')}</b></td><td><a href="/events/${encodeURIComponent(r.slug || '')}">Event record →</a></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="result-empty card">${state.tab === 'official' ? 'Official picks are not activated.' : 'No eligible results for this filter.'}</p>`;
  pager($('rec-pager'), state.page, pages, (n) => { go({ page: n }); ledger(); $('rec-top')?.scrollIntoView({ block: 'start' }); });
}

function locked() {
  $('results-overview').innerHTML = '<div class="card result-empty"><strong>Official picks: not activated</strong><p>Recorded forecast results are available to verified All Access members. No official pick record is being claimed.</p></div>';
  $('rec-members').hidden = true;
  $('rec-gate').hidden = false;
}

PBE.datasets.track = { ms: 300e3, run: async () => { const v = await sigFetch('track', 'track-record'); if (v) scoring(v); } };
PBE.datasets.results = { ms: 300e3, run: async () => {
  if (!member) return;
  const v = await sigFetch('results', 'premium/results-board', { credentials: 'same-origin' });
  if (!v) { if (!board) $('results-ledger').textContent = 'Result verification temporarily unavailable.'; return; }
  board = v; $('rec-gate').hidden = true; $('rec-members').hidden = false; overview(v); ledger();
} };

function onMembership(m) {
  if (!m?.entitled || member) return;
  member = true; pull('results');
}
document.addEventListener('pbe:membership', (ev) => onMembership(ev.detail));
locked();
if (window.PBE_MEMBERSHIP) onMembership(window.PBE_MEMBERSHIP);
bootLive();
