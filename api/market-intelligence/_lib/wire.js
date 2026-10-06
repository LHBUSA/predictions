const finite = v => v != null && v !== '' && Number.isFinite(Number(v));
const change = v => `${Number(v)>0?'+':''}${Number(v).toFixed(2)}%`;

// Feed-derived observations, not AI verdicts or intraday estimates. Keep periods explicit.
export function buildWire(data, now = new Date().toISOString()) {
  const movers = [
    ...(data?.stocks?.quotes || []).filter(q => finite(q.price) && finite(q.pct)).map(q => ({symbol:String(q.symbol),price:Number(q.price),move:Number(q.pct),period:'session',source:'Finnhub'})),
    ...(data?.crypto?.coins || []).filter(q => finite(q.current_price) && finite(q.price_change_percentage_24h)).map(q => ({symbol:String(q.symbol).toUpperCase(),price:Number(q.current_price),move:Number(q.price_change_percentage_24h),period:'24h',source:'CoinGecko'}))
  ].sort((a,b) => Math.abs(b.move)-Math.abs(a.move));
  const cards = movers.slice(0,2).map((q,i) => ({
    id:`motion-${q.symbol}`,category:i===0?'MOMENTUM CHECK':'RELATIVE MOTION',symbol:q.symbol,
    title:`${q.symbol} ${change(q.move)} · ${q.period}`,
    detail:`Latest feed price: $${q.price.toLocaleString('en-US',{maximumFractionDigits:2})}. This is a ${q.period} change, not a short-window momentum signal.`,
    why:'A large move gives you a thesis to test. Check volume, catalyst quality and invalidation before assuming continuation.',
    source:q.source,observed_at:now,
    prompt:`Debate ${q.symbol} after its ${change(q.move)} ${q.period} move. Check volume and catalysts if verified data is available; identify invalidation and missing evidence.`
  }));
  const headline=(data?.news?.news || []).find(n => n.headline || n.title);
  if(headline) cards.push({id:'catalyst',category:'CATALYST WATCH',title:String(headline.headline || headline.title).slice(0,220),
    detail:'News context from the market feed. A headline alone does not establish causation or a tradable repricing.',
    why:'Ask which assets are exposed, what the market already priced in, and which evidence would confirm the catalyst.',
    source:String(headline.source || 'Market news'),observed_at:now,
    published_at:finite(headline.datetime)?new Date(Number(headline.datetime)*1000).toISOString():null,
    prompt:`Assess this reported catalyst, verify its date and source, and explain the event risk: ${String(headline.headline || headline.title).slice(0,220)}`
  });
  const fg=data?.sentiment?.current;
  if(finite(fg?.value)) cards.push({id:'sentiment',category:'SENTIMENT CONTEXT',title:`Crypto Fear & Greed: ${fg.value}/100`,
    detail:String(fg.value_classification || 'Sentiment index'),
    why:'Sentiment is context, not a timing signal. Compare it with price structure and asset-specific evidence.',
    source:'Alternative.me via market feed',observed_at:now,prompt:'Compare current crypto sentiment with BTC and ETH price structure. What evidence supports continuation versus exhaustion?'
  });
  return {generated_at:now,cadence_seconds:60,method:'feed-derived',cards:cards.slice(0,4),movers:movers.slice(0,5),sentiment:finite(fg?.value)?{value:Number(fg.value),label:String(fg.value_classification || '')}:null,
    limitations:['Feed refresh times vary by source. Observation time is not exchange time.','Volume and volatility are reviewed by the analysts when verified context is available.','Venue divergence requires matched contracts and settlement rules; use Compare.']};
}
