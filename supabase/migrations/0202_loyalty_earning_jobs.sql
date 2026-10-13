-- =============================================================================
-- 0202_loyalty_earning_jobs.sql — LL Loyalty module 3: earning rules,
-- milestones, referrals, expiry and demotion. Plan: docs/loyalty/PLAN.md.
-- Builds on 0200 (ledger) and 0201 (Shopify sync).
--
-- NO DOUBLE PAY ACROSS THE JOY SWITCH. Joy keeps paying until cutover and its
-- balances are imported as opening balances (module 8), so everything here
-- only pays for things that happen AFTER the program went live (live_since):
--   * milestones    — live webhook orders only, never backfilled ones
--   * signup        — only accounts created on/after live_since
--   * newsletter    — only when Shopify's consent_updated_at is on/after live_since
--   * birthday / anniversary / expiry / demotion — jobs, from go-live on
-- Every award is keyed once per member (or per member per year), so retries
-- and re-runs never pay twice.
--
-- REFERRALS. A member refers a friend's email (loyalty_create_referral); module
-- 4 gives the friend a single-use discount code (loyalty_referrals.discount_code).
-- When a PAID order uses that code, the referrer earns the 'referral' rule
-- points. Checks kept from Joy (plan §3): a friend can be referred once, a
-- similar email (same address after normalizing) is rejected, the friend must
-- not already be a paying member, paid orders only.
--
-- JOBS. run_loyalty_jobs() is plain SQL, scheduled hourly by pg_cron. Each step
-- is idempotent, so the hourly cadence only shortens the delay after an outage.
-- Dates (birthdays, anniversaries) use loyalty_programs.timezone.
--
-- EVENTS. loyalty_events is an outbox the Klaviyo sender (module 6) drains:
-- demotion_warning, pre_birthday, birthday. Tier changes stay in
-- loyalty_tier_changes and awards in loyalty_ledger.
--
-- Test: scripts/test_loyalty_earning_jobs.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_programs add column if not exists timezone text not null default 'UTC';
alter table loyalty_members  add column if not exists last_demoted_at timestamptz;

-- -----------------------------------------------------------------------------
-- Events outbox
-- -----------------------------------------------------------------------------
create table if not exists loyalty_events (
  id          bigint      generated always as identity primary key,
  program_id  uuid        not null references loyalty_programs(id) on delete cascade,
  member_id   uuid        not null references loyalty_members(id) on delete cascade,
  kind        text        not null check (kind in ('demotion_warning', 'pre_birthday', 'birthday')),
  payload     jsonb       not null default '{}'::jsonb,
  dedupe_key  text        not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  attempts    int         not null default 0,
  last_error  text,
  unique (program_id, dedupe_key)
);

create index if not exists idx_loyalty_events_unsent on loyalty_events(created_at) where sent_at is null;

create or replace function loyalty_emit_event(p_member uuid, p_kind text, p_dedupe_key text, p_payload jsonb default '{}'::jsonb)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into loyalty_events (program_id, member_id, kind, payload, dedupe_key)
  select m.program_id, m.id, p_kind, coalesce(p_payload, '{}'::jsonb), p_dedupe_key
    from loyalty_members m where m.id = p_member
  on conflict (program_id, dedupe_key) do nothing;
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_award_action — an active 'action' rule's points, once per member
-- (p_period null) or once per member per period (e.g. the year, for
-- birthdays). Returns points awarded: 0 when already awarded, the rule is
-- inactive/missing, or it is worth 0.
-- -----------------------------------------------------------------------------
create or replace function loyalty_award_action(
  p_member      uuid,
  p_rule_key    text,
  p_period      text default null,
  p_occurred_at timestamptz default null,   -- null = now
  p_actor       text default 'system'
)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_points int;
  v_r      jsonb;
begin
  select r.points into v_points
    from loyalty_earn_rules r join loyalty_members m on m.program_id = r.program_id
   where m.id = p_member and m.status = 'active'
     and r.key = p_rule_key and r.kind = 'action' and r.is_active;
  if coalesce(v_points, 0) = 0 then
    return 0;
  end if;
  v_r := loyalty_post_entry(
    p_member, v_points, 'action',
    'action:' || p_rule_key || ':' || p_member || coalesce(':' || p_period, ''),
    0, p_rule_key, 'rule', p_rule_key, null, p_actor, p_occurred_at);
  return case when (v_r->>'duplicate')::boolean then 0 else v_points end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Referrals
-- -----------------------------------------------------------------------------

-- loyalty_normalize_email — the "similar email" check: lowercase, no +tag, and
-- for Gmail no dots (a.b+x@googlemail.com = ab@gmail.com).
create or replace function loyalty_normalize_email(p_email text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when position('@' in coalesce(p_email, '')) < 2 then nullif(lower(trim(p_email)), '')
    else (
      select case when d in ('gmail.com', 'googlemail.com')
                  then replace(split_part(l, '+', 1), '.', '') || '@gmail.com'
                  else split_part(l, '+', 1) || '@' || d end
        from (select split_part(lower(trim(p_email)), '@', 1) as l,
                     split_part(lower(trim(p_email)), '@', 2) as d) x)
  end;
$$;

create table if not exists loyalty_referrals (
  id                  uuid        primary key default gen_random_uuid(),
  program_id          uuid        not null references loyalty_programs(id) on delete cascade,
  referrer_id         uuid        not null references loyalty_members(id) on delete cascade,
  friend_email        text        not null,          -- as entered
  friend_email_norm   text        not null,
  discount_code       text,                          -- set by module 4
  status              text        not null default 'invited' check (status in ('invited', 'completed', 'rejected')),
  reject_reason       text,
  friend_customer_id  bigint,
  shopify_order_id    bigint,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (program_id, friend_email_norm)               -- a friend can be referred once
);

create unique index if not exists uq_loyalty_referrals_code
  on loyalty_referrals(program_id, upper(discount_code)) where discount_code is not null;
create index if not exists idx_loyalty_referrals_referrer on loyalty_referrals(referrer_id);

drop trigger if exists trg_loyalty_referrals_updated_at on loyalty_referrals;
create trigger trg_loyalty_referrals_updated_at
  before update on loyalty_referrals
  for each row execute function set_updated_at();

-- loyalty_create_referral — returns {status, referral_id}. status:
--   created | already_referred | similar_email | already_customer | invalid_email
create or replace function loyalty_create_referral(p_referrer uuid, p_friend_email text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_m    loyalty_members%rowtype;
  v_norm text := loyalty_normalize_email(p_friend_email);
  v_id   uuid;
begin
  select * into v_m from loyalty_members where id = p_referrer and status = 'active';
  if not found then
    raise exception 'loyalty member % not found or not active', p_referrer;
  end if;
  if v_norm is null or v_norm !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('status', 'invalid_email');
  end if;
  if v_norm = loyalty_normalize_email(v_m.email) then
    return jsonb_build_object('status', 'similar_email');
  end if;
  if exists (select 1 from loyalty_members
              where program_id = v_m.program_id and paid_order_count > 0
                and loyalty_normalize_email(email) = v_norm) then
    return jsonb_build_object('status', 'already_customer');
  end if;

  insert into loyalty_referrals (program_id, referrer_id, friend_email, friend_email_norm)
  values (v_m.program_id, p_referrer, trim(p_friend_email), v_norm)
  on conflict (program_id, friend_email_norm) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('status', 'already_referred');
  end if;
  return jsonb_build_object('status', 'created', 'referral_id', v_id);
end;
$$;

-- loyalty_complete_referral — a paid order used a referral's code. Pays the
-- referrer (once per referral) or rejects it. Returns the referral's new
-- status, or null when no open referral has any of these codes.
create or replace function loyalty_complete_referral(p_program uuid, p_order jsonb)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ref      loyalty_referrals%rowtype;
  v_referrer loyalty_members%rowtype;
  v_cust     bigint := nullif(p_order->'customer'->>'id', '')::bigint;
  v_email    text := loyalty_normalize_email(coalesce(nullif(p_order->>'email', ''), p_order->'customer'->>'email'));
  v_points   int;
  v_friend   uuid;
begin
  select r.* into v_ref
    from loyalty_referrals r
   where r.program_id = p_program and r.status = 'invited' and r.discount_code is not null
     and upper(r.discount_code) in (select upper(c) from jsonb_array_elements_text(coalesce(p_order->'discount_codes', '[]'::jsonb)) c)
   limit 1
   for update;
  if not found then
    return null;
  end if;
  select * into v_referrer from loyalty_members where id = v_ref.referrer_id;

  if v_cust is not null and v_cust = v_referrer.shopify_customer_id then
    update loyalty_referrals set status = 'rejected', reject_reason = 'self', shopify_order_id = (p_order->>'id')::bigint
     where id = v_ref.id;
    return 'rejected';
  end if;
  if v_email is not null and v_email = loyalty_normalize_email(v_referrer.email) then
    update loyalty_referrals set status = 'rejected', reject_reason = 'similar_email', shopify_order_id = (p_order->>'id')::bigint
     where id = v_ref.id;
    return 'rejected';
  end if;

  update loyalty_referrals
     set status = 'completed', friend_customer_id = v_cust, shopify_order_id = (p_order->>'id')::bigint,
         completed_at = coalesce(nullif(p_order->>'processed_at', '')::timestamptz, now())
   where id = v_ref.id;

  select points into v_points from loyalty_earn_rules
   where program_id = p_program and kind = 'referral' and is_active
   order by key limit 1;
  if coalesce(v_points, 0) > 0 and v_referrer.status = 'active' then
    perform loyalty_post_entry(v_referrer.id, v_points, 'referral', 'referral:' || v_ref.id, 0,
                               'referral', 'referral', v_ref.id::text, null, 'system',
                               nullif(p_order->>'processed_at', '')::timestamptz);
  end if;

  if v_cust is not null then
    select id into v_friend from loyalty_members where program_id = p_program and shopify_customer_id = v_cust;
    update loyalty_members set referred_by = v_referrer.id where id = v_friend and referred_by is null;
  end if;
  return 'completed';
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_sync_customer — 0201's, plus the live-only awards. p_live is true
-- for webhooks, false for the backfill.
-- -----------------------------------------------------------------------------
drop function if exists loyalty_sync_customer(uuid, jsonb);

create or replace function loyalty_sync_customer(p_program uuid, p_customer jsonb, p_live boolean default false)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id      bigint := nullif(p_customer->>'id', '')::bigint;
  v_member  uuid;
  v_prog    loyalty_programs%rowtype;
  v_created timestamptz := nullif(p_customer->>'created_at', '')::timestamptz;
  v_consent jsonb := p_customer->'email_marketing_consent';
  v_new     boolean;
begin
  if v_id is null then
    return null;   -- guest checkout with no customer record
  end if;
  select id into v_member from loyalty_members where program_id = p_program and shopify_customer_id = v_id;
  select * into v_prog from loyalty_programs where id = p_program;
  if v_member is null and not (coalesce(v_prog.is_active, false)
                               and (v_prog.enroll_guests or lower(p_customer->>'state') = 'enabled')) then
    return null;
  end if;
  v_new := v_member is null;

  v_member := loyalty_enroll_member(
    p_program, v_id,
    nullif(p_customer->>'email', ''), nullif(p_customer->>'first_name', ''), nullif(p_customer->>'last_name', ''),
    v_created);

  if p_live and v_prog.is_active and v_prog.live_since is not null then
    if v_new and v_created >= v_prog.live_since then
      perform loyalty_award_action(v_member, 'signup', null, v_created);
    end if;
    if lower(v_consent->>'state') = 'subscribed'
       and nullif(v_consent->>'consent_updated_at', '')::timestamptz >= v_prog.live_since then
      perform loyalty_award_action(v_member, 'newsletter', null, (v_consent->>'consent_updated_at')::timestamptz);
    end if;
  end if;
  return v_member;
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_record_order — 0201's, plus referral completion and milestones on
-- live orders. p_order may now carry email and discount_codes.
-- -----------------------------------------------------------------------------
create or replace function loyalty_record_order(p_program uuid, p_order jsonb, p_source text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prog      loyalty_programs%rowtype;
  v_order_id  bigint := (p_order->>'id')::bigint;
  v_at        timestamptz := coalesce(nullif(p_order->>'processed_at', '')::timestamptz, now());
  v_eligible  bigint := greatest(coalesce((p_order->>'eligible_cents')::bigint, 0), 0);
  v_net       bigint;
  v_member    uuid;
  v_counted   boolean;
  v_points    int := 0;
  v_before    int;
  v_after     int;
  v_r         jsonb;
  v_ms        record;
  v_awarded   text[] := '{}';
  v_referral  text;
begin
  if p_source not in ('webhook', 'backfill') then
    raise exception 'unknown source %', p_source;
  end if;
  if v_order_id is null then
    raise exception 'order id is required';
  end if;
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  v_net := least(greatest(coalesce((p_order->>'net_eligible_cents')::bigint, v_eligible), 0), v_eligible);

  if exists (select 1 from loyalty_orders where program_id = p_program and shopify_order_id = v_order_id) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  -- Before the member check: a guest friend's order still pays the referrer.
  if p_source = 'webhook' then
    v_referral := loyalty_complete_referral(p_program, p_order);
  end if;

  v_member := loyalty_sync_customer(p_program, p_order->'customer', p_source = 'webhook');
  if v_member is null then
    return jsonb_build_object('status', 'not_member', 'referral', v_referral);
  end if;

  v_counted := v_prog.tier_spend_since is null or v_at >= v_prog.tier_spend_since::timestamptz;
  if p_source = 'webhook' then
    v_points := loyalty_order_points(v_member, v_eligible);
  end if;

  insert into loyalty_orders (program_id, shopify_order_id, member_id, order_name, eligible_cents,
                              refunded_cents, spend_counted, points_earned, source, processed_at)
  values (p_program, v_order_id, v_member, p_order->>'name', v_eligible,
          v_eligible - v_net, v_counted, v_points, p_source, v_at)
  on conflict (program_id, shopify_order_id) do nothing;
  if not found then
    return jsonb_build_object('status', 'duplicate');   -- a concurrent delivery won
  end if;

  select paid_order_count into v_before from loyalty_members where id = v_member;
  v_r := loyalty_post_entry(
    v_member, v_points, 'order', 'order:' || v_order_id || ':earn',
    case when v_counted then v_net else 0 end,
    null, 'shopify_order', v_order_id::text,
    case when p_source = 'backfill' then 'backfill: spend and order count only' end,
    'system', v_at);
  v_after := (v_r->>'paid_order_count')::int;

  -- Milestones: live orders only; all of them if several are crossed at once.
  if p_source = 'webhook' and not (v_r->>'duplicate')::boolean then
    for v_ms in select * from loyalty_milestones_crossed(p_program, v_before, v_after) loop
      if v_ms.points > 0 then
        v_r := loyalty_post_entry(v_member, v_ms.points, 'milestone', 'milestone:' || v_member || ':' || v_ms.key,
                                  0, v_ms.key, 'shopify_order', v_order_id::text, null, 'system', v_at);
        if not (v_r->>'duplicate')::boolean then
          v_awarded := v_awarded || v_ms.key;
        end if;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', 'recorded', 'member_id', v_member, 'points', v_points,
    'orders_before', v_before, 'orders_after', v_after,
    'milestones', to_jsonb(v_awarded), 'referral', v_referral);
end;
$$;

-- loyalty_sync_customers — 0201's batch form, re-created against the new
-- signature (backfill: not live).
create or replace function loyalty_sync_customers(p_program uuid, p_customers jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_c jsonb;
  v_n int := 0;
begin
  for v_c in select * from jsonb_array_elements(coalesce(p_customers, '[]'::jsonb)) loop
    if loyalty_sync_customer(p_program, v_c, false) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Date helper: this year's occurrence of a month/day, Feb 29 -> Feb 28.
-- -----------------------------------------------------------------------------
create or replace function loyalty_occurrence(p_date date, p_year int)
returns date
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when extract(month from p_date) = 2 and extract(day from p_date) = 29
         and not (p_year % 4 = 0 and (p_year % 100 <> 0 or p_year % 400 = 0))
      then make_date(p_year, 2, 28)
    else make_date(p_year, extract(month from p_date)::int, extract(day from p_date)::int)
  end;
$$;

-- -----------------------------------------------------------------------------
-- run_loyalty_jobs — expiry, demotion (+ warning), birthdays, anniversaries,
-- for every active, live program. p_now is for tests. Returns counts.
--
-- Birthday and anniversary pay on the day or the day after (one missed run is
-- caught up), keyed by year. Expiry is keyed by the inactivity period, so a
-- member is expired once per lapse. Demotion is one tier per lapse: the clock
-- restarts at the demotion, so Gold -> Silver -> Bronze takes two lapses.
-- -----------------------------------------------------------------------------
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
      select m.id, t.rank,
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

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — loyalty jobs NOT scheduled. Enable it, then re-run this migration.';
    return;
  end if;
  begin
    perform cron.unschedule('loyalty-jobs');
  exception when others then
    null;
  end;
  perform cron.schedule('loyalty-jobs', '7 * * * *', $cron$select run_loyalty_jobs();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only (as 0200).
-- -----------------------------------------------------------------------------
alter table loyalty_events    enable row level security;
alter table loyalty_referrals enable row level security;
revoke all on loyalty_events, loyalty_referrals from anon, authenticated;
grant select, insert, update, delete on loyalty_events, loyalty_referrals to service_role;

revoke execute on function loyalty_emit_event(uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_award_action(uuid, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function loyalty_normalize_email(text) from public, anon, authenticated;
revoke execute on function loyalty_create_referral(uuid, text) from public, anon, authenticated;
revoke execute on function loyalty_complete_referral(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_sync_customer(uuid, jsonb, boolean) from public, anon, authenticated;
revoke execute on function loyalty_record_order(uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function loyalty_sync_customers(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_occurrence(date, int) from public, anon, authenticated;
revoke execute on function run_loyalty_jobs(timestamptz) from public, anon, authenticated;

grant execute on function loyalty_emit_event(uuid, text, text, jsonb) to service_role;
grant execute on function loyalty_award_action(uuid, text, text, timestamptz, text) to service_role;
grant execute on function loyalty_normalize_email(text) to service_role;
grant execute on function loyalty_create_referral(uuid, text) to service_role;
grant execute on function loyalty_complete_referral(uuid, jsonb) to service_role;
grant execute on function loyalty_sync_customer(uuid, jsonb, boolean) to service_role;
grant execute on function loyalty_record_order(uuid, jsonb, text) to service_role;
grant execute on function loyalty_sync_customers(uuid, jsonb) to service_role;
grant execute on function loyalty_occurrence(date, int) to service_role;
grant execute on function run_loyalty_jobs(timestamptz) to service_role;
