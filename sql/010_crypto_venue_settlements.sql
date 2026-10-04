-- 010: BTC SHADOW venue settlement observations (owner-approved additive storage fix, 2026-10-04).
--
-- Polymarket settles (UMA, Chainlink stream) after Kalshi; pred_crypto_resolutions is written once at Kalshi's result
-- and is never updated. This append-only table records each venue's own settlement when OUR reader first observes
-- it — for venue-result agreement / audit ONLY. The frozen SHADOW scoring target stays Kalshi's published YES/NO
-- (pred_crypto_resolutions / pred_crypto_scores are untouched) unless a new protocol version says otherwise.
--
-- Timestamps are never invented: observed_at = when our reader saw the settled state; source_settled_at = the
-- timestamp the venue itself supplied (Kalshi settlement_ts, Polymarket umaEndDate), null if none; the raw source
-- fields are kept in ref.

begin;

create table pred_crypto_venue_settlements (
  settlement_id bigint generated always as identity primary key,
  window_id text not null references pred_crypto_windows(window_id),
  venue text not null check (venue in ('kalshi', 'polymarket')),
  market_id text not null,
  result text not null,                                 -- venue-native: kalshi yes|no, polymarket up|down
  direction text not null check (direction in ('UP', 'DOWN')),
  observed_at timestamptz not null,                     -- OUR first observation of the settled state
  source_settled_at timestamptz,                        -- as supplied by the venue, else null (never derived)
  source text not null,                                 -- endpoint family the result was read from
  ref jsonb not null default '{}'::jsonb,               -- raw settlement fields exactly as supplied
  created_at timestamptz not null default now(),
  unique (window_id, venue),
  check ((venue = 'kalshi' and result in ('yes', 'no') and direction = case result when 'yes' then 'UP' else 'DOWN' end)
      or (venue = 'polymarket' and result in ('up', 'down') and direction = upper(result)))
);

create trigger pred_crypto_venue_settlements_no_update before update or delete on pred_crypto_venue_settlements
  for each row execute function pred_reject_mutation();
create trigger pred_crypto_venue_settlements_no_truncate before truncate on pred_crypto_venue_settlements
  for each statement execute function pred_reject_mutation();
alter table pred_crypto_venue_settlements enable row level security;
revoke truncate, update, delete on pred_crypto_venue_settlements from anon, authenticated, service_role;

commit;
