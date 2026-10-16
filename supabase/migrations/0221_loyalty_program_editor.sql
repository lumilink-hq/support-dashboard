-- =============================================================================
-- 0221 - LL Loyalty: program editor for staff (/loyalty/program)
--
-- What used to need SQL (setup-loyalty-program.sql), editable by LumiLink
-- staff in the app. Every function: SECURITY DEFINER, loyalty_require_staff()
-- (staff + MFA), validates, writes one program_save access-log row with the
-- before and after values. Nothing here touches member point balances.
--
--   loyalty_staff_program_config(program)        everything the page shows
--   loyalty_staff_program_save(program, settings) earn rate, expiry, demotion,
--                                                reminder, near-tier %, gross margin
--   loyalty_staff_tiers_save(program, tiers)     thresholds, multipliers, perks text,
--                                                all tiers in one call so the order
--                                                can be checked. Members who now
--                                                qualify for a higher tier are moved
--                                                up quietly (no tier_up emails for a
--                                                config change). Raising a threshold
--                                                never demotes anyone.
--   loyalty_staff_reward_save(program, reward)   create or edit a $-off reward
--                                                (points cost, value, minimum order,
--                                                max units, on/off)
--   loyalty_staff_earn_rule_save(program, key, points, active)
--                                                points and on/off of an existing rule
--
-- Tier names and keys stay as they are, as they are the customer tags and the
-- Klaviyo tier values. Changes reach the storefront through the shop metafield
-- (its hash changes, loyalty_shopify_has_work picks it up).
-- =============================================================================

alter table loyalty_access_log drop constraint if exists loyalty_access_log_action_check;
alter table loyalty_access_log add constraint loyalty_access_log_action_check
  check (action in ('search', 'view', 'adjust', 'set_tier', 'set_birthday', 'data_requests', 'campaign_save', 'campaign_active',
                    'challenge_save', 'challenge_active', 'list', 'program_save'));

-- Whole months in an interval (1 year -> 12), null stays null.
create or replace function loyalty_interval_months(p interval)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p is null then null else (extract(year from p) * 12 + extract(month from p))::int end;
$$;

create or replace function loyalty_staff_program_config(p_program uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_p loyalty_programs%rowtype;
begin
  perform loyalty_require_staff();
  select * into v_p from loyalty_programs where id = p_program;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'program', jsonb_build_object(
      'id', v_p.id, 'name', v_p.name, 'shop_domain', v_p.shop_domain,
      'points_per_dollar', v_p.points_per_dollar,
      'expire_months', loyalty_interval_months(v_p.points_expire_after),
      'demote_months', loyalty_interval_months(v_p.demote_after_inactive),
      'demotion_warning_days', v_p.demotion_warning_days,
      'balance_reminder_days', v_p.balance_reminder_days,
      'near_tier_percent', v_p.near_tier_percent,
      'gross_margin_pct', v_p.gross_margin_pct,
      'code_prefix', v_p.discount_code_prefix),
    'tiers', (select coalesce(jsonb_agg(jsonb_build_object(
                'key', t.key, 'name', t.name, 'rank', t.rank, 'min_spend_cents', t.min_spend_cents,
                'earn_multiplier', t.earn_multiplier, 'perks', t.perks,
                'members', (select count(*) from loyalty_members m where m.program_id = p_program and m.tier_key = t.key and m.status = 'active'))
                order by t.rank), '[]'::jsonb)
                from loyalty_tiers t where t.program_id = p_program),
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object(
                  'key', r.key, 'name', r.name, 'kind', r.kind, 'points_cost', r.points_cost, 'value_cents', r.value_cents,
                  'min_order_cents', r.min_order_cents, 'max_units', r.max_units, 'is_active', r.is_active,
                  'codes_issued', (select count(*) from loyalty_discount_codes c where c.program_id = p_program and c.reward_key = r.key))
                  order by r.points_cost nulls last, r.key), '[]'::jsonb)
                  from loyalty_rewards r where r.program_id = p_program and r.kind = 'amount_off_order'),
    'earn_rules', (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', e.key, 'kind', e.kind, 'points', e.points, 'order_count', e.order_count,
                     'is_active', e.is_active, 'title', e.title)
                     order by e.kind, e.order_count nulls first, e.key), '[]'::jsonb)
                     from loyalty_earn_rules e where e.program_id = p_program));
end;
$$;

create or replace function loyalty_staff_program_save(p_program uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  text;
  v_before jsonb;
  v_ppd    numeric := (p_settings->>'points_per_dollar')::numeric;
  v_exp    int := nullif(p_settings->>'expire_months', '')::int;
  v_dem    int := (p_settings->>'demote_months')::int;
  v_warn   int := (p_settings->>'demotion_warning_days')::int;
  v_rem    int := (p_settings->>'balance_reminder_days')::int;
  v_near   int := (p_settings->>'near_tier_percent')::int;
  v_margin numeric := nullif(p_settings->>'gross_margin_pct', '')::numeric;
begin
  v_actor := loyalty_require_staff();
  v_before := loyalty_staff_program_config(p_program)->'program';
  if v_before is null then
    raise exception 'program not found';
  end if;
  if v_ppd is null or v_ppd < 0.1 or v_ppd > 100 then raise exception 'Points per $1 must be between 0.1 and 100.'; end if;
  if v_exp is not null and (v_exp < 1 or v_exp > 60) then raise exception 'Expiry must be 1 to 60 months, or never.'; end if;
  if v_dem is null or v_dem < 1 or v_dem > 36 then raise exception 'Demotion must be after 1 to 36 months.'; end if;
  if v_warn is null or v_warn < 0 or v_warn > 60 then raise exception 'The demotion warning must be 0 to 60 days before.'; end if;
  if v_rem is null or v_rem < 7 or v_rem > 365 then raise exception 'The balance reminder must be every 7 to 365 days.'; end if;
  if v_near is null or v_near < 1 or v_near > 50 then raise exception 'Near tier must be 1 to 50 percent.'; end if;
  if v_margin is not null and (v_margin <= 0 or v_margin > 100) then raise exception 'Gross margin must be above 0 and at most 100 percent.'; end if;

  update loyalty_programs set
    points_per_dollar = round(v_ppd, 2),
    points_expire_after = case when v_exp is null then null else make_interval(months => v_exp) end,
    demote_after_inactive = make_interval(months => v_dem),
    demotion_warning_days = v_warn,
    balance_reminder_days = v_rem,
    near_tier_percent = v_near,
    gross_margin_pct = v_margin
  where id = p_program;

  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'settings', 'before', v_before, 'after', loyalty_staff_program_config(p_program)->'program'));
  return loyalty_staff_program_config(p_program)->'program';
end;
$$;

create or replace function loyalty_staff_tiers_save(p_program uuid, p_tiers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    text;
  v_before   jsonb;
  v_t        record;
  v_in       jsonb;
  v_prev     bigint := -1;
  v_first    boolean := true;
  v_quiet    text;
  v_m        record;
  v_promoted int := 0;
  v_perk     jsonb;
begin
  v_actor := loyalty_require_staff();
  v_before := loyalty_staff_program_config(p_program)->'tiers';
  if v_before is null or jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'program not found or no tiers given';
  end if;
  if jsonb_array_length(p_tiers) <> (select count(*) from loyalty_tiers where program_id = p_program) then
    raise exception 'Send every tier.';
  end if;

  -- Validate in rank order before writing anything.
  for v_t in select * from loyalty_tiers where program_id = p_program order by rank loop
    select x into v_in from jsonb_array_elements(p_tiers) x where x->>'key' = v_t.key;
    if v_in is null then raise exception 'Missing tier %.', v_t.name; end if;
    if (v_in->>'min_spend_cents') is null or (v_in->>'min_spend_cents')::bigint < 0 then
      raise exception '% needs a spend threshold.', v_t.name;
    end if;
    if v_first and (v_in->>'min_spend_cents')::bigint <> 0 then
      raise exception 'The first tier (%) starts at $0.', v_t.name;
    end if;
    if not v_first and (v_in->>'min_spend_cents')::bigint <= v_prev then
      raise exception '% must need more spend than the tier below it.', v_t.name;
    end if;
    if (v_in->>'earn_multiplier') is null or (v_in->>'earn_multiplier')::numeric < 1 or (v_in->>'earn_multiplier')::numeric > 5 then
      raise exception '% needs a multiplier between 1 and 5.', v_t.name;
    end if;
    if jsonb_typeof(coalesce(v_in->'perks', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(v_in->'perks', '[]'::jsonb)) > 8 then
      raise exception '% can list up to 8 perks.', v_t.name;
    end if;
    for v_perk in select * from jsonb_array_elements(coalesce(v_in->'perks', '[]'::jsonb)) loop
      if jsonb_typeof(v_perk) <> 'string' or length(v_perk #>> '{}') not between 1 and 120 then
        raise exception 'Each perk on % is 1 to 120 characters.', v_t.name;
      end if;
    end loop;
    v_prev := (v_in->>'min_spend_cents')::bigint;
    v_first := false;
  end loop;

  update loyalty_tiers t set
    min_spend_cents = (x->>'min_spend_cents')::bigint,
    earn_multiplier = round((x->>'earn_multiplier')::numeric, 2),
    perks = coalesce(x->'perks', '[]'::jsonb)
    from jsonb_array_elements(p_tiers) x
   where t.program_id = p_program and t.key = x->>'key';

  -- Members whose spend now reaches a higher tier move up, without tier_up events.
  v_quiet := coalesce(current_setting('loyalty.quiet', true), '');
  perform set_config('loyalty.quiet', 'on', true);
  for v_m in
    select m.id, loyalty_tier_for_spend(p_program, m.tier_spend_cents) as spend_tier, t.rank as cur_rank
      from loyalty_members m join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
     where m.program_id = p_program and m.status = 'active'
  loop
    if (select rank from loyalty_tiers where program_id = p_program and key = v_m.spend_tier) > v_m.cur_rank then
      perform loyalty_set_tier(v_m.id, v_m.spend_tier, 'staff', v_actor);
      v_promoted := v_promoted + 1;
    end if;
  end loop;
  perform set_config('loyalty.quiet', v_quiet, true);

  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'tiers', 'before', v_before, 'after', loyalty_staff_program_config(p_program)->'tiers', 'promoted', v_promoted));
  return jsonb_build_object('promoted', v_promoted, 'tiers', loyalty_staff_program_config(p_program)->'tiers');
end;
$$;

create or replace function loyalty_staff_reward_save(p_program uuid, p_reward jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  text;
  v_key    text := nullif(p_reward->>'key', '');
  v_old    loyalty_rewards%rowtype;
  v_name   text := trim(coalesce(p_reward->>'name', ''));
  v_cost   int := nullif(p_reward->>'points_cost', '')::int;
  v_value  bigint := (p_reward->>'value_cents')::bigint;
  v_min    bigint := coalesce(nullif(p_reward->>'min_order_cents', '')::bigint, 0);
  v_units  int := nullif(p_reward->>'max_units', '')::int;   -- null = no cap
  v_active boolean := coalesce((p_reward->>'is_active')::boolean, true);
  v_base   text;
  v_n      int := 1;
  v_before jsonb;
begin
  v_actor := loyalty_require_staff();
  if not exists (select 1 from loyalty_programs where id = p_program) then
    raise exception 'program not found';
  end if;
  if v_key is not null then
    select * into v_old from loyalty_rewards where program_id = p_program and key = v_key and kind = 'amount_off_order';
    if not found then raise exception 'Unknown reward.'; end if;
    v_before := to_jsonb(v_old);
  end if;

  if length(v_name) not between 1 and 60 then raise exception 'Give the reward a name (up to 60 characters).'; end if;
  if v_value is null or v_value < 100 or v_value > 100000 then raise exception 'The value must be $1 to $1,000.'; end if;
  if v_min < 0 or v_min > 1000000 then raise exception 'The minimum order must be $0 to $10,000.'; end if;
  if v_units is not null and (v_units < 1 or v_units > 1000) then raise exception 'Max per code must be 1 to 1,000, or no limit.'; end if;
  -- The referral friend's coupon has no points cost; every other reward needs one.
  if v_old.points_cost is null and v_key is not null then
    v_cost := null;
    v_units := 1;
  elsif v_cost is null or v_cost < 1 or v_cost > 1000000 then
    raise exception 'The points cost must be 1 to 1,000,000.';
  end if;

  if v_key is null then
    v_base := trim(both '_' from regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'));
    if v_base = '' or v_base ~ '^[0-9]' then v_base := 'reward_' || v_base; end if;
    v_base := left(trim(both '_' from v_base), 40);
    v_key := v_base;
    while exists (select 1 from loyalty_rewards where program_id = p_program and key = v_key) loop
      v_n := v_n + 1;
      v_key := v_base || '_' || v_n;
    end loop;
    insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents, min_order_cents, max_units, is_active)
    values (p_program, v_key, v_name, 'amount_off_order', v_cost, v_value, v_min, v_units, v_active);
  else
    update loyalty_rewards set name = v_name, points_cost = v_cost, value_cents = v_value, min_order_cents = v_min,
                               max_units = v_units, is_active = v_active
     where program_id = p_program and key = v_key;
  end if;

  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'reward', 'key', v_key, 'before', v_before,
    'after', (select to_jsonb(r) from loyalty_rewards r where program_id = p_program and key = v_key)));
  return jsonb_build_object('key', v_key);
end;
$$;

create or replace function loyalty_staff_earn_rule_save(p_program uuid, p_key text, p_points int, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text;
  v_old   loyalty_earn_rules%rowtype;
begin
  v_actor := loyalty_require_staff();
  select * into v_old from loyalty_earn_rules where program_id = p_program and key = p_key;
  if not found then raise exception 'Unknown earning rule.'; end if;
  if p_points is null or p_points < 0 or p_points > 100000 then raise exception 'Points must be 0 to 100,000.'; end if;
  update loyalty_earn_rules set points = p_points, is_active = coalesce(p_active, is_active)
   where program_id = p_program and key = p_key;
  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'earn_rule', 'key', p_key,
    'before', jsonb_build_object('points', v_old.points, 'is_active', v_old.is_active),
    'after', jsonb_build_object('points', p_points, 'is_active', coalesce(p_active, v_old.is_active))));
  return jsonb_build_object('key', p_key, 'points', p_points, 'is_active', coalesce(p_active, v_old.is_active));
end;
$$;

revoke execute on function loyalty_interval_months(interval) from public, anon;
revoke execute on function loyalty_staff_program_config(uuid) from public, anon;
revoke execute on function loyalty_staff_program_save(uuid, jsonb) from public, anon;
revoke execute on function loyalty_staff_tiers_save(uuid, jsonb) from public, anon;
revoke execute on function loyalty_staff_reward_save(uuid, jsonb) from public, anon;
revoke execute on function loyalty_staff_earn_rule_save(uuid, text, int, boolean) from public, anon;
grant execute on function loyalty_interval_months(interval) to authenticated, service_role;
grant execute on function loyalty_staff_program_config(uuid) to authenticated;
grant execute on function loyalty_staff_program_save(uuid, jsonb) to authenticated;
grant execute on function loyalty_staff_tiers_save(uuid, jsonb) to authenticated;
grant execute on function loyalty_staff_reward_save(uuid, jsonb) to authenticated;
grant execute on function loyalty_staff_earn_rule_save(uuid, text, int, boolean) to authenticated;
