-- =============================================================================
-- test_loyalty_storefront_content.sql — non-destructive test of 0220: the shop
-- metafield carries signup_points and the campaigns the theme can announce.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_storefront_content.sql
--
-- To see it FAIL:
--   * drop "and ends_at > now()" from the campaigns subquery
--     -> "campaigns: an ended campaign is left out" fails.
--   * drop "and is_active" from it -> "campaigns: a paused campaign is left out" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_j      jsonb;
  v_c      jsonb;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Content Test', 'loyalty-content-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar)
  values (v_client, 'content-test.myshopify.com', 'Wave Rewards', 3) returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values (v_prog, 'bronze', 'Bronze', 0, 0);

  v_j := loyalty_shop_program_json(v_prog);
  assert v_j->'signup_points' = 'null'::jsonb, 'signup: null without a signup rule';
  assert v_j->'campaigns' = '[]'::jsonb, 'campaigns: empty list, not null';

  insert into loyalty_earn_rules (program_id, key, kind, points) values (v_prog, 'signup', 'action', 100);
  assert (loyalty_shop_program_json(v_prog)->>'signup_points')::int = 100, 'signup: the rule''s points';
  update loyalty_earn_rules set is_active = false where program_id = v_prog and key = 'signup';
  assert loyalty_shop_program_json(v_prog)->'signup_points' = 'null'::jsonb, 'signup: an inactive rule is left out';

  insert into loyalty_campaigns (program_id, key, name, kind, multiplier, flat_points, starts_at, ends_at, collection_gid, product_tag, is_active) values
    (v_prog, 'running_all', 'Double points weekend', 'multiplier', 2, null, now() - interval '1 day', now() + interval '2 days', null, null, true),
    (v_prog, 'running_coll', 'New arrivals bonus', 'flat', null, 50, now() - interval '1 hour', now() + interval '5 days', 'gid://shopify/Collection/123456789', null, true),
    (v_prog, 'upcoming_tag', 'Triple on gummies', 'multiplier', 3, null, now() + interval '3 days', now() + interval '6 days', null, 'gummies', true),
    (v_prog, 'ended', 'Last week', 'multiplier', 2, null, now() - interval '9 days', now() - interval '2 days', null, null, true),
    (v_prog, 'paused', 'Paused one', 'multiplier', 2, null, now() - interval '1 day', now() + interval '2 days', null, null, false);

  v_j := loyalty_shop_program_json(v_prog);
  assert jsonb_array_length(v_j->'campaigns') = 3, 'campaigns: running and upcoming only';
  assert not exists (select 1 from jsonb_array_elements(v_j->'campaigns') c where c->>'key' = 'ended'), 'campaigns: an ended campaign is left out';
  assert not exists (select 1 from jsonb_array_elements(v_j->'campaigns') c where c->>'key' = 'paused'), 'campaigns: a paused campaign is left out';
  assert v_j->'campaigns'->0->>'key' = 'running_all', 'campaigns: soonest start first';

  select c into v_c from jsonb_array_elements(v_j->'campaigns') c where c->>'key' = 'running_coll';
  assert v_c->>'collection_id' = '123456789', 'scope: numeric collection id from the gid (Liquid compares collection.id)';
  assert (v_c->>'flat_points')::int = 50 and v_c->'multiplier' = 'null'::jsonb, 'kind: flat bonus';
  assert (v_c->>'ends_at')::bigint between extract(epoch from now() + interval '5 days')::bigint - 5
                                       and extract(epoch from now() + interval '5 days')::bigint + 5, 'dates: epoch seconds';
  select c into v_c from jsonb_array_elements(v_j->'campaigns') c where c->>'key' = 'upcoming_tag';
  assert v_c->>'product_tag' = 'gummies' and v_c->'collection_id' = 'null'::jsonb, 'scope: product tag';

  -- The metafield must not churn: same input, same JSON (the hash check resyncs on change only).
  assert md5(loyalty_shop_program_json(v_prog)::text) = md5(v_j::text), 'hash: stable between calls';
  assert (loyalty_shopify_work(v_prog)->'program_metafield') <> 'null'::jsonb, 'sync: a new campaign marks the metafield for sync';

  raise notice 'test_loyalty_storefront_content: all assertions passed';
end;
$$;

rollback;
