select s.* from pred_scores s where s.contract_id in (select contract_id from pred_contracts where event_type = 'MAX_TEMP_BUCKET')
