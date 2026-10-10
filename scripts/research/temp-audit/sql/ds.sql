select d.* from pred_forecast_designations d where d.contract_id in (select contract_id from pred_contracts where event_type = 'MAX_TEMP_BUCKET')
