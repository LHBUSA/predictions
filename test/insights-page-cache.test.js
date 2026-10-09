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
test('coalesces concurrent cold loads',async()=>{
 let calls=0,release;
 const wait=new Promise(resolve=>release=resolve);
 const build=async()=>{calls++;await wait;return response('shared')};
 const many=Array.from({length:12},()=>cachedInsightsDesk('test-b',build));
 release();
 const answers=await Promise.all(many);
 assert.equal(calls,1);
 assert.deepEqual(await Promise.all(answers.map(a=>a.text())),Array(12).fill('shared'));
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
