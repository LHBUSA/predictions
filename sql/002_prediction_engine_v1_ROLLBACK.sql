-- Rollback for 002_prediction_engine_v1. Restores the exact 001 shape.
-- Only safe while the new tables/columns hold no records worth keeping: export them first.
begin;

drop trigger if exists pred_forecast_designations_consistent on pred_forecast_designations;
drop trigger if exists pred_forecast_designations_no_update on pred_forecast_designations;
drop trigger if exists pred_contracts_no_update on pred_contracts;
drop function if exists pred_designation_consistent();

drop index if exists pred_scores_designation_unique;
alter table pred_scores
  drop constraint if exists pred_scores_designation_check,
  drop constraint if exists pred_scores_outcome_check,
  drop column if exists contract_id,
  drop column if exists designation,
  drop column if exists market_probability,
  drop column if exists outcome;

drop table if exists pred_forecast_designations;

drop index if exists pred_resolutions_contract_idx;
alter table pred_resolutions
  drop constraint if exists pred_resolutions_official_outcome_check,
  drop constraint if exists pred_resolutions_venue_result_check,
  drop column if exists contract_id,
  drop column if exists market_id,
  drop column if exists official_outcome,
  drop column if exists official_value,
  drop column if exists official_units,
  drop column if exists official_source,
  drop column if exists official_observation_key,
  drop column if exists venue_result,
  drop column if exists venue_settlement_value,
  drop column if exists venue_expiration_value,
  drop column if exists venue_settled_at,
  drop column if exists sources_agree;

drop index if exists pred_forecasts_contract_idx;
alter table pred_forecasts
  drop constraint if exists pred_forecasts_market_probability_check,
  drop constraint if exists pred_forecasts_market_before_capture,
  drop constraint if exists pred_forecasts_cutoff_before_capture,
  drop constraint if exists pred_forecasts_model_state_check,
  drop constraint if exists pred_forecasts_confidence_check,
  drop constraint if exists pred_forecasts_revision_reason,
  drop column if exists divergence_points,
  drop column if exists contract_id,
  drop column if exists market_id,
  drop column if exists market_probability,
  drop column if exists market_snapshot_key,
  drop column if exists market_observed_at,
  drop column if exists data_cutoff_at,
  drop column if exists model_state,
  drop column if exists confidence,
  drop column if exists features_sha256,
  drop column if exists revision_reason,
  drop column if exists revision_of;

drop index if exists pred_venue_snapshots_contract_idx;
alter table pred_venue_snapshots
  drop constraint if exists pred_venue_lifecycle_check,
  drop column if exists contract_id,
  drop column if exists no_bid,
  drop column if exists no_ask,
  drop column if exists last_price,
  drop column if exists volume_24h,
  drop column if exists market_status,
  drop column if exists lifecycle,
  drop column if exists close_time,
  drop column if exists source_updated_at,
  drop column if exists normalizer;

drop table if exists pred_contracts;

drop index if exists pred_events_venue_event_idx;
alter table pred_events
  drop constraint if exists pred_events_domain_check,
  drop constraint if exists pred_events_model_state_check,
  drop constraint if exists pred_events_lifecycle_check,
  drop column if exists domain,
  drop column if exists event_family,
  drop column if exists venue,
  drop column if exists venue_event_id,
  drop column if exists venue_series_id,
  drop column if exists model_family,
  drop column if exists model_state,
  drop column if exists lifecycle,
  drop column if exists close_time,
  drop column if exists first_discovered_at;

alter table pred_feature_snapshots drop constraint if exists pred_feature_snapshots_market_free;
drop function if exists pred_features_market_free(jsonb);

commit;
