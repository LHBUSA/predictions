// Prediction Intelligence pages: /insights/ desk, vertical desks, articles, RSS and the news sitemap.
// Article = immutable story (evidence packet bounded by as_of) + a clearly labeled LIVE module read at render time.
import { esc, layout, SITE, badge, headlineOutcome, shareBar, ORG_ID, WEBSITE_ID, ORG_NODE, WEBSITE_NODE } from '../pages.js';
import { networkModule } from '../network.js';
import { premiumModule } from '../pages.js';
import { publicEventView } from '../premium.js';
import { fmtUtc } from './charts.js';
import { VERTICALS } from './stories.js';
import { storyImage, heroOverlaySvg, storySvg } from './images.js';
import { LIVE_V } from '../pages.js';

const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const longDate = (iso) => new Date(iso).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const storyUrl = (st) => `${SITE}/insights/${st.slug}`;
export const storyImageUrl = (st) => storyImage(st).og_image;
const AUTHOR = { '@type': 'Organization', '@id': `${SITE}/insights/#desk`, name: 'PropBetEdge Predictions Desk', url: `${SITE}/insights/` };

// Abstract editorial textures per vertical (decorative only — never shaped like data).
const TEXTURE = {
  weather: '<svg viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + Array.from({ length: 9 }, (_, i) => `<ellipse cx="430" cy="210" rx="${40 + i * 34}" ry="${26 + i * 22}" fill="none" stroke="#5aa2ff" stroke-opacity="${0.34 - i * 0.03}" stroke-width="1.2" transform="rotate(-14 430 210)"/>`).join('') + '</svg>',
  rates: '<svg viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + Array.from({ length: 14 }, (_, i) => `<line x1="0" x2="600" y1="${40 + i * 24}" y2="${40 + i * 24}" stroke="#5aa2ff" stroke-opacity="${0.06 + (i % 4 === 0 ? 0.12 : 0.04)}"/>`).join('') + Array.from({ length: 16 }, (_, i) => `<line y1="0" y2="400" x1="${200 + i * 26}" x2="${200 + i * 26}" stroke="#5aa2ff" stroke-opacity=".07"/>`).join('') + '</svg>',
};

function heroNumbers(h) {
  if (h.type === 'flow') {
    return `<div class="ix-flow" aria-label="${esc(`${h.from} to ${h.to}`)}"><span class="from">${esc(h.from)}</span><span class="arrow" aria-hidden="true">→</span><span class="to">${esc(h.to)}</span></div><p class="ix-flow-label">${esc(h.label)}</p>${h.stats ? `<div class="ix-hstats small">${h.stats.map(stat).join('')}</div>` : ''}`;
  }
  return `<div class="ix-hstats${h.four ? ' four' : ''}">${h.stats.map(stat).join('')}</div>${h.outcome ? `<p class="ix-flow-label">${esc(h.outcome)}</p>` : ''}`;
}
const stat = (s) => `<div class="ix-hstat t-${esc(s.tone)}"><span>${esc(s.label)}</span><strong>${esc(s.value)}</strong>${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</div>`;

// LIVE UPDATE (freshness pass): current state of the story's contract, refreshed in place while the article is open
// (/v1/live/insight/:slug via live.js). The published evidence below never changes. UPDATE entries are deterministic:
// each later PUBLIC PBE snapshot of the same contract that moved >= UPDATE_PTS from the last reported value.
export const UPDATE_PTS = 10;
export function liveUpdate(rec, marketId, story, built = null) {
  if (!rec) return '';
  const o = rec.outcomes.find((x) => x.market_id === marketId) || headlineOutcome(rec);
  if (!o) return '';
  const L = o.live || {};
  const resolved = Boolean(o.resolution);
  const state = resolved ? 'RESOLVED' : L.window?.state === 'WINDOW_OPEN' ? 'WINDOW OPEN · OBSERVING' : L.window?.state === 'WINDOW_CLOSED' ? 'WINDOW CLOSED · AWAITING SETTLEMENT' : 'PRE-WINDOW';
  const pubPbe = built?.hero?.type === 'flow' ? Number(String(built.hero.to).replace('%', '')) : null;
  const pubMkt = (built?.claims || []).filter((c) => c.kind === 'market_at_snapshot').at(-1)?.value ?? null;
  const k = o.venues?.kalshi?.current;
  const since = (now, then) => (now === null || now === undefined || then === null || then === undefined ? '' : `<small>${sign(now - then)} pts since publication</small>`);
  const after = (o.history || []).filter((h) => h.pct !== null && h.t > story.as_of);
  const updates = []; let last = pubPbe;
  for (const h of after) { if (last === null || Math.abs(h.pct - last) >= UPDATE_PTS) { updates.push(h); last = h.pct; } }
  const obs = L.observations;
  const pbeLabel = L.pbe_frozen ? `PBE · pre-window, frozen ${fmtUtc(L.pbe_frozen.frozen_at)}` : 'PBE';
  return `<section class="ix-live" aria-labelledby="live-h"><div class="ix-live-head"><span class="ix-pulse" aria-hidden="true"></span><span id="live-h">LIVE UPDATE · not part of the original story</span></div>
<h3>${esc(rec.event.title)}</h3><p class="note" style="color:#a9bccf">${esc(o.label)} · <b>${esc(state)}</b></p>
<div class="ix-live-grid"><div><span>${esc(pbeLabel)}</span><b>${o.pbe_pct !== null ? `${o.pbe_pct}%` : '—'}</b>${since(o.pbe_pct, pubPbe)}</div><div><span>Kalshi</span><b>${k?.mid_pct !== null && k?.mid_pct !== undefined ? `${k.mid_pct}%` : `<small style="font-size:13px">${k ? 'No two-sided quote' : 'Awaiting market'}</small>`}</b>${since(k?.mid_pct, pubMkt)}</div><div><span>Gap</span><b class="${o.divergence_pts > 0 ? 'pos' : o.divergence_pts < 0 ? 'neg' : ''}">${o.divergence_pts !== null ? `${sign(o.divergence_pts)}` : '<small style="font-size:13px">No comparable quote</small>'}</b></div></div>
${obs ? `<p class="ix-live-meta">At ${esc(L.station.icao)}: high so far <b>${obs.max_so_far ? `${obs.max_so_far.temp_f.toFixed(1)}°F` : '—'}</b> · latest ${obs.latest.temp_f !== null ? `${obs.latest.temp_f.toFixed(1)}°F` : '—'} (<span data-ago="${esc(obs.latest.t)}"></span>)${obs.precip_so_far_in !== null ? ` · rain so far ${obs.precip_so_far_in.toFixed(2)} in` : ''} · ${esc(obs.freshness?.label || '')}</p>` : ''}
<p class="ix-live-meta">${badge(rec.event.state)} PBE ${o.published_at ? esc(fmtUtc(o.published_at)) : '—'} · market ${k?.observed_at ? `<span data-ago="${esc(k.observed_at)}"></span>` : '—'}</p>
${updates.length ? `<ol class="ix-live-updates">${updates.map((h) => `<li><b>UPDATE · ${esc(fmtUtc(h.t))}</b> PBE ${h.pct}% <small>${esc(h.model)} · data cutoff ${esc(fmtUtc(h.cutoff))}</small></li>`).join('')}</ol>` : ''}
<a class="cta-primary ix-live-cta" href="/events/${esc(rec.event.slug)}">Open the live forecast →</a></section>`;
}

function resolutionModule(res, story) {
  if (!res) return '';
  return `<section class="ix-update" aria-labelledby="upd-h"><span class="ix-kicker">UPDATE · ${esc(shortDate(res.resolved_at || res.venue_settled_at))}</span><h2 id="upd-h">This contract has resolved</h2>
<p>Venue settlement: <b>${esc(String(res.venue_result || '').toUpperCase() || 'pending')}</b>${res.venue_expiration_value ? ` (${esc(res.venue_expiration_value)})` : ''}. Official check: ${res.official_outcome ? `<b>${esc(res.official_outcome)}</b> · ${esc(res.official_value)} ${esc(res.official_units || '')}` : 'pending'}${res.source_url ? ` · <a href="${esc(res.source_url)}" rel="noopener" target="_blank">source</a>` : ''}. The analysis above is unchanged; scores for the designated snapshots are on the <a href="/events/${esc(story.primary)}">event record</a>.</p></section>`;
}

function ledger(items, rule, model) {
  return `<section class="ix-ledger" aria-labelledby="ledger-h"><h2 id="ledger-h">Evidence &amp; method</h2><p class="note">What this story is based on. Every value above was read from these immutable records.</p>
${items.length > 3 ? `<div class="tbl-wrap"><table class="tbl ix-ledger-tbl"><thead><tr><th>Outcome</th><th>Model</th><th>Snapshot</th><th>Compared with</th><th>Captured</th><th>Data cutoff</th><th>Market</th></tr></thead><tbody>${items.map((it) => `<tr><td><b>${esc(it.label)}</b></td><td>${esc(it.model)} · ${esc(it.state)}</td><td class="mono">${esc(it.snapshot_id)}</td><td class="mono">${esc(it.pair_id || '—')}</td><td>${esc(fmtUtc(it.captured))}</td><td>${esc(fmtUtc(it.cutoff))}</td><td>${it.market !== null && it.market !== undefined ? `${it.market}%` : '—'}</td></tr>`).join('')}</tbody></table></div><p class="note">Source families: ${[...new Set(items.flatMap((it) => it.sources))].map(esc).join(' · ')}. Market = Kalshi mid captured with each snapshot.</p>` : `<div class="ix-ledger-grid">${items.map((it) => `<div class="ix-ledger-item"><b>${esc(it.label)}</b><dl>
<dt>Model</dt><dd>${esc(it.model)} · ${esc(it.state)}</dd>
<dt>Snapshot</dt><dd class="mono">${esc(it.snapshot_id)}</dd>${it.pair_id ? `<dt>Compared with</dt><dd class="mono">${esc(it.pair_id)}</dd>` : ''}
<dt>Captured</dt><dd>${esc(fmtUtc(it.captured))}</dd><dt>Data cutoff</dt><dd>${esc(fmtUtc(it.cutoff))}</dd>
${it.market !== null && it.market !== undefined ? `<dt>Market observation</dt><dd>${it.market}%${it.market_t ? ` · ${esc(fmtUtc(it.market_t))}` : ' · captured with the snapshot'}</dd>` : ''}
${it.sources.length ? `<dt>Source families</dt><dd>${it.sources.map(esc).join(' · ')}</dd>` : ''}</dl></div>`).join('')}</div>`}
<div class="ix-rule"><span class="ix-kicker">RESOLUTION RULE</span><dl class="kv"><dt>Resolves on</dt><dd>${esc(rule.authority || '—')}${rule.dataset ? ` — ${esc(rule.dataset)}` : ''}</dd>${rule.check ? `<dt>Independent check</dt><dd>${esc(rule.check)}</dd>` : ''}<dt>Measurement</dt><dd>${esc(rule.measurement || '—')}</dd>${rule.rounding ? `<dt>Rounding</dt><dd>${esc(rule.rounding)}</dd>` : ''}${rule.exceptions.length ? `<dt>Exceptions</dt><dd>${rule.exceptions.map(esc).join(' · ')}</dd>` : ''}</dl>${rule.rule ? `<div class="rules">${esc(rule.rule)}</div>` : ''}</div>
${model ? `<div class="ix-limits"><span class="ix-kicker">MODEL LIMITATIONS</span><ul>${model.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="note">${esc(model.name)} — inputs: ${esc(model.inputs)}. <a href="/models/#${esc(model.id)}">This model on the research board →</a></p></div>` : ''}
<p class="note">Market prices are a benchmark only and never enter a PropBetEdge model. Research-stage probabilities; not advice.</p></section>`;
}

// Hero: raster (photo / bespoke art) in a <picture>, with the story's evidence geometry layered over real photos;
// Tier 3 = inline story-specific SVG. Both fill the same fixed box (zero CLS).
function heroArt(img, eager, story) {
  if (img.type === 'svg') return `<div class="ix-hero-art ix-svg-art" role="img" aria-label="${esc(img.hero_alt)}">${storySvg(story)}</div>`;
  const b = img.base;
  return `<div class="ix-hero-art${img.type === 'photo' ? ' is-photo' : ''}"><picture>
<source media="(max-width: 760px)" type="image/avif" srcset="${b}/mobile-640.avif 640w, ${b}/mobile-960.avif 960w" sizes="100vw">
<source media="(max-width: 760px)" type="image/webp" srcset="${b}/mobile-640.webp 640w, ${b}/mobile-960.webp 960w" sizes="100vw">
<source type="image/avif" srcset="${b}/hero-800.avif 800w, ${b}/hero-1200.avif 1200w, ${b}/hero-1600.avif 1600w" sizes="(max-width: 760px) 100vw, 74vw">
<source type="image/webp" srcset="${b}/hero-800.webp 800w, ${b}/hero-1200.webp 1200w, ${b}/hero-1600.webp 1600w" sizes="(max-width: 760px) 100vw, 74vw">
<img src="${b}/hero-1200.webp" width="1600" height="900" alt="${esc(img.hero_alt)}" style="object-position:${esc(img.hero_focal_point)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture>${img.overlay && story ? heroOverlaySvg(story) : ''}</div>`;
}
const cardArt = (img, eager = false, story = null) => (img.type === 'svg'
  ? `<div class="ix-card-art ix-svg-art" aria-hidden="true">${storySvg(story, { w: 800, h: 450 })}</div>`
  : `<picture class="ix-card-art"><source type="image/avif" srcset="${img.base}/hero-800.avif"><img src="${img.base}/hero-800.webp" width="800" height="450" alt="" style="object-position:${esc(img.hero_focal_point)}"${eager ? '' : ' loading="lazy"'} decoding="async"></picture>`);
// Photo credit links to the Commons file page and the license; illustrations keep their plain credit line.
const creditLine = (img) => (img.type === 'photo' && img.credit
  ? `<p class="ix-credit">${img.credit.author ? `Photo: ${esc(img.credit.author)} · ` : 'Photo · '}${img.credit.license_url ? `<a href="${esc(img.credit.license_url)}" target="_blank" rel="noopener license">${esc(img.credit.license)}</a>` : esc(img.credit.license)} · <a href="${esc(img.credit.source_url)}" target="_blank" rel="noopener">Wikimedia Commons</a></p>`
  : `<p class="ix-credit">${esc(img.image_credit)}</p>`);

// One breadcrumb trail for the visible nav AND the BreadcrumbList (they must agree).
export function articleCrumbs(story, built) {
  return [{ name: 'PropBetEdge', url: 'https://propbetedge.ai/' }, { name: 'Predictions', url: `${SITE}/` }, { name: 'Insights', url: `${SITE}/insights/` }, { name: VERTICALS[story.vertical], url: `${SITE}/insights/${story.vertical}/` }, { name: built.title }];
}

// Contextual internal links every story carries: live forecast, model, methodology, record, vertical, home.
function continueResearch(story, built) {
  const fam = built.model_family;
  return `<nav class="ix-continue" aria-labelledby="continue-h"><h2 id="continue-h">Continue the research</h2><ul>
<li><a href="/events/${esc(story.primary)}"><b>Open the live forecast</b><span>The canonical event record: current PBE probability, market, evidence and the scoring checkpoints (full archive with All Access).</span></a></li>
${fam ? `<li><a href="/models/#${esc(fam)}"><b>The model on the research board</b><span>${esc(fam)}: state, versions, live forecasts, calibration status and limitations.</span></a></li>` : ''}
<li><a href="/methodology/#scoring"><b>How forecasts are made and scored</b><span>Contract normalization, point-in-time data, immutable snapshots and fixed scoring roles.</span></a></li>
<li><a href="/#track-record"><b>Track record</b><span>Resolved forecasts scored against the market on the same snapshots.</span></a></li>
<li><a href="/insights/${esc(story.vertical)}/"><b>More ${esc(VERTICALS[story.vertical])} analysis</b><span>Every ${esc(VERTICALS[story.vertical].toLowerCase())} story from the Predictions desk.</span></a></li>
<li><a href="/"><b>PropBetEdge Predictions</b><span>The intelligence desk: every live real-world contract we track.</span></a></li>
</ul></nav>`;
}

export function articleJsonLd(story, built, modified) {
  const url = storyUrl(story);
  const img = storyImage(story);
  const node = {
    '@type': 'NewsArticle', '@id': `${url}#article`, url, mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    headline: built.title.length > 110 ? `${built.title.slice(0, 107)}…` : built.title, name: built.title, description: built.description,
    articleSection: VERTICALS[story.vertical], genre: story.family_label, inLanguage: 'en-US', isAccessibleForFree: true,
    isPartOf: { '@id': WEBSITE_ID }, author: AUTHOR, publisher: { '@id': ORG_ID },
    image: [...img.schema.map(([u, w, h]) => ({ '@type': 'ImageObject', url: `${SITE}${u}`, width: w, height: h, creditText: img.image_credit, ...(img.type === 'photo' && img.credit ? { license: img.credit.license_url || undefined, acquireLicensePage: img.credit.source_url, creator: img.credit.author ? { '@type': 'Person', name: img.credit.author } : undefined } : { copyrightNotice: img.image_credit }) })), { '@type': 'ImageObject', url: storyImageUrl(story), width: 1200, height: 630 }],
    datePublished: story.published_at,
    about: story.events.slice(0, 7).map((slug) => ({ '@type': 'Dataset', '@id': `${SITE}/events/${slug}#dataset`, url: `${SITE}/events/${slug}` })),
    isBasedOn: story.events.map((slug) => `${SITE}/events/${slug}`),
    ...(built.model_family ? { mentions: [{ '@type': 'CreativeWork', name: `PropBetEdge model ${built.model_family}`, url: `${SITE}/models/#${built.model_family}` }] } : {}),
  };
  if (modified) node.dateModified = modified;
  return {
    '@context': 'https://schema.org',
    '@graph': [ORG_NODE, WEBSITE_NODE, { '@type': 'WebPage', '@id': url, url, name: built.title, isPartOf: { '@id': WEBSITE_ID }, breadcrumb: { '@id': `${url}#breadcrumbs` } }, node, { '@type': 'BreadcrumbList', '@id': `${url}#breadcrumbs`, itemListElement: articleCrumbs(story, built).map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, ...(c.url ? { item: c.url } : {}) })) }],
  };
}

export function renderArticle(story, inputBuilt, { live, related = [], model, words }) {
  const built = { ...inputBuilt, model_family: inputBuilt.model_family || model?.id || null };
  const url = storyUrl(story);
  const modified = built.resolution && (built.resolution.resolved_at || built.resolution.venue_settled_at) > story.published_at ? (built.resolution.resolved_at || built.resolution.venue_settled_at) : null;
  const rel = related.filter(Boolean).slice(0, 4);
  const img = storyImage(story);
  const body = `<article class="ix-article fam-${esc(story.family.toLowerCase())}" data-live-src="/api/live/insight/${esc(story.slug)}">
<header class="ix-hero has-art v-${esc(story.vertical)}${story.family === 'RESOLUTION_REPORT' ? ' resolved' : ''}" data-image-version="${esc(img.image_version)}" data-image-key="${esc(img.key)}" data-image-type="${esc(img.type)}">${heroArt(img, true, story)}<div class="ix-hero-shade" aria-hidden="true"></div>
<div class="wrap ix-hero-inner"><div class="ix-hero-copy">
<nav class="ix-crumbs" aria-label="Breadcrumb">${articleCrumbs(story, built).slice(0, -1).map((c) => `<a href="${c.url.startsWith(SITE) ? c.url.slice(SITE.length) : c.url}">${esc(c.name)}</a>`).join(' › ')}</nav>
<span class="ix-eyebrow">${esc(VERTICALS[story.vertical].toUpperCase())} · ${esc(story.family_label.toUpperCase())}</span>
<h1>${esc(built.title)}</h1><p class="ix-dek">${esc(built.dek)}</p>
<p class="ix-meta"><span>Published <time datetime="${esc(story.published_at)}">${esc(longDate(story.published_at))}</time></span>${modified ? `<span>Updated <time datetime="${esc(modified)}">${esc(longDate(modified))}</time></span>` : ''}<span>Model data as of ${esc(fmtUtc(built.model_as_of))}</span><span>By the PropBetEdge Predictions Desk</span>${words ? `<span>${Math.max(1, Math.round(words / 230))} min read</span>` : ''}</p>
${creditLine(img)}</div><div class="ix-hero-nums">${heroNumbers(built.hero)}</div></div></header>
<div class="wrap ix-layout"><div class="ix-main">
<div data-live-region="insight">${liveUpdate(live, built.outcome_market_id, story, built)}</div>
${shareBar(url, built.title)}
${resolutionModule(built.resolution, story)}
<section class="ix-quick" aria-labelledby="quick-h"><h2 id="quick-h">Quick read</h2><ul>${built.quick.map((q) => `<li>${q}</li>`).join('')}</ul></section>
<div class="ix-body">${built.sections}</div>
${live ? premiumModule(publicEventView(live)) : ''}
${ledger(built.ledger, built.rule, model)}
${continueResearch(story, built)}
${networkModule()}
</div><aside class="ix-side">
${rel.length ? `<section class="ix-related"><h3>Related predictions</h3>${rel.map((e) => `<a class="ix-rel" href="${esc(e.url)}"><span class="cat">${esc(e.category_label)}</span><b>${esc(e.title)}</b><small>${e.headline?.pbe_pct !== null && e.headline?.pbe_pct !== undefined ? `PBE ${e.headline.pbe_pct}% · ` : ''}${e.headline?.market_pct !== null && e.headline?.market_pct !== undefined ? `market ${e.headline.market_pct}%` : 'market monitoring'}</small></a>`).join('')}</section>` : ''}
</aside></div></article><script src="/live.js?v=${LIVE_V}" defer></script>`;
  return layout({
    title: `${built.seo_title} | PropBetEdge Predictions`, description: built.description, canonical: url, ogImage: storyImageUrl(story), ogType: 'article', ogImageAlt: `${built.title} — ${img.hero_alt}`,
    jsonld: [articleJsonLd(story, built, modified)], body,
    extraHead: `<meta property="article:published_time" content="${esc(story.published_at)}">${modified ? `<meta property="article:modified_time" content="${esc(modified)}">` : ''}<meta property="article:section" content="${esc(VERTICALS[story.vertical])}"><link rel="alternate" type="application/rss+xml" title="PropBetEdge Prediction Intelligence" href="${SITE}/insights/rss.xml">`,
    current: 'insights',
  });
}

const storyCard = (s, size = 'md') => `<a class="ix-card ix-card-${size} v-${esc(s.story.vertical)}" href="/insights/${esc(s.story.slug)}">${cardArt(storyImage(s.story), size === 'lg', s.story)}
<span class="ix-eyebrow">${esc(VERTICALS[s.story.vertical].toUpperCase())} · ${esc(s.story.family_label.toUpperCase())}</span>
<b>${esc(s.built.title)}</b>${size !== 'sm' ? `<p>${esc(s.built.dek)}</p>` : ''}
${s.built.hero.type === 'flow' ? `<div class="ix-card-nums"><span class="mkt">${esc(s.built.hero.from)}</span><span class="arr">→</span><span class="pbe">${esc(s.built.hero.to)}</span></div>` : `<div class="ix-card-nums">${s.built.hero.stats.map((x) => `<span class="t-${esc(x.tone)}"><small>${esc(x.label)}</small>${esc(x.value)}</span>`).join('')}</div>`}
<small class="ix-card-meta">${esc(shortDate(s.story.published_at))} · data as of ${esc(fmtUtc(s.built.model_as_of))}</small></a>`;

export function renderDesk({ items, vertical = null, gaps = [], calendar = [], models = [] }) {
  const list = vertical ? items.filter((i) => i.story.vertical === vertical) : items;
  const [lead, ...rest] = list;
  const second = rest.slice(0, 2); const more = rest.slice(2);
  const verticals = [...new Set(items.map((i) => i.story.vertical))];
  const canonical = vertical ? `${SITE}/insights/${vertical}/` : `${SITE}/insights/`;
  const title = vertical ? `${VERTICALS[vertical]} forecasts & analysis | PropBetEdge Prediction Intelligence` : 'Prediction Intelligence — model-vs-market analysis of real-world events | PropBetEdge';
  const description = vertical ? `PropBetEdge ${VERTICALS[vertical].toLowerCase()} analysis built on immutable model forecasts, market prices and official resolution data.` : 'Analysis written from PropBetEdge\'s immutable forecast archive: what the model believed, what the market believed, what changed, why, and how it scored.';
  const jsonld = [{ '@context': 'https://schema.org', '@type': 'CollectionPage', '@id': `${canonical}#page`, url: canonical, name: title.split(' | ')[0], description, isPartOf: { '@id': WEBSITE_ID }, publisher: { '@id': ORG_ID },
    mainEntity: { '@type': 'ItemList', itemListElement: list.map((i, k) => ({ '@type': 'ListItem', position: k + 1, url: storyUrl(i.story), name: i.built.title })) } },
  { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Predictions', item: `${SITE}/` }, { '@type': 'ListItem', position: 2, name: 'Insights', item: `${SITE}/insights/` }, ...(vertical ? [{ '@type': 'ListItem', position: 3, name: VERTICALS[vertical], item: canonical }] : [])] }];
  const body = `<main>
<section class="ix-desk-head"><div class="wrap"><span class="ix-eyebrow">PREDICTION INTELLIGENCE${vertical ? ` · ${esc(VERTICALS[vertical].toUpperCase())}` : ''}</span>
<h1>${vertical ? `${esc(VERTICALS[vertical])}` : 'What the model believed. What the market believed. What happened.'}</h1>
<p>Analysis written from PropBetEdge's immutable forecast archive — every number traceable to a stored snapshot, every story linked to its live event and, once settled, its score.</p>
<nav class="ix-vnav" aria-label="Verticals"><a href="/insights/"${!vertical ? ' aria-current="page"' : ''}>All</a>${verticals.map((v) => `<a href="/insights/${v}/"${vertical === v ? ' aria-current="page"' : ''}>${esc(VERTICALS[v])}</a>`).join('')}<a href="/insights/rss.xml">RSS</a></nav></div></section>
<div class="wrap ix-desk">
<div class="ix-desk-main">${lead ? storyCard(lead, 'lg') : ''}<div class="ix-desk-two">${second.map((s) => storyCard(s)).join('')}</div>${more.length ? `<div class="ix-desk-more">${more.map((s) => storyCard(s, 'sm')).join('')}</div>` : ''}
${!vertical && verticals.length > 1 ? verticals.map((v) => `<section class="ix-band"><h2><a href="/insights/${v}/">${esc(VERTICALS[v])}</a></h2><div class="ix-band-row">${items.filter((i) => i.story.vertical === v).map((s) => storyCard(s, 'sm')).join('')}</div></section>`).join('') : ''}
</div>
<aside class="ix-desk-side">
${gaps.length ? `<section class="ix-rail"><h3>Largest live model–market gaps</h3><p class="note">Live from the intelligence desk</p>${gaps.map((e) => `<a class="ix-rail-row" href="${esc(e.url)}"><span><span class="cat">${esc(e.category_label)}</span> ${esc(e.title)}</span><b class="${e.headline.divergence_pts > 0 ? 'pos' : 'neg'}">${sign(e.headline.divergence_pts)}</b><small>${esc(e.headline.label)} · PBE ${e.headline.pbe_pct}% · mkt ${e.headline.market_pct}%</small></a>`).join('')}</section>` : ''}
${calendar.length ? `<section class="ix-rail"><h3>Upcoming resolutions</h3>${calendar.map((e) => `<a class="ix-rail-row" href="${esc(e.url)}"><span>${esc(e.title)}</span><small>${esc(fmtUtc(e.close_time))} · ${e.state === 'MARKET_MONITORING' ? 'market monitoring' : `${esc(e.state.toLowerCase())} model`}</small></a>`).join('')}</section>` : ''}
${models.length ? `<section class="ix-rail"><h3>Model research</h3>${models.map((m) => `<a class="ix-rail-row" href="/models/"><span>${esc(m.name)}</span><small>${badge(m.state)} ${m.live_forecasts} live forecasts · ${esc(m.calibration_state)}</small></a>`).join('')}</section>` : ''}
</aside></div></main>`;
  return layout({ title, description, canonical, jsonld, body, current: 'insights', ogImage: lead ? storyImageUrl(lead.story) : undefined, extraHead: `<link rel="alternate" type="application/rss+xml" title="PropBetEdge Prediction Intelligence" href="${SITE}/insights/rss.xml">` });
}

export function rssXml(items) {
  const x = (s) => esc(s);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>PropBetEdge Prediction Intelligence</title><link>${SITE}/insights/</link><description>Model-vs-market analysis of real-world events from PropBetEdge's immutable forecast archive.</description><language>en-us</language>
<atom:link href="${SITE}/insights/rss.xml" rel="self" type="application/rss+xml"/>
${items.map((i) => `<item><title>${x(i.built.title)}</title><link>${storyUrl(i.story)}</link><guid isPermaLink="true">${storyUrl(i.story)}</guid><pubDate>${new Date(i.story.published_at).toUTCString()}</pubDate><category>${x(VERTICALS[i.story.vertical])}</category><description>${x(i.built.dek)}</description><media:content url="${storyImageUrl(i.story)}" medium="image" width="1200" height="630"/></item>`).join('\n')}
</channel></rss>
`;
}

export function newsSitemapXml(items, now = Date.now()) {
  const recent = items.filter((i) => now - Date.parse(i.story.published_at) <= 2 * 86400000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${recent.map((i) => `<url><loc>${storyUrl(i.story)}</loc><news:news><news:publication><news:name>PropBetEdge Predictions</news:name><news:language>en</news:language></news:publication><news:publication_date>${i.story.published_at}</news:publication_date><news:title>${esc(i.built.title)}</news:title></news:news></url>`).join('\n')}
</urlset>
`;
}
