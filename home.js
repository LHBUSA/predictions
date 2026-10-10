// / — Homepage V2 (issue #50, owner direction 2026-10-09). One glance: live, independent, evidence-backed.
// Six sections, small capped datasets, never the 60-event desk:
//   1 hero + LIVE SPOTLIGHT (member: /api/featured — largest COMPARABLE gap, 24 h stored path, source drivers;
//     guest: public prices + provenance, PBE locked)   2 Global Intelligence Pulse (/api/preview/pulse + BTC nowcast)
//   3 model-vs-market comparisons (rest of /api/featured)   4 scoreboard (member results board ?limit=3 / public scoring)
//   5 product previews + latest Insight (lazy)   6 value strip.
// Paid numbers come only from gated routes. Every payload is rendered by its own `audience`, never by a page flag, so a
// preview response can never be shown as member data (the "PBE null" defect).

// Old homepage anchors became real pages: one-time redirect (keeps every shared/bookmarked deep link working).
(function legacyAnchors() {
  const to = { '#desk': '/desk/', '#calendar': '/calendar/', '#track-record': '/track-record/', '#picks-results': '/track-record/', '#models': '/models/' }[location.hash];
  const cat = new URLSearchParams(location.search).get('category');
  if (to) location.replace(to + (to === '/desk/' && cat ? `?category=${encodeURIComponent(cat)}` : ''));
  else if (cat) location.replace(`/desk/?category=${encodeURIComponent(cat)}`);
})();

let member = false;
const finitePct = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
// a probability cell: a real number, or an honest word — never the string "null"
const pctCell = (v, missing = 'No quote') => (finitePct(v) ? `<strong class="num">${pctTxt(v)}</strong>` : `<strong class="null-state">${missing}</strong>`);
const FRESH = { live: 'live', delayed: 'delayed', stale: 'stale' };

// ---- engine line (hero): real last cycle + three counts, no stat-card wall
function stats(s) {
  const eng = s.engine || null; const cad = eng && Number.isFinite(eng.cadence_minutes) ? eng.cadence_minutes : null;
  const line = $('engine-line'); if (!line) return;
  line.hidden = false;
  $('e-live').textContent = s.live_contracts.toLocaleString(); $('e-modeled').textContent = s.modeled_contracts.toLocaleString();
  $('e-scored').textContent = s.resolved_scored.toLocaleString();
  const cyc = $('e-cycle'); cyc.hidden = !s.last_engine_cycle;
  $('e-cycle-ago').dataset.ago = s.last_engine_cycle || ''; $('e-cycle-ago').textContent = s.last_engine_cycle ? ago(s.last_engine_cycle) : '';
  $('e-cycle-sub').textContent = s.last_engine_cycle ? `${utcHM(s.last_engine_cycle)}${cad ? ` · every ${cad} min` : ''}` : '';
  liveStatus(s);
}

// ---- probability movement chart: stored observations only (PBE held until replaced; Kalshi broken on gaps > gap_ms;
// the venue line ends at its last observation). No smoothing, no interpolation.
function moveChart(sp) {
  const W = 560, H = 168, L = 34, R = 10, T = 10, B = 22;
  const t0 = Date.parse(sp.from), t1 = Date.parse(sp.to);
  const vals = [...sp.pbe, ...sp.kalshi].map((p) => p.v).filter(finitePct);
  if (!vals.length) return '';
  let lo = Math.max(0, Math.floor((Math.min(...vals) - 6) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...vals) + 6) / 10) * 10);
  if (hi - lo < 20) { hi = Math.min(100, lo + 20); lo = Math.max(0, hi - 20); }
  const x = (t) => (L + ((Math.max(t0, Math.min(t1, t)) - t0) / Math.max(1, t1 - t0)) * (W - L - R)).toFixed(1);
  const y = (v) => (T + (1 - (v - lo) / (hi - lo)) * (H - T - B)).toFixed(1);
  const path = (pts, holdTo, gap) => pts.filter((p) => finitePct(p.v)).map((p, i, a) => {
    const tp = Date.parse(p.t); const nextT = a[i + 1] ? Date.parse(a[i + 1].t) : null;
    const broken = i > 0 && gap && tp - Date.parse(a[i - 1].t) > gap;
    const end = nextT !== null ? (gap && nextT - tp > gap ? tp : nextT) : (holdTo ?? tp);
    return `${i === 0 || broken ? 'M' : 'L'}${x(tp)},${y(p.v)} H${x(end)}`;
  }).join(' ');
  const grid = [lo, (lo + hi) / 2, hi].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="mc-grid"/><text x="${L - 6}" y="${(+y(v) + 4).toFixed(1)}" class="mc-ax" text-anchor="end">${Math.round(v)}%</text>`).join('');
  const ticks = [0, 0.5, 1].map((f) => { const t = t0 + f * (t1 - t0); return `<text x="${x(t)}" y="${H - 6}" class="mc-ax" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${f === 1 ? 'now' : utcHM(new Date(t).toISOString()).replace(' UTC', '')}</text>`; }).join('');
  const lastP = sp.pbe.at(-1); const lastK = sp.kalshi.at(-1);
  const dot = (p, cls, hold) => (p && finitePct(p.v) ? `<circle cx="${x(hold ? t1 : Date.parse(p.t))}" cy="${y(p.v)}" r="3.5" class="${cls}"/>` : '');
  const label = `Last 24 hours, stored observations only. PBE ${lastP ? `${lastP.v}%` : 'n/a'}; Kalshi ${lastK ? `${lastK.v}% observed ${utcHM(lastK.t)}` : 'not observed'}.`;
  return `<svg class="move-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none"><title>${esc(label)}</title>${grid}${ticks}
    ${sp.kalshi.length ? `<path d="${path(sp.kalshi, null, sp.gap_ms)}" class="mc-k"/>` : ''}${sp.pbe.length ? `<path d="${path(sp.pbe, t1, null)}" class="mc-p"/>` : ''}${dot(lastK, 'mc-kd', false)}${dot(lastP, 'mc-pd', true)}</svg>
    <div class="mc-key"><span><i class="k-p"></i>PBE forecast</span><span><i class="k-k"></i>Kalshi mid (same contract)</span><span>24 h · stored observations · gaps shown</span></div>`;
}

// ---- 1. LIVE SPOTLIGHT
const spotFrame = (head, body, foot) => `<div class="spot-head"><span class="spot-live"><i></i>Live spotlight</span></div>${head}${body}<div class="spot-foot">${foot}</div>`;
function spotMember(d) {
  const el = $('spot'); if (!el) return;
  const e = d.events[0] || d.watch?.[0] || null;
  if (!e) { el.innerHTML = spotFrame('', '<p class="spot-note">No modeled event is open right now. The engine publishes the next forecast as soon as a contract qualifies.</p>', '<a class="spot-cta" href="/desk/">Open the Intelligence Desk →</a>'); return; }
  const h = e.headline || {}; const comparable = d.events[0] === e; const k = h.venues?.kalshi || null;
  const w = h.why || null;
  const nums = `<div class="spot-nums">
    <div class="sn-p"><span>PBE forecast</span>${pctCell(h.pbe_pct, 'Not modeled')}</div>
    <div class="sn-k"><span>Kalshi${comparable && k?.freshness ? ` · ${FRESH[k.freshness] || ''}` : ''}</span>${pctCell(comparable ? h.market_pct : null, 'No comparable quote')}</div>
    <div class="sn-d"><span>Model vs market</span>${comparable ? `<strong class="num ${dcls(h.divergence_pts)}">${pts(h.divergence_pts)}</strong>` : '<strong class="null-state">Not comparable</strong>'}</div></div>`;
  const chart = h.spark ? moveChart(h.spark) : '';
  const drivers = (w?.drivers || []).slice(0, 3);
  const why = w ? `<div class="spot-why"><h4>Why the model says ${pctTxt(h.pbe_pct)}</h4>${drivers.length ? `<ul>${drivers.map((x) => `<li><span>${esc(x.label)}</span><b class="num">${esc(x.display)}${esc(x.unit || '')}</b>${x.source ? `<small>${esc(x.source)}${x.available_at ? ` · ${utcHM(x.available_at)}` : ''}</small>` : ''}</li>`).join('')}</ul>` : '<p class="spot-note">This model family records its source ledger without a single dominant driver.</p>'}
    <p class="spot-stamp">${esc(w.model)} · ${esc(w.model_state || '')} · data cutoff ${utcHM(w.data_cutoff_at)} · published ${utcHM(w.published_at)}${comparable && k?.observed_at ? ` · Kalshi observed ${utcHM(k.observed_at)}` : ''}</p></div>` : '';
  const head = `<div class="spot-meta"><span class="spot-chip">${comparable ? 'Largest comparable gap' : 'Watch · no comparable quote'}</span><span>${esc(e.category_label)}</span>${badge(e.state)}<span>closes in ${untilEl(e.close_time)}</span></div>
    <h3><a href="${esc(e.url)}">${esc(e.title)}</a></h3>${h.label ? `<p class="spot-outcome">Outcome: <b>${esc(h.label)}</b></p>` : ''}`;
  el.innerHTML = spotFrame(head, nums + (chart ? `<div class="spot-chart">${chart}</div>` : '') + why, `<a class="spot-cta" href="${esc(w?.record_url || e.url)}">Open the full evidence →</a>`);
}
function spotPreview(d) {
  const el = $('spot'); if (!el) return;
  const e = d.events[0]; if (!e) { el.closest('.hero-spot').hidden = true; return; }
  const h = e.headline || {};
  const head = `<div class="spot-meta"><span class="spot-chip">Live event</span><span>${esc(e.category_label)}</span>${badge(e.state)}<span>closes in ${untilEl(e.close_time)}</span></div>
    <h3><a href="${esc(e.url)}">${esc(e.title)}</a></h3>${h.label ? `<p class="spot-outcome">Market favorite: <b>${esc(h.label)}</b></p>` : ''}`;
  const nums = `<div class="spot-nums">
    <div class="sn-p"><span>PBE forecast</span><strong class="num">${LOCKED}</strong></div>
    <div class="sn-k"><span>Kalshi market</span>${pctCell(h.market_pct)}</div>
    <div class="sn-d"><span>Model vs market</span><strong class="num">${LOCKED_PTS}</strong></div></div>`;
  const prov = `<div class="spot-prov"><h4>With All Access, this card shows</h4><ul>
    <li><b>The 24-hour movement chart</b><small>Every stored PBE forecast against every stored Kalshi quote for the same contract</small></li>
    <li><b>Why the model moved</b><small>The source data behind the forecast: station observations, official forecasts, release values, each with its time</small></li>
    <li><b>The model-vs-market gap</b><small>Only when the market quote is for the identical contract and fresh</small></li></ul>
    <p class="spot-stamp">${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled · market data updated ${utcHM(e.updated_at)}</p></div>`;
  el.innerHTML = spotFrame(head, nums + prov, `<a class="spot-cta" href="${AA_URL}" data-purchase-cta data-pbe-placement="predictions_home_spotlight">Unlock the live model →</a>`);
}

// ---- 3. comparisons (member): ranked COMPARABLE gaps after the spotlight, then honest watch cards. Guest: public prices.
const featCard = (e, pbe, mkt, div, cls) => `<a class="card feat ${cls}" href="${esc(e.url)}">
    <div class="row-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}<span>closes in ${untilEl(e.close_time)}</span></div>
    <h3>${esc(e.title)}</h3><div class="outcome">${e.headline?.label ? `Outcome: <b>${esc(e.headline.label)}</b> · ` : ''}${e.outcomes_modeled}/${e.outcomes_total} outcomes modeled</div>
    <div class="trio"><div><span>PBE</span>${pbe}</div><div><span>Market</span>${mkt}</div><div><span>Gap</span>${div}</div></div></a>`;
function compareCards(d) {
  const el = $('featured'); if (!el) return;
  const sec = el.closest('section');
  if (d.audience === 'member') {
    const gaps = d.events.slice(1); const watch = d.events.length ? (d.watch || []) : (d.watch || []).slice(1);
    const cards = [...gaps.map((e) => [e, true]), ...watch.map((e) => [e, false])].slice(0, 3);
    sec.hidden = !cards.length; if (!cards.length) return;
    const n = d.comparable_count;
    $('featured-title').textContent = gaps.length ? 'More model-vs-market gaps' : 'Modeled events to watch';
    $('featured-sub').textContent = `${n} ${n === 1 ? 'event has' : 'events have'} a fresh market quote for the identical contract right now${n ? ', ranked by the size of the gap' : ''}. Events without one are shown as watch, never as a gap.`;
    el.innerHTML = cards.map(([e, cmp]) => featCard(e, pctCell(e.headline?.pbe_pct, 'Not modeled'),
      cmp ? pctCell(e.headline.market_pct) : '<strong class="null-state">No comparable quote</strong>',
      cmp ? `<strong class="num ${dcls(e.headline.divergence_pts)}">${pts(e.headline.divergence_pts)}</strong>` : '<strong class="null-state">Watch</strong>', cmp ? '' : 'feat-watch')).join('');
    return;
  }
  const rest = d.events.slice(1, 4);
  sec.hidden = !rest.length; if (!rest.length) return;
  $('featured-title').textContent = 'Closing next';
  $('featured-sub').textContent = 'Modeled events closing soonest, with the live market price. The PBE forecast and the model-vs-market gap are included with All Access.';
  el.innerHTML = rest.map((e) => featCard(e, `<strong class="num">${LOCKED}</strong>`, pctCell(e.headline?.market_pct), `<strong class="num">${LOCKED_PTS}</strong>`, '')).join('');
}

// member fetch failure: say what happened (fail closed) and drop anything rendered for another audience
function memberUnavailable(status) {
  const msg = status === 401 ? 'Your sign-in has expired. Sign in again to load the live model.' : status === 403 ? 'This account does not include All Access, so model numbers are not loaded.' : 'Member data is temporarily unavailable. Retrying automatically; no numbers are shown until it loads.';
  const el = $('spot'); if (el) el.innerHTML = spotFrame('', `<p class="spot-note" role="status">${esc(msg)}</p>`, '<a class="spot-cta" href="/desk/">Open the Intelligence Desk →</a>');
  const f = $('featured'); if (f) f.closest('section').hidden = true;
}

// ---- 2. GLOBAL INTELLIGENCE PULSE: one live observation per category (market price + whether PBE models it) and the
// separate BTC nowcast engine (labelled as its own engine and model state).
const pulseParts = { events: '', crypto: '' };
function renderPulse() { const el = $('pulse'); if (!el) return; el.innerHTML = pulseParts.events + pulseParts.crypto; el.closest('section').hidden = !el.innerHTML; }
function pulse(p) {
  pulseParts.events = p.categories.filter((c) => c.observation && finitePct(c.observation.market_pct)).map((c) => { const o = c.observation; return `<a class="pulse-tile" href="${esc(o.url)}">
    <div class="pt-head"><span class="pt-cat">${esc(c.label)}</span><span class="pt-state ${o.modeled ? 'is-modeled' : ''}">${o.modeled ? 'PBE modeled' : 'Market monitoring'}</span></div>
    <b class="pt-title">${esc(o.title)}</b>
    <div class="pt-row"><span>${esc(o.favorite || 'Market')}</span><strong class="num">${pctTxt(o.market_pct)}</strong></div>
    <div class="pt-bar" aria-hidden="true"><i style="width:${Math.max(2, o.market_pct)}%"></i></div>
    <small>Market price · closes in ${untilEl(o.close_time)} · ${c.modeled_events}/${c.events} events modeled</small></a>`; }).join('');
  renderPulse();
}
function cryptoPulse(n) {
  const f = n.latest_forecast; const k = n.markets?.kalshi; const pm = n.markets?.polymarket;
  const up = Math.round(f.p_up * 100); const mid = (q) => (q && Number.isFinite(q.mid) ? `${Math.round(q.mid * 100)}%` : '—');
  pulseParts.crypto = `<a class="pulse-tile pulse-crypto" href="/crypto/">
    <div class="pt-head"><span class="pt-cat">Crypto</span><span class="pt-state">Nowcast · ${esc(String(f.model_state || '').toLowerCase())}</span></div>
    <b class="pt-title">BTC up this 15-minute window? Closes ${utcHM(n.window.close_at)}</b>
    <div class="pt-row"><span>Nowcast P(up)</span><strong class="num">${up}%</strong></div>
    <div class="pt-row pt-sub"><span>Kalshi ${mid(k)}</span><span>Polymarket ${mid(pm)}</span></div>
    <div class="pt-bar" aria-hidden="true"><i style="width:${Math.max(2, up)}%"></i></div>
    <small>Separate 15-min engine · read-only market data · ${n.active ? 'live window' : 'last window'}</small></a>`;
  renderPulse();
}

// ---- 4. THE CALLS & THE SCOREBOARD. Three records, three denominators, never blended; losses shown.
let lastTrack = null;
function scoreMember(data) {
  const el = $('scoreboard'); if (!el) return;
  const top = data.top_outcome || { matched: 0, missed: 0, events: 0, rows: [] };
  const pro = data.prospective || { matched: 0, missed: 0, pending: 0, calls: 0, rows: [] };
  const off = data.official || { calls: 0 };
  const since = off.policy?.activated_at ? new Date(off.policy.activated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }) : null;
  const recent = [...(top.rows || []).map((r) => ({ ...r, kind: 'Temperature outcome', at: r.scored_at, line: `Top bucket <b>${esc(r.picked)}</b>${r.probability_pct != null ? ` (${r.probability_pct}%)` : ''} · actual <b>${esc(r.actual)}</b>` })),
    ...(off.rows || []).filter((r) => r.result !== 'PENDING').map((r) => ({ ...r, kind: 'Official pick', at: r.decided_at, line: `Called <b>${esc(r.side)}</b> on ${esc(r.label)}${r.probability_pct != null ? ` at ${r.probability_pct}%` : ''} · resolved <b>${esc(r.actual)}</b>` })),
    ...(pro.rows || []).filter((r) => r.result !== 'PENDING' && r.result !== 'VOID').map((r) => ({ ...r, kind: 'Research call', at: r.decided_at, line: `Called <b>${esc(r.side)}</b> on ${esc(r.label)}${r.probability_pct != null ? ` at ${r.probability_pct}%` : ''} · resolved <b>${esc(r.actual)}</b>` }))]
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 3);
  el.innerHTML = `<div class="sb-grid">
    <div class="sb-tile"><span>Temperature event outcomes</span><b class="num">${top.matched}/${top.events}</b><small>top bucket matched the winner · ${top.missed} missed · retrospective, one result per settled event</small><div class="sb-bar" aria-hidden="true"><i style="width:${top.events ? (top.matched / top.events) * 100 : 0}%"></i></div></div>
    <div class="sb-tile"><span>Research YES/NO calls</span><b class="num">${pro.matched}–${pro.missed}</b><small>${pro.pending} pending · frozen before resolution · research, not official picks</small></div>
    <div class="sb-tile"><span>Official picks · rain YES/NO</span>${off.calls ? `<b class="num">${off.matched}–${off.missed}</b><small>${off.pending} pending${off.void ? ` · ${off.void} void` : ''} · forward official decisions only${since ? ` · since ${esc(since)}` : ''}</small>` : `<b>Active</b><small>${since ? `since ${esc(since)} · ` : ''}first official pick = the next eligible rain call, locked before its window</small>`}</div>
    <div class="sb-tile"><span>Contracts scored</span><b class="num" id="sb-n">—</b><small id="sb-brier">stored scores · not wins</small></div></div>
    ${recent.length ? `<h3 class="sb-h">Latest settled</h3><ul class="sb-rows">${recent.map((r) => `<li><span class="result-pill ${r.result === 'MATCHED' ? 'result-pill--hit' : r.result === 'MISSED' ? 'result-pill--miss' : 'result-pill--pending'}">${r.result === 'MATCHED' ? 'RIGHT' : r.result === 'MISSED' ? 'MISSED' : esc(r.result)}</span><span class="sb-kind">${esc(r.kind)}</span><a href="/events/${encodeURIComponent(r.slug || '')}">${esc(r.title)}</a><small>${r.line}</small></li>`).join('')}</ul>` : ''}`;
  if (lastTrack) scoring(lastTrack);
}
function scoring(t) {
  lastTrack = t;
  const g = (d, m) => t.groups.find((x) => x.designation === d && x.method === m);
  const b = g('FINAL_PRE_RESOLUTION', 'brier'); const l = g('FINAL_PRE_RESOLUTION', 'log_loss'); const enough = t.resolved_contracts >= t.min_for_claims;
  if (member) {
    if ($('sb-n')) { $('sb-n').textContent = t.resolved_contracts.toLocaleString(); $('sb-brier').textContent = b && enough && b.paired_pbe_mean != null ? `Brier ${b.paired_pbe_mean.toFixed(3)} vs market ${b.market_mean.toFixed(3)} on the same ${b.market_n} contracts · lower is better · not wins` : 'stored scores · not wins'; }
    return;
  }
  const el = $('scoreboard'); if (!el) return;
  el.innerHTML = `<div class="sb-grid">
    <div class="sb-tile"><span>Contracts scored</span><b class="num">${t.resolved_contracts.toLocaleString()}</b><small>every resolved contract with a stored forecast · not a win count</small></div>
    <div class="sb-tile"><span>Brier · same contracts as the market</span><b class="num">${b && enough && b.paired_pbe_mean != null ? b.paired_pbe_mean.toFixed(3) : 'Pending'}</b><small>${b?.paired_pbe_mean != null ? `market ${b.market_mean.toFixed(3)} on the same ${b.market_n} contracts · lower is better` : 'lower is better'}</small></div>
    <div class="sb-tile"><span>Log loss · same contracts</span><b class="num">${l && enough && l.paired_pbe_mean != null ? l.paired_pbe_mean.toFixed(3) : 'Pending'}</b><small>${l?.paired_pbe_mean != null ? `market ${l.market_mean.toFixed(3)} on the same ${l.market_n} · lower is better` : 'lower is better'}</small></div>
    <div class="sb-tile"><span>Official picks · rain YES/NO</span><b>Active</b><small>activated Oct 9, 2026 · tracked RIGHT / MISSED / PENDING / VOID · picks and results for All Access members</small></div></div>
    <p class="rp-lock">Members see every settled result: temperature event outcomes and research calls, wins and losses, with the evidence behind each. <a href="${AA_URL}" data-purchase-cta data-pbe-placement="predictions_home_results">Get All Access →</a></p>`;
}

// ---- 5. product previews: real status only
function products(s) { const d = $('pv-desk'); if (d) d.innerHTML = `<b class="num">${s.live_events}</b> live events · <b class="num">${s.modeled_contracts}</b> modeled contracts`; }
function cryptoPreview(n) { const el = $('pv-crypto'); if (el) el.innerHTML = `BTC 15-min · nowcast P(up) <b class="num">${Math.round(n.latest_forecast.p_up * 100)}%</b> · ${n.active ? 'live window' : 'last window'}`; }
function insight(i) {
  const el = $('latest-insight'); if (!el || !i?.title) return;
  el.innerHTML = `<span class="li-k">Latest Insight</span><a href="${esc(i.url)}">${esc(i.title)}</a><small>${new Date(i.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${i.family ? ` · ${esc(i.family)}` : ''}</small>`;
  el.hidden = false;
}

// ---- data. Member reads report their status, so a 401/403/503 fails closed instead of leaving stale cards.
async function memberRead(name, path) {
  const r = await fetch(`${API}/${path}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) { live.sig[name] = undefined; return { status: r.status }; }
  const body = await r.text(); if (body === live.sig[name]) return {};
  live.sig[name] = body; return { data: JSON.parse(body) };
}
// a response fetched for one audience is dropped if membership changed while it was in flight; then re-read
const changed = (asMember, name) => { if (asMember === member) return false; live.sig[name] = undefined; setTimeout(() => pull(name), 0); return true; };
PBE.datasets.summary = { ms: 60e3, run: async () => { const v = await sigFetch('summary', 'summary'); if (v) { stats(v); products(v); } } };
PBE.datasets.featured = { ms: 60e3, run: async () => {
  const asMember = member;
  if (asMember) {
    const r = await memberRead('featured', 'featured'); if (changed(asMember, 'featured')) return;
    if (r.status) return memberUnavailable(r.status);
    if (r.data?.audience === 'member') { spotMember(r.data); compareCards(r.data); }
    return;
  }
  const v = await sigFetch('featured', 'preview/featured'); if (changed(asMember, 'featured')) return;
  if (v?.audience === 'preview') { spotPreview(v); compareCards(v); }
} };
PBE.datasets.pulse = { ms: 120e3, run: async () => { const v = await sigFetch('pulse', 'preview/pulse'); if (v) pulse(v); } };
PBE.datasets.crypto = { ms: 60e3, run: async () => { const v = await sigFetch('crypto', 'crypto/nowcast'); if (v?.ok && v.window && v.latest_forecast) { cryptoPulse(v); cryptoPreview(v); } } };
PBE.datasets.track = { ms: 300e3, run: async () => { const v = await sigFetch('track', 'track-record'); if (v) scoring(v); } };
PBE.datasets.results = { ms: 300e3, run: async () => {
  const asMember = member; if (!asMember) return;
  const r = await memberRead('results', 'premium/results-board?limit=3'); if (changed(asMember, 'results')) return;
  if (r.status && $('scoreboard')) { $('scoreboard').innerHTML = '<p class="spot-note" role="status">Member results are temporarily unavailable. Retrying automatically.</p>'; return; }
  if (r.data) scoreMember(r.data);
} };
// the latest Insight line is read once, only when its section nears the viewport (never on initial paint)
(function lazyInsight() {
  const el = $('latest-insight'); if (!el) return;
  const go = () => fetch(`${API}/preview/latest-insight`).then((r) => (r.ok ? r.json() : null)).then(insight).catch(() => {});
  if (!('IntersectionObserver' in window)) return void setTimeout(go, 3000);
  const io = new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: '300px' });
  io.observe(el);
})();

function onMembership(m) {
  if (!m?.entitled || member) return;
  member = true;
  document.documentElement.classList.add('is-member');
  live.sig.featured = undefined; live.sig.results = undefined; live.sig.track = undefined; // re-read the member versions now
  pull('featured'); pull('results'); pull('track');
}
document.addEventListener('pbe:membership', (ev) => onMembership(ev.detail));
if (window.PBE_MEMBERSHIP) onMembership(window.PBE_MEMBERSHIP);
bootLive();
