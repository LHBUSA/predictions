import puppeteer from 'puppeteer-core';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {startServer} from './serve.mjs';
import {buildWire} from '../../api/market-intelligence/_lib/wire.js';

const chrome=process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if(!chrome)throw new Error('Chrome unavailable');
const live=process.argv.find(a=>a.startsWith('https://'));
const out=join(process.cwd(),'_preview','markets');mkdirSync(out,{recursive:true});
const market={stocks:{quotes:[{symbol:'SPY',price:598.23,pct:0.83},{symbol:'NVDA',price:186.4,pct:2.4},{symbol:'QQQ',price:530,pct:1.1}]},crypto:{coins:[{symbol:'btc',name:'Bitcoin',current_price:92350,price_change_percentage_24h:1.8},{symbol:'eth',name:'Ethereum',current_price:3420,price_change_percentage_24h:-0.7}]},sentiment:{current:{value:'56',value_classification:'Greed'}},news:{news:[{headline:'Macro release expectations remain a focus for the next research session',source:'QA fixture',datetime:1791320000}],earnings:[]},macro:{indicators:{}},onchain:{},options:{}};
const wire=buildWire(market);
const sse=events=>events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');
let server,browser;const results=[];
try{
  let origin=live;
  if(!origin){const s=await startServer();server=s.server;origin=s.origin}
  browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--hide-scrollbars']});
  for(const state of live?['production']:['anonymous','free','unverified','all_access','owner']){
    for(const width of state==='production'||state==='anonymous'||state==='all_access'?[1440,1280,1024,768,390]:[1440,390]){
      const page=await browser.newPage();const errors=[];const requests=[];let consultBody;
      page.on('pageerror',e=>errors.push(e.message));
      await page.setViewport({width,height:width<800?844:1000,deviceScaleFactor:1});
      if(!live){
        await page.setRequestInterception(true);
        page.on('request',async req=>{
          const url=new URL(req.url());
          if(url.pathname.startsWith('/api/')){
            requests.push(url.pathname);
            let body,status=200,type='application/json';
            if(url.pathname==='/api/membership')body={authenticated:['free','all_access','owner'].includes(state),membership:{state,entitled:['all_access','owner'].includes(state)}};
            else if(url.pathname.endsWith('/wire'))body=wire;
            else if(url.pathname.endsWith('/market'))body=market;
            else if(url.pathname.endsWith('/debate')){type='text/event-stream';body=sse([{type:'persona_start',persona:'quant',name:'Data',role:'The Data Read',emoji:'◆'},{type:'text',persona:'quant',text:'### Stance\nMixed\n### Confidence\nLimited by missing volume.\n### Key driver\nPrice structure\n### Risk\nEvent volatility\n### What would change my mind\nVerified volume.'},{type:'persona_done',persona:'quant'},{type:'summary',text:'### Agreement\nVerify the catalyst.\n### Disagreement\nContinuation remains uncertain.\n### Next check\nVolume confirmation.'},{type:'debate_done'}])}
            else if(url.pathname.endsWith('/stream')){consultBody=JSON.parse(req.postData());type='text/event-stream';body=sse([{type:'text',text:'Follow-up fixture: verify fresh price structure.'},{type:'done'}])}
            else body={ok:true,symbols:[]};
            await req.respond({status,contentType:type,body:typeof body==='string'?body:JSON.stringify(body)});return;
          }
          if(url.origin!==origin){await req.abort();return}await req.continue();
        });
      }
      const url=origin.replace(/\/$/,'')+(live?'/markets/':'/markets/');
      const res=await page.goto(url,{waitUntil:'networkidle0',timeout:60000});assert.equal(res.status(),200);
      await page.waitForFunction(()=>typeof membershipVerdict!=='undefined'&&membershipVerdict!==null);
      const metrics=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,member:document.body.classList.contains('market-member'),memory:!document.getElementById('memory-controls').hidden,wire:document.getElementById('wire-state').textContent}));
      assert.ok(metrics.scroll<=metrics.client,`${state} ${width}: overflow ${metrics.scroll} > ${metrics.client}`);
      if(!live){const member=['all_access','owner'].includes(state);assert.equal(metrics.member,member);assert.equal(metrics.memory,member);assert.equal(requests.includes('/api/market-intelligence/wire'),member)}
      await page.screenshot({path:join(out,`${state}-${width}.png`),fullPage:true});
      if(!live&&state==='all_access'&&width===1440){
        await page.type('#watchlist-name','My Crypto');await page.click('#save-watchlist');
        assert.equal(await page.$eval('#saved-watchlists',el=>el.textContent),'My Crypto');
        await page.type('#inp','Is BTC overextended here?');await page.click('#save-prompt');await page.click('#send-btn');
        await page.waitForFunction(()=>!busy&&document.querySelector('.debate-summary'));
        await page.click('#btn-consult');await page.type('#inp','What would invalidate that thesis?');await page.click('#send-btn');
        await page.waitForFunction(()=>!busy&&document.querySelectorAll('.msg').length===2);
        assert.equal(consultBody.memory.history.length,2);assert.match(consultBody.memory.history[1].content,/Mixed/);
        await page.click('#new-session');await page.click('#continue-session');
        assert.ok(await page.$eval('#msgs',el=>el.textContent.includes('Follow-up fixture')));
        await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>document.body.classList.contains('market-member'));
        assert.equal(await page.$eval('#saved-watchlists',el=>el.textContent),'My Crypto');
        await page.click('#continue-session');assert.ok(await page.$eval('#msgs',el=>el.textContent.includes('Follow-up fixture')));
        await page.click('#clear-memory');assert.equal(await page.$eval('#saved-watchlists',el=>el.textContent),'');
        await page.click('#btn-trade');assert.equal(await page.$eval('#trade-lab',el=>getComputedStyle(el).display),'block');
        assert.equal(await page.$eval('#trade-preview',el=>getComputedStyle(el).display),'none');
      }
      if(!live&&state==='anonymous'){await page.click('#send-btn');assert.ok(!requests.includes('/api/market-intelligence/debate'))}
      assert.deepEqual(errors,[]);results.push({state,width,...metrics,errors});console.log(`${state} @ ${width}: no overflow, member=${metrics.member}, memory=${metrics.memory}, wire=${metrics.wire}`);
      await page.close();
    }
  }
  writeFileSync(join(out,live?'production-results.json':'fixture-results.json'),JSON.stringify(results,null,2));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r))}
