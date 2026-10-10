select s.designation, s.scoring_method, c.event_type, count(*) n,
 round(avg(s.score)::numeric, 4) pbe_all,
 count(s.benchmark_score) paired_n,
 round(avg(s.score) filter (where s.benchmark_score is not null)::numeric, 4) pbe_paired,
 round(avg(s.benchmark_score)::numeric, 4) mkt_paired,
 count(distinct c.event_id) events,
 count(distinct (c.detail->>'climate_date')) dates
from pred_scores s join pred_contracts c on c.contract_id = s.contract_id
join pred_forecasts f on f.forecast_id = s.forecast_id and f.model_state <> 'SHADOW'
where s.designation = 'FINAL_PRE_RESOLUTION'
group by 1,2,3 order by 2,3
