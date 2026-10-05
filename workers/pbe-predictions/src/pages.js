// Server-rendered pages (served at predictions.propbetedge.ai via Vercel rewrites). Metadata, canonical URL, Open Graph
// and JSON-LD are in the initial HTML. Every number rendered is a stored observation or a stored PBE forecast.
export const SITE = 'https://predictions.propbetedge.ai';
const OG_DEFAULT = `${SITE}/og/predictions-card.jpg`;
// ONE PropBetEdge publisher identity across the network (defined in full on propbetedge.ai).
export const ORG_ID = 'https://propbetedge.ai/#organization';
export const NETWORK_WEBSITE_ID = 'https://propbetedge.ai/#website';
export const WEBSITE_ID = `${SITE}/#website`;
export const LOGO = { '@type': 'ImageObject', '@id': `${SITE}/#logo`, url: `${SITE}/brand/predictions-logo-512.png`, width: 512, height: 512, caption: 'PropBetEdge Predictions' };
export const ORG_NODE = { '@type': 'NewsMediaOrganization', '@id': ORG_ID, name: 'PropBetEdge', url: 'https://propbetedge.ai/', logo: { '@type': 'ImageObject', '@id': 'https://propbetedge.ai/#logo', url: 'https://propbetedge.ai/logo/pbe-full-400.png', width: 400, height: 100 } };
export const WEBSITE_NODE = { '@type': 'WebSite', '@id': WEBSITE_ID, name: 'PropBetEdge Predictions', url: `${SITE}/`, publisher: { '@id': ORG_ID }, isPartOf: { '@id': NETWORK_WEBSITE_ID }, image: LOGO, inLanguage: 'en' };
export const ASSET_V = '20261005aa3';
import { siteHeader, siteFooter, THEME_BOOT } from './network.js';
import { callBlock, factsBlock, marketView, pbeVsMarket, gradeBlock, permanentRecord, stationBlock } from './record-blocks.js';
import { liveWeatherBlock, atmosphereLayer } from './weather-blocks.js';
export const LIVE_V = '20261005aa1';
export const HEAD_ICONS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png"><link rel="icon" href="/favicon-16x16.png" sizes="16x16" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">`;
export const BRAND = `<a class="brand" href="/"><img class="brand-mark" src="/brand/predictions-mark.svg" width="32" height="32" alt=""><span>PropBetEdge<small>PREDICTIONS</small></span></a>`;
const NAV = [['desk', '/#desk', 'Intelligence desk'], ['insights', '/insights/', 'Insights'], ['calendar', '/#calendar', 'Calendar'], ['models', '/models/', 'Models'], ['record', '/#track-record', 'Track record'], ['methodology', '/methodology/', 'Methodology']];
export const nav = (current) => `<nav class="nav" aria-label="Primary">${NAV.map(([k, href, label]) => `<a href="${href}"${k === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;

// Native share controls: every URL is the canonical page URL. Web Share appears only where supported.
export function shareBar(url, text) {
  const u = encodeURIComponent(url); const t = encodeURIComponent(text);
  return `<div class="share" role="group" aria-label="Share"><span class="share-label">Share</span>
<button type="button" class="share-btn" data-copy="${esc(url)}">Copy link</button>
<a class="share-btn" href="https://x.com/intent/post?url=${u}&amp;text=${t}" target="_blank" rel="noopener">X</a>
<a class="share-btn" href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener">LinkedIn</a>
<a class="share-btn" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener">Facebook</a>
<button type="button" class="share-btn" data-share="${esc(url)}" data-title="${esc(text)}" hidden>Share…</button></div>`;
}
const SHARE_JS = `<script>(()=>{const n=navigator;document.querySelectorAll('[data-share]').forEach(b=>{if(n.share){b.hidden=false;b.addEventListener('click',()=>n.share({title:b.dataset.title,url:b.dataset.share}).catch(()=>{}))}});document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{try{await n.clipboard.writeText(b.dataset.copy);b.textContent='Link copied'}catch(e){b.textContent=b.dataset.copy}setTimeout(()=>{b.textContent='Copy link'},2400)}))})()</script>`;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const STATE_BADGE = { RESEARCH: 'b-research', VALIDATED: 'b-validated', OFFICIAL: 'b-official', MARKET_MONITORING: 'b-monitoring', MONITORING: 'b-monitoring', SHADOW: 'b-shadow', BACKTESTING: 'b-backtesting' };
export const badge = (state) => `<span class="badge ${STATE_BADGE[state] || 'b-monitoring'}">${esc(state === 'MARKET_MONITORING' ? 'Market monitoring' : state)}</span>`;

export function layout({ title, description, canonical, ogImage = OG_DEFAULT, ogImageAlt = '', ogType = 'website', jsonld = [], body, robots = 'index,follow,max-image-preview:large', extraHead = '', current = null }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${esc(robots)}">
<meta name="theme-color" content="#0e2a4a">${THEME_BOOT}
<meta property="og:type" content="${esc(ogType)}"><meta property="og:site_name" content="PropBetEdge Predictions">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">${ogImageAlt ? `<meta property="og:image:alt" content="${esc(ogImageAlt)}"><meta name="twitter:image:alt" content="${esc(ogImageAlt)}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(ogImage)}">
${HEAD_ICONS}
<link rel="stylesheet" href="/site.css?v=${ASSET_V}">
${jsonld.map((j) => `<script type="application/ld+json">${jsonLd(j)}</script>`).join('\n')}
${extraHead}
</head><body>
${siteHeader(current)}
${body}
${siteFooter()}
${body.includes('data-copy=') ? SHARE_JS : ''}
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
${outs.map((o) => `<tr><td><b>${esc(o.label)}</b>${o.status !== 'NORMALIZED' ? `<br><span class="note">${esc(o.reason || o.status)}</span>` : ''}</td><td class="num">${o.pbe_pct !== null ? `<b>${o.pbe_pct}%</b>` : '<span class="note">No PBE model</span>'}</td><td class="num">${o.market_pct !== null ? `${o.market_pct}%` : `<span class="note">${o.market_observed_at ? 'No two-sided quote' : 'Awaiting market'}</span>`}</td><td class="num ${o.divergence_pts > 0 ? 'dpos' : o.divergence_pts < 0 ? 'dneg' : ''}">${o.divergence_pts !== null ? `${sign(o.divergence_pts)} pts` : `<span class="note">${o.pbe_pct === null ? 'Not modeled' : 'No comparable market'}</span>`}</td><td>${o.kalshi_url ? `<a href="${esc(o.kalshi_url)}" rel="noopener" target="_blank">Kalshi ↗</a>` : ''}</td></tr>`).join('')}
</tbody></table></div>${d?.note ? `<p class="note">${esc(d.note)}</p>` : ''}`;
}

// Public metadata never carries a PBE probability or market comparison (owner contract 2026-10-05: Predictions is an
// All Access product). `shell` = premium.js publicEventShell.
export function eventDescription(shell) {
  const base = shell.event.title.replace(/\?$/, '');
  return shell.modeled
    ? `${base}: the PropBetEdge model probability vs the live market, evidence ledger, forecast history and the exact resolution rule. Included with PropBetEdge All Access ($29/month).`
    : `${base}: live market monitoring with the exact resolution rule. Included with PropBetEdge All Access ($29/month).`;
}

export function headlineOutcome(rec) {
  const m = rec.outcomes.filter((o) => o.pbe_pct !== null);
  // monitoring-only events: the outcome the market prices highest (never an unquoted outcome when a quoted one exists)
  const quoted = [...rec.outcomes].filter((o) => o.market_pct !== null && o.market_pct !== undefined).sort((a, b) => b.market_pct - a.market_pct)[0];
  return [...m].filter((o) => o.divergence_pts !== null).sort((a, b) => Math.abs(b.divergence_pts) - Math.abs(a.divergence_pts))[0] || m[0] || quoted || rec.outcomes[0] || null;
}

// The public social card carries no numbers, so its cache key is the public shell only.
export function eventOgImage(shell) {
  const e = shell.event;
  const key = [e.title, e.state, e.close_time, e.lifecycle, shell.outcomes.length, 'aa1'].join('|');
  let x = 0; for (const ch of key) x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  return `${SITE}/og/events/${e.slug}.png?v=${x.toString(36)}`;
}

const GATE_FEATURES = ['Official PBE probability for every modeled outcome', 'Model vs market comparison', 'Evidence ledger with data cutoff and sources', 'Immutable forecast history and scoring checkpoints', 'Live station and market updates'];
// The All Access gate. Purchase/sign-in actions sit in [data-gate-cta]: invisible until access.js knows the reader's
// state (space reserved, no layout shift), never shown to All Access / owner, replaced by a retry when the
// entitlement check is unavailable.
export function gatePanel({ heading, features = GATE_FEATURES, placement }) {
  return `<section class="card panel prem gate" data-gate aria-labelledby="gate-h">
<span class="prem-kicker">PROPBETEDGE PREDICTIONS · ALL ACCESS</span><h2 id="gate-h">${esc(heading)}</h2>
<ul class="gate-list">${features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
<p class="gate-price">Included with PropBetEdge All Access · <b>$29/month</b></p>
<div class="gate-cta" data-gate-cta><a class="cta-primary" href="https://propbetedge.ai/pro" data-pbe-placement="${esc(placement)}">Get All Access</a><a class="cta-secondary" href="#" data-pbe-signin>Sign in</a></div>
</section>`;
}

// ALL ACCESS: the intelligence of one event (served only through /v1/premium/event-page/<slug>, private, no-store).
// `rec` = premiumEventView. Returns the main-column and aside HTML that access.js swaps into the public shell.
export function eventIntel(rec, { multiVenue = false } = {}) {
  const e = rec.event; const h = headlineOutcome(rec);
  const canonical = `${SITE}/events/${e.slug}`;
  const kpis = h ? `<div class="kpis">
<div class="kpi"><span>PBE data model</span><strong class="num">${h.pbe_pct !== null ? `${h.pbe_pct}%` : '—'}</strong><small>${h.pbe_pct !== null ? `${esc(h.label)} · ${esc(h.model)}` : 'Market monitoring — no PBE model'}</small></div>
<div class="kpi"><span>Market</span><strong class="num">${h.market_pct !== null ? `${h.market_pct}%` : '—'}</strong><small>${h.kalshi_url ? `<a href="${esc(h.kalshi_url)}" target="_blank" rel="noopener">Kalshi ↗</a> · ` : ''}mid ${h.market_observed_at ? utc(h.market_observed_at) : ''}</small></div>
<div class="kpi"><span>Divergence</span><strong class="num ${h.divergence_pts > 0 ? 'dpos' : h.divergence_pts < 0 ? 'dneg' : ''}">${h.divergence_pts !== null ? `${sign(h.divergence_pts)}<small style="display:inline;font-size:14px"> pts</small>` : '—'}</strong><small>PBE vs current market price</small></div></div>
${h.divergence_pts !== null ? `<p class="headline">${Math.abs(h.divergence_pts) <= 2 ? 'PBE and the market agree within 2 points on this outcome.' : `PBE sees a ${h.divergence_pts > 0 ? 'higher' : 'lower'} probability of “${esc(h.label)}” than the current market price.`}</p>` : ''}` : '';
  const evidence = h?.evidence?.length ? `<section class="card panel"><h2>Why the model sees it — ${esc(h.label)}</h2><ul class="ev-list">${h.evidence.map((x) => `<li class="ev-item"><div><b>${esc(x.label)}</b><small>${esc(x.detail || '')}</small></div><strong class="num">${esc(x.value)}${esc(x.unit)}</strong></li>`).join('')}</ul></section>` : '';
  const snaps = rec.outcomes.filter((o) => o.history.length).map((o) => `<details class="snap"><summary>${esc(o.label)} — ${o.history.length} snapshot${o.history.length > 1 ? 's' : ''}${o.resolution ? ` · resolved ${esc(String(o.resolution.venue_result).toUpperCase())}` : ''}</summary>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Published</th><th>PBE</th><th>Market then</th><th>Model</th><th>Data cutoff</th><th>Quality</th><th>Scoring role</th></tr></thead><tbody>
${o.history.map((s) => `<tr><td class="num">${utc(s.t)}</td><td class="num"><b>${s.pct}%</b></td><td class="num">${s.market_pct ?? '—'}${s.market_pct !== null ? '%' : ''}</td><td>${esc(s.model)}</td><td class="num">${utc(s.cutoff)}</td><td>${esc(s.confidence || '')}</td><td>${esc(s.roles.length ? s.roles.map((r) => r.replace(/_/g, ' ').toLowerCase()).join(', ') : 'interim')}</td></tr>`).join('')}
</tbody></table></div>${o.scores.length ? `<p class="note">Scores (Brier, PBE vs market on the same snapshot): ${o.scores.filter((s) => s.method === 'brier').map((s) => `${s.designation.replace(/_/g, ' ').toLowerCase()} ${s.pbe.toFixed(3)} vs ${s.market === null ? '—' : s.market.toFixed(3)}`).join(' · ')}</p>` : ''}</details>`).join('');
  const prov = (h?.provenance || []).map((p) => `<li class="ev-item"><div><b>${esc(p.source)}</b><small>${esc([p.provider, p.station && `station ${p.station}`, p.run && `run ${utc(p.run)}`, p.latest_value_date && `latest ${p.latest_value_date}`, p.updated_at && `issued ${utc(p.updated_at)}`, p.dataset].filter(Boolean).join(' · '))}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">source</a>` : ''}</small></div><span class="note">${esc(p.role || '')}</span></li>`).join('');
  const model = rec.model ? `<section class="card panel"><h2>Model run</h2><dl class="kv"><dt>Versions here</dt><dd>${esc(rec.model.versions.join(', '))}</dd><dt>Data cutoff</dt><dd>${utc(h?.data_cutoff_at)}</dd>${h?.tier ? `<dt>Tier</dt><dd>${esc(h.tier)}</dd>` : ''}</dl></section>` : '';
  const citation = `PropBetEdge Predictions. "${e.title}" forecast record${rec.model ? `, ${rec.model.id} (${rec.model.state.toLowerCase()})` : ''}. ${canonical} (retrieved ${new Date().toISOString().slice(0, 10)}).`;
  const main = `<p class="prem-active">ALL ACCESS · ${esc(e.latest_forecast_at ? `${h?.live?.pbe_frozen ? 'pre-window PBE forecast (frozen)' : 'latest PBE forecast'} ${utc(e.latest_forecast_at)}` : 'market monitoring')}${e.latest_market_at ? ` · market observed ${utc(e.latest_market_at)}` : ''}</p>
<div data-live-region="call">${h?.call ? callBlock(h) : `<section class="card panel">${kpis}</section>`}</div>
<div data-live-region="station">${h?.intel ? liveWeatherBlock(h) : stationBlock(h)}</div>
<div data-live-region="market">${marketView(h)}</div>
<section class="card panel"><h2>${rec.distribution?.kind === 'exclusive' ? 'Outcome distribution — PBE vs market' : rec.distribution?.kind === 'threshold' ? 'Threshold curve — PBE vs market' : 'Outcomes — PBE vs market'}</h2>${distributionBlock(rec)}</section>
<section class="card panel prem" id="pbe-premium" data-slug="${esc(e.slug)}" aria-labelledby="prem-h"><span class="prem-kicker">ALL ACCESS</span><h2 id="prem-h">Full forecast archive</h2><div class="prem-body" data-prem-body hidden></div></section>
${h?.call ? `${factsBlock(h)}
${pbeVsMarket(h)}` : evidence}
${rec.outcomes.some((o) => o.history.length) ? `<section class="card panel"><h2>Forecast history</h2><p class="note">Every immutable PBE snapshot; the scored ones carry their role (fixed by rule before the outcome).</p>${snaps}</section>` : ''}
${gradeBlock(rec)}
${multiVenue && h?.market_id ? `<section class="card panel" id="mv-chart-panel" hidden data-event="${esc(e.event_id)}" data-market="${esc(h.market_id)}"><h2>PBE vs venues — ${esc(h.label)}</h2><div class="mv-chart"></div><div class="mv-related-box" hidden></div></section>` : ''}`;
  const aside = `${model}
${prov && !h?.call ? `<section class="card panel"><h2>Provenance</h2><ul class="ev-list">${prov}<li class="ev-item"><div><b>Market observations — benchmark only, never a model input</b><small>Kalshi via the PropBetEdge canonical market service; first observed by PBE is not necessarily the opening price</small></div><span class="note">benchmark</span></li></ul></section>` : ''}
${permanentRecord(h, citation, e.slug)}`;
  return { main, aside, atmosphere: h?.intel?.atmosphere ?? null, multi_venue: Boolean(multiVenue && h?.market_id) };
}

// PUBLIC event page: the product shell only (premium.js publicEventShell). No PBE probability, market comparison,
// evidence, history or score is in this HTML; members receive them from /api/premium/event-page/<slug>.
export function renderEvent(shell, { stories = [] } = {}) {
  const e = shell.event;
  const canonical = `${SITE}/events/${e.slug}`;
  const title = `${e.title.replace(/\?$/, '')} — forecast vs market | PropBetEdge Predictions`;
  const description = eventDescription(shell);
  const c = shell.contract || {};
  const ogImage = eventOgImage(shell);
  const jsonld = [{ '@context': 'https://schema.org', '@graph': [
    ORG_NODE, WEBSITE_NODE,
    { '@type': 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: title, description, dateModified: e.date_modified, isPartOf: { '@id': WEBSITE_ID }, publisher: { '@id': ORG_ID }, breadcrumb: { '@id': `${canonical}#breadcrumbs` }, mainEntity: { '@id': `${canonical}#dataset` }, primaryImageOfPage: { '@type': 'ImageObject', '@id': `${canonical}#card`, url: ogImage, width: 1200, height: 630, caption: `${e.title} — PropBetEdge Predictions` } },
    { '@type': 'Dataset', '@id': `${canonical}#dataset`, name: `PBE forecast record: ${e.title}`, description: `PropBetEdge Predictions forecast record${shell.model ? ` (${shell.model.id})` : ''} for "${e.title}": PBE model probability vs the market, evidence, forecast history and scoring. The exact resolution rule is public; the forecast record is included with PropBetEdge All Access ($29/month).`, url: canonical, creator: { '@id': ORG_ID }, publisher: { '@id': ORG_ID }, image: { '@id': `${canonical}#card` }, isPartOf: { '@id': WEBSITE_ID }, dateModified: e.date_modified, datePublished: e.created_at, isAccessibleForFree: false, conditionsOfAccess: 'Included with PropBetEdge All Access ($29/month).', keywords: [e.category_label, 'forecast', 'prediction market', 'probability'], variableMeasured: ['PBE model probability', 'market-implied probability (Kalshi mid)', 'divergence (percentage points)'] },
    { '@type': 'BreadcrumbList', '@id': `${canonical}#breadcrumbs`, itemListElement: [{ '@type': 'ListItem', position: 1, name: 'PropBetEdge', item: 'https://propbetedge.ai/' }, { '@type': 'ListItem', position: 2, name: 'Predictions', item: `${SITE}/` }, { '@type': 'ListItem', position: 3, name: e.category_label, item: `${SITE}/?category=${encodeURIComponent(e.category)}#desk` }, { '@type': 'ListItem', position: 4, name: e.venue_event_id, item: canonical }] },
  ] }];
  const outs = shell.outcomes;
  const outcomes = `<section class="card panel"><h2>Tracked outcomes</h2><ul class="ev-list">${outs.map((o) => `<li class="ev-item"><div><b>${esc(o.label)}</b>${o.status !== 'NORMALIZED' ? `<small>${esc(o.reason || o.status)}</small>` : ''}</div>${o.resolution ? `<span class="note">resolved ${esc(String(o.resolution.venue_result).toUpperCase())}</span>` : ''}</li>`).join('')}</ul></section>`;
  const resolved = outs.filter((o) => o.resolution);
  const resolution = resolved.length ? `<section class="card panel"><h2>Resolution</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Outcome</th><th>Venue settlement</th><th>Official value</th><th>Agree</th></tr></thead><tbody>${resolved.map((o) => `<tr><td>${esc(o.label)}</td><td>${esc(String(o.resolution.venue_result).toUpperCase())}${o.resolution.venue_value ? ` (${esc(o.resolution.venue_value)})` : ''}</td><td>${o.resolution.official_outcome ? `${esc(o.resolution.official_outcome)} · ${esc(o.resolution.official_value)} ${esc(o.resolution.official_units)}` : 'pending'}${o.resolution.source_url ? ` · <a href="${esc(o.resolution.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</td><td>${o.resolution.sources_agree === null ? '—' : o.resolution.sources_agree ? 'yes' : '<b>no — flagged</b>'}</td></tr>`).join('')}</tbody></table></div></section>` : '';
  const L = c.location || {};
  const contract = shell.contract ? `<section class="card panel"><h2>Exactly how this resolves</h2><dl class="kv">
${c.station_id ? `<dt>Station / series</dt><dd>${esc(c.station_id)}${L.name ? ` — ${esc(L.name)} (${esc(L.icao || '')}${L.wfo ? `, NWS ${esc(L.wfo)}` : ''})` : ''}</dd>` : ''}
<dt>Measurement</dt><dd>${esc(c.measurement_definition || '—')}</dd>
${c.observation_start ? `<dt>Window</dt><dd>${utc(c.observation_start)} → ${utc(c.observation_end)} (${esc(c.timezone || 'UTC')})</dd>` : ''}
<dt>Resolution source</dt><dd>${esc(c.resolution_authority || '—')}${c.resolution_dataset ? ` — ${esc(c.resolution_dataset)}` : ''}</dd>
${c.verification_dataset ? `<dt>Independent check</dt><dd>${esc(c.verification_dataset)}</dd>` : ''}
${c.rounding_rule ? `<dt>Rounding</dt><dd>${esc(c.rounding_rule)}</dd>` : ''}
${(c.exceptions || []).length ? `<dt>Exceptions</dt><dd>${(c.exceptions || []).map(esc).join(' · ')}</dd>` : ''}
<dt>Normalization</dt><dd>${esc(c.normalization_status)}${c.status_reason ? ` (${esc(c.status_reason)})` : ''} · ${esc(c.normalizer || '')}</dd>
</dl>${c.rules_primary_example ? `<p class="note" style="margin-top:10px">Venue rule (example outcome):</p><div class="rules">${esc(c.rules_primary_example)}</div>` : ''}</section>` : '';
  const model = shell.model ? `<section class="card panel"><h2>Model</h2><dl class="kv"><dt>Family</dt><dd>${esc(shell.model.name)} (${esc(shell.model.id)})</dd><dt>State</dt><dd>${badge(shell.model.state)}</dd><dt>Inputs</dt><dd>${esc(shell.model.inputs)}</dd></dl><p class="note" style="margin-top:10px"><b>Known limitations:</b> ${shell.model.limitations.map(esc).join(' · ')}</p><p class="note"><a href="/methodology/">Methodology →</a></p></section>` : '';
  const gate = gatePanel({ heading: shell.modeled ? 'The PBE forecast for this event is included with All Access' : 'Live market monitoring for this event is included with All Access', placement: 'predictions_event_gate' });
  const body = `<main class="wrap" data-live-src="/api/live/event/${esc(e.slug)}" data-event-slug="${esc(e.slug)}">
<nav class="crumbs" aria-label="Breadcrumb"><a href="https://propbetedge.ai/">PropBetEdge</a> › <a href="/">Predictions</a> › <a href="/?category=${encodeURIComponent(e.category)}#desk">${esc(e.category_label)}</a> › ${esc(e.venue_event_id)}</nav>
<header class="ev-head"><div class="ev-meta"><span class="cat">${esc(e.category_label)}</span>${badge(e.state)}<span>${e.kalshi_url ? `<a href="${esc(e.kalshi_url)}" target="_blank" rel="noopener">${esc(e.venue)} ${esc(e.venue_event_id)} ↗</a>` : esc(e.venue_event_id)}</span></div>
<h1>${esc(e.title)}</h1>
${shareBar(canonical, e.title)}
<div class="ev-meta"><span>Closes ${utc(e.close_time)}</span><span>${outs.length} outcome${outs.length > 1 ? 's' : ''}</span></div></header>
<div class="ev-grid"><div>
<div data-prem-intel>${gate}</div>
${outcomes}
${resolution}
</div><aside>
<div data-prem-aside></div>
${contract}
${model}
${stories.length ? `<section class="card panel"><h2>Prediction Intelligence on this event</h2><ul class="ev-list">${stories.map((st) => `<li class="ev-item"><div><b><a href="/insights/${esc(st.slug)}">${esc(st.title)}</a></b><small>${esc(st.family_label)} · ${esc(new Date(st.published_at).toISOString().slice(0, 10))}</small></div></li>`).join('')}</ul></section>` : ''}
</aside></div></main><script src="/live.js?v=${LIVE_V}" defer></script>`;
  return layout({ title, description, canonical, jsonld, body, ogImage, current: 'desk' });
}

export function renderNotFound(path) {
  return layout({ title: 'Not found | PropBetEdge Predictions', description: 'This record does not exist.', canonical: `${SITE}${path}`, robots: 'noindex', body: `<main class="wrap section"><h1>Record not found</h1><p class="empty-honest">There is no event at this address. <a href="/">Back to the intelligence desk</a>.</p></main>` });
}

export function sitemapXml(entries, insights = []) {
  const urls = [
    ...(insights.length ? [{ loc: `${SITE}/insights/`, changefreq: 'daily', priority: '0.9' }, ...[...new Set(insights.map((i) => i.vertical))].map((v) => ({ loc: `${SITE}/insights/${v}/`, changefreq: 'daily', priority: '0.6' })), ...insights.map((i) => ({ loc: `${SITE}/insights/${i.slug}`, lastmod: (i.modified || i.published_at).slice(0, 10), changefreq: 'weekly', priority: '0.8' }))] : []),
    { loc: `${SITE}/`, changefreq: 'hourly', priority: '1.0' },
    { loc: `${SITE}/models/`, changefreq: 'daily', priority: '0.6' },
    { loc: `${SITE}/methodology/`, changefreq: 'monthly', priority: '0.5' },
    ...entries.map((e) => ({ loc: `${SITE}/events/${e.slug}`, lastmod: (e.updated_at || '').slice(0, 10), changefreq: 'hourly', priority: '0.7' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}\n</urlset>\n`;
}
