// Research only: selection consumes an independently validated forecast and snapshot prices.
export const POLICY=Object.freeze({version:'selective-edge/0.1-research',maxQuoteAgeSeconds:7200,maxSpread:.10,minGrossEdge:.10,minNetEdge:.04,probabilityBuffer:.05,feeReserve:.02,maxSelectionsPerEvent:1});
const prob=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1;
export function chooseOne(event,policy=POLICY){
 if(!event||!Number.isFinite(event.cutoffEpoch)||!Array.isArray(event.contracts))throw Error('INVALID_EVENT');
 const refusals={};const reject=k=>{refusals[k]=(refusals[k]||0)+1};
 if(event.modelStatus!=='VALIDATED')return{status:'PASS',reason:'MODEL_NOT_VALIDATED',refusals,selected:null};
 if(!Number.isFinite(event.captureAt)||!Number.isFinite(event.releaseAt)||event.captureAt>event.cutoffEpoch||event.releaseAt<=event.cutoffEpoch)return{status:'PASS',reason:'INVALID_CAPTURE_TIMING',refusals,selected:null};
 const eligible=[];
 for(const c of event.contracts){
  if(c.termsOk!==true){reject('UNVERIFIED_TERMS');continue}
  if(!prob(c.pYes)){reject('BAD_MODEL_PROBABILITY');continue}
  if(!Number.isFinite(c.quoteAt)||c.quoteAt>event.cutoffEpoch||event.cutoffEpoch-c.quoteAt>policy.maxQuoteAgeSeconds){reject('STALE_OR_FUTURE_QUOTE');continue}
  if(!prob(c.yesBid)||!prob(c.yesAsk)||c.yesBid>c.yesAsk){reject('INVALID_QUOTE');continue}
  if(c.yesAsk-c.yesBid>policy.maxSpread){reject('WIDE_SPREAD');continue}
  if(c.liquidityVerified!==true){reject('UNVERIFIED_LIQUIDITY');continue}
  for(const side of ['YES','NO']){
   const cost=side==='YES'?c.yesAsk:1-c.yesBid;
   const p=side==='YES'?c.pYes-policy.probabilityBuffer:1-c.pYes-policy.probabilityBuffer;
   const gross=p-cost,net=gross-policy.feeReserve;
   if(gross>=policy.minGrossEdge&&net>=policy.minNetEdge)eligible.push({ticker:c.ticker,side,cost,probability:p,netEdge:net,grossEdge:gross,feeReserve:policy.feeReserve});
  }
 }
 eligible.sort((a,b)=>b.netEdge-a.netEdge||a.ticker.localeCompare(b.ticker)||a.side.localeCompare(b.side));
 return eligible.length?{status:'RESEARCH_CANDIDATE',reason:'PRECOMMITTED_THRESHOLD',refusals,selected:eligible[0],eligibleCount:eligible.length}:{status:'PASS',reason:'NO_QUALIFYING_CONTRACT',refusals,selected:null};
}
export function settle(selection,outcomes){
 if(selection.status!=='RESEARCH_CANDIDATE'||!selection.selected)return{status:'NOT_SELECTED'};
 const s=selection.selected,o=outcomes?.[s.ticker];if(o!==0&&o!==1)return{status:'UNSETTLED'};
 const won=s.side==='YES'?o===1:o===0;
 return{status:'SCORED',won,netPayoutPerDollar:(won?1:0)-s.cost-s.feeReserve};
}