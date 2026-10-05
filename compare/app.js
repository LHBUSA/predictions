const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let all = [];
let view = 'gaps';
const qs = new URLSearchParams(location.search);
const selectedEvent = qs.get('event') || '';
const selectedMarket = qs.get('market') || '';
const initialScope = (qs.get('scope') || '').toLowerCase();

const pct = (bp) => bp == null ? '—' : (bp / 100).toFixed(bp % 100 ? 1 : 0) + '%';
const signed = (n) => n > 0 ? '+' + n.toFixed(1) : n < 0 ? '−' + Math.abs(n).toFixed(1) : '0.0';
const age = (iso) => {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + 's ago';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
  return Math.round(ms / 3600000) + 'h ago';
};
const freshest = (c) => Math.max(0, ...(c.venues || []).map((v) => Date.parse(v.observed_at || '') || 0));
const pbeDivergence = (c) => Math.max(0, ...(c.comparison?.pbe_vs_venues_pts || []).map(Math.abs));
const keyFor = (c) => c.canonical_contract_id || c.label || c.event_title;
const rowId = (c) => 'm-' + btoa(unescape(encodeURIComponent(keyFor(c)))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 50);

async function member() {
  const r = await fetch('/api/membership', { credentials:'include', cache:'no-store' });
  return r.json();
}

async function load() {
  const v = $('#scope').value;
  const u = v === 'nonsports'
    ? '/api/desk?domain=nonsports&limit=200'
    : '/api/desk?sport=' + encodeURIComponent(v) + '&limit=200';
  const r = await fetch(u, { credentials:'include', cache:'no-store' });
  if (r.status === 403) return;
  const d = await r.json();
  all = (d.events || []).flatMap((e) => (e.contracts || []).map((c) => ({
    ...c,
    canonical_event_id: c.canonical_event_id || e.canonical_event_id || e.id || '',
    event_title: e.title || e.label || e.question || '',
    destination: e.destination
  })));
  render();
  if (selectedMarket) {
    requestAnimationFrame(() => document.getElementById(rowId({canonical_contract_id:selectedMarket}))?.scrollIntoView({block:'center'}));
  }
}

function deepLink(c) {
  const u = new URL('https://compare.propbetedge.ai/');
  u.searchParams.set('scope', $('#scope').value);
  if (c.canonical_event_id) u.searchParams.set('event', c.canonical_event_id);
  if (c.canonical_contract_id) u.searchParams.set('market', c.canonical_contract_id);
  return u.toString();
}

function freshnessTags(c) {
  const tags = (c.venues || []).map((v) => {
    const f = String(v.freshness || 'unknown').toLowerCase();
    const cls = f === 'live' ? 'live' : f === 'stale' ? 'stale' : '';
    return '<span class="tag ' + cls + '">' + esc(v.venue) + ' ' + esc(f.toUpperCase()) + (v.observed_at ? ' · ' + esc(age(v.observed_at)) : '') + '</span>';
  });
  return tags.join('');
}

function rowHtml(c) {
  const kv = (c.venues || []).find((v) => v.venue === 'kalshi');
  const pm = (c.venues || []).find((v) => v.venue === 'polymarket');
  const cmp = c.comparison;
  const pbe = c.pbe?.probability != null ? Math.round(c.pbe.probability * 100) + '%' : '—';
  const rel = (c.related || [])[0];
  const outside = cmp && /^outside/.test(cmp.pbe_position || '');
  const gap = cmp?.venue_gap_pts ?? null;
  const divergence = pbeDivergence(c);
  const title = c.event_title || c.label || 'Market';
  const exactLabel = cmp?.match_class || (rel ? rel.match : 'NO COMPARISON');
  const selected = selectedMarket && c.canonical_contract_id === selectedMarket;
  const command = new URL('https://members.propbetedge.ai/');
  command.searchParams.set('add', deepLink(c));
  command.searchParams.set('title', title + (c.label && c.label !== title ? ' · ' + c.label : ''));

  return '<article class="row" id="' + rowId(c) + '"' + (selected ? ' data-selected="true"' : '') + '>' +
    '<div class="row-main">' +
      '<div class="market">' +
        '<div class="title">' + esc(title) + '</div>' +
        (c.label && c.label !== title ? '<div class="label">' + esc(c.label) + '</div>' : '') +
        '<div class="sub">' +
          '<span class="tag">' + esc(exactLabel) + '</span>' +
          (outside ? '<span class="tag outside">PBE OUTSIDE BOTH</span>' : '') +
          (rel ? '<span class="tag related">RELATED · RULES DIFFER</span>' : '') +
          '<span class="freshness">' + freshnessTags(c) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="metric"><span>PBE</span><strong class="gold">' + pbe + '</strong></div>' +
      '<div class="metric"><span>Kalshi</span><strong>' + pct(kv?.mid_bp) + '</strong></div>' +
      '<div class="metric"><span>Polymarket</span><strong>' + pct(pm?.mid_bp) + '</strong></div>' +
      '<div class="metric"><span>' + (cmp ? 'Venue gap' : 'PBE divergence') + '</span><strong class="' + (gap != null && gap >= 5 ? 'red' : outside ? 'violet' : 'green') + '">' +
        (gap != null ? gap.toFixed(1) + ' pts' : divergence ? divergence.toFixed(1) + ' pts' : '—') +
      '</strong></div>' +
    '</div>' +
    '<div class="row-actions">' +
      (c.canonical_event_id && c.canonical_contract_id ? '<button class="action" type="button" data-history="' + esc(rowId(c)) + '" data-event="' + esc(c.canonical_event_id) + '" data-market="' + esc(c.canonical_contract_id) + '">24H OBSERVED MOVE</button>' : '') +
      '<a class="action primary" href="' + esc(command.toString()) + '">+ COMMAND CENTER</a>' +
      (kv?.market_url ? '<a class="action" href="' + esc(kv.market_url) + '" target="_blank" rel="noopener nofollow">KALSHI ↗</a>' : '') +
      (pm?.market_url ? '<a class="action" href="' + esc(pm.market_url) + '" target="_blank" rel="noopener nofollow">POLYMARKET ↗</a>' : '') +
      '<a class="action" href="' + esc(deepLink(c)) + '">SHARE</a>' +
    '</div>' +
    '<div class="history" data-history-box="' + esc(rowId(c)) + '"></div>' +
  '</article>';
}

function filteredRows() {
  const q = $('#q').value.toLowerCase().trim();
  let rows = all.filter((c) => (c.event_title + ' ' + (c.label || '')).toLowerCase().includes(q));
  if (view === 'outside') rows = rows.filter((c) => /^outside/.test(c.comparison?.pbe_position || ''));
  if (view === 'gaps') rows = rows.filter((c) => c.comparison);
  const sort = $('#sort').value;
  rows.sort((a, b) => {
    if (sort === 'pbe') return pbeDivergence(b) - pbeDivergence(a);
    if (sort === 'fresh') return freshest(b) - freshest(a);
    return (b.comparison?.venue_gap_pts || 0) - (a.comparison?.venue_gap_pts || 0);
  });
  return rows;
}

function render() {
  const rows = filteredRows();
  const comparable = all.filter((c) => c.comparison).length;
  const outside = all.filter((c) => /^outside/.test(c.comparison?.pbe_position || '')).length;
  const related = all.reduce((n, c) => n + (c.related?.length || 0), 0);
  const max = Math.max(0, ...all.map((c) => c.comparison?.venue_gap_pts || 0));
  $('#exact').textContent = comparable;
  $('#outside').textContent = outside;
  $('#related').textContent = related;
  $('#maxgap').textContent = max ? max.toFixed(1) + ' pts' : '—';
  $('#live-count').textContent = comparable;
  $('#rows').innerHTML = rows.map(rowHtml).join('') || '<div class="gate empty">No markets match this view right now.</div>';
  bindHistory();
}

function summarizeMoves(series) {
  return (series || []).map((s) => {
    const points = (s.segments || []).flat();
    if (points.length < 2) return { source:s.source, label:s.label, move:null, first:points[0]?.v, last:points.at(-1)?.v, n:points.length };
    const first = points[0].v;
    const last = points.at(-1).v;
    return { source:s.source, label:s.label, move:(last-first)/100, first, last, n:points.length };
  });
}

function bindHistory() {
  document.querySelectorAll('[data-history]').forEach((button) => {
    button.addEventListener('click', async () => {
      const box = document.querySelector('[data-history-box="' + button.dataset.history + '"]');
      if (!box) return;
      if (box.classList.contains('open')) { box.classList.remove('open'); return; }
      box.classList.add('open');
      box.innerHTML = '<div class="loading-line">Loading stored observations…</div>';
      const u = '/api/series?event=' + encodeURIComponent(button.dataset.event) + '&market=' + encodeURIComponent(button.dataset.market) + '&hours=24';
      try {
        const r = await fetch(u, {credentials:'include', cache:'no-store'});
        if (!r.ok) throw new Error('series');
        const d = await r.json();
        const moves = summarizeMoves(d.series);
        box.innerHTML = '<div class="moves">' + moves.map((m) =>
          '<div class="move"><small>' + esc(m.label || m.source) + ' · ' + esc(m.n) + ' observations</small><b class="' + (m.move > 0 ? 'green' : m.move < 0 ? 'red' : '') + '">' +
          (m.move == null ? 'Not enough observations' : signed(m.move) + ' pts') +
          '</b></div>'
        ).join('') + '</div><p class="loading-line">Observed points only. Gaps remain gaps; no interpolation or reconstructed moves.</p>';
      } catch {
        box.innerHTML = '<div class="loading-line">Observed history is unavailable right now.</div>';
      }
    });
  });
}

async function init() {
  if (initialScope && [...$('#scope').options].some((o) => o.value === initialScope)) $('#scope').value = initialScope;
  if (selectedMarket) view = 'all';
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  const m = await member();
  $('#acct').textContent = m.membership?.label || 'Account';
  if (m.membership?.entitled) {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    await load();
  } else {
    $('#gate').hidden = false;
  }
}

$('#scope').addEventListener('change', load);
$('#sort').addEventListener('change', render);
$('#q').addEventListener('input', render);
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  render();
}));
init();
