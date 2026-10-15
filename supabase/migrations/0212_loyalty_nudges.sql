-- =============================================================================
-- 0212_loyalty_nudges.sql — Phase 1b module 11: cart + checkout nudges
-- (plan §6). Builds on 0200-0211.
--
-- CART (Tinker's drawer, J's cart-rewards-bar snippet). Computed in Liquid on
-- every drawer render, so it follows the cart total with no extra request:
--   customer metafields ll_loyalty.tier / .points (0203) plus, new here,
--     .tier_spend_cents  spend counted toward the tier
--     .group             'treatment' | 'holdout' (0211's fixed bucket)
--   shop metafield ll_loyalty.program (json): name, points per dollar, code
--     prefix, tiers (thresholds + multipliers), points rewards, nudges_live.
-- Rules come from the shop metafield, so the theme never hard-codes them.
-- Redeem in cart reuses the proxy's POST /redeem (0204).
--
-- WHAT THE HOLDOUT SEES. Joy parity stays for everyone: "points this order
-- earns" (Joy's points calculator) and redeem in cart (Joy's redeem inline).
-- The NEW nudges at purchase moments, "$X more to reach Silver" and next
-- reward progress in the cart and on the thank-you page, show only when
--   program nudges_live (treatment_since is set: module 11 is the first
--   Phase 1b feature, so going live = setting treatment_since) and
--   the member is in the treatment group.
-- The account page block mirrors the Wave Rewards page (Phase 1), so it's
-- the same for both groups.
--
-- EXTENSIONS (thank-you, order status, account profile) call loyalty-ext with
-- a Shopify session token; loyalty_extension_state is what they get.
--
-- Existing members re-sync once after this lands (their spend/group were
-- never pushed): about 4,500 members at 120 a minute, under 40 minutes.
--
-- Test: scripts/test_loyalty_nudges.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_members add column if not exists shopify_synced_spend_cents bigint;
alter table loyalty_members add column if not exists shopify_synced_group text;

-- Metafield definitions are versioned so new ones reach stores that already
-- have 0203's two. 1 = tier + points (0203), 2 = + tier_spend_cents, group,
-- shop program.
alter table loyalty_programs add column if not exists shopify_definitions_version int not null default 0;
update loyalty_programs set shopify_definitions_version = 1
 where shopify_definitions_at is not null and shopify_definitions_version = 0;
alter table loyalty_programs add column if not exists shopify_program_hash text;
alter table loyalty_programs add column if not exists shopify_program_synced_at timestamptz;

-- -----------------------------------------------------------------------------
-- Groups
-- -----------------------------------------------------------------------------

-- loyalty_member_group — 'holdout' | 'treatment' (0211's bucket), null = no member.
create or replace function loyalty_member_group(p_member uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case when loyalty_member_treated(p_member) then 'treatment' else 'holdout' end
   where exists (select 1 from loyalty_members where id = p_member);
$$;

-- loyalty_nudges_for — the purchase-moment nudges are on for this member.
create or replace function loyalty_nudges_for(p_member uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(p.treatment_since is not null and p.treatment_since <= now() and loyalty_member_treated(m.id), false)
    from loyalty_members m join loyalty_programs p on p.id = m.program_id
   where m.id = p_member;
$$;

-- -----------------------------------------------------------------------------
-- Shop metafield ll_loyalty.program
-- -----------------------------------------------------------------------------

-- loyalty_shop_program_json — what the theme reads. Public rules only.
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
    'tiers', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'min_spend_cents', t.min_spend_cents,
                                                           'multiplier', t.earn_multiplier) order by t.rank), '[]'::jsonb)
                from loyalty_tiers t where t.program_id = p.id),
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object('key', r.key, 'name', r.name, 'points_cost', r.points_cost,
                                                             'value_cents', r.value_cents, 'min_order_cents', r.min_order_cents)
                                          order by r.points_cost, r.key), '[]'::jsonb)
                  from loyalty_rewards r where r.program_id = p.id and r.is_active and r.points_cost is not null))
    from loyalty_programs p where p.id = p_program;
$$;

create or replace function loyalty_program_metafield_synced(p_program uuid, p_hash text)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_programs set shopify_program_hash = p_hash, shopify_program_synced_at = now() where id = p_program;
$$;

-- -----------------------------------------------------------------------------
-- Work for loyalty-shopify: 0203's, plus the program metafield and the
-- versioned definitions.
-- -----------------------------------------------------------------------------
create or replace function loyalty_shopify_work(p_program uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_tiers jsonb;
  v_perks jsonb;
  v_min   int;
  v_json  jsonb;
  v_prog  loyalty_programs%rowtype;
begin
  select * into v_prog from loyalty_programs where id = p_program;

  -- Segments are needed for every tier at or above the lowest tier any active perk targets.
  select min(t.rank) into v_min
    from loyalty_perks k join loyalty_tiers t on t.program_id = k.program_id and t.key = k.tier_key
   where k.program_id = p_program and k.is_active;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'key', t.key, 'name', t.name, 'rank', t.rank,
                   'segment_id', t.shopify_segment_id) order by t.rank), '[]'::jsonb)
    into v_tiers
    from loyalty_tiers t where t.program_id = p_program;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_perks from (
    select jsonb_build_object('id', k.id, 'is_active', k.is_active, 'discount_id', k.shopify_discount_id,
                              'hash', md5(loyalty_perk_config(k.id)::text), 'config', loyalty_perk_config(k.id)) as x
      from loyalty_perks k
     where k.program_id = p_program
       and ((k.is_active and (k.shopify_discount_id is null or k.synced_hash is distinct from md5(loyalty_perk_config(k.id)::text)))
            or (not k.is_active and k.shopify_discount_id is not null))
  ) s;

  v_json := loyalty_shop_program_json(p_program);

  return jsonb_build_object(
    'tiers', v_tiers,
    'segment_min_rank', v_min,
    'perks', v_perks,
    'definitions_needed', coalesce(v_prog.shopify_definitions_version, 0) < 2,
    -- null = the shop metafield is current
    'program_metafield', case when v_prog.shopify_program_hash is distinct from md5(v_json::text)
                              then jsonb_build_object('hash', md5(v_json::text), 'value', v_json) end);
end;
$$;

create or replace function loyalty_definitions_done(p_program uuid)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_programs set shopify_definitions_at = now(), shopify_definitions_version = 2 where id = p_program;
$$;

-- -----------------------------------------------------------------------------
-- Member sync: 0203's, plus tier spend and group.
-- -----------------------------------------------------------------------------
create or replace function loyalty_members_to_sync(p_program uuid, p_limit int default 120)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tier_names', (select jsonb_agg(name order by rank) from loyalty_tiers where program_id = p_program),
    'members', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('member_id', m.id, 'customer_id', m.shopify_customer_id,
                                'tier_key', m.tier_key, 'tier_name', t.name, 'points', m.points_balance,
                                'tier_spend_cents', m.tier_spend_cents, 'group', g.grp,
                                'tier_changed', m.tier_key is distinct from m.shopify_synced_tier) as x
        from loyalty_members m
        join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
        cross join lateral (select loyalty_member_group(m.id) as grp) g
       where m.program_id = p_program
         and (m.tier_key is distinct from m.shopify_synced_tier
              or m.points_balance is distinct from m.shopify_synced_points
              or m.tier_spend_cents is distinct from m.shopify_synced_spend_cents
              or g.grp is distinct from m.shopify_synced_group)
       order by m.shopify_synced_at nulls first
       limit p_limit) s), '[]'::jsonb));
$$;

-- p_items: [{member_id, tier_key, points, tier_spend_cents, group, error}] — what was pushed (error = not pushed).
create or replace function loyalty_mark_members_synced(p_items jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update loyalty_members m
     set shopify_synced_tier        = case when i.error is null then i.tier_key else m.shopify_synced_tier end,
         shopify_synced_points      = case when i.error is null then i.points else m.shopify_synced_points end,
         shopify_synced_spend_cents = case when i.error is null then coalesce(i.tier_spend_cents, m.shopify_synced_spend_cents)
                                           else m.shopify_synced_spend_cents end,
         shopify_synced_group       = case when i.error is null then coalesce(i."group", m.shopify_synced_group)
                                           else m.shopify_synced_group end,
         shopify_synced_at          = now(),
         shopify_sync_error         = left(i.error, 500)
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb))
         as i(member_id uuid, tier_key text, points int, tier_spend_cents bigint, "group" text, error text)
   where m.id = i.member_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- loyalty_shopify_has_work — 0204's, with the new member fields, the program
-- metafield and the definitions version.
create or replace function loyalty_shopify_has_work(p_program uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from loyalty_discount_codes where program_id = p_program and status = 'pending')
      or exists (select 1 from loyalty_order_tags where program_id = p_program and status = 'pending')
      or exists (select 1 from loyalty_members m where m.program_id = p_program
                  and (m.tier_key is distinct from m.shopify_synced_tier
                       or m.points_balance is distinct from m.shopify_synced_points
                       or m.tier_spend_cents is distinct from m.shopify_synced_spend_cents
                       or loyalty_member_group(m.id) is distinct from m.shopify_synced_group)
                  and (m.shopify_synced_at is null or m.shopify_sync_error is null or m.shopify_synced_at < now() - interval '15 minutes'))
      or jsonb_array_length(loyalty_shopify_work(p_program)->'perks') > 0
      or (loyalty_shopify_work(p_program)->'program_metafield') <> 'null'::jsonb
      or (select shopify_definitions_version < 2 from loyalty_programs where id = p_program);
$$;

-- -----------------------------------------------------------------------------
-- Extensions (loyalty-ext): thank-you, order status, account profile block.
-- -----------------------------------------------------------------------------

-- loyalty_extension_state — p_customer_id null = a guest checkout (no token
-- subject): program rules only. p_order_id: the order on the page; its points
-- are returned only when it belongs to this customer.
--   rate              points per dollar at the member's tier (entry tier for guests)
--   order             {recorded, points_earned} | null
--   next_tier, next_reward   progress (always; the caller decides where to show it)
--   nudges            the purchase-moment nudges are on for this member (0212 header)
create or replace function loyalty_extension_state(p_program uuid, p_customer_id bigint default null, p_order_id bigint default null)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_p     loyalty_programs%rowtype;
  v_m     loyalty_members%rowtype;
  v_tier  loyalty_tiers%rowtype;
  v_next  loyalty_tiers%rowtype;
  v_rew   loyalty_rewards%rowtype;
  v_order jsonb;
begin
  select * into v_p from loyalty_programs where id = p_program and is_active;
  if not found then
    return null;
  end if;

  if p_customer_id is not null then
    select * into v_m from loyalty_members
     where program_id = p_program and shopify_customer_id = p_customer_id and status = 'active';
  end if;

  if v_m.id is null then
    select * into v_tier from loyalty_tiers where program_id = p_program order by rank limit 1;
    return jsonb_build_object(
      'program', jsonb_build_object('name', v_p.name),
      'member', null,
      'rate', round(v_p.points_per_dollar * v_tier.earn_multiplier, 2));
  end if;

  select * into v_tier from loyalty_tiers where program_id = p_program and key = v_m.tier_key;
  select * into v_next from loyalty_tiers where program_id = p_program and rank > v_tier.rank order by rank limit 1;
  -- The cheapest points reward the member can't afford yet, else the cheapest one.
  select * into v_rew from loyalty_rewards
   where program_id = p_program and is_active and points_cost is not null
   order by (points_cost <= v_m.points_balance), points_cost limit 1;

  if p_order_id is not null then
    select jsonb_build_object('recorded', true, 'points_earned', o.points_earned - o.points_clawed)
      into v_order
      from loyalty_orders o where o.program_id = p_program and o.shopify_order_id = p_order_id and o.member_id = v_m.id;
    v_order := coalesce(v_order, jsonb_build_object('recorded', false, 'points_earned', null));
  end if;

  return jsonb_build_object(
    'program', jsonb_build_object('name', v_p.name),
    'member', jsonb_build_object(
      'first_name', v_m.first_name,
      'points', v_m.points_balance,
      'tier', v_tier.name,
      'tier_spend_cents', v_m.tier_spend_cents),
    'rate', round(v_p.points_per_dollar * v_tier.earn_multiplier, 2),
    'order', v_order,
    'next_tier', case when v_next.id is null then null else jsonb_build_object(
                   'name', v_next.name, 'min_spend_cents', v_next.min_spend_cents,
                   'remaining_cents', greatest(v_next.min_spend_cents - v_m.tier_spend_cents, 0)) end,
    'next_reward', case when v_rew.id is null then null else jsonb_build_object(
                     'name', v_rew.name, 'points_cost', v_rew.points_cost, 'value_cents', v_rew.value_cents,
                     'remaining_points', greatest(v_rew.points_cost - v_m.points_balance, 0)) end,
    'codes', (select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'value_cents', c.value_cents) order by c.created_at desc), '[]'::jsonb)
                from (select * from loyalty_discount_codes where member_id = v_m.id and status = 'issued'
                      order by created_at desc limit 5) c),
    'nudges', loyalty_nudges_for(v_m.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants: service role only (edge functions).
-- -----------------------------------------------------------------------------
revoke execute on function loyalty_member_group(uuid) from public, anon, authenticated;
revoke execute on function loyalty_nudges_for(uuid) from public, anon, authenticated;
revoke execute on function loyalty_shop_program_json(uuid) from public, anon, authenticated;
revoke execute on function loyalty_program_metafield_synced(uuid, text) from public, anon, authenticated;
revoke execute on function loyalty_shopify_work(uuid) from public, anon, authenticated;
revoke execute on function loyalty_definitions_done(uuid) from public, anon, authenticated;
revoke execute on function loyalty_members_to_sync(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_mark_members_synced(jsonb) from public, anon, authenticated;
revoke execute on function loyalty_shopify_has_work(uuid) from public, anon, authenticated;
revoke execute on function loyalty_extension_state(uuid, bigint, bigint) from public, anon, authenticated;

grant execute on function loyalty_member_group(uuid) to service_role;
grant execute on function loyalty_nudges_for(uuid) to service_role;
grant execute on function loyalty_shop_program_json(uuid) to service_role;
grant execute on function loyalty_program_metafield_synced(uuid, text) to service_role;
grant execute on function loyalty_shopify_work(uuid) to service_role;
grant execute on function loyalty_definitions_done(uuid) to service_role;
grant execute on function loyalty_members_to_sync(uuid, int) to service_role;
grant execute on function loyalty_mark_members_synced(jsonb) to service_role;
grant execute on function loyalty_shopify_has_work(uuid) to service_role;
grant execute on function loyalty_extension_state(uuid, bigint, bigint) to service_role;
