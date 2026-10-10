select f.forecast_id, f.contract_id, f.model_id, f.model_version, f.model_state, f.probability, f.captured_at, f.data_cutoff_at, f.market_probability, f.market_observed_at, f.confidence, f.record_type, f.explanation
from pred_forecasts f where f.contract_id in (select contract_id from pred_contracts where event_type='MAX_TEMP_BUCKET')
