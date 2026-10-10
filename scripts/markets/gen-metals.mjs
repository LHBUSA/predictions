// Generates markets/metals/index.html (issue #63) with the ONE network shell. Data loads client-side from /api/metals.
//   node scripts/markets/gen-metals.mjs   (run from the repo root)
import { writeFileSync, mkdirSync } from 'node:fs';
import { siteHeader, siteFooter } from '../../workers/pbe-predictions/src/network.js';

const V = '20261010mt1';
const SITE_V = '20261010nav1';
const BASE = 'https://predictions.propbetedge.ai';
const title = 'Gold, Silver & Platinum Tracker | PropBetEdge Predictions';
const desc = 'Gold (XAU), silver (XAG) and platinum (XPT) research tracker: spot price source rights, the GLD, SLV and PPLT exchange-traded trusts with next-day IEX prices, and how precious metals differ from stocks.';
const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': [
  { '@type': 'WebPage', '@id': `${BASE}/markets/metals/#webpage`, name: title, url: `${BASE}/markets/metals/`, description: desc, isPartOf: { '@id': `${BASE}/#website` }, publisher: { '@id': 'https://propbetedge.ai/#organization' } },
] }).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en" class="s10">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${BASE}/markets/metals/">
<meta name="theme-color" content="#14110d">
<meta property="og:type" content="website"><meta property="og:site_name" content="PropBetEdge Predictions"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${BASE}/markets/metals/"><meta property="og:image" content="${BASE}/og/predictions-card.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>try{var t=localStorage.getItem('pbe-theme');if(t==='dark'||t==='system')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<link rel="stylesheet" href="/site.css?v=${SITE_V}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&display=swap">
<link rel="stylesheet" href="/markets/signal-10/signal10.css?v=20261010tape1">
<link rel="stylesheet" href="/markets/metals/metals.css?v=${V}">
<script type="application/ld+json">${ld}</script>
</head>
<body class="s10-page" data-page="metals">
<!-- network:header -->
${siteHeader('metals', { live: false })}
<!-- /network:header -->

<main id="main">
<section class="s10-mast"><div class="wrap">
  <div class="s10-kicker"><span>Commodities</span><span aria-hidden="true">·</span><span>Precious metals</span><span class="s10-rule" aria-hidden="true"></span><span>Research</span></div>
  <h1 class="s10-h1">Gold, Silver &amp; Platinum</h1>
  <p class="s10-dek">The three precious metals in U.S. dollars per troy ounce, the exchange-traded trusts that hold them, and exactly which prices we are allowed to show you. No price appears here without a source that permits it.</p>
  <p class="s10-disclosure" role="note"><b>RESEARCH</b><span>Education and research, not investment advice. An ETF share price is not a spot metal price.</span></p>
</div></section>
<div class="wrap s10-body">
<div id="mt-app" data-state="loading"><div class="s10-loading" aria-hidden="true"></div><p class="sr-only" role="status">Loading the metals record…</p></div>
<section class="mt-sec" aria-labelledby="mt-learn-h"><h2 id="mt-learn-h" class="s10-h2">How precious metals differ from stocks</h2>
<div class="mt-learn">
<article><h3>No cash flows</h3><p>A share of a company is a claim on future earnings and dividends. An ounce of gold pays nothing, so its price rests on supply, demand, the U.S. dollar and real interest rates rather than on profits.</p></article>
<article><h3>Gold, silver and platinum behave differently</h3><ul><li><b>Gold</b> is held mostly as a store of value by investors and central banks.</li><li><b>Silver</b> is part monetary metal, part industrial input (electronics, solar), and usually more volatile.</li><li><b>Platinum</b> is mainly industrial (autocatalysts, chemicals) and tied to a small set of producers.</li></ul></article>
<article><h3>Sometimes a diversifier, not a guarantee</h3><p>Metals have at times moved differently from stocks in sell-offs, and at other times fallen with them. We record how they behave against the equity accounts in the Strategy Arena, and make no claim that they hedge until enough forward outcomes exist to test it.</p></article>
<article><h3>Limits of the ETF route</h3><ul><li>Trusts charge fees (0.40%–0.60% a year here) that slowly reduce metal per share.</li><li>They trade only in U.S. equity sessions; spot metal trades around the clock.</li><li>Prices shown are IEX-venue last sales from the previous session, not live and not consolidated.</li></ul></article>
</div></section>
</div>
</main>

<!-- network:footer -->
${siteFooter()}
<!-- /network:footer -->
<script src="/markets/metals/metals.js?v=${V}" defer></script>
</body></html>
`;
mkdirSync('markets/metals', { recursive: true });
writeFileSync('markets/metals/index.html', html);
console.log('wrote markets/metals/index.html');
