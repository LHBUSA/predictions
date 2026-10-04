// LIVE WEATHER INTELLIGENCE blocks (event page). Server-rendered from stored facts (weather-intel.js) and swapped in
// place by live.js. The atmosphere layer follows the OBSERVATION (never the PBE probability); stale observations
// render no animation; prefers-reduced-motion disables motion (site.css).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = (iso) => (iso ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : '—');
const pct = (v) => (v === null || v === undefined ? '—' : v < 1 ? '<1%' : v > 99 ? '>99%' : `${v}%`);
const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const title = (s) => String(s || '').toLowerCase().replace(/\b(intl|arpt|intnl)\b/g, '').replace(/[/(].*$/, '').trim().replace(/\b\w/g, (c) => c.toUpperCase());

export const ATMOSPHERES = Object.freeze(['rain', 'snow', 'storm', 'fog', 'cloudy', 'clear-day', 'clear-night', 'stale', 'none']);
export const atmosphereLayer = (cls) => `<div class="wx-atmo wx-${esc(ATMOSPHERES.includes(cls) ? cls : 'none')}" data-atmo aria-hidden="true"><i class="wx-l1"></i><i class="wx-l2"></i></div>`;

function chart(c) {
  if (!c || (c.pbe.length + c.market.length) < 2) return '';
  const W = 720, H = 200, L = 34, R = 40, T = 10, B = 24;
  const t0 = Date.parse(c.from), t1 = Math.max(Date.parse(c.to), t0 + 3600000);
  const x = (t) => (L + ((Math.max(t0, Math.min(t1, Date.parse(t))) - t0) / (t1 - t0)) * (W - L - R)).toFixed(1);
  const y = (v) => (T + (1 - v / 100) * (H - T - B)).toFixed(1);
  const temps = c.temps.filter((p) => p.v !== null && p.v !== undefined);
  const tMin = temps.length ? Math.floor(Math.min(...temps.map((p) => p.v)) - 2) : 0, tMax = temps.length ? Math.ceil(Math.max(...temps.map((p) => p.v)) + 2) : 1;
  const yt = (v) => (T + (1 - (v - tMin) / Math.max(1, tMax - tMin)) * (H - T - B)).toFixed(1);
  const step = (pts, holdTo) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.v)} H${x(pts[i + 1] ? pts[i + 1].t : holdTo)}`).join(' ');
  const grid = [0, 50, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="wxc-grid"/><text x="4" y="${Number(y(v)) + 4}" class="wxc-ax">${v}%</text>`).join('');
  const tempPath = temps.length > 1 ? `<path d="${temps.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${yt(p.v)}`).join(' ')}" class="wxc-temp"/><text x="${W - R + 4}" y="${yt(temps.at(-1).v)}" class="wxc-ax">${temps.at(-1).v.toFixed(0)}°F</text>` : '';
  const mk = c.market.length > 1 ? `<path d="${c.market.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.v)} H${x(c.market[i + 1] ? c.market[i + 1].t : p.t)}`).join(' ')}" class="wxc-mkt"/>` : '';
  const pb = c.pbe.length ? `<path d="${step(c.pbe, c.to)}" class="wxc-pbe"/>${c.pbe.map((p) => `<circle cx="${x(p.t)}" cy="${y(p.v)}" r="${p.pre ? 3.5 : 4.5}" class="${p.pre ? 'wxc-pre' : 'wxc-dot'}"><title>${p.pre ? 'Pre-window PBE (frozen)' : 'Live PBE'} ${p.v}%</title></circle>`).join('')}` : '';
  return `<figure class="wx-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Today: PBE path, Kalshi stored observations and station temperature">${grid}${tempPath}${mk}${pb}</svg>
<figcaption><span><i class="k-pbe"></i>PBE (dots = immutable forecasts; first = frozen pre-window)</span><span><i class="k-mkt"></i>Kalshi (stored observations)</span><span><i class="k-temp"></i>Station temperature (°F, right)</span></figcaption></figure>`;
}

export function liveWeatherBlock(h) {
  const w = h?.intel;
  if (!w) return '';
  const o = w.observed; const fr = o.freshness;
  const headline = [o.temp_f !== null && o.temp_f !== undefined ? `${o.temp_f.toFixed(0)}°F` : null, o.text, o.high_f !== null && o.high_f !== undefined ? `Observed high ${o.high_f.toFixed(1).replace(/\.0$/, '')}°F` : null].filter(Boolean).join(' · ');
  const why = w.why.length ? `<div class="wx-why"><h3>Why PBE moved</h3><ul>${w.why.map((x) => `<li><span>${esc(x.label)}</span><b class="num">${esc(x.value)}</b>${x.prev !== null && x.prev !== x.value ? `<small>was ${esc(x.prev)}</small>` : ''}</li>`).join('')}${w.previous ? `<li><span>Previous live PBE</span><b class="num">${pct(w.previous.pct)}</b><small>${hm(w.previous.at)}</small></li>` : ''}${w.pbe ? `<li><span>Current live PBE</span><b class="num">${pct(w.pbe.pct)}</b><small>${hm(w.pbe.at)}</small></li>` : ''}</ul><p class="note">Every value above is the stored input of an immutable forecast (${esc(w.pbe?.model || '')} · ${esc((w.pbe?.state || '').toLowerCase())}).</p></div>` : '';
  const dis = w.disagreement ? `<div class="wx-disagree" role="note"><span class="wx-tag">MARKET DISAGREEMENT</span><p><b>PBE ${esc((w.pbe?.state || '').toUpperCase())} ${pct(w.pbe?.pct)}</b> · Kalshi ${pct(w.market?.pct)} · gap <b class="num">${sign(w.gap)} pts</b></p><p class="note">What PBE sees: the inputs listed in “Why PBE moved”. What this model does not yet see: ${w.disagreement.not_yet_modeled.map(esc).join('; ')}. The forecast is never adjusted toward a market, and a research-stage model’s gap is not an edge.</p></div>` : '';
  const tl = (w.prewindow || w.revisions.length) ? `<div class="wx-timeline"><h3>Live timeline</h3><ol>${w.prewindow ? `<li><time>${hm(w.prewindow.at)}</time><b>PRE-WINDOW PBE · ${pct(w.prewindow.pct)}</b><small>${esc(w.prewindow.model)} · frozen</small></li>` : ''}${w.revisions.map((r) => `<li><time>${hm(r.t)}</time><b>LIVE PBE · ${pct(r.pct)}</b><small>${esc(r.cause.join(' · '))}</small></li>`).join('')}</ol></div>` : '';
  return `<section class="card panel wx-live" aria-labelledby="wx-h"><div class="live-head"><h2 id="wx-h">Live weather · ${esc(title(w.station.name))}</h2>${fr ? `<span class="fresh fresh-${esc(fr.toLowerCase())}">${esc(fr)}</span>` : ''}</div>
<p class="wx-now"><b>${esc(headline || 'Awaiting a station report')}</b></p>
<p class="wx-sub">${w.guidance ? `Guidance day high ${esc(String(w.guidance.high_f))}°F · ` : ''}${w.pbe ? `PBE ${esc(h.label)}: <b>${pct(w.pbe.pct)}</b> · ` : ''}${w.market ? `Market: <b>${pct(w.market.pct)}</b>${w.gap !== null ? ` · PBE ${sign(w.gap)} pts vs market` : ''} · ` : ''}Updated ${hm(o.at)} · NWS / ASOS ${esc(w.station.icao)}</p>
${dis}${why}${chart(w.chart)}${tl}</section>`;
}
