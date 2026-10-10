// Generates the five static Signal 10 pages with the shared network header + footer.
// node scripts/signal10/pages/gen-pages.mjs   (run from the repo root; writes markets/signal-10/**/index.html)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURED, robinhoodUrl } from '../../../src/signal10/tape.js';
import { siteHeader, siteFooter } from '../../../workers/pbe-predictions/src/network.js';

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const V = '20261010tape1';
// The ONE network shell (workers/pbe-predictions/src/network.js), current = Signal 10, wrapped in the same markers
// the other static pages carry. No live chip: these pages do not load core.js, which keeps the engine chip honest.
const header = `<!-- network:header -->
${siteHeader('signal10', { live: false })}
<!-- /network:header -->`;
const footer = `<!-- network:footer -->
${siteFooter()}
<!-- /network:footer -->`;

const BASE = 'https://predictions.propbetedge.ai';
const TABS = [
  ['now', '/markets/signal-10/', 'Live Algorithm'],
  ['live', '/markets/signal-10/live/', 'Live $10k Portfolio'],
  ['ledger', '/markets/signal-10/ledger/', 'Trade Ledger'],
  ['methodology', '/markets/signal-10/methodology/', 'Methodology'],
  ['arena', '/markets/signal-10/arena/', 'Strategy Arena'],
  ['backtest', '/markets/signal-10/backtest/', 'Backtest (research)'],
];
// U.S. stock tape (issue #54): featured links are static (work without JS, no layout shift); tape.js fills prices.
const escA = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const TAPE = `<section class="s10-tape" id="s10-tape" data-state="loading" aria-labelledby="s10-tape-h"><div class="wrap">
  <div class="s10-tape-head"><h2 id="s10-tape-h" class="s10-tape-h">U.S. Stocks</h2><span class="s10-tape-status" data-tape-status role="status" aria-live="polite">U.S. regular session</span><span class="s10-tape-meta" data-tape-meta></span></div>
  <div class="s10-tape-track" data-tape-track role="group" aria-label="Featured U.S. stocks — each opens its Robinhood page in a new tab">
    <span class="s10-tg">Featured</span>
${FEATURED.map((f) => `    <a class="s10-tq${f.pinned ? ' pin' : ''}" data-sym="${f.symbol}" href="${robinhoodUrl(f.symbol)}" target="_blank" rel="noopener noreferrer external" title="${escA(`${f.symbol} · ${f.name}. Opens Robinhood’s ${f.symbol} page in a new tab; prices, eligibility and any order are handled entirely by Robinhood.`)}"><span class="s10-tq-top"><b class="s10-tq-sym">${f.symbol}</b><span class="s10-tq-ch num flat"></span></span><span class="s10-tq-bot"><span class="s10-tq-px num">${escA(f.name)}</span><span class="s10-tq-go" aria-hidden="true">↗</span></span><span class="sr-only"> ${escA(f.name)}. View ${f.symbol} on Robinhood (opens in a new tab)</span></a>`).join(String.fromCharCode(10))}
  </div>
</div></section>`;
const tabs = (cur) => `<nav class="s10-tabs" aria-label="Signal 10 sections">${TABS.map(([k, h, t]) => `<a href="${h}"${k === cur ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>`;

function page({ key, title, desc, h1, dek, body, css = null, js = null }) {
  const path = TABS.find((t) => t[0] === key)[1];
  return `<!doctype html>
<html lang="en" class="s10">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal 10 · ${title} | PropBetEdge Predictions</title>
<meta name="description" content="${desc}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${BASE}${path}">
<meta name="theme-color" content="#14110d">
<link rel="stylesheet" href="/site.css?v=20261010nav1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&display=swap">
<link rel="stylesheet" href="/markets/signal-10/signal10.css?v=${V}">${css ? `\n<link rel="stylesheet" href="${css}?v=${V}">` : ''}
</head>
<body class="s10-page" data-page="${key}">
${header}

<main id="main">
<section class="s10-mast"><div class="wrap">
  <div class="s10-kicker"><span>PBE Signal 10</span><span aria-hidden="true">·</span><span>The $10,000 Experiment</span><span class="s10-rule" aria-hidden="true"></span><span>Markets AI</span></div>
  <h1 class="s10-h1">${h1}</h1>
  <p class="s10-dek">${dek}</p>
  <p class="s10-disclosure" role="note"><b>HYPOTHETICAL / SIMULATED</b><span>Paper results only. Not actual trading. Not investment advice. Scores are a 0–100 rank index, not a probability.</span></p>
  ${tabs(key)}
</div></section>
${TAPE}
<div class="wrap s10-body">
${body}
</div>
</main>

${footer}
<script type="module" src="/markets/signal-10/signal10-core.js?v=${V}"></script>
<script src="/markets/signal-10/signal10.js?v=${V}" defer></script>
<script src="/markets/signal-10/tape.js?v=${V}" defer></script>${js ? `\n<script src="${js}?v=${V}" defer></script>` : ''}
</body></html>
`;
}

const APP = '<div id="s10-app" data-state="loading"><div class="s10-loading" aria-hidden="true"></div><p class="sr-only" role="status">Loading Signal 10 data…</p></div>';

const pages = [
  { key: 'now', title: 'Live Algorithm', h1: 'The Algorithm, Live',
    desc: 'PBE Signal 10 live: the algorithm’s $10,000 paper account, today’s frozen top 10 of the S&P 500, queued orders and every decision. Simulated paper research; not actual trading.',
    dek: 'What the algorithm owns right now, what it is worth at the latest timestamped quotes, today’s top 10 and the orders it has queued for the next open. Rankings freeze once per day after the U.S. close; prices move the account during the session.',
    body: `${APP}
<div id="s10-rank" data-state="loading"></div>` },
  { key: 'live', title: 'Live $10k Portfolio', h1: 'Live $10,000 Paper Portfolio',
    desc: 'PBE Signal 10 paper account: $10,000 of simulated cash run by pre-registered rules, marked with timestamped quotes. Hypothetical / simulated; not actual trading.',
    dek: 'Simulated cash, real timestamps. The forward paper account started with $10,000 and is marked from source quotes with their own trade times. Nothing here is a brokerage account.',
    body: APP },
  { key: 'backtest', title: 'Backtest (research)', h1: 'Backtest Research, 2018–2026',
    desc: 'PBE Signal 10 historical backtest: $10,000 of hypothetical capital from 2018-01-02, versus SPY and QQQ, with every month, drawdown and cost shown. Reconstructed history; hypothetical.',
    dek: 'Research only — not the live algorithm’s record. A reconstruction of what the pre-registered rules would have done with $10,000 from January 2018, using point-in-time S&P 500 membership. It trailed both SPY and QQQ. Every month is shown, including the losing ones.',
    body: APP },
  { key: 'ledger', title: 'Trade Ledger', h1: 'Trade Ledger',
    desc: 'PBE Signal 10 ledgers: every simulated fill, dividend, split and decision for the historical backtest and the forward paper account, kept separate.',
    dek: 'Every live paper-account event, append-only and hash-chained: fills, orders, waits, holds, dividends and daily marks. The backtest ledger is a separate research record and is never combined with it.',
    body: APP },
  { key: 'arena', title: 'Strategy Arena', h1: 'The Strategy Arena',
    desc: 'PBE Signal 10 Strategy Arena: three brand-new $10,000 simulated paper accounts — the original Signal 10 rules, Tech Conviction and Diversified Risk Discipline — launched together on the same market. Hypothetical; not actual trading.',
    dek: 'Three philosophies. One market. A permanent record. Three brand-new $10,000 simulated accounts — the original Signal 10 rules and two new algorithms, all frozen before their first decision — start from cash on the same day and are compared on the same closes.',
    css: '/markets/signal-10/arena.css', js: '/markets/signal-10/arena.js',
    body: `<section class="ar-sec" aria-labelledby="ar-who-h"><h2 id="ar-who-h" class="s10-h2">The contenders</h2>
<div class="ar-intro">
<article class="orig"><span class="ar-sub">V1 rules · new account</span><h3>Original</h3><p>The original Signal 10 rules exactly as pre-registered on Oct 9, 2026, on a brand-new account.</p>
<ul><li>S&amp;P 500, momentum with a low-volatility tilt</li><li>Dip and persistence entries, 10 slots</li><li>SPY 200-day regime, 20% trailing stop</li></ul></article>
<article class="tech"><span class="ar-sub">New algorithm</span><h3>Tech Conviction</h3><p>Concentrated momentum in technology leaders. Buys strength, holds up to 8 names.</p>
<ul><li>Technology, chips, software, cloud (SEC SIC)</li><li>No volatility penalty; QQQ 200-day regime</li><li>25% trailing stop, 10-session re-entry cooldown</li></ul></article>
<article class="div"><span class="ar-sub">New algorithm</span><h3>Diversified Risk Discipline</h3><p>Cross-sector, risk-sized, with hard limits and an optional precious-metals ETF sleeve.</p>
<ul><li>≤ 10% per holding, ≤ 25% per sector, ≤ 20% metals</li><li>Inverse-volatility sizing; cash allowed</li><li>GLD / SLV / PPLT only when verified</li></ul></article>
</div></section>
<section class="ar-sec" aria-labelledby="ar-proof-h"><h2 id="ar-proof-h" class="s10-h2">Public proof record</h2><div id="arena-proof" data-state="loading"><p class="s10-note" role="status">Loading the proof record…</p></div></section>
<div id="arena-app" data-state="loading"><div class="s10-loading" aria-hidden="true"></div><p class="sr-only" role="status">Loading the Arena standings…</p></div>
<section class="ar-sec" aria-labelledby="ar-rules-h"><h2 id="ar-rules-h" class="s10-h2">How the comparison is kept fair</h2>
<ul class="s10-list"><li>Same market, same closes, same fills: every account trades at the next regular-session open with 10 bps slippage, whole shares and $0 commission.</li>
<li>Pre-registered: each account's rules are frozen by SHA-256 before its first decision; any change is a new version with its own record.</li>
<li>Same start: all three accounts begin with $10,000 cash and zero positions at the same close (T0). No record exists before it and nothing is backfilled.</li>
<li>Separate history: the first Signal 10 paper account (Oct 9, 2026) continues as historical research and is not part of the competition.</li>
<li>Honest marks: a holding without an observed close is NOT AVAILABLE, never estimated. Sharpe ratios appear only after 60 daily observations, and no winner is declared early.</li>
<li>Precious metals: the Diversified sleeve may hold the GLD, SLV and PPLT exchange-traded trusts, never spot metal. See the <a href="/markets/metals/">precious-metals tracker</a>.</li></ul>
<p class="s10-note">Full rules: <a href="https://github.com/LHBUSA/predictions/blob/main/docs/signal10/strategy-arena/PREREGISTRATION.md" target="_blank" rel="noopener">Strategy Arena pre-registration</a> · <a href="/markets/signal-10/methodology/">Original methodology</a>.</p></section>` },
  { key: 'methodology', title: 'Methodology', h1: 'Methodology',
    desc: 'How PBE Signal 10 works: universe, features and weights, portfolio-manager rules, fills and costs, data sources, coverage, survivorship bias and pre-registration.',
    dek: 'Every rule, number and known limitation of the Signal 10 model and its paper portfolio manager — written down before any result was computed.',
    body: readFileSync(new URL('./methodology-body.html', import.meta.url), 'utf8') },
];

mkdirSync(join(ROOT, 'markets/signal-10'), { recursive: true });
for (const p of pages) {
  const dir = p.key === 'now' ? 'markets/signal-10' : `markets/signal-10/${p.key}`;
  mkdirSync(join(ROOT, dir), { recursive: true });
  writeFileSync(join(ROOT, dir, 'index.html'), page(p));
  console.log('wrote', `${dir}/index.html`);
}
