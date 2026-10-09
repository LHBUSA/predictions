// /calendar/ — the Prediction Calendar (issue #50): every tracked event closing in the next three weeks (stored venue close
// times from /api/calendar, public), grouped by day, with a category filter kept in the URL. Each row links to the
// canonical /events/:slug record. Times are shown in the reader's local zone with the UTC time beside it.
let cal = [];
const state = { cat: urlState.get('category', 'ALL') };
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const localHM = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function cats() {
  const counts = {}; const label = {};
  for (const e of cal) { counts[e.category] = (counts[e.category] || 0) + 1; label[e.category] = e.category_label; }
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (state.cat !== 'ALL' && !counts[state.cat]) state.cat = 'ALL';
  const btn = (k, l, n) => `<button type="button" class="chip" data-cat="${k}" aria-pressed="${state.cat === k}">${esc(l)}<small>${n}</small></button>`;
  $('cal-cats').innerHTML = btn('ALL', 'All', cal.length) + keys.map((k) => btn(k, label[k] || k, counts[k])).join('');
  $('cal-cats').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { state.cat = b.dataset.cat; urlState.set({ category: state.cat }); cats(); render(); }));
}

function render() {
  const rows = cal.filter((e) => state.cat === 'ALL' || e.category === state.cat).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  if (!rows.length) { $('cal-list').innerHTML = '<div class="card empty-honest">No tracked event in this category closes in the next three weeks.</div>'; return; }
  const groups = new Map();
  for (const e of rows) { const k = dayKey(e.close_time); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  $('cal-list').innerHTML = [...groups.values()].map((list) => `<section class="cal-day"><h2 class="cal-date">${esc(dayLabel(list[0].close_time))}<small>${list.length} event${list.length === 1 ? '' : 's'}</small></h2>
    <div class="card cal-rows">${list.map((e) => `<a class="cal-row" href="${esc(e.url)}"><span class="cal-time num"><b>${esc(localHM(e.close_time))}</b><small>${esc(utcHM(e.close_time))}</small></span><span class="cal-title"><b>${esc(e.title)}</b><small>${esc(e.category_label)} · ${e.outcomes_total} outcome${e.outcomes_total === 1 ? '' : 's'}</small></span><span class="cal-state">${badge(e.state)}</span><span class="cal-until">${untilEl(e.close_time)}</span></a>`).join('')}</div></section>`).join('');
}

PBE.datasets.calendar = { ms: 120e3, run: async () => { const v = await sigFetch('calendar', 'calendar'); if (v) { cal = v.events; $('cal-sub').textContent = `${cal.length} tracked events close in the next three weeks · updated ${ago(v.generated_at)}`; cats(); render(); } } };
PBE.datasets.summary = { ms: 60e3, run: async () => { const v = await sigFetch('summary', 'summary'); if (v) liveStatus(v); } };
bootLive();
