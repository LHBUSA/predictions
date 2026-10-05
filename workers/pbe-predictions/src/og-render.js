// Social card (1200x630) as SVG. Pure function: the Worker rasterizes it with resvg (src/og.js); tests and
// scripts/brand can render it locally. Every number on a card is passed in from a stored forecast/observation.
import metrics from './font-metrics.json' with { type: 'json' };
import { WORDMARK_DARK } from './brand-svg.js';

const W = 1200; const H = 630;
// Inter latin subset: map glyphs it lacks to safe equivalents.
const GLYPH = { '≥': '>=', '≤': '<=', '→': '-', '≈': '~' };
const x = (s) => String(s ?? '').replace(/[≥≤→≈]/g, (c) => GLYPH[c]).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function textWidth(s, px, weight = 800) {
  const m = metrics[String(weight)];
  let w = 0;
  for (const ch of String(s)) w += m[ch] ?? 0.6;
  return w * px;
}

export function wrap(text, px, maxWidth, maxLines, weight = 800) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (textWidth(next, px, weight) <= maxWidth || !cur) cur = next;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && textWidth(`${last}…`, px, weight) > maxWidth) last = last.split(' ').slice(0, -1).join(' ');
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

const TONE = { pbe: '#8cc2ff', market: '#c9d6e6', pos: '#5fe0a8', neg: '#ff9b8a', neutral: '#ffffff' };

// stats: up to 3 tiles {label, value, sub?, tone}; flow: optional {from, to} (forecast-change hero)
export function cardSvg({ eyebrow, badge, title, subtitle, stats = [], flow = null, footer, bgDataUri = null }) {
  const titlePx = title.length > 70 ? 44 : 50;
  const lines = wrap(title, titlePx, 1060, 3);
  const titleY = 196;
  const lh = titlePx * 1.12;
  const lastBaseline = titleY + (lines.length - 1) * lh + titlePx * 0.8;
  const subBaseline = lastBaseline + 50;
  const statsY = Math.max((subtitle ? subBaseline : lastBaseline) + 44, 384);
  const eyebrowW = textWidth(eyebrow, 17, 700) + 2.5 * eyebrow.length;
  let tiles = '';
  if (flow) {
    tiles = `<text x="64" y="${statsY + 86}" font-family="Inter" font-weight="800" font-size="104" fill="${TONE.market}">${x(flow.from)}</text>
<path d="M${64 + textWidth(flow.from, 104) + 30},${statsY + 50} h58 m-22,-22 l22,22 l-22,22" fill="none" stroke="#4f7fbf" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
<text x="${64 + textWidth(flow.from, 104) + 120}" y="${statsY + 86}" font-family="Inter" font-weight="800" font-size="104" fill="${TONE.pbe}">${x(flow.to)}</text>
${flow.label ? `<text x="64" y="${statsY + 130}" font-family="Inter" font-weight="700" font-size="20" fill="#9fb3c9">${x(flow.label)}</text>` : ''}`;
  } else if (stats.length) {
    const tw = 330; const gap = 22;
    tiles = stats.slice(0, 3).map((s, i) => {
      const tx = 64 + i * (tw + gap);
      return `<rect x="${tx}" y="${statsY}" width="${tw}" height="140" rx="18" fill="#0a1d36" fill-opacity=".82" stroke="#7fa6d6" stroke-opacity=".22"/>
<text x="${tx + 24}" y="${statsY + 38}" font-family="Inter" font-weight="700" font-size="17" letter-spacing="2" fill="#9fb3c9">${x(s.label.toUpperCase())}</text>
<text x="${tx + 22}" y="${statsY + 104}" font-family="Inter" font-weight="800" font-size="${String(s.value).length > 7 ? 46 : 62}" fill="${TONE[s.tone] || TONE.neutral}">${x(s.value)}</text>
${s.sub ? `<text x="${tx + 24}" y="${statsY + 128}" font-family="Inter" font-weight="500" font-size="15" fill="#8fa5bd">${x(s.sub)}</text>` : ''}`;
    }).join('\n');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#020a16"/>
${bgDataUri ? `<image href="${bgDataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` : ''}
<rect x="0" y="0" width="${W}" height="6" fill="#3f8cff"/>
<svg x="64" y="44" width="230" height="54" viewBox="0 0 272 64">${WORDMARK_DARK.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replace(/<title>.*?<\/title>/, '')}</svg>
<rect x="64" y="122" width="${eyebrowW + 28}" height="34" rx="8" fill="#3f8cff" fill-opacity=".16" stroke="#3f8cff" stroke-opacity=".45"/>
<text x="78" y="145" font-family="Inter" font-weight="700" font-size="17" letter-spacing="2.5" fill="#8cc2ff">${x(eyebrow)}</text>
${badge ? `<text x="${64 + eyebrowW + 46}" y="145" font-family="Inter" font-weight="700" font-size="17" letter-spacing="2" fill="#9fb3c9">${x(badge)}</text>` : ''}
${lines.map((l, i) => `<text x="64" y="${titleY + i * lh + titlePx * 0.8}" font-family="Inter" font-weight="800" font-size="${titlePx}" fill="#ffffff">${x(l)}</text>`).join('\n')}
${subtitle ? `<text x="64" y="${subBaseline}" font-family="Inter" font-weight="500" font-size="23" fill="#b9c8d9">${x(wrap(subtitle, 23, 1060, 1, 500)[0])}</text>` : ''}
${tiles}
<text x="64" y="598" font-family="Inter" font-weight="500" font-size="17" fill="#8fa5bd">${x(footer)}</text>
<text x="1136" y="598" text-anchor="end" font-family="Inter" font-weight="700" font-size="17" fill="#e8f0fa">predictions.propbetedge.ai</text>
</svg>`;
}

const utc = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Public event card from the public shell (premium.js publicEventShell): Predictions is an All Access product, so the
// card carries no PBE probability, market price or divergence — only what the public page shows.
export function eventCard(shell) {
  const e = shell.event;
  return cardSvg({
    eyebrow: e.category_label.toUpperCase(),
    badge: shell.modeled ? 'PBE FORECAST · ALL ACCESS' : 'MARKET MONITORING · ALL ACCESS',
    title: e.title,
    subtitle: 'Independent probability. Auditable decisions.',
    stats: [{ label: 'Outcomes', value: String(shell.outcomes.length), tone: 'neutral' }, { label: 'Closes', value: day(e.close_time), tone: 'neutral', sub: utc(e.close_time) }, { label: 'All Access', value: '$29/mo', tone: 'pbe' }],
    footer: 'Included with PropBetEdge All Access',
  });
}
