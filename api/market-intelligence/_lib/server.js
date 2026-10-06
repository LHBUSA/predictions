const DATA_UPSTREAM = 'https://markets-proptechusa.sales-fd3.workers.dev';
const TECHNICALS_UPSTREAM = 'https://markets-technicals.sales-fd3.workers.dev/data';

export const MODEL = 'gpt-5.4-mini';
export const RESEARCH_MODEL = 'gpt-5.6-luna';

const SUBJECT_RULES = [
  'Resolve the exact company, security, ETF, index, or crypto asset the user means before analysis.',
  'Current date is October 6, 2026. Use web search to verify current public/private status and ticker.',
  'Prefer authoritative issuer, exchange, SEC, investor-relations, and major financial-market sources.',
  'Do not confuse similarly named securities or stale/private-company status.',
  'If the user asks about a company that is now public, return its current public ticker.',
  'If the question is general market commentary rather than a specific instrument, return ASSET_TYPE=general and SYMBOL=NONE.',
  'Return the requested line protocol exactly. Keep RESEARCH to one compact sentence with the most decision-relevant current facts.'
].join(' ');

export const PERSONAS = {
  bull: {
    name: 'Tim',
    role: 'The Bull Case',
    instruction: [
      'You are Tim, the Bull analyst inside PropBetEdge Market Intelligence.',
      'Build the strongest evidence-based upside case for the RESOLVED SUBJECT, not for the market in general.',
      'Evidence hierarchy: (1) subject-specific research and current quote, (2) subject technicals/fundamentals/catalysts, (3) broad market and macro context only as secondary evidence.',
      'Never use broad Fear/Greed, index moves, or generic analyst consensus as if it were evidence about the subject itself.',
      'If the resolved subject is public and a live quote is supplied, use it and do not claim the subject is unpriceable.',
      'Be concise, specific, numerical, and use at most 4 short sections and roughly 180 words.',
      'Acknowledge material downside risks. Never invent a price, percentage, catalyst, multiple, target, filing, or fact.',
      'This is market analysis, not personalized financial advice.'
    ].join(' ')
  },
  bear: {
    name: 'Bramer',
    role: 'The Bear Case',
    instruction: [
      'You are Bramer, the Bear analyst inside PropBetEdge Market Intelligence.',
      'Stress-test the RESOLVED SUBJECT using subject-specific evidence first.',
      'Evidence hierarchy: (1) subject-specific research and current quote, (2) subject technicals/fundamentals/catalysts, (3) broad market and macro context only as secondary evidence.',
      'Never use broad Fear/Greed, index moves, or generic analyst consensus as if it were evidence about the subject itself.',
      'If the resolved subject is public and a live quote is supplied, use it and do not claim the subject is unpriceable.',
      'Lead with the clearest valuation, execution, technical, liquidity, or thesis risk actually supported by the evidence.',
      'Be concise, specific, numerical, and use at most 4 short sections and roughly 180 words.',
      'Never invent a price, percentage, catalyst, multiple, target, filing, or fact. This is market analysis, not personalized financial advice.'
    ].join(' ')
  },
  quant: {
    name: 'Data',
    role: 'The Data Read',
    instruction: [
      'You are Data, the Quant analyst inside PropBetEdge Market Intelligence.',
      'Read the RESOLVED SUBJECT clinically and lead with the most decision-relevant subject-specific numbers.',
      'Evidence hierarchy: (1) subject-specific research and current quote, (2) subject technicals/fundamentals/catalysts, (3) broad market and macro context only as secondary evidence.',
      'Never use broad Fear/Greed, index moves, or generic analyst consensus as if it were evidence about the subject itself.',
      'If the resolved subject is public and a live quote is supplied, use it and do not claim the subject is unpriceable.',
      'Separate observed facts from interpretation. Do not express a personal bullish or bearish preference.',
      'Be concise, specific, numerical, and use at most 4 short sections and roughly 180 words.',
      'Never invent a price, percentage, catalyst, multiple, target, filing, or fact. This is market analysis, not personalized financial advice.'
    ].join(' ')
  }
};

export function safeSymbols(value, fallback, max=20) {
  return String(value || fallback).split(',').map((x)=>x.trim().toUpperCase()).filter((x)=>/^[A-Z0-9.-]{1,10}$/.test(x)).slice(0,max).join(',');
}

function extractResponseText(body) {
  return (body?.output || [])
    .flatMap((item)=>item?.content || [])
    .filter((part)=>part?.type === 'output_text')
    .map((part)=>part.text || '')
    .join('')
    .trim();
}

function extractResponseSources(body) {
  const out = [];
  for (const item of body?.output || []) {
    for (const part of item?.content || []) {
      for (const a of part?.annotations || []) {
        const u = a?.url_citation?.url || a?.url || null;
        const title = a?.url_citation?.title || a?.title || null;
        if (u && !out.some((x)=>x.url===u)) out.push({title:title || u,url:u});
      }
    }
  }
  return out.slice(0,8);
}

function field(text, name) {
  const m = String(text || '').match(new RegExp('^' + name + '=(.*)$','mi'));
  return m ? m[1].trim() : '';
}

export async function resolveAndResearchSubject(question) {
  if (!process.env.OPENAI_API_KEY) throw new Error('openai_not_configured');
  const prompt = [
    SUBJECT_RULES,
    '',
    'USER QUESTION:',
    question,
    '',
    'Return exactly these lines:',
    'SUBJECT=<canonical current subject name or GENERAL MARKET>',
    'SYMBOL=<current ticker or NONE>',
    'ASSET_TYPE=<equity|etf|index|crypto|private_company|general|unknown>',
    'PUBLIC_STATUS=<public|private|not_applicable|unknown>',
    'EXCHANGE=<exchange name or NONE>',
    'CONFIDENCE=<0.00-1.00>',
    'RESEARCH=<one compact sentence summarizing the most decision-relevant current company/security facts and any fresh catalyst or valuation context you can verify>'
  ].join('\n');

  const r = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+process.env.OPENAI_API_KEY},
    body:JSON.stringify({
      model:RESEARCH_MODEL,
      tools:[{type:'web_search',search_context_size:'low'}],
      reasoning:{effort:'none'},
      input:prompt,
      max_output_tokens:420
    }),
    signal:AbortSignal.timeout(30000)
  });
  const body = await r.json().catch(()=>null);
  if (!r.ok || !body) throw new Error(body?.error?.message || 'subject_resolution_failed');
  const text = extractResponseText(body);
  const rawSymbol = field(text,'SYMBOL').toUpperCase();
  const symbol = /^[A-Z0-9.-]{1,10}$/.test(rawSymbol) && rawSymbol !== 'NONE' ? rawSymbol : null;
  const confidence = Number(field(text,'CONFIDENCE'));
  return {
    subject: field(text,'SUBJECT') || 'General market',
    symbol,
    asset_type: field(text,'ASSET_TYPE') || 'unknown',
    public_status: field(text,'PUBLIC_STATUS') || 'unknown',
    exchange: field(text,'EXCHANGE') || null,
    confidence: Number.isFinite(confidence) ? Math.max(0,Math.min(1,confidence)) : 0,
    research: field(text,'RESEARCH') || '',
    sources: extractResponseSources(body)
  };
}

export async function marketData(stocks, crypto) {
  const u = new URL(DATA_UPSTREAM + '/market');
  u.searchParams.set('stocks', safeSymbols(stocks, 'SPY,QQQ,DIA,IWM,VIX', 20));
  u.searchParams.set('crypto', safeSymbols(crypto, 'BTC,ETH,SOL,BNB,XRP,ADA', 20));
  const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  const body = await r.json().catch(()=>null);
  if (!r.ok || !body) throw new Error('market_data_unavailable');
  return body;
}

function mergeSymbol(value, symbol, fallback) {
  const items = safeSymbols(value, fallback, 20).split(',').filter(Boolean);
  if (symbol && /^[A-Z0-9.-]{1,10}$/.test(symbol) && !items.includes(symbol)) items.unshift(symbol);
  return items.slice(0,20).join(',');
}

export async function technicalData(symbol) {
  if (!symbol || !/^[A-Z0-9.-]{1,10}$/.test(symbol)) return null;
  try{
    const u=new URL(TECHNICALS_UPSTREAM);u.searchParams.set('symbol',symbol);
    const r=await fetch(u,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8500)});
    const body=await r.json().catch(()=>null);
    return r.ok && body ? body : null;
  }catch{return null}
}

export async function buildResearchContext(question, stocks, crypto) {
  let resolved;
  try{
    resolved=await resolveAndResearchSubject(question);
  }catch{
    resolved={subject:'Unresolved subject',symbol:null,asset_type:'unknown',public_status:'unknown',exchange:null,confidence:0,research:'',sources:[]};
  }

  const stockSymbols = resolved.symbol && ['equity','etf','index'].includes(resolved.asset_type)
    ? mergeSymbol(stocks,resolved.symbol,'SPY,QQQ,DIA,IWM,VIX')
    : safeSymbols(stocks,'SPY,QQQ,DIA,IWM,VIX',20);

  const cryptoSymbols = resolved.symbol && resolved.asset_type==='crypto'
    ? mergeSymbol(crypto,resolved.symbol.replace(/-USD$/,''),'BTC,ETH,SOL,BNB,XRP,ADA')
    : safeSymbols(crypto,'BTC,ETH,SOL,BNB,XRP,ADA',20);

  const [data,technical]=await Promise.all([
    marketData(stockSymbols,cryptoSymbols),
    resolved.symbol && ['equity','etf','index'].includes(resolved.asset_type) ? technicalData(resolved.symbol) : Promise.resolve(null)
  ]);

  return {resolved,data,technical,context:contextFromMarket(data,resolved,technical)};
}

function f(v) { return v == null ? 'N/A' : String(v); }
function pct(v) { return v == null || !Number.isFinite(Number(v)) ? 'N/A' : ((Number(v)>0?'+':'')+Number(v).toFixed(2)+'%'); }

export function contextFromMarket(d, resolved=null, technical=null) {
  const quotes = d?.stocks?.quotes || [];
  const coins = d?.crypto?.coins || [];
  const macro = d?.macro?.indicators || {};
  const news = d?.news?.news || [];
  const earnings = d?.news?.earnings || [];
  const consensus = d?.options?.summary || {};

  const subjectQuote = resolved?.symbol
    ? quotes.find((x)=>x?.symbol===resolved.symbol) || coins.find((x)=>String(x?.symbol||'').toUpperCase()===resolved.symbol.replace(/-USD$/,''))
    : null;

  const sourceLines=(resolved?.sources||[]).slice(0,5).map((s)=>'- '+s.title+' | '+s.url);

  const subjectBlock = resolved ? [
    '[RESOLVED SUBJECT — HIGHEST PRIORITY]',
    'Subject: ' + f(resolved.subject),
    'Symbol: ' + f(resolved.symbol),
    'Asset type: ' + f(resolved.asset_type),
    'Public status: ' + f(resolved.public_status),
    'Exchange: ' + f(resolved.exchange),
    'Resolution confidence: ' + f(resolved.confidence),
    'Current subject research: ' + f(resolved.research),
    ...(sourceLines.length ? ['Verified research sources:',...sourceLines] : []),
    subjectQuote ? (
      'Live subject quote: ' + f(resolved.symbol) +
      ' | price $' + f(subjectQuote.price ?? subjectQuote.current_price) +
      ' | change ' + pct(subjectQuote.pct ?? subjectQuote.price_change_percentage_24h) +
      ' | high ' + f(subjectQuote.high) +
      ' | low ' + f(subjectQuote.low)
    ) : 'Live subject quote: unavailable from the current quote feed',
    technical ? (
      'Subject technicals: RSI14 ' + f(technical?.rsi?.rsi14) +
      ' | RSI signal ' + f(technical?.rsi?.signal14) +
      ' | MACD ' + f(technical?.macd?.histogram) +
      ' | MACD bias ' + f(technical?.macd?.bias) +
      ' | EMA50 $' + f(technical?.emas?.ema50) +
      ' | trend ' + f(technical?.emas?.trend) +
      ' | volume ratio ' + f(technical?.volume?.ratio) +
      ' | 52w low $' + f(technical?.range?.low52w) +
      ' | 52w high $' + f(technical?.range?.high52w)
    ) : 'Subject technicals: unavailable',
    'Rule: Do not substitute broad market sentiment for subject-specific evidence.',
    ''
  ] : [];

  const equityLines = quotes.filter((x)=>x?.symbol).slice(0,20)
    .map((x)=>x.symbol+': $'+f(x.price)+' | '+pct(x.pct)+' | H '+f(x.high)+' | L '+f(x.low));
  const cryptoLines = coins.filter((x)=>x?.symbol).slice(0,20)
    .map((x)=>String(x.symbol).toUpperCase()+': $'+f(x.current_price)+' | 24h '+pct(x.price_change_percentage_24h));

  return [
    ...subjectBlock,
    '[BROAD MARKET SNAPSHOT — SECONDARY CONTEXT ONLY]',
    'US EQUITIES / ETFs:',
    ...(equityLines.length ? equityLines : ['No equity quotes available']),
    '',
    'CRYPTO:',
    ...(cryptoLines.length ? cryptoLines : ['No crypto quotes available']),
    '',
    'MARKET STATE:',
    'Fear/Greed: ' + f(d?.sentiment?.current?.value) + ' ' + f(d?.sentiment?.current?.value_classification),
    'Market mood: ' + f(d?.mood?.label || d?.mood?.mood),
    'BTC dominance: ' + f(d?.crypto?.btcDominance) + '%',
    'Broad analyst consensus: ' + f(consensus?.sentiment) + ' | bullish ' + f(consensus?.bullish) + ' / bearish ' + f(consensus?.bearish) + ' / neutral ' + f(consensus?.neutral),
    '',
    'MACRO:',
    'Fed funds: ' + f(macro?.fedfunds?.current?.value) + '%',
    'CPI: ' + f(macro?.cpi?.current?.value),
    '30Y mortgage: ' + f(macro?.rate30?.current?.value) + '%',
    'Unemployment: ' + f(macro?.unemployment?.current?.value) + '%',
    '10Y Treasury: ' + f(macro?.treasury10y?.current?.value) + '%',
    '2Y Treasury: ' + f(macro?.treasury2y?.current?.value) + '%',
    'Yield curve 10Y-2Y: ' + f(d?.macro?.yieldCurve?.spread) + '%',
    '',
    'CURRENT MARKET HEADLINES:',
    ...news.slice(0,8).map((n)=>'- '+n.headline+' ['+(n.source||'source')+']'),
    '',
    'UPCOMING EARNINGS:',
    ...earnings.slice(0,6).map((e)=>'- '+f(e.symbol)+' | EPS est '+f(e.epsEstimate)+' | '+f(e.hour)),
    '',
    'Use subject-specific evidence first. If the user asks whether something is a good buy, distinguish valuation/price evidence, catalyst evidence, technical evidence, and broad market context. Never say a public security is unpriceable when a live subject quote appears above.'
  ].join('\n');
}

export async function askOpenAI({ instruction, input, maxOutput=700 }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('openai_not_configured');
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type':'application/json', authorization:'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: 'none' },
      instructions: instruction,
      input,
      max_output_tokens: maxOutput
    }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await r.json().catch(()=>null);
  if (!r.ok || !body) throw new Error(body?.error?.message || 'openai_request_failed');
  const text = extractResponseText(body);
  if (!text) throw new Error('empty_model_response');
  return text;
}

export function sseHeaders(res) {
  res.setHeader('content-type','text/event-stream; charset=utf-8');
  res.setHeader('cache-control','private, no-store, max-age=0');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('vary','Cookie');
}

export function sendEvent(res, data) {
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}
