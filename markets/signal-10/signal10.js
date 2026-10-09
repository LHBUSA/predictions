// PBE Signal 10 — page controller (one classic script; behavior chosen by <body data-page>).
// Renders ONLY values returned by /api/signal10/* (same-origin, credentials). Member routes answer 401/403/503 when the
// reader is not entitled; the page then shows the matching gate and never a number from anywhere else.
// Two record populations — HISTORICAL_REPLAY (backtest) and FORWARD_PAPER (paper account) — are never drawn together.
(() => {
  'use strict';
  const boot = () => main(window.S10Core);
  if (window.S10Core) boot(); else window.addEventListener('s10core', boot, { once: true });

  function main(C) {
    const { esc, fmtUSD, fmtPct, fmtPrice, fmtInt, fmtQty, fmtDate, etDateTime, etTime, relTime, signCls } = C;
    const page = document.body.dataset.page;
    const app = document.getElementById('s10-app');
    const PRO = 'https://propbetedge.ai/pro';
    const START_CENTS = 1000000;
    let gated = false;
    let rerun = null;

    // ---------------- fetch + access ----------------
    async function api(path) {
      try {
        const r = await fetch(`/api/signal10/${path}`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
        let data = null; try { data = await r.json(); } catch { /* non-JSON */ }
        return { status: r.status, data, retryAfter: r.headers.get('retry-after') };
      } catch (e) { return { status: 0, data: null, error: e }; }
    }
    function gateHTML(kind, what) {
      if (kind === 'signin') return `<section class="card gate prem s10-gate" aria-labelledby="s10-gate-h">
<span class="prem-kicker">PROPBETEDGE PREDICTIONS · ALL ACCESS</span><h2 id="s10-gate-h">Sign in to see ${esc(what)}</h2>
<p>Signal 10 rankings, the $10,000 paper account, the full backtest and both ledgers are included with PropBetEdge All Access.</p>
<ul class="gate-list"><li>Top 10 ranked S&amp;P 500 names each close, with factor detail</li><li>The live $10,000 paper account with timestamped quotes</li><li>Every backtest month, drawdown, cost and contributor</li><li>Append-only, hash-chained trade ledgers</li></ul>
<p class="gate-price">Included with PropBetEdge All Access · <b>$29/month</b> — 10 sports + PropBetEdge Predictions.</p>
<div class="gate-cta" data-gate-cta><a class="cta-primary" href="${PRO}" data-pbe-placement="predictions_signal10_gate">Get All Access</a><a class="cta-secondary" href="#" data-pbe-signin>Sign in</a></div>
<p class="s10-note">The <a href="/markets/signal-10/methodology/">methodology</a> and the public headline record are open to everyone.</p></section>`;
      if (kind === 'upgrade') return `<section class="card gate prem s10-gate" aria-labelledby="s10-gate-h">
<span class="prem-kicker">PROPBETEDGE PREDICTIONS · ALL ACCESS</span><h2 id="s10-gate-h">${esc(what[0].toUpperCase() + what.slice(1))} ${what.endsWith('s') ? 'are' : 'is'} included with All Access</h2>
<p>You are signed in, but this account does not include PropBetEdge All Access.</p>
<p class="gate-price">All Access · <b>$29/month</b> — 10 sports + PropBetEdge Predictions.</p>
<div class="gate-cta" data-gate-cta><a class="cta-primary" href="${PRO}" data-pbe-placement="predictions_signal10_upgrade">Upgrade to All Access</a><a class="cta-secondary" href="#" data-pbe-signin>Sign in with another account</a></div>
<p class="s10-note">The <a href="/markets/signal-10/methodology/">methodology</a> and the public headline record are open to everyone.</p></section>`;
      return '';
    }
    // Returns true when the response was a gate/error (and schedules a retry where appropriate).
    function handleGate(r, what, retry, target = app) {
      const kind = C.gateFor(r.status);
      if (!kind) { gated = false; return false; }
      gated = true; rerun = retry;
      target.dataset.state = kind;
      if (kind === 'signin' || kind === 'upgrade') { target.innerHTML = gateHTML(kind, what); return true; }
      const ms = kind === 'retry' ? C.retryAfterMs(r.retryAfter, 5) : 60000;
      target.innerHTML = kind === 'retry'
        ? `<p class="s10-statusline" role="status"><b>ACCESS CHECK UNAVAILABLE</b> Your membership could not be verified just now. Retrying in ${Math.round(ms / 1000)} s.</p>`
        : `<p class="s10-statusline" role="status"><b>DATA UNAVAILABLE</b> Signal 10 data could not be loaded (${r.status ? `HTTP ${r.status}` : 'network error'}). Retrying in ${Math.round(ms / 1000)} s.</p>`;
      setTimeout(retry, ms);
      return true;
    }
    // membership resolved to entitled while a gate is showing (e.g. after sign-in): load again
    document.addEventListener('pbe:membership', (ev) => { if (gated && ev.detail?.entitled && rerun) rerun(); });

    // ---------------- small render helpers ----------------
    const cls = (v) => signCls(v);
    const zeroTxt = (t) => !/[1-9]/.test(t); // prints as zero -> neutral colour, never a green/red 0.00
    const money = (c, o) => { const t = fmtUSD(c, { sign: true, ...o }); return `<span class="${zeroTxt(t) ? 'flat' : cls(c)}">${t}</span>`; };
    const pct = (f, o) => { const t = fmtPct(f, o); return `<span class="${zeroTxt(t) ? 'flat' : cls(f)}">${t}</span>`; };
    const short = (h) => (h ? `${String(h).slice(0, 10)}…` : '—');
    const kpi = (label, value, small = '', extra = '') => `<div class="s10-kpi ${extra}"><span>${label}</span><strong>${value}</strong>${small ? `<small>${small}</small>` : ''}</div>`;
    const tbl = (caption, head, rows, { cap2 = '', label = caption, cls: tc = '' } = {}) => `<div class="s10-tbl-wrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="s10-tbl ${tc}"><caption>${caption}${cap2 ? `<small>${cap2}</small>` : ''}</caption><thead><tr>${head.map((h) => `<th scope="col"${/^(r:)/.test(h) ? ' class="r"' : ''}>${h.replace(/^r:/, '')}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    const symCell = (sym, name) => `<th scope="row"><span class="s10-sym">${esc(sym)}</span>${name ? `<span class="s10-name" title="${esc(name)}">${esc(name)}</span>` : ''}</th>`;
    const rel = (iso) => `<span data-rel="${esc(iso || '')}" title="${esc(etDateTime(iso))}">${relTime(iso)}</span>`;
    setInterval(() => { for (const el of document.querySelectorAll('[data-rel]')) if (el.dataset.rel) el.textContent = relTime(el.dataset.rel); }, 30000);

    // ---------------- SVG line chart (hand-written; straight segments through data rows only) ----------------
    // spec: { xs:number[], series:[{key,label,values:(number|null)[],cls,area?}], yFmt, tipX, xTicks(x0,x1,xs)->[{x,label}],
    //         log?:boolean, baseline?:number, ariaLabel, readout:Element, height? }
    function chart(host, spec) {
      const state = { idx: -1, hidden: new Set(spec.hidden || []), log: !!spec.log };
      host.classList.add('s10-chart');
      host.innerHTML = '';
      const tip = document.createElement('div'); tip.className = 's10-tip'; tip.hidden = true; tip.setAttribute('aria-hidden', 'true');
      let W = 0, H = 0, geo = null;
      function draw() {
        W = Math.max(280, Math.round(host.clientWidth || 600));
        H = spec.height ? spec.height(W) : (W < 560 ? 240 : 330);
        const M = { l: W < 560 ? 48 : 62, r: 14, t: 12, b: 28 };
        const vis = spec.series.filter((s) => !state.hidden.has(s.key));
        const all = vis.flatMap((s) => s.values);
        if (spec.baseline != null) all.push(spec.baseline);
        let ext = C.extent(all) || [0, 1];
        const useLog = state.log && ext[0] > 0;
        let ticks;
        if (useLog) { ext = [ext[0] * 0.97, ext[1] * 1.03]; ticks = C.logTicks(ext[0], ext[1]); }
        else { ticks = C.niceTicks(ext[0], ext[1], W < 560 ? 4 : 6); ext = [Math.min(ext[0], ticks[0]), Math.max(ext[1], ticks.at(-1))]; }
        const x0 = spec.xs[0], x1 = spec.xs.at(-1);
        const sx = C.scale(x0, x1 === x0 ? x0 + 1 : x1, M.l, W - M.r);
        const sy = C.scale(ext[0], ext[1], H - M.b, M.t, { log: useLog });
        geo = { sx, sy, M, px: spec.xs.map(sx) };
        const yt = ticks.filter((v) => v >= ext[0] - 1e-9 && v <= ext[1] + 1e-9);
        let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="${esc(spec.ariaLabel)}" focusable="true">`;
        const ystep = yt.length > 1 ? Math.abs(yt[1] - yt[0]) : 0;
        svg += yt.map((v) => `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/><text class="axis" x="${M.l - 6}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${esc(spec.yFmt(v, true, ystep))}</text>`).join('');
        if (spec.baseline != null) svg += `<line class="base" x1="${M.l}" x2="${W - M.r}" y1="${sy(spec.baseline).toFixed(1)}" y2="${sy(spec.baseline).toFixed(1)}"/>`;
        const xt = spec.xTicks(x0, x1, spec.xs, W);
        svg += xt.map((t, i) => `<text class="axis" x="${sx(t.x).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 && sx(t.x) - M.l < 20 ? 'start' : 'middle'}">${esc(t.label)}</text>`).join('');
        for (const s of vis) {
          const d = C.linePath(spec.xs, s.values, sx, sy);
          if (s.area) {
            const b = sy(Math.max(ext[0], Math.min(ext[1], 0)));
            // area closes down to zero only between drawn points of the same segment
            const segs = d.split('M').filter(Boolean).map((seg) => { const pts = seg.split('L'); const first = pts[0].split(','), last = pts.at(-1).split(','); return `M${seg}L${last[0]},${b.toFixed(1)}L${first[0]},${b.toFixed(1)}Z`; });
            svg += `<path class="area" d="${segs.join('')}"/>`;
          }
          svg += `<path class="ln ${s.cls || s.key}" d="${d}"/>`;
          // a series with a single drawn point still shows as a dot
          const n = s.values.filter((v) => Number.isFinite(v)).length;
          if (n === 1) { const i = s.values.findIndex((v) => Number.isFinite(v)); svg += `<circle class="dot ${s.cls || s.key}" r="3.5" cx="${sx(spec.xs[i]).toFixed(1)}" cy="${sy(s.values[i]).toFixed(1)}"/>`; }
        }
        svg += `<g class="xhg" visibility="hidden"><line class="xh" y1="${M.t}" y2="${H - M.b}"/>${vis.map((s) => `<circle class="dot ${s.cls || s.key}" r="4" data-k="${s.key}"/>`).join('')}</g>`;
        svg += `<rect x="${M.l}" y="${M.t}" width="${Math.max(1, W - M.l - M.r)}" height="${Math.max(1, H - M.t - M.b)}" fill="transparent" class="hit"/></svg>`;
        host.innerHTML = svg; host.appendChild(tip);
        const el = host.querySelector('svg');
        el.addEventListener('pointermove', (ev) => { const r = el.getBoundingClientRect(); const x = (ev.clientX - r.left) * (W / r.width); show(C.nearest(geo.px, x)); });
        el.addEventListener('pointerleave', () => hide());
        el.addEventListener('blur', () => hide());
        el.addEventListener('keydown', (ev) => {
          const n = spec.xs.length; let i = state.idx < 0 ? n - 1 : state.idx;
          const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -(spec.page || 21), PageDown: spec.page || 21 }[ev.key];
          if (step) i += step; else if (ev.key === 'Home') i = 0; else if (ev.key === 'End') i = n - 1; else if (ev.key === 'Escape') { hide(); return; } else return;
          ev.preventDefault(); show(Math.max(0, Math.min(n - 1, i)));
        });
        if (state.idx >= 0) show(state.idx);
      }
      function show(i) {
        if (i < 0) return;
        state.idx = i;
        const el = host.querySelector('svg'); const g = el.querySelector('.xhg');
        const x = geo.px[i];
        g.setAttribute('visibility', 'visible');
        g.querySelector('.xh').setAttribute('x1', x); g.querySelector('.xh').setAttribute('x2', x);
        const rows = [];
        for (const c of g.querySelectorAll('circle')) {
          const s = spec.series.find((q) => q.key === c.dataset.k); const v = s.values[i];
          if (Number.isFinite(v)) { c.setAttribute('cx', x); c.setAttribute('cy', geo.sy(v)); c.setAttribute('visibility', 'visible'); } else c.setAttribute('visibility', 'hidden');
          rows.push(`<span><em><i class="sw-${s.cls || s.key}"></i>${esc(s.label)}</em><b style="display:inline;margin:0;color:inherit">${Number.isFinite(v) ? esc(spec.yFmt(v)) : '—'}</b></span>`);
        }
        tip.innerHTML = `<b>${esc(spec.tipX(spec.xs[i], i))}</b>${rows.join('')}`;
        tip.hidden = false;
        const r = el.getBoundingClientRect(); const scaleX = r.width / W; const px = x * scaleX;
        const tw = tip.offsetWidth || 200;
        tip.style.left = `${Math.max(0, Math.min(r.width - tw, px + (px > r.width / 2 ? -tw - 12 : 12)))}px`;
        if (spec.readout) spec.readout.textContent = `${spec.tipX(spec.xs[i], i)} — ${spec.series.filter((s) => !state.hidden.has(s.key)).map((s) => `${s.label} ${Number.isFinite(s.values[i]) ? spec.yFmt(s.values[i]) : 'no data'}`).join(' · ')}`;
      }
      function hide() { const g = host.querySelector('.xhg'); if (g) g.setAttribute('visibility', 'hidden'); tip.hidden = true; state.idx = -1; }
      draw();
      let lastW = host.clientWidth;
      if ('ResizeObserver' in window) new ResizeObserver(() => { if (Math.abs(host.clientWidth - lastW) > 2) { lastW = host.clientWidth; draw(); } }).observe(host);
      return { toggle(k, on) { if (on) state.hidden.delete(k); else state.hidden.add(k); draw(); }, setLog(on) { state.log = on; draw(); }, redraw: draw };
    }
    const yearTicks = (x0, x1, xs, W) => {
      const out = []; const y0 = new Date(x0).getUTCFullYear(), y1 = new Date(x1).getUTCFullYear();
      const every = W < 560 ? 2 : 1;
      for (let y = y0 + (Date.UTC(y0, 0, 1) < x0 ? 1 : 0); y <= y1; y++) if ((y - y0) % every === 0) out.push({ x: Date.UTC(y, 0, 1), label: String(y) });
      return out;
    };
    const sampleTicks = (fmt) => (x0, x1, xs, W) => {
      const n = Math.min(xs.length, W < 560 ? 3 : 5); if (n < 2) return xs.length ? [{ x: xs[0], label: fmt(xs[0]) }] : [];
      return Array.from({ length: n }, (_, k) => xs[Math.round((k * (xs.length - 1)) / (n - 1))]).map((x) => ({ x, label: fmt(x) }));
    };
    const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
    const shortDay = (ms) => fmtDate(isoDay(ms)).replace(/, \d{4}$/, '');

    // chart toggles: buttons with aria-pressed
    function toggles(series, ch, { log = false } = {}) {
      const box = document.createElement('div'); box.className = 's10-chart-tools'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Chart series');
      box.innerHTML = series.map((s) => `<button type="button" class="s10-toggle" aria-pressed="${s.hidden ? 'false' : 'true'}" data-k="${s.key}"><i class="sw-${s.cls || s.key}" aria-hidden="true"></i>${esc(s.label)}</button>`).join('')
        + (log ? '<button type="button" class="s10-toggle scale" aria-pressed="false" data-log>Log scale</button>' : '');
      box.addEventListener('click', (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        const on = b.getAttribute('aria-pressed') !== 'true';
        if (b.hasAttribute('data-log')) { b.setAttribute('aria-pressed', String(on)); ch().setLog(on); return; }
        if (!on && box.querySelectorAll('[data-k][aria-pressed=true]').length === 1) return; // keep one series visible
        b.setAttribute('aria-pressed', String(on)); ch().toggle(b.dataset.k, on);
      });
      return box;
    }

    // ---------------- public proof (forward status line) ----------------
    async function proof() { const r = await api('proof'); return r.status === 200 ? r.data : null; }
    function forwardStatusLine(p) {
      const f = p?.forward;
      if (!f) return '<p class="s10-statusline" role="status"><b>PAPER ACCOUNT STATUS UNAVAILABLE</b> The public proof record could not be loaded just now.</p>';
      if (f.status === 'RUNNING') return `<p class="s10-statusline" role="status"><b>PBE PAPER ACCOUNT · RUNNING</b> Inception ${esc(fmtDate(f.inception))} close · ${fmtInt(f.ledger_events)} ledger events · head hash <span class="s10-hash">${esc(short(f.ledger_head_hash))}</span>${f.latest_snapshot ? ` · latest snapshot ${esc(fmtDate(f.latest_snapshot.d))}` : ''}.</p>`;
      if (f.status === 'NOT_STARTED') return '<p class="s10-statusline" role="status"><b>PBE PAPER ACCOUNT · NOT STARTED</b> The $10,000 simulated account is funded at its first end-of-day run (inception: the 2026-10-09 close) and places its first fills at the next regular-session open. Until then nothing on this page belongs to it.</p>';
      return '<p class="s10-statusline" role="status"><b>PBE PAPER ACCOUNT · STATUS UNAVAILABLE</b> The forward ledger could not be read just now; the backtest below is unaffected.</p>';
    }

    // =====================================================================================================
    // TOP 10 TODAY
    // =====================================================================================================
    async function today() {
      const r = await api('today');
      if (handleGate(r, 'today’s Signal 10 rankings', today)) return;
      const d = r.data;
      app.dataset.state = 'ready';
      if (d.origin === 'FORWARD_PAPER') return todayForward(d);
      const p = await proof();
      const max = 100;
      app.innerHTML = `<section class="s10-sec s10-hypo" aria-labelledby="t-h">
<span class="s10-tag s10-tag-bt">HISTORICAL_REPLAY · BACKTEST · HYPOTHETICAL</span>
<h2 class="s10-h2" id="t-h" style="margin-top:10px">${esc(d.label)}</h2>
<ul class="s10-meta"><li>Model <b>${esc(d.model)}</b></li><li>Snapshot <b>${esc(fmtDate(d.d))}</b> close</li><li><b>${fmtInt(d.eligible)}</b> eligible point-in-time S&amp;P 500 members</li><li>Change vs the previous replay close</li></ul>
<ol class="s10-top">${d.top.slice(0, 10).map((t) => {
        const mv = C.rankMove(t.rank, t.prevRank);
        return `<li class="s10-rank"><span class="s10-rank-n" aria-label="Rank ${t.rank}">${t.rank}</span>
<div class="s10-rank-id"><span class="s10-sym">${esc(t.symbol)}</span></div>
<div class="s10-bar" aria-label="Score ${t.score} of 100 (index, not a probability)"><span class="s10-bar-track"><span class="s10-bar-fill" style="width:${Math.max(0, Math.min(100, (t.score / max) * 100))}%"></span></span><b>${t.score.toFixed(1)} <small>/ 100</small></b></div>
<div class="s10-rank-meta"><span class="s10-chip ${mv.dir}" title="${t.prevRank ? `Previous rank ${t.prevRank}` : 'Not in the previous top 10'}">${mv.dir === 'new' ? 'NEW' : mv.dir === 'same' ? 'SAME RANK' : mv.text}</span></div></li>`;
      }).join('')}</ol>
<p class="s10-note">Replay snapshots carry ranks and scores only; factor detail, holdings and order badges arrive with the forward lane’s first frozen snapshot. Score = percentile of the composite among eligible names — an index from 0 to 100, not a probability.</p>
</section>
${forwardStatusLine(p)}
${links()}`;
    }
    function links() {
      return `<nav class="s10-sec" aria-label="More Signal 10"><span class="s10-over">Continue</span><ul class="s10-toc">
<li><a href="/markets/signal-10/live/">Live $10k paper portfolio →</a></li><li><a href="/markets/signal-10/backtest/">Historical backtest →</a></li><li><a href="/markets/signal-10/ledger/">Trade ledger →</a></li><li><a href="/markets/signal-10/methodology/">How the rank works →</a></li></ul></nav>`;
    }
    function factorChips(f) {
      if (!f) return '';
      const c = (label, v, o) => `<span class="s10-factor"><em>${label}</em>${pct(v, o)}</span>`;
      return `<div class="s10-factors">${c('12-1 mom', f.mom12_1)}${c('6-mo', f.mom6)}${c('vs 200-day', f.trend200)}<span class="s10-factor"><em>63-day vol</em>${fmtPct(f.vol63, { sign: false })}</span>${c('1-day', f.ret1)}${c('from 10-day high', f.pullback10)}<span class="s10-factor"><em>uptrend</em>${f.uptrend ? 'yes' : 'no'}</span></div>`;
    }
    function orderText(o) {
      if (o.side === 'BUY') return `ORDER QUEUED · next open · BUY ≈ ${fmtUSD(o.targetCents, { dp: 0 })}`;
      return `ORDER QUEUED · next open · SELL ${fmtQty(o.qty)} sh`;
    }
    async function todayForward(d) {
      const pend = new Map((d.pending || []).map((o) => [o.symbol, o]));
      const statusChip = (t) => {
        if (t.status === 'NEW') return '<span class="s10-chip new">NEW</span>';
        const mv = C.rankMove(t.rank, t.prevRank);
        if (t.status === 'RISING') return `<span class="s10-chip up">RISING ${mv.text}</span>`;
        if (t.status === 'FALLING') return `<span class="s10-chip down">FALLING ${mv.text}</span>`;
        if (t.status === 'HOLDING') return '<span class="s10-chip" title="HOLDING: same rank as the previous close">SAME RANK</span>';
        return t.prevRank ? `<span class="s10-chip">prev #${t.prevRank}</span>` : '';
      };
      const counts = { NEW: 0, RISING: 0, FALLING: 0, HOLDING: 0 };
      for (const t of d.top.slice(0, 10)) if (t.status in counts) counts[t.status]++;
      const rg = d.regime || {};
      const above = rg.spyAdj && rg.spySma200 ? rg.spyAdj / rg.spySma200 - 1 : null;
      const excl = Object.entries(d.excluded || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmtInt(v)}`).join(' · ');
      const row = (t) => {
        const o = pend.get(t.symbol);
        return `<li class="s10-rank" data-sym="${esc(t.symbol)}"><span class="s10-rank-n" aria-label="Rank ${t.rank}">${t.rank}</span>
<div class="s10-rank-id"><span class="s10-sym">${esc(t.ticker || t.symbol)}</span>${t.name ? `<span class="s10-name">${esc(t.name)}</span>` : ''}</div>
<div class="s10-bar" aria-label="Score ${t.score} of 100 (index, not a probability)"><span class="s10-bar-track"><span class="s10-bar-fill" style="width:${Math.max(0, Math.min(100, t.score))}%"></span></span><b>${Number(t.score).toFixed(1)} <small>/ 100</small></b></div>
<div class="s10-rank-meta">${statusChip(t)}<span class="s10-chip ${t.held ? 'held' : ''}">${t.held ? 'HELD' : 'NOT HELD'}</span>${o ? `<span class="s10-chip queued">${esc(orderText(o))}</span>` : ''}${t.streak ? `<span class="s10-chip" title="Consecutive closes in the top 10">streak ${t.streak}/5</span>` : ''}</div>
${factorChips(t.f)}<p class="s10-why" data-why hidden></p></li>`;
      };
      const watch = d.top.slice(10, 30);
      app.innerHTML = `<section class="s10-sec" aria-labelledby="t-h">
<span class="s10-tag s10-tag-fw">FORWARD_PAPER · FROZEN SNAPSHOT</span>
<h2 class="s10-h2" id="t-h" style="margin-top:10px">Top 10 at the ${esc(fmtDate(d.d))} close</h2>
<ul class="s10-meta"><li>Frozen <b>${esc(etDateTime(d.frozen_at))}</b></li><li>Data cutoff <b>${esc(d.data_cutoff || '—')}</b></li><li><b>${fmtInt(d.eligible)}</b> eligible of <b>${fmtInt(d.members?.count)}</b> members${excl ? ` (excluded: ${esc(excl)})` : ''}</li><li>Model <b>${esc(d.model)}</b></li><li>Snapshot hash <span class="s10-hash" title="${esc(d.content_sha256 || '')}">${esc(short(d.content_sha256))}</span></li></ul>
<p style="margin:0 0 12px"><span class="s10-regime ${rg.riskOn ? 'on' : 'off'}">${rg.riskOn ? 'RISK-ON' : 'RISK-OFF'} · SPY ${above == null ? '' : `${fmtPct(above)} vs`} its 200-day average · ${rg.riskOn ? 'new buys allowed' : 'no new names (hold / exit only)'}</span></p>
${d.prev_d ? `<p class="s10-note" style="margin:0 0 12px">Changes since ${esc(fmtDate(d.prev_d))}: <b>${counts.NEW}</b> new · <b>${counts.RISING}</b> rising · <b>${counts.FALLING}</b> falling · <b>${counts.HOLDING}</b> unchanged · <b>${(d.exited || []).length}</b> exited the top 10.</p>` : '<p class="s10-note" style="margin:0 0 12px">First frozen snapshot: no previous close to compare.</p>'}
<ol class="s10-top" id="s10-top10">${d.top.slice(0, 10).map(row).join('')}</ol>
<p class="s10-note">Score = percentile of the composite among eligible names — an index from 0 to 100, not a probability. HELD means the paper account owns the name; a queued order fills at the next regular-session open.</p>
</section>
${(d.pending || []).length ? `<section class="s10-sec" aria-labelledby="p-h"><h2 class="s10-h2" id="p-h">Orders queued for the next open</h2><p class="s10-sub">Decided at the ${esc(fmtDate(d.d))} close; simulated fills at the next regular-session open with 10 bps slippage.</p>
${tbl('Pending paper orders', ['Side', 'Symbol', 'r:Size', 'r:Rank', 'r:Score', 'Reason'], d.pending.map((o) => `<tr><td>${esc(o.side)}</td>${symCell(o.symbol)}<td class="num">${o.side === 'BUY' ? `≈ ${fmtUSD(o.targetCents)}` : `${fmtQty(o.qty)} sh`}</td><td class="num">${o.rank ?? '—'}</td><td class="num">${o.score ?? '—'}</td><td class="wrap">${esc(o.reason || '')}</td></tr>`))}</section>` : ''}
${(d.exited || []).length ? `<section class="s10-sec" aria-labelledby="x-h"><h2 class="s10-h2" id="x-h">Exited the top 10</h2>${tbl('Names that left the top 10 since the previous close', ['Symbol', 'r:Previous rank', 'r:Rank now'], d.exited.map((x) => `<tr>${symCell(x.symbol, x.name)}<td class="num">${x.prevRank}</td><td class="num">${x.rank ?? 'not ranked'}</td></tr>`))}</section>` : ''}
${watch.length ? `<section class="s10-sec" aria-labelledby="w-h"><h2 class="s10-h2" id="w-h">Watch band · ranks 11–30</h2><p class="s10-sub">Holdings in this band are kept (exit at rank &gt; 30). Names here are not entry candidates until they reach the top 10.</p>
${tbl('Ranks 11 to 30', ['r:Rank', 'Symbol', 'r:Score', 'Change', 'Held'], watch.map((t) => `<tr><td class="num">${t.rank}</td>${symCell(t.ticker || t.symbol, t.name)}<td class="num">${Number(t.score).toFixed(1)}</td><td>${statusChip(t) || '—'}</td><td>${t.held ? '<span class="s10-chip held">HELD</span>' : 'not held'}</td></tr>`))}</section>` : ''}
${links()}`;
      // WAIT / HOLD reasons for today's decisions come from the forward ledger (annotated after first paint)
      const lr = await api(`ledger?origin=FORWARD_PAPER&d=${encodeURIComponent(d.d)}`);
      if (lr.status !== 200 || !lr.data?.events) return;
      const dec = new Map();
      for (const e of lr.data.events.map(C.flattenEvent)) if (e.type === 'DECISION' && e.d === d.d && e.symbol) dec.set(e.symbol, e);
      for (const li of document.querySelectorAll('#s10-top10 [data-sym]')) {
        const e = dec.get(li.dataset.sym); const p = li.querySelector('[data-why]');
        if (e && p) { const why = String(e.reason || ''); const head = why.split(':')[0]; p.innerHTML = e.action && why.startsWith(e.action) ? `<b>${esc(head)}</b>${esc(why.slice(head.length))}` : `<b>${esc(e.action || 'DECISION')}</b> ${esc(why)}`; p.hidden = false; }
      }
    }

    // =====================================================================================================
    // LIVE $10K PORTFOLIO
    // =====================================================================================================
    const L = { timer: null, data: null, quotes: new Map(), cq: new Map(), intraSig: null, eodSig: null, built: false, proof: null, charts: {} };
    async function live() {
      clearTimeout(L.timer);
      const r = await api('live');
      if (handleGate(r, 'the Signal 10 paper portfolio', live)) return;
      L.data = r.data;
      if (!L.data.forward && !L.proof) L.proof = await proof();
      renderLive(L.data);
      schedule();
    }
    function schedule() {
      clearTimeout(L.timer);
      const ms = C.pollMs(L.data?.session?.state, document.visibilityState === 'visible');
      if (ms) L.timer = setTimeout(live, ms);
    }
    if (page === 'live') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') live(); else clearTimeout(L.timer); });

    function quoteTimes(d) {
      return [...(d.forward?.positions || []).map((p) => p.quoteTime), d.benchmarksQuotes?.SPY?.quoteTime, d.benchmarksQuotes?.QQQ?.quoteTime].filter(Boolean);
    }
    function renderLive(d) {
      const now = Date.parse(d.now) || Date.now();
      const badge = C.sessionBadge(d.session, quoteTimes(d), now);
      const sessionHTML = `<span class="s10-session ${badge.cls}" role="status"><i aria-hidden="true"></i>${esc(badge.text)}</span>`;
      const f = d.forward;
      if (!L.built || (L.built === 'fwd') !== !!f) {
        L.built = f ? 'fwd' : 'nofwd'; L.quotes.clear(); L.cq.clear(); L.intraSig = null; L.eodSig = null;
        app.dataset.state = 'ready';
        app.innerHTML = `${f ? `<section class="s10-term" aria-labelledby="acct-h" id="s10-hero"></section>
<section class="s10-sec" aria-labelledby="h-h"><h2 class="s10-h2" id="h-h">Holdings</h2><p class="s10-sub">Each price carries the source’s own trade time. Rows update only when a new quote time arrives.</p><div id="s10-holdings"></div><div id="s10-pending"></div></section>
<section class="s10-sec" aria-labelledby="b-h"><h2 class="s10-h2" id="b-h">Same-inception paper benchmarks</h2><p class="s10-sub">$10,000 of simulated cash each, whole shares bought at the account’s first fill-session open (+10 bps), dividends to cash.</p><div id="s10-bench"></div></section>
<div class="s10-grid2"><section class="s10-sec" aria-labelledby="i-h" id="s10-intra-sec"><h2 class="s10-h2" id="i-h">Today · persisted 5-minute marks</h2><div id="s10-intra"></div></section>
<section class="s10-sec" aria-labelledby="e-h" id="s10-eod-sec"><h2 class="s10-h2" id="e-h">Daily closes since inception</h2><div id="s10-eod"></div></section></div>`
          : `<section class="s10-term" aria-labelledby="acct-h"><div class="s10-term-head"><h2 id="acct-h">PBE PAPER ACCOUNT · STARTING $10,000 · SIMULATED</h2><span id="s10-sess">${sessionHTML}</span></div>${forwardStatusLine(L.proof).replace('s10-statusline', 's10-term-foot')}</section>`}
<section class="s10-sec s10-hypo" aria-labelledby="c-h"><span class="s10-tag s10-tag-bt">HISTORICAL_REPLAY · HYPOTHETICAL CONTINUATION</span><h2 class="s10-h2" id="c-h" style="margin-top:10px">${esc(d.continuation?.label || 'Backtested Holdings · hypothetical continuation')}</h2>
<p class="s10-sub">The backtest’s final holdings (as of the ${esc(fmtDate(d.continuation?.asOf))} close) marked at the same live quotes. This is not the paper account and is never added to its totals.</p><div id="s10-cont"></div></section>
<p class="s10-note">Quotes: ${esc(d.quoteSource || '')}. Cached up to ${fmtInt(d.quoteCacheSeconds)} s. This page refreshes every 20 s while the regular session is open and this tab is visible, every 2 min otherwise, and pauses while hidden.</p>`;
      }
      if (f) { renderHero(d, f, sessionHTML); renderHoldings(f); renderBench(d, f); renderIntra(f); renderEod(f); }
      else { const s = document.getElementById('s10-sess'); if (s) s.innerHTML = sessionHTML; }
      renderCont(d);
    }
    function renderHero(d, f, sessionHTML) {
      const nv = C.navView(f);
      const since = C.pnl(nv.cents, f.startingCents || START_CENTS);
      const today = f.priorClose ? C.pnl(nv.cents, f.priorClose.nav_cents) : { cents: null, pct: null };
      const inv = C.investedPct(nv.cents, f.cashCents);
      const win = C.windowLabel(f.fillSessions, f.windowSessions);
      const navSmall = nv.partial
        ? `<span class="s10-partial">PARTIAL · ${nv.freshN} of ${nv.totalN} prices fresh</span><br>${nv.basis === 'eod' ? `Showing the last end-of-day NAV (${esc(fmtDate(nv.asOf))} close) as the authoritative value.` : 'No end-of-day NAV recorded yet.'}${Number.isFinite(f.nav?.cents) ? ` Live partial estimate ${fmtUSD(f.nav.cents)}.` : ''}`
        : `${nv.totalN ? `All ${nv.totalN} held prices fresh` : 'All cash — no positions'} · ${esc(etDateTime(d.now))}`;
      const awaiting = !(f.positions || []).length;
      document.getElementById('s10-hero').innerHTML = `<div class="s10-term-head"><div><span class="s10-over">FORWARD_PAPER · ${esc(f.account || 'paper account')} · not a brokerage account</span><h2 id="acct-h">PBE PAPER ACCOUNT · STARTING $10,000 · SIMULATED</h2></div>${sessionHTML}</div>
<div class="s10-kpis">${kpi('Net asset value (simulated)', fmtUSD(nv.cents), navSmall, 's10-kpi-xl')}
${kpi(`Since inception · ${esc(fmtDate(f.inception))}`, money(since.cents), `${pct(since.pct, { dp: 2 })} vs $10,000 start`)}
${kpi('Today', today.cents == null ? '—' : money(today.cents), f.priorClose ? `${pct(today.pct, { dp: 2 })} vs ${esc(fmtDate(f.priorClose.d))} close ${fmtUSD(f.priorClose.nav_cents)}` : 'no prior close recorded yet')}
${kpi('Invested', inv == null ? '—' : fmtPct(inv, { sign: false }), `${fmtUSD(f.cashCents)} available cash`)}</div>
${awaiting ? '<p class="s10-term-foot"><b>AWAITING ENTRY.</b> No positions yet. The manager buys a top-10 name only when it shows a qualifying setup (a ≥ 3% dip from its 10-day high, or 5 straight closes in the top 10) in an uptrend and a risk-on regime. There is no forced buy.</p>' : ''}
<p class="s10-term-foot">${win ? `<b>${esc(win)}</b> · ` : ''}${fmtInt(f.fillSessions)} fill sessions · realized ${fmtUSD(f.realizedCents, { sign: true })} · dividends ${fmtUSD(f.dividendsCents)} · slippage paid ${fmtUSD(f.slippageCents)} · ledger #${fmtInt(f.ledgerSeq)} head <span title="${esc(f.ledgerHeadHash || '')}">${esc(short(f.ledgerHeadHash))}</span> · state as of ${esc(fmtDate(f.stateAsOf))}</p>`;
    }
    function holdingRow(p, nav) {
      const x = C.positionRow(p, nav);
      return `<tr data-sym="${esc(p.symbol)}">${symCell(p.symbol, p.name)}<td class="num">${fmtQty(p.qty)}</td><td class="num">${fmtPrice(p.avgCost)}</td><td class="num">${fmtPrice(p.price)}${p.fresh ? '' : ' <span class="s10-chip stale">STALE</span>'}</td><td class="num">${p.quoteTime ? `${rel(p.quoteTime)}<br><small>${esc(etTime(p.quoteTime))}</small>` : '—'}</td><td class="num">${pct(x.dayPct, { dp: 2 })}<br><small>${x.dayCents == null ? '' : money(x.dayCents)}</small></td><td class="num">${fmtUSD(x.value)}</td><td class="num">${money(x.unrealCents)}</td><td class="num">${pct(x.unrealPct, { dp: 2 })}</td><td class="num">${fmtPct(x.weight, { sign: false })}</td></tr>`;
    }
    function renderHoldings(f) {
      const box = document.getElementById('s10-holdings');
      const nv = C.navView(f).cents;
      const pos = f.positions || [];
      const syms = pos.map((p) => p.symbol).join(',');
      if (!pos.length) { box.innerHTML = '<p class="s10-statusline"><b>NO POSITIONS</b> The paper account is entirely in cash.</p>'; L.quotes.clear(); }
      else if (box.dataset.syms !== syms || !box.querySelector('tbody')) {
        box.dataset.syms = syms;
        box.innerHTML = tbl('Paper positions', ['Symbol', 'r:Shares', 'r:Avg cost', 'r:Price', 'r:Quote time', 'r:Day move', 'r:Market value', 'r:Unrealized', 'r:Unreal. %', 'r:Weight'], pos.map((p) => holdingRow(p, nv)), { cap2: 'Unrealized = market value − cost. Day move vs the previous close.' });
        L.quotes = new Map(pos.map((p) => [p.symbol, p.quoteTime ?? null]));
      } else {
        for (const s of C.changedQuotes(L.quotes, pos)) {
          const p = pos.find((q) => q.symbol === s); const tr = box.querySelector(`tr[data-sym="${CSS.escape(s)}"]`);
          if (tr && p) { tr.outerHTML = holdingRow(p, nv); L.quotes.set(s, p.quoteTime ?? null); }
        }
      }
      const pend = f.pending || [];
      document.getElementById('s10-pending').innerHTML = pend.length ? `<h3 class="s10-sec-h3" style="margin:16px 0 8px;font-size:15px">Orders queued for the next open</h3>${tbl('Pending paper orders', ['Side', 'Symbol', 'r:Size', 'Decided', 'Reason'], pend.map((o) => `<tr><td><span class="s10-chip queued">${esc(o.side)} · next open</span></td>${symCell(o.symbol)}<td class="num">${o.side === 'BUY' ? `≈ ${fmtUSD(o.targetCents)}` : `${fmtQty(o.qty)} sh`}</td><td class="num">${esc(fmtDate(o.d))}</td><td class="wrap">${esc(o.reason || '')}</td></tr>`))}` : '';
    }
    function renderBench(d, f) {
      const last = f.lastEod?.benchmarks || {};
      document.getElementById('s10-bench').innerHTML = `<div class="s10-kpis">${['SPY', 'QQQ'].map((k) => {
        const b = f.benchmarks?.[k];
        const live = Number.isFinite(b?.navCents);
        const v = live ? b.navCents : last[k];
        const p = C.pnl(v, START_CENTS);
        const q = d.benchmarksQuotes?.[k];
        return kpi(`${k} paper benchmark`, fmtUSD(v), `${money(p.cents)} · ${pct(p.pct, { dp: 2 })} since inception${live ? '' : (Number.isFinite(v) ? ` · last close ${esc(fmtDate(f.lastEod?.d))}` : '')}${q ? `<br>${k} ${fmtPrice(q.price)} · ${rel(q.quoteTime)}` : ''}`);
      }).join('')}${(() => { const nv = C.navView(f); const p = C.pnl(nv.cents, START_CENTS); return kpi('Signal 10 paper account', fmtUSD(nv.cents), `${money(p.cents)} · ${pct(p.pct, { dp: 2 })} since inception${nv.partial ? ' · last close' : ''}`); })()}</div>`;
    }
    function renderIntra(f) {
      const rows = f.intraday || [];
      const sig = `${rows.length}:${rows.at(-1)?.observed_at || ''}`;
      if (sig === L.intraSig) return; L.intraSig = sig;
      const box = document.getElementById('s10-intra');
      if (rows.length < 2) { box.innerHTML = `<p class="s10-statusline"><b>${rows.length} MARK${rows.length === 1 ? '' : 'S'} TODAY</b> Marks are persisted every 5 minutes from 09:30 to 16:05 ET on trading days; the chart draws once two exist.</p>`; return; }
      const xs = rows.map((r) => Date.parse(r.observed_at));
      const series = [
        { key: 'acct', label: 'Paper account', values: rows.map((r) => r.nav_cents ?? null) },
        { key: 'spy', label: 'SPY paper', values: rows.map((r) => r.benchmarks?.SPY ?? null) },
        { key: 'qqq', label: 'QQQ paper', values: rows.map((r) => r.benchmarks?.QQQ ?? null) },
      ];
      const gaps = rows.filter((r) => r.nav_cents == null).length;
      box.innerHTML = '<div data-c></div><p class="s10-readout" aria-live="polite"></p>';
      const host = box.querySelector('[data-c]'); const readout = box.querySelector('.s10-readout');
      let ch;
      box.prepend(toggles(series, () => ch));
      ch = chart(host, { xs, series, yFmt: (v, ax, st) => (ax ? C.axisUSD(v, st) : fmtUSD(v)), tipX: (x) => etDateTime(new Date(x).toISOString()), xTicks: sampleTicks((x) => etTime(new Date(x).toISOString())), baseline: START_CENTS, page: 6,
        ariaLabel: `Intraday persisted marks today: ${rows.length} marks from ${etTime(rows[0].observed_at)} to ${etTime(rows.at(-1).observed_at)}; paper account last ${fmtUSD(series[0].values.filter(Number.isFinite).at(-1))}. Use arrow keys to inspect.`, readout });
      box.insertAdjacentHTML('beforeend', `<p class="s10-note">Only stored marks are drawn, connected by straight lines; the line breaks where a mark had incomplete prices${gaps ? ` (${gaps} today)` : ''}. Dashed line: $10,000 start.</p>`);
    }
    function renderEod(f) {
      const rows = f.eodHistory || [];
      const sig = `${rows.length}:${rows.at(-1)?.d || ''}`;
      if (sig === L.eodSig) return; L.eodSig = sig;
      const box = document.getElementById('s10-eod');
      if (rows.length < 2) { box.innerHTML = `<p class="s10-statusline"><b>${rows.length} CLOSE${rows.length === 1 ? '' : 'S'} RECORDED</b> ${rows.length ? `${esc(fmtDate(rows[0].d))}: ${fmtUSD(rows[0].nav_cents)}. ` : ''}The daily chart draws from the second end-of-day mark.</p>`; return; }
      const xs = rows.map((r) => C.dayMs(r.d));
      const series = [
        { key: 'acct', label: 'Paper account', values: rows.map((r) => r.nav_cents) },
        { key: 'spy', label: 'SPY paper', values: rows.map((r) => r.benchmarks?.SPY ?? null) },
        { key: 'qqq', label: 'QQQ paper', values: rows.map((r) => r.benchmarks?.QQQ ?? null) },
      ];
      box.innerHTML = '<div data-c></div><p class="s10-readout" aria-live="polite"></p>';
      let ch;
      box.prepend(toggles(series, () => ch));
      ch = chart(box.querySelector('[data-c]'), { xs, series, yFmt: (v, ax, st) => (ax ? C.axisUSD(v, st) : fmtUSD(v)), tipX: (x) => fmtDate(isoDay(x)), xTicks: sampleTicks(shortDay), baseline: START_CENTS, page: 5,
        ariaLabel: `Daily end-of-day NAV since inception, ${rows.length} closes from ${fmtDate(rows[0].d)} to ${fmtDate(rows.at(-1).d)}: paper account ${fmtUSD(rows.at(-1).nav_cents)}. Use arrow keys to inspect.`, readout: box.querySelector('.s10-readout') });
    }
    function contRow(h) {
      const v = Number.isFinite(h.price) ? Math.round(h.qty * h.price * 100) : h.valueCents;
      const chg = Number.isFinite(h.price) && h.close ? h.price / h.close - 1 : null;
      return `<tr data-sym="${esc(h.symbol)}">${symCell(h.symbol, h.name)}<td class="num">${fmtQty(h.qty)}</td><td class="num">${esc(fmtDate(h.entryDate))}</td><td class="num">${fmtPrice(h.close)}<br><small>${esc(fmtDate(h.closeDate))}</small></td><td class="num">${fmtPrice(h.price)}<br><small>${h.quoteTime ? rel(h.quoteTime) : 'no quote'}</small></td><td class="num">${pct(chg, { dp: 2 })}</td><td class="num">${fmtUSD(v)}</td><td class="num">${money(v - h.costCents)}</td></tr>`;
    }
    function renderCont(d) {
      const c = d.continuation; const box = document.getElementById('s10-cont');
      if (!c || !box) return;
      const hs = c.holdings || [];
      const total = (c.cashCents || 0) + hs.reduce((s, h) => s + (Number.isFinite(h.price) ? Math.round(h.qty * h.price * 100) : h.valueCents || 0), 0);
      const atClose = (c.cashCents || 0) + hs.reduce((s, h) => s + (h.valueCents || 0), 0);
      const syms = hs.map((h) => h.symbol).join(',');
      if (box.dataset.syms !== syms || !box.querySelector('tbody')) {
        box.dataset.syms = syms;
        box.innerHTML = `<div data-k></div>${tbl('Backtest final holdings at live quotes (hypothetical)', ['Symbol', 'r:Shares', 'r:Entered', 'r:Backtest close', 'r:Live price', 'r:Since close', 'r:Value', 'r:Unrealized'], hs.map(contRow), { cap2: 'HISTORICAL_REPLAY origin. Never added to the paper account.' })}`;
        L.cq = new Map(hs.map((h) => [h.symbol, h.quoteTime ?? null]));
      } else {
        for (const s of C.changedQuotes(L.cq, hs)) { const h = hs.find((q) => q.symbol === s); const tr = box.querySelector(`tr[data-sym="${CSS.escape(s)}"]`); if (tr && h) { tr.outerHTML = contRow(h); L.cq.set(s, h.quoteTime ?? null); } }
      }
      box.querySelector('[data-k]').innerHTML = `<div class="s10-kpis" style="margin-bottom:12px">${kpi('Hypothetical value at live quotes', fmtUSD(total), `incl. ${fmtUSD(c.cashCents)} backtest cash`)}${kpi(`At the ${esc(fmtDate(c.asOf))} backtest close`, fmtUSD(atClose))}${kpi('Change since that close', money(total - atClose), pct(C.pnl(total, atClose).pct, { dp: 2 }))}</div>`;
    }

    // =====================================================================================================
    // HISTORICAL BACKTEST
    // =====================================================================================================
    async function backtest() {
      const r = await api('backtest');
      if (handleGate(r, 'the Signal 10 backtest', backtest)) return;
      const b = r.data; app.dataset.state = 'ready';
      const s = b.strategy, SPY = b.benchmarks?.SPY, QQQ = b.benchmarks?.QQQ, cmp = b.comparator;
      const v = C.verdict(s, { SPY, QQQ });
      const under = v.filter((x) => x.under).map((x) => x.key);
      const maxEnd = Math.max(s.endCents, SPY?.endCents || 0, QQQ?.endCents || 0, cmp?.endCents || 0);
      const vbar = (label, cents, key) => `<div class="s10-vbar"><span>${label}</span><span class="trk"><i class="sw-${key}" style="width:${((cents / maxEnd) * 100).toFixed(1)}%"></i></span><b>${fmtUSD(cents, { dp: 0 })}</b></div>`;
      const grid = C.monthlyGrid(b.monthly);
      const negYears = (b.annual || []).filter((a) => a.returnPct < 0).length;
      const F = b.nav.fields; const ix = (k) => F.indexOf(k);
      const rows = b.nav.rows; const xs = rows.map((x) => C.dayMs(x[ix('d')]));
      const col = (k) => rows.map((x) => x[ix(k)]);
      const [navS, spyS, qqqS, cmpS] = [col('nav'), col('spy'), col('qqq'), col('cmp')];
      const dd = { s: C.drawdowns(navS), spy: C.drawdowns(spyS), qqq: C.drawdowns(qqqS) };
      const yearEnd = []; for (let i = 0; i < rows.length; i++) if (i === rows.length - 1 || rows[i + 1][0].slice(0, 4) !== rows[i][0].slice(0, 4)) yearEnd.push(i);
      app.innerHTML = `<section class="s10-sec s10-hypo" aria-labelledby="v-h">
<span class="s10-tag s10-tag-bt">${esc(b.origin)} · ${esc(b.label)}</span>
<h2 class="s10-h2" id="v-h" style="margin-top:10px">The result, plainly</h2>
<div class="s10-verdict"><p>$10,000 of hypothetical capital from ${esc(fmtDate(s.start))} grew to <strong>${fmtUSD(s.endCents, { dp: 0 })}</strong> (${fmtPct(s.totalReturn)}) by ${esc(fmtDate(s.end))}. Over the same period SPY grew to ${fmtUSD(SPY?.endCents, { dp: 0 })} and QQQ to ${fmtUSD(QQQ?.endCents, { dp: 0 })}. ${under.length ? `<strong>The strategy underperformed ${under.join(' and ')}</strong>${under.length < v.length ? `, and beat ${v.filter((x) => !x.under).map((x) => x.key).join(' and ')}` : ''}.` : 'The strategy ended above both benchmarks.'} It lost money in ${grid.negatives} of ${grid.total} months and in ${negYears} of ${(b.annual || []).length} calendar years.</p>
<div class="s10-vbars" role="img" aria-label="Ending values: strategy ${fmtUSD(s.endCents, { dp: 0 })}, SPY ${fmtUSD(SPY?.endCents, { dp: 0 })}, QQQ ${fmtUSD(QQQ?.endCents, { dp: 0 })}, comparator ${fmtUSD(cmp?.endCents, { dp: 0 })}">${vbar('Signal 10', s.endCents, 'strategy')}${vbar('SPY', SPY?.endCents, 'spy')}${vbar('QQQ', QQQ?.endCents, 'qqq')}${cmp ? vbar('Comparator', cmp.endCents, 'cmp') : ''}</div></div>
<p class="s10-note">${esc(b.disclosure)} Model ${esc(b.model)} · policy ${esc(b.policy)} · data cutoff ${esc(b.data_cutoff)}. Residual survivorship bias: about 130 delisted or acquired former members have no source history (see coverage below).</p></section>

<section class="s10-sec" aria-labelledby="k-h"><h2 class="s10-h2" id="k-h">Key numbers</h2>
<div class="s10-kpis">${kpi('End value', fmtUSD(s.endCents))}${kpi('Gain', money(s.gainCents))}${kpi('Total return', pct(s.totalReturn))}${kpi('CAGR', pct(s.cagr, { dp: 2 }), `${s.years} years`)}
${kpi('Max drawdown', pct(s.maxDrawdown), `${esc(fmtDate(s.maxDrawdownPeak))} → ${esc(fmtDate(s.maxDrawdownTrough))}`)}${kpi('Volatility', fmtPct(s.volAnnual, { sign: false }), 'annualized')}${kpi('Sharpe (0% rate)', Number.isFinite(s.sharpe0) ? s.sharpe0.toFixed(2) : '—', `SPY ${SPY?.sharpe0?.toFixed(2) ?? '—'} · QQQ ${QQQ?.sharpe0?.toFixed(2) ?? '—'}`)}
${kpi('Avg invested', fmtPct(s.avgInvestedPct, { sign: false }))}${kpi('Turnover / yr', `${Number.isFinite(s.turnoverPerYear) ? s.turnoverPerYear.toFixed(2) : '—'}×`, `${fmtInt(s.fills)} fills`)}${kpi('Slippage paid', fmtUSD(s.slippageCents), '10 bps per side')}${kpi('Dividends', fmtUSD(s.dividendsCents), 'credited on ex-date')}${kpi('Realized / unrealized', `${fmtUSD(s.realizedCents, { dp: 0 })}`, `unrealized ${fmtUSD(s.unrealizedCents, { dp: 0 })}`)}</div></section>

<section class="s10-sec" aria-labelledby="g-h"><h2 class="s10-h2" id="g-h">Growth of $10,000</h2><p class="s10-sub">Daily NAV from the backtest rows only, joined by straight lines. Hover, tap, or focus the chart and use ← → (PageUp/PageDown = one month, Home/End).</p><div id="c-growth"></div></section>
<section class="s10-sec" aria-labelledby="d-h"><h2 class="s10-h2" id="d-h">Drawdown from previous peak</h2><p class="s10-sub">Deepest: Signal 10 ${fmtPct(dd.s.max)} (${esc(fmtDate(rows[dd.s.peak]?.[0]))} → ${esc(fmtDate(rows[dd.s.trough]?.[0]))}) · SPY ${fmtPct(dd.spy.max)} · QQQ ${fmtPct(dd.qqq.max)}.</p><div id="c-dd"></div></section>

<section class="s10-sec" aria-labelledby="a-h"><h2 class="s10-h2" id="a-h">Calendar years</h2>
${tbl('Annual returns', ['Year', 'r:Signal 10', 'r:SPY', 'r:QQQ', 'r:Comparator', 'r:vs SPY', 'r:Start → end'], (b.annual || []).map((a) => `<tr><th scope="row" class="s10-mono">${esc(a.period)}${a.endDate && !a.endDate.endsWith('12-31') && !a.endDate.endsWith('12-30') && !a.endDate.endsWith('12-29') ? ' <small>(YTD)</small>' : ''}</th><td class="num">${pct(a.returnPct)}</td><td class="num">${pct(a.spy)}</td><td class="num">${pct(a.qqq)}</td><td class="num">${pct(a.cmp)}</td><td class="num">${pct(a.returnPct - a.spy, { dp: 1 })}</td><td class="num">${fmtUSD(a.startCents, { dp: 0 })} → ${fmtUSD(a.endCents, { dp: 0 })}</td></tr>`), { cap2: '“vs SPY” is the simple difference in percentage points. Negative values are shown in red.' })}</section>

<section class="s10-sec" aria-labelledby="m-h"><h2 class="s10-h2" id="m-h">Every month</h2><p class="s10-sub"><b>${grid.negatives} of ${grid.total} months were negative.</b> Worst: ${esc(grid.worst?.period || '—')} ${fmtPct(grid.worst?.returnPct)} (${fmtUSD(grid.worst?.gainCents, { sign: true })}). Best: ${esc(grid.best?.period || '—')} ${fmtPct(grid.best?.returnPct)}.</p>
${tbl('Monthly returns, Signal 10 backtest', ['Year', ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m) => `r:${m}`), 'r:Year'], grid.years.map((y) => {
        const a = (b.annual || []).find((x) => x.period === y.year);
        return `<tr><th scope="row" class="s10-mono">${y.year}</th>${y.months.map((m) => (m ? `<td class="${zeroTxt(fmtPct(m.returnPct)) ? 'z' : `h${C.heat(m.returnPct)} ${m.returnPct < 0 ? 'n' : 'p'}`}" title="${esc(m.period)}: ${fmtPct(m.returnPct, { dp: 2 })} · ${fmtUSD(m.gainCents, { sign: true })} · SPY ${fmtPct(m.spy)} · QQQ ${fmtPct(m.qqq)}">${fmtPct(m.returnPct)}</td>` : '<td class="none">·</td>')).join('')}<td class="yr ${a && a.returnPct < 0 ? 'n' : 'p'}">${a ? fmtPct(a.returnPct) : '—'}</td></tr>`;
      }), { cls: 's10-heat', cap2: 'Tint shows size; the value is always printed. Red = loss.' })}</section>

<div id="s10-variants"></div>

<div class="s10-grid2">
<section class="s10-sec" aria-labelledby="co-h"><h2 class="s10-h2" id="co-h">Start-date cohorts</h2><p class="s10-sub">The same rules started at each new year, run to ${esc(fmtDate(s.end))}. A result that depends on the start date is fragile.</p>
${tbl('Inception cohorts', ['Start', 'r:Years', 'r:Signal 10', 'r:CAGR', 'r:Max DD', 'r:SPY', 'r:QQQ'], (b.cohorts || []).map((c) => `<tr><th scope="row" class="s10-mono">${esc(c.inception)}</th><td class="num">${c.strategy?.years ?? '—'}</td><td class="num">${pct(c.strategy?.totalReturn)}</td><td class="num">${pct(c.strategy?.cagr)}</td><td class="num">${pct(c.strategy?.maxDrawdown)}</td><td class="num">${pct(c.spy?.totalReturn)}</td><td class="num">${pct(c.qqq?.totalReturn)}</td></tr>`))}</section>
<section class="s10-sec" aria-labelledby="se-h"><h2 class="s10-h2" id="se-h">Cost sensitivity</h2><p class="s10-sub">Same rules with different slippage per side. The official record uses 10 bps.</p>
${tbl('Slippage sensitivity', ['r:Slippage', 'r:End value', 'r:Total', 'r:CAGR', 'r:Max DD'], (b.sensitivity || []).map((x) => `<tr${x.slippageBps === 10 ? ' class="is-total"' : ''}><th scope="row" class="s10-mono">${x.slippageBps} bps${x.slippageBps === 10 ? ' · official' : ''}</th><td class="num">${fmtUSD(x.endCents, { dp: 0 })}</td><td class="num">${pct(x.totalReturn)}</td><td class="num">${pct(x.cagr, { dp: 2 })}</td><td class="num">${pct(x.maxDrawdown)}</td></tr>`))}
${cmp ? `<p class="s10-note"><b>Comparator:</b> ${esc(cmp.label)} — ended at ${fmtUSD(cmp.endCents, { dp: 0 })} (${fmtPct(cmp.totalReturn)}, max drawdown ${fmtPct(cmp.maxDrawdown)}).</p>` : ''}</section>
</div>

<div class="s10-grid2">
<section class="s10-sec" aria-labelledby="tc-h"><h2 class="s10-h2" id="tc-h">Biggest contributors</h2>${contribTbl('Top 15 contributors', b.contributions?.top)}</section>
<section class="s10-sec" aria-labelledby="bc-h"><h2 class="s10-h2" id="bc-h">Biggest detractors</h2>${contribTbl('Bottom 15 contributors', b.contributions?.bottom)}<p class="s10-note">${fmtInt(b.contributions?.count)} symbols traded in total.</p></section>
</div>

<section class="s10-sec" aria-labelledby="fh-h"><h2 class="s10-h2" id="fh-h">Final backtest holdings · ${esc(fmtDate(b.data_cutoff))} close</h2>
${tbl('Holdings at the end of the backtest', ['Symbol', 'r:Shares', 'r:Entered', 'r:Cost', 'r:Close', 'r:Value', 'r:Unrealized'], (b.final_holdings || []).map((h) => `<tr>${symCell(h.symbol, h.name)}<td class="num">${fmtQty(h.qty)}</td><td class="num">${esc(fmtDate(h.entryDate))}</td><td class="num">${fmtUSD(h.costCents)}</td><td class="num">${fmtPrice(h.close)}</td><td class="num">${fmtUSD(h.valueCents)}</td><td class="num">${money(h.valueCents - h.costCents)}</td></tr>`).concat([`<tr class="is-total"><th scope="row">Cash</th><td></td><td></td><td></td><td></td><td class="num">${fmtUSD(s.cashCents)}</td><td></td></tr>`]), { cap2: 'Hypothetical. The Live page marks these at current quotes, separately from the paper account.' })}
${(b.final_pending || []).length ? `<p class="s10-note">Order left pending at the cutoff: ${b.final_pending.map((o) => `${esc(o.side)} ${esc(o.symbol)} — ${esc(o.reason)}`).join('; ')}.</p>` : ''}</section>

<section class="s10-sec" aria-labelledby="cv-h"><h2 class="s10-h2" id="cv-h">Coverage and survivorship bias</h2>
<p class="s10-sub">Share of point-in-time S&amp;P 500 member-days with a price series at the source. ${fmtInt(b.coverage?.symbols_with_data)} of ${fmtInt(b.coverage?.universe_tickers)} member tickers have data. Names without history could never be held — mostly delisted or acquired companies (e.g. SIVB, FRC, ATVI, TWTR). This bias usually flatters a backtest; its size here has not been measured.</p>
<div class="s10-grid2">${tbl('Coverage by year', ['Year', 'r:Member-days', 'r:Priced', 'r:Coverage'], Object.entries(b.coverage?.by_year || {}).filter(([y]) => y >= (s.start || '').slice(0, 4)).map(([y, c]) => `<tr><th scope="row" class="s10-mono">${esc(y)}</th><td class="num">${fmtInt(c.member_days)}</td><td class="num">${fmtInt(c.covered)}</td><td class="num">${c.pct}%</td></tr>`))}
${tbl('Largest uncovered members', ['Ticker', 'r:Member-days missing'], (b.coverage?.uncovered_top || []).slice(0, 12).map((u) => `<tr><th scope="row" class="s10-mono">${esc(u.ticker)}</th><td class="num">${fmtInt(u.member_days)}</td></tr>`), { cap2: `Top 12 of ${fmtInt((b.coverage?.uncovered_top || []).length)} listed by the build.` })}</div></section>

<section class="s10-sec" aria-labelledby="hs-h"><h2 class="s10-h2" id="hs-h">Reproducibility</h2>
<ul class="s10-meta" style="display:grid;gap:6px"><li>Dataset SHA-256 <span class="s10-hash">${esc(b.dataset_sha256)}</span></li><li>Ledger SHA-256 <span class="s10-hash">${esc(b.ledger_sha256)}</span></li><li>NAV SHA-256 <span class="s10-hash">${esc(b.nav_sha256)}</span></li>
<li>Reconciliation: engine NAV ${fmtUSD(b.reconciliation?.engineNavCents)} · ledger replay NAV ${fmtUSD(b.reconciliation?.ledgerReplayNavCents)} · cash ${b.reconciliation?.cashMatches ? 'matches' : 'MISMATCH'} · NAV ${b.reconciliation?.navMatches ? 'matches' : 'MISMATCH'} · quantities ${b.reconciliation?.qtyMatches ? 'match' : 'MISMATCH'}</li><li>Generated ${esc(etDateTime(b.generated_at))} · schema ${esc(b.schema)}</li></ul>
<p class="s10-note">Every fill, dividend and split is in the <a href="/markets/signal-10/ledger/">trade ledger</a>. Rules: <a href="/markets/signal-10/methodology/">methodology</a>.</p></section>`;

      // research variants (post-hoc)
      const rv = b.research_variants;
      if (rv?.variants?.length) {
        const vs = [...rv.variants].sort((a, c) => (/official/i.test(c.name) ? 1 : 0) - (/official/i.test(a.name) ? 1 : 0));
        document.getElementById('s10-variants').innerHTML = `<section class="s10-sec s10-hypo" aria-labelledby="rv-h"><span class="s10-tag s10-tag-bt">${esc(rv.label)}</span>
<h2 class="s10-h2" id="rv-h" style="margin-top:10px">Research notes: variants we tested after seeing the result</h2>
<p class="s10-sub">None of these replaces the pre-registered v1.0.0 record${QQQ ? (vs.every((x) => x.endCents < QQQ.endCents) ? `, and none beat QQQ (${fmtUSD(QQQ.endCents, { dp: 0 })}) over this period` : `; ${vs.filter((x) => x.endCents >= QQQ.endCents).map((x) => esc(x.name)).join(', ')} ended above QQQ (${fmtUSD(QQQ.endCents, { dp: 0 })}) in-sample`) : ''}. They were defined after the result, on the same history, so they are not evidence of future performance.</p>
${tbl('Post-hoc research variants, same period', ['Variant', 'r:End value', 'r:Total', 'r:CAGR', 'r:Max DD', 'r:Vol', 'r:Sharpe', 'r:Fills'], vs.map((x) => `<tr${/official/i.test(x.name) ? ' class="is-total"' : ''}><th scope="row"><span class="s10-sym">${esc(x.name)}</span><span class="s10-name" style="white-space:normal;max-width:340px">${esc(x.desc || '')}</span></th><td class="num">${fmtUSD(x.endCents, { dp: 0 })}</td><td class="num">${pct(x.totalReturn)}</td><td class="num">${pct(x.cagr, { dp: 2 })}</td><td class="num">${pct(x.maxDrawdown)}</td><td class="num">${fmtPct(x.volAnnual, { sign: false })}</td><td class="num">${Number.isFinite(x.sharpe0) ? x.sharpe0.toFixed(2) : '—'}</td><td class="num">${fmtInt(x.fills)}</td></tr>`), { cap2: `${esc(rv.start || '')} → ${esc(rv.data_cutoff || '')}. Official v1.0.0 first.` })}</section>`;
      }

      // growth chart
      const gs = [
        { key: 'strategy', label: 'Signal 10', values: navS },
        { key: 'spy', label: 'SPY', values: spyS },
        { key: 'qqq', label: 'QQQ', values: qqqS },
        { key: 'cmp', label: 'Comparator', values: cmpS },
      ];
      const gBox = document.getElementById('c-growth');
      gBox.innerHTML = '<div data-c></div><p class="s10-readout" aria-live="polite"></p>';
      let gch; gBox.prepend(toggles(gs, () => gch, { log: true }));
      gch = chart(gBox.querySelector('[data-c]'), { xs, series: gs, yFmt: (v, ax, st) => (ax ? C.axisUSD(v, st) : fmtUSD(v, { dp: 0 })), tipX: (x) => fmtDate(isoDay(x)), xTicks: yearTicks, baseline: START_CENTS,
        ariaLabel: `Growth of $10,000 from ${fmtDate(s.start)} to ${fmtDate(s.end)}: Signal 10 ended at ${fmtUSD(s.endCents, { dp: 0 })}, SPY ${fmtUSD(SPY?.endCents, { dp: 0 })}, QQQ ${fmtUSD(QQQ?.endCents, { dp: 0 })}, comparator ${fmtUSD(cmp?.endCents, { dp: 0 })}. Year-end values are in the table that follows.`, readout: gBox.querySelector('.s10-readout') });
      gBox.insertAdjacentHTML('beforeend', `<table class="sr-only"><caption>Year-end value of $10,000 (hypothetical)</caption><thead><tr><th scope="col">Date</th>${gs.map((g) => `<th scope="col">${g.label}</th>`).join('')}</tr></thead><tbody>${yearEnd.map((i) => `<tr><th scope="row">${rows[i][0]}</th>${gs.map((g) => `<td>${fmtUSD(g.values[i], { dp: 0 })}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="s10-note">Comparator = ${esc(cmp?.label || '')}. Dashed horizontal line: the $10,000 start.</p>`);
      // drawdown chart
      const ds = [
        { key: 'dd', cls: 'dd', label: 'Signal 10', values: dd.s.dd, area: true },
        { key: 'spy', label: 'SPY', values: dd.spy.dd },
        { key: 'qqq', label: 'QQQ', values: dd.qqq.dd, hidden: true },
      ];
      const dBox = document.getElementById('c-dd');
      dBox.innerHTML = '<div data-c></div><p class="s10-readout" aria-live="polite"></p>';
      let dch; dBox.prepend(toggles(ds, () => dch));
      dch = chart(dBox.querySelector('[data-c]'), { xs, series: ds, hidden: ['qqq'], yFmt: (v, ax) => fmtPct(v, { dp: ax ? 0 : 1 }), tipX: (x) => fmtDate(isoDay(x)), xTicks: yearTicks, height: (W) => (W < 560 ? 180 : 230),
        ariaLabel: `Drawdown from previous peak. Signal 10 deepest ${fmtPct(dd.s.max)} from ${fmtDate(rows[dd.s.peak]?.[0])} to ${fmtDate(rows[dd.s.trough]?.[0])}; SPY deepest ${fmtPct(dd.spy.max)}; QQQ deepest ${fmtPct(dd.qqq.max)}.`, readout: dBox.querySelector('.s10-readout') });
    }
    function contribTbl(caption, list) {
      return tbl(caption, ['Symbol', 'r:Total', 'r:Realized', 'r:Unrealized', 'r:Dividends', 'r:Buys/sells'], (list || []).map((c) => `<tr>${symCell(c.symbol, c.name)}<td class="num">${money(c.totalCents)}</td><td class="num">${money(c.realizedCents)}</td><td class="num">${money(c.unrealizedCents)}</td><td class="num">${fmtUSD(c.dividendsCents)}</td><td class="num">${c.buys}/${c.sells}</td></tr>`));
    }

    // =====================================================================================================
    // TRADE LEDGER
    // =====================================================================================================
    const LG = { origin: 'HISTORICAL_REPLAY', rows: [], type: '', sym: '', page: 1, data: null };
    async function ledger() {
      const q = new URLSearchParams(location.search);
      LG.origin = q.get('origin') === 'FORWARD_PAPER' ? 'FORWARD_PAPER' : 'HISTORICAL_REPLAY';
      LG.type = q.get('type') || ''; LG.sym = q.get('symbol') || ''; LG.page = Number(q.get('page')) || 1;
      const r = await api(`ledger?origin=${LG.origin}`);
      if (handleGate(r, 'the Signal 10 trade ledgers', ledger)) return;
      LG.data = r.data; LG.rows = (r.data.events || []).map(C.flattenEvent);
      app.dataset.state = 'ready';
      const fw = LG.origin === 'FORWARD_PAPER';
      const types = [...new Set(LG.rows.map((e) => e.type))].sort();
      const syms = [...new Set(LG.rows.map((e) => e.symbol).filter(Boolean))].sort();
      let status = '';
      if (fw && !LG.rows.length) status = forwardStatusLine(await proof());
      app.innerHTML = `<section class="s10-sec ${fw ? '' : 's10-hypo'}" aria-labelledby="l-h">
<div class="s10-switch" role="group" aria-label="Ledger origin"><a href="?origin=HISTORICAL_REPLAY"${fw ? '' : ' aria-current="page"'}>Backtest ledger</a><a href="?origin=FORWARD_PAPER"${fw ? ' aria-current="page"' : ''}>Forward paper ledger</a></div>
<p style="margin:12px 0 0"><span class="s10-tag ${fw ? 's10-tag-fw' : 's10-tag-bt'}">${fw ? 'FORWARD_PAPER · PBE PAPER ACCOUNT · SIMULATED' : 'HISTORICAL_REPLAY · BACKTEST · HYPOTHETICAL · RECONSTRUCTED HISTORY'}</span></p>
<h2 class="s10-h2" id="l-h" style="margin-top:10px">${fw ? 'Forward paper ledger' : 'Backtest ledger'}</h2>
<p class="s10-sub">${fw ? `Account ${esc(LG.data.account || '')}. Append-only and hash-chained: each event’s SHA-256 covers the previous event’s hash plus the event body. Every row is listed, including STATE account checkpoints, so the whole chain can be recomputed.` : `Every simulated fill, dividend, split and unfilled order from ${esc(fmtDate(LG.rows[0]?.d))} to ${esc(fmtDate(LG.rows.at(-1)?.d))}. Ledger SHA-256 <span class="s10-hash">${esc(LG.data.ledger_sha256 || '')}</span>.`}</p>
${status}
${LG.rows.length ? `<form class="s10-filters" id="lg-f" role="search" aria-label="Filter ledger"><label>Type<select name="type"><option value="">All types (${fmtInt(LG.rows.length)})</option>${types.map((t) => `<option value="${esc(t)}"${t === LG.type ? ' selected' : ''}>${esc(t)} (${fmtInt(LG.rows.filter((e) => e.type === t).length)})</option>`).join('')}</select></label>
<label>Symbol<input name="symbol" list="lg-syms" value="${esc(LG.sym)}" autocomplete="off" spellcheck="false" placeholder="e.g. MU" maxlength="12"></label><datalist id="lg-syms">${syms.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
<button type="submit" class="s10-btn">Apply</button><button type="button" class="s10-btn" data-reset>Reset</button></form>
<p class="s10-count" id="lg-count" role="status" aria-live="polite"></p><div id="lg-t"></div><nav class="s10-pager" id="lg-p" aria-label="Ledger pages"></nav>` : ''}
</section>`;
      const f = document.getElementById('lg-f');
      if (!f) return;
      f.addEventListener('submit', (ev) => { ev.preventDefault(); LG.type = f.type.value; LG.sym = f.symbol.value.trim().toUpperCase(); LG.page = 1; drawLedger(); });
      f.type.addEventListener('change', () => { LG.type = f.type.value; LG.page = 1; drawLedger(); });
      f.querySelector('[data-reset]').addEventListener('click', () => { f.type.value = ''; f.symbol.value = ''; LG.type = ''; LG.sym = ''; LG.page = 1; drawLedger(); });
      drawLedger();
    }
    function drawLedger() {
      const fw = LG.origin === 'FORWARD_PAPER';
      const all = C.filterEvents(LG.rows, { type: LG.type, symbol: LG.sym });
      const pg = C.paginate(all, LG.page, 100); LG.page = pg.page;
      const q = new URLSearchParams(); q.set('origin', LG.origin); if (LG.type) q.set('type', LG.type); if (LG.sym) q.set('symbol', LG.sym); if (pg.page > 1) q.set('page', pg.page);
      history.replaceState(null, '', `${location.pathname}?${q}`);
      document.getElementById('lg-count').textContent = all.length ? `Showing ${fmtInt(pg.from)}–${fmtInt(pg.to)} of ${fmtInt(all.length)} events${LG.type || LG.sym ? ' (filtered)' : ''}` : 'No events match this filter.';
      const head = ['r:Seq', 'Date', 'Type', 'Side', 'Symbol', 'r:Qty', 'r:Price', 'r:Amount', 'r:Realized', 'Detail'];
      if (fw) head.push('Hash');
      document.getElementById('lg-t').innerHTML = all.length ? tbl(fw ? 'Forward paper ledger events' : 'Backtest ledger events', head, pg.rows.map((e) => {
        const amt = e.notionalCents ?? e.cashCents ?? e.proceedsCents ?? e.navCents ?? null;
        const px = e.price ?? null;
        return `<tr><td class="num">${e.seq}</td><td class="num">${esc(e.d || '')}</td><td><span class="s10-chip">${esc(e.type)}</span></td><td>${esc(e.side || e.action || '')}</td><td class="s10-sym">${esc(e.symbol || e.benchmark || '')}</td><td class="num">${e.qty != null ? fmtQty(e.qty) : ''}</td><td class="num">${px != null ? `${fmtPrice(px)}${e.open != null ? `<br><small>open ${fmtPrice(e.open)}</small>` : ''}` : ''}</td><td class="num">${amt != null ? fmtUSD(amt) : ''}</td><td class="num">${e.realizedCents != null ? money(e.realizedCents) : ''}</td><td style="min-width:220px">${esc(C.eventDetail(e))}</td>${fw ? `<td><span class="s10-hash" title="hash ${esc(e.hash || '')}&#10;prev ${esc(e.prev_hash || '')}">${esc(short(e.hash))}</span><br><small class="s10-hash">prev ${esc(short(e.prev_hash))}</small></td>` : ''}</tr>`;
      }), { cap2: `Page ${pg.page} of ${pg.pages}. Prices are unadjusted; fills include 10 bps slippage.` }) : '';
      const p = document.getElementById('lg-p');
      if (pg.pages <= 1) { p.innerHTML = ''; return; }
      const nums = []; for (let n = 1; n <= pg.pages; n++) if (n === 1 || n === pg.pages || Math.abs(n - pg.page) <= 1) nums.push(n); else if (nums.at(-1) !== '…') nums.push('…');
      const btn = (n, label, cur, dis) => `<button type="button" class="s10-btn" data-p="${n}"${cur ? ' aria-current="page"' : ''}${dis ? ' disabled' : ''}${typeof label === 'number' ? ` aria-label="Page ${n}"` : ''}>${label}</button>`;
      p.innerHTML = btn(pg.page - 1, '‹ Prev', false, pg.page <= 1) + nums.map((n) => (n === '…' ? '<span aria-hidden="true">…</span>' : btn(n, n, n === pg.page))).join('') + btn(pg.page + 1, 'Next ›', false, pg.page >= pg.pages) + `<span>Page ${pg.page} of ${pg.pages}</span>`;
      p.querySelectorAll('[data-p]:not([disabled])').forEach((b) => b.addEventListener('click', () => { LG.page = Number(b.dataset.p); drawLedger(); document.getElementById('lg-count').scrollIntoView({ block: 'start' }); }));
    }

    // =====================================================================================================
    // METHODOLOGY (public)
    // =====================================================================================================
    async function methodology() {
      const box = document.getElementById('s10-proof');
      const p = await proof();
      if (!p) { box.innerHTML = '<p class="s10-statusline" role="status"><b>PROOF RECORD UNAVAILABLE</b> The public proof record could not be loaded just now. Retrying in 60 s.</p>'; setTimeout(methodology, 60000); return; }
      const bt = p.backtest || {}; const s = bt.strategy || {};
      const row = (k, x) => `<tr><th scope="row">${k}</th><td class="num">${fmtUSD(x?.endCents, { dp: 0 })}</td><td class="num">${pct(x?.totalReturn)}</td><td class="num">${pct(x?.cagr, { dp: 2 })}</td><td class="num">${pct(x?.maxDrawdown)}</td></tr>`;
      box.innerHTML = `<div class="s10-grid2"><div><span class="s10-tag s10-tag-bt">${esc(bt.origin || 'HISTORICAL_REPLAY')} · ${esc(bt.label || '')}</span>
<p class="s10-sub" style="margin-top:10px">$10,000 of hypothetical capital, ${esc(fmtDate(s.start))} to ${esc(fmtDate(s.end))}.</p>
${tbl('Backtest headline (public)', ['Series', 'r:End value', 'r:Total', 'r:CAGR', 'r:Max DD'], [row('Signal 10', s), row('SPY', bt.SPY), row('QQQ', bt.QQQ)])}
<p class="s10-note">${s.endCents < (bt.SPY?.endCents ?? -1) && s.endCents < (bt.QQQ?.endCents ?? -1) ? '<b>The backtest underperformed both SPY and QQQ.</b> ' : ''}Backtest results are reconstructed history with residual survivorship bias; see coverage below.</p></div>
<div><span class="s10-tag s10-tag-fw">FORWARD_PAPER</span><div style="margin-top:10px">${forwardStatusLine(p)}</div>
<ul class="s10-meta" style="display:grid;gap:6px;margin-top:12px"><li>Model <b>${esc(p.model)}</b> · policy <b>${esc(p.policy)}</b></li><li>Dataset SHA-256 <span class="s10-hash">${esc(bt.dataset_sha256 || '')}</span></li><li>Ledger SHA-256 <span class="s10-hash">${esc(bt.ledger_sha256 || '')}</span></li><li>NAV SHA-256 <span class="s10-hash">${esc(bt.nav_sha256 || '')}</span></li>${p.generated_at ? `<li>Record generated ${esc(etDateTime(p.generated_at))}</li>` : ''}</ul></div></div>
<p class="s10-statusline" style="margin-top:14px" role="note"><b>DISCLOSURE</b> ${esc(p.disclosure || 'HYPOTHETICAL / SIMULATED PAPER RESULTS. Not actual trading. Not investment advice.')}</p>`;
    }

    const run = { today, live, backtest, ledger, methodology }[page];
    if (run) run();
  }
})();
