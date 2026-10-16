-- =============================================================================
-- 0218 — LL Loyalty: match Joy before cutover (docs/loyalty/JOY-MERCHANT-CONFIG.md §0)
--
--   1. Order points round to the NEAREST point (Joy: "Rounding to the nearest"),
--      not down. Refund claw-back stays floor(), so a partial refund never takes
--      back more than the order earned.
--   2. Dynamic amount rewards: loyalty_rewards.max_units. A reward with
--      max_units > 1 (or null = no cap, Joy's setting) can be bought N times in
--      one code: N x points_cost for N x value_cents. Default 1 keeps every
--      existing reward as it was. loyalty_redeem takes p_units (default 1).
--   3. Inactivity demotion also lowers tier spend to the new tier's threshold
--      (Joy: "Downgrade tier progress to the previous tier"), through a
--      zero-point 'adjust' ledger entry so loyalty_verify_balances stays clean.
--      Answers PLAN §9 ("goes straight back to their spend tier").
-- =============================================================================

-- 1. Rounding ------------------------------------------------------------------

-- loyalty_order_points — points for an order's eligible amount at the
-- member's current tier: round(dollars x points_per_dollar x multiplier), the
-- nearest point like Joy (0200 used floor).
create or replace function loyalty_order_points(p_member uuid, p_eligible_cents bigint)
returns int
language sql
stable
set search_path = public, pg_temp
as $$
  select round(greatest(p_eligible_cents, 0) * p.points_per_dollar * t.earn_multiplier / 100)::int
    from loyalty_members m
    join loyalty_programs p on p.id = m.program_id
    join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
   where m.id = p_member;
$$;

-- 2. Dynamic amount rewards ----------------------------------------------------

alter table loyalty_rewards add column if not exists max_units int default 1;
alter table loyalty_rewards drop constraint if exists loyalty_rewards_max_units_check;
alter table loyalty_rewards add constraint loyalty_rewards_max_units_check check (max_units is null or max_units >= 1);
comment on column loyalty_rewards.max_units is
  'How many of this reward one code may bundle (N x points_cost for N x value_cents). 1 = fixed reward; null = no cap (Joy''s dynamic discount).';

-- "$10 off" for a bundled code's title.
create or replace function loyalty_money_label(p_cents bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select '$' || regexp_replace(to_char(p_cents / 100.0, 'FM999999990.00'), '\.00$', '');
$$;

drop function if exists loyalty_redeem(uuid, text, text);

-- loyalty_redeem — spend points on a reward, p_units of it in one code (only
-- rewards whose max_units allows it). p_request_key makes a retried request
-- return the same code. Returns {status: 'pending' | 'duplicate' |
-- 'insufficient_points' | 'unknown_reward' | 'invalid_units', code_id, code}.
create or replace function loyalty_redeem(p_member uuid, p_reward_key text, p_request_key text, p_units int default 1)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_m      loyalty_members%rowtype;
  v_p      loyalty_programs%rowtype;
  v_rw     loyalty_rewards%rowtype;
  v_code   loyalty_discount_codes%rowtype;
  v_id     uuid := gen_random_uuid();
  v_text   text;
  v_units  int := coalesce(p_units, 1);
  v_cost   int;
  v_value  bigint;
begin
  if p_request_key is null or length(p_request_key) not between 8 and 100 then
    raise exception 'request_key (8-100 chars) is required';
  end if;
  select * into v_m from loyalty_members where id = p_member and status = 'active';
  if not found then
    raise exception 'loyalty member % not found or not active', p_member;
  end if;
  select * into v_code from loyalty_discount_codes where program_id = v_m.program_id and request_key = p_request_key;
  if found then
    return jsonb_build_object('status', 'duplicate', 'code_id', v_code.id, 'code', v_code.code, 'code_status', v_code.status);
  end if;
  select * into v_rw from loyalty_rewards
   where program_id = v_m.program_id and key = p_reward_key and is_active and points_cost is not null
     and kind = 'amount_off_order';
  if not found then
    return jsonb_build_object('status', 'unknown_reward');
  end if;
  -- null max_units = no cap; 1,000 only guards against absurd requests.
  if v_units < 1 or v_units > coalesce(v_rw.max_units, 1000) then
    return jsonb_build_object('status', 'invalid_units', 'max_units', v_rw.max_units);
  end if;
  v_cost  := v_rw.points_cost * v_units;
  v_value := v_rw.value_cents * v_units;
  select * into v_p from loyalty_programs where id = v_m.program_id;

  begin
    perform loyalty_post_entry(p_member, -v_cost, 'redeem', 'redeem:' || p_request_key, 0,
                               v_rw.key, 'reward', v_id::text,
                               case when v_units > 1 then v_units || ' x ' || v_rw.name end, 'member');
  exception when others then
    if sqlerrm like 'insufficient_points%' then
      return jsonb_build_object('status', 'insufficient_points', 'points_balance', v_m.points_balance, 'points_cost', v_cost);
    end if;
    raise;
  end;

  loop
    v_text := loyalty_new_code(v_p.discount_code_prefix);
    exit when not exists (select 1 from loyalty_discount_codes where program_id = v_m.program_id and upper(code) = v_text);
  end loop;
  insert into loyalty_discount_codes (id, program_id, member_id, reward_key, code, title, value_cents,
                                      min_order_cents, points_spent, combines, ends_at, request_key)
  values (v_id, v_m.program_id, p_member, v_rw.key, v_text,
          v_p.name || ': ' || case when v_units > 1 then loyalty_money_label(v_value) || ' off' else v_rw.name end,
          v_value, v_rw.min_order_cents, v_cost, v_rw.combines, now() + v_rw.expires_after, p_request_key);
  return jsonb_build_object('status', 'pending', 'code_id', v_id, 'code', v_text);
end;
$$;

-- Storefront state and the shop metafield carry max_units (0204 / 0212 otherwise unchanged).

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
                                                             'value_cents', value_cents, 'min_order_cents', min_order_cents,
                                                             'max_units', case when points_cost is null then 1 else max_units end)
                                          order by points_cost nulls last, key), '[]'::jsonb)
                  from loyalty_rewards where program_id = p_program and is_active),
    'logged_in', p_customer_id is not null,
    'member', v_member);
end;
$$;

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
                                                             'value_cents', r.value_cents, 'min_order_cents', r.min_order_cents,
                                                             'max_units', r.max_units)
                                          order by r.points_cost, r.key), '[]'::jsonb)
                  from loyalty_rewards r where r.program_id = p.id and r.is_active and r.points_cost is not null))
    from loyalty_programs p where p.id = p_program;
$$;

-- 3. Demotion lowers tier spend (0202's jobs otherwise unchanged) ---------------

create or replace function run_loyalty_jobs(p_now timestamptz default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now     timestamptz := coalesce(p_now, now());
  v_prog    loyalty_programs%rowtype;
  v_m       record;
  v_today   date;
  v_year    int;
  v_y       int;
  v_occ     date;
  v_ref     timestamptz;
  v_lower   text;
  v_floor   bigint;
  v_expired int := 0;
  v_demoted int := 0;
  v_warned  int := 0;
  v_bdays   int := 0;
  v_annivs  int := 0;
begin
  for v_prog in select * from loyalty_programs where is_active and live_since is not null loop
    v_today := (v_now at time zone v_prog.timezone)::date;
    v_year  := extract(year from v_today)::int;

    -- Expiry: whole balance after a lapse with no activity.
    if v_prog.points_expire_after is not null then
      for v_m in
        select id, points_balance, coalesce(last_activity_at, enrolled_at) as ref
          from loyalty_members
         where program_id = v_prog.id and status = 'active' and points_balance > 0
           and coalesce(last_activity_at, enrolled_at) + v_prog.points_expire_after <= v_now
      loop
        perform loyalty_post_entry(v_m.id, -v_m.points_balance, 'expire',
          'expire:' || v_m.id || ':' || extract(epoch from v_m.ref)::bigint,
          0, null, 'job', 'expiry', 'no activity since ' || v_m.ref::date, 'system', v_now);
        v_expired := v_expired + 1;
      end loop;
    end if;

    -- Demotion: one tier down after a lapse with no order; warn before.
    for v_m in
      select m.id, t.rank, m.tier_spend_cents,
             coalesce(greatest(m.last_order_at, m.last_demoted_at), m.enrolled_at) as ref
        from loyalty_members m
        join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
       where m.program_id = v_prog.id and m.status = 'active'
         and t.rank > (select min(rank) from loyalty_tiers where program_id = v_prog.id)
    loop
      v_ref := v_m.ref;
      if v_ref + v_prog.demote_after_inactive <= v_now then
        select key into v_lower from loyalty_tiers
         where program_id = v_prog.id and rank < v_m.rank order by rank desc limit 1;
        perform loyalty_set_tier(v_m.id, v_lower, 'inactivity');
        -- Joy's "move down one tier": tier progress drops to the new tier's
        -- threshold, so the next order doesn't put the member straight back.
        -- A zero-point ledger entry, so cached spend still equals the ledger.
        select min_spend_cents into v_floor from loyalty_tiers where program_id = v_prog.id and key = v_lower;
        if v_m.tier_spend_cents > v_floor then
          perform loyalty_post_entry(v_m.id, 0, 'adjust', 'demote_spend:' || v_m.id || ':' || extract(epoch from v_ref)::bigint,
                                     v_floor - v_m.tier_spend_cents, null, 'job', 'demotion',
                                     'inactivity demotion: tier spend reset to ' || v_lower, 'system', v_now);
        end if;
        update loyalty_members set last_demoted_at = v_now where id = v_m.id;
        v_demoted := v_demoted + 1;
      elsif v_ref + v_prog.demote_after_inactive - make_interval(days => v_prog.demotion_warning_days) <= v_now then
        if loyalty_emit_event(v_m.id, 'demotion_warning',
             'demotion_warning:' || v_m.id || ':' || extract(epoch from v_ref)::bigint,
             jsonb_build_object('demotes_at', v_ref + v_prog.demote_after_inactive)) then
          v_warned := v_warned + 1;
        end if;
      end if;
    end loop;

    -- Birthdays: event 7 days before; points + event on the day.
    for v_m in
      select id, birthday from loyalty_members
       where program_id = v_prog.id and status = 'active' and birthday is not null
    loop
      -- A week out may be next year's (Dec 28 -> Jan 4).
      foreach v_y in array array[v_year, v_year + 1] loop
        v_occ := loyalty_occurrence(v_m.birthday, v_y);
        if v_occ - v_today = 7 then
          perform loyalty_emit_event(v_m.id, 'pre_birthday', 'pre_birthday:' || v_m.id || ':' || v_y,
                                     jsonb_build_object('birthday', v_occ));
        end if;
      end loop;
      v_occ := loyalty_occurrence(v_m.birthday, v_year);
      -- Late December birthdays caught up on Jan 1 belong to last year.
      if v_today - v_occ not between 0 and 1 then
        v_occ := loyalty_occurrence(v_m.birthday, v_year - 1);
      end if;
      if v_today - v_occ between 0 and 1 then
        if loyalty_award_action(v_m.id, 'birthday', extract(year from v_occ)::text, v_now) > 0 then
          v_bdays := v_bdays + 1;
        end if;
        perform loyalty_emit_event(v_m.id, 'birthday', 'birthday:' || v_m.id || ':' || extract(year from v_occ),
                                   jsonb_build_object('birthday', v_occ));
      end if;
    end loop;

    -- Member anniversaries (1 year+).
    for v_m in
      select id, (enrolled_at at time zone v_prog.timezone)::date as joined from loyalty_members
       where program_id = v_prog.id and status = 'active'
    loop
      foreach v_y in array array[v_year, v_year - 1] loop
        v_occ := loyalty_occurrence(v_m.joined, v_y);
        if v_y > extract(year from v_m.joined) and v_today - v_occ between 0 and 1 then
          if loyalty_award_action(v_m.id, 'anniversary', v_y::text, v_now) > 0 then
            v_annivs := v_annivs + 1;
          end if;
        end if;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object('ran_at', v_now, 'expired', v_expired, 'demoted', v_demoted,
                            'warned', v_warned, 'birthdays', v_bdays, 'anniversaries', v_annivs);
end;
$$;

revoke execute on function loyalty_money_label(bigint) from public, anon, authenticated;
revoke execute on function loyalty_redeem(uuid, text, text, int) from public, anon, authenticated;
grant execute on function loyalty_money_label(bigint) to service_role;
grant execute on function loyalty_redeem(uuid, text, text, int) to service_role;
