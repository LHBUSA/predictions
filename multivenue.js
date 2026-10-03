// MULTI-VENUE DESK (hidden; propbetedge-workers docs/MULTI_VENUE_DESK.md). Loaded ONLY when the page URL carries
// ?mv=1 — production output without the flag is byte-identical. Data: propsports-markets /v1/market-desk
// (+ /series), which carries a second venue only when that Worker's POLYMARKET_DISPLAY_ENABLED is on and the
// contract is EXACT_MATCH; anything else renders exactly today's single-venue design (no empty slot).
// PBE is the product (gold); venues are benchmarks (one compact MARKETS block). No consensus number.
const MV_API = 'https://propsports-markets.sales-fd3.workers.dev';
const qs = new URLSearchParams(location.search);
const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const API = local && qs.get('mvsrc') ? qs.get('mvsrc') : MV_API; // local QA proxy only
const VENUE = { kalshi: 'Kalshi', polymarket: 'Polymarket' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pts = (bp) => Math.round(bp / 100);
const sgn = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

const CSS = `
.mv-pbe strong{color:var(--amber,#b8860b)}
.mv-markets strong{display:flex;flex-direction:column;gap:1px;font-size:13px;line-height:1.25;font-weight:600}
.mv-markets strong em{display:flex;justify-content:space-between;gap:6px;font-style:normal}
.mv-markets strong b{font-weight:700}
.mv-markets small{color:var(--muted,#6b7c8f);font-weight:500;margin-right:4px}
.row.mv-row{box-shadow:inset 3px 0 0 rgba(31,99,181,.35)}
.mv-sub{display:block;margin-top:3px;color:var(--muted,#6b7c8f);font-size:12.5px}
.mv-sub b{color:inherit;font-weight:600}
.mv-chart svg{width:100%;height:auto;display:block}
.mv-chart .legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:12.5px;color:var(--muted,#6b7c8f)}
.mv-chart .legend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
@media (max-width:640px){.mv-markets strong{font-size:12.5px}.mv-sub{font-size:12px}}
`;
function style() { if (document.getElementById('mv-style')) return; const s = document.createElement('style'); s.id = 'mv-style'; s.textContent = CSS; document.head.appendChild(s); }

// ---------------------------------------------------------------------------------------------------------
// Homepage desk
const bySlugMarket = new Map(); // `${slug}|${market_id}` -> contract
async function loadDesk() {
  const r = await fetch(`${API}/v1/market-desk?domain=nonsports`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`desk ${r.status}`);
  const d = await r.json();
  for (const e of d.events || []) {
    const slug = (e.destination?.url || '').split('/events/')[1];
    if (!slug) continue;
    for (const c of e.contracts || []) bySlugMarket.set(`${slug}|${c.canonical_contract_id.split('|').pop()}`, c);
  }
}
const slugOf = (e) => (e.url || '').split('/events/')[1];
const contractFor = (e) => (e.headline?.market_id ? bySlugMarket.get(`${slugOf(e)}|${e.headline.market_id}`) : null);
// multi-venue only: >= 2 EXACT venues with an aligned comparison. Anything else = today's row.
const multi = (e) => { const c = contractFor(e); return c && c.venues.length >= 2 && c.comparison ? c : null; };

function decorate(list) {
  const rows = [...document.querySelectorAll('#desk-list a.card.row')];
  for (const a of rows) {
    const e = list.find((x) => x.url === a.getAttribute('href'));
    const c = e && multi(e);
    if (!c) continue;
    const cells = a.querySelectorAll('.cells .cell');
    if (cells.length < 3) continue;
    a.classList.add('mv-row');
    cells[0].classList.add('mv-pbe');
    cells[1].classList.add('mv-markets');
    cells[1].innerHTML = `<span>Markets</span><strong class="num">${c.venues.map((v) => `<em><small>${esc(VENUE[v.venue] || v.venue)}</small><b>${pts(v.mid_bp)}%</b></em>`).join('')}</strong>`;
    const cmp = c.comparison;
    if (cmp.pbe_vs_venues_pts) {
      const vs = cmp.pbe_vs_venues_pts.map((x) => Math.round(x));
      const lo = Math.min(...vs), hi = Math.max(...vs);
      cells[2].innerHTML = `<span>PBE vs range</span><strong class="num ${lo > 0 ? 'dpos' : hi < 0 ? 'dneg' : ''}">${lo === hi ? sgn(lo) : `${sgn(hi < 0 ? hi : lo)}…${sgn(hi < 0 ? lo : hi)}`}</strong>`;
    }
    const sub = a.querySelector('.sub');
    if (sub) sub.insertAdjacentHTML('beforeend', `<span class="mv-sub">Venue gap <b class="num">${Math.round(cmp.venue_gap_pts)} pts</b>${cmp.pbe_vs_venues_pts ? ` · PBE vs range <b class="num">${sgn(Math.round(cmp.pbe_vs_venues_pts[0]))} to ${sgn(Math.round(cmp.pbe_vs_venues_pts.at(-1)))} pts</b>` : ''} · aligned within ${cmp.aligned_within_s} s</span>`);
  }
}

// Sort / filter modes — offered only when the underlying set is non-empty.
const MODES = {
  mv_gap: { label: 'Largest venue disagreement', pick: (e) => multi(e), key: (c) => -c.comparison.venue_gap_pts },
  mv_outside: { label: 'PBE outside both venues', pick: (e) => { const c = multi(e); return c && /^outside/.test(c.comparison.pbe_position || '') ? c : null; }, key: (c) => -Math.min(...c.comparison.pbe_vs_venues_pts.map(Math.abs)) },
  mv_inside: { label: 'PBE inside venue range', pick: (e) => { const c = multi(e); return c && c.comparison.pbe_position === 'inside' ? c : null; }, key: (c) => -c.comparison.venue_gap_pts },
};
function addModes(list) {
  const sel = document.getElementById('sort');
  if (!sel) return;
  for (const [k, m] of Object.entries(MODES)) if (list.some((e) => m.pick(e)) && !sel.querySelector(`option[value="${k}"]`)) sel.insertAdjacentHTML('beforeend', `<option value="${k}">${esc(m.label)}</option>`);
}
function order(mode, rows) {
  const m = MODES[mode];
  if (!m) return rows;
  return rows.map((e) => [e, m.pick(e)]).filter(([, c]) => c).sort((a, b) => m.key(a[1]) - m.key(b[1])).map(([e]) => e);
}

// ---------------------------------------------------------------------------------------------------------
// Event page: three series (PBE, Kalshi, Polymarket) from stored observations; step lines, gaps, markers.
const COLORS = { pbe: '#b8860b', kalshi: '#1f63b5', polymarket: '#6b4fbb' };
async function eventChart(panel) {
  const r = await fetch(`${API}/v1/market-desk/series?event=${encodeURIComponent(panel.dataset.event)}&market=${encodeURIComponent(panel.dataset.market)}&hours=168`, { headers: { accept: 'application/json' } });
  if (!r.ok) return;
  const d = await r.json();
  if (!(d.series || []).some((s) => s.source === 'polymarket')) return; // single venue: the existing chart stays the design
  const all = d.series.flatMap((s) => s.segments.flat().map((p) => Date.parse(p.t)));
  const t0 = Math.min(...all), t1 = Math.max(...all, Date.parse(d.window.to));
  const W = 720, H = 240, L = 38, R = 12, T = 10, B = 26;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (bp) => T + (1 - bp / 10000) * (H - T - B);
  const grid = [0, 25, 50, 75, 100].map((p) => `<line x1="${L}" x2="${W - R}" y1="${y(p * 100)}" y2="${y(p * 100)}" stroke="#e9eff6"/><text x="4" y="${y(p * 100) + 4}" font-size="11" fill="#8597a9">${p}%</text>`).join('');
  const step = (seg, extendTo) => { const p = seg.map((q) => [Date.parse(q.t), q.v]); if (extendTo) p.push([extendTo, p.at(-1)[1]]); return p.map(([t, v], i) => `${i ? `H${x(t).toFixed(1)} V${y(v).toFixed(1)}` : `M${x(t).toFixed(1)},${y(v).toFixed(1)}`}`).join(' '); };
  const paths = d.series.map((s) => s.segments.map((seg, i) => {
    const ext = s.source === 'pbe' && i === s.segments.length - 1 ? t1 : null; // a forecast holds until replaced
    return seg.length > 1 || ext ? `<path d="${step(seg, ext)}" fill="none" stroke="${COLORS[s.source]}" stroke-width="${s.source === 'pbe' ? 2.5 : 2}"${s.source === 'pbe' ? '' : ' stroke-dasharray="5 3"'}/>` : `<circle cx="${x(Date.parse(seg[0].t)).toFixed(1)}" cy="${y(seg[0].v).toFixed(1)}" r="2.5" fill="${COLORS[s.source]}"/>`;
  }).join('') + (s.segments[0]?.[0] ? `<circle cx="${x(Date.parse(s.segments[0][0].t)).toFixed(1)}" cy="${y(s.segments[0][0].v).toFixed(1)}" r="4" fill="#fff" stroke="${COLORS[s.source]}" stroke-width="2"><title>${esc(s.label)} first observed ${esc(s.segments[0][0].t)}</title></circle>` : '')).join('');
  const res = d.resolution ? `<line x1="${x(Date.parse(d.resolution.t))}" x2="${x(Date.parse(d.resolution.t))}" y1="${T}" y2="${H - B}" stroke="#2c3e50" stroke-dasharray="2 3"/><text x="${x(Date.parse(d.resolution.t)) - 4}" y="${T + 10}" font-size="11" text-anchor="end" fill="#2c3e50">resolved ${esc(String(d.resolution.result || '').toUpperCase())}</text>` : '';
  const axis = [t0, t1].map((t, i) => `<text x="${i ? W - R : L}" y="${H - 6}" font-size="11" fill="#8597a9" text-anchor="${i ? 'end' : 'start'}">${new Date(t).toISOString().slice(5, 16).replace('T', ' ')}Z</text>`).join('');
  panel.querySelector('.mv-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PBE forecast, Kalshi and Polymarket over time (stored observations)">${grid}${axis}${paths}${res}</svg>
<div class="legend">${d.series.map((s) => `<span><i style="background:${COLORS[s.source]}"></i>${esc(s.label)}${s.source === 'pbe' ? ' forecast' : ' mid (observed)'}</span>`).join('')}<span>Open circle = first observed by PBE · gaps = not observed</span></div>`;
  panel.hidden = false;
}

// ---------------------------------------------------------------------------------------------------------
style();
const panel = document.getElementById('mv-chart-panel');
if (panel) eventChart(panel).catch((e) => console.warn('mv chart', e));
export const ready = panel ? Promise.resolve() : loadDesk().catch((e) => console.warn('mv desk', e));
window.PBE_MV = { decorate, order, addModes, handles: (m) => m in MODES };
