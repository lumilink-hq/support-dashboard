-- =============================================================================
-- 0204_loyalty_storefront.sql — LL Loyalty module 5: what the Wave Rewards
-- theme block reads and does (through the app proxy, loyalty-proxy), plus
-- order tags on loyalty orders. Plan: docs/loyalty/PLAN.md. Builds on 0200-0203.
--
-- STOREFRONT. loyalty_storefront_state is the one read: program rules for
-- everyone, the member's own state when a customer is logged in. The writes a
-- shopper can make are narrow and each is once-only or limited:
--   * loyalty_set_birthday       — once; staff change it after (module 7)
--   * loyalty_claim_action       — honor-system actions marked claimable
--                                   (Instagram follow), once per member
--   * loyalty_referral_by_code   — the friend's landing form: referrer by
--                                   their code, capped per referrer per day
--   * loyalty_redeem (0203)      — points spend, idempotent per request
--
-- ORDER TAGS. A paid order that used one of our codes is tagged in Shopify:
-- a points reward -> loyalty_programs.assisted_order_tag, a referral coupon ->
-- referral_order_tag (Joy used 'Joy assisted' / 'Joy Referral'). Queued in
-- loyalty_order_tags; loyalty-shopify applies them (needs write_orders).
--
-- Test: scripts/test_loyalty_storefront.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_programs   add column if not exists assisted_order_tag text not null default 'Loyalty assisted';
alter table loyalty_programs   add column if not exists referral_order_tag text not null default 'Loyalty referral';
alter table loyalty_programs   add column if not exists referrals_per_day int not null default 10 check (referrals_per_day >= 0);
alter table loyalty_earn_rules add column if not exists claimable boolean not null default false;  -- shopper can claim it (honor system)
alter table loyalty_earn_rules add column if not exists title text;         -- storefront copy; null = the block's default
alter table loyalty_earn_rules add column if not exists description text;
alter table loyalty_members    add column if not exists birthday_set_at timestamptz;

-- -----------------------------------------------------------------------------
-- Order tags
-- -----------------------------------------------------------------------------
create table if not exists loyalty_order_tags (
  program_id        uuid        not null references loyalty_programs(id) on delete cascade,
  shopify_order_id  bigint      not null,
  tags              text[]      not null,
  status            text        not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts          int         not null default 0,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (program_id, shopify_order_id)
);

create index if not exists idx_loyalty_order_tags_pending on loyalty_order_tags(program_id) where status = 'pending';

drop trigger if exists trg_loyalty_order_tags_updated_at on loyalty_order_tags;
create trigger trg_loyalty_order_tags_updated_at
  before update on loyalty_order_tags
  for each row execute function set_updated_at();

-- loyalty_mark_codes_used — 0203's, plus queueing the order's tags.
create or replace function loyalty_mark_codes_used(p_program uuid, p_order jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n     int;
  v_tags  text[];
  v_order bigint := (p_order->>'id')::bigint;
begin
  with used as (
    update loyalty_discount_codes
       set status = 'used', used_order_id = v_order,
           used_at = coalesce(nullif(p_order->>'processed_at', '')::timestamptz, now())
     where program_id = p_program and status in ('issued', 'pending')
       and upper(code) in (select upper(c) from jsonb_array_elements_text(coalesce(p_order->'discount_codes', '[]'::jsonb)) c)
    returning referral_id
  )
  select count(*), array_agg(distinct case when u.referral_id is null then p.assisted_order_tag else p.referral_order_tag end)
    into v_n, v_tags
    from used u cross join loyalty_programs p
   where p.id = p_program;

  if v_n > 0 then
    insert into loyalty_order_tags (program_id, shopify_order_id, tags)
    values (p_program, v_order, v_tags)
    on conflict (program_id, shopify_order_id) do update
       set tags = (select array_agg(distinct t) from unnest(loyalty_order_tags.tags || excluded.tags) t),
           status = 'pending', attempts = 0, last_error = null;
  end if;
  return v_n;
end;
$$;

create or replace function loyalty_order_tags_to_apply(p_program uuid, p_limit int default 50)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('order_id', shopify_order_id, 'tags', to_jsonb(tags))), '[]'::jsonb)
    from (select shopify_order_id, tags from loyalty_order_tags
           where program_id = p_program and status = 'pending'
           order by created_at limit p_limit) x;
$$;

-- p_error null = applied. 5 failures = 'failed' (left for staff to look at).
create or replace function loyalty_order_tags_result(p_program uuid, p_order_id bigint, p_error text default null)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_order_tags
     set status = case when p_error is null then 'done' when attempts + 1 >= 5 then 'failed' else 'pending' end,
         attempts = attempts + case when p_error is null then 0 else 1 end,
         last_error = left(p_error, 500)
   where program_id = p_program and shopify_order_id = p_order_id;
$$;

-- loyalty_shopify_has_work — 0203's, plus pending order tags.
create or replace function loyalty_shopify_has_work(p_program uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from loyalty_discount_codes where program_id = p_program and status = 'pending')
      or exists (select 1 from loyalty_order_tags where program_id = p_program and status = 'pending')
      or exists (select 1 from loyalty_members where program_id = p_program
                  and (tier_key is distinct from shopify_synced_tier or points_balance is distinct from shopify_synced_points)
                  and (shopify_synced_at is null or shopify_sync_error is null or shopify_synced_at < now() - interval '15 minutes'))
      or jsonb_array_length(loyalty_shopify_work(p_program)->'perks') > 0
      or (select shopify_definitions_at is null from loyalty_programs where id = p_program);
$$;

-- -----------------------------------------------------------------------------
-- Storefront reads
-- -----------------------------------------------------------------------------

-- loyalty_program_for_shop — the active program behind a shop's storefront.
create or replace function loyalty_program_for_shop(p_shop text)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select id from loyalty_programs where shop_domain = lower(p_shop) and is_active;
$$;

-- loyalty_storefront_state — p_customer_id null = logged out. Never returns
-- another member's data: the member is looked up by the logged-in customer.
create or replace function loyalty_storefront_state(p_program uuid, p_customer_id bigint default null)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_p      loyalty_programs%rowtype;
  v_m      loyalty_members%rowtype;
  v_tier   loyalty_tiers%rowtype;
  v_next   loyalty_tiers%rowtype;
  v_member jsonb;
begin
  select * into v_p from loyalty_programs where id = p_program and is_active;
  if not found then
    return null;
  end if;

  if p_customer_id is not null then
    select * into v_m from loyalty_members where program_id = p_program and shopify_customer_id = p_customer_id;
    if found then
      select * into v_tier from loyalty_tiers where program_id = p_program and key = v_m.tier_key;
      select * into v_next from loyalty_tiers where program_id = p_program and rank > v_tier.rank order by rank limit 1;
      v_member := jsonb_build_object(
        'first_name', v_m.first_name,
        'status', v_m.status,
        'points', v_m.points_balance,
        'tier', jsonb_build_object('key', v_tier.key, 'name', v_tier.name, 'multiplier', v_tier.earn_multiplier),
        'tier_spend_cents', v_m.tier_spend_cents,
        'next_tier', case when v_next.id is null then null else jsonb_build_object(
                       'key', v_next.key, 'name', v_next.name, 'min_spend_cents', v_next.min_spend_cents,
                       'remaining_cents', greatest(v_next.min_spend_cents - v_m.tier_spend_cents, 0)) end,
        'paid_order_count', v_m.paid_order_count,
        'referral_code', v_m.referral_code,
        'birthday', to_char(v_m.birthday, 'YYYY-MM-DD'),
        'claimed', (select coalesce(jsonb_agg(distinct l.rule_key), '[]'::jsonb) from loyalty_ledger l
                     where l.member_id = v_m.id and l.reason in ('action', 'milestone') and l.rule_key is not null),
        'codes', (select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'title', c.title, 'value_cents', c.value_cents,
                                                               'status', c.status, 'created_at', c.created_at) order by c.created_at desc), '[]'::jsonb)
                    from (select * from loyalty_discount_codes where member_id = v_m.id and status in ('pending', 'issued')
                          order by created_at desc limit 10) c),
        'history', (select coalesce(jsonb_agg(jsonb_build_object('points', h.points, 'reason', h.reason, 'rule_key', h.rule_key,
                                                                 'at', h.occurred_at) order by h.id desc), '[]'::jsonb)
                      from (select * from loyalty_ledger where member_id = v_m.id and points <> 0
                            order by id desc limit 15) h));
    end if;
  end if;

  return jsonb_build_object(
    'program', jsonb_build_object('name', v_p.name, 'points_per_dollar', v_p.points_per_dollar),
    'tiers', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'name', name, 'min_spend_cents', min_spend_cents,
                                                           'multiplier', earn_multiplier, 'perks', perks) order by rank), '[]'::jsonb)
                from loyalty_tiers where program_id = p_program),
    'earn_rules', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'kind', kind, 'points', points, 'order_count', order_count,
                                                                'claimable', claimable, 'title', title, 'description', description)
                                             order by kind, order_count nulls first, key), '[]'::jsonb)
                     from loyalty_earn_rules where program_id = p_program and is_active),
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'name', name, 'points_cost', points_cost,
                                                             'value_cents', value_cents, 'min_order_cents', min_order_cents)
                                          order by points_cost nulls last, key), '[]'::jsonb)
                  from loyalty_rewards where program_id = p_program and is_active),
    'logged_in', p_customer_id is not null,
    'member', v_member);
end;
$$;

-- -----------------------------------------------------------------------------
-- Storefront writes
-- -----------------------------------------------------------------------------

-- loyalty_member_for_customer — the logged-in shopper's member id (or null).
create or replace function loyalty_member_for_customer(p_program uuid, p_customer_id bigint)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select id from loyalty_members
   where program_id = p_program and shopify_customer_id = p_customer_id and status = 'active';
$$;

-- loyalty_set_birthday — once. Returns 'set' | 'already_set' | 'invalid'.
create or replace function loyalty_set_birthday(p_member uuid, p_birthday date)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_birthday is null or p_birthday > current_date or p_birthday < date '1900-01-01' then
    return 'invalid';
  end if;
  update loyalty_members set birthday = p_birthday, birthday_set_at = now()
   where id = p_member and birthday is null;
  if not found then
    return 'already_set';
  end if;
  return 'set';
end;
$$;

-- loyalty_claim_action — an honor-system action the shopper says they did.
-- Returns points awarded (0 = already claimed, or not claimable).
create or replace function loyalty_claim_action(p_member uuid, p_rule_key text)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from loyalty_earn_rules r join loyalty_members m on m.program_id = r.program_id
                  where m.id = p_member and r.key = p_rule_key and r.kind = 'action' and r.claimable and r.is_active) then
    return 0;
  end if;
  return loyalty_award_action(p_member, p_rule_key, null, null, 'member');
end;
$$;

-- loyalty_referral_by_code — the referred friend's form. Returns 0202's
-- statuses plus 'unknown_code' and 'limit_reached', and the friend's code.
create or replace function loyalty_referral_by_code(p_program uuid, p_referral_code text, p_friend_email text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_referrer uuid;
  v_limit    int;
  v_r        jsonb;
begin
  select m.id, p.referrals_per_day into v_referrer, v_limit
    from loyalty_members m join loyalty_programs p on p.id = m.program_id
   where m.program_id = p_program and m.referral_code = upper(trim(p_referral_code)) and m.status = 'active';
  if v_referrer is null then
    return jsonb_build_object('status', 'unknown_code');
  end if;
  if (select count(*) from loyalty_referrals
       where referrer_id = v_referrer and created_at > now() - interval '1 day') >= v_limit then
    return jsonb_build_object('status', 'limit_reached');
  end if;
  v_r := loyalty_create_referral(v_referrer, p_friend_email);
  if v_r->>'status' = 'created' then
    v_r := v_r || jsonb_build_object(
      'code', (select discount_code from loyalty_referrals where id = (v_r->>'referral_id')::uuid),
      'code_id', (select id from loyalty_discount_codes where referral_id = (v_r->>'referral_id')::uuid));
  end if;
  return v_r - 'referral_id';
end;
$$;

-- loyalty_code_for_issue — one pending code, shaped like loyalty_codes_to_issue
-- rows, so the proxy can create it in Shopify right away.
create or replace function loyalty_code_for_issue(p_code uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', c.id, 'code', c.code, 'title', c.title, 'value_cents', c.value_cents,
                            'min_order_cents', c.min_order_cents, 'combines', c.combines, 'ends_at', c.ends_at,
                            'customer_id', m.shopify_customer_id)
    from loyalty_discount_codes c left join loyalty_members m on m.id = c.member_id
   where c.id = p_code and c.status = 'pending';
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only (as 0200).
-- -----------------------------------------------------------------------------
alter table loyalty_order_tags enable row level security;
revoke all on loyalty_order_tags from anon, authenticated;
grant select, insert, update, delete on loyalty_order_tags to service_role;

revoke execute on function loyalty_mark_codes_used(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_order_tags_to_apply(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_order_tags_result(uuid, bigint, text) from public, anon, authenticated;
revoke execute on function loyalty_shopify_has_work(uuid) from public, anon, authenticated;
revoke execute on function loyalty_program_for_shop(text) from public, anon, authenticated;
revoke execute on function loyalty_storefront_state(uuid, bigint) from public, anon, authenticated;
revoke execute on function loyalty_member_for_customer(uuid, bigint) from public, anon, authenticated;
revoke execute on function loyalty_set_birthday(uuid, date) from public, anon, authenticated;
revoke execute on function loyalty_claim_action(uuid, text) from public, anon, authenticated;
revoke execute on function loyalty_referral_by_code(uuid, text, text) from public, anon, authenticated;
revoke execute on function loyalty_code_for_issue(uuid) from public, anon, authenticated;

grant execute on function loyalty_mark_codes_used(uuid, jsonb) to service_role;
grant execute on function loyalty_order_tags_to_apply(uuid, int) to service_role;
grant execute on function loyalty_order_tags_result(uuid, bigint, text) to service_role;
grant execute on function loyalty_shopify_has_work(uuid) to service_role;
grant execute on function loyalty_program_for_shop(text) to service_role;
grant execute on function loyalty_storefront_state(uuid, bigint) to service_role;
grant execute on function loyalty_member_for_customer(uuid, bigint) to service_role;
grant execute on function loyalty_set_birthday(uuid, date) to service_role;
grant execute on function loyalty_claim_action(uuid, text) to service_role;
grant execute on function loyalty_referral_by_code(uuid, text, text) to service_role;
grant execute on function loyalty_code_for_issue(uuid) to service_role;
