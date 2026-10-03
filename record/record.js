// Forecast record page. Renders only stored records from /api/contract/:id — PBE forecasts (versioned,
// immutable), Kalshi observations (linked back to Kalshi), the normalized contract and the resolution.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);
const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const local = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz || 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—');
const sign = (n) => `${n > 0 ? '+' : ''}${n}`;

function headline(c, e) {
  const d = c.detail?.climate_date;
  const when = d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  if (c.event_type === 'PRECIP_ANY') return `Will ${c.detail.city_label} record measurable rain on ${when}?`;
  if (c.event_type === 'MAX_TEMP_BUCKET') return `${c.detail.city_label} high on ${when}: ${c.outcome_label}?`;
  return e?.canonical_question || c.market_id;
}

function timeline(forecasts, path) {
  const pts = [...forecasts.map((f) => Date.parse(f.captured_at)), ...path.map((m) => Date.parse(m.t))];
  if (pts.length < 2) return '';
  const t0 = Math.min(...pts); const t1 = Math.max(...pts) || t0 + 1;
  const W = 640; const H = 180; const x = (t) => 30 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 50); const y = (p) => 10 + (1 - p / 100) * (H - 30);
  const line = (arr, color, dash) => arr.length ? `<polyline fill="none" stroke="${color}" stroke-width="2.4" ${dash ? 'stroke-dasharray="5 4"' : ''} points="${arr.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}"/>` : '';
  const mk = path.filter((m) => m.probability_pct !== null).map((m) => [Date.parse(m.t), m.probability_pct]);
  const pb = forecasts.map((f) => [Date.parse(f.captured_at), f.probability_pct]);
  const dots = pb.map(([t, p]) => `<circle cx="${x(t).toFixed(1)}" cy="${y(p).toFixed(1)}" r="4" fill="#1f67ad"/>`).join('');
  const grid = [0, 25, 50, 75, 100].map((p) => `<line x1="30" x2="${W - 20}" y1="${y(p)}" y2="${y(p)}" stroke="#e8eef5"/><text x="2" y="${y(p) + 4}" font-size="10" fill="#8aa0b6">${p}%</text>`).join('');
  return `<div class="tl"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PBE probability and market price over time">${grid}${line(mk, '#9badbf', true)}${line(pb, '#1f67ad')}${dots}</svg>
    <div class="legend"><span><i style="background:#1f67ad"></i>PBE forecast (each dot = an immutable published snapshot)</span><span><i style="background:#9badbf"></i>Kalshi mid price (observed)</span></div></div>`;
}

async function main() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { $('rec-title').textContent = 'No record selected.'; return; }
  const res = await fetch(`/api/contract/${encodeURIComponent(id)}`);
  if (!res.ok) { $('rec-title').textContent = 'Record not found.'; return; }
  const r = await res.json();
  const c = r.contract;
  const latest = r.forecasts.at(-1) || null;
  const lastMarket = [...r.market_path].reverse().find((m) => m.probability_pct !== null) || null;
  const kalshi = r.market_summary.kalshi_url;
  document.title = `${headline(c, r.event)} — PropBetEdge Predictions`;
  $('rec-overline').textContent = `FORECAST RECORD · ${c.domain} · ${c.market_id}`;
  $('rec-title').textContent = headline(c, r.event);
  $('rec-yes').innerHTML = `YES if <b>${esc(c.yes_condition || '')}</b>${c.station_id ? ` — station ${esc(c.station_id)} (${esc(c.location?.name || '')})` : ''}, as reported by ${esc(c.resolution_authority || '')}.`;

  const kpi = [];
  if (latest) kpi.push(`<div><span>PBE data model</span><strong>${latest.probability_pct}%<em>YES</em></strong><small>${esc(latest.model_id)}@${esc(latest.model_version)} · ${esc(latest.model_state)} · ${utc(latest.captured_at)}</small></div>`);
  else kpi.push(`<div><span>PBE data model</span><strong style="font-size:18px">Market monitoring</strong>${c.normalization_status === 'NORMALIZED' ? '' : `<small>${esc(c.status_reason)}</small>`}</div>`);
  if (lastMarket) kpi.push(`<div><span>Market</span><strong>${lastMarket.probability_pct}%<em>YES</em></strong><small>${kalshi ? `<a href="${esc(kalshi)}" target="_blank" rel="noopener">Kalshi ↗</a> · ` : ''}mid, observed ${utc(lastMarket.t)}</small></div>`);
  if (latest && lastMarket) {
    const d = latest.probability_pct - lastMarket.probability_pct;
    kpi.push(`<div class="div"><span>Divergence</span><strong>${sign(d)}<em>pts</em></strong><small>PBE vs current market price</small></div>`);
    $('rec-sentence').textContent = Math.abs(d) <= 2 ? 'PBE and the current market price agree within 2 points.' : `PBE sees a ${d > 0 ? 'higher' : 'lower'} probability of YES than the current market price.`;
  }
  $('rec-kpis').innerHTML = kpi.join('');

  if (latest?.explanation?.evidence?.length) {
    $('rec-why').hidden = false;
    $('rec-evidence').innerHTML = latest.explanation.evidence.map((e) => `<div class="ev-row"><div><b>${esc(e.label)}</b><small>${esc(e.detail || '')}</small></div><strong>${esc(e.value)}${esc(e.unit)}</strong></div>`).join('');
  }

  if (r.forecasts.length || r.market_path.length) {
    $('rec-timeline-card').hidden = false;
    $('rec-timeline').innerHTML = timeline(r.forecasts, r.market_path);
    const des = new Map();
    for (const d of r.designations) des.set(d.forecast_id, [...(des.get(d.forecast_id) || []), d.designation.replace(/_/g, ' ').toLowerCase()]);
    if (r.forecasts.length) {
      $('rec-history').innerHTML = `<table class="hist"><thead><tr><th>Published</th><th>PBE</th><th>Market then</th><th>Divergence</th><th>Model</th><th>Data cutoff</th><th>Quality</th><th>Scoring role</th></tr></thead><tbody>${r.forecasts.map((f) => `<tr><td>${utc(f.captured_at)}</td><td><b>${f.probability_pct}%</b></td><td>${f.market_probability_pct ?? '—'}${f.market_probability_pct != null ? '%' : ''}</td><td>${f.market_probability_pct != null ? `${sign(f.probability_pct - f.market_probability_pct)} pts` : '—'}</td><td>${esc(f.model_version)}</td><td>${utc(f.data_cutoff_at)}</td><td>${esc(f.confidence || '')}</td><td>${esc((des.get(f.forecast_id) || []).join(', '))}</td></tr>`).join('')}</tbody></table>`;
    }
  }

  if (r.resolution) {
    const x = r.resolution;
    $('rec-resolution-card').hidden = false;
    const sc = (d, m) => r.scores.find((s) => s.designation === d && s.scoring_method === m);
    const rows = ['FIRST_PUBLISHED', 'T_MINUS_24H', 'FINAL_PRE_RESOLUTION'].map((d) => { const b = sc(d, 'brier'); return b ? `<tr><td>${d.replace(/_/g, ' ').toLowerCase()}</td><td>${Number(b.score).toFixed(3)}</td><td>${b.benchmark_score != null ? Number(b.benchmark_score).toFixed(3) : '—'}</td></tr>` : ''; }).join('');
    $('rec-resolution').innerHTML = `<p><b>Venue settlement:</b> ${esc(String(x.venue_result).toUpperCase())}${x.venue_expiration_value ? ` (reported value ${esc(x.venue_expiration_value)})` : ''} · ${utc(x.venue_settled_at || x.resolved_at)}</p>
      <p><b>Independent official check:</b> ${x.official_outcome ? `${esc(x.official_outcome)} — ${esc(x.official_value)} ${esc(x.official_units)} · ${x.source_url ? `<a href="${esc(x.source_url)}" target="_blank" rel="noopener">${esc(x.official_source)}</a>` : esc(x.official_source)}` : 'not yet available'}${x.sources_agree === false ? ' · <b>sources disagree — flagged</b>' : ''}</p>
      ${rows ? `<table class="hist"><thead><tr><th>Scored snapshot</th><th>PBE Brier</th><th>Market Brier</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
  }

  const prov = latest?.provenance || [];
  $('rec-provenance').innerHTML = prov.map((p) => `<div class="prov"><b>${esc(p.source)} — ${esc(p.role || '')}</b><span>${esc(p.provider || '')}${p.station ? ` · station ${esc(p.station)}` : ''}${p.run ? ` · run ${utc(p.run)} (usable ${utc(p.available_at)})` : ''}${p.updated_at ? ` · issued ${utc(p.updated_at)}` : ''}${p.url ? ` · ${esc(p.url)}` : ''}${p.dataset ? ` · ${esc(p.dataset)}` : ''}</span></div>`).join('')
    + `<div class="prov"><b>Market observations — benchmark only, never a model input</b><span>Kalshi via the PropBetEdge canonical market service · ${r.market_path.length} stored observations${r.market_summary.first_observed ? ` · first observed ${utc(r.market_summary.first_observed.t)} (not necessarily the opening price)` : ''}</span></div>`;

  const L = c.location || {};
  const dl = [
    ['Station', `${c.station_id} — ${L.name || ''} (${L.icao || ''}, NWS ${L.wfo || ''})`],
    ['Coordinates', L.lat != null ? `${L.lat}, ${L.lon}` : ''],
    ['Measurement', c.measurement_definition],
    ['Threshold', c.event_type === 'PRECIP_ANY' ? '> 0.00 in' : c.yes_condition],
    ['Observation window', c.observation_start ? `${local(c.observation_start, c.timezone)} → ${local(c.observation_end, c.timezone)} (local standard-time climate day)` : ''],
    ['Resolution source', `${c.resolution_authority} — ${c.resolution_dataset || ''}`],
    ['Independent verification', c.verification_dataset],
    ['Rounding', c.rounding_rule],
    ['Exceptions', (c.exceptions || []).join(' · ')],
    ['Normalization', `${c.normalization_status}${c.status_reason ? ` (${c.status_reason})` : ''} · ${c.normalizer_version}`],
  ].filter(([, v]) => v);
  $('rec-contract').innerHTML = dl.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + `<dt>Venue rules</dt><dd><div class="rules">${esc(c.rules_primary || '')}</div></dd>`;

  if (latest?.confidence) {
    $('rec-quality-card').hidden = false;
    const ex = latest.explanation || {};
    $('rec-quality').innerHTML = `<span class="grade ${esc(latest.confidence)}">${esc(latest.confidence)}</span>
      <p style="font-size:12px;color:#5f7790">Rules ${esc(ex.quality_rules || '')}: HIGH = complete current NWS guidance (run ≤12 h old), lead ≤54 h (temperature ≤30 h), and this station's out-of-sample skill proven on 2025-26 data; MEDIUM = complete guidance up to 24 h old; LOW otherwise. Guidance age at publication: ${esc(ex.run_age_h)} h.</p>
      <p style="font-size:12px;color:#5f7790">Model state ${esc(latest.model_state)}: research models are not presented as validated edge. Calibration artifact ${esc(ex.artifact_version || '')}.</p>`;
  }

  $('rec-market').innerHTML = `${kalshi ? `<p><a href="${esc(kalshi)}" target="_blank" rel="noopener">View this market on Kalshi ↗</a></p>` : ''}
    <p style="font-size:12px;color:#5f7790">${lastMarket ? `Latest: ${lastMarket.probability_pct}% (bid ${lastMarket.bid_pct ?? '—'}% / ask ${lastMarket.ask_pct ?? '—'}%), status ${esc(lastMarket.status)}, lifecycle ${esc(lastMarket.lifecycle)}.` : ''}</p>
    <p style="font-size:12px;color:#5f7790">Market probability = mid of best bid/ask when the spread is ≤10¢. PBE does not claim guaranteed profit or certainty.</p>`;
}

main().catch((e) => { $('rec-title').textContent = 'This record could not be loaded.'; console.error(e); });
