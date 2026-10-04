-- 009: BTC 15-minute nowcast SHADOW ledger (owner decision 2026-10-04: "Proceed to BTC SHADOW").
-- docs/research/CRYPTO_NOWCAST_AUDIT.md + docs/research/CRYPTO_SHADOW_V1.md.
--
-- ISOLATED from the public ledger on purpose: no row here is read by any public route (pred_events / the live slate /
-- the sitemap never see a BTC window), so nothing is activated publicly. Append-only like 001/002/007: row-level
-- update/delete and statement-level TRUNCATE are rejected by pred_reject_mutation() (sql/001).
--
-- Rights rules (owner): public exchange observations are research/model INPUTS; only OUR derived values are stored
-- (features, probabilities, designations, scores). Raw exchange feeds are not stored. CF Benchmarks' BRTI is never
-- ingested, stored or displayed: there is deliberately NO column for Kalshi's strike (floor_strike) or expiration
-- value (both are BRTI averages). The window target used by the model is OUR exchange proxy. Resolution = Kalshi's
-- published yes/no result only. Kalshi / Polymarket are benchmarks, never inputs (features CHECKed market-free with
-- the generated pred_features_market_free() from sql/004).

begin;

create table pred_crypto_windows (
  window_id text primary key,                      -- 'BTC15M:<open ISO>'
  asset text not null check (asset = 'BTC'),
  horizon_min integer not null check (horizon_min = 15),
  open_at timestamptz not null,
  close_at timestamptz not null,
  settle_rule text not null,                       -- 'avg60(close) >= avg60(open)'; tie UP; missing data DOWN
  kalshi_market_ticker text,                       -- KXBTC15M market for this window (identity only, never its strike)
  polymarket_slug text,                            -- btc-updown-15m-<open epoch> (SAME_WINDOW_DIFFERENT_INDEX)
  proxy_open_usd numeric not null check (proxy_open_usd > 0), -- OUR derived reference (exchange typical-price mean)
  proxy_basis jsonb not null,                      -- {exchanges, minute, rule} — derivation, no raw feed
  created_at timestamptz not null default now(),
  check (close_at = open_at + interval '15 minutes')
);

create table pred_crypto_forecasts (
  forecast_id bigint generated always as identity primary key,
  window_id text not null references pred_crypto_windows(window_id),
  model_id text not null,
  model_version text not null,
  model_state text not null check (model_state = 'SHADOW'),
  captured_at timestamptz not null,
  data_cutoff_at timestamptz not null,
  p_up numeric not null check (p_up >= 0 and p_up <= 1),
  features jsonb not null check (pred_features_market_free(features)),
  features_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (window_id, model_id, captured_at),
  check (data_cutoff_at <= captured_at)
);

create table pred_crypto_venue_obs (
  obs_id bigint generated always as identity primary key,
  window_id text not null references pred_crypto_windows(window_id),
  venue text not null check (venue in ('kalshi', 'polymarket')),
  market_id text not null,
  captured_at timestamptz not null,
  bid numeric check (bid is null or (bid >= 0 and bid <= 1)),
  ask numeric check (ask is null or (ask >= 0 and ask <= 1)),
  mid numeric check (mid is null or (mid >= 0 and mid <= 1)), -- only when both sides and width <= 0.10
  market_status text,
  comparability text not null check (comparability in ('SAME_CONTRACT', 'SAME_WINDOW_DIFFERENT_INDEX')),
  created_at timestamptz not null default now(),
  unique (window_id, venue, captured_at)
);

create table pred_crypto_designations (
  designation_id bigint generated always as identity primary key,
  window_id text not null references pred_crypto_windows(window_id),
  model_id text not null,
  designation text not null check (designation in ('FIRST_PUBLISHED', 'T_MINUS_10', 'T_MINUS_5', 'T_MINUS_1', 'FINAL_PRE_RESOLUTION')),
  forecast_id bigint not null references pred_crypto_forecasts(forecast_id),
  reference_time timestamptz not null,
  rule_version text not null,
  kalshi_obs_id bigint references pred_crypto_venue_obs(obs_id),      -- venue obs within +-30 s of the forecast, else null
  polymarket_obs_id bigint references pred_crypto_venue_obs(obs_id),
  created_at timestamptz not null default now(),
  unique (window_id, model_id, designation)
);

create table pred_crypto_resolutions (
  window_id text primary key references pred_crypto_windows(window_id),
  venue_result text not null check (venue_result in ('yes', 'no')),  -- Kalshi's published outcome (YES = UP)
  venue_settled_at timestamptz,
  proxy_close_usd numeric,                                             -- OUR exchange proxy at close (independent check)
  proxy_result text check (proxy_result in ('yes', 'no')),
  proxy_agrees boolean,
  polymarket_result text check (polymarket_result in ('up', 'down')),  -- different index; venue-agreement stat only
  resolved_at timestamptz not null default now()
);

create table pred_crypto_scores (
  score_id bigint generated always as identity primary key,
  designation_id bigint not null references pred_crypto_designations(designation_id),
  window_id text not null references pred_crypto_windows(window_id),
  designation text not null,
  method text not null check (method in ('brier', 'log_loss')),
  outcome smallint not null check (outcome in (0, 1)),
  pbe_p numeric not null,
  pbe_score numeric not null,
  kalshi_p numeric,
  kalshi_score numeric,
  polymarket_p numeric,
  polymarket_score numeric,                                            -- different index: reported, labelled, never pooled
  created_at timestamptz not null default now(),
  unique (designation_id, method)
);

create index pred_crypto_forecasts_window_idx on pred_crypto_forecasts (window_id, captured_at);
create index pred_crypto_venue_obs_window_idx on pred_crypto_venue_obs (window_id, venue, captured_at);
create index pred_crypto_windows_close_idx on pred_crypto_windows (close_at);

do $$
declare t text;
begin
  foreach t in array array['pred_crypto_windows', 'pred_crypto_forecasts', 'pred_crypto_venue_obs', 'pred_crypto_designations', 'pred_crypto_resolutions', 'pred_crypto_scores'] loop
    execute format('create trigger %I before update or delete on %I for each row execute function pred_reject_mutation()', t || '_no_update', t);
    execute format('create trigger %I before truncate on %I for each statement execute function pred_reject_mutation()', t || '_no_truncate', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke truncate, update, delete on %I from anon, authenticated, service_role', t);
  end loop;
end $$;

commit;
