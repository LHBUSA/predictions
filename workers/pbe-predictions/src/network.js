// PropBetEdge network shell for predictions.propbetedge.ai — ONE implementation of the header and footer, used by the
// Worker's server-rendered pages and (via scripts/brand/shell.mjs) by index.html and the generated static pages.
// Source of truth for links/copy: brand/network.json. Predictions is a product included in All Access, not a sport.
import NET from '../../../brand/network.json' with { type: 'json' };

export const NETWORK = NET;
export const ACCESS_V = '20261005aa1';
export const THEME_V = '20261004t1';
// applied in <head> before first paint (no flash); light = no attribute (default)
export const THEME_BOOT = `<script>try{var t=localStorage.getItem('pbe-theme');if(t==='dark'||t==='system')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>`;
const THEME_BTN = `<button type="button" class="theme-btn" data-theme-toggle aria-label="Theme: Light. Switch to Dark" title="Theme: Light (click for Dark)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg><span class="theme-label">Light</span></button>`;
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ext = 'target="_blank" rel="noopener"';

// Compact line icons (16px grid, currentColor stroke). One per product key; decorative only (aria-hidden).
const ICON_PATHS = {
  overview: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  signal10: '<path d="M1.5 8.5h2.6l1.7-4.6 2.7 8.6 2-5.5 1.1 1.5h2.9"/>',
  desk: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><path d="M4.6 6.4l2 1.6-2 1.6M8.3 10h3"/>',
  // Bitcoin mark: B with the two through-strokes
  crypto: '<path d="M5.5 3.5h4a2.1 2.1 0 010 4.2h-4zM5.5 7.7h4.6a2.4 2.4 0 010 4.8H5.5zM5.5 3.5v9M7 1.8v1.7M9 1.8v1.7M7 12.5v1.7M9 12.5v1.7"/>',
  markets: '<path d="M2 13.5h12"/><path d="M4.5 4v7.5M8 2.5v8M11.5 5.5v5"/><rect x="3.4" y="6" width="2.2" height="3.5" rx=".4"/><rect x="6.9" y="4" width="2.2" height="4.5" rx=".4"/><rect x="10.4" y="7" width="2.2" height="2.5" rx=".4"/>',
  insights: '<rect x="2.5" y="1.8" width="11" height="12.4" rx="1.5"/><path d="M5 5h6M5 7.8h6M5 10.6h3.6"/>',
  record: '<path d="M3 2.2h8.6a1.4 1.4 0 011.4 1.4v10.2H4.4A1.4 1.4 0 013 12.4z"/><path d="M3 11.2a1.4 1.4 0 011.4-1.4H13"/><path d="M5.6 5.6l1.4 1.4 2.8-2.8"/>',
  research: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2l3.6 3.6M5 7h4M7 5v4"/>',
  // all markets: a 3x3 catalog grid
  allmarkets: '<path d="M2.5 3h3v3h-3zM6.5 3h3v3h-3zM10.5 3h3v3h-3zM2.5 7h3v3h-3zM6.5 7h3v3h-3zM10.5 7h3v3h-3zM2.5 11h3v3h-3zM6.5 11h3v3h-3z"/><path d="M10.5 12.5h3"/>',
  // precious metals: two stacked ingots
  metals: '<path d="M2 13.2h5.4l-1-3.6H3z"/><path d="M8.6 13.2H14l-1-3.6H9.6z"/><path d="M5.3 8.4h5.4l-1-3.6H6.3z"/>',
};
const icon = (key) => ICON_PATHS[key] ? `<svg class="nav-ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICON_PATHS[key]}</svg>` : '';

const BRAND = `<a class="brand" href="/"><img class="brand-mark" src="/brand/predictions-mark.svg" width="32" height="32" alt=""><span>PropBetEdge<small>PREDICTIONS</small></span></a>`;
// Product link: icon + label. Signal 10 carries a data-signal hook for its pulse accent.
// current = a product key (this page IS that product) or '<key>/child' (a page inside that product's section, e.g. a
// per-metal page under Metals): the section link is then marked aria-current="true", never "page".
const currentAttr = (key, current) => (key === current ? ' aria-current="page"' : typeof current === 'string' && current === `${key}/child` ? ' aria-current="true"' : '');
// An optional 4th field is a compact label shown on mid-width desktops (CSS .nl-long / .nl-short); the link's
// aria-label always carries the full product name.
const link = (current) => ([label, href, key, short]) => `<a href="${href}"${currentAttr(key, current)}${key === 'signal10' ? ' data-signal' : ''}${short ? ` aria-label="${e(label)}"` : ''}>${icon(key)}${short ? `<span class="nl-long">${e(label)}</span><span class="nl-short" aria-hidden="true">${e(short)}</span>` : `<span>${e(label)}</span>`}</a>`;
const productLinks = (current) => NET.product.map(link(current)).join('');
// Research: a grouped mega menu (desktop) in one native <details> (keyboard + screen-reader friendly, no script); the
// summary carries the active state when the current page lives inside it. In-page anchors (#immutable …) never take
// aria-current. Mobile: a compact page list flattened into the single horizontal tab strip (never two stacked navs).
const R = NET.research;
const researchKeys = new Set(R.groups.flatMap((g) => g.items.map(([, , key]) => key)).filter(Boolean));
const researchMenu = (current) => {
  const active = researchKeys.has(current);
  const item = ([label, href, key, desc]) => `<a href="${href}"${key && key === current ? ' aria-current="page"' : ''}><b>${e(label)}</b><small>${e(desc)}</small></a>`;
  return `<details class="nav-drop"${active ? ' data-active' : ''}><summary${active ? ' aria-current="true"' : ''}>${icon('research')}<span>${e(R.label)}</span><span aria-hidden="true" class="nav-caret"></span></summary><div class="nav-menu nav-mega">`
    + `<div class="nm-intro"><span class="nm-kicker">Research</span><p>${e(R.intro)}</p><a class="nm-cta" href="/about/">What is PropBetEdge Predictions? <span aria-hidden="true">→</span></a></div>`
    + R.groups.map((g) => `<div class="nm-group"><span class="nm-title">${e(g.title)}</span>${g.items.map(item).join('')}</div>`).join('')
    + `</div></details>`;
};
const researchLinks = (current) => R.strip.map(([label, href, key]) => `<a href="${href}"${key === current ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('');

// live: optional page-owned status indicator (the Crypto desk reports its nowcast feed in #crypto-live); default = the
// engine heartbeat (#live-dot / #live-text / #live-tip) that core.js keeps honest; false = no chip (pages without core.js).
export function siteHeader(current = null, { live = null } = {}) {
  const liveDot = live === false ? '' : live ? `<span class="live-dot" id="${e(live.id)}"><i></i><span>${e(live.text)}</span></span>`
    : `<span class="live-dot" id="live-dot" tabindex="0" aria-describedby="live-tip"><i></i><span id="live-text">Live engine</span><span class="live-tip" id="live-tip" role="tooltip">${e(NET.live_tip)}</span></span>`;
  return `<link rel="stylesheet" href="/pbe-consent-v1.css"><script src="/pbe-consent-v1.js"></script><header class="topbar"><div class="wrap">
${BRAND}
<nav class="nav" aria-label="Predictions">${productLinks(current)}${researchMenu(current)}</nav>
<div class="top-right">
${liveDot}
${THEME_BTN}
<a class="net-link" href="${NET.brand.url}" data-pbe-placement="predictions_header_network"><span class="net-long">PropBetEdge Network</span><span class="net-short">Network</span> <span aria-hidden="true">↗</span></a>
<a class="mem-chip" id="mem-chip" href="#" data-pbe-signin data-state="loading" aria-label="Account"><span class="mem-state">Account</span></a>
<a class="aa-pill" href="${NET.all_access.url}" data-acct-cta data-pbe-placement="predictions_header_all_access" aria-label="Get PropBetEdge All Access, $29/month">Get All Access</a>
</div></div>
<nav class="subnav" aria-label="Predictions sections"><div class="subnav-track">${productLinks(current)}${researchLinks(current)}<a class="subnav-net" href="${NET.brand.url}">PropBetEdge ↗</a></div></nav>
</header>
<script src="/access.js?v=${ACCESS_V}" defer></script>
<script src="/theme.js?v=${THEME_V}" defer></script>`;
}

export function siteFooter() {
  // trust/legal pages open in place (as before); other cross-site destinations open a new tab
  const sameTab = new Set(NET.trust.map(([, href]) => href));
  const a = ([label, href]) => `<a href="${href}"${/^https?:/.test(href) && !sameTab.has(href) ? ` ${ext}` : ''}>${e(label)}</a>`;
  const col = (title, rows, cls = '') => `<div class="nf-col${cls}"><strong>${e(title)}</strong>${rows.map(a).join('')}</div>`;
  const M = NET.mission;
  return `<footer class="footer net-footer"><div class="wrap">
<section class="nf-intro" aria-labelledby="nf-intro-h">
<div class="nf-brandline"><img src="/brand/predictions-mark.svg" width="36" height="36" alt=""><div><span class="nf-kicker">PropBetEdge Predictions</span><h2 id="nf-intro-h">${e(M.title)}</h2></div></div>
<p class="nf-mission">${e(M.body)}</p>
<ul class="nf-pillars">${M.pillars.map((p) => `<li>${e(p)}</li>`).join('')}</ul>
<a class="nf-more" href="/about/">What is PropBetEdge Predictions? <span aria-hidden="true">→</span></a>
</section>
<div class="nf-grid">
${col('Predictions', NET.footer_product)}
${col('What We Cover', NET.coverage)}
<div class="nf-col nf-sports"><strong>PropBetEdge Sports</strong><div class="nf-sports-grid">${NET.sports.map(([label, href]) => `<a href="${href}" ${ext}>${e(label)}</a>`).join('')}</div></div>
${col('All Access', NET.all_access_products.filter(([, href]) => href !== NET.all_access.url))}
<div class="nf-col"><strong>Network &amp; Trust</strong>${NET.network_trust.filter(([, href]) => !sameTab.has(href)).map(a).join('')}<span class="nf-sub">Trust</span>${NET.trust.map(a).join('')}</div>
</div>
<div class="nf-base">
<p class="nf-line"><a href="${NET.all_access.url}" data-pbe-placement="predictions_footer_all_access"><strong>PropBetEdge All Access</strong></a> — 10 sports + Predictions + Compare for $29/month.</p>
<p class="nf-note">${e(NET.disclaimer)}</p>
<p class="nf-fine"><a href="${NET.brand.url}" ${ext}>PropBetEdge</a> · 10 sports + Predictions + Compare — part of the broader PropBetEdge intelligence network.</p>
</div>
</div></footer>`;
}

// End-of-article module: restrained, one per story.
export function networkModule() {
  return `<aside class="net-module" aria-label="PropBetEdge network">
<span class="net-module-kicker">Part of the PropBetEdge intelligence network</span>
<p><a href="${NET.brand.url}">PropBetEdge</a> runs sport-specific intelligence for ten live sports and PropBetEdge Predictions for real-world events.</p>
<a class="aa-pill" href="${NET.all_access.url}" data-pbe-placement="predictions_article_all_access">10 sports + PropBetEdge Predictions · All Access $29/month</a>
</aside>`;
}
