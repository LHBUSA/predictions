# Generates the static /models/ and /methodology/ pages, favicon.svg and robots.txt (run from the repo root).
import io, json, os

SITE = 'https://predictions.propbetedge.ai'
ORG = {"@type": "Organization", "@id": f"{SITE}/#org", "name": "PropBetEdge", "url": "https://propbetedge.ai", "logo": {"@type": "ImageObject", "@id": f"{SITE}/#logo", "url": f"{SITE}/brand/predictions-logo-512.png", "width": 512, "height": 512}}
SITE_NODE = {"@type": "WebSite", "@id": f"{SITE}/#website", "name": "PropBetEdge Predictions", "url": f"{SITE}/", "publisher": {"@id": f"{SITE}/#org"}}

def ld(title, desc, path):
    page = {"@type": "WebPage", "@id": f"{SITE}{path}#webpage", "name": title, "url": f"{SITE}{path}", "description": desc, "isPartOf": {"@id": f"{SITE}/#website"}, "publisher": {"@id": f"{SITE}/#org"},
            "breadcrumb": {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Predictions", "item": f"{SITE}/"}, {"@type": "ListItem", "position": 2, "name": title.split(' | ')[0].split(' — ')[0], "item": f"{SITE}{path}"}]}}
    graph = [ORG, SITE_NODE, page]
    if path == '/models/':
        page["mainEntity"] = {"@id": f"{SITE}/models/#dataset"}
        graph.append({"@type": "Dataset", "@id": f"{SITE}/models/#dataset", "name": "PropBetEdge Predictions model registry", "description": "Every PropBetEdge Predictions model family with its state, live forecast counts, resolved sample, calibration status and known limitations.", "url": f"{SITE}/models/", "creator": {"@id": f"{SITE}/#org"}, "isAccessibleForFree": True, "distribution": [{"@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": f"{SITE}/api/models"}]})
    return json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False).replace('<', '\\u003c')

def head(title, desc, path):
    cur = lambda p: ' aria-current="page"' if path == p else ''
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><meta name="description" content="{desc}">
<link rel="canonical" href="https://predictions.propbetedge.ai{path}"><meta name="robots" content="index,follow"><meta name="theme-color" content="#0e2a4a">
<meta property="og:type" content="website"><meta property="og:site_name" content="PropBetEdge Predictions"><meta property="og:title" content="{title}"><meta property="og:description" content="{desc}">
<meta property="og:url" content="https://predictions.propbetedge.ai{path}"><meta property="og:image" content="https://predictions.propbetedge.ai/og/predictions-card.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title}"><meta name="twitter:description" content="{desc}"><meta name="twitter:image" content="https://predictions.propbetedge.ai/og/predictions-card.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png"><link rel="icon" href="/favicon-16x16.png" sizes="16x16" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><link rel="stylesheet" href="/site.css?v=20261004c">
<script type="application/ld+json">{ld(title, desc, path)}</script>
</head><body>
<header class="topbar"><div class="wrap"><a class="brand" href="/"><img class="brand-mark" src="/brand/predictions-mark.svg" width="32" height="32" alt=""><span>PropBetEdge<small>PREDICTIONS</small></span></a>
<nav class="nav" aria-label="Primary"><a href="/#desk">Intelligence desk</a><a href="/insights/">Insights</a><a href="/#calendar">Calendar</a><a href="/models/"{cur('/models/')}>Models</a><a href="/#track-record">Track record</a><a href="/methodology/"{cur('/methodology/')}>Methodology</a></nav>
<div class="top-right"><span class="live-dot"><i></i>Live engine</span></div></div></header>'''

FOOT = '''<footer class="footer"><div class="wrap"><div><strong>PropBetEdge Predictions</strong><br>Independent model probabilities, stored separately from market prices.</div><div><strong>Market data</strong><br>Kalshi prices are a benchmark, never a model input.</div><div><strong>Records</strong><br>Append-only forecasts, fixed scoring roles.</div><div><strong>Not advice</strong><br>Research-stage probabilities.</div></div></footer>'''

MODELS_JS = r'''<script>
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const B={RESEARCH:'b-research',VALIDATED:'b-validated',OFFICIAL:'b-official',MONITORING:'b-monitoring',SHADOW:'b-shadow',BACKTESTING:'b-backtesting'};
const d=(iso)=>iso?new Date(iso).toISOString().slice(0,16).replace('T',' ')+' UTC':'—';
fetch('/api/models').then(r=>r.json()).then(m=>{document.getElementById('fams').innerHTML=m.families.map(f=>`<section class="card panel" style="margin:0"><div class="row-meta"><span class="cat">${esc(f.category_label)}</span><span class="badge ${B[f.state]||'b-monitoring'}">${esc(f.state)}</span>${f.versions.length?`<span>versions ${esc(f.versions.join(', '))}</span>`:''}</div><h2 style="margin:6px 0">${esc(f.name)} <span class="note">${esc(f.id)}</span></h2><dl class="kv"><dt>Inputs</dt><dd>${esc(f.inputs)}</dd><dt>Contracts tracked (60 d)</dt><dd class="num">${f.contracts_tracked}</dd><dt>Live forecasts (60 d)</dt><dd class="num">${f.live_forecasts}</dd><dt>First live</dt><dd>${d(f.first_live)}</dd><dt>Last run</dt><dd>${d(f.last_run)}</dd><dt>Resolved</dt><dd class="num">${f.resolved??'scored privately'}</dd><dt>Brier / log loss</dt><dd class="num">${f.metrics?`${f.metrics.brier} / ${f.metrics.log_loss} (market Brier ${f.metrics.market_brier}, n=${f.metrics.n})`:'—'}</dd><dt>Calibration</dt><dd>${esc(f.calibration_state)}</dd><dt>Known limitations</dt><dd>${f.limitations.map(esc).join(' · ')}</dd></dl></section>`).join('')}).catch(()=>{document.getElementById('fams').innerHTML='<div class="card empty-honest">The research board could not be loaded right now.</div>'});
fetch('/api/queue').then(r=>r.json()).then(q=>{const rows=Object.entries(q.counts).filter(([k])=>!/NORMALIZED$/.test(k)).sort((a,b)=>b[1]-a[1]);document.getElementById('queue').innerHTML=rows.length?rows.map(([k,n])=>`<tr><td>${esc(k.replace(/:/g,' · '))}</td><td class="num">${n}</td></tr>`).join(''):'<tr><td colspan="2" class="note">Every tracked contract is normalized.</td></tr>'});
</script>'''

models = head('Model Registry & 60-Day Research Board | PropBetEdge Predictions', 'Every PropBetEdge Predictions model family, its state (monitoring, shadow, research, validated), live forecast counts, resolved sample, calibration status and known limitations.', '/models/') + '''
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
<section class="card panel"><h2>2 · The market never enters the model</h2><p>Kalshi prices, order books, volume and price history are stored as a benchmark only. Feature vectors are built from allowlisted official/public source classes; a code guard and a database constraint reject any market-derived key, and a regression test shows PBE probabilities and feature hashes are unchanged when every market price is shifted.</p></section>
<section class="card panel"><h2>3 · Point-in-time data</h2><p>Each input carries the time it became available. Weather guidance runs are used only five hours after their cycle; rates use the official Daily Treasury Par Yield Curve as published; macro inputs use never-revised daily series. Backtests apply the same rules and are evaluated on chronological holdouts.</p></section>
<section class="card panel"><h2>4 · Immutable snapshots and fixed scoring roles</h2><p>A forecast is written once with its model version, feature snapshot, data cutoff, evidence and the market price observed at that moment. A later run creates a new snapshot; nothing is rewritten. The snapshots that count for scoring are fixed by rule before the outcome: FIRST_PUBLISHED, T_MINUS_24H (only if a forecast existed 24 hours before the reference time) and FINAL_PRE_RESOLUTION.</p></section>
<section class="card panel"><h2>5 · Resolution and scoring</h2><p>The venue settlement and an independent official value (the NWS Daily Climate Report for the exact station, the Treasury par curve, the Federal Reserve target range) are stored separately and compared. PBE and the market are scored on the same snapshot with Brier score and log loss. Model skill is not claimed until enough contracts have resolved.</p></section>
<section class="card panel"><h2>6 · Model states</h2><p>MONITORING (market shown, no model) → BACKTESTING → SHADOW (forecasts stored, never published) → RESEARCH (published, not validated) → VALIDATED → OFFICIAL. See the <a href="/models/">research board</a>.</p></section>
</main>''' + FOOT + '</body></html>\n'

os.makedirs('models', exist_ok=True); os.makedirs('methodology', exist_ok=True)
io.open('models/index.html', 'w', encoding='utf-8', newline='\n').write(models)
io.open('methodology/index.html', 'w', encoding='utf-8', newline='\n').write(meth)
# favicon.svg is generated by scripts/brand/brand-kit.py (the Predictions mark)
io.open('robots.txt', 'w', encoding='utf-8', newline='\n').write('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\n\nSitemap: https://predictions.propbetedge.ai/sitemap.xml\nSitemap: https://predictions.propbetedge.ai/news-sitemap.xml\n')
print('static pages written')
