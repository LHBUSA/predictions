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

const BRAND = `<a class="brand" href="/"><img class="brand-mark" src="/brand/predictions-mark.svg" width="32" height="32" alt=""><span>PropBetEdge<small>PREDICTIONS</small></span></a>`;
const productLinks = (current) => NET.product.map(([label, href, key]) => `<a href="${href}"${key === current ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('');

export function siteHeader(current = null) {
  return `<link rel="stylesheet" href="/pbe-consent-v1.css"><script src="/pbe-consent-v1.js"></script><header class="topbar"><div class="wrap">
${BRAND}
<nav class="nav" aria-label="Predictions">${productLinks(current)}</nav>
<div class="top-right">
<span class="live-dot" id="live-dot"><i></i><span id="live-text">Live engine</span></span>
${THEME_BTN}
<a class="net-link" href="${NET.brand.url}" data-pbe-placement="predictions_header_network"><span class="net-long">PropBetEdge Network</span><span class="net-short">Network</span> <span aria-hidden="true">↗</span></a>
<a class="mem-chip" id="mem-chip" href="#" data-pbe-signin data-state="loading" aria-label="Account"><span class="mem-state">Account</span></a>
<a class="aa-pill" href="${NET.all_access.url}" data-acct-cta data-pbe-placement="predictions_header_all_access" aria-label="Get PropBetEdge All Access, $29/month">Get All Access</a>
</div></div>
<nav class="subnav" aria-label="Predictions sections"><div class="subnav-track">${productLinks(current)}<a class="subnav-net" href="${NET.brand.url}">PropBetEdge ↗</a></div></nav>
</header>
<script src="/access.js?v=${ACCESS_V}" defer></script>
<script src="/theme.js?v=${THEME_V}" defer></script>`;
}

export function siteFooter() {
  const col = (title, rows, external = false) => `<div class="nf-col"><strong>${e(title)}</strong>${rows.map(([label, href]) => `<a href="${href}"${external || /^https?:/.test(href) ? ` ${ext}` : ''}>${e(label)}</a>`).join('')}</div>`;
  return `<footer class="footer net-footer"><div class="wrap">
<div class="nf-grid">
${col('Predictions', NET.footer_product)}
<div class="nf-col nf-sports"><strong>PropBetEdge Sports</strong><div class="nf-sports-grid">${NET.sports.map(([label, href]) => `<a href="${href}" ${ext}>${e(label)}</a>`).join('')}</div></div>
${col('Network', NET.network)}
<div class="nf-col"><strong>Trust</strong>${NET.trust.map(([label, href]) => `<a href="${href}">${e(label)}</a>`).join('')}<span class="nf-note">${e(NET.disclaimer)}</span></div>
</div>
<p class="nf-line"><a href="${NET.all_access.url}" data-pbe-placement="predictions_footer_all_access"><strong>PropBetEdge All Access</strong></a> — 10 sports + PropBetEdge Predictions for $29/month.</p>
<p class="nf-fine"><a href="${NET.brand.url}" ${ext}>PropBetEdge</a> · Predictions is part of the PropBetEdge intelligence network.</p>
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
