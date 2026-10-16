-- =============================================================================
-- 0220 — LL Loyalty: what the product page CTAs and the rewards strip need in
-- the shop metafield ll_loyalty.program (0212 / 0218 otherwise unchanged).
--
--   signup_points  the active 'signup' earn rule's points, for "Join free and
--                  earn 100 points" (null when there's no such rule)
--   campaigns      active bonus campaigns that haven't ended (0214), soonest
--                  first, at most 10: name, kind, multiplier / flat points,
--                  starts_at / ends_at as epoch seconds (Liquid compares them
--                  with 'now'), and the scope: collection_id (numeric, from
--                  collection_gid) or product_tag, neither = every product.
--
-- The JSON only changes when a campaign is created, edited, paused or ends, so
-- loyalty_shopify_has_work picks it up through the existing hash check.
-- Campaign bonuses only pay treatment members once nudges are live, so the
-- theme shows them under the same rule (nudges_live, customer group).
-- =============================================================================

create or replace function loyalty_shop_program_json(p_program uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'name', p.name,
    'points_per_dollar', p.points_per_dollar,
    'code_prefix', p.discount_code_prefix,
    'nudges_live', p.treatment_since is not null and p.treatment_since <= now(),
    'signup_points', (select e.points from loyalty_earn_rules e
                       where e.program_id = p.id and e.key = 'signup' and e.is_active),
    'tiers', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'min_spend_cents', t.min_spend_cents,
                                                           'multiplier', t.earn_multiplier) order by t.rank), '[]'::jsonb)
                from loyalty_tiers t where t.program_id = p.id),
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object('key', r.key, 'name', r.name, 'points_cost', r.points_cost,
                                                             'value_cents', r.value_cents, 'min_order_cents', r.min_order_cents,
                                                             'max_units', r.max_units)
                                          order by r.points_cost, r.key), '[]'::jsonb)
                  from loyalty_rewards r where r.program_id = p.id and r.is_active and r.points_cost is not null),
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
                           'key', c.key, 'name', c.name, 'kind', c.kind, 'multiplier', c.multiplier, 'flat_points', c.flat_points,
                           'starts_at', extract(epoch from c.starts_at)::bigint, 'ends_at', extract(epoch from c.ends_at)::bigint,
                           'collection_id', substring(c.collection_gid from '[0-9]+$'), 'product_tag', c.product_tag)
                         order by c.starts_at, c.key), '[]'::jsonb)
                    from (select * from loyalty_campaigns
                           where program_id = p.id and is_active and ends_at > now()
                           order by starts_at, key limit 10) c))
    from loyalty_programs p where p.id = p_program;
$$;
