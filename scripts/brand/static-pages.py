# Generates the static /models/ and /methodology/ pages, favicon.svg and robots.txt (run from the repo root).
import io, json, os, subprocess

# The network header/footer come from the ONE implementation in workers/pbe-predictions/src/network.js.
SHELL = json.loads(subprocess.run(["node", "scripts/brand/shell.mjs"], capture_output=True, text=True, encoding="utf-8", check=True).stdout)

SITE = 'https://predictions.propbetedge.ai'
ORG_ID = "https://propbetedge.ai/#organization"  # the ONE PropBetEdge publisher identity across the network
ORG = json.loads('{"@type":"NewsMediaOrganization","@id":"https://propbetedge.ai/#organization","name":"PropBetEdge","url":"https://propbetedge.ai/","logo":{"@type":"ImageObject","@id":"https://propbetedge.ai/#logo","url":"https://propbetedge.ai/logo/pbe-full-400.png","width":400,"height":100}}')
SITE_NODE = json.loads('{"@type":"WebSite","@id":"https://predictions.propbetedge.ai/#website","name":"PropBetEdge Predictions","url":"https://predictions.propbetedge.ai/","publisher":{"@id":"https://propbetedge.ai/#organization"},"isPartOf":{"@id":"https://propbetedge.ai/#website"},"image":{"@type":"ImageObject","@id":"https://predictions.propbetedge.ai/#logo","url":"https://predictions.propbetedge.ai/brand/predictions-logo-512.png","width":512,"height":512},"inLanguage":"en"}')

def ld(title, desc, path):
    page = {"@type": "WebPage", "@id": f"{SITE}{path}#webpage", "name": title, "url": f"{SITE}{path}", "description": desc, "isPartOf": {"@id": f"{SITE}/#website"}, "publisher": {"@id": ORG_ID},
            "breadcrumb": {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "PropBetEdge", "item": "https://propbetedge.ai/"}, {"@type": "ListItem", "position": 2, "name": "Predictions", "item": f"{SITE}/"}, {"@type": "ListItem", "position": 3, "name": CRUMB[path], "item": f"{SITE}{path}"}]}}
    graph = [ORG, SITE_NODE, page]
    if path == '/about/':
        page["@type"] = "AboutPage"
        page["about"] = {"@id": f"{SITE}/#website"}
    if path == '/models/':
        page["mainEntity"] = {"@id": f"{SITE}/models/#dataset"}
        # The model registry (states, sample sizes, limitations, aggregate calibration) is intentionally public
        # methodology. It carries no live PBE probability; forecasts themselves are All Access (event Dataset nodes
        # say isAccessibleForFree: false).
        graph.append({"@type": "Dataset", "@id": f"{SITE}/models/#dataset", "name": "PropBetEdge Predictions model registry", "description": "Every PropBetEdge Predictions model family with its state, forecast snapshot counts, resolved sample, calibration status and known limitations.", "url": f"{SITE}/models/", "creator": {"@id": ORG_ID}, "isAccessibleForFree": True, "distribution": [{"@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": f"{SITE}/api/models"}]})
    return json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False).replace('<', '\\u003c')

CRUMB = {'/about/': 'About', '/models/': 'Models', '/methodology/': 'Methodology', '/desk/': 'Intelligence Desk', '/track-record/': 'Track Record', '/calendar/': 'Calendar'}
PAGE_KEY = {'/about/': 'about', '/models/': 'models', '/methodology/': 'methodology', '/desk/': 'desk', '/track-record/': 'record', '/calendar/': 'calendar'}
ASSET_V = '20261010nav1'  # == workers/pbe-predictions/src/pages.js ASSET_V (test/home-truth.test.js)
def scripts(name):
    return f'<script src="/core.js?v={ASSET_V}" defer></script><script src="/{name}.js?v={ASSET_V}" defer></script>'

def head(title, desc, path):
    cur = lambda p: ' aria-current="page"' if path == p else ''
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><meta name="description" content="{desc}">
<link rel="canonical" href="https://predictions.propbetedge.ai{path}"><meta name="robots" content="index,follow"><meta name="theme-color" content="#0e2a4a"><script>try{{var t=localStorage.getItem('pbe-theme');if(t==='dark'||t==='system')document.documentElement.setAttribute('data-theme',t)}}catch(e){{}}</script>
<meta property="og:type" content="website"><meta property="og:site_name" content="PropBetEdge Predictions"><meta property="og:title" content="{title}"><meta property="og:description" content="{desc}">
<meta property="og:url" content="https://predictions.propbetedge.ai{path}"><meta property="og:image" content="https://predictions.propbetedge.ai/og/predictions-card.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title}"><meta name="twitter:description" content="{desc}"><meta name="twitter:image" content="https://predictions.propbetedge.ai/og/predictions-card.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png"><link rel="icon" href="/favicon-16x16.png" sizes="16x16" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><link rel="stylesheet" href="/site.css?v={ASSET_V}">
<script type="application/ld+json">{ld(title, desc, path)}</script>
</head><body>
{SHELL['header'][PAGE_KEY.get(path, 'none')]}
<nav class="crumbs wrap" aria-label="Breadcrumb" style="padding-top:14px"><a href="https://propbetedge.ai/">PropBetEdge</a> › <a href="/">Predictions</a> › {CRUMB[path]}</nav>'''

FOOT = SHELL['footer']

MODELS_JS = r'''<script>
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const B={RESEARCH:'b-research',VALIDATED:'b-validated',OFFICIAL:'b-official',MONITORING:'b-monitoring',SHADOW:'b-shadow',BACKTESTING:'b-backtesting'};
const d=(iso)=>iso?new Date(iso).toISOString().slice(0,16).replace('T',' ')+' UTC':'—';
fetch('/api/models').then(r=>r.json()).then(m=>{document.getElementById('fams').innerHTML=m.families.map(f=>`<section class="card panel model-fam" id="${esc(f.id)}" style="margin:0"><div class="row-meta"><span class="cat">${esc(f.category_label)}</span><span class="badge ${B[f.state]||'b-monitoring'}">${esc(f.state)}</span>${f.versions.length?`<span>versions ${esc(f.versions.join(', '))}</span>`:''}</div><h2 style="margin:6px 0">${esc(f.name)} <span class="note">${esc(f.id)}</span></h2><dl class="kv"><dt>Inputs</dt><dd>${esc(f.inputs)}</dd><dt>Contracts tracked (60 d)</dt><dd class="num">${f.contracts_tracked}</dd><dt>Forecast snapshots (60 d)</dt><dd class="num">${f.live_forecasts}</dd><dt>First live</dt><dd>${d(f.first_live)}</dd><dt>Last run</dt><dd>${d(f.last_run)}</dd><dt>Resolved</dt><dd class="num">${f.resolved??'scored privately'}</dd><dt>Brier / log loss</dt><dd class="num">${f.metrics?`${f.metrics.brier} / ${f.metrics.log_loss} (market Brier ${f.metrics.market_brier}, n=${f.metrics.n})`:'—'}</dd><dt>Calibration</dt><dd>${esc(f.calibration_state)}</dd><dt>Known limitations</dt><dd>${f.limitations.map(esc).join(' · ')}</dd></dl></section>`).join('');if(location.hash){const t=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(t)t.scrollIntoView()}}).catch(()=>{document.getElementById('fams').innerHTML='<div class="card empty-honest">The research board could not be loaded right now.</div>'});
fetch('/api/queue').then(r=>r.json()).then(q=>{const rows=Object.entries(q.counts).filter(([k])=>!/NORMALIZED$/.test(k)).sort((a,b)=>b[1]-a[1]);document.getElementById('queue').innerHTML=rows.length?rows.map(([k,n])=>`<tr><td>${esc(k.replace(/:/g,' · '))}</td><td class="num">${n}</td></tr>`).join(''):'<tr><td colspan="2" class="note">Every tracked contract is normalized.</td></tr>'});
</script>'''

models = head('Model Registry & 60-Day Research Board | PropBetEdge Predictions', 'Every PropBetEdge Predictions model family, its state (monitoring, shadow, research, validated), forecast snapshot counts, resolved sample, calibration status and known limitations.', '/models/') + '''
<main class="wrap section">
<span class="overline">60-DAY RESEARCH BOARD</span><h1 style="font-size:34px;letter-spacing:-.03em;margin:8px 0 6px">Model families</h1>
<p class="note" style="font-size:14px;max-width:820px">States: MONITORING (market shown, no model) → BACKTESTING → SHADOW (forecasts stored, never published) → RESEARCH (published, not validated) → VALIDATED → OFFICIAL. Skill metrics appear only once a family has enough resolved forecasts; until then the sample is reported as insufficient.</p>
<div id="fams" style="display:grid;gap:12px;margin-top:16px;min-height:600px"></div>
<h2 style="font-size:20px;margin:26px 0 8px">Unsupported and held contracts</h2>
<p class="note">Contracts that are not modeled, with the exact machine-readable reason (live from the engine).</p>
<div class="card" style="padding:6px 16px"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Reason</th><th>Contracts</th></tr></thead><tbody id="queue"></tbody></table></div></div>
</main>''' + FOOT + MODELS_JS + '</body></html>\n'

meth = head('Methodology — How PropBetEdge Predictions Forecasts Real-World Events', 'How PropBetEdge Predictions normalizes contracts, keeps market prices out of its models, publishes immutable forecasts, resolves against official sources and scores every forecast.', '/methodology/') + '''
<main class="wrap section" style="max-width:900px">
<span class="overline">METHODOLOGY</span><h1 style="font-size:34px;letter-spacing:-.03em;margin:8px 0 14px">How a PropBetEdge forecast is made</h1>
<section class="card panel"><h2>1 · Model the contract, not the headline</h2><p>Every venue contract is normalized to its exact resolution semantics: station or series, observation window (for weather, the NWS climate day in local standard time), comparator, threshold, units, resolution authority and exceptions. If the rules text and the venue's structured fields disagree, or the settlement source is unknown or commercial, the contract is held with a machine-readable reason (HOLD_RESOLUTION_AMBIGUOUS, UNMODELABLE, COMMERCIAL_SETTLEMENT_SOURCE) and receives no probability.</p></section>
<section class="card panel" id="evidence"><h2>2 · The market never enters the model</h2><p>Kalshi prices, order books, volume and price history are stored as a benchmark only. Feature vectors are built from allowlisted official/public source classes; a code guard and a database constraint reject any market-derived key, and a regression test shows PBE probabilities and feature hashes are unchanged when every market price is shifted.</p></section>
<section class="card panel"><h2>3 · Point-in-time data</h2><p>Each input carries the time it became available. Weather guidance runs are used only five hours after their cycle; rates use the official Daily Treasury Par Yield Curve as published; macro inputs use never-revised daily series. Backtests apply the same rules and are evaluated on chronological holdouts.</p></section>
<section class="card panel" id="immutable"><h2>4 · Immutable snapshots and fixed scoring roles</h2><p>A forecast is written once with its model version, feature snapshot, data cutoff, evidence and the market price observed at that moment. A later run creates a new snapshot; nothing is rewritten. The snapshots that count for scoring are fixed by rule before the outcome: FIRST_PUBLISHED, T_MINUS_24H (only if a forecast existed 24 hours before the reference time) and FINAL_PRE_RESOLUTION.</p></section>
<section class="card panel" id="scoring"><h2>5 · Resolution and scoring</h2><p>The venue settlement and an independent official value (the NWS Daily Climate Report for the exact station, the Treasury par curve, the Federal Reserve target range) are stored separately and compared. PBE and the market are scored on the same snapshot with Brier score and log loss. Model skill is not claimed until enough contracts have resolved.</p></section>
<section class="card panel" id="states"><h2>6 · Model states and limitations</h2><p>MONITORING (market shown, no model) → BACKTESTING → SHADOW (forecasts stored, never published) → RESEARCH (published, not validated) → VALIDATED → OFFICIAL. A model moves up only when it passes a gate set before the results are known. Every family's current state, sample size and known limitations are listed live on the <a href="/models/">research board</a>.</p></section>
<section class="card panel" id="access"><h2>7 · Access</h2><p>This methodology, the model registry and the aggregate scoring record are public. The forecasts themselves — every PBE probability, the model-vs-market comparison, the evidence ledger, forecast history and the full intelligence desk — are PropBetEdge Predictions, included with <a href="https://propbetedge.ai/pro">PropBetEdge All Access</a> ($29/month).</p></section>
<section class="card panel" id="venue-relationships"><h2>8 · Partner relationships</h2><p>PropBetEdge participates in Kalshi's referral program for Kalshi Perpetuals. Some pages show a separate, clearly labelled Kalshi Perpetuals offer. PropBetEdge may receive compensation from qualifying Kalshi referrals; offer eligibility and terms are determined by Kalshi. That offer is kept apart from market links: "Open on Kalshi" always goes straight to the contract shown, with nothing added. Partner compensation does not affect PropBetEdge model probabilities, market comparisons, rankings, editorial conclusions, or research, and Kalshi data remains a benchmark that never enters a PBE model.</p></section>
</main>''' + FOOT + '</body></html>\n'


# ---- Dedicated destinations (issue #50): the homepage is an overview; full data lives here. ----
GATE = '''<section class="card panel prem gate" id="desk-gate" data-gate aria-labelledby="gate-h">
      <span class="prem-kicker">PROPBETEDGE PREDICTIONS · ALL ACCESS</span><h2 id="gate-h">Unlock every PBE probability with All Access</h2>
      <ul class="gate-list"><li>Official PBE Predictions with model probability</li><li>Market comparison against live venues</li><li>Evidence ledger and exact resolution rules</li><li>Immutable forecast history</li><li>Full intelligence desk: divergence scanner, search and sort</li><li>Scored track record</li></ul>
      <p class="gate-price">Included with PropBetEdge All Access · <b>$29/month</b> — 10 sports + PropBetEdge Predictions.</p>
      <div class="gate-cta" data-gate-cta><a class="cta-primary" href="https://propbetedge.ai/pro" data-pbe-placement="predictions_desk_gate">Get All Access</a><a class="cta-secondary" href="#" data-pbe-signin>Sign in</a></div>
    </section>'''

desk = head('Intelligence Desk — Event Markets vs PBE Forecasts | PropBetEdge Predictions', 'Every tracked real-world event market on Kalshi and Polymarket — weather, rates, macro, business, space, public health and energy — with close times, live prices and, with All Access, the PBE probability and model-vs-market divergence.', '/desk/') + '''
<main class="wrap section page-main" id="desk-top">
<header class="page-head"><span class="overline">INTELLIGENCE DESK</span><h1>Every event market we track</h1>
<p class="page-lede" id="desk-sub">Every tracked event, its close time and the live market price.</p>
<p class="note">Kalshi and Polymarket event contracts compared with PBE forecasts. PBE probabilities and model-vs-market divergence are included with All Access; events without a specialist model are market monitoring. Stocks and macro analysis live in <a href="/markets/">Markets AI</a>; crypto in the <a href="/crypto/">Crypto Nowcast</a>.</p></header>
<div class="tape" aria-label="Live probability tape"><div class="tape-track" id="tape"></div></div>
<div id="desk-controls">
  <div class="cats desk-tabs" id="cats" role="group" aria-label="Categories"></div>
  <div class="controls" role="search">
    <label class="sr-only" for="q">Search events</label><input class="search" id="q" type="search" placeholder="Search events, cities, tenors…" autocomplete="off">
    <label class="sr-only" for="sort">Sort</label>
    <select class="sort" id="sort"><option value="div">Largest divergence</option><option value="close">Closing soonest</option><option value="fresh">Latest forecast</option></select>
  </div>
  <div class="cats views" id="views" role="group" aria-label="Desk views"></div>
</div>
<p class="list-count" id="desk-count" aria-live="polite"></p>
<div class="desk" id="desk-list"><div class="card skel" style="height:78px"></div><div class="card skel" style="height:78px"></div><div class="card skel" style="height:78px"></div></div>
<nav class="pager" id="desk-pager" aria-label="Desk pages" hidden></nav>
''' + GATE + '''
</main>''' + FOOT + scripts('desk') + '</body></html>\n'

record = head('Track Record — Forecast Results, Wins, Misses & Scoring | PropBetEdge Predictions', 'The PropBetEdge Predictions track record: contracts scored with Brier and log loss against the market, temperature event outcomes matched and missed, prospective research calls, and Official PBE Picks (rain YES/NO, active since Oct 9, 2026), each result linked to its stored evidence.', '/track-record/') + '''
<main class="wrap section page-main">
<header class="page-head"><span class="overline">TRACK RECORD</span><h1>What we predicted. What actually happened.</h1>
<p class="page-lede">Records that are never mixed: contracts scored against the market, retrospective event outcomes, research calls, and Official PBE Picks (rain YES/NO, active since Oct 9, 2026), each tracked RIGHT, MISSED, PENDING or VOID.</p></header>
<section class="rec-block"><h2>Contracts scored</h2><p class="note">Accuracy across every resolved contract (lower is better). A scored contract is not a win, and nothing here is a trading return.</p>
<div class="stats stats-4" id="tr"><div class="card skel" style="height:96px"></div></div></section>
<section class="rec-block" id="rec-top"><h2>Results ledger</h2>
<div id="results-overview" class="result-overview" aria-live="polite"></div>
<div id="rec-members" hidden>
  <div class="cats" id="rec-tabs" role="group" aria-label="Record"></div>
  <div class="cats views" id="rec-filters" role="group" aria-label="Result filter"></div>
  <p class="note" id="rec-note"></p><p class="list-count" id="rec-count" aria-live="polite"></p>
  <div id="results-ledger" class="result-ledger"></div>
  <nav class="pager" id="rec-pager" aria-label="Results pages" hidden></nav>
</div>
<section class="card panel prem gate" id="rec-gate" data-gate hidden aria-labelledby="rec-gate-h"><span class="prem-kicker">PROPBETEDGE PREDICTIONS · ALL ACCESS</span><h2 id="rec-gate-h">See every win and every miss</h2><p>Members see the model’s selected outcome, the actual winner, the result and a direct link to the stored evidence, for every settled event and every frozen research call.</p><div class="gate-cta" data-gate-cta><a class="cta-primary" href="https://propbetedge.ai/pro" data-pbe-placement="predictions_record_gate">Get All Access</a><a class="cta-secondary" href="#" data-pbe-signin>Sign in</a></div></section>
<p class="result-disclosure">A high-probability forecast is not automatically an official YES/NO pick. A correct forecast is not necessarily a profitable trade. Unsettled events and model PASS decisions are never counted as wins. <a href="/methodology/#scoring">How scoring works →</a></p>
</section>
</main>''' + FOOT + scripts('track-record') + '</body></html>\n'

calendar = head('Prediction Calendar — Upcoming Event Resolutions | PropBetEdge Predictions', 'When every tracked prediction-market contract closes over the next three weeks, grouped by day, with category filters and links to each event record.', '/calendar/') + '''
<main class="wrap section page-main">
<header class="page-head"><span class="overline">PREDICTION CALENDAR</span><h1>Upcoming resolutions</h1>
<p class="page-lede" id="cal-sub">When the tracked contracts close, from stored venue close times.</p><p class="note">Times in your local time zone, with UTC beside each one.</p></header>
<div class="cats" id="cal-cats" role="group" aria-label="Categories"></div>
<div id="cal-list"><div class="card skel" style="height:240px"></div></div>
</main>''' + FOOT + scripts('calendar') + '</body></html>\n'

ICON = lambda d: f'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{d}</svg>'
AB_DOES = [
    ('<path d="M3 12h3l2.5-6 4 12 2.5-6H21"/>', 'Monitors live markets', 'Event contracts on Kalshi and Polymarket are captured continuously, with their exact rules, close times and prices.'),
    ('<path d="M5 4h11l3 3v13H5z"/><path d="M8 9h8M8 13h8M8 17h5"/>', 'Keeps the historical record', 'Every observation is stored with the moment it became available, so the past can be replayed exactly as it looked.'),
    ('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>', 'Runs proprietary models', 'Specialist models turn official and public data into probabilities. Market prices never enter them.'),
    ('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/><path d="M15 16l1.5 1.5L19 15"/>', 'Maintains an ongoing ledger', 'Forecasts are append-only: each run adds a new snapshot with its model version, inputs and data cutoff.'),
    ('<path d="M4 19V5M4 19h16"/><path d="M7 15l4-4 3 3 5-6"/>', 'Studies markets against outcomes', 'Prices, model forecasts and official results are compared over time to see where each was right, early or wrong.'),
    ('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>', 'Builds new datasets', 'The ledger becomes structured, point-in-time data that powers new models and intelligence products.'),
]
AB_MONITOR = [
    ('weather', 'Weather & climate', 'Research models', 'b-research', ['Daily rain and high-temperature contracts for named NWS climate stations', 'Forecast guidance, live station observations and climate-day rules', 'Resolved against the NWS Daily Climate Report for the exact station'], '/desk/', 'Open the Intelligence Desk'),
    ('macro', 'Rates & macro', 'Research + shadow', 'b-shadow', ['Treasury yield-path contracts, scored against the official par yield curve', 'Federal Reserve decisions, modeled in shadow before any publication', 'Inflation and labor releases in private research until they pass validation'], '/models/', 'See every model family'),
    ('crypto', 'Crypto', 'Live nowcast', 'b-monitoring', ['A 15-minute Bitcoin probability nowcast beside the live 15-minute contracts', 'Momentum, volatility and trend regimes across major crypto markets', 'Gaps shown only when the contract, window and data are genuinely comparable'], '/crypto/', 'Open Crypto Nowcast'),
    ('equities', 'Equities & market structure', 'Forward paper record', 'b-monitoring', ['Signal 10: a pre-registered ranking model running a live $10k paper portfolio', 'Every trade written to a hash-chained ledger, never edited after the fact', 'Market structure and macro analysis in Markets AI'], '/markets/signal-10/', 'Follow Signal 10'),
    ('sports', 'Sports prediction markets', 'Across the network', 'b-monitoring', ['Game and player markets are covered by the ten PropBetEdge sport platforms', 'Compare lines up venue prices for the same outcome side by side', 'The same record-keeping discipline: locked picks, versions and public results'], 'https://compare.propbetedge.ai/', 'Open Compare'),
    ('emerging', 'Emerging categories', 'Monitoring', 'b-monitoring', ['Business, space, public health and energy contracts are tracked today', 'Market shown, no model, until a specialist model passes its gates', 'New categories are added as their settlement sources are verified'], '/calendar/', 'See what resolves next'),
]
AB_FLOW = [
    ('Data ingestion', 'Official, public and venue data, each stamped with when it became available'),
    ('Historical records', 'Point-in-time archives that replay the past exactly as it looked'),
    ('Proprietary algorithms', 'Specialist models per category; market prices never enter them'),
    ('Ongoing ledger', 'Append-only forecast snapshots with versions, inputs and cutoffs'),
    ('Evaluation', 'Brier score and log loss against the market and the official result'),
    ('New datasets', 'Structured, scored history that trains the next model generation'),
    ('Intelligence products', 'The desk, Insights, Signal 10, Crypto Nowcast and what comes next'),
]
AB_DIFF = [
    ('Immutable record', 'Nothing is rewritten. A new run is a new snapshot, and the scoring snapshots are fixed by rule before the outcome is known.'),
    ('Ongoing performance tracking', 'Wins, misses and scores stay public in the track record, including the forecasts that went wrong.'),
    ('Evidence-based modeling', 'Every forecast links to its inputs, its data cutoff and the exact resolution rules it was built for.'),
    ('Proprietary workflows', 'Contract normalization, point-in-time data and leakage guards are built in-house and enforced in code and in the database.'),
    ('Cross-market intelligence', 'Weather, rates, macro, crypto and equities share one ledger, one scoring method and one standard of evidence.'),
    ('Expanding coverage', 'Categories enter as monitoring and earn a model only after their settlement source and backtests check out.'),
]

ab_does = ''.join(f'<li class="ab-does-item">{ICON(i)}<div><h3>{t}</h3><p>{d}</p></div></li>' for i, t, d in AB_DOES)
ab_mon = ''.join(
    f'<article class="ab-mon card" id="{k}"><div class="ab-mon-head"><h3>{t}</h3><span class="badge {b}">{st}</span></div>'
    f'<ul>{"".join(f"<li>{x}</li>" for x in pts)}</ul>'
    f'<a class="ab-mon-link" href="{h}"{" target=\"_blank\" rel=\"noopener\"" if h.startswith("http") else ""}>{l} <span aria-hidden="true">→</span></a></article>'
    for k, t, st, b, pts, h, l in AB_MONITOR)
ab_flow = ''.join(f'<li><span class="ab-step num">{n:02d}</span><b>{t}</b><small>{d}</small></li>' for n, (t, d) in enumerate(AB_FLOW, 1))
ab_diff = ''.join(f'<li><h3>{t}</h3><p>{d}</p></li>' for t, d in AB_DIFF)

about = head('What Is PropBetEdge Predictions? Predictive Intelligence, Built as a Living Ledger', 'PropBetEdge Predictions monitors prediction markets, runs proprietary forecasting models, keeps every forecast in an append-only ledger and scores each one against the official outcome, across weather, rates, macro, crypto and equities.', '/about/') + f'''
<main class="ab">
<section class="ab-hero"><div class="wrap ab-hero-grid">
  <div>
    <span class="overline">WHAT IS PROPBETEDGE PREDICTIONS?</span>
    <h1>Predictive intelligence, built as a living ledger.</h1>
    <p class="ab-lede">PropBetEdge Predictions is where we monitor live markets, study historical outcomes, test proprietary algorithms and build new data products that show where prediction markets and evidence disagree.</p>
    <div class="ab-cta"><a class="cta-primary" href="/desk/">Open the Intelligence Desk</a><a class="cta-secondary" href="/methodology/">Read the methodology</a></div>
  </div>
  <figure class="ab-record" aria-label="Anatomy of one forecast record">
    <figcaption><span class="ab-rec-dot" aria-hidden="true"></span>Anatomy of a forecast record</figcaption>
    <dl>
      <dt>Contract</dt><dd>Exact rules, station, window and threshold</dd>
      <dt>Model</dt><dd>Family and version, e.g. pbe-weather-precip 1.1.0</dd>
      <dt>Data cutoff</dt><dd>Only inputs available before this time</dd>
      <dt>Feature snapshot</dt><dd>Hashed inputs, market data excluded</dd>
      <dt>Market at publish</dt><dd>Stored beside the forecast as a benchmark</dd>
      <dt>Scoring role</dt><dd>FIRST_PUBLISHED · T-24H · FINAL</dd>
      <dt>Resolution</dt><dd>Venue settlement + independent official value</dd>
    </dl>
    <p class="ab-rec-foot">Written once. Never edited. Scored after the outcome.</p>
  </figure>
</div></section>

<section class="wrap ab-sec" aria-labelledby="ab-does-h">
  <header class="ab-sec-head"><span class="overline">01 · WHAT THIS PLATFORM DOES</span><h2 id="ab-does-h">One system, from market tick to scored result</h2></header>
  <ul class="ab-does">{ab_does}</ul>
</section>

<section class="ab-band" id="monitor" aria-labelledby="ab-mon-h"><div class="wrap ab-sec">
  <header class="ab-sec-head"><span class="overline">02 · WHAT WE MONITOR</span><h2 id="ab-mon-h">Coverage across real-world events, crypto and markets</h2><p>Each category shows where it stands today. A category earns a published model only after its settlement source is verified and its backtests pass. Live states for every model family are on the <a href="/models/">research board</a>.</p></header>
  <div class="ab-mon-grid">{ab_mon}</div>
</div></section>

<section class="wrap ab-sec" aria-labelledby="ab-why-h">
  <header class="ab-sec-head"><span class="overline">03 · WHY IT EXISTS</span><h2 id="ab-why-h">A proprietary data and intelligence engine, built in the open</h2></header>
  <div class="ab-why">
    <div class="card panel"><h3>A public research surface</h3><p>The methodology, the model registry and the scored track record are public. Anyone can see what we forecast, how it was made and how it turned out. Insights explains the moves as they happen.</p></div>
    <div class="card panel"><h3>An operating layer for new data</h3><p>Behind the pages, the same engine produces point-in-time datasets, model generations and market intelligence that feed the wider PropBetEdge network, from the sport platforms to Compare.</p></div>
  </div>
</section>

<section class="ab-band" aria-labelledby="ab-sys-h"><div class="wrap ab-sec">
  <header class="ab-sec-head"><span class="overline">04 · THE SYSTEM</span><h2 id="ab-sys-h">How the pieces fit together</h2></header>
  <ol class="ab-flow">{ab_flow}</ol>
</div></section>

<section class="wrap ab-sec" aria-labelledby="ab-diff-h">
  <header class="ab-sec-head"><span class="overline">05 · WHAT MAKES IT DIFFERENT</span><h2 id="ab-diff-h">Standards we hold every forecast to</h2></header>
  <ul class="ab-diff">{ab_diff}</ul>
</section>

<section class="wrap ab-sec" aria-labelledby="ab-trust-h">
  <div class="card panel ab-trust">
    <span class="overline">06 · IMPORTANT</span><h2 id="ab-trust-h">Research and intelligence, not advice</h2>
    <ul>
      <li>PropBetEdge Predictions publishes research-stage probabilities and market intelligence. Nothing here is financial or betting advice.</li>
      <li>Market prices are a reference benchmark. They are stored beside each forecast and never enter a PropBetEdge model.</li>
      <li>Models evolve. Each change is a new version with its own record; earlier forecasts keep the version that made them.</li>
      <li>Coverage will expand. New categories start in monitoring and are labeled with their state everywhere they appear.</li>
    </ul>
    <p class="ab-trust-links"><a href="/methodology/#immutable">Immutable forecasts</a><a href="/methodology/#evidence">Evidence &amp; sources</a><a href="/methodology/#scoring">Scoring methodology</a><a href="/methodology/#states">Model states &amp; limitations</a><a href="/track-record/">Track record</a></p>
  </div>
  <p class="ab-close">PropBetEdge Predictions is included with <a href="https://propbetedge.ai/pro" data-pbe-placement="predictions_about_all_access">PropBetEdge All Access</a> — 10 sports + Predictions + Compare for $29/month.</p>
</section>
</main>''' + FOOT + '</body></html>\n'

for d in ('about', 'models', 'methodology', 'desk', 'track-record', 'calendar'): os.makedirs(d, exist_ok=True)
io.open('about/index.html', 'w', encoding='utf-8', newline='\n').write(about)
io.open('models/index.html', 'w', encoding='utf-8', newline='\n').write(models)
io.open('methodology/index.html', 'w', encoding='utf-8', newline='\n').write(meth)
io.open('desk/index.html', 'w', encoding='utf-8', newline='\n').write(desk)
io.open('track-record/index.html', 'w', encoding='utf-8', newline='\n').write(record)
io.open('calendar/index.html', 'w', encoding='utf-8', newline='\n').write(calendar)
# favicon.svg is generated by scripts/brand/brand-kit.py (the Predictions mark)
io.open('robots.txt', 'w', encoding='utf-8', newline='\n').write('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\n\nSitemap: https://predictions.propbetedge.ai/sitemap.xml\nSitemap: https://predictions.propbetedge.ai/news-sitemap.xml\n')
print('static pages written')
