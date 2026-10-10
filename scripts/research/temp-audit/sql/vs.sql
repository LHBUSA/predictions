select v.contract_id, v.captured_at, v.probability, v.bid, v.ask, v.last_price, v.market_status, v.volume
from pred_venue_snapshots v where v.contract_id in (select contract_id from pred_contracts where event_type='MAX_TEMP_BUCKET')
