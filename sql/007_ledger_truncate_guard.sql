-- 007: TRUNCATE guard for the legacy append-only Predictions ledger tables (owner-approved 2026-10-04). Additive only.
-- Row-level `before update or delete` triggers (sql/001, sql/002) do not fire on TRUNCATE, and Supabase's default
-- grants give service_role TRUNCATE. This adds a statement-level `before truncate` trigger (same pred_reject_mutation()
-- function) and revokes TRUNCATE from the API roles, on EXACTLY the tables whose contract is append-only.
-- Deliberately NOT included: pred_events (mutable current-state registry). pred_decisions already has its guard (006).
-- INSERT is untouched; corrections/revisions continue as new rows.

create trigger pred_source_observations_no_truncate before truncate on pred_source_observations for each statement execute function pred_reject_mutation();
create trigger pred_feature_snapshots_no_truncate before truncate on pred_feature_snapshots for each statement execute function pred_reject_mutation();
create trigger pred_forecasts_no_truncate before truncate on pred_forecasts for each statement execute function pred_reject_mutation();
create trigger pred_venue_snapshots_no_truncate before truncate on pred_venue_snapshots for each statement execute function pred_reject_mutation();
create trigger pred_resolutions_no_truncate before truncate on pred_resolutions for each statement execute function pred_reject_mutation();
create trigger pred_scores_no_truncate before truncate on pred_scores for each statement execute function pred_reject_mutation();
create trigger pred_forecast_designations_no_truncate before truncate on pred_forecast_designations for each statement execute function pred_reject_mutation();

revoke truncate on pred_source_observations, pred_feature_snapshots, pred_forecasts, pred_venue_snapshots,
  pred_resolutions, pred_scores, pred_forecast_designations from service_role, anon, authenticated;
