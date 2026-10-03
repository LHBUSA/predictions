// Prediction Intelligence evidence contract: stories fail closed without evidence, packets never load SHADOW or
// post-as-of rows, and feeds only list what exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STORIES } from '../workers/pbe-predictions/src/insights/stories.js';
import { loadEventPacket, twoSided } from '../workers/pbe-predictions/src/insights/packet.js';
import { newsSitemapXml, rssXml } from '../workers/pbe-predictions/src/insights/render.js';
import { cardSvg, wrap } from '../workers/pbe-predictions/src/og-render.js';

test('every flagship story fails closed when its evidence packets are missing', () => {
  for (const s of STORIES) {
    const r = s.build({});
    assert.equal(r.ok, false, s.slug);
  }
});

function fakeStore(tables) {
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    if (k === 'select' || typeof v !== 'string') return true;
    const [op, val] = [v.slice(0, v.indexOf('.')), v.slice(v.indexOf('.') + 1)];
    if (op === 'eq') return String(row[k]) === val;
    if (op === 'lte') return Date.parse(row[k]) <= Date.parse(val);
    return true;
  });
  return {
    select: async (t, q) => (tables[t] || []).filter((r) => match(r, q)),
    selectIn: async (t, q, col, ids) => (tables[t] || []).filter((r) => ids.includes(r[col]) && match(r, q)),
  };
}

test('packets exclude SHADOW forecasts and anything captured after the as-of time', async () => {
  const asOf = '2026-10-03T21:00:00Z';
  const store = fakeStore({
    pred_events: [{ event_id: 'E', slug: 'ev', canonical_question: 'Q?', category: 'MACRO', close_time: '2026-10-29T18:00:00Z' }],
    pred_contracts: [{ contract_id: 'C', event_id: 'E', market_id: 'M', outcome_label: 'Hold', normalized_at: '2026-10-03T10:00:00Z', threshold_low: null, threshold_high: null }],
    pred_forecasts: [
      { forecast_id: 'f1', contract_id: 'C', model_id: 'pbe-fed-decision', model_version: '1.0.0', model_state: 'SHADOW', probability: 0.9, market_probability: 0.8, captured_at: '2026-10-03T12:00:00Z', explanation: {} },
      { forecast_id: 'f2', contract_id: 'C', model_id: 'm', model_version: '1.0.0', model_state: 'RESEARCH', probability: 0.4, market_probability: 0.5, captured_at: '2026-10-03T12:00:00Z', explanation: {} },
      { forecast_id: 'f3', contract_id: 'C', model_id: 'm', model_version: '1.0.0', model_state: 'RESEARCH', probability: 0.7, market_probability: 0.5, captured_at: '2026-10-03T22:00:00Z', explanation: {} },
    ],
    pred_venue_snapshots: [{ contract_id: 'C', captured_at: '2026-10-03T20:00:00Z', probability: 0.5, bid: 0.48, ask: 0.52 }, { contract_id: 'C', captured_at: '2026-10-03T23:00:00Z', probability: 0.9, bid: 0.88, ask: 0.92 }],
  });
  const p = await loadEventPacket(store, 'ev', asOf);
  const o = p.outcomes[0];
  assert.deepEqual(o.snapshots.map((s) => s.id), ['f2']);
  assert.deepEqual(o.market_path.map((m) => m.mid), [50]);
  assert.equal(twoSided(o.market_path[0]), true);
});

test('two-sided requires a quote no wider than 10 points', () => {
  assert.equal(twoSided({ bid: 5, ask: 23, mid: null }), false);
  assert.equal(twoSided({ bid: 94, ask: 99, mid: 97 }), true);
});

test('news sitemap lists only stories from the last two days; RSS lists all', () => {
  const mk = (slug, published_at) => ({ story: { slug, published_at, vertical: 'weather' }, built: { title: slug, dek: 'd' } });
  const now = Date.parse('2026-10-06T00:00:00Z');
  const items = [mk('new', '2026-10-05T12:00:00Z'), mk('old', '2026-10-01T12:00:00Z')];
  const news = newsSitemapXml(items, now);
  assert.match(news, /insights\/new</);
  assert.doesNotMatch(news, /insights\/old</);
  assert.equal((rssXml(items).match(/<item>/g) || []).length, 2);
});

test('social card wraps long titles within three lines and renders only supplied numbers', () => {
  const lines = wrap('A very long title '.repeat(12), 50, 1060, 3);
  assert.equal(lines.length, 3);
  const svg = cardSvg({ eyebrow: 'WEATHER', title: 'Title', stats: [{ label: 'PBE model', value: '8%', tone: 'pbe' }], footer: 'As of x' });
  assert.match(svg, />8%</);
  assert.doesNotMatch(svg, /MARKET/);
});
