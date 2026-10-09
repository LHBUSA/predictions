import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedInsightsDesk } from '../workers/pbe-predictions/src/insights/page-cache.js';

const response = (body='ok',status=200,cache='public, max-age=120') => new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':cache}});

test('reuses same public HTML during TTL; refreshes afterward', async()=>{
 let tick=0,calls=0;
 const build=()=>{calls++;return response('generation-'+calls)};
 assert.equal(await (await cachedInsightsDesk('test-a',build,{now:()=>tick,ttlMs:100})).text(),'generation-1');
 tick=50;
 assert.equal(await (await cachedInsightsDesk('test-a',build,{now:()=>tick,ttlMs:100})).text(),'generation-1');
 tick=110;
 assert.equal(await (await cachedInsightsDesk('test-a',build,{now:()=>tick,ttlMs:100})).text(),'generation-2');
 assert.equal(calls,2);
});
// Workers forbids sharing a Response/stream (or awaiting another request's promise) across requests: the memo
// must hand every request its own fresh Response built from plain data. (The original cross-request coalescing
// shared one Response and returned 500s in production on 2026-10-09: "ReadableStream is currently locked".)
test('every request gets an independent Response (no shared body/stream across requests)',async()=>{
 let calls=0;
 // Model the Workers rule: the builder's Response belongs to ITS request; cloning it or handing it out again is forbidden.
 const build=()=>{calls++;const r=response('desk-html');r.clone=()=>{throw new Error('cross-request Response reuse (clone)')};return r};
 const first=await cachedInsightsDesk('test-b',build);
 const second=await cachedInsightsDesk('test-b',build);
 const third=await cachedInsightsDesk('test-b',build);
 assert.notEqual(first,second); assert.notEqual(second,third);
 // each body can be read on its own, in any order, without locking the others
 assert.equal(await third.text(),'desk-html'); assert.equal(await first.text(),'desk-html'); assert.equal(await second.text(),'desk-html');
 assert.equal(first.headers.get('cache-control'),'public, max-age=120');
 assert.equal(calls,1);
});
test('never caches non-success, private, or cookie-bearing data',async()=>{
 for(const [key,make] of [
  ['errors',()=>response('bad',503)],
  ['private',()=>response('secret',200,'private, no-store')],
  ['cookie',()=>new Response('no',{headers:{'content-type':'text/html','cache-control':'public, max-age=120','set-cookie':'pbe_session=secret'}})]
 ]) {
  let count=0;
  await cachedInsightsDesk('test-'+key,()=>{count++;return make()});
  await cachedInsightsDesk('test-'+key,()=>{count++;return make()});
  assert.equal(count,2,key);
 }
});
test('concurrent failure does not poison future requests',async()=>{
 let count=0;
 const load=()=>{count++;if(count===1)throw Error('upstream down');return response('recovered')};
 await assert.rejects(()=>cachedInsightsDesk('test-error',load));
 assert.equal(await (await cachedInsightsDesk('test-error',load)).text(),'recovered');
 assert.equal(count,2);
});
