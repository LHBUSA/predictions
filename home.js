// / — executive overview (issue #50). Deliberately small: 4 KPIs, 3 featured events, a 5-row results preview and links
// into the deep pages. The full desk, results ledger, calendar and model registry live on /desk/, /track-record/,
// /calendar/ and /models/ and are never fetched or rendered here. Paid numbers come only from gated routes.

// Old homepage anchors became real pages: one-time redirect (keeps every shared/bookmarked deep link working).
(function legacyAnchors() {
  const to = { '#desk': '/desk/', '#calendar': '/calendar/', '#track-record': '/track-record/', '#picks-results': '/track-record/', '#models': '/models/' }[location.hash];
  const cat = new URLSearchParams(location.search).get('category');
  if (to) location.replace(to + (to === '/desk/' && cat ? `?category=${encodeURIComponent(cat)}` : ''));
  else if (cat) location.replace(`/desk/?category=${encodeURIComponent(cat)}`);
})();

let member = false;

// KPI strip: exactly four, named for what they count (contracts, not wins).
function stats(s) {
  $('s-live').textContent = s.live_contracts.toLocaleString(); $('s-live-sub').textContent = `${s.live_events} events · ${Object.keys(s.by_category).length} categories`;
  $('s-modeled').textContent = s.modeled_contracts.toLocaleString();
  $('s-scored').textContent = s.resolved_scored.toLocaleString(); $('s-scored-sub').textContent = s.resolved_scored ? 'contracts with stored scores (not wins)' : 'first settlements pending';
  const eng = s.engine || null;
  const cad = eng && Number.isFinite(eng.cadence_minutes) ? eng.cadence_minutes : null;
  // No-empty-state rule: with no successful recorded run yet, the engine card is not rendered at all.
  const cycleCard = $('s-cycle').closest?.('.stat');
  if (cycleCard) cycleCard.hidden = !s.last_engine_cycle;
  $('s-cycle').dataset.ago = s.last_engine_cycle || '';
  $('s-cycle').textContent = s.last_engine_cycle ? ago(s.last_engine_cycle) : '';
  $('s-cycle-sub').textContent = s.last_engine_cycle ? `${new Date(s.last_engine_cycle).toISOString().slice(11, 16)} UTC${cad ? ` · core every ${cad} min` : ''}` : '';
  liveStatus(s);
}

// Three featured events. Member: the three largest model-vs-market divergences (gated /api/featured). Public: the three
// soonest-closing modeled events with a market price (/api/preview/featured; the PBE cell is a placeholder).
function featuredCards(d) {
  const el = $('featured'); if (!el) return;
  const top = (d?.events || []).slice(0, 3);
  el.closest('section').hidden = !top.length;
  if (!top.length) return;
  $('featured-sub').textContent = member ? 'The three largest gaps between the PBE forecast and the same contract’s market price right now.' : 'Three modeled events closing soonest. PBE probabilities and divergences are included with All Access.';
  el.innerHTML = top.map((e) => {
    const h = e.headline || {};
    const pbe = member ? `<strong class="num">${pctTxt(h.pbe_pct)}</strong>` : `<strong class="num">${LOCKED}</strong>`;
    const div = member ? (h.divergence_pts != null ? `<strong class="num ${dcls(h.divergence_pts)}">${pts(h.divergence_pts)}</strong>` : '<strong class="null-state">No comparable market</strong>') : `<strong class="num">${LOCKED_PTS}</strong>`;
    return `<a class="card feat" href="${esc(e.url)}">
    <div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}<span>closes in ${untilEl(e.close_time)}</span></div>
    <h3>${esc(e.title)}</h3><div class="outcome">${h.label ? `Outcome: <b>${esc(h.label)}</b> · ` : ''}${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled</div>
    <div class="trio"><div><span>PBE</span>${pbe}</div><div><span>Market</span><strong class="num">${h.market_pct != null ? pctTxt(h.market_pct) : '—'}</strong></div><div><span>Divergence</span>${div}</div></div></a>`;
  }).join('');
}

// Results preview: <= 5 rows. Retrospective temperature outcomes and prospective research calls stay separate; official
// picks are not activated. Members: gated results board. Public: the aggregate scoring record only.
function resultsPreview(data) {
  const el = $('results-preview'); if (!el) return;
  const top = data.top_outcome || { matched: 0, missed: 0, events: 0, rows: [] };
  const pro = data.prospective || { matched: 0, missed: 0, pending: 0, calls: 0 };
  const off = data.official || { calls: 0 };
  const rows = (top.rows || []).slice(0, 5);
  el.innerHTML = `<div class="rp-sum">
      <div><span>Temperature outcomes</span><b class="num">${top.matched} right · ${top.missed} missed</b><small>of ${top.events} settled events · retrospective</small></div>
      <div><span>Research calls</span><b class="num">${pro.matched}–${pro.missed}</b><small>${pro.pending} pending · prospective, not official</small></div>
      <div><span>Official picks</span><b>${off.calls ? `${off.matched}–${off.missed}` : 'Not activated'}</b><small>${off.calls ? `${off.pending} pending` : 'no official win claim'}</small></div></div>
    ${rows.length ? `<ul class="rp-rows">${rows.map((r) => `<li><span class="result-pill ${r.result === 'MATCHED' ? 'result-pill--hit' : 'result-pill--miss'}">${r.result === 'MATCHED' ? 'RIGHT' : 'MISSED'}</span><a href="/events/${encodeURIComponent(r.slug || '')}">${esc(r.title)}</a><small>Model: <b>${esc(r.picked)}</b> · Actual: <b>${esc(r.actual)}</b></small></li>`).join('')}</ul>` : '<p class="note">No eligible settled results yet.</p>'}`;
}
function resultsPublic(t) {
  const el = $('results-preview'); if (!el) return;
  const g = (d, m) => t.groups.find((x) => x.designation === d && x.method === m);
  const b = g('FINAL_PRE_RESOLUTION', 'brier'); const enough = t.resolved_contracts >= t.min_for_claims;
  el.innerHTML = `<div class="rp-sum">
      <div><span>Contracts scored</span><b class="num">${t.resolved_contracts || 'Building'}</b><small>stored scores, not wins</small></div>
      <div><span>Accuracy (Brier)</span><b class="num">${b && enough ? b.pbe_mean.toFixed(3) : 'Pending'}</b><small>${b ? `market ${b.market_mean?.toFixed(3) ?? '—'} · lower is better` : 'lower is better'}</small></div>
      <div><span>Official picks</span><b>Not activated</b><small>no official win claim</small></div></div>
    <p class="rp-lock">Members see every settled result: the model’s outcome, the actual winner, right or missed, with the evidence. <a href="${AA_URL}" data-purchase-cta data-pbe-placement="predictions_home_results">Get All Access →</a></p>`;
}

PBE.datasets.summary = { ms: 60e3, run: async () => { const v = await sigFetch('summary', 'summary'); if (v) stats(v); } };
PBE.datasets.featured = { ms: 60e3, run: async () => {
  const v = member ? await sigFetch('featured', 'featured', { credentials: 'same-origin' }) : await sigFetch('featured', 'preview/featured');
  if (v) featuredCards(v);
} };
PBE.datasets.results = { ms: 300e3, run: async () => {
  if (member) { const v = await sigFetch('results', 'premium/results-board?limit=5', { credentials: 'same-origin' }); if (v) resultsPreview(v); return; }
  const v = await sigFetch('results', 'track-record'); if (v) resultsPublic(v);
} };

function onMembership(m) {
  if (!m?.entitled || member) return;
  member = true;
  $('hero-member-cta')?.removeAttribute('hidden');
  live.sig.featured = undefined; live.sig.results = undefined; // re-read the member versions now
  pull('featured'); pull('results');
}
document.addEventListener('pbe:membership', (ev) => onMembership(ev.detail));
if (window.PBE_MEMBERSHIP) onMembership(window.PBE_MEMBERSHIP);
bootLive();
