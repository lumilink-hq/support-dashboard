-- =============================================================================
-- 0224_loyalty_plans.sql - LL Loyalty Phase 2 module P3: plans, feature gates,
-- order metering and Shopify usage events.
-- Plan: docs/loyalty/PLAN.md section 7 (proposed pricing, NOT approved - the
-- numbers live in loyalty_plans, so a change after approval is an update).
--
-- loyalty_plans - free, starter, growth, pro. features is the list the gates
--   read (loyalty_plan_allows):
--     checkout_blocks  thank-you, order status and account blocks (loyalty-ext)
--     expiry           points expiry job
--     demotion         inactivity demotion + warning job
--     milestones       order milestone points
--     growth           the Phase 1b engine - bonus campaigns, badges, streaks,
--                      challenges, automations, purchase nudges
--     insights         ROI and analytics pages, for merchants (staff always see them)
--     games, api       Pro, not built yet
--
-- Program plan - plan_key, plan_source staff or shopify. The column default
--   is pro, so a program staff make with the setup script keeps every feature,
--   as before. Self-serve installs start on free (loyalty_create_default_program). Staff
--   set it for stores billed outside Shopify (custom apps billed by Stripe,
--   Tsunami). Shopify App Pricing sets it for public-app stores, through the
--   loyalty-billing edge function (plan check on the Partner API). Programs that
--   exist before this migration get pro (Tsunami, the dev store), except
--   self-serve ones, which get free.
--
-- Growth needs treatment_since (0211). For a self-serve program, moving onto a
--   plan with growth starts it, so the features work without a staff step.
--   Staff-made programs keep setting it by hand (holdout measurement).
--
-- Downgrades never delete settings - a gated feature just stops running.
--   Members keep their points, campaigns stay in the table, inactive.
--
-- Usage - Shopify App Pricing bills overage itself from usage events (a
--   graduated meter with the included orders at 0). Each live paid order on a
--   shopify-billed program queues one event in loyalty_usage_events, and
--   loyalty-billing sends it to the App Events API (one per request, the order
--   id as idempotency key). Over the cap, earning never stops - the Free plan
--   only shows an upgrade prompt (loyalty_plan_usage).
--
-- Comment rule (plan section 1): no semicolons or apostrophes in top-level
-- comments.
--
-- Test: scripts/test_loyalty_plans.sql.
-- =============================================================================

create table if not exists loyalty_plans (
  key                    text        primary key check (key ~ '^[a-z0-9_]+$'),
  name                   text        not null,
  price_cents            int         not null check (price_cents >= 0),
  included_orders        int         not null check (included_orders > 0),
  overage_cents_per_100  int         check (overage_cents_per_100 is null or overage_cents_per_100 > 0),
  features               text[]      not null default '{}',
  sort                   int         not null,
  shopify_plan_handle    text        unique,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table loyalty_plans enable row level security;

drop trigger if exists trg_loyalty_plans_updated_at on loyalty_plans;
create trigger trg_loyalty_plans_updated_at
  before update on loyalty_plans
  for each row execute function set_updated_at();

insert into loyalty_plans (key, name, price_cents, included_orders, overage_cents_per_100, features, sort, shopify_plan_handle) values
  ('free',    'Free',    0,     300,   null, '{}', 0, 'free'),
  ('starter', 'Starter', 1500,  750,   1000, '{checkout_blocks,expiry,demotion,milestones}', 1, 'starter'),
  ('growth',  'Growth',  7900,  2500,  800,  '{checkout_blocks,expiry,demotion,milestones,growth,insights}', 2, 'growth'),
  ('pro',     'Pro',     24900, 10000, 400,  '{checkout_blocks,expiry,demotion,milestones,growth,insights,games,api}', 3, 'pro')
on conflict (key) do nothing;

alter table loyalty_programs add column if not exists plan_key text not null default 'pro' references loyalty_plans(key);
alter table loyalty_programs alter column plan_key set default 'pro';
alter table loyalty_programs add column if not exists plan_source text not null default 'staff' check (plan_source in ('staff', 'shopify'));
alter table loyalty_programs add column if not exists plan_changed_at timestamptz;
alter table loyalty_programs add column if not exists shopify_shop_gid text;
alter table loyalty_programs add column if not exists plan_checked_at timestamptz;
-- The public app id on the Partner API (gid://shopify/App/...), for the plan check.
alter table loyalty_apps add column if not exists partner_app_gid text;

update loyalty_programs set plan_key = 'free'
 where plan_changed_at is null and created_via = 'self_serve' and plan_key = 'pro';

alter table loyalty_access_log drop constraint if exists loyalty_access_log_action_check;
alter table loyalty_access_log add constraint loyalty_access_log_action_check check (action in (
  'search', 'view', 'adjust', 'set_tier', 'set_birthday', 'data_requests', 'campaign_save', 'campaign_active',
  'challenge_save', 'challenge_active', 'list', 'program_save', 'plan_set'));

create or replace function loyalty_plan_allows(p_program uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select p_feature = any (pl.features)
                     from loyalty_programs p join loyalty_plans pl on pl.key = p.plan_key
                    where p.id = p_program), false);
$$;

-- loyalty_set_plan - the one place a plan changes. p_source staff or shopify.
create or replace function loyalty_set_plan(p_program uuid, p_plan_key text, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p    loyalty_programs%rowtype;
  v_from text;
begin
  if p_source not in ('staff', 'shopify') then
    raise exception 'plan source must be staff or shopify';
  end if;
  if not exists (select 1 from loyalty_plans where key = p_plan_key) then
    raise exception 'unknown plan %', p_plan_key;
  end if;
  select * into v_p from loyalty_programs where id = p_program for update;
  if not found then
    raise exception 'program not found';
  end if;
  v_from := v_p.plan_key;
  update loyalty_programs
     set plan_key = p_plan_key, plan_source = p_source,
         plan_changed_at = case when plan_key is distinct from p_plan_key or plan_source is distinct from p_source
                                then now() else plan_changed_at end,
         plan_checked_at = now(),
         treatment_since = case when created_via = 'self_serve' and treatment_since is null
                                     and exists (select 1 from loyalty_plans pl where pl.key = p_plan_key and 'growth' = any (pl.features))
                                then now() else treatment_since end
   where id = p_program;
  return jsonb_build_object('program_id', p_program, 'from', v_from, 'to', p_plan_key, 'source', p_source);
end;
$$;

-- loyalty_staff_set_plan - staff only: stores billed outside Shopify.
create or replace function loyalty_staff_set_plan(p_program uuid, p_plan_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r jsonb;
begin
  perform loyalty_require_staff();
  v_r := loyalty_set_plan(p_program, p_plan_key, 'staff');
  perform loyalty_log_access('plan_set', p_program, null, v_r);
  return v_r;
end;
$$;

-- loyalty_plan_usage - live orders this calendar month in the store time zone,
-- against the plan. Shopify bills on its own 30-day cycle, so this is a guide
-- for the pages, not the invoice.
create or replace function loyalty_plan_usage(p_program uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'plan', pl.key, 'plan_name', pl.name, 'source', p.plan_source,
           'price_cents', pl.price_cents, 'included_orders', pl.included_orders,
           'overage_cents_per_100', pl.overage_cents_per_100, 'features', to_jsonb(pl.features),
           'month', to_char(now() at time zone p.timezone, 'YYYY-MM'),
           'orders', (select count(*) from loyalty_orders o
                       where o.program_id = p.id and o.source = 'webhook'
                         and o.processed_at >= (date_trunc('month', now() at time zone p.timezone) at time zone p.timezone)),
           'over_cap', (select count(*) from loyalty_orders o
                         where o.program_id = p.id and o.source = 'webhook'
                           and o.processed_at >= (date_trunc('month', now() at time zone p.timezone) at time zone p.timezone))
                       > pl.included_orders)
    from loyalty_programs p join loyalty_plans pl on pl.key = p.plan_key
   where p.id = p_program;
$$;

-- loyalty_staff_plan - the plan card on the program page.
create or replace function loyalty_staff_plan(p_program uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform loyalty_require_manager(p_program);
  return loyalty_plan_usage(p_program) || jsonb_build_object(
    'plans', (select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'price_cents', price_cents,
                                                  'included_orders', included_orders) order by sort)
                from loyalty_plans));
end;
$$;

-- -----------------------------------------------------------------------------
-- Usage events (Shopify App Pricing meter)
-- -----------------------------------------------------------------------------
create table if not exists loyalty_usage_events (
  id                bigint      generated always as identity primary key,
  program_id        uuid        not null references loyalty_programs(id) on delete cascade,
  shopify_order_id  bigint      not null,
  occurred_at       timestamptz not null default now(),
  status            text        not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts          int         not null default 0,
  last_error        text,
  sent_at           timestamptz,
  unique (program_id, shopify_order_id)
);

create index if not exists idx_loyalty_usage_events_pending on loyalty_usage_events(program_id) where status = 'pending';
alter table loyalty_usage_events enable row level security;

create or replace function loyalty_queue_usage_event()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source = 'webhook'
     and exists (select 1 from loyalty_programs where id = new.program_id and plan_source = 'shopify') then
    insert into loyalty_usage_events (program_id, shopify_order_id)
    values (new.program_id, new.shopify_order_id)
    on conflict (program_id, shopify_order_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_loyalty_orders_usage on loyalty_orders;
create trigger trg_loyalty_orders_usage
  after insert on loyalty_orders
  for each row execute function loyalty_queue_usage_event();

-- loyalty_billing_due - pending events for one program, with what the sender
-- needs: the shop gid and the public app credentials (App Events auth).
create or replace function loyalty_billing_due(p_program uuid, p_limit int default 200)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'program_id', p.id,
    'shop_domain', p.shop_domain,
    'shop_gid', p.shopify_shop_gid,
    'app_client_id', a.app_client_id,
    'partner_app_gid', la.partner_app_gid,
    'plan_checked_at', p.plan_checked_at,
    'credentials', (select decrypted_secret from vault.decrypted_secrets where name = la.app_secret_ref),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'order_id', e.shopify_order_id, 'occurred_at', e.occurred_at)
                                         order by e.id)
                          from (select * from loyalty_usage_events
                                 where program_id = p.id and status = 'pending' order by id limit p_limit) e), '[]'::jsonb))
    from loyalty_programs p
    left join lateral (select * from loyalty_shopify_apps sa
                        where sa.program_id = p.id and sa.token_ref is not null
                          and exists (select 1 from loyalty_apps x where x.app_client_id = sa.app_client_id and x.distribution = 'public')
                        order by sa.connected_at desc limit 1) a on true
    left join loyalty_apps la on la.app_client_id = a.app_client_id
   where p.id = p_program;
$$;

-- loyalty_billing_mark - after a send. 5 failed attempts = failed (staff look).
create or replace function loyalty_billing_mark(p_event bigint, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update loyalty_usage_events
     set attempts = attempts + 1,
         status = case when p_ok then 'sent' when attempts + 1 >= 5 then 'failed' else 'pending' end,
         sent_at = case when p_ok then now() end,
         last_error = case when p_ok then null else left(p_error, 500) end
   where id = p_event;
$$;

create or replace function request_loyalty_billing(p_program uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed - cannot request loyalty billing';
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'loyalty_billing_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';
  if v_url is null or v_secret is null then
    raise notice 'loyalty_billing_url / voice_tool_secret not in Vault - cannot request loyalty billing';
    return null;
  end if;
  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using v_url,
          jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
          jsonb_build_object('program_id', p_program::text);
  return v_req;
end;
$$;

-- Every minute: programs with pending usage, and once a day every program
-- billed by Shopify or installed through a public app, so the plan check
-- catches changes made in Shopify.
create or replace function run_due_loyalty_billing()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row record;
  v_n   int := 0;
begin
  for v_row in
    select p.id from loyalty_programs p
     where p.is_active
       and (p.plan_source = 'shopify'
            or exists (select 1 from loyalty_shopify_apps sa join loyalty_apps x on x.app_client_id = sa.app_client_id
                        where sa.program_id = p.id and sa.token_ref is not null and x.distribution = 'public'))
       and (exists (select 1 from loyalty_usage_events e where e.program_id = p.id and e.status = 'pending')
            or p.plan_checked_at is null or p.plan_checked_at < now() - interval '1 day')
  loop
    if request_loyalty_billing(v_row.id) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed - loyalty billing NOT scheduled. Enable it, then re-run this migration.';
    return;
  end if;
  begin
    perform cron.unschedule('loyalty-billing-due');
  exception when others then
    null;
  end;
  perform cron.schedule('loyalty-billing-due', '* * * * *', $cron$select run_due_loyalty_billing();$cron$);
end;
$$;

revoke all on table loyalty_plans from public, anon, authenticated;
revoke all on table loyalty_usage_events from public, anon, authenticated;
revoke execute on function loyalty_plan_allows(uuid, text) from public, anon, authenticated;
revoke execute on function loyalty_set_plan(uuid, text, text) from public, anon, authenticated;
revoke execute on function loyalty_staff_set_plan(uuid, text) from public, anon;
revoke execute on function loyalty_plan_usage(uuid) from public, anon, authenticated;
revoke execute on function loyalty_staff_plan(uuid) from public, anon;
revoke execute on function loyalty_queue_usage_event() from public, anon, authenticated;
revoke execute on function loyalty_billing_due(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_billing_mark(bigint, boolean, text) from public, anon, authenticated;
revoke execute on function request_loyalty_billing(uuid) from public, anon, authenticated;
revoke execute on function run_due_loyalty_billing() from public, anon, authenticated;

grant execute on function loyalty_staff_set_plan(uuid, text) to authenticated;
grant execute on function loyalty_staff_plan(uuid) to authenticated;
grant execute on function loyalty_set_plan(uuid, text, text) to service_role;
grant execute on function loyalty_plan_usage(uuid) to service_role;
grant execute on function loyalty_billing_due(uuid, int) to service_role;
grant execute on function loyalty_billing_mark(bigint, boolean, text) to service_role;
grant execute on function request_loyalty_billing(uuid) to service_role;
grant execute on function run_due_loyalty_billing() to service_role;

-- -----------------------------------------------------------------------------
-- Gates. Each function below is its latest migration version with only the
-- plan check added.
-- -----------------------------------------------------------------------------

-- loyalty_create_default_program, from 0222_loyalty_self_serve_install
create or replace function loyalty_create_default_program(p_shop text, p_shop_name text, p_timezone text)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_shop   text := lower(p_shop);
  v_name   text := nullif(btrim(coalesce(p_shop_name, '')), '');
  v_tz     text := coalesce(nullif(p_timezone, ''), 'UTC');
  v_base   text;
  v_slug   text;
  v_client uuid;
  v_prog   uuid;
  i        int := 1;
begin
  if v_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then
    raise exception 'not a myshopify domain: %', p_shop;
  end if;
  if exists (select 1 from loyalty_programs where shop_domain = v_shop) then
    raise exception 'shop % already has a program', v_shop;
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;
  v_name := left(coalesce(v_name, split_part(v_shop, '.', 1)), 80);

  v_base := 'loyalty-' || split_part(v_shop, '.', 1);
  v_slug := v_base;
  while exists (select 1 from clients where slug = v_slug) loop
    i := i + 1;
    v_slug := v_base || '-' || i;
  end loop;
  insert into clients (name, slug) values (v_name, v_slug) returning id into v_client;

  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, tier_spend_since,
                                demote_after_inactive, demotion_warning_days, points_expire_after,
                                discount_code_prefix, timezone, enroll_guests, created_via, plan_key)
  values (v_client, v_shop, left(v_name || ' Rewards', 80), 1, null,
          '12 months', 7, '1 year', 'LL-', v_tz, true, 'self_serve', 'free')
  returning id into v_prog;

  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier, perks) values
    (v_prog, 'bronze', 'Bronze', 0, 0,      1.0,  '[]'),
    (v_prog, 'silver', 'Silver', 1, 50000,  1.25, '["1.25x points"]'),
    (v_prog, 'gold',   'Gold',   2, 100000, 1.5,  '["1.5x points"]');

  insert into loyalty_earn_rules (program_id, key, kind, points, order_count, claimable) values
    (v_prog, 'signup',      'action',    50,  null, false),
    (v_prog, 'birthday',    'action',    100, null, false),
    (v_prog, 'anniversary', 'action',    100, null, false),
    (v_prog, 'referral',    'referral',  200, null, false),
    (v_prog, 'order_1',     'milestone', 50,  1,    false);

  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents, min_order_cents, max_units) values
    (v_prog, 'five_off',        '$5 off',                   'amount_off_order', 200,  500,  0, null),
    (v_prog, 'referral_friend', '$10 off your first order', 'amount_off_order', null, 1000, 0, 1);

  perform loyalty_seed_default_badges(v_prog);
  return v_prog;
end;
$$;

-- loyalty_nudges_for, from 0212_loyalty_nudges
create or replace function loyalty_nudges_for(p_member uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(p.treatment_since is not null and p.treatment_since <= now() and loyalty_member_treated(m.id)
                  and loyalty_plan_allows(p.id, 'growth'), false)
    from loyalty_members m join loyalty_programs p on p.id = m.program_id
   where m.id = p_member;
$$;

-- run_loyalty_automations, from 0216_loyalty_achievements
create or replace function run_loyalty_automations(p_now timestamptz default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now    timestamptz := coalesce(p_now, now());
  v_p      loyalty_programs%rowtype;
  v_c      loyalty_campaigns%rowtype;
  v_ch     loyalty_challenges%rowtype;
  v_near   int := 0;
  v_bal    int := 0;
  v_camp   int := 0;
  v_chs    int := 0;
  v_streak int := 0;
  v_n      int;
  v_q      text;
  v_slot   bigint;
  v_local  timestamp;
  v_month  text;
begin
  for v_p in
    select * from loyalty_programs where is_active and treatment_since is not null and treatment_since <= v_now
       and loyalty_plan_allows(id, 'growth')
  loop
    v_q := to_char(v_now at time zone v_p.timezone, 'YYYY-"Q"Q');
    v_local := v_now at time zone v_p.timezone;
    v_month := to_char(v_local, 'YYYY-MM');

    -- near_tier (0214)
    with cand as (
      select m.id, nt.key next_key, nt.name next_name, nt.min_spend_cents - m.tier_spend_cents remaining
        from loyalty_members m
        join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
        join lateral (select * from loyalty_tiers x where x.program_id = m.program_id and x.rank > t.rank
                       order by x.rank limit 1) nt on true
       where m.program_id = v_p.id and m.status = 'active' and m.holdout_bucket >= v_p.holdout_percent
         and nt.min_spend_cents - m.tier_spend_cents > 0
         and nt.min_spend_cents - m.tier_spend_cents <= nt.min_spend_cents * v_p.near_tier_percent / 100.0
    )
    select count(*) filter (where loyalty_emit_event(c.id, 'near_tier', 'near_tier:' || c.id || ':' || c.next_key || ':' || v_q,
             jsonb_build_object('next_tier', c.next_name, 'remaining_cents', c.remaining,
                                'remaining', to_char(c.remaining / 100.0, 'FM999999990.00'))))
      into v_n from cand c;
    v_near := v_near + v_n;

    -- balance_reminder (0214)
    v_slot := floor(extract(epoch from v_now) / (v_p.balance_reminder_days * 86400));
    with cheapest as (
      select key, name, points_cost, value_cents from loyalty_rewards
       where program_id = v_p.id and is_active and points_cost is not null
       order by points_cost limit 1
    ), cand as (
      select m.id, m.points_balance, r.name, r.points_cost, r.value_cents
        from loyalty_members m cross join cheapest r
       where m.program_id = v_p.id and m.status = 'active' and m.holdout_bucket >= v_p.holdout_percent
         and m.points_balance >= r.points_cost
         and m.enrolled_at < v_now - make_interval(days => v_p.balance_reminder_days)
         and not exists (select 1 from loyalty_ledger l where l.member_id = m.id and l.reason = 'redeem'
                          and l.occurred_at >= v_now - make_interval(days => v_p.balance_reminder_days))
    )
    select count(*) filter (where loyalty_emit_event(c.id, 'balance_reminder', 'balance_reminder:' || c.id || ':' || v_slot,
             jsonb_build_object('reward', c.name, 'points_cost', c.points_cost, 'reward_value_cents', c.value_cents,
                                'rewards_affordable', c.points_balance / c.points_cost)))
      into v_n from cand c;
    v_bal := v_bal + v_n;

    -- campaign_started (0214)
    for v_c in
      select * from loyalty_campaigns
       where program_id = v_p.id and is_active and announce and announced_at is null
         and starts_at <= v_now and ends_at > v_now
       for update skip locked
    loop
      select count(*) filter (where loyalty_emit_event(m.id, 'campaign_started', 'campaign_started:' || v_c.id || ':' || m.id,
               jsonb_build_object('campaign', v_c.name, 'campaign_key', v_c.key, 'kind', v_c.kind,
                                  'multiplier', v_c.multiplier, 'flat_points', v_c.flat_points,
                                  'starts_at', v_c.starts_at, 'ends_at', v_c.ends_at,
                                  'ends_on', to_char(v_c.ends_at at time zone v_p.timezone, 'FMMonth FMDD'))))
        into v_n
        from loyalty_members m
       where m.program_id = v_p.id and m.status = 'active' and m.holdout_bucket >= v_p.holdout_percent;
      update loyalty_campaigns set announced_at = v_now where id = v_c.id;
      v_camp := v_camp + v_n;
    end loop;

    -- challenge_started: once per challenge, to every treated member.
    for v_ch in
      select * from loyalty_challenges
       where program_id = v_p.id and is_active and announce and announced_at is null
         and starts_at <= v_now and ends_at > v_now
       for update skip locked
    loop
      select count(*) filter (where loyalty_emit_event(m.id, 'challenge_started', 'challenge_started:' || v_ch.id || ':' || m.id,
               jsonb_build_object('challenge', v_ch.name, 'challenge_key', v_ch.key, 'description', v_ch.description,
                                  'kind', v_ch.kind, 'target', v_ch.target, 'points', v_ch.points,
                                  'ends_at', v_ch.ends_at, 'ends_on', to_char(v_ch.ends_at at time zone v_p.timezone, 'FMMonth FMDD'))))
        into v_n
        from loyalty_members m
       where m.program_id = v_p.id and m.status = 'active' and m.holdout_bucket >= v_p.holdout_percent;
      update loyalty_challenges set announced_at = v_now where id = v_ch.id;
      v_chs := v_chs + v_n;
    end loop;

    -- streak_ending: the last 7 days of the month, a 2+ month streak, no order yet this month.
    if (date_trunc('month', v_local) + interval '1 month')::date - v_local::date <= 7 then
      with cand as (
        select m.id, loyalty_member_streak(m.id, v_now) s
          from loyalty_members m
         where m.program_id = v_p.id and m.status = 'active' and m.holdout_bucket >= v_p.holdout_percent
           and m.last_order_at >= date_trunc('month', v_local - interval '1 month') at time zone v_p.timezone
      )
      select count(*) filter (where loyalty_emit_event(c.id, 'streak_ending', 'streak_ending:' || c.id || ':' || v_month,
               jsonb_build_object('streak_months', (c.s->>'months')::int, 'keep_by', c.s->>'keep_by',
                                  'keep_by_text', to_char((c.s->>'keep_by')::date, 'FMMonth FMDD'))))
        into v_n
        from cand c
       where (c.s->>'months')::int >= 2 and not (c.s->>'this_month')::boolean;
      v_streak := v_streak + v_n;
    end if;
  end loop;

  return jsonb_build_object('near_tier', v_near, 'balance_reminder', v_bal, 'campaign_started', v_camp,
                            'challenge_started', v_chs, 'streak_ending', v_streak);
end;
$$;

-- loyalty_milestones_crossed, from 0200_loyalty_core
create or replace function loyalty_milestones_crossed(p_program uuid, p_from int, p_to int)
returns table (key text, points int, order_count int)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.key, r.points, r.order_count
    from loyalty_earn_rules r
   where r.program_id = p_program and r.kind = 'milestone' and r.is_active
     and r.order_count > p_from and r.order_count <= p_to
     and loyalty_plan_allows(p_program, 'milestones')
   order by r.order_count;
$$;

-- run_loyalty_jobs, from 0218_loyalty_joy_parity
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
    if v_prog.points_expire_after is not null and loyalty_plan_allows(v_prog.id, 'expiry') then
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
    if loyalty_plan_allows(v_prog.id, 'demotion') then
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
    end if;

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

-- loyalty_extension_state, from 0212_loyalty_nudges
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
  if not found or not loyalty_plan_allows(p_program, 'checkout_blocks') then
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

-- loyalty_staff_campaign_save, from 0223_loyalty_merchant_access
create or replace function loyalty_staff_campaign_save(p_program uuid, p_campaign uuid, p_fields jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := loyalty_require_manager(p_program);
  v_prog   loyalty_programs%rowtype;
  v_old    loyalty_campaigns%rowtype;
  v_id     uuid;
  v_name   text := nullif(trim(p_fields->>'name'), '');
  v_kind   text := p_fields->>'kind';
  v_starts timestamptz;
  v_ends   timestamptz;
  v_coll   text := nullif(trim(p_fields->>'collection_gid'), '');
  v_tag    text := nullif(trim(p_fields->>'product_tag'), '');
begin
  if not loyalty_plan_allows(p_program, 'growth') then
    raise exception 'Bonus campaigns need the Growth plan or higher.';
  end if;
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  if v_name is null or length(v_name) > 80 then
    raise exception 'a name of up to 80 characters is required';
  end if;
  begin
    v_starts := (p_fields->>'starts_local')::timestamp at time zone v_prog.timezone;
    v_ends   := (p_fields->>'ends_local')::timestamp at time zone v_prog.timezone;
  exception when others then
    raise exception 'start and end must be dates and times';
  end;
  if v_starts is null or v_ends is null or v_ends <= v_starts then
    raise exception 'the end must be after the start';
  end if;
  if v_coll is not null and v_coll ~ '^[0-9]+$' then
    v_coll := 'gid://shopify/Collection/' || v_coll;   -- a bare id from the admin URL
  end if;
  if v_coll is not null and v_tag is not null then
    raise exception 'limit to a collection or a tag, not both';
  end if;

  if p_campaign is not null then
    select * into v_old from loyalty_campaigns where id = p_campaign and program_id = p_program for update;
    if not found then
      raise exception 'campaign not found';
    end if;
  end if;

  if v_old.id is not null and v_old.starts_at <= now() then
    -- Started: only name, end and announce.
    if v_kind is distinct from v_old.kind
       or nullif(p_fields->>'multiplier', '')::numeric is distinct from v_old.multiplier
       or nullif(p_fields->>'flat_points', '')::int is distinct from v_old.flat_points
       or coalesce(nullif(p_fields->>'min_scope_cents', '')::bigint, 1) is distinct from v_old.min_scope_cents
       or v_coll is distinct from v_old.collection_gid or v_tag is distinct from v_old.product_tag
       -- The form sends minutes; seconds on the stored start aren't a change.
       or date_trunc('minute', v_starts) is distinct from date_trunc('minute', v_old.starts_at) then
      raise exception 'this campaign has started: only its name, end and announcement can change';
    end if;
    if v_ends < now() then
      raise exception 'the end can''t be moved into the past';
    end if;
    update loyalty_campaigns
       set name = v_name, ends_at = v_ends, announce = coalesce((p_fields->>'announce')::boolean, announce)
     where id = v_old.id;
    v_id := v_old.id;
  elsif v_old.id is not null then
    update loyalty_campaigns
       set name = v_name, kind = v_kind,
           multiplier = case when v_kind = 'multiplier' then nullif(p_fields->>'multiplier', '')::numeric end,
           flat_points = case when v_kind = 'flat' then nullif(p_fields->>'flat_points', '')::int end,
           min_scope_cents = coalesce(nullif(p_fields->>'min_scope_cents', '')::bigint, 1),
           starts_at = v_starts, ends_at = v_ends, collection_gid = v_coll, product_tag = v_tag,
           announce = coalesce((p_fields->>'announce')::boolean, true)
     where id = v_old.id;
    v_id := v_old.id;
  else
    if v_starts < now() - interval '5 minutes' then
      raise exception 'a new campaign can''t start in the past';
    end if;
    insert into loyalty_campaigns (program_id, key, name, kind, multiplier, flat_points, min_scope_cents,
                                   starts_at, ends_at, collection_gid, product_tag, announce, created_by)
    values (p_program,
            coalesce(nullif(p_fields->>'key', ''),
                     left(trim(both '_' from regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g')), 40) || '_' || to_char(v_starts at time zone v_prog.timezone, 'YYYYMMDD')),
            v_name, v_kind,
            case when v_kind = 'multiplier' then nullif(p_fields->>'multiplier', '')::numeric end,
            case when v_kind = 'flat' then nullif(p_fields->>'flat_points', '')::int end,
            coalesce(nullif(p_fields->>'min_scope_cents', '')::bigint, 1),
            v_starts, v_ends, v_coll, v_tag, coalesce((p_fields->>'announce')::boolean, true), v_email)
    returning id into v_id;
  end if;

  perform loyalty_log_access('campaign_save', p_program, null, jsonb_build_object(
    'campaign_id', v_id, 'created', v_old.id is null, 'fields', p_fields));
  return v_id;
end;
$$;

-- loyalty_staff_challenge_save, from 0223_loyalty_merchant_access
create or replace function loyalty_staff_challenge_save(p_program uuid, p_challenge uuid, p_fields jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := loyalty_require_manager(p_program);
  v_prog   loyalty_programs%rowtype;
  v_old    loyalty_challenges%rowtype;
  v_id     uuid;
  v_name   text := nullif(trim(p_fields->>'name'), '');
  v_desc   text := nullif(trim(p_fields->>'description'), '');
  v_kind   text := p_fields->>'kind';
  v_target bigint := nullif(p_fields->>'target', '')::bigint;
  v_points int := nullif(p_fields->>'points', '')::int;
  v_starts timestamptz;
  v_ends   timestamptz;
  v_coll   text := nullif(trim(p_fields->>'collection_gid'), '');
  v_tag    text := nullif(trim(p_fields->>'product_tag'), '');
begin
  if not loyalty_plan_allows(p_program, 'growth') then
    raise exception 'Challenges need the Growth plan or higher.';
  end if;
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  if v_name is null or length(v_name) > 80 then
    raise exception 'a name of up to 80 characters is required';
  end if;
  if v_desc is not null and length(v_desc) > 200 then
    raise exception 'keep the description to 200 characters';
  end if;
  begin
    v_starts := (p_fields->>'starts_local')::timestamp at time zone v_prog.timezone;
    v_ends   := (p_fields->>'ends_local')::timestamp at time zone v_prog.timezone;
  exception when others then
    raise exception 'start and end must be dates and times';
  end;
  if v_starts is null or v_ends is null or v_ends <= v_starts then
    raise exception 'the end must be after the start';
  end if;
  if v_coll is not null and v_coll ~ '^[0-9]+$' then
    v_coll := 'gid://shopify/Collection/' || v_coll;
  end if;
  if v_kind = 'tagged_product' and v_coll is null and v_tag is null then
    raise exception 'a tagged-product challenge needs a tag or a collection';
  end if;
  if v_kind <> 'tagged_product' then
    v_coll := null;
    v_tag := null;
  end if;
  if v_coll is not null and v_tag is not null then
    raise exception 'limit to a collection or a tag, not both';
  end if;
  if v_target is null or v_target <= 0 or v_points is null or v_points <= 0 or v_points > 100000 then
    raise exception 'the target and the points must be above zero (points up to 100,000)';
  end if;

  if p_challenge is not null then
    select * into v_old from loyalty_challenges where id = p_challenge and program_id = p_program for update;
    if not found then
      raise exception 'challenge not found';
    end if;
  end if;

  if v_old.id is not null and v_old.starts_at <= now() then
    if v_kind is distinct from v_old.kind or v_target is distinct from v_old.target or v_points is distinct from v_old.points
       or v_coll is distinct from v_old.collection_gid or v_tag is distinct from v_old.product_tag
       or date_trunc('minute', v_starts) is distinct from date_trunc('minute', v_old.starts_at) then
      raise exception 'this challenge has started: only its name, description, end and announcement can change';
    end if;
    if v_ends < now() then
      raise exception 'the end can''t be moved into the past';
    end if;
    update loyalty_challenges
       set name = v_name, description = v_desc, ends_at = v_ends,
           announce = coalesce((p_fields->>'announce')::boolean, announce)
     where id = v_old.id;
    v_id := v_old.id;
  elsif v_old.id is not null then
    update loyalty_challenges
       set name = v_name, description = v_desc, kind = v_kind, target = v_target, points = v_points,
           starts_at = v_starts, ends_at = v_ends, collection_gid = v_coll, product_tag = v_tag,
           announce = coalesce((p_fields->>'announce')::boolean, true)
     where id = v_old.id;
    v_id := v_old.id;
  else
    if v_starts < now() - interval '5 minutes' then
      raise exception 'a new challenge can''t start in the past';
    end if;
    insert into loyalty_challenges (program_id, key, name, description, kind, target, points, starts_at, ends_at,
                                    collection_gid, product_tag, announce, created_by)
    values (p_program,
            left(trim(both '_' from regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g')), 40) || '_' || to_char(v_starts at time zone v_prog.timezone, 'YYYYMMDD'),
            v_name, v_desc, v_kind, v_target, v_points, v_starts, v_ends, v_coll, v_tag,
            coalesce((p_fields->>'announce')::boolean, true), v_email)
    returning id into v_id;
  end if;

  perform loyalty_log_access('challenge_save', p_program, null, jsonb_build_object(
    'challenge_id', v_id, 'created', v_old.id is null, 'fields', p_fields));
  return v_id;
end;
$$;

-- loyalty_staff_insights, from 0223_loyalty_merchant_access
create or replace function loyalty_staff_insights(p_program uuid, p_from date, p_to date, p_bucket text default 'week')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog   loyalty_programs%rowtype;
  v_step   interval;
  v_margin numeric;
  v_series jsonb;
begin
  perform loyalty_require_manager(p_program);
  if not loyalty_is_staff() and not loyalty_plan_allows(p_program, 'insights') then
    raise exception 'Results need the Growth plan or higher.';
  end if;
  if p_bucket not in ('week', 'month') then
    raise exception 'bucket must be week or month';
  end if;
  if p_to - p_from > 731 then
    raise exception 'period is limited to 2 years';
  end if;
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  v_step   := ('1 ' || p_bucket)::interval;
  v_margin := v_prog.gross_margin_pct / 100.0;

  -- One pass for every bucket (weeks start Monday), clipped to the period.
  -- Value per member = (revenue x margin - reward cost) / members, the same
  -- figure loyalty_insights averages per member.
  with b as (
    select greatest(gs::date, p_from) f, least((gs + v_step)::date, p_to) t
      from generate_series(date_trunc(p_bucket, p_from::timestamp), (p_to - 1)::timestamp, v_step) gs
  ), bt as (
    select f, t, f::timestamp at time zone v_prog.timezone fts, t::timestamp at time zone v_prog.timezone tts from b
  ), mem as (
    select m.id, m.enrolled_at,
           case when m.holdout_bucket < v_prog.holdout_percent then 'holdout' else 'treatment' end grp
      from loyalty_members m where m.program_id = p_program and m.status = 'active'
  ), per as (
    select bt.f, bt.t, g.grp,
           (select count(*) from mem where mem.grp = g.grp and mem.enrolled_at < bt.tts) members,
           (select count(*) from loyalty_orders o join mem on mem.id = o.member_id and mem.grp = g.grp
             where o.program_id = p_program and o.processed_at >= bt.fts and o.processed_at < bt.tts) orders,
           (select coalesce(sum(o.eligible_cents - o.refunded_cents), 0) from loyalty_orders o join mem on mem.id = o.member_id and mem.grp = g.grp
             where o.program_id = p_program and o.processed_at >= bt.fts and o.processed_at < bt.tts) rev,
           (select coalesce(sum(c.value_cents), 0) from loyalty_discount_codes c join mem on mem.id = c.member_id and mem.grp = g.grp
             where c.program_id = p_program and c.status = 'used' and c.referral_id is null
               and c.used_at >= bt.fts and c.used_at < bt.tts) cost,
           (select coalesce(sum(l.points), 0) from loyalty_ledger l where l.program_id = p_program and l.occurred_at < bt.tts) liab
      from bt cross join (values ('treatment'), ('holdout')) g(grp)
  )
  select coalesce(jsonb_agg(x.j order by x.f), '[]'::jsonb) into v_series
    from (select f, jsonb_build_object(
            'from', f, 'to', t,
            'treatment_revenue_per_member_cents', round(max(rev::numeric / nullif(members, 0)) filter (where grp = 'treatment'), 2),
            'holdout_revenue_per_member_cents',   round(max(rev::numeric / nullif(members, 0)) filter (where grp = 'holdout'), 2),
            'treatment_value_per_member_cents',   round(max((case when v_margin is null then rev else rev * v_margin end - cost)
                                                            / nullif(members, 0)) filter (where grp = 'treatment'), 2),
            'holdout_value_per_member_cents',     round(max((case when v_margin is null then rev else rev * v_margin end - cost)
                                                            / nullif(members, 0)) filter (where grp = 'holdout'), 2),
            'orders', sum(orders), 'revenue_cents', sum(rev), 'liability_points', max(liab)) j
            from per group by f, t) x;

  return jsonb_build_object('summary', loyalty_insights(p_program, p_from, p_to), 'series', v_series);
end;
$$;

-- loyalty_staff_insights_detail, from 0223_loyalty_merchant_access
create or replace function loyalty_staff_insights_detail(p_program uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform loyalty_require_manager(p_program);
  if not loyalty_is_staff() and not loyalty_plan_allows(p_program, 'insights') then
    raise exception 'Results need the Growth plan or higher.';
  end if;
  if p_to - p_from > 731 then
    raise exception 'period is limited to 2 years';
  end if;
  return loyalty_insights_detail(p_program, p_from, p_to);
end;
$$;
