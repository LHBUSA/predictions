import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('Market Intelligence is a Predictions All Access product with no retired PropTechUSA customer links', () => {
  const html = read('markets/index.html');
  const js = read('markets/market-intelligence.js');
  assert.match(html, /PROPBETEDGE PREDICTIONS · ALL ACCESS/);
  assert.match(html, /TRADE LAB/);
  assert.match(html, /live equities, crypto and macro context/i);
  assert.doesNotMatch(html + js, /localhomebuyersusa|PropTechUSA|Landlord|STR|trade\.proptechusa\.ai|markets\.proptechusa\.ai/i);
});

test('Market Intelligence premium APIs fail through the shared All Access authority and use OpenAI', () => {
  for (const p of ['api/market-intelligence/market.js','api/market-intelligence/stream.js','api/market-intelligence/debate.js','api/market-intelligence/chart.js']) {
    const src = read(p);
    assert.match(src, /requireAllAccess/);
  }
  const core = read('src/market-intelligence-server.js');
  const chart = read('api/market-intelligence/chart.js');
  assert.match(core + chart, /api\.openai\.com\/v1\/responses/);
  assert.match(core + chart, /OPENAI_API_KEY/);
  assert.doesNotMatch(core + chart, /anthropic|claude/i);
});

test('Trade Lab is analysis, not position sizing or buy-sell instruction', () => {
  const chart = read('api/market-intelligence/chart.js');
  assert.match(chart, /Do not tell the user to buy, sell, enter, exit, size a position/);
  assert.match(chart, /risk\/reward/);
  assert.match(chart, /invalidation/i);
});
