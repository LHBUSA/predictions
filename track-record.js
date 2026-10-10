// /track-record/ — the flagship scoreboard (issue #50). Three records that are never mixed:
//   1. Contracts scored (public aggregate /api/track-record): Brier / log loss vs the market, denominated in contracts —
//      never a win rate and never a trade return.
//   2. Temperature event outcomes (members, /api/premium/results-board): retrospective, one result per settled event:
//      the model's top bucket vs the winning bucket.
//   3. Research calls (members): prospectively frozen YES/NO calls, not official picks; PASS excluded.
// Official PBE Picks (rain YES/NO) are active from 2026-10-09 21:15 UTC; earlier calls stay research. Losses stay on the record. Paid rows come only from the gated route.
const PAGE_SIZE = 20;
let member = false;
let board = null;
const state = { tab: urlState.get('tab', 'temperature'), result: urlState.get('result', 'ALL'), page: Math.max(1, Number(urlState.get('page', 1)) || 1) };
const go = (patch) => { Object.assign(state, patch); urlState.set({ tab: state.tab === 'temperature' ? null : state.tab, result: state.result, page: state.page }); };

const f3 = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(3));
const VERDICT = { PBE_AHEAD: 'PBE ahead (95% range excludes zero)', MARKET_AHEAD: 'Market ahead (95% range excludes zero)', NOT_ESTABLISHED: 'No difference established', TOO_FEW_DAYS: 'Too few days for a verdict' };
// Paired = PBE and market on the same contracts. pbe_mean (every contract) is never set against a market mean taken
// over a different subset; lanes are never blended into one verdict.
function scoring(t) {
  const g = (d, m) => t.groups.find((x) => x.designation === d && x.method === m);
  const b = g('FINAL_PRE_RESOLUTION', 'brier'); const l = g('FINAL_PRE_RESOLUTION', 'log_loss');
  const enough = t.resolved_contracts >= t.min_for_claims;
  const pair = (x, name) => (x && enough && x.paired_pbe_mean != null ? `<div class="stat"><span>${name} · same contracts</span><strong class="num">PBE ${f3(x.paired_pbe_mean)}</strong><small>market ${f3(x.market_mean)} on the same ${x.market_n} contracts · PBE ${f3(x.pbe_mean)} on all ${x.n}</small></div>`
    : `<div class="stat"><span>${name}</span><strong class="num">Pending</strong><small>${enough ? 'no contracts with a same-time market price yet' : `scores start at ${t.min_for_claims} resolved`}</small></div>`);
  const by = (v) => (t.lanes || []).filter((x) => x.brier?.paired?.verdict === v).map((x) => x.label);
  const ahead = by('PBE_AHEAD'); const behind = by('MARKET_AHEAD');
  $('tr').innerHTML = `
    <div class="stat"><span>Resolved contracts</span><strong class="num">${t.resolved_contracts ? t.resolved_contracts : 'Building'}</strong><small>${t.resolved_contracts ? 'contracts scored (not wins)' : 'first settlements pending'}</small></div>
    ${pair(b, 'Brier')}${pair(l, 'Log loss')}
    <div class="stat"><span>Evidence of an edge</span><strong>${ahead.length ? 'PBE ahead' : enough ? 'None yet' : 'Pending'}</strong><small>${[ahead.length ? `PBE ahead: ${esc(ahead.join(' · '))}` : '', behind.length ? `market ahead: ${esc(behind.join(' · '))}` : '', !ahead.length && enough ? 'enough to score · not evidence of an edge' : '', enough ? '' : `scores start at ${t.min_for_claims} resolved`].filter(Boolean).join(' · ')}</small></div>`;
  const lanes = (t.lanes || []).filter((x) => x.brier?.paired);
  $('tr-lanes').innerHTML = lanes.map((x) => { const p = x.brier.paired;
    return `<div class="stat"><span>${esc(x.label)}</span><strong class="num">PBE ${f3(p.pbe_mean)}</strong><small>market ${f3(p.market_mean)} · Brier on the same ${p.n} contracts · ${p.clusters} ${p.clusters === 1 ? 'day/event' : 'days/events'} · difference ${p.diff >= 0 ? '+' : ''}${f3(p.diff)} [${f3(p.ci95[0])}, ${f3(p.ci95[1])}] · ${esc(VERDICT[p.verdict] || p.verdict)}</small></div>`; }).join('')
    || '<p class="note">Lane scores appear once a lane has contracts with a same-time market price.</p>';
}

function overview(data) {
  const top = data.top_outcome || { matched: 0, missed: 0, events: 0 };
  const pro = data.prospective || { matched: 0, missed: 0, pending: 0, calls: 0 };
  const off = data.official || { matched: 0, missed: 0, pending: 0, void: 0, calls: 0 };
  const card = (label, value, detail, kind = '') => `<div class="card result-stat ${kind}"><span>${esc(label)}</span><strong class="num">${esc(value)}</strong><small>${esc(detail)}</small></div>`;
  const sk = data.temperature_skill;
  $('results-overview').innerHTML = card('Temperature outcomes matched', top.matched, `Out of ${top.events} settled events · top modeled bucket${sk ? ` · ${sk.top_bucket.expected.toFixed(1)} expected from PBE’s own probabilities` : ''}`)
    + card('Temperature outcomes missed', top.missed, 'Same event-level rule, not individual NO contracts', 'result-stat--miss')
    + card('Research calls', `${pro.matched}–${pro.missed}`, `${pro.pending} pending · ${pro.calls} frozen prospective calls`)
    + card('Official picks · rain YES/NO', off.calls ? `${off.matched}–${off.missed}` : 'Active', off.calls ? `${off.pending} pending${off.void ? ` · ${off.void} void` : ''} · since activation` : 'Activated Oct 9, 2026 · the first official pick is the next eligible rain call');
}

const TABS = { temperature: 'Temperature outcomes', calls: 'Research calls', official: 'Official picks' };
// Temperature skill (members): the hit count beside its expectation, the market's favourite at the same moment, the
// whole-distribution score and the guidance error by city. Pre-window forecasts only; never blended with rain picks.
function skillPanel(t) {
  if (!t) return '';
  const pct = (x) => `${Math.round(x * 100)}%`; const f2 = (x) => Number(x).toFixed(2);
  const m = t.market; const early = (v) => (v === 'TOO_FEW_DAYS' ? `early: ${t.dates} of ${t.min_days_for_verdict} days needed for a verdict` : v === 'MARKET_AHEAD' ? 'market ahead (95% range excludes zero)' : v === 'PBE_AHEAD' ? 'PBE ahead (95% range excludes zero)' : 'no difference established');
  const stat = (label, value, detail) => `<div class="stat"><span>${esc(label)}</span><strong class="num">${esc(value)}</strong><small>${esc(detail)}</small></div>`;
  const city = (t.by_city || []).map((c) => `${esc(c.city)} ${c.nbm_bias_f > 0 ? '+' : ''}${c.nbm_bias_f ?? '—'}°F (MAE ${c.nbm_mae_f ?? '—'}, ${c.hits}/${c.events} vs ${c.expected_hits} expected)`).join(' · ');
  return `<h3 class="rec-skill-h">Temperature skill · pre-window forecasts</h3><div class="stats stats-4">${
    stat('Top bucket vs expectation', `${t.top_bucket.hits} of ${t.events}`, `${t.top_bucket.expected.toFixed(1)} expected from PBE’s own probabilities · this few or fewer happens ${pct(t.top_bucket.p_at_most)} of the time by chance`)
    + (m ? stat('Market favourite, same moment', `${m.market_hits} of ${m.events}`, `${m.market_expected.toFixed(1)} expected from the market’s prices · same favourite as PBE in ${m.same_modal}`) : '')
    + (m ? stat('Whole-distribution log loss', `PBE ${f2(m.log_loss.mean_a)} · mkt ${f2(m.log_loss.mean_b)}`, `lower is better · ${early(m.verdict_log_loss)}`) : stat('Whole-distribution log loss', `PBE ${f2(t.pbe.log_loss)}`, 'lower is better · no same-time market ladder'))
    + stat('Average favourite probability', pct(t.top_bucket.mean_p_modal), m ? `market ${pct(m.market_expected / m.events)}` : 'PBE')
  }</div><p class="note">Guidance error by city (official high − National Blend forecast PBE used, mean °F): ${city}. ${t.events} events, ${t.dates} days; days share weather, so small samples move together.</p>`;
}
function ledger() {
  if (!board) return;
  const src = { temperature: board.top_outcome, calls: board.prospective, official: board.official }[state.tab] || board.top_outcome;
  const all = src?.rows || [];
  const tabs = Object.entries(TABS).map(([k, l]) => `<button type="button" class="chip" data-tab="${k}" aria-pressed="${state.tab === k}">${esc(l)}<small>${({ temperature: board.top_outcome, calls: board.prospective, official: board.official }[k]?.rows || []).length}</small></button>`).join('');
  const filters = ['ALL', 'MATCHED', 'MISSED', 'PENDING', 'VOID'].filter((k) => k === 'ALL' || all.some((r) => r.result === k));
  if (!filters.includes(state.result)) state.result = 'ALL';
  const fl = { ALL: 'All results', MATCHED: 'Right', MISSED: 'Missed', PENDING: 'Pending', VOID: 'Void' };
  $('rec-tabs').innerHTML = tabs;
  $('rec-filters').innerHTML = filters.map((k) => `<button type="button" class="chip" data-result="${k}" aria-pressed="${state.result === k}">${fl[k]}<small>${k === 'ALL' ? all.length : all.filter((r) => r.result === k).length}</small></button>`).join('');
  $('rec-tabs').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { go({ tab: b.dataset.tab, result: 'ALL', page: 1 }); ledger(); }));
  $('rec-filters').querySelectorAll('[data-result]').forEach((b) => b.addEventListener('click', () => { go({ result: b.dataset.result, page: 1 }); ledger(); }));
  const rows = all.filter((r) => state.result === 'ALL' || r.result === state.result);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE; const shown = rows.slice(start, start + PAGE_SIZE);
  const note = { temperature: 'Retrospective · one result per settled event: the model’s highest-probability bucket vs the winning bucket.', calls: 'Prospective research calls frozen before resolution. Not official PBE picks; PASS decisions are excluded.', official: `Official PBE Picks: rain YES/NO calls by the frozen rain-v1 policy, locked before the event window, counted only from activation (${board.official?.policy?.activated_at ? String(board.official.policy.activated_at).replace('T', ' ').slice(0, 16) + ' UTC' : 'Oct 9, 2026'}). Earlier calls stay research. VOID = the venue cancelled the contract.` }[state.tab];
  $('rec-note').textContent = note;
  $('rec-skill').innerHTML = state.tab === 'temperature' ? skillPanel(board.temperature_skill) : '';
  $('rec-count').textContent = rows.length ? `Showing ${start + 1}–${start + shown.length} of ${rows.length}` : '';
  const type = state.tab === 'temperature' ? 'temperature' : 'calls';
  $('results-ledger').innerHTML = shown.length ? `<div class="result-table-wrap"><table class="result-table"><thead><tr><th>Result</th><th>Event</th><th>Model forecast</th><th>Actual outcome</th><th>Evidence</th></tr></thead><tbody>${
    shown.map((r) => `<tr><td><span class="result-pill ${r.result === 'MATCHED' ? 'result-pill--hit' : r.result === 'MISSED' ? 'result-pill--miss' : 'result-pill--pending'}">${esc(r.result === 'MATCHED' ? 'RIGHT' : r.result === 'MISSED' ? 'MISSED' : r.result === 'VOID' ? 'VOID' : 'PENDING')}</span></td><td><b>${esc(r.title)}</b><small>${esc(type === 'calls' ? (r.official ? 'Official decision' : 'Prospective research call') : 'Retrospective top outcome')}${r.scored_at || r.decided_at ? ` · ${esc(String(r.scored_at || r.decided_at).slice(0, 10))}` : ''}</small></td><td><b>${esc(type === 'calls' ? `${r.side} · ${r.label}` : r.picked)}</b><small>${esc(r.probability_pct == null ? 'Probability not available' : `${r.probability_pct}% forecast probability`)}${type === 'temperature' && r.market_picked ? ` · market favourite ${esc(r.market_picked)} (${r.market_pct}%)` : ''}</small></td><td><b>${esc(r.actual || 'Not settled')}</b>${type === 'temperature' && r.official_f != null ? `<small>official ${r.official_f}°F${r.nbm_f != null ? ` · NBM guidance ${r.nbm_f}°F (${r.error_f > 0 ? '+' : ''}${r.error_f})` : ''}</small>` : ''}</td><td><a href="/events/${encodeURIComponent(r.slug || '')}">Event record →</a></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="result-empty card">${state.tab === 'official' && !all.length ? 'Official picks are active. The first official pick will be the next eligible rain YES/NO call, locked before its event window; it will appear here as PENDING until the venue settles.' : 'No eligible results for this filter.'}</p>`;
  pager($('rec-pager'), state.page, pages, (n) => { go({ page: n }); ledger(); $('rec-top')?.scrollIntoView({ block: 'start' }); });
}

function locked() {
  $('results-overview').innerHTML = '<div class="card result-empty"><strong>Official picks: active (rain YES/NO)</strong><p>Official PBE Picks and every recorded result, right or missed, are available to verified All Access members.</p></div>';
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
