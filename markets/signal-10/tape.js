// PBE Market Tape on Signal 10 (issues #54, #56). Classic deferred script; reads helpers from window.S10Core.
// The featured links are server-rendered in the page (they work without JS and never shift layout); this script reads the
// ONE shared contract GET /api/market-tape (market-tape/1), fills whatever the rights gate allows (today: no prices), adds the
// member-only PBE SIGNAL 10 RESEARCH badges (frozen EOD ranks, simulated paper flags) and the member groups to the right.
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
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const track = root.querySelector('[data-tape-track]');
    // ---- scrolling ticker: track > loop > [rail (live items), clone (aria-hidden copy)] translated by CSS; no scroll bars.
    // Paused on hover, keyboard focus (manual mode scrolls the focused item into view), hidden tab and reduced motion.
    const loop = document.createElement('div'); loop.className = 's10-tape-loop';
    const rail = document.createElement('div'); rail.className = 's10-tape-rail'; rail.setAttribute('role', 'presentation');
    while (track.firstChild) rail.appendChild(track.firstChild);
    // aria-hidden + untabbable links (NOT inert: the copy must stay clickable while it is the visible half of the loop)
    const clone = document.createElement('div'); clone.className = 's10-tape-rail'; clone.setAttribute('aria-hidden', 'true');
    loop.append(rail, clone); track.appendChild(loop);
    const PX_PER_S = 38;
    function syncClone() {
      clone.innerHTML = rail.innerHTML;
      for (const a of clone.querySelectorAll('a')) { a.tabIndex = -1; a.removeAttribute('title'); a.setAttribute('role', 'presentation'); a.classList.remove('tick-up', 'tick-dn'); }
      const w = rail.scrollWidth;
      root.style.setProperty('--tape-dur', `${Math.max(20, Math.round(w / PX_PER_S))}s`);
      root.classList.toggle('s10-tape-moving', !reduce && w > track.clientWidth);
    }
    let manualTimer = null;
    track.addEventListener('focusin', (e) => {
      // keyboard focus only (a mouse click is focus too, but must not stop and reset the loop)
      if (!e.target.matches?.(':focus-visible')) return;
      clearTimeout(manualTimer);
      root.classList.add('s10-tape-manual');
      e.target.closest?.('.s10-tq')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    track.addEventListener('focusout', () => { manualTimer = setTimeout(() => { if (!track.contains(document.activeElement)) { root.classList.remove('s10-tape-manual'); track.scrollLeft = 0; } }, 1500); });
    addEventListener('resize', () => syncClone(), { passive: true });
    syncClone();
    const statusEl = root.querySelector('[data-tape-status]');
    const metaEl = root.querySelector('[data-tape-meta]');
    let timer = null, last = null, lastAt = 0, inflight = false;

    const STATUS = { LIVE_QUOTES: 'CURRENT' };
    // market-tape/1 -> rows this controller renders (prices only ever come from the payload; null stays null)
    function normalize(mt) {
      const shown = mt.rights?.state === 'CLEARED';
      const s = mt.session || {};
      return {
        generated_at: mt.generated_at, research: mt.research_snapshot || null, source: shown ? { name: mt.rights.provider } : null,
        // next-day exchange prices (IEX HIST): session date + credit line travel with every value
        t1: (mt.lists || []).flatMap((l) => l.securities).find((x) => x.price_basis && x.attribution) || null,
        quotes: { shown, withheld: shown ? null : 'SOURCE_RIGHTS_HOLD' },
        session: { ...s, opens_at: s.session_open_at, closes_at: s.session_close_at },
        groups: (mt.lists || []).map((l) => ({ key: l.key, kind: l.kind, label: l.label, note: l.note, rows: l.securities.map((x) => ({
          symbol: x.symbol, name: x.name, robinhood_url: x.robinhood_url, pinned: x.pinned, group: l.key, kind: l.kind,
          price: x.last_price, previous_close: x.previous_regular_close, change_abs: x.change_abs, change_pct: x.change_pct, price_observed_at: x.observed_at,
          status: STATUS[x.state] || x.state, research: x.research || null, price_session_date: x.price_session_date || null, price_basis: x.price_basis || null,
          rank: l.kind === 'MODEL_RESEARCH' ? x.research?.rank ?? null : null })) })),
      };
    }
    // PBE SIGNAL 10 RESEARCH badge (members): genuine frozen-snapshot evidence only; nothing for symbols outside the model
    function rsText(r) {
      const x = r.research;
      if (!x) return '';
      if (r.kind === 'MODEL_RESEARCH') return x.move === 'NEW' ? 'NEW' : x.move === 'UP' ? `▲${x.prev_rank - x.rank}` : x.move === 'DOWN' ? `▼${x.rank - x.prev_rank}` : '';
      if (x.paper_held) return 'PAPER';
      return x.rank ? (r.change_pct != null ? `#${x.rank}` : `S10 #${x.rank}`) : '';
    }
    function rsTitle(r) {
      const x = r.research;
      if (!x) return '';
      if (!x.in_universe) return ' Not in the Signal 10 model universe (S&P 500).';
      const parts = [` PBE Signal 10 research (as of the ${x.snapshot_d} close): ${x.rank ? `rank ${x.rank}${x.prev_rank ? `, previously ${x.prev_rank}` : ', new to the stored top 50'}` : 'outside the stored top 50'}.`];
      if (x.paper_held) parts.push(' Held in the SIMULATED $10,000 paper account.');
      return parts.join('');
    }
    // move colours only for the model's own ranking group; a featured badge is a neutral reference, never a gain/loss cue
    const rsCls = (r) => `s10-tq-rs${r.research?.paper_held && r.kind !== 'MODEL_RESEARCH' ? ' paper' : ''}${r.kind === 'MODEL_RESEARCH' && r.research?.move === 'UP' ? ' up' : r.kind === 'MODEL_RESEARCH' && r.research?.move === 'DOWN' ? ' dn' : ''}`;
    const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');
    const chg = (r) => {
      if (r.change_pct == null) return '';
      const t = fmtPct(r.change_pct, { dp: 2 });
      return /[1-9]/.test(t) ? t : t.replace(/^[+−]/, '');
    };
    const title = (r) => {
      const px = r.price != null ? `${fmtPrice(r.price)}${r.price_basis === 'IEX_LAST_SALE' ? ` — IEX last sale ${C.fmtDate(r.price_session_date)} (IEX venue only, next-day)` : ''}${r.change_abs != null ? ` (${r.change_abs >= 0 ? '+' : '−'}${fmtPrice(Math.abs(r.change_abs)).slice(1)} vs previous session ${fmtPrice(r.previous_close)})` : ''} · exchange trade time ${etShort(r.price_observed_at)}` : r.status === 'MEMBERS_ONLY' ? 'Prices are shown to PropBetEdge All Access members' : r.status === 'STALE' ? 'No current quote from the source' : r.status === 'SOURCE_RIGHTS_HOLD' ? 'Prices are not shown (quote source rights hold)' : 'Quote source unavailable';
      return `${r.symbol} · ${r.name} — ${px}.${rsTitle(r)} Opens Robinhood’s ${r.symbol} page in a new tab; prices, eligibility and any order are handled entirely by Robinhood.`;
    };
    const itemHTML = (r) => `<a class="s10-tq${r.pinned ? ' pin' : ''}" data-sym="${esc(r.symbol)}" href="${esc(r.robinhood_url)}" target="_blank" rel="noopener noreferrer external" title="${esc(title(r))}">`
      + `<span class="s10-tq-top"><b class="s10-tq-sym">${r.rank ? `<span class="s10-tq-rk">${esc(r.rank)}</span>` : ''}${esc(r.symbol)}</b><span class="s10-tq-ch num ${r.change_pct == null ? 'flat' : sign(r.change_pct)}">${esc(chg(r))}</span><span class="${rsCls(r)}">${esc(rsText(r))}</span></span>`
      + `<span class="s10-tq-bot"><span class="s10-tq-px num">${pxText(r)}</span><span class="s10-tq-go" aria-hidden="true">↗</span></span>`
      + `<span class="sr-only"> ${esc(r.name)}. View ${esc(r.symbol)} on Robinhood (opens in a new tab)</span></a>`;
    function pxText(r) {
      if (r.price != null) return esc(fmtPrice(r.price));
      // no price for this reader: the company name (exactly what the static page already shows, so nothing flickers)
      if (r.status === 'MEMBERS_ONLY' || r.status === 'SOURCE_RIGHTS_HOLD') return esc(r.name);
      if (r.status === 'STALE') return '<span class="s10-tq-dim">Stale</span>';
      // no observation yet for this symbol: keep the name (nothing invented, nothing flickers)
      return esc(r.name);
    }

    // Update one existing item in place (only the nodes whose text changed).
    function patch(el, r) {
      const px = el.querySelector('.s10-tq-px'), ch = el.querySelector('.s10-tq-ch');
      const nextPx = pxText(r), nextCh = chg(r);
      const prev = Number(el.dataset.px);
      if (px.innerHTML !== nextPx) px.innerHTML = nextPx;
      if (ch.textContent !== nextCh) ch.textContent = nextCh;
      let rs = el.querySelector('.s10-tq-rs');
      const nextRs = rsText(r);
      if (!rs && nextRs) { rs = document.createElement('span'); ch.after(rs); }
      if (rs && rs.textContent !== nextRs) rs.textContent = nextRs;
      if (rs) rs.className = rsCls(r);
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
          for (const r of g.rows) { const el = rail.querySelector(`.s10-tq[data-sym="${CSS.escape(r.symbol)}"]:not([data-g])`); if (el) patch(el, r); }
          continue;
        }
        const sig = g.rows.map((r) => r.symbol).join(',');
        let box = rail.querySelector(`[data-tape-group="${g.key}"]`);
        if (!box || box.dataset.sig !== sig || box.dataset.label !== g.label) {
          const html = `<span class="s10-tg" title="${esc(g.note)}">${esc(g.label)}</span>${g.rows.map(itemHTML).join('')}`;
          if (!box) {
            box = document.createElement('div'); box.className = 's10-tape-grp'; box.dataset.tapeGroup = g.key; box.setAttribute('role', 'presentation');
            // order: SpaceX first, then the algorithm's latest frozen Top 10, then the rest of the watchline; paper holdings last
            const pin = rail.querySelector('.s10-tq.pin:not([data-g])');
            if (g.kind === 'MODEL_RESEARCH' && pin) pin.after(box); else rail.appendChild(box);
          }
          box.innerHTML = html; box.dataset.sig = sig; box.dataset.label = g.label;
          for (const el of box.querySelectorAll('.s10-tq')) el.dataset.g = g.key;
        }
        for (const r of g.rows) { const el = box.querySelector(`.s10-tq[data-sym="${CSS.escape(r.symbol)}"]`); if (el) patch(el, r); }
      }
      for (const box of rail.querySelectorAll('[data-tape-group]')) if (!d.groups.some((g) => g.key === box.dataset.tapeGroup)) box.remove();
      // the Top 10 group sits between SPCX and the rest of the featured watchline: label that remainder so it reads apart
      let rest = rail.querySelector('[data-tape-rest]');
      const top = rail.querySelector('[data-tape-group="SIGNAL10_TOP10"]');
      if (top && !rest) { rest = document.createElement('span'); rest.className = 's10-tg'; rest.dataset.tapeRest = '1'; rest.textContent = 'Watchline'; top.after(rest); }
      if (!top && rest) rest.remove();
      syncClone();

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
      if (!d.quotes.shown && d.quotes.withheld === 'SOURCE_RIGHTS_HOLD') parts.push('<span title="No licensed quote source yet: symbols, market hours and Robinhood links only">Prices: source rights hold</span>');
      if (!d.quotes.shown && d.quotes.withheld === 'MEMBERS_ONLY') parts.push('<span>Prices for <a href="https://propbetedge.ai/pro" data-pbe-placement="predictions_signal10_tape">All Access</a> members · <a href="#" data-pbe-signin>Sign in</a></span>');
      const span = C.quoteSpan(rows);
      if (d.quotes.shown && d.t1) {
        const days = [...new Set(rows.filter((r) => r.price != null).map((r) => r.price_session_date))].sort();
        if (days.length) parts.push(`<span title="Last regular-session sale on IEX for that day (not the consolidated close); published by IEX the next morning">PBE Markets · IEX last sale · ${esc(days.map((x) => C.fmtDate(x)).join(' / '))} · IEX venue only · next-day</span>`);
        else parts.push('<span>IEX next-day prices pending</span>');
        if (d.session.state === 'OPEN' && d.session.closes_at) parts.push(`<span>Closes ${esc(etTime(d.session.closes_at))}</span>`);
        else if (d.session.next_open_at) parts.unshift(`<span>${esc(C.reopenText(d.session))}</span>`);
        // compact source credit (IEX's required attribution text in the tooltip); no fine-print paragraph (owner)
        // first in the line so the (ellipsized) meta row can never truncate it away
        parts.unshift(`<a href="https://exchange.iex.io/products/market-data-connectivity/hist-terms/" target="_blank" rel="noopener noreferrer" title="${esc(d.t1.attribution)}">Data: IEX</a>`);
      } else if (d.quotes.shown && span) {
        const same = etTime(span.min) === etTime(span.max);
        const when = d.session.state === 'OPEN' ? `Source trades ${same ? etTime(span.max) : `${etTime(span.min).replace(' ET', '')}–${etTime(span.max)}`}` : `Last close ${etShort(d.session.last_close_at)}`;
        parts.push(`<span>${esc(when)}</span>`);
        if (d.session.state !== 'OPEN' && d.session.next_open_at) parts.push(`<span>${esc(C.reopenText(d.session))}</span>`);
      } else if (!d.t1 && d.session.state !== 'OPEN' && d.session.next_open_at) parts.unshift(`<span>${esc(C.reopenText(d.session))}</span>`);
      if (!d.t1 && d.session.state === 'OPEN' && d.session.closes_at && !(d.quotes.shown && C.quoteSpan(rows))) parts.push(`<span>Closes ${esc(etTime(d.session.closes_at))}</span>`);
      if (d.quotes.shown && !d.t1) parts.push(`<span>Source: ${esc(d.source?.name || '')}</span>`, `<span>Updated <span data-rel="${esc(d.generated_at)}">${esc(relTime(d.generated_at))}</span></span>`);
      if (d.research) parts.push(`<a href="/markets/signal-10/methodology/" title="End-of-day ranks from the pre-registered Signal 10 model, set at each close; research, not advice">Signal 10 research · as of ${esc(C.fmtDate(d.research.d))} close</a>`);
      return parts.join('<span aria-hidden="true"> · </span>');
    }

    async function load() {
      if (inflight) return;
      inflight = true; clearTimeout(timer);
      try {
        const r = await fetch('/api/market-tape', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
        const mt = r.ok ? await r.json() : null;
        if (mt && mt.contract === 'market-tape/1' && Array.isArray(mt.lists) && mt.session) { render(normalize(mt)); lastAt = Date.now(); root.dataset.state = 'ready'; }
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
    // sign-in completed elsewhere on the page: reload so members get their research groups
    document.addEventListener('pbe:membership', (ev) => { if (ev.detail?.entitled && last && !last.research) load(); });
    setInterval(() => { for (const el of root.querySelectorAll('[data-rel]')) el.textContent = relTime(el.dataset.rel); }, 15000);
    load();
  }
})();
