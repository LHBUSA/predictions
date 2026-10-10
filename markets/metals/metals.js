// PropBetEdge Predictions · Precious metals tracker (issue #63). Classic deferred script; renders ONLY /api/metals
// (contract metals/1). Spot prices are shown only when a source with display rights exists (today: none -> SOURCE RIGHTS
// HOLD). ETF prices are next-day IEX venue prices with their session date — never presented as live or as spot.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}` : '—'; };
  const usd = (v) => (Number.isFinite(v) ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
  const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}%` : '—');
  const METAL = { GOLD: 'gold', SILVER: 'silver', PLATINUM: 'platinum' };

  function spotCard(x, hold) {
    return `<article class="mt-card mt-${METAL[x.metal]}" aria-labelledby="mt-${x.code}-h">
<header><span class="mt-orb" aria-hidden="true">${esc(x.code)}</span><div><h3 id="mt-${x.code}-h">${esc(x.label)}</h3><span class="mt-sym">${esc(x.code)}/USD · spot · ${esc(x.unit)}</span></div></header>
<p class="mt-note"><a href="/commodities/${METAL[x.metal]}/">Explore ${esc(x.label)} research →</a></p>
<p class="mt-hold" role="status"><b>${esc(x.quote.label || 'QUOTE UNAVAILABLE')}</b></p>
<p class="mt-note">${esc(hold.note)}</p>
<dl class="mt-kv"><dt>Last legitimate observation</dt><dd>none on file</dd><dt>Instrument id</dt><dd><code>${esc(x.id)}</code></dd></dl></article>`;
  }
  function etfCard(e, attribution) {
    const q = e.quote; const has = Number.isFinite(q.value);
    const state = q.state === 'NEXT_DAY' ? `IEX NEXT-DAY · ${esc(day(q.session_date))} session` : q.state === 'AWAITING_FIRST_OBSERVATION' ? 'AWAITING FIRST IEX OBSERVATION' : 'PRICE WITHHELD · SOURCE RIGHTS HOLD';
    return `<article class="mt-card mt-etf mt-${METAL[e.metal]}" aria-labelledby="mt-${e.symbol}-h">
<header><span class="mt-orb" aria-hidden="true">${esc(e.symbol)}</span><div><h3 id="mt-${e.symbol}-h">${esc(e.symbol)} · ${esc(e.label)}</h3><span class="mt-sym">Exchange-traded trust · ${esc(e.exchange)} · not spot metal</span></div></header>
<p class="mt-price">${has ? `<b class="num">${usd(q.value)}</b><span class="num ${q.change_pct > 0 ? 'pos' : q.change_pct < 0 ? 'neg' : ''}">${pct(q.change_pct)}${q.previous ? ` vs ${esc(day(q.previous.session_date))}` : ''}</span>` : '<b class="mt-dim">—</b>'}</p>
<p class="mt-state">${state}</p>
${has ? `<p class="mt-note">Last sale on the IEX exchange for that session (IEX venue only, published the next morning). Per share of the trust, in USD.${attribution ? ` <a href="${esc(attribution.url || 'https://www.iex.io/products/market-data-connectivity/hist-terms')}" target="_blank" rel="noopener">Data: IEX</a>` : ''}</p>` : ''}
<dl class="mt-kv"><dt>Legal name</dt><dd>${esc(e.legal_name)}</dd><dt>Sponsor</dt><dd>${esc(e.sponsor)}</dd><dt>Structure</dt><dd>${esc(e.structure)}</dd>
<dt>Expense ratio</dt><dd class="num">${(e.expense_ratio * 100).toFixed(2)}%</dd><dt>NAV basis</dt><dd>${esc(e.nav_basis)}</dd><dt>Listed</dt><dd>${esc(day(e.listed_on))}</dd>
<dt>SEC CIK</dt><dd><a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&amp;CIK=${esc(e.sec_cik)}" target="_blank" rel="noopener">${esc(e.sec_cik)}</a></dd>${e.cusip ? `<dt>CUSIP</dt><dd><code>${esc(e.cusip)}</code></dd>` : ''}${e.splits?.length ? `<dt>Splits</dt><dd>${e.splits.map((s) => `${s.ratio}-for-1 on ${esc(day(s.d))}`).join(', ')}</dd>` : ''}</dl></article>`;
  }
  function sleeve(sv) {
    if (!sv) return '';
    const rows = (sv.candidates || []).map((c) => `<tr><th scope="row">${esc(c.symbol)}</th><td>${c.verified ? 'Verified' : `Hold · ${esc(c.hold || 'pending')}`}</td><td class="num">${c.above_sma200 == null ? '—' : c.above_sma200 ? 'Above' : 'Below'}</td><td class="num">${Number.isFinite(sv.holdings?.find((h) => h.symbol === c.symbol)?.weight) ? `${(sv.holdings.find((h) => h.symbol === c.symbol).weight * 100).toFixed(1)}%` : '0%'}</td></tr>`).join('');
    return `<section class="mt-sec" aria-labelledby="mt-sleeve-h"><h2 id="mt-sleeve-h" class="s10-h2">Signal 10 Diversified · metals sleeve</h2>
<p class="s10-sub">${sv.as_of ? `As of the ${esc(day(sv.as_of))} close: the sleeve is <b class="num">${Number.isFinite(sv.weight) ? `${(sv.weight * 100).toFixed(1)}%` : '0%'}</b> of the simulated account (cap ${(sv.cap * 100).toFixed(0)}%).` : 'The Diversified challenger has not started yet. Its metals sleeve can stay at zero whenever an ETF is unverified or not in an uptrend.'}</p>
${rows ? `<div class="tbl-wrap"><table class="s10-tbl"><thead><tr><th scope="col">ETF</th><th scope="col">Registry</th><th scope="col" class="num">vs 200-day</th><th scope="col" class="num">Weight</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
<p class="s10-note">Simulated paper portfolio, not advice. <a href="/markets/signal-10/arena/">Open the Strategy Arena</a>.</p></section>`;
  }

  async function load() {
    const box = $('mt-app');
    let r; try { r = await fetch('/api/metals', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }); } catch { r = null; }
    const d = r && r.ok ? await r.json().catch(() => null) : null;
    if (!d) { box.innerHTML = '<p class="s10-statusline" role="status"><b>DATA UNAVAILABLE</b> The metals record could not be loaded. Retrying in 60 s.</p>'; setTimeout(load, 60000); return; }
    box.dataset.state = 'ready';
    box.innerHTML = `<section class="mt-sec" aria-labelledby="mt-spot-h"><h2 id="mt-spot-h" class="s10-h2">Spot metal · USD per troy ounce</h2>
<div class="mt-grid">${d.spot.map((x) => spotCard(x, d.rights.spot)).join('')}</div></section>
<section class="mt-sec" aria-labelledby="mt-etf-h"><h2 id="mt-etf-h" class="s10-h2">Listed ETF proxies</h2>
<p class="s10-sub">Shares of trusts that hold physical metal. Their prices follow the metal less fees and tracking differences, trade only during U.S. equity sessions, and are never a spot price.</p>
<div class="mt-grid">${d.etfs.map((e) => etfCard(e, d.attribution)).join('')}</div></section>
${sleeve(d.diversified_sleeve)}
<section class="mt-sec" aria-labelledby="mt-src-h"><h2 id="mt-src-h" class="s10-h2">Sources and display rights</h2>
<div class="tbl-wrap"><table class="s10-tbl"><caption class="sr-only">Precious-metal price sources and what each permits</caption><thead><tr><th scope="col">Source</th><th scope="col">Research use</th><th scope="col">Members</th><th scope="col">Public</th><th scope="col">Used</th></tr></thead><tbody>
${d.sources.map((s) => `<tr><th scope="row">${esc(s.source)}${s.note ? `<small> ${esc(s.note)}</small>` : ''}</th><td>${esc(s.internal)}</td><td>${esc(s.paid)}</td><td>${esc(s.public)}</td><td>${s.used ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>
<p class="s10-note">${esc(d.disclosure)} Record generated ${esc(new Date(d.generated_at).toUTCString())}.</p></section>`;
  }
  load();
})();
