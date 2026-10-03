// Predictions editorial art — original, code-generated compositions (owned by PropBetEdge; no stock, no third-party
// imagery). Each master is 2400x1350 (16:9), text-free and number-free: live or story numbers are rendered as
// separate deterministic overlays (HTML hero, server-rendered social card), never baked into the art.
//   node scripts/brand/editorial-art.mjs   -> images/insights/_masters/<key>.svg + .png
import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const W = 2400; const H = 1350;
const OUT = 'images/insights/_masters';
mkdirSync(OUT, { recursive: true });

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const f = (n) => n.toFixed(1);
const svg = (defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
<filter id="glow2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28"/></filter>
<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
<radialGradient id="vignette" cx="50%" cy="50%" r="75%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".55"/></radialGradient>
</defs>${body}<rect width="${W}" height="${H}" fill="url(#vignette)"/></svg>`;

function plane(x, y, s, fill, light = true) {
  // distant airliner, side profile; s = scale (1 = 120 px long)
  const p = (px, py) => `${f(x + px * s)},${f(y + py * s)}`;
  return `<g fill="${fill}"><path d="M${p(-60, -3)} L${p(48, -4)} Q${p(62, -3)} ${p(60, 2)} L${p(-56, 4)} Z"/>
<path d="M${p(-58, -2)} L${p(-66, -22)} L${p(-56, -22)} L${p(-44, -3)} Z"/><path d="M${p(-8, 1)} L${p(-26, 12)} L${p(-16, 12)} L${p(6, 2)} Z"/>
<path d="M${p(-62, -1)} L${p(-72, 3)} L${p(-56, 3)} Z"/></g>${light ? `<circle cx="${f(x + 58 * s)}" cy="${f(y)}" r="${f(2.2 * s)}" fill="#ffd9a8"/><circle cx="${f(x - 64 * s)}" cy="${f(y - 20 * s)}" r="${f(1.8 * s)}" fill="#ff6b6b"/>` : ''}`;
}

// ---------------------------------------------------------------- 1. LAX: the last few degrees
function heatColumns() {
  let out = '';
  for (let i = 0; i < 14; i += 1) { const x = 900 + i * 95; let d = `M${x},790`; for (let y = 790; y >= 600; y -= 10) d += ` L${f(x + 9 * Math.sin(y / 17 + i))},${y}`; out += `<path d="${d}" stroke="#ffd9b0" stroke-opacity=".08" stroke-width="7" fill="none" filter="url(#soft)"/>`; }
  return out;
}
function lax() {
  const r = rng(99);
  const hz = 790; const vp = [1520, hz];
  const sky = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#04101f"/><stop offset=".3" stop-color="#0d2a50"/><stop offset=".48" stop-color="#28466b"/><stop offset=".56" stop-color="#7b6a63"/><stop offset=".585" stop-color="#c79a74"/><stop offset=".6" stop-color="#3a4258"/><stop offset="1" stop-color="#050c18"/></linearGradient>
<radialGradient id="sun" cx="0.69" cy="0.45" r="0.55"><stop offset="0" stop-color="#fff1dc" stop-opacity="1"/><stop offset=".07" stop-color="#ffd2a1" stop-opacity=".8"/><stop offset=".22" stop-color="#ffb079" stop-opacity=".32"/><stop offset=".5" stop-color="#ff8f5a" stop-opacity=".1"/><stop offset="1" stop-color="#ff8f5a" stop-opacity="0"/></radialGradient>
<linearGradient id="tarmac" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2232"/><stop offset=".35" stop-color="#0e1626"/><stop offset="1" stop-color="#060b14"/></linearGradient>
<linearGradient id="heat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb079" stop-opacity="0"/><stop offset=".6" stop-color="#ffb079" stop-opacity=".22"/><stop offset="1" stop-color="#ffb079" stop-opacity="0"/></linearGradient>
<linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f8cff" stop-opacity="0"/><stop offset=".5" stop-color="#3f8cff" stop-opacity=".9"/><stop offset="1" stop-color="#3f8cff" stop-opacity=".2"/></linearGradient>
<filter id="shimmer" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.06" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="26" xChannelSelector="R" yChannelSelector="G"/></filter>`;
  let stars = '';
  for (let i = 0; i < 0; i += 1) stars += `<circle cx="${f(r() * W)}" cy="${f(r() * 420)}" r="${f(0.6 + r() * 1.3)}" fill="#cfe2ff" opacity="${f(0.15 + r() * 0.5)}"/>`;
  // terrain + ocean + airport structures on the horizon
  let hills = `M0,${hz - 6}`; for (let x = 0; x <= W; x += 40) hills += ` L${x},${f(hz - 10 - 26 * Math.max(0, Math.sin(x / 520 + 1.2)) - 8 * Math.sin(x / 90) - (x < 700 ? 18 * Math.sin(x / 260) ** 2 : 0))}`; hills += ` L${W},${hz + 6} L0,${hz + 6} Z`;
  let city = '';
  for (let x = 120; x < W - 60; x += 14 + r() * 22) { const h = 6 + r() * (x > 2000 ? 40 : 18); city += `<rect x="${f(x)}" y="${f(hz - h)}" width="${f(8 + r() * 16)}" height="${f(h)}" fill="#08111f"/>`; if (r() > 0.5) city += `<circle cx="${f(x + 4)}" cy="${f(hz - h * r())}" r="1.6" fill="#ffd9a8" opacity="${f(0.4 + r() * 0.5)}"/>`; }
  const tower = `<g fill="#08111f"><rect x="610" y="${hz - 150}" width="14" height="150"/><path d="M588,${hz - 150} h58 l-8,-26 h-42 Z"/><rect x="592" y="${hz - 182}" width="50" height="8"/></g><rect x="596" y="${hz - 172}" width="42" height="12" fill="#8cc2ff" opacity=".55"/>`;
  // runway in perspective, threshold "piano keys" in the foreground (the contract threshold motif)
  const [vx, vy] = vp;
  const L = (t, side) => { const xb = side < 0 ? -500 : 3300; return [vx - 46 * (side < 0 ? 1 : -1) + (xb - (vx - 46 * (side < 0 ? 1 : -1))) * t, vy + 4 + (H - vy - 4) * t]; };
  const left = (t) => L(t, -1); const right = (t) => L(t, 1);
  const pt = (a) => `${f(a[0])},${f(a[1])}`;
  const runway = `<path d="M${pt(left(0))} L${pt(right(0))} L${pt(right(1))} L${pt(left(1))} Z" fill="url(#tarmac)"/>`;
  let marks = '';
  const T = (k) => (Math.exp(k * 2.4) - 1) / (Math.exp(2.4) - 1); // perspective spacing
  for (let k = 0.04; k < 0.86; k += 0.045) { const t0 = T(k); const t1 = T(k + 0.02); const c0 = [(left(t0)[0] + right(t0)[0]) / 2, left(t0)[1]]; const c1 = [(left(t1)[0] + right(t1)[0]) / 2, left(t1)[1]]; const w0 = (right(t0)[0] - left(t0)[0]) * 0.008; const w1 = (right(t1)[0] - left(t1)[0]) * 0.008; marks += `<path d="M${f(c0[0] - w0)},${f(c0[1])} L${f(c0[0] + w0)},${f(c0[1])} L${f(c1[0] + w1)},${f(c1[1])} L${f(c1[0] - w1)},${f(c1[1])} Z" fill="#e8f0fa" opacity="${f(0.25 + 0.5 * t0)}"/>`; }
  // threshold piano keys near the bottom
  const tk0 = T(0.9); const tk1 = T(0.97);
  for (let i = 0; i < 16; i += 1) {
    const u0 = 0.06 + i * 0.056; const u1 = u0 + 0.03; if (u0 > 0.47 && u0 < 0.53) continue;
    const at = (t, u) => [left(t)[0] + (right(t)[0] - left(t)[0]) * u, left(t)[1]];
    marks += `<path d="M${pt(at(tk0, u0))} L${pt(at(tk0, u1))} L${pt(at(tk1, u1))} L${pt(at(tk1, u0))} Z" fill="#e8f0fa" opacity=".62"/>`;
  }
  let lights = '';
  for (let k = 0.02; k < 1; k += 0.035) { const t = T(k); for (const side of [left, right]) { const [x, y] = side(t); const rr = 1.2 + 9 * t; lights += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(rr * 2.6)}" fill="#3f8cff" opacity=".18" filter="url(#soft)"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(rr)}" fill="#bfdcff"/>`; } }
  // heat shimmer bands over the far runway
  let shimmer = '';
  for (let i = 0; i < 9; i += 1) { const y = hz - 34 + i * 9; let d = `M${f(vx - 900)},${y}`; for (let x = vx - 900; x <= vx + 900; x += 30) d += ` L${x},${f(y + 3 * Math.sin(x / 37 + i))}`; shimmer += `<path d="${d}" stroke="#ffcf9e" stroke-opacity="${f(0.05 + 0.04 * (i % 3))}" stroke-width="3" fill="none"/>`; }
  // probability motif: a distribution in the sky, with the thin tail beyond the threshold beam highlighted
  const thrX = 1990; const base = hz - 30; const mu = 1540; const sd = 210; const amp = 360;
  let curve = ''; let tail = `M${thrX},${base}`;
  for (let x = 900; x <= 2300; x += 10) { const y = base - amp * Math.exp(-0.5 * ((x - mu) / sd) ** 2); curve += `${curve ? ' L' : 'M'}${x},${f(y)}`; if (x >= thrX) tail += ` L${x},${f(y)}`; }
  tail += ` L2300,${base} Z`;
  const motif = `<path d="${curve}" fill="none" stroke="#8cc2ff" stroke-opacity=".55" stroke-width="3"/><path d="${curve} L2300,${base} L900,${base} Z" fill="#3f8cff" fill-opacity=".07"/><path d="${tail}" fill="#3f8cff" fill-opacity=".55"/>
<rect x="${thrX - 2}" y="120" width="4" height="${H - 120}" fill="url(#beam)"/><rect x="${thrX - 14}" y="120" width="28" height="${H - 120}" fill="#3f8cff" opacity=".08" filter="url(#glow)"/>${Array.from({ length: 16 }, (_, i) => `<line x1="${thrX - (i % 5 === 0 ? 22 : 11)}" x2="${thrX}" y1="${180 + i * 34}" y2="${180 + i * 34}" stroke="#8cc2ff" stroke-opacity="${i % 5 === 0 ? 0.8 : 0.45}" stroke-width="2"/>`).join('')}`;
  return svg(sky, `<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars}<rect width="${W}" height="${H}" fill="url(#sun)"/>
<circle cx="1660" cy="610" r="210" fill="#fff4e4" opacity=".55" filter="url(#glow2)"/><circle cx="1660" cy="610" r="96" fill="#fff6ea" opacity=".95" filter="url(#soft)"/>
${plane(1985, 470, 1.25, '#0a1424')}${tower}<g filter="url(#shimmer)"><rect x="0" y="${hz - 160}" width="${W}" height="175" fill="url(#heat)"/><path d="${hills}" fill="#1a2436"/>${city}${plane(1410, hz - 8, 0.6, '#0c1626')}${plane(1660, hz - 6, 0.42, '#0c1626', false)}</g>${heatColumns()}
<rect x="0" y="${hz}" width="${W}" height="${H - hz}" fill="#060d19"/>
<path d="M0,${hz + 2} L760,${hz + 2} L760,${hz + 6} L0,${hz + 10} Z" fill="#7aa7dc" opacity=".35"/>
${runway}${marks}${lights}<g filter="url(#shimmer)">${shimmer}</g>${motif}`);
}

// ---------------------------------------------------------------- 2. Treasury: the 7-year, isolated
function treasury() {
  const r = rng(7);
  const defs = `<radialGradient id="bg" cx=".62" cy=".42" r=".8"><stop offset="0" stop-color="#0e2a52"/><stop offset=".55" stop-color="#061427"/><stop offset="1" stop-color="#020812"/></radialGradient>
<linearGradient id="vbeam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f8cff" stop-opacity="0"/><stop offset=".45" stop-color="#3f8cff" stop-opacity=".85"/><stop offset="1" stop-color="#3f8cff" stop-opacity="0"/></linearGradient>
<linearGradient id="fan" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8cc2ff" stop-opacity=".5"/><stop offset="1" stop-color="#8cc2ff" stop-opacity="0"/></linearGradient>`;
  let grid = '';
  for (let x = 0; x <= W; x += 60) grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#3f8cff" stroke-opacity="${x % 300 === 0 ? 0.1 : 0.035}"/>`;
  for (let y = 0; y <= H; y += 60) grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#3f8cff" stroke-opacity="${y % 300 === 0 ? 0.1 : 0.035}"/>`;
  const tenors = [1 / 12, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
  const X = (t) => 200 + (Math.log(t * 12) / Math.log(360)) * 1500;
  const Y = (t) => 760 - 230 * (1 - Math.exp(-t / 6)) + 30 * Math.exp(-t / 0.4);
  const pts = tenors.map((t) => [X(t), Y(t)]);
  const smooth = (p) => p.map((q, i) => (i ? `S${f((p[i - 1][0] + q[0]) / 2 + 30)},${f(q[1])} ${f(q[0])},${f(q[1])}` : `M${f(q[0])},${f(q[1])}`)).join(' ');
  const prev = tenors.map((t) => [X(t), Y(t) + 26 + 10 * Math.sin(t)]);
  const k = pts[7];
  // Monte Carlo path fan from the 7-year node: the path model's view of the rest of the month
  let paths = ''; const thr = k[1] + 70; let hit = 0;
  for (let i = 0; i < 90; i += 1) {
    let x = k[0]; let y = k[1]; let d = `M${f(x)},${f(y)}`; let crossed = false;
    for (let s = 0; s < 19; s += 1) { x += 34; y += (r() - 0.5) * 34; d += ` L${f(x)},${f(y)}`; if (y > thr) crossed = true; }
    if (crossed) hit += 1;
    paths += `<path d="${d}" fill="none" stroke="${crossed ? '#8cc2ff' : '#5d7fae'}" stroke-opacity="${crossed ? 0.42 : 0.16}" stroke-width="${crossed ? 2.2 : 1.6}"/>`;
  }
  let ticks = '';
  for (const t of tenors) ticks += `<line x1="${f(X(t))}" y1="1120" x2="${f(X(t))}" y2="${t === 7 ? 1150 : 1136}" stroke="${t === 7 ? '#8cc2ff' : '#5d7288'}" stroke-width="${t === 7 ? 4 : 2}"/>`;
  let rings = '';
  for (let i = 1; i <= 5; i += 1) rings += `<circle cx="${f(k[0])}" cy="${f(k[1])}" r="${18 + i * 26}" fill="none" stroke="#3f8cff" stroke-opacity="${f(0.5 - i * 0.08)}" stroke-width="2"/>`;
  return svg(defs, `<rect width="${W}" height="${H}" fill="url(#bg)"/>${grid}
<rect x="${f(k[0] - 2)}" y="0" width="4" height="${H}" fill="url(#vbeam)"/><rect x="${f(k[0] - 70)}" y="0" width="140" height="${H}" fill="#3f8cff" opacity=".05"/>
<line x1="${f(k[0])}" y1="${f(thr)}" x2="${f(k[0] + 700)}" y2="${f(thr)}" stroke="#e8f0fa" stroke-opacity=".5" stroke-width="2" stroke-dasharray="10 10"/>
${paths}
<path d="${smooth(prev)}" fill="none" stroke="#5d7fae" stroke-opacity=".45" stroke-width="3" stroke-dasharray="12 10"/>
<path d="${smooth(pts)}" fill="none" stroke="#3f8cff" stroke-width="16" stroke-opacity=".35" filter="url(#glow)"/>
<path d="${smooth(pts)}" fill="none" stroke="#bcd9ff" stroke-width="4.5"/>
${pts.map((q, i) => (i === 7 ? '' : `<circle cx="${f(q[0])}" cy="${f(q[1])}" r="7" fill="#0b2547" stroke="#8cc2ff" stroke-width="3"/>`)).join('')}
${rings}<circle cx="${f(k[0])}" cy="${f(k[1])}" r="34" fill="#3f8cff" opacity=".35" filter="url(#glow)"/><circle cx="${f(k[0])}" cy="${f(k[1])}" r="15" fill="#fff"/>
<line x1="200" y1="1120" x2="1700" y2="1120" stroke="#5d7288" stroke-opacity=".6" stroke-width="2"/>${ticks}`);
}

// ---------------------------------------------------------------- 3. Same data, two guidance systems
function twoGuidance() {
  const r = rng(4);
  const O = [1200, 700];
  const defs = `<radialGradient id="bg" cx=".5" cy=".52" r=".75"><stop offset="0" stop-color="#0d2448"/><stop offset=".6" stop-color="#050f20"/><stop offset="1" stop-color="#02070f"/></radialGradient>
<clipPath id="leftHalf"><rect x="0" y="0" width="1200" height="${H}"/></clipPath><clipPath id="rightHalf"><rect x="1200" y="0" width="1200" height="${H}"/></clipPath>
<radialGradient id="origin" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffffff"/><stop offset=".25" stop-color="#bcd9ff" stop-opacity=".9"/><stop offset="1" stop-color="#3f8cff" stop-opacity="0"/></radialGradient>`;
  const field = (cx, cy, k1, k2, ph, color) => {
    let out = '';
    for (let i = 1; i <= 14; i += 1) {
      const r0 = 40 + i * 46; let d = '';
      for (let a = 0; a <= 360; a += 4) { const t = (a * Math.PI) / 180; const rr = r0 * (1 + k1 * Math.sin(3 * t + ph + i * 0.18) + k2 * Math.sin(5 * t - ph * 1.7)); d += `${d ? ' L' : 'M'}${f(cx + rr * Math.cos(t))},${f(cy + rr * 0.72 * Math.sin(t))}`; }
      out += `<path d="${d} Z" fill="none" stroke="${color}" stroke-opacity="${f(0.62 - i * 0.035)}" stroke-width="${i % 4 === 0 ? 3 : 1.6}"/>`;
    }
    return out;
  };
  // shared city grid in perspective (the same underlying place)
  let city = ''; const hz = 900;
  for (let i = -24; i <= 24; i += 1) city += `<line x1="${O[0] + i * 12}" y1="${hz}" x2="${O[0] + i * 140}" y2="${H}" stroke="#3f8cff" stroke-opacity=".14"/>`;
  for (let j = 0; j < 12; j += 1) { const y = hz + (H - hz) * ((Math.exp(j / 4) - 1) / (Math.exp(11 / 4) - 1)); city += `<line x1="0" y1="${f(y)}" x2="${W}" y2="${f(y)}" stroke="#3f8cff" stroke-opacity=".12"/>`; }
  for (let i = 0; i < 260; i += 1) { const y = hz + (H - hz) * r() ** 1.6; const spread = (y - hz) / (H - hz); city += `<circle cx="${f(O[0] + (r() - 0.5) * 3200 * spread + (r() - 0.5) * 300)}" cy="${f(y)}" r="${f(1 + 2.4 * spread)}" fill="${r() > 0.7 ? '#ffd9a8' : '#bcd9ff'}" opacity="${f(0.25 + 0.5 * r())}"/>`; }
  // two diverging streamline bundles from the same origin
  let streams = '';
  for (let i = 0; i < 22; i += 1) {
    const s = (i - 10.5) * 6;
    streams += `<path d="M${O[0]},${O[1]} C${O[0] - 120 - s},${O[1] - 200} ${O[0] - 520 - s * 3},${O[1] - 300 + s} ${O[0] - 980 - s * 4},${O[1] - 470 + s * 2}" fill="none" stroke="#9b85ff" stroke-opacity="${f(0.1 + 0.25 * r())}" stroke-width="2"/>`;
    streams += `<path d="M${O[0]},${O[1]} C${O[0] + 120 + s},${O[1] - 200} ${O[0] + 560 + s * 3},${O[1] - 250 + s} ${O[0] + 1000 + s * 4},${O[1] - 360 + s * 2}" fill="none" stroke="#5aa2ff" stroke-opacity="${f(0.1 + 0.25 * r())}" stroke-width="2"/>`;
  }
  return svg(defs, `<rect width="${W}" height="${H}" fill="url(#bg)"/>
<g clip-path="url(#leftHalf)">${field(O[0] - 140, O[1] - 40, 0.1, 0.05, 0.3, '#a68bff')}</g>
<g clip-path="url(#rightHalf)">${field(O[0] + 160, O[1] - 70, 0.07, 0.08, 1.9, '#5aa2ff')}</g>
<rect x="1198" y="0" width="4" height="${O[1]}" fill="#e8f0fa" opacity=".22"/>
${city}${streams}
<circle cx="${O[0]}" cy="${O[1]}" r="130" fill="url(#origin)" opacity=".75"/><circle cx="${O[0]}" cy="${O[1]}" r="13" fill="#fff"/>
<rect x="0" y="0" width="${W}" height="${H}" fill="none"/>`);
}

// ---------------------------------------------------------------- category fallbacks (automated stories)
function category(key) {
  const r = rng(key.length * 97 + key.charCodeAt(0));
  const bg = `<radialGradient id="bg" cx=".68" cy=".45" r=".8"><stop offset="0" stop-color="#0e2a52"/><stop offset=".6" stop-color="#051226"/><stop offset="1" stop-color="#020812"/></radialGradient>`;
  let body = `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  const c = '#5aa2ff';
  if (key === 'weather') {
    for (let i = 1; i <= 16; i += 1) { let d = ''; for (let a = 0; a <= 360; a += 4) { const t = (a * Math.PI) / 180; const rr = 50 + i * 60 + 22 * Math.sin(3 * t + i * 0.4); d += `${d ? ' L' : 'M'}${f(1650 + rr * Math.cos(t))},${f(560 + rr * 0.7 * Math.sin(t))}`; } body += `<path d="${d} Z" fill="none" stroke="${c}" stroke-opacity="${f(0.55 - i * 0.03)}" stroke-width="${i % 4 ? 1.6 : 3}"/>`; }
    for (let i = 0; i < 60; i += 1) { const x = 300 + r() * 1900; const y = 200 + r() * 950; body += `<path d="M${f(x)},${f(y)} l${f(26 + r() * 30)},${f(-8 + r() * 16)}" stroke="#bcd9ff" stroke-opacity=".25" stroke-width="2"/>`; }
  } else if (key === 'rates' || key === 'economics') {
    for (let x = 0; x <= W; x += 60) body += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${c}" stroke-opacity=".05"/>`;
    for (let y = 0; y <= H; y += 60) body += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${c}" stroke-opacity=".05"/>`;
    if (key === 'rates') { let d = ''; for (let x = 200; x <= 2200; x += 20) d += `${d ? ' L' : 'M'}${x},${f(800 - 260 * (1 - Math.exp(-(x - 200) / 600)))}`; body += `<path d="${d}" fill="none" stroke="${c}" stroke-width="14" stroke-opacity=".3" filter="url(#glow)"/><path d="${d}" fill="none" stroke="#bcd9ff" stroke-width="4"/>`; }
    else for (let i = 0; i < 26; i += 1) { const h = 120 + 420 * (0.5 + 0.5 * Math.sin(i / 3)) * (0.7 + 0.3 * r()); body += `<rect x="${300 + i * 70}" y="${f(1050 - h)}" width="40" height="${f(h)}" rx="6" fill="${c}" fill-opacity="${f(0.18 + (i === 18 ? 0.5 : 0))}"/>`; }
  } else if (key === 'space') {
    body += `<circle cx="2050" cy="1550" r="900" fill="#0b2547" stroke="${c}" stroke-opacity=".35" stroke-width="3"/>`;
    for (let i = 1; i <= 5; i += 1) body += `<ellipse cx="1200" cy="760" rx="${260 + i * 180}" ry="${90 + i * 60}" fill="none" stroke="${c}" stroke-opacity="${f(0.45 - i * 0.06)}" stroke-width="2" transform="rotate(-12 1200 760)"/>`;
    for (let i = 0; i < 220; i += 1) body += `<circle cx="${f(r() * W)}" cy="${f(r() * H)}" r="${f(0.6 + r() * 1.6)}" fill="#cfe2ff" opacity="${f(0.15 + r() * 0.6)}"/>`;
  } else if (key === 'public-health') {
    const nodes = Array.from({ length: 70 }, () => [300 + r() * 1900, 160 + r() * 1000]);
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) { const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]); if (d < 190) body += `<line x1="${f(nodes[i][0])}" y1="${f(nodes[i][1])}" x2="${f(nodes[j][0])}" y2="${f(nodes[j][1])}" stroke="${c}" stroke-opacity=".22"/>`; }
    for (const n of nodes) body += `<circle cx="${f(n[0])}" cy="${f(n[1])}" r="${f(4 + r() * 6)}" fill="#bcd9ff" opacity=".7"/>`;
  } else if (key === 'energy') {
    for (let k = 0; k < 6; k += 1) { let d = ''; for (let x = 0; x <= W; x += 12) d += `${d ? ' L' : 'M'}${x},${f(675 + (120 - k * 14) * Math.sin(x / (140 + k * 20) + k))}`; body += `<path d="${d}" fill="none" stroke="${c}" stroke-opacity="${f(0.55 - k * 0.07)}" stroke-width="${k ? 2 : 5}"/>`; }
  } else {
    for (let i = 0; i < 9; i += 1) for (let j = 0; j < 5; j += 1) { const h = 60 + r() * 260; body += `<rect x="${500 + i * 170}" y="${f(950 - h - j * 8)}" width="120" height="${f(h)}" rx="8" fill="${c}" fill-opacity="${f(0.06 + r() * 0.12)}" stroke="${c}" stroke-opacity=".25"/>`; }
  }
  return svg(bg, body);
}

const jobs = { 'lax-99': lax(), 'treasury-7y': treasury(), 'two-guidance': twoGuidance() };
for (const k of ['weather', 'rates', 'economics', 'science', 'space', 'public-health', 'energy', 'business']) jobs[`category-${k}`] = category(k);
for (const [k, s] of Object.entries(jobs)) {
  writeFileSync(`${OUT}/${k}.svg`, s);
  const png = new Resvg(s, { fitTo: { mode: 'width', value: W } }).render().asPng();
  writeFileSync(`${OUT}/${k}.png`, png);
  console.log(k, png.length);
}
