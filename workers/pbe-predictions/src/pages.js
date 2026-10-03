// Server-rendered pages (served at predictions.propbetedge.ai via Vercel rewrites). Metadata, canonical URL, Open Graph
// and JSON-LD are in the initial HTML. Every number rendered is a stored observation or a stored PBE forecast.
export const SITE = 'https://predictions.propbetedge.ai';
const OG_DEFAULT = `${SITE}/og/default.png`;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const STATE_BADGE = { RESEARCH: 'b-research', VALIDATED: 'b-validated', OFFICIAL: 'b-official', MARKET_MONITORING: 'b-monitoring', MONITORING: 'b-monitoring', SHADOW: 'b-shadow', BACKTESTING: 'b-backtesting' };
export const badge = (state) => `<span class="badge ${STATE_BADGE[state] || 'b-monitoring'}">${esc(state === 'MARKET_MONITORING' ? 'Market monitoring' : state)}</span>`;

export function layout({ title, description, canonical, ogImage = OG_DEFAULT, jsonld = [], body, robots = 'index,follow', extraHead = '' }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${esc(robots)}">
<meta name="theme-color" content="#0e2a4a">
<meta property="og:type" content="website"><meta property="og:site_name" content="PropBetEdge Predictions">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css?v=20261003k">
${jsonld.map((j) => `<script type="application/ld+json">${jsonLd(j)}</script>`).join('\n')}
${extraHead}
</head><body>
<header class="topbar"><div class="wrap">
<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">P</span><span>PropBetEdge<small>PREDICTIONS</small></span></a>
<nav class="nav" aria-label="Primary"><a href="/#desk">Intelligence desk</a><a href="/#calendar">Calendar</a><a href="/models/">Models</a><a href="/#track-record">Track record</a><a href="/methodology/">Methodology</a></nav>
<div class="top-right"><span class="live-dot"><i></i>Live engine</span></div>
</div></header>
${body}
<footer class="footer"><div class="wrap">
<div><strong>PropBetEdge Predictions</strong><br>Independent model probabilities, stored separately from market prices. No retroactive rewrites.</div>
<div><strong>Records</strong><br>Immutable forecast snapshots, fixed scoring roles, venue and official resolution stored independently.</div>
<div><strong>Market data</strong><br>Kalshi prices are a benchmark, never a model input. Every Kalshi value links to Kalshi.</div>
<div><strong>Not advice</strong><br>Research-stage probabilities. A divergence is not a guarantee of anything.</div>
</div></footer>
</body></html>`;
}

function historyChart(outcome) {
  const fs = outcome.history.filter((h) => h.pct !== null);
  const ms = outcome.market_path.filter((m) => m.pct !== null);
  const ts = [...fs.map((h) => Date.parse(h.t)), ...ms.map((m) => Date.parse(m.t))];
  if (ts.length < 2) return '';
  const t0 = Math.min(...ts); const t1 = Math.max(...ts);
  const W = 720; const H = 220; const L = 38; const R = 12; const T = 10; const B = 26;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R); const y = (p) => T + (1 - p / 100) * (H - T - B);
  const grid = [0, 25, 50, 75, 100].map((p) => `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="#e9eff6"/><text x="4" y="${y(p) + 4}" font-size="11" fill="#8597a9">${p}%</text>`).join('');
  const step = (pts) => pts.map(([t, p], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(p).toFixed(1)}${i < pts.length - 1 ? ` H${x(pts[i + 1][0]).toFixed(1)}` : ''}`).join(' ');
  const mk = ms.map((m) => [Date.parse(m.t), m.pct]);
  const pb = fs.map((h) => [Date.parse(h.t), h.pct]);
  const lastX = x(t1);
  const pbExt = pb.length ? [...pb, [t1, pb.at(-1)[1]]] : [];
  const axis = [t0, t1].map((t, i) => `<text x="${i ? W - R : L}" y="${H - 6}" font-size="11" fill="#8597a9" text-anchor="${i ? 'end' : 'start'}">${new Date(t).toISOString().slice(5, 16).replace('T', ' ')}Z</text>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PBE forecast and market price over time for ${esc(outcome.label)}">${grid}${axis}
${mk.length > 1 ? `<path d="${step(mk)}" fill="none" stroke="#8a9db1" stroke-width="2" stroke-dasharray="4 4"/>` : ''}
${pbExt.length > 1 ? `<path d="${step(pbExt)}" fill="none" stroke="#1f63b5" stroke-width="2.5"/>` : ''}
${pb.map(([t, p]) => `<circle cx="${x(t).toFixed(1)}" cy="${y(p).toFixed(1)}" r="4" fill="#1f63b5"><title>PBE ${p}% · ${new Date(t).toISOString()}</title></circle>`).join('')}
<line x1="${lastX}" x2="${lastX}" y1="${T}" y2="${H - B}" stroke="#dde6f0"/></svg>
<div class="legend"><span><i style="background:#1f63b5"></i>PBE forecast (each dot is an immutable snapshot)</span><span><i style="background:#8a9db1"></i>Kalshi mid (observed)</span></div></div>`;
}

function distributionBlock(rec) {
  const d = rec.distribution;
  const outs = rec.outcomes;
  if (d?.kind === 'exclusive') {
    return `<div class="legend"><span><i style="background:#1f63b5"></i>PBE distribution (sums to 100%)</span><span><i style="background:#8a9db1"></i>Market (raw contract mid)</span></div>
${d.labels.map((l, i) => `<div class="dist-row"><div><b>${esc(l)}</b></div><div class="bars">
<div class="bar"><i style="width:${d.pbe[i]}%"></i></div><div class="bar m"><i style="width:${d.market_raw[i] ?? 0}%"></i></div>
<div class="bar-lbl"><span>PBE ${d.pbe[i]}%</span><span>Market ${d.market_raw[i] ?? '—'}${d.market_raw[i] !== null ? '%' : ''}${d.market_normalized ? ` · normalized ${d.market_normalized[i]}%` : ''}</span></div></div>
<div class="num ${d.market_raw[i] !== null ? (d.pbe[i] - d.market_raw[i] >= 0 ? 'dpos' : 'dneg') : ''}">${d.market_raw[i] !== null ? `${sign(d.pbe[i] - d.market_raw[i])} pts` : '—'}</div></div>`).join('')}
<p class="note">${esc(d.note)}${d.market_raw_sum !== null ? ` Raw market mids sum to ${d.market_raw_sum}%.` : ' Some outcomes have no two-sided market quote (spread over 10¢), so no normalized market distribution is shown.'}</p>`;
  }
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Outcome</th><th>PBE</th><th>Market</th><th>Divergence</th><th>Kalshi</th></tr></thead><tbody>
${outs.map((o) => `<tr><td><b>${esc(o.label)}</b>${o.status !== 'NORMALIZED' ? `<br><span class="note">${esc(o.reason || o.status)}</span>` : ''}</td><td class="num">${o.pbe_pct !== null ? `<b>${o.pbe_pct}%</b>` : '<span class="note">monitoring</span>'}</td><td class="num">${o.market_pct !== null ? `${o.market_pct}%` : '—'}</td><td class="num ${o.divergence_pts > 0 ? 'dpos' : o.divergence_pts < 0 ? 'dneg' : ''}">${o.divergence_pts !== null ? `${sign(o.divergence_pts)} pts` : '—'}</td><td>${o.kalshi_url ? `<a href="${esc(o.kalshi_url)}" rel="noopener" target="_blank">Kalshi ↗</a>` : ''}</td></tr>`).join('')}
</tbody></table></div>${d?.note ? `<p class="note">${esc(d.note)}</p>` : ''}`;
}

export function eventDescription(rec) {
  const h = headlineOutcome(rec);
  const base = rec.event.title.replace(/\?$/, '');
  if (h && h.pbe_pct !== null) return `PBE model ${h.pbe_pct}% vs market ${h.market_pct ?? '—'}% for "${h.label}". ${base}: exact resolution rule (${rec.contract?.resolution_authority || 'venue'}), immutable forecast history, evidence and provenance.`;
  return `${base}: live Kalshi market monitoring with the exact resolution rule. No PBE model is enabled for this event yet, so no PBE probability is shown.`;
}

export function headlineOutcome(rec) {
  const m = rec.outcomes.filter((o) => o.pbe_pct !== null);
  return [...m].filter((o) => o.divergence_pts !== null).sort((a, b) => Math.abs(b.divergence_pts) - Math.abs(a.divergence_pts))[0] || m[0] || rec.outcomes[0] || null;
}

export function renderEvent(rec) {
  const e = rec.event; const h = headlineOutcome(rec);
  const canonical = `${SITE}/events/${e.slug}`;
  const title = `${e.title.replace(/\?$/, '')} — forecast vs market | PropBetEdge Predictions`;
  const description = eventDescription(rec);
  const stale = e.latest_market_at && Date.now() - Date.parse(e.latest_market_at) > 3 * 3600000 && !['CLOSED', 'SETTLED'].includes(e.lifecycle);
  const c = rec.contract || {};
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'WebPage', '@id': canonical, url: canonical, name: title, description, dateModified: e.date_modified, isPartOf: { '@type': 'WebSite', name: 'PropBetEdge Predictions', url: SITE }, publisher: { '@type': 'Organization', name: 'PropBetEdge', url: 'https://propbetedge.ai' } },
    { '@context': 'https://schema.org', '@type': 'Dataset', name: `PBE forecast record: ${e.title}`, description: `Immutable PropBetEdge forecast snapshots${rec.model ? ` (${rec.model.id})` : ''}, stored market observations, exact resolution rule and resolution/score for "${e.title}".`, url: canonical, creator: { '@type': 'Organization', name: 'PropBetEdge', url: 'https://propbetedge.ai' }, dateModified: e.date_modified, datePublished: e.created_at, isAccessibleForFree: true, keywords: [e.category_label, 'forecast', 'prediction market', 'probability'], variableMeasured: ['PBE model probability', 'market-implied probability (Kalshi mid)', 'divergence (percentage points)'], distribution: [{ '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${SITE}/api/event/${e.slug}` }] },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Predictions', item: SITE }, { '@type': 'ListItem', position: 2, name: e.category_label, item: `${SITE}/?category=${encodeURIComponent(e.category)}#desk` }, { '@type': 'ListItem', position: 3, name: e.title, item: canonical }] },
  ];
  const kpis = h ? `<div class="kpis">
<div class="kpi"><span>PBE data model</span><strong class="num">${h.pbe_pct !== null ? `${h.pbe_pct}%` : '—'}</strong><small>${h.pbe_pct !== null ? `${esc(h.label)} · ${esc(h.model)}` : 'Market monitoring — no PBE model'}</small></div>
<div class="kpi"><span>Market</span><strong class="num">${h.market_pct !== null ? `${h.market_pct}%` : '—'}</strong><small>${h.kalshi_url ? `<a href="${esc(h.kalshi_url)}" target="_blank" rel="noopener">Kalshi ↗</a> · ` : ''}mid ${h.market_observed_at ? utc(h.market_observed_at) : ''}</small></div>
<div class="kpi"><span>Divergence</span><strong class="num ${h.divergence_pts > 0 ? 'dpos' : h.divergence_pts < 0 ? 'dneg' : ''}">${h.divergence_pts !== null ? `${sign(h.divergence_pts)}<small style="display:inline;font-size:14px"> pts</small>` : '—'}</strong><small>PBE vs current market price</small></div></div>
${h.divergence_pts !== null ? `<p class="headline">${Math.abs(h.divergence_pts) <= 2 ? 'PBE and the market agree within 2 points on this outcome.' : `PBE sees a ${h.divergence_pts > 0 ? 'higher' : 'lower'} probability of “${esc(h.label)}” than the current market price.`}</p>` : ''}` : '';
  const evidence = h?.evidence?.length ? `<section class="card panel"><h2>Why the model sees it — ${esc(h.label)}</h2><ul class="ev-list">${h.evidence.map((x) => `<li class="ev-item"><div><b>${esc(x.label)}</b><small>${esc(x.detail || '')}</small></div><strong class="num">${esc(x.value)}${esc(x.unit)}</strong></li>`).join('')}</ul></section>` : '';
  const snaps = rec.outcomes.filter((o) => o.history.length).map((o) => `<details class="snap"><summary>${esc(o.label)} — ${o.history.length} snapshot${o.history.length > 1 ? 's' : ''}${o.resolution ? ` · resolved ${esc(String(o.resolution.venue_result).toUpperCase())}` : ''}</summary>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Published</th><th>PBE</th><th>Market then</th><th>Model</th><th>Data cutoff</th><th>Quality</th><th>Scoring role</th><th>What changed</th></tr></thead><tbody>
${o.history.map((s) => `<tr><td class="num">${utc(s.t)}</td><td class="num"><b>${s.pct}%</b></td><td class="num">${s.market_pct ?? '—'}${s.market_pct !== null ? '%' : ''}</td><td>${esc(s.model)}</td><td class="num">${utc(s.cutoff)}</td><td>${esc(s.confidence || '')}</td><td>${esc(s.roles.map((r) => r.replace(/_/g, ' ').toLowerCase()).join(', '))}</td><td>${esc(s.changed.slice(0, 4).map((ch) => `${ch.feature}: ${typeof ch.from === 'object' ? '…' : ch.from} → ${typeof ch.to === 'object' ? '…' : ch.to}`).join('; '))}</td></tr>`).join('')}
</tbody></table></div>${o.scores.length ? `<p class="note">Scores (Brier, PBE vs market on the same snapshot): ${o.scores.filter((s) => s.method === 'brier').map((s) => `${s.designation.replace(/_/g, ' ').toLowerCase()} ${s.pbe.toFixed(3)} vs ${s.market === null ? '—' : s.market.toFixed(3)}`).join(' · ')}</p>` : ''}</details>`).join('');
  const resolved = rec.outcomes.filter((o) => o.resolution);
  const resolution = resolved.length ? `<section class="card panel"><h2>Resolution</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Outcome</th><th>Venue settlement</th><th>Official value</th><th>Agree</th></tr></thead><tbody>${resolved.map((o) => `<tr><td>${esc(o.label)}</td><td>${esc(String(o.resolution.venue_result).toUpperCase())}${o.resolution.venue_value ? ` (${esc(o.resolution.venue_value)})` : ''}</td><td>${o.resolution.official_outcome ? `${esc(o.resolution.official_outcome)} · ${esc(o.resolution.official_value)} ${esc(o.resolution.official_units)}` : 'pending'}${o.resolution.source_url ? ` · <a href="${esc(o.resolution.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</td><td>${o.resolution.sources_agree === null ? '—' : o.resolution.sources_agree ? 'yes' : '<b>no — flagged</b>'}</td></tr>`).join('')}</tbody></table></div></section>` : '';
  const prov = (h?.provenance || []).map((p) => `<li class="ev-item"><div><b>${esc(p.source)}</b><small>${esc([p.provider, p.station && `station ${p.station}`, p.run && `run ${utc(p.run)}`, p.latest_value_date && `latest ${p.latest_value_date}`, p.updated_at && `issued ${utc(p.updated_at)}`, p.dataset].filter(Boolean).join(' · '))}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">source</a>` : ''}</small></div><span class="note">${esc(p.role || '')}</span></li>`).join('');
  const L = c.location || {};
  const contract = rec.contract ? `<section class="card panel"><h2>Exactly how this resolves</h2><dl class="kv">
${c.station_id ? `<dt>Station / series</dt><dd>${esc(c.station_id)}${L.name ? ` — ${esc(L.name)} (${esc(L.icao || '')}${L.wfo ? `, NWS ${esc(L.wfo)}` : ''})` : ''}</dd>` : ''}
<dt>Measurement</dt><dd>${esc(c.measurement_definition || '—')}</dd>
${c.observation_start ? `<dt>Window</dt><dd>${utc(c.observation_start)} → ${utc(c.observation_end)} (${esc(c.timezone || 'UTC')})</dd>` : ''}
<dt>Resolution source</dt><dd>${esc(c.resolution_authority || '—')}${c.resolution_dataset ? ` — ${esc(c.resolution_dataset)}` : ''}</dd>
${c.verification_dataset ? `<dt>Independent check</dt><dd>${esc(c.verification_dataset)}</dd>` : ''}
${c.rounding_rule ? `<dt>Rounding</dt><dd>${esc(c.rounding_rule)}</dd>` : ''}
${(c.exceptions || []).length ? `<dt>Exceptions</dt><dd>${(c.exceptions || []).map(esc).join(' · ')}</dd>` : ''}
<dt>Normalization</dt><dd>${esc(c.normalization_status)}${c.status_reason ? ` (${esc(c.status_reason)})` : ''} · ${esc(c.normalizer || '')}</dd>
</dl>${c.rules_primary_example ? `<p class="note" style="margin-top:10px">Venue rule (example outcome):</p><div class="rules">${esc(c.rules_primary_example)}</div>` : ''}</section>` : '';
  const model = rec.model ? `<section class="card panel"><h2>Model</h2><dl class="kv"><dt>Family</dt><dd>${esc(rec.model.name)} (${esc(rec.model.id)})</dd><dt>State</dt><dd>${badge(rec.model.state)}</dd><dt>Versions here</dt><dd>${esc(rec.model.versions.join(', '))}</dd><dt>Inputs</dt><dd>${esc(rec.model.inputs)}</dd><dt>Data cutoff</dt><dd>${utc(h?.data_cutoff_at)}</dd>${h?.tier ? `<dt>Tier</dt><dd>${esc(h.tier)}</dd>` : ''}</dl><p class="note" style="margin-top:10px"><b>Known limitations:</b> ${rec.model.limitations.map(esc).join(' · ')}</p></section>` : '';
  const citation = `PropBetEdge Predictions. "${e.title}" forecast record${rec.model ? `, ${rec.model.id} (${rec.model.state.toLowerCase()})` : ''}. ${canonical} (retrieved ${new Date().toISOString().slice(0, 10)}).`;
  const body = `<main class="wrap">
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Predictions</a> › <a href="/?category=${encodeURIComponent(e.category)}#desk">${esc(e.category_label)}</a> › ${esc(e.venue_event_id)}</nav>
<header class="ev-head"><div class="ev-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}<span>${e.kalshi_url ? `<a href="${esc(e.kalshi_url)}" target="_blank" rel="noopener">${esc(e.venue)} ${esc(e.venue_event_id)} ↗</a>` : esc(e.venue_event_id)}</span></div>
<h1>${esc(e.title)}</h1>
<div class="ev-meta"><span>Latest PBE forecast: <b class="num">${utc(e.latest_forecast_at)}</b></span><span>Latest market observation: <b class="num">${utc(e.latest_market_at)}</b>${stale ? ' <span class="stale">· stale</span>' : ''}</span><span>Closes ${utc(e.close_time)}</span><span>${rec.outcomes.length} outcome${rec.outcomes.length > 1 ? 's' : ''}</span></div></header>
<div class="ev-grid"><div>
<section class="card panel">${kpis}</section>
<section class="card panel"><h2>${rec.distribution?.kind === 'exclusive' ? 'Outcome distribution — PBE vs market' : rec.distribution?.kind === 'threshold' ? 'Threshold curve — PBE vs market' : 'Outcomes — PBE vs market'}</h2>${distributionBlock(rec)}</section>
${h && (h.history.length || h.market_path.length) ? `<section class="card panel"><h2>Probability history — ${esc(h.label)}</h2>${historyChart(h)}</section>` : ''}
${evidence}
${rec.outcomes.some((o) => o.history.length) ? `<section class="card panel"><h2>Forecast snapshots (immutable archive)</h2>${snaps}</section>` : ''}
${resolution}
</div><aside>
${contract}
${model}
${prov ? `<section class="card panel"><h2>Provenance</h2><ul class="ev-list">${prov}<li class="ev-item"><div><b>Market observations — benchmark only, never a model input</b><small>Kalshi via the PropBetEdge canonical market service; first observed by PBE is not necessarily the opening price</small></div><span class="note">benchmark</span></li></ul></section>` : ''}
<section class="card panel"><h2>Cite this record</h2><div class="cite" id="cite">${esc(citation)}</div><p class="note" style="margin-top:8px">Machine-readable: <a href="/api/event/${esc(e.slug)}">/api/event/${esc(e.slug)}</a></p></section>
</aside></div></main>`;
  return layout({ title, description, canonical, jsonld, body });
}

export function renderNotFound(path) {
  return layout({ title: 'Not found | PropBetEdge Predictions', description: 'This record does not exist.', canonical: `${SITE}${path}`, robots: 'noindex', body: `<main class="wrap section"><h1>Record not found</h1><p class="empty-honest">There is no event at this address. <a href="/">Back to the intelligence desk</a>.</p></main>` });
}

export function sitemapXml(entries) {
  const urls = [
    { loc: `${SITE}/`, changefreq: 'hourly', priority: '1.0' },
    { loc: `${SITE}/models/`, changefreq: 'daily', priority: '0.6' },
    { loc: `${SITE}/methodology/`, changefreq: 'monthly', priority: '0.5' },
    ...entries.map((e) => ({ loc: `${SITE}/events/${e.slug}`, lastmod: (e.updated_at || '').slice(0, 10), changefreq: 'hourly', priority: '0.7' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}\n</urlset>\n`;
}
