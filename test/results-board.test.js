import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assembleScorecard } from '../workers/pbe-predictions/src/results-board.js';

const e=(id,title)=>({event_id:id,slug:'event-'+id,canonical_question:title,category:'WEATHER'});
const c=(id,eventId,label,type='MAX_TEMP_BUCKET')=>({contract_id:id,event_id:eventId,market_id:'m-'+id,outcome_label:label,event_type:type});
const f=(id,contract,p)=>({forecast_id:id,contract_id:contract,probability:p,model_state:'RESEARCH',captured_at:'2026-10-01T01:00:00Z'});
const s=(id,outcome)=>({forecast_id:'f-'+id,contract_id:id,designation:'FINAL_PRE_RESOLUTION',scoring_method:'brier',outcome,scored_at:'2026-10-07T01:00:00Z'});
test('one completed multi-bucket event counts once, no artificial NO accuracy inflation',()=>{
 const data={ events:[e('A','High in Austin?')], contracts:[c('a1','A','95'),c('a2','A','96'),c('a3','A','97'),c('a4','A','98')], forecasts:[f('f-a1','a1',.1),f('f-a2','a2',.6),f('f-a3','a3',.2),f('f-a4','a4',.1)],scores:[s('a1',0),s('a2',0),s('a3',1),s('a4',0)] };
 const r=assembleScorecard(data);
 assert.deepEqual([r.top_outcome.events,r.top_outcome.matched,r.top_outcome.missed],[1,0,1]);
 assert.equal(r.top_outcome.rows[0].picked,'96');assert.equal(r.top_outcome.rows[0].actual,'97');
 assert.equal(r.top_outcome.rows[0].classification,'DESCRIPTIVE_TOP_OUTCOME_NOT_OFFICIAL_PICK');
});
test('a matched completed event is one result and a lone threshold is excluded',()=>{
 const data={events:[e('A','Temp'),e('B','Threshold')],contracts:[c('a1','A','96'),c('a2','A','97'),c('b1','B','Any rain','PRECIP_ANY')],
 forecasts:[f('f-a1','a1',.8),f('f-a2','a2',.2),f('f-b1','b1',.9)],scores:[s('a1',1),s('a2',0),s('b1',1)]};
 const r=assembleScorecard(data);assert.deepEqual([r.top_outcome.events,r.top_outcome.matched],[1,1]);
});
test('ungraded, incomplete, and shadow forecasts cannot become a win',()=>{
 const data={events:[e('A','Temp')],contracts:[c('a1','A','96'),c('a2','A','97')],
 forecasts:[f('f-a1','a1',.8),{...f('f-a2','a2',.2),model_state:'SHADOW'}],scores:[s('a1',1),s('a2',0)]};
 assert.equal(assembleScorecard(data).top_outcome.events,0);
});
test('research calls never become official and use their locked forecast only',()=>{
 const data={events:[e('A','Rain')],contracts:[c('a1','A','YES','PRECIP_ANY')],forecasts:[f('f-a1','a1',.8)],
 scores:[s('a1',1)],decisions:[{decision_id:'d1',contract_id:'a1',forecast_id:'f-a1',state:'CALL',side:'YES',policy_status:'FROZEN_PROSPECTIVE',official_at_decision:false,decision_as_of:'2026-10-01T01:00:00Z'}]};
 const r=assembleScorecard(data);assert.equal(r.prospective.matched,1);assert.equal(r.official.calls,0);
 const other={...data,decisions:[{...data.decisions[0],forecast_id:'not-scored'}]};
 assert.equal(assembleScorecard(other).prospective.pending,1);
});
test('no eligible settled results stay empty, not a fake win rate',()=>{
 const r=assembleScorecard();assert.equal(r.top_outcome.events,0);assert.equal(r.official.calls,0);
});
test('the member route is gated before any scorecard load',()=>{
 const src=readFileSync(new URL('../workers/pbe-predictions/src/index.js',import.meta.url),'utf8');
 const i=src.indexOf("if (p === '/v1/premium/results-board')");
 assert.ok(i>0);const block=src.slice(i,i+220);
 assert.ok(block.indexOf('requireAllAccess')>=0);assert.ok(block.indexOf('requireAllAccess')<block.indexOf('memberScorecard'));
 assert.match(block,/privateJson/);
});
test('official picks (activated 2026-10-09): RIGHT/MISSED from their own locked forecast, VOID on a venue void, PENDING until settled; earlier calls stay research',()=>{
 const off=(id,side,extra={})=>({decision_id:'d-'+id,contract_id:id,forecast_id:'f-'+id,state:'CALL',side,policy_status:'OFFICIAL',official_at_decision:true,decision_as_of:'2026-10-10T05:30:00Z',...extra});
 const data={events:[e('A','Rain')],contracts:['r1','r2','r3','r4','r5'].map(id=>c(id,'A','YES','PRECIP_ANY')),forecasts:['r1','r2','r3','r4','r5'].map(id=>f('f-'+id,id,.8)),
  scores:[s('r1',1),s('r2',1)],
  decisions:[off('r1','YES'),off('r2','NO'),off('r3','YES'),off('r4','NO'),
   {...off('r5','YES'),policy_status:'FROZEN_PROSPECTIVE',official_at_decision:false,decision_as_of:'2026-10-08T05:30:00Z'}],
  voids:[{contract_id:'r4',venue_result:'void'}]};
 const r=assembleScorecard(data);
 const by=Object.fromEntries(r.official.rows.map(x=>[x.side+x.decided_at+x.result,x]));
 assert.deepEqual([r.official.calls,r.official.matched,r.official.missed,r.official.pending,r.official.void],[4,1,1,1,1]);
 assert.deepEqual(r.official.rows.map(x=>x.result).sort(),['MATCHED','MISSED','PENDING','VOID']);
 assert.equal(r.official.rows.find(x=>x.result==='VOID').actual,'VOID');
 assert.equal(r.prospective.calls,1,'the pre-activation call stays research');
 assert.equal(r.official.policy.activated_at,'2026-10-09T21:15:00Z');
 assert.equal(r.official.policy.status,'OFFICIAL');
 assert.ok(by);
});
