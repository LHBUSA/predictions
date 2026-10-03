-- Rollback for 004_features_market_free_v2: restores the exact sql/002 function body (narrower denylist) and
-- re-adds the CHECK. Safe at any time: every row valid under v2 is valid under the narrower v1 rule.
-- The code guard (src/engine/leakage.js) stays strict regardless; this only loosens the DB backstop.

begin;

alter table pred_feature_snapshots drop constraint if exists pred_feature_snapshots_market_free;

create or replace function pred_features_market_free(doc jsonb)
returns boolean
language sql
immutable
as $$
  select not exists (
    select 1
    from jsonb_path_query(coalesce(doc, '{}'::jsonb), 'strict $.**') as node(v)
    cross join lateral jsonb_object_keys(case when jsonb_typeof(node.v) = 'object' then node.v else '{}'::jsonb end) as k(key)
    where k.key ~* '(kalshi|market|venue|yes_bid|yes_ask|no_bid|no_ask|last_price|order_?book|open_interest|liquidity|implied_prob|settlement|traded|volume)'
  ) and not exists (
    select 1 from jsonb_object_keys(case when jsonb_typeof(doc) = 'object' then doc else '{}'::jsonb end) as k(key)
    where k.key ~* '(kalshi|market|venue|yes_bid|yes_ask|no_bid|no_ask|last_price|order_?book|open_interest|liquidity|implied_prob|settlement|traded|volume)'
  )
$$;

comment on function pred_features_market_free(jsonb) is null;

alter table pred_feature_snapshots
  add constraint pred_feature_snapshots_market_free check (pred_features_market_free(features));

commit;
