const DATA_UPSTREAM = 'https://markets-proptechusa.sales-fd3.workers.dev';

export const MODEL = 'gpt-5.4-mini';

export const PERSONAS = {
  bull: {
    name: 'Bull',
    role: 'The Bull Case',
    instruction: 'You are the Bull analyst inside PropBetEdge Market Intelligence. Build the strongest evidence-based upside case from the supplied live market data. Be concise, specific and numerical. Use at most 4 short sections and roughly 180 words. Acknowledge material downside risks. Never invent a price, percentage, catalyst or fact. This is market analysis, not personalized financial advice.'
  },
  bear: {
    name: 'Bear',
    role: 'The Bear Case',
    instruction: 'You are the Bear analyst inside PropBetEdge Market Intelligence. Stress-test the market narrative using the supplied live market data. Lead with the clearest risk, contradiction or missing assumption. Be concise, specific and numerical. Use at most 4 short sections and roughly 180 words. Never invent a price, percentage, catalyst or fact. This is market analysis, not personalized financial advice.'
  },
  quant: {
    name: 'Quant',
    role: 'The Data Read',
    instruction: 'You are the Quant analyst inside PropBetEdge Market Intelligence. Read the supplied market data clinically. Lead with the most important number, separate signal from noise, and do not express a personal bullish or bearish preference. Use at most 4 short sections and roughly 180 words. Never invent a price, percentage, catalyst or fact. This is market analysis, not personalized financial advice.'
  }
};

export function safeSymbols(value, fallback, max=20) {
  return String(value || fallback).split(',').map((x)=>x.trim().toUpperCase()).filter((x)=>/^[A-Z0-9.-]{1,10}$/.test(x)).slice(0,max).join(',');
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

export function contextFromMarket(d) {
  const quotes = d?.stocks?.quotes || [];
  const coins = d?.crypto?.coins || [];
  const macro = d?.macro?.indicators || {};
  const news = d?.news?.news || [];
  const earnings = d?.news?.earnings || [];
  const consensus = d?.options?.summary || {};
  const f = (v) => v == null ? 'N/A' : String(v);
  const pct = (v) => v == null ? 'N/A' : ((Number(v) > 0 ? '+' : '') + Number(v).toFixed(2) + '%');

  const equityLines = quotes
    .filter((x)=>x?.symbol)
    .slice(0,20)
    .map((x)=>x.symbol + ': $' + f(x.price) + ' | ' + pct(x.pct) + ' | H ' + f(x.high) + ' | L ' + f(x.low));

  const cryptoLines = coins
    .filter((x)=>x?.symbol)
    .slice(0,20)
    .map((x)=>String(x.symbol).toUpperCase() + ': $' + f(x.current_price) + ' | 24h ' + pct(x.price_change_percentage_24h) + (x.price_change_percentage_7d_in_currency != null ? ' | 7d ' + pct(x.price_change_percentage_7d_in_currency) : ''));

  return [
    '[CURRENT MARKET SNAPSHOT]',
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
    'Analyst consensus: ' + f(consensus?.sentiment) + ' | bullish ' + f(consensus?.bullish) + ' / bearish ' + f(consensus?.bearish) + ' / neutral ' + f(consensus?.neutral),
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
    'TOP MARKET HEADLINES:',
    ...news.slice(0,6).map((n)=>'- ' + n.headline + ' [' + (n.source||'source') + ']'),
    '',
    'UPCOMING EARNINGS:',
    ...earnings.slice(0,6).map((e)=>'- ' + f(e.symbol) + ' | EPS est ' + f(e.epsEstimate) + ' | ' + f(e.hour)),
    '',
    'Use only the snapshot above for numerical claims. If the requested security or fact is not present, say that the live feed does not currently contain it.'
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
  const text = (body.output || []).flatMap((item)=>item?.content || []).filter((p)=>p?.type==='output_text').map((p)=>p.text || '').join('').trim();
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
