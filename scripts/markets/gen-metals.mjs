// Generates the precious-metals pages (issues #63 / #66) with the ONE network shell. Data loads client-side from
// /api/metals (contract metals/1); a page narrows to one metal with <body data-metal>.
//   markets/metals/index.html          overview of all three
//   commodities/{gold,silver,platinum}/index.html   one page per metal (destinations of gold./silver./platinum. hosts)
//   node scripts/markets/gen-metals.mjs   (run from the repo root)
import { writeFileSync, mkdirSync } from 'node:fs';
import { siteHeader, siteFooter } from '../../workers/pbe-predictions/src/network.js';

const V = '20261010mt2';
const SITE_V = '20261010nav1';
const S10_V = '20261010w2';
const BASE = 'https://predictions.propbetedge.ai';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const LEARN_ALL = `<article><h3>No cash flows</h3><p>A share of a company is a claim on future earnings and dividends. An ounce of gold pays nothing, so its price rests on supply, demand, the U.S. dollar and real interest rates rather than on profits.</p></article>
<article><h3>Gold, silver and platinum behave differently</h3><ul><li><b>Gold</b> is held mostly as a store of value by investors and central banks.</li><li><b>Silver</b> is part monetary metal, part industrial input (electronics, solar), and usually more volatile.</li><li><b>Platinum</b> is mainly industrial (autocatalysts, chemicals) and tied to a small set of producers.</li></ul></article>
<article><h3>Sometimes a diversifier, not a guarantee</h3><p>Metals have at times moved differently from stocks in sell-offs, and at other times fallen with them. We record how they behave against the equity accounts in the Strategy Arena, and make no claim that they hedge until enough forward outcomes exist to test it.</p></article>
<article><h3>Limits of the ETF route</h3><ul><li>Trusts charge fees (0.40%–0.60% a year here) that slowly reduce metal per share.</li><li>They trade only in U.S. equity sessions; spot metal trades around the clock.</li><li>Prices shown are IEX-venue last sales from the previous session, not live and not consolidated.</li></ul></article>`;

const METALS = {
  GOLD: { slug: 'gold', name: 'Gold', code: 'XAU', etf: 'GLD', fee: '0.40%',
    learn: `<article><h3>What moves gold</h3><p>Gold is held mainly as a store of value by investors and central banks. Its price tends to respond to real (inflation-adjusted) interest rates, the U.S. dollar and demand for safety; it has no earnings to anchor it.</p></article>
<article><h3>Reading the GLD proxy</h3><p>SPDR Gold Shares (GLD) is a grantor trust holding allocated gold; its net asset value is set from the LBMA Gold Price PM. The 0.40% annual fee slowly reduces the gold behind each share, so GLD drifts below spot over time.</p></article>` },
  SILVER: { slug: 'silver', name: 'Silver', code: 'XAG', etf: 'SLV', fee: '0.50%',
    learn: `<article><h3>What moves silver</h3><p>Silver is part monetary metal, part industrial input — electronics, solar panels, brazing — so it reacts both to the forces that move gold and to the industrial cycle. It is usually more volatile than gold.</p></article>
<article><h3>Reading the SLV proxy</h3><p>The iShares Silver Trust (SLV) holds physical silver and values it from the LBMA Silver Price. Its 0.50% annual fee reduces the silver behind each share over time; it split 10-for-1 on July 24, 2008.</p></article>` },
  PLATINUM: { slug: 'platinum', name: 'Platinum', code: 'XPT', etf: 'PPLT', fee: '0.60%',
    learn: `<article><h3>What moves platinum</h3><p>Platinum is mainly an industrial metal — catalytic converters, chemical and glass production — with a small investment market. Mine supply is concentrated in a few countries, so supply disruptions and auto demand weigh heavily on its price.</p></article>
<article><h3>Reading the PPLT proxy</h3><p>The abrdn Physical Platinum Shares ETF (PPLT) holds physical platinum valued from the LBMA Platinum Price. Its 0.60% annual fee reduces the platinum behind each share over time; it split 10-for-1 on May 18, 2026 (SEC 8-K).</p></article>` },
};

function page({ path, metal, title, desc, kicker, h1, dek, learnTitle, learn }) {
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', '@id': `${BASE}${path}#webpage`, name: title, url: `${BASE}${path}`, description: desc, isPartOf: { '@id': `${BASE}/#website` }, publisher: { '@id': 'https://propbetedge.ai/#organization' },
      breadcrumb: { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Predictions', item: `${BASE}/` }, { '@type': 'ListItem', position: 2, name: 'Precious metals', item: `${BASE}/markets/metals/` }, ...(metal ? [{ '@type': 'ListItem', position: 3, name: METALS[metal].name, item: `${BASE}${path}` }] : [])] } },
  ] }).replace(/</g, '\\u003c');
  const siblings = `<nav class="mt-siblings" aria-label="Precious metals"><a href="/markets/metals/"${metal ? '' : ' aria-current="page"'}>All three</a>${Object.entries(METALS).map(([k, m]) => `<a href="/commodities/${m.slug}/"${k === metal ? ' aria-current="page"' : ''}>${m.name}</a>`).join('')}</nav>`;
  return `<!doctype html>
<html lang="en" class="s10">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${BASE}${path}">
<meta name="theme-color" content="#14110d">
<meta property="og:type" content="website"><meta property="og:site_name" content="PropBetEdge Predictions"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${BASE}${path}"><meta property="og:image" content="${BASE}/og/predictions-card.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>try{var t=localStorage.getItem('pbe-theme');if(t==='dark'||t==='system')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<link rel="stylesheet" href="/site.css?v=${SITE_V}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&display=swap">
<link rel="stylesheet" href="/markets/signal-10/signal10.css?v=${S10_V}">
<link rel="stylesheet" href="/markets/metals/metals.css?v=${V}">
<script type="application/ld+json">${ld}</script>
</head>
<body class="s10-page" data-page="metals"${metal ? ` data-metal="${metal}"` : ''}>
<!-- network:header -->
${siteHeader('metals', { live: false })}
<!-- /network:header -->

<main id="main">
<section class="s10-mast"><div class="wrap">
  <div class="s10-kicker"><span>Commodities</span><span aria-hidden="true">·</span><span>${esc(kicker)}</span><span class="s10-rule" aria-hidden="true"></span><span>Research</span></div>
  <h1 class="s10-h1">${h1}</h1>
  <p class="s10-dek">${esc(dek)}</p>
  <p class="s10-disclosure" role="note"><b>RESEARCH</b><span>Education and research, not investment advice. An ETF share price is not a spot metal price.</span></p>
  ${siblings}
</div></section>
<div class="wrap s10-body">
<div id="mt-app" data-state="loading"><div class="s10-loading" aria-hidden="true"></div><p class="sr-only" role="status">Loading the metals record…</p></div>
<section class="mt-sec" aria-labelledby="mt-learn-h"><h2 id="mt-learn-h" class="s10-h2">${esc(learnTitle)}</h2>
<div class="mt-learn">
${learn}
</div></section>
</div>
</main>

<!-- network:footer -->
${siteFooter()}
<!-- /network:footer -->
<script src="/markets/metals/metals.js?v=${V}" defer></script>
</body></html>
`;
}

const out = [];
out.push(['markets/metals/index.html', page({ path: '/markets/metals/', metal: null,
  title: 'Gold, Silver & Platinum Tracker | PropBetEdge Predictions',
  desc: 'Gold (XAU), silver (XAG) and platinum (XPT) research tracker: spot price source rights, the GLD, SLV and PPLT exchange-traded trusts with next-day IEX prices, and how precious metals differ from stocks.',
  kicker: 'Precious metals', h1: 'Gold, Silver &amp; Platinum',
  dek: 'The three precious metals in U.S. dollars per troy ounce, the exchange-traded trusts that hold them, and exactly which prices we are allowed to show you. No price appears here without a source that permits it.',
  learnTitle: 'How precious metals differ from stocks', learn: LEARN_ALL })]);
for (const [key, m] of Object.entries(METALS)) {
  out.push([`commodities/${m.slug}/index.html`, page({ path: `/commodities/${m.slug}/`, metal: key,
    title: `${m.name} (${m.code}/USD) Tracker — Spot Rights & ${m.etf} | PropBetEdge Predictions`,
    desc: `${m.name} (${m.code}/USD, per troy ounce) research tracker: spot price source rights, the ${m.etf} exchange-traded trust with next-day IEX prices, and what moves ${m.name.toLowerCase()}.`,
    kicker: m.name, h1: m.name,
    dek: `${m.name} in U.S. dollars per troy ounce, the ${m.etf} exchange-traded trust that holds it, and exactly which prices we are allowed to show you. No price appears here without a source that permits it.`,
    learnTitle: `Understanding ${m.name.toLowerCase()}`, learn: m.learn })]);
}
for (const [file, html] of out) {
  mkdirSync(file.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(file, html);
  console.log('wrote', file);
}
