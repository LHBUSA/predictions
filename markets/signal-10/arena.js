// PBE Signal 10 · Strategy Arena — page controller (classic deferred script; uses window.S10Core formatters).
// Public layer: /api/signal10/arena/proof (versions, policy hashes, T0, ledger heads). Member layer: /api/signal10/arena
// (All Access; 401/403/503 show the matching gate). Renders only values those routes return — never an invented number.
(() => {
  'use strict';
  const boot = () => main(window.S10Core);
  if (window.S10Core) boot(); else window.addEventListener('s10core', boot, { once: true });

  function main(C) {
    const { esc, fmtUSD, fmtPct, fmtDate } = C;
    const PRO = 'https://propbetedge.ai/pro';
    const pub = document.getElementById('arena-proof');
    const app = document.getElementById('arena-app');
    const KEYS = ['ORIGINAL', 'TECH', 'DIVERSIFIED'];
    const CLS = { ORIGINAL: 'orig', TECH: 'tech', DIVERSIFIED: 'div', SPY: 'spy', QQQ: 'qqq' };
    const pct = (x, o) => (Number.isFinite(x) ? fmtPct(x, o) : '—');
    const short = (h) => (h ? `${h.slice(0, 10)}…` : '—');
    let gated = false;

    async function get(path) {
      try {
        const r = await fetch(`/api/signal10/${path}`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
        let data = null; try { data = await r.json(); } catch { /* non-JSON */ }
        return { status: r.status, data, retryAfter: r.headers.get('retry-after') };
      } catch { return { status: 0, data: null }; }
    }

    // ---------------- public proof ----------------
    async function proof() {
      const r = await get('arena/proof');
      if (r.status !== 200 || !r.data) { pub.innerHTML = '<p class="s10-statusline" role="status"><b>PROOF RECORD UNAVAILABLE</b> Retrying in 60 s.</p>'; setTimeout(proof, 60000); return; }
      const p = r.data;
      const rows = p.strategies.map((s) => `<tr><th scope="row">${esc(s.label)}</th><td>${esc(s.account)}</td><td><span class="ar-status ar-${s.status === 'RUNNING' ? 'run' : 'wait'}">${esc(s.status.replace(/_/g, ' '))}</span></td><td class="num">${s.inception ? esc(fmtDate(s.inception)) : '—'}</td><td class="num">${esc(String(s.ledger_events))}</td><td><span class="s10-hash" title="${esc(s.policy_sha256)}">${esc(short(s.policy_sha256))}</span></td><td><span class="s10-hash" title="${esc(s.ledger_head_hash || '')}">${esc(short(s.ledger_head_hash))}</span></td></tr>`).join('');
      pub.innerHTML = `<p class="ar-t0">${p.t0 ? `Cohort start <b>T0 = ${esc(fmtDate(p.t0))}</b> · both challengers funded with $10,000 simulated that day; first fills at the next open.` : '<b>Cohort not started.</b> T0 is set at the first U.S. close after activation. No challenger record exists before it, and nothing is backfilled.'}</p>
<div class="tbl-wrap"><table class="s10-tbl ar-proof"><caption class="sr-only">Challenger proof record</caption><thead><tr><th scope="col">Strategy</th><th scope="col">Account</th><th scope="col">Status</th><th scope="col" class="num">Inception</th><th scope="col" class="num">Ledger events</th><th scope="col">Policy SHA-256</th><th scope="col">Ledger head</th></tr></thead><tbody>
<tr><th scope="row">Original</th><td>${esc(p.control.account)}</td><td><span class="ar-status ar-run">CONTROL</span></td><td class="num">Oct 9, 2026</td><td class="num">—</td><td><a href="/markets/signal-10/methodology/">pre-registered 1.0.0</a></td><td><a href="/markets/signal-10/ledger/">control ledger</a></td></tr>${rows}</tbody></table></div>
<p class="s10-note">Policy hashes are frozen in the <a href="${esc(p.preregistration)}" target="_blank" rel="noopener">pre-registration</a> and stamped on every ledger row. Sector taxonomy ${esc(p.taxonomy.version)}, snapshot ${esc(fmtDate(p.taxonomy.effective_from))} <span class="s10-hash">${esc(short(p.taxonomy.content_sha256))}</span>.</p>`;
    }

    // ---------------- member arena ----------------
    function gate(status, retryAfter) {
      const kind = C.gateFor(status);
      if (!kind) return false;
      gated = true; app.dataset.state = kind;
      if (kind === 'signin' || kind === 'upgrade') {
        app.innerHTML = `<section class="card gate prem s10-gate" aria-labelledby="ar-gate-h"><span class="prem-kicker">PROPBETEDGE PREDICTIONS · ALL ACCESS</span>
<h2 id="ar-gate-h">${kind === 'signin' ? 'Sign in to see the Arena standings' : 'The Arena standings are included with All Access'}</h2>
<p>${kind === 'upgrade' ? 'You are signed in, but this account does not include PropBetEdge All Access. ' : ''}Members see all three paper portfolios side by side: NAV since the common start, drawdowns, holdings, sector and metal exposure, and every decision with its reason.</p>
<p class="gate-price">Included with PropBetEdge All Access · <b>$29/month</b> — 10 sports + PropBetEdge Predictions.</p>
<div class="gate-cta" data-gate-cta><a class="cta-primary" href="${PRO}" data-pbe-placement="predictions_arena_gate">${kind === 'signin' ? 'Get All Access' : 'Upgrade to All Access'}</a><a class="cta-secondary" href="#" data-pbe-signin>Sign in</a></div></section>`;
        return true;
      }
      const ms = kind === 'retry' ? C.retryAfterMs(retryAfter, 5) : 60000;
      app.innerHTML = `<p class="s10-statusline" role="status"><b>${kind === 'retry' ? 'ACCESS CHECK UNAVAILABLE' : 'DATA UNAVAILABLE'}</b> Retrying in ${Math.round(ms / 1000)} s.</p>`;
      setTimeout(arena, ms); return true;
    }
    document.addEventListener('pbe:membership', (ev) => { if (gated && ev.detail?.entitled) arena(); });

    function chart(a) {
      const series = a.strategies.map((s) => ({ key: s.key, label: s.label, pts: s.series }));
      if (a.comparators) for (const k of ['SPY', 'QQQ']) series.push({ key: k, label: `${k} buy & hold`, pts: a.comparators[k] });
      const dates = [...new Set(series.flatMap((s) => s.pts.map((p) => p.d)))].sort();
      if (dates.length < 2) return `<p class="s10-note">The comparison chart starts after the second close since T0 (${dates.length} session${dates.length === 1 ? '' : 's'} recorded so far).</p>`;
      const vals = series.flatMap((s) => s.pts.map((p) => p.indexed)).filter(Number.isFinite);
      let lo = Math.min(10000, ...vals), hi = Math.max(10000, ...vals); const pad = (hi - lo) * 0.08 || 100; lo -= pad; hi += pad;
      const W = 760, H = 300, L = 62, R = 14, Tp = 12, B = 30;
      const x = (i) => L + (W - L - R) * (i / (dates.length - 1)); const y = (v) => Tp + (H - Tp - B) * (1 - (v - lo) / (hi - lo));
      const di = new Map(dates.map((d, i) => [d, i]));
      const ticks = 4; let g = '';
      for (let k = 0; k <= ticks; k++) { const v = lo + (hi - lo) * k / ticks; g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmtUSD(Math.round(v * 100), { dp: 0 }))}</text>`; }
      g += `<line class="base" x1="${L}" x2="${W - R}" y1="${y(10000).toFixed(1)}" y2="${y(10000).toFixed(1)}"/>`;
      g += [0, dates.length - 1].map((i) => `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i ? 'end' : 'start'}">${esc(fmtDate(dates[i]))}</text>`).join('');
      for (const s of series) {
        let d = ''; let pen = false;
        for (const p of s.pts) { if (!Number.isFinite(p.indexed)) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${x(di.get(p.d)).toFixed(1)},${y(p.indexed).toFixed(1)}`; pen = true; }
        g += `<path class="ar-ln ${CLS[s.key]}" d="${d}"/>`;
      }
      const legend = series.map((s) => { const last = s.pts.filter((p) => Number.isFinite(p.indexed)).at(-1); return `<li><i class="ar-sw ${CLS[s.key]}" aria-hidden="true"></i>${esc(s.label)} <b class="num">${last ? esc(fmtUSD(Math.round(last.indexed * 100), { dp: 0 })) : '—'}</b></li>`; }).join('');
      const table = `<table class="sr-only"><caption>Indexed value, $10,000 at T0</caption><thead><tr><th scope="col">Date</th>${series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${dates.map((d) => `<tr><th scope="row">${esc(d)}</th>${series.map((s) => { const p = s.pts.find((q) => q.d === d); return `<td>${p && Number.isFinite(p.indexed) ? esc(fmtUSD(Math.round(p.indexed * 100))) : 'not available'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
      return `<figure class="ar-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Value of $10,000 since T0 for the three strategies and SPY/QQQ; the table below has every value">${g}</svg><figcaption><ul class="ar-legend">${legend}</ul><span>$10,000 at T0 · Original indexed for display only · gaps = NOT AVAILABLE marks</span></figcaption>${table}</figure>`;
    }

    function card(s) {
      const m = s.metrics || {}; const last = (s.series || []).filter((p) => Number.isFinite(p.indexed)).at(-1);
      const waiting = s.status !== 'RUNNING';
      return `<article class="ar-card ${CLS[s.key]}" aria-labelledby="ar-${s.key}-h"><header><span class="ar-sub">${esc(s.sub)}</span><h3 id="ar-${s.key}-h">${esc(s.label)}</h3></header>
<p class="ar-thesis">${esc(s.thesis)}</p>
${waiting ? `<p class="ar-wait"><b>${esc(s.status.replace(/_/g, ' '))}</b>${s.key === 'ORIGINAL' ? '' : ' · funds $10,000 at T0'}</p>` : `<p class="ar-big num">${last ? esc(fmtUSD(Math.round(last.indexed * 100), { dp: 0 })) : '—'}<small>${pct(m.total_return)} since T0</small></p>`}
<dl class="ar-kv"><dt>Max drawdown</dt><dd class="num">${pct(m.max_drawdown)}</dd><dt>Volatility (ann.)</dt><dd class="num">${pct(m.volatility, { sign: false })}</dd>
<dt>Sharpe</dt><dd class="num" title="${esc(m.sharpe_note || '')}">${Number.isFinite(m.sharpe) ? m.sharpe.toFixed(2) : `<span class="ar-dim">after ${a0.sharpe_min_observations} obs</span>`}</dd>
<dt>Cash</dt><dd class="num">${pct(s.exposure?.cash, { sign: false })}</dd><dt>Largest position</dt><dd class="num">${pct(s.exposure?.max_position, { sign: false })}</dd>
<dt>Metals (ETF)</dt><dd class="num">${pct(s.exposure?.metals, { sign: false })}</dd><dt>Trading cost</dt><dd class="num">${s.turnover ? esc(fmtUSD(s.turnover.trading_cost_cents)) : '—'}</dd><dt>Turnover</dt><dd class="num">${Number.isFinite(s.turnover?.turnover) ? `${(s.turnover.turnover * 100).toFixed(0)}%` : '—'}</dd></dl>
<p class="ar-ver">${esc(s.model)} · ${esc(s.policy)}${s.policy_sha256 ? ` · <span class="s10-hash" title="${esc(s.policy_sha256)}">${esc(short(s.policy_sha256))}</span>` : ''}</p></article>`;
    }
    let a0 = null;

    function exposure(s) {
      const ex = s.exposure; if (!ex) return `<p class="s10-note">${esc(s.label)}: no holdings yet.</p>`;
      const parts = [...ex.sectors.map((x) => ({ k: x.label, w: x.weight, c: 'sec' })), ...(ex.metals > 0 ? [{ k: 'Precious metals (ETF)', w: ex.metals, c: 'met' }] : []), { k: 'Cash', w: ex.cash, c: 'cash' }].filter((x) => x.w > 0.0005);
      return `<div class="ar-exp"><h4>${esc(s.label)}</h4><div class="ar-bar" role="img" aria-label="${esc(parts.map((x) => `${x.k} ${(x.w * 100).toFixed(1)}%`).join(', '))}">${parts.map((x, i) => `<span class="ar-seg ${x.c} s${i % 6}" style="width:${(x.w * 100).toFixed(2)}%" title="${esc(x.k)} ${(x.w * 100).toFixed(1)}%"></span>`).join('')}</div>
<ul class="ar-exp-list">${parts.map((x, i) => `<li><i class="ar-seg ${x.c} s${i % 6}" aria-hidden="true"></i>${esc(x.k)} <b class="num">${(x.w * 100).toFixed(1)}%</b></li>`).join('')}</ul></div>`;
    }

    function holdings(s) {
      if (!s.holdings?.length) return `<p class="s10-note">${s.status === 'RUNNING' ? 'All cash at the latest close.' : 'No holdings before T0.'}</p>`;
      return `<div class="tbl-wrap"><table class="s10-tbl"><caption class="sr-only">${esc(s.label)} holdings at the ${esc(fmtDate(s.nav?.d))} close</caption><thead><tr><th scope="col">Symbol</th><th scope="col">Sector</th><th scope="col" class="num">Weight</th><th scope="col" class="num">P&amp;L vs cost</th><th scope="col" class="num">Since</th></tr></thead><tbody>${s.holdings.map((h) => `<tr><th scope="row">${esc(h.symbol)}${h.name ? `<small> ${esc(h.name)}</small>` : ''}</th><td>${esc(h.kind === 'METAL_ETF' ? 'Precious metals ETF' : (h.sector || '').replace(/_/g, ' ').toLowerCase())}</td><td class="num">${pct(h.weight, { sign: false })}</td><td class="num ${C.signCls(h.pnl_pct)}">${pct(h.pnl_pct)}</td><td class="num">${h.entry_date ? esc(fmtDate(h.entry_date)) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function decisions(s) {
      const rows = (s.decisions || []).filter((d) => d.type === 'ORDER' || d.action !== 'HOLD').slice(0, 40);
      const pend = s.pending || [];
      if (!rows.length && !pend.length) return '<p class="s10-note">No orders or waits at the latest close.</p>';
      return `<ul class="ar-dec">${rows.map((d) => `<li><span class="ar-act ${esc((d.action || '').toLowerCase())}">${esc(d.type === 'ORDER' ? d.action : d.action || d.type)}</span><b>${esc(d.symbol || '')}</b>${d.rank ? `<span class="ar-dim"> rank ${esc(String(d.rank))}</span>` : ''}<span class="ar-why">${esc(d.reason || '')}</span></li>`).join('')}</ul>`;
    }

    async function arena() {
      const r = await get('arena');
      if (gate(r.status, r.retryAfter)) return;
      if (r.status !== 200 || !r.data) { app.innerHTML = '<p class="s10-statusline" role="status"><b>DATA UNAVAILABLE</b> Retrying in 60 s.</p>'; setTimeout(arena, 60000); return; }
      gated = false; const a = a0 = r.data; app.dataset.state = 'ready';
      const by = Object.fromEntries(a.strategies.map((s) => [s.key, s]));
      const orig = by.ORIGINAL;
      const tabs = KEYS.map((k, i) => `<button type="button" role="tab" id="ar-tab-${k}" aria-controls="ar-pane-${k}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" class="ar-tab ${CLS[k]}">${esc(by[k].label)}</button>`).join('');
      const panes = KEYS.map((k, i) => `<div role="tabpanel" id="ar-pane-${k}" aria-labelledby="ar-tab-${k}"${i ? ' hidden' : ''} tabindex="0"><div class="s10-grid2"><section><h4>Holdings${by[k].nav?.d ? ` · ${esc(fmtDate(by[k].nav.d))} close` : ''}</h4>${holdings(by[k])}</section><section><h4>Latest decisions</h4>${decisions(by[k])}</section></div>
${k === 'ORIGINAL' ? '' : `<p class="s10-note">Every event of this account, hash-chained: <a href="/api/signal10/arena/ledger?account=${esc(by[k].account)}">ledger JSON</a> (${esc(String(by[k].ledger?.events ?? 0))} events, head <span class="s10-hash">${esc(short(by[k].ledger?.head_hash))}</span>).</p>`}</div>`).join('');
      app.innerHTML = `<section class="ar-sec" aria-labelledby="ar-board-h"><h2 id="ar-board-h" class="s10-h2">Standings since T0</h2>
${a.status !== 'RUNNING' ? '<p class="s10-statusline" role="status"><b>AWAITING T0</b> The challengers fund $10,000 each at the first U.S. close after activation. Until then only the Original has a record.</p>' : `<p class="s10-sub">Common start <b>${esc(fmtDate(a.t0))}</b> · latest close ${esc(fmtDate(a.sample.last_d))} · ${esc(String(a.sample.sessions))} session${a.sample.sessions === 1 ? '' : 's'}. No winner is declared on a short sample.</p>`}
<div class="ar-cards">${KEYS.map((k) => card(by[k])).join('')}</div></section>
${a.status === 'RUNNING' ? `<section class="ar-sec" aria-labelledby="ar-chart-h"><h2 id="ar-chart-h" class="s10-h2">Value of $10,000 since T0</h2>${chart(a)}</section>` : ''}
<section class="ar-sec" aria-labelledby="ar-exp-h"><h2 id="ar-exp-h" class="s10-h2">Sector, metal and cash exposure</h2><div class="ar-exps">${KEYS.map((k) => exposure(by[k])).join('')}</div>
<p class="s10-note">Sectors use the PBE SEC-SIC taxonomy (not GICS). The Diversified caps are 10% per holding, 25% per sector and 20% in precious-metal ETFs; Tech holds technology only by design.</p></section>
<section class="ar-sec" aria-labelledby="ar-hold-h"><h2 id="ar-hold-h" class="s10-h2">Holdings and decision evidence</h2><div class="ar-tabs" role="tablist" aria-label="Strategy">${tabs}</div>${panes}</section>
<section class="ar-sec" aria-labelledby="ar-orig-h"><h2 id="ar-orig-h" class="s10-h2">About the Original's record</h2>
<p class="s10-sub">The Original is the control and is never reset. It started on ${esc(fmtDate(orig.inception))} and was already invested at T0, so it is compared <b>indexed to $10,000 at T0</b> (display only). Its real lifetime paper NAV: <b class="num">${orig.nav?.cents != null ? esc(fmtUSD(orig.nav.cents)) : '—'}</b> at the ${esc(fmtDate(orig.nav?.d))} close, ${pct(orig.metrics_lifetime?.total_return)} since inception. <a href="/markets/signal-10/live/">Open the Original's live portfolio</a>.</p></section>`;
      const tablist = app.querySelector('[role=tablist]');
      const sel = (btn) => { app.querySelectorAll('[role=tab]').forEach((b) => { const on = b === btn; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; document.getElementById(b.getAttribute('aria-controls')).hidden = !on; }); btn.focus(); };
      tablist.addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) sel(b); });
      tablist.addEventListener('keydown', (e) => { const list = [...tablist.querySelectorAll('[role=tab]')]; const i = list.indexOf(document.activeElement); if (i < 0) return; const n = e.key === 'ArrowRight' ? (i + 1) % list.length : e.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1; if (n >= 0) { e.preventDefault(); sel(list[n]); } });
    }

    proof(); arena();
  }
})();
