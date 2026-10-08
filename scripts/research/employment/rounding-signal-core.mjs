// Pure, descriptive post-gate research. No model fitting, no forecast, no market feature.
export const ROUNDED_GAP_BAND = 0.025;
export function calendarMonthIndex(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('Invalid month ' + month);
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
}
export function nextRatePairs(releases, cutoffFor) {
  const ready = releases.filter(r => r.rate_check === 'MATCH' && r.reference_levels).map(r => {
    const x = r.reference_levels;
    if (![x.u3_unrounded, x.u3_published, x.civilian_labor_force_k, x.unemployed_k].every(Number.isFinite) || x.civilian_labor_force_k <= 0)
      throw Error('Bad levels at ' + r.reference_month);
    if (Math.abs(100 * x.unemployed_k / x.civilian_labor_force_k - x.u3_unrounded) > 1e-9)
      throw Error('Inconsistent levels at ' + r.reference_month);
    const gap = x.u3_unrounded - x.u3_published;
    if (Math.abs(gap) > .05001) throw Error('Gap outside rounding bucket ' + r.reference_month);
    if (!r.release_at || !r.release_date) throw Error('Missing release timestamp ' + r.reference_month);
    return { month:r.reference_month, monthIndex:calendarMonthIndex(r.reference_month), releaseAt:r.release_at, releaseDate:r.release_date, published:x.u3_published, gap };
  });
  ready.sort((a,b)=>a.monthIndex-b.monthIndex);
  for(let i=1;i<ready.length;i++) if(ready[i].monthIndex===ready[i-1].monthIndex) throw Error('Duplicate first print ' + ready[i].month);
  const result={pairs:[],rejected:[]};
  for(let i=1;i<ready.length;i++) {
    const prev=ready[i-1], next=ready[i];
    if(next.monthIndex!==prev.monthIndex+1) {result.rejected.push({month:next.month,reason:'NONADJACENT_MONTH'});continue;}
    const cutoff=cutoffFor(next.releaseDate);
    if(prev.releaseAt>cutoff) {result.rejected.push({month:next.month,reason:'PRIOR_PRINT_AFTER_FORECAST_CUTOFF'});continue;}
    result.pairs.push({month:next.month,prevMonth:prev.month,priorPublished:prev.published,priorGap:prev.gap,delta:+(next.published-prev.published).toFixed(3)});
  }
  return result;
}
function mean(a){return a.length?a.reduce((s,v)=>s+v,0)/a.length:null}
export function pairCorrelation(pairs){
  if(pairs.length<2)return null;
  const xs=pairs.map(p=>p.priorGap),ys=pairs.map(p=>p.delta),mx=mean(xs),my=mean(ys);
  const num=xs.reduce((s,x,i)=>s+(x-mx)*(ys[i]-my),0);
  const den=Math.sqrt(xs.reduce((s,x)=>s+(x-mx)**2,0)*ys.reduce((s,y)=>s+(y-my)**2,0));
  return den?num/den:null;
}
export function bucketSummary(pairs){
  const buckets={low:[],mid:[],high:[]};
  for(const p of pairs) buckets[p.priorGap<-ROUNDED_GAP_BAND?'low':p.priorGap>ROUNDED_GAP_BAND?'high':'mid'].push(p);
  const summarize=list=>({n:list.length,up:list.filter(p=>p.delta>0).length,flat:list.filter(p=>p.delta===0).length,down:list.filter(p=>p.delta<0).length,upShare:list.length?list.filter(p=>p.delta>0).length/list.length:null,meanDelta:mean(list.map(p=>p.delta))});
  return Object.fromEntries(Object.entries(buckets).map(([key,v])=>[key,summarize(v)]));
}
export function upRateDifference(pairs){const b=bucketSummary(pairs);return b.high.n&&b.low.n?b.high.upShare-b.low.upShare:null;}
export function bootstrapGap(pairs,{seed=20261008,reps=5000,block=12}={}){
  const orig=upRateDifference(pairs);
  let state=seed>>>0;const random=()=>{state=(1664525*state+1013904223)>>>0;return state/2**32};
  const values=[];
  if(!pairs.length)return{effect:null,ci95:null};
  for(let j=0;j<reps;j++) {
    const sample=[];
    while(sample.length<pairs.length){const i=Math.floor(random()*pairs.length);for(let k=0;k<block&&sample.length<pairs.length;k++) sample.push(pairs[(i+k)%pairs.length]);}
    const v=upRateDifference(sample);if(v!==null&&Number.isFinite(v))values.push(v);
  }
  values.sort((a,b)=>a-b);
  return{effect:orig,ci95:values.length?[values[Math.floor(.025*values.length)],values[Math.min(values.length-1,Math.floor(.975*values.length))]]:null,repsUsed:values.length};
}
export function report(releases, cutoffFor){
 const {pairs,rejected}=nextRatePairs(releases,cutoffFor);
 const selections={all:pairs,ex2020_21:pairs.filter(x=>x.month<'2020-03'||x.month>'2021-12'),since2022:pairs.filter(x=>x.month>='2022-01')};
 return{sourceReleaseCount:releases.length,eligiblePairCount:pairs.length,rejected,periods:Object.fromEntries(Object.entries(selections).map(([key,p])=>[key,{n:p.length,corr:pairCorrelation(p),buckets:bucketSummary(p),bootstrap:bootstrapGap(p)}]))};
}
