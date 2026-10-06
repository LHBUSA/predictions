(() => {
  const $=id=>document.getElementById(id);
  const encode=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const KEY='pbe_markets_memory_v1';
  const blank=()=>({watchlists:[],prompts:[],sessions:[],style:'balanced'});
  let memory=blank(),activeId=null,wireCards=[],loading=false,live=false,storageAvailable=true;
  let history=[];
  function status(s){$('memory-status').textContent=s}
  function persist(){
    try{localStorage.setItem(KEY,JSON.stringify(memory));return true}
    catch{storageAvailable=false;status('Browser storage unavailable. Changes last for this visit only.');return false}
  }
  function loadMemory(){
    try{
      const m=JSON.parse(localStorage.getItem(KEY)||'null');
      if(m){memory={watchlists:Array.isArray(m.watchlists)?m.watchlists.slice(0,8):[],prompts:Array.isArray(m.prompts)?m.prompts.slice(0,8):[],sessions:Array.isArray(m.sessions)?m.sessions.slice(0,8):[],style:['balanced','concise','technical','risk'].includes(m.style)?m.style:'balanced'}}
    }catch{memory=blank();storageAvailable=false;status('Browser memory could not be loaded. You can clear it and start again.')}
  }
  function button(label,click){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{if(isMember)click()};return b}
  function renderMemory(){
    $('research-style').value=memory.style;
    $('saved-watchlists').replaceChildren(...memory.watchlists.map((w,i)=>button(w.name,()=>{
      tickerStocks=Array.isArray(w.stocks)?w.stocks:[];tickerCrypto=Array.isArray(w.crypto)?w.crypto:[];savePrefs();renderChips();loadData();loadWire();status('Loaded '+w.name+'.');
    })));
    $('saved-prompts').replaceChildren(...memory.prompts.map(p=>button(p,()=>{setMode('consult');inp.value=p;inp.dispatchEvent(new Event('input'));inp.focus()})));
    $('saved-sessions').replaceChildren(...memory.sessions.slice(0,3).map(s=>button(s.title,()=>restore(s.id))));
    $('continue-session').disabled=!memory.sessions.length;
  }
  function restore(id){
    if(!isMember||busy)return;
    const s=memory.sessions.find(x=>x.id===id);if(!s)return;
    activeId=s.id;history=Array.isArray(s.history)?s.history:[];
    $('msgs').innerHTML='';
    for(const b of Array.isArray(s.blocks)?s.blocks:[]){
      const el=document.createElement('div');el.className='debate-block';
      const head=document.createElement('div');head.className='db-head';head.textContent=b.label;
      const body=document.createElement('div');body.className='db-body';body.textContent=b.text;body.style.whiteSpace='pre-wrap';el.append(head,body);$('msgs').appendChild(el);
    }
    $('welcome').style.display='none';setMode(s.mode==='trade'?'debate':s.mode);persona=s.persona||'tim';if(mode==='consult')setPersona(persona);
    status('Reopened saved session. Previous quotes are historical; follow-ups fetch fresh context.');scrollBot(true);
  }
  function capture(question){
    if(!isMember)return;
    const blocks=[...$('msgs').querySelectorAll('.debate-topic,.debate-block,.msg,.debate-summary')].slice(-18).map(el=>({label:el.querySelector('.db-name,.m-who,.dt-lbl,h2')?.textContent||'Session',text:(el.querySelector('.db-body,.m-bub,.dt-txt')||el).textContent.slice(0,10000)}));
    activeId ||= crypto.randomUUID();
    const prior=memory.sessions.find(x=>x.id===activeId);
    const session={id:activeId,title:prior?.title||question.slice(0,75),mode,persona,history:history.slice(-8),blocks,updated_at:new Date().toISOString()};
    memory.sessions=[session,...memory.sessions.filter(x=>x.id!==activeId)].slice(0,8);persist();renderMemory();
  }
  function newSession(){
    if(busy)return;history=[];activeId=null;$('msgs').replaceChildren();$('welcome').style.display='block';$('welcome').style.opacity='1';$('welcome').style.transform='none';setMode('debate');$('feed').scrollTop=0;status('New research session.');
  }
  function workflow(m,prompt,symbol){
    setMode(m);
    if(m==='trade'){$('trade-symbol').value=symbol||'';$('trade-thesis').value=prompt||'';$('trade-symbol').focus();return}
    inp.value=prompt||'';inp.dispatchEvent(new Event('input'));inp.focus();
    if(!isMember){status('Sign in with All Access to run this workflow.');tradeLocked()}
  }
  function preview(){
    wireCards=[
      {category:'MOMENTUM CHECK · PREVIEW',title:'The move is obvious. Is the evidence?',detail:'Open a debate on price extension, volume confirmation and the catalyst behind the move.',why:'Quant reads the tape. Bull argues continuation. Bear tests the weak point.',prompt:'Is BTC overextended here? Check current price structure, volume if available, and invalidation.',symbol:'BTC'},
      {category:'CATALYST WATCH · PREVIEW',title:'Stress-test the next macro headline.',detail:'Put event risk, expectations and thesis invalidation into a single research workflow.',why:'Members get feed-derived ideas with observation times and quick actions into all three modes.',prompt:'What is the risk into CPI? Verify the upcoming release date and distinguish expectations from confirmed data.'}
    ];renderWire();
  }
  function renderWire(){
    $('wire-cards').innerHTML=wireCards.map((c,i)=>`<article class="wire-card"><div class="wire-category"><span>${encode(c.category)}</span>${c.observed_at?'<time>'+encode(new Date(c.observed_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))+'</time>':''}</div><h3>${encode(c.title)}</h3><p>${encode(c.detail)}</p><p style="margin-top:8px"><strong>Why it matters</strong> · ${encode(c.why)}</p>${c.source?'<div class="wire-source">'+encode(c.source)+' · observed at refresh'+(c.published_at?' · published '+encode(new Date(c.published_at).toLocaleString()):'')+'</div>':''}<div class="wire-actions"><button class="wire-action primary" data-wire="${i}" data-mode="debate">Debate ↗</button><button class="wire-action" data-wire="${i}" data-mode="consult">Consult</button><button class="wire-action" data-wire="${i}" data-mode="trade">Trade Lab</button></div></article>`).join('');
  }
  async function loadWire(){
    if(!isMember||loading||document.hidden)return;loading=true;
    try{
      const r=await fetch('/api/market-intelligence/wire?stocks='+encodeURIComponent(tickerStocks.join(','))+'&crypto='+encodeURIComponent(tickerCrypto.join(',')),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
      if([401,403,503].includes(r.status)){
        if(r.status===503)throw new Error('Access verification unavailable');
        isMember=false;live=false;document.body.classList.remove('market-member');document.body.classList.add('market-preview');$('memory-controls').hidden=true;$('memory-locked').hidden=false;$('msgs').replaceChildren();history=[];preview();$('wire-state').textContent='ACCESS REQUIRED';return;
      }
      if(!r.ok)throw new Error('Feed unavailable');
      const d=await r.json();wireCards=d.cards||[];renderWire();
      $('wire-state').textContent='MEMBER FEED';$('wire-note').textContent='Machine-curated observations · refreshes every 60 seconds';
      $('wire-freshness').textContent='Observed '+new Date(d.generated_at).toLocaleTimeString()+' · Source updates vary. Ask an analyst for the AI thesis.';
      if(!wireCards.length)$('wire-cards').textContent='No verified observations in this refresh. Your analyst workflows remain available.';
      const q=d.movers?.[0];if(q){$('signal-mover').textContent=q.symbol+' '+(q.move>0?'+':'')+q.move.toFixed(2)+'%';$('signal-mover-note').textContent=q.period+' change · largest absolute move among selected assets.'}
      if(d.sentiment){$('signal-sentiment').textContent=d.sentiment.value+'/100 · '+d.sentiment.label;$('signal-sentiment-note').textContent='Crypto Fear & Greed · Alternative.me. Context, not a timing signal.'}
    }catch{
      $('wire-state').textContent=wireCards.some(c=>c.observed_at)?'STALE':'UNAVAILABLE';
      $('wire-note').textContent='Update unavailable. Retrying on the next refresh.';
      if(!wireCards.some(c=>c.observed_at)){$('wire-cards').textContent='The member feed is temporarily unavailable. Start a research workflow below.'}
    }finally{loading=false}
  }
  function access(){
    const m=membershipVerdict;
    $('workspace-access').textContent=isMember?'ALL ACCESS ACTIVE':m?.membership?.state==='unverified'?'ACCESS CHECK':m?.authenticated?'ALL ACCESS REQUIRED':'PREVIEW WORKSPACE';
    $('memory-controls').hidden=!isMember;$('memory-locked').hidden=isMember;
    document.querySelector('.tb-status span').textContent=isMember?'Member':'Preview';
    if(!isMember){
      if(m?.membership?.state==='unverified'){$('access-preview').querySelector('b').textContent='ACCESS CHECK';$('access-preview').querySelector('span').textContent='Access verification is unavailable. Refresh to retry; your subscription status has not been determined.'}
      if(m?.authenticated&&m?.membership?.state!=='unverified'){$('access-preview').querySelector('b').textContent='SIGNED IN';$('access-preview').querySelector('span').textContent='All Access unlocks Debate, Consult, Trade Lab, the Live Market Wire and saved research.'}
      preview();return;
    }
    if(!live){live=true;loadMemory();renderMemory();loadWire()}
  }
  $('wire-cards').addEventListener('click',e=>{const b=e.target.closest('[data-wire]');if(!b)return;const c=wireCards[Number(b.dataset.wire)];if(c)workflow(b.dataset.mode,c.prompt,c.symbol)});
  document.querySelectorAll('[data-workflow]').forEach(b=>b.onclick=()=>workflow(b.dataset.workflow));
  $('save-watchlist').onclick=()=>{if(!isMember)return;const name=$('watchlist-name').value.trim();if(!name){status('Name your watchlist first.');return}memory.watchlists=[{name,stocks:[...tickerStocks],crypto:[...tickerCrypto]},...memory.watchlists.filter(w=>w.name!==name)].slice(0,8);if(persist())status('Saved '+name+' on this browser.');renderMemory()};
  $('save-prompt').onclick=()=>{if(!isMember)return;const p=inp.value.trim();if(!p){status('Type a question in the composer to save it.');return}memory.prompts=[p,...memory.prompts.filter(x=>x!==p)].slice(0,8);if(persist())status('Prompt saved.');renderMemory()};
  $('research-style').onchange=e=>{if(!isMember)return;memory.style=e.target.value;if(persist())status('Research style saved.')};
  $('continue-session').onclick=()=>{if(isMember&&memory.sessions[0])restore(memory.sessions[0].id)};
  $('new-session').onclick=()=>{if(isMember)newSession()};
  $('clear-memory').onclick=()=>{if(!isMember||busy)return;memory=blank();history=[];activeId=null;try{localStorage.removeItem(KEY);storageAvailable=true}catch{status('Storage unavailable. Clear browser site data to remove saved memory.');return}newSession();renderMemory();status('Watchlists, prompts and saved sessions cleared.')};
  window.MarketWorkspace={
    context:()=>isMember?{history:history.slice(-8),style:memory.style,tracked_assets:[...tickerStocks,...tickerCrypto].slice(0,25)}:{},
    remember:(question,answer)=>{if(!isMember||!answer)return;history.push({role:'user',content:question.slice(0,1200)},{role:'assistant',content:answer.slice(0,6000)});history=history.slice(-8)},
    capture,newSession
  };
  window.addEventListener('market-access',access);if(membershipVerdict)access();else preview();
  setInterval(loadWire,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadWire()});
})();
