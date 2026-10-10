// Generates all-markets/index.html (#79) with the ONE network shell. Data loads client-side from /api/market-catalog
// (market-catalog/1, LHBUSA/propbetedge-workers#37) through a Vercel rewrite; the browser never calls a venue.
//   node scripts/markets/gen-all-markets.mjs   (run from the repo root)
import { writeFileSync, mkdirSync } from 'node:fs';
import { siteHeader, siteFooter } from '../../workers/pbe-predictions/src/network.js';

const SITE_V = '20261011nav77';
const V = '20261011am1';
const BASE = 'https://predictions.propbetedge.ai';
const title = 'All Non-Sports Prediction Markets · Kalshi & Polymarket | PropBetEdge Predictions';
const desc = 'Browse the non-sports prediction markets listed on Kalshi and Polymarket — politics, economics, weather, crypto, commodities, science and more — with venue prices, close times and direct venue links. Coverage of the full catalog is shown honestly.';
const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', '@id': `${BASE}/all-markets/#webpage`, name: title, url: `${BASE}/all-markets/`, description: desc,
  isPartOf: { '@id': `${BASE}/#website` }, publisher: { '@id': 'https://propbetedge.ai/#organization' },
  breadcrumb: { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Predictions', item: `${BASE}/` }, { '@type': 'ListItem', position: 2, name: 'All Markets', item: `${BASE}/all-markets/` }] } }] }).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="${desc}">
<link rel="canonical" href="${BASE}/all-markets/"><meta name="robots" content="index,follow"><meta name="theme-color" content="#0e2a4a"><script>try{var t=localStorage.getItem('pbe-theme');if(t==='dark'||t==='system')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<meta property="og:type" content="website"><meta property="og:site_name" content="PropBetEdge Predictions"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${BASE}/all-markets/"><meta property="og:image" content="${BASE}/og/predictions-card.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/site.css?v=${SITE_V}"><link rel="stylesheet" href="/all-markets/explorer.css?v=${V}">
<script type="application/ld+json">${ld}</script>
</head><body>
<!-- network:header -->
${siteHeader('allmarkets')}
<!-- /network:header -->
<main class="wrap section page-main am-page" id="main">
<header class="page-head"><span class="overline">ALL NON-SPORTS MARKETS</span><h1>Every non-sports market on Kalshi and Polymarket</h1>
<p class="page-lede">Politics, economics, weather, crypto, commodities, science and more — straight from each venue’s listing, with its price, close time and a direct link. Sports markets are excluded.</p>
<p class="note">This is the venues’ catalog, not PBE forecasts: model probabilities exist only for events on the <a href="/desk/">Intelligence Desk</a>. Prices are venue listing prices with when we read them; never live.</p></header>
<div id="am-app" data-state="loading"><div class="card skel" style="height:120px"></div><p class="sr-only" role="status">Loading the market catalog…</p></div>
</main>
<!-- network:footer -->
${siteFooter()}
<!-- /network:footer -->
<script type="module" src="/all-markets/explorer.js?v=${V}"></script>
</body></html>
`;
mkdirSync('all-markets', { recursive: true });
writeFileSync('all-markets/index.html', html);
console.log('wrote all-markets/index.html');
