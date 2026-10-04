-- 008: TRUNCATE guard for pred_contracts (owner-approved 2026-10-04; final ledger-hardening follow-up). Additive only.
-- pred_contracts is append-only by design (a rules change = a new contract_id) and already rejects UPDATE/DELETE
-- (pred_contracts_no_update, sql/002). This adds the statement-level TRUNCATE rejection and revokes TRUNCATE from the
-- API roles, exactly as 007 did for the other ledger tables. pred_events stays mutable and untouched.
create trigger pred_contracts_no_truncate before truncate on pred_contracts for each statement execute function pred_reject_mutation();
revoke truncate on pred_contracts from service_role, anon, authenticated;
