// Event record blocks (Predictions V4): THE CALL -> THE FACTS -> MARKET VIEW -> PBE VS MARKET -> THE GRADE ->
// PERMANENT RECORD. Every number is read from the stored record: the PBE forecast + its frozen evidence packet,
// and venue observations (benchmarks, never inputs). No text is generated beyond fixed templates over those values.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const pctTxt = (v) => (v === null || v === undefined ? '—' : v < 1 ? '<1%' : v > 99 ? '>99%' : `${v}%`);
const role = (r) => r.replace(/_/g, ' ').toLowerCase();
const DIV_LABEL = { PBE_ABOVE_MARKET: 'PBE above market', PBE_BELOW_MARKET: 'PBE below market', PBE_MARKET_AGREEMENT: 'PBE / market agreement' };
const DIV_CLASS = { PBE_ABOVE_MARKET: 'dpos', PBE_BELOW_MARKET: 'dneg', PBE_MARKET_AGREEMENT: '' };
const REASON_TEXT = {
  exceptions_differs: 'exception rules differ', measurement_unknown: 'measurement not stated identically', rounding_unknown: 'rounding not stated identically',
  window_tz_differs: 'time window differs', resolution_source_differs: 'resolution source differs', condition_differs: 'outcome condition differs', rules_changed_since_gate: 'rules changed since the last semantic check',
};
const reasons = (rs) => (rs || []).filter((r) => !/^reviewed_/.test(r)).map((r) => REASON_TEXT[r] || r.replace(/_/g, ' ')).join(' · ');
const venues = (o) => [o?.venues?.kalshi, o?.venues?.polymarket].filter(Boolean);

// THE CALL. While prediction-decision-v1 is DRAFT the public record shows the forecast only (no call state).
export function callBlock(h) {
  const c = h?.call;
  if (!c) return '';
  const d = c.decision?.official ? c.decision : null;
  const state = d ? (d.state === 'CALL' ? `CALL ${d.side}` : d.state) : null;
  return `<section class="card panel v4-call" aria-labelledby="call-h"><span class="v4-kicker">${d ? 'PBE CALL' : 'PBE FORECAST'}</span>
<h2 id="call-h" class="sr-only">${d ? 'The call' : 'The PBE forecast'} — ${esc(h.label)}</h2>
<div class="v4-callrow"><strong class="num v4-big">${state ? `${esc(state)} · ` : ''}${pctTxt(c.pbe_pct)}</strong><span class="v4-callmeta"><b>${esc(h.label)}</b><span>Confidence: <b>${esc(c.confidence || '—')}</b> · Model: <b class="mono">${esc(c.model)}</b> · ${esc((c.model_state || '').toLowerCase())}</span><span>Published ${utc(c.published_at)} · data cutoff ${utc(c.data_cutoff_at)}</span></span></div>
${d && d.state !== 'CALL' ? `<p class="note">${esc(d.reasons.join(' · ').replace(/_/g, ' ').toLowerCase())}</p>` : ''}
${c.summary ? `<p class="v4-summary">${esc(c.summary)}</p>` : ''}</section>`;
}

// THE FACTS: material drivers from the frozen packet, the context evidence, and the source ledger.
export function factsBlock(h) {
  const p = h?.call?.evidence;
  if (!p) return '';
  const drivers = p.drivers.map((x) => `<li class="ev-item"><div><b>${esc(x.label)}</b><small>${x.source ? `${esc(x.source.name)}${x.source.run ? ` · run ${utc(x.source.run)}` : ''}${x.source.available_at ? ` · available ${utc(x.source.available_at)}` : ''}` : 'stored feature'} · <span class="mono">${esc(x.feature)}</span></small></div><strong class="num">${esc(x.display)}${esc(x.unit)}</strong></li>`).join('');
  const context = (p.context || []).map((x) => `<li class="ev-item"><div><b>${esc(x.label)}</b><small>${esc(x.detail || '')}</small></div><strong class="num">${esc(x.value)}${esc(x.unit)}</strong></li>`).join('');
  const ledger = p.sources.map((s) => `<li class="ev-item"><div><b>${esc(s.name)}</b><small>${esc([s.provider, s.station && `station ${s.station}`, s.run && `run ${utc(s.run)}`, s.available_at && `available ${utc(s.available_at)}`, s.latest_value_date && `latest ${s.latest_value_date}`, s.issued_at && `issued ${utc(s.issued_at)}`].filter(Boolean).join(' · '))}${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">source</a>` : ''}</small></div><span class="note">${esc(s.role || '')}</span></li>`).join('');
  const integrity = p.integrity.ok ? `Every model input was available at or before the data cutoff (${utc(p.data_cutoff_at)}); no market value is in the feature vector.` : `Integrity check failed: ${p.integrity.violations.map((v) => v.rule.replace(/_/g, ' ')).join(', ')}.`;
  return `<section class="card panel" aria-labelledby="facts-h"><h2 id="facts-h">Why PBE sees it — the frozen facts</h2>
${drivers ? `<ul class="ev-list">${drivers}</ul>` : ''}
${context ? `<details class="snap"><summary>Context evidence (${p.context.length})</summary><ul class="ev-list">${context}</ul></details>` : ''}
<details class="snap"><summary>Source ledger (${p.sources.length})</summary><ul class="ev-list">${ledger}</ul></details>
<p class="note">${esc(integrity)} Evidence hash <span class="mono">${esc((h.call.evidence_sha256 || '').slice(0, 16))}…</span> · feature snapshot <span class="mono">${esc((p.features_sha256 || '').slice(0, 12))}</span></p></section>`;
}

function venueRow(v) {
  const cur = v.current;
  const price = cur?.mid_pct !== null && cur?.mid_pct !== undefined ? pctTxt(cur.mid_pct) : cur ? '<span class="null-state">No quote</span>' : '<span class="null-state">Awaiting market</span>';
  const quote = cur ? `${cur.bid_pct !== null && cur.ask_pct !== null ? `bid ${cur.bid_pct} / ask ${cur.ask_pct} · ` : cur.mid_pct === null ? 'no two-sided quote · ' : ''}${cur.checked_at && cur.checked_at !== cur.observed_at ? `unchanged since ${utc(cur.observed_at)} · checked ${utc(cur.checked_at)}` : `observed ${utc(cur.observed_at)}`}${cur.freshness ? ` · ${cur.freshness.label}` : ''}` : 'no stored observation';
  const tag = v.comparable ? (v.semantic_class === 'EXACT_MATCH' ? '<span class="v4-tag ok">Exact match</span>' : '') : `<span class="v4-tag rel">${esc(v.display === 'native_price_unverified' ? 'UNVERIFIED · NOT COMPARED' : 'RELATED MARKET · RULES DIFFER')}</span>`;
  return `<li class="v4-vrow"><span class="v4-vname">${esc(v.venue_label)}</span><strong class="num">${price}</strong><span class="v4-vmeta">${tag}${esc(quote)}${!v.comparable && v.reasons?.length ? `<small>${esc(reasons(v.reasons))}</small>` : ''}</span>${v.url ? `<a class="v4-out" href="${esc(v.url)}" target="_blank" rel="noopener" aria-label="${esc(v.venue_label)} market">↗</a>` : '<span></span>'}</li>`;
}

// MARKET VIEW: venues independently (no consensus), each with its observation time; divergence only where comparable.
export function marketView(h) {
  const vs = venues(h);
  if (!vs.length) return '';
  const pbe = h.call ? `<li class="v4-vrow pbe"><span class="v4-vname">PBE</span><strong class="num">${pctTxt(h.call.pbe_pct)}</strong><span class="v4-vmeta">${esc(h.call.model)} · published ${utc(h.call.published_at)}</span><span></span></li>` : '';
  const divs = vs.filter((v) => v.divergence_now).map((v) => `<li><b class="num ${DIV_CLASS[v.divergence_now.label]}">PBE vs ${esc(v.venue_label)} ${sign(v.divergence_now.pts)} pts</b> · ${esc(DIV_LABEL[v.divergence_now.label])}</li>`).join('');
  return `<section class="card panel" aria-labelledby="mv-h"><h2 id="mv-h">Market view — ${esc(h.label)}</h2>
<ul class="v4-venues">${pbe}${vs.map(venueRow).join('')}</ul>
${divs ? `<ul class="v4-divs">${divs}</ul>` : ''}
<p class="note">Venue prices are PropBetEdge's own timestamped observations, shown as independent benchmarks after the PBE forecast exists — never averaged, never a model input. A PBE-vs-venue gap is shown only where the venue contract resolves exactly like the contract PBE models.</p></section>`;
}

// PBE VS MARKET: each public PBE checkpoint against each venue's latest observation AT OR BEFORE it, then movement.
export function pbeVsMarket(h) {
  const k = h?.venues?.kalshi; const pm = h?.venues?.polymarket;
  const rows = (k || pm)?.at_forecast || [];
  if (!h?.call || !rows.length) return '';
  const cell = (v, fid) => {
    if (!v) return '<td class="note">No comparable market</td><td></td>';
    const a = v.at_forecast.find((x) => x.forecast_id === fid);
    if (!a || a.benchmark === 'NO_OBSERVATION_AT_PBE_FORECAST') return '<td class="note">no observation at PBE forecast</td><td></td>';
    const b = a.benchmark;
    return `<td class="num">${pctTxt(b.mid_pct)}<br><small class="note">${utc(b.observed_at)}</small></td><td class="num ${a.divergence ? DIV_CLASS[a.divergence.label] : ''}">${a.divergence ? `${sign(a.divergence.pts)} pts` : v.comparable ? '—' : '<span class="note">not compared</span>'}</td>`;
  };
  const moved = [k, pm].filter((v) => v?.current && v.at_forecast.length).map((v) => {
    const last = v.at_forecast.at(-1);
    if (last.benchmark === 'NO_OBSERVATION_AT_PBE_FORECAST' || last.benchmark.mid_pct === null || v.current.mid_pct === null) return '';
    const d = v.current.mid_pct - last.benchmark.mid_pct;
    return `<li>${esc(v.venue_label)}: <b class="num">${pctTxt(last.benchmark.mid_pct)}</b> at the current PBE forecast → <b class="num">${pctTxt(v.current.mid_pct)}</b> now (${sign(d)} pts, observed ${utc(v.current.observed_at)})</li>`;
  }).filter(Boolean).join('');
  return `<section class="card panel" aria-labelledby="pvm-h"><h2 id="pvm-h">PBE vs market at each forecast</h2>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>PBE forecast</th><th>PBE</th><th>Kalshi then</th><th>PBE vs Kalshi</th><th>Polymarket then</th><th>PBE vs Polymarket</th></tr></thead><tbody>
${rows.map((r) => `<tr><td class="num">${utc(r.pbe_at)}<br><small class="note">${esc(r.roles.length ? r.roles.map(role).join(', ') : 'current')}</small></td><td class="num"><b>${pctTxt(r.pbe_pct)}</b></td>${cell(k, r.forecast_id)}${cell(pm, r.forecast_id)}</tr>`).join('')}
</tbody></table></div>
${moved ? `<p class="note" style="margin-top:8px"><b>Since the forecast</b></p><ul class="v4-divs">${moved}</ul>` : ''}
<p class="note">"Then" = the latest stored observation at or before the PBE forecast time; a later price never repairs it. No observation = none was stored before that moment, permanently.</p></section>`;
}

// THE GRADE: same contract, same outcome, same designated timestamp.
export function gradeBlock(rec) {
  const rows = rec.outcomes.flatMap((o) => (o.venue_scores || []).map((s) => ({ o, s })));
  if (!rows.length) return '';
  const v = (x) => (x.status === 'SCORED' ? `<td class="num">${x.brier.toFixed(3)}<br><small class="note">${pctTxt(x.mid_pct)} @ ${utc(x.observed_at)}</small></td>` : `<td class="note">${esc(x.status.replace(/_/g, ' ').toLowerCase())}</td>`);
  return `<section class="card panel" aria-labelledby="grade-h"><h2 id="grade-h">The grade — Brier score (lower is better)</h2>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Outcome</th><th>Checkpoint</th><th>Result</th><th>PBE</th><th>Kalshi</th><th>Polymarket</th></tr></thead><tbody>
${rows.map(({ o, s }) => `<tr><td>${esc(o.label)}</td><td>${esc(role(s.designation))}</td><td>${s.outcome ? 'YES' : 'NO'}</td><td class="num"><b>${s.pbe_brier !== undefined ? s.pbe_brier.toFixed(3) : '—'}</b></td>${v(s.kalshi)}${v(s.polymarket)}</tr>`).join('')}
</tbody></table></div><p class="note">Every venue is scored at the same designated timestamp as the PBE snapshot, from its latest stored observation at or before that moment. Losses are never hidden.</p></section>`;
}

// PERMANENT RECORD: identifiers that make the forecast citable and auditable.
export function permanentRecord(h, citation, slug) {
  const c = h?.call;
  return `<section class="card panel"><h2>Permanent record</h2>${c ? `<dl class="kv"><dt>Forecast ID</dt><dd class="mono">${esc(c.forecast_id)}</dd><dt>Published</dt><dd>${utc(c.published_at)}</dd><dt>Model</dt><dd class="mono">${esc(c.model)}</dd><dt>Evidence hash</dt><dd class="mono">${esc(c.evidence_sha256)}</dd><dt>Feature hash</dt><dd class="mono">${esc(c.evidence?.features_sha256 || '')}</dd></dl>` : ''}
<div class="cite" id="cite" style="margin-top:10px">${esc(citation)}</div><p class="note" style="margin-top:8px">Machine-readable: <a href="/api/event/${esc(slug)}">/api/event/${esc(slug)}</a></p></section>`;
}

