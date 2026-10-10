// PBE Signal 10 — U.S. stock tape controller (issue #54). Classic deferred script; reads helpers from window.S10Core.
// The featured links are server-rendered in the page (they work without JS and never shift layout); this script only fills
// prices from GET /api/signal10/tape and appends the members-only groups to the right of the scroller.
// Every value shown comes from that response. Nothing is animated except a short colour cue on a changed price
// (none under prefers-reduced-motion).
(() => {
  'use strict';
  const root = document.getElementById('s10-tape');
  if (!root) return;
  const boot = () => main(window.S10Core);
  if (window.S10Core) boot(); else window.addEventListener('s10core', boot, { once: true });

  function main(C) {
    const { esc, fmtPrice, fmtPct, etShort, etTime, relTime } = C;
    const track = root.querySelector('[data-tape-track]');
    const statusEl = root.querySelector('[data-tape-status]');
    const metaEl = root.querySelector('[data-tape-meta]');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let timer = null, last = null, lastAt = 0, inflight = false;

    const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');
    const chg = (r) => {
      if (r.change_pct == null) return '';
      const t = fmtPct(r.change_pct, { dp: 2 });
      return /[1-9]/.test(t) ? t : t.replace(/^[+−]/, '');
    };
    const title = (r) => {
      const px = r.price != null ? `${fmtPrice(r.price)}${r.change_abs != null ? ` (${r.change_abs >= 0 ? '+' : '−'}${fmtPrice(Math.abs(r.change_abs)).slice(1)} vs previous close ${fmtPrice(r.previous_close)})` : ''} · source trade time ${etShort(r.price_observed_at)}` : r.status === 'MEMBERS_ONLY' ? 'Prices are shown to PropBetEdge All Access members' : r.status === 'STALE' ? 'No current quote from the source' : r.status === 'QUOTES_OFF' ? 'Prices are not shown' : 'Quote source unavailable';
      return `${r.symbol} · ${r.name} — ${px}. Opens Robinhood’s ${r.symbol} page in a new tab; prices, eligibility and any order are handled entirely by Robinhood.`;
    };
    const itemHTML = (r) => `<a class="s10-tq${r.pinned ? ' pin' : ''}" role="listitem" data-sym="${esc(r.symbol)}" href="${esc(r.robinhood_url)}" target="_blank" rel="noopener noreferrer external" title="${esc(title(r))}">`
      + `<span class="s10-tq-top"><b class="s10-tq-sym">${r.rank ? `<span class="s10-tq-rk">${esc(r.rank)}</span>` : ''}${esc(r.symbol)}</b><span class="s10-tq-ch num ${r.change_pct == null ? 'flat' : sign(r.change_pct)}">${esc(chg(r))}</span></span>`
      + `<span class="s10-tq-bot"><span class="s10-tq-px num">${pxText(r)}</span><span class="s10-tq-go" aria-hidden="true">↗</span></span>`
      + `<span class="sr-only"> ${esc(r.name)}. View ${esc(r.symbol)} on Robinhood (opens in a new tab)</span></a>`;
    function pxText(r) {
      if (r.price != null) return esc(fmtPrice(r.price));
      // no price for this reader: the company name (exactly what the static page already shows, so nothing flickers)
      if (r.status === 'MEMBERS_ONLY' || r.status === 'QUOTES_OFF') return esc(r.name);
      if (r.status === 'STALE') return '<span class="s10-tq-dim">Stale</span>';
      return '<span class="s10-tq-dim">No quote</span>';
    }

    // Update one existing item in place (only the nodes whose text changed).
    function patch(el, r) {
      const px = el.querySelector('.s10-tq-px'), ch = el.querySelector('.s10-tq-ch');
      const nextPx = pxText(r), nextCh = chg(r);
      const prev = Number(el.dataset.px);
      if (px.innerHTML !== nextPx) px.innerHTML = nextPx;
      if (ch.textContent !== nextCh) ch.textContent = nextCh;
      ch.className = `s10-tq-ch num ${r.change_pct == null ? 'flat' : sign(r.change_pct)}`;
      el.title = title(r);
      el.dataset.status = r.status;
      if (r.price != null) {
        if (!reduce && Number.isFinite(prev) && prev !== r.price) {
          el.classList.remove('tick-up', 'tick-dn'); void el.offsetWidth; el.classList.add(r.price > prev ? 'tick-up' : 'tick-dn');
        }
        el.dataset.px = String(r.price);
      } else delete el.dataset.px;
    }

    function render(d) {
      last = d;
      const rows = d.groups.flatMap((g) => g.rows);
      // featured items already exist in the page; members-only groups are rebuilt only when their symbol set changes
      for (const g of d.groups) {
        if (g.key === 'FEATURED') {
          for (const r of g.rows) { const el = track.querySelector(`.s10-tq[data-sym="${CSS.escape(r.symbol)}"]:not([data-g])`); if (el) patch(el, r); }
          continue;
        }
        const sig = g.rows.map((r) => r.symbol).join(',');
        let box = track.querySelector(`[data-tape-group="${g.key}"]`);
        if (!box || box.dataset.sig !== sig || box.dataset.label !== g.label) {
          const html = `<span class="s10-tg" role="listitem" title="${esc(g.note)}">${esc(g.label)}</span>${g.rows.map(itemHTML).join('')}`;
          if (!box) { box = document.createElement('div'); box.className = 's10-tape-grp'; box.dataset.tapeGroup = g.key; box.setAttribute('role', 'presentation'); track.appendChild(box); }
          box.innerHTML = html; box.dataset.sig = sig; box.dataset.label = g.label;
          for (const el of box.querySelectorAll('.s10-tq')) el.dataset.g = g.key;
        }
        for (const r of g.rows) { const el = box.querySelector(`.s10-tq[data-sym="${CSS.escape(r.symbol)}"]`); if (el) patch(el, r); }
      }
      for (const box of track.querySelectorAll('[data-tape-group]')) if (!d.groups.some((g) => g.key === box.dataset.tapeGroup)) box.remove();

      const s = C.tapeStatus(d.session, rows);
      root.dataset.session = d.session.state; root.dataset.quotes = d.quotes.shown ? 'on' : 'off';
      const nextTxt = s.text;
      if (statusEl.dataset.text !== nextTxt) { statusEl.dataset.text = nextTxt; statusEl.innerHTML = `${s.live ? '<i class="s10-tape-dot" aria-hidden="true"></i>' : ''}${esc(nextTxt)}`; }
      statusEl.className = `s10-tape-status ${s.cls}`;
      metaEl.innerHTML = metaHTML(d, rows);
      metaEl.title = metaEl.textContent;
    }
    function metaHTML(d, rows) {
      const parts = [];
      if (!d.quotes.shown && d.quotes.withheld === 'MEMBERS_ONLY') parts.push('<span>Prices for <a href="https://propbetedge.ai/pro" data-pbe-placement="predictions_signal10_tape">All Access</a> members · <a href="#" data-pbe-signin>Sign in</a></span>');
      const span = C.quoteSpan(rows);
      if (d.quotes.shown && span) {
        const same = etTime(span.min) === etTime(span.max);
        const when = d.session.state === 'OPEN' ? `Source trades ${same ? etTime(span.max) : `${etTime(span.min).replace(' ET', '')}–${etTime(span.max)}`}` : `Last close ${etShort(d.session.last_close_at)}`;
        parts.push(`<span>${esc(when)}</span>`);
      } else if (d.session.state !== 'OPEN' && d.session.last_close_at) parts.push(`<span>Last close ${esc(etShort(d.session.last_close_at))}</span>`);
      if (d.session.state !== 'OPEN' && d.session.next_open_at) parts.push(`<span>Opens ${esc(etShort(d.session.next_open_at))}</span>`);
      if (d.quotes.shown) parts.push(`<span title="${esc(d.source?.delay || '')}">Yahoo Finance · may be delayed</span>`, `<span>Updated <span data-rel="${esc(d.generated_at)}">${esc(relTime(d.generated_at))}</span></span>`);
      return parts.join('<span aria-hidden="true"> · </span>');
    }

    async function load() {
      if (inflight) return;
      inflight = true; clearTimeout(timer);
      try {
        const r = await fetch('/api/signal10/tape', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
        const d = r.ok ? await r.json() : null;
        if (d && Array.isArray(d.groups) && d.session) { render(d); lastAt = Date.now(); root.dataset.state = 'ready'; }
        else root.dataset.state = 'error';
      } catch { root.dataset.state = 'error'; }
      inflight = false;
      schedule();
    }
    function interval() { return C.tapePollMs(last?.session, document.visibilityState === 'visible') ?? null; }
    function schedule() {
      clearTimeout(timer);
      // errors: retry in 2 min while the market is open (or unknown), otherwise in 15 min (never a tight loop)
      const ms = root.dataset.state === 'error' ? (document.visibilityState !== 'visible' ? null : !last || last.session.state === 'OPEN' ? 120000 : 15 * 60000) : interval();
      if (ms) timer = setTimeout(load, ms);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') { clearTimeout(timer); return; }
      const ms = interval();
      if (!last || ms == null || Date.now() - lastAt >= Math.min(ms, 90000)) load(); else schedule();
    });
    // sign-in completed elsewhere on the page: reload so members get prices + their groups
    document.addEventListener('pbe:membership', (ev) => { if (ev.detail?.entitled && last && !last.quotes.shown && last.quotes.withheld === 'MEMBERS_ONLY') load(); });
    setInterval(() => { for (const el of root.querySelectorAll('[data-rel]')) el.textContent = relTime(el.dataset.rel); }, 15000);
    load();
  }
})();
