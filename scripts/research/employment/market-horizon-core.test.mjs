import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivedWindow, quoteAt, binaryLogLoss, summarizePairedEventScores } from './market-horizon-core.mjs';
const base = 2_000_000_000;
const entry = {status:200, url:`https://example.test/candles?start_ts=${base-72*3600}&end_ts=${base}&period_interval=60`};
test('T-3 archived, T-7 unavailable',()=>{
 assert.equal(archivedWindow(entry,base-48*3600).covered,true);
 assert.equal(archivedWindow(entry,base-6*24*3600).reason,'HORIZON_NOT_ARCHIVED');
});
test('missing archive is not a missing price',()=>{
 assert.equal(archivedWindow(undefined,base).reason,'NO_ARCHIVE_MANIFEST');
});
test('no future information, freshness enforced',()=>{
 const c=[
  {end_period_ts:base-3600,yes_bid:{close:.4},yes_ask:{close:.5}},
  {end_period_ts:base+60,yes_bid:{close:.9},yes_ask:{close:1}},
  {end_period_ts:base-600,yes_bid:{close:.3},yes_ask:{close:.4}}
 ];
 assert.equal(quoteAt(c,base).mid,.35);
 assert.equal(quoteAt(c,base-7200).status,'NO_QUOTE_AT_CUTOFF');
 assert.equal(quoteAt(c,base+3*3600).status,'STALE');
});
test('bad quotes fail closed',()=>{
 assert.equal(quoteAt([{end_period_ts:base+1,yes_bid:{close:.3},yes_ask:{close:.4}}],base).status,'NO_QUOTE_AT_CUTOFF');
 assert.equal(quoteAt([{end_period_ts:base,yes_bid:{close:.5},yes_ask:{close:.4}}],base).status,'INVALID_CROSSED_QUOTE');
 assert.equal(quoteAt([{end_period_ts:base,yes_bid:{close:null},yes_ask:{close:.4}}],base).status,'NO_QUOTE_AT_CUTOFF');
});
test('proper scoring finite, invalid excluded',()=>{
 assert.ok(Number.isFinite(binaryLogLoss(0,1)));
 assert.ok(Math.abs(binaryLogLoss(.8,1)+Math.log(.8))<1e-10);
 assert.throws(()=>binaryLogLoss(1.1,1));
});
test('paired comparisons share contracts and require eligible features',()=>{
 const priced=(mid)=>({status:'PRICED',mid});
 const events=[{event:'e1',month:'2026-09',feature_status:{1:'OK',3:'OK'},contracts:[
  {outcome:1,prices:{1:priced(.9),3:priced(.6)}},
  {outcome:0,prices:{1:priced(.1),3:{status:'STALE'}}}
 ]},{event:'e2',month:'2026-08',feature_status:{1:'OK',3:'INPUT_UNAVAILABLE'},contracts:[
  {outcome:0,prices:{1:priced(.2),3:priced(.4)}}
 ]}];
 const out=summarizePairedEventScores(events);
 assert.equal(out.events,1);assert.equal(out.contracts,1);assert.ok(out.early_minus_late>0);
});
