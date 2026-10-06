import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('market intelligence resolves and researches the requested subject before debate',()=>{
  const server=read('api/market-intelligence/_lib/server.js');
  const debate=read('api/market-intelligence/debate.js');
  assert.match(server,/resolveAndResearchSubject/);
  assert.match(server,/tools:\[\{type:'web_search'/);
  assert.match(server,/Current date is October 6, 2026/);
  assert.match(server,/Do not confuse similarly named securities/);
  assert.match(debate,/buildResearchContext\(topic/);
  assert.match(debate,/type:'research'/);
});

test('resolved ticker is injected into the quote request and subject evidence outranks broad sentiment',()=>{
  const server=read('api/market-intelligence/_lib/server.js');
  assert.match(server,/mergeSymbol\(stocks,resolved\.symbol/);
  assert.match(server,/RESOLVED SUBJECT — HIGHEST PRIORITY/);
  assert.match(server,/BROAD MARKET SNAPSHOT — SECONDARY CONTEXT ONLY/);
  assert.match(server,/Do not substitute broad market sentiment for subject-specific evidence/);
  assert.match(server,/Never say a public security is unpriceable when a live subject quote appears above/);
});

test('analysts cannot treat market-wide fear greed or consensus as company-specific evidence',()=>{
  const server=read('api/market-intelligence/_lib/server.js');
  const matches=server.match(/Never use broad Fear\/Greed, index moves, or generic analyst consensus as if it were evidence about the subject itself\./g)||[];
  assert.equal(matches.length,3);
});

test('markets UI surfaces the resolved company and symbol before analyst output',()=>{
  const html=read('markets/index.html');
  assert.match(html,/e\.type==='research'/);
  assert.match(html,/dt-resolved/);
  assert.match(html,/Resolved: /);
});
