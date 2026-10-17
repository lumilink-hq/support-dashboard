-- =============================================================================
-- test_loyalty_plans.sql — non-destructive test of 0224 (Phase 2 P3): plans,
-- feature gates, set-plan, order metering and the usage event outbox.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_plans.sql
--
-- To see it FAIL:
--   * drop the 'expiry' check in run_loyalty_jobs -> "free: no expiry" fails.
--   * drop the 'growth' check in loyalty_nudges_for -> "starter: no nudges" fails.
--   * drop "created_via = 'self_serve'" in loyalty_set_plan
--     -> "staff program: treatment_since left to staff" fails.
--   * drop "plan_source = 'shopify'" in loyalty_queue_usage_event
--     -> "staff-billed order queues nothing" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated;

create or replace function pg_temp.raises(p_sql text, p_like text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlerrm like p_like;
end;
$$;
grant execute on function pg_temp.raises(text, text) to authenticated;

do $$
declare
  v_staff  uuid := gen_random_uuid();
  v_owner  uuid := gen_random_uuid();
  v_cs     uuid;
  v_co     uuid;
  v_ps     uuid;   -- staff-made program
  v_pf     uuid;   -- self-serve program
  v_ms     uuid;
  v_mf     uuid;
  v_r      jsonb;
  v_n      int;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at) values
    (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now()),
    (v_owner, 'owner@plan-shop.example', '{"business_name":"Plan Shop"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  select gen_random_uuid(), u, 'test', 'totp', 'verified', now(), now(), 'x' from unnest(array[v_staff, v_owner]) u;
  select client_id into v_cs from users where id = v_staff;
  select client_id into v_co from users where id = v_owner;
  update users set role = 'admin' where id = v_owner;

  -- 1. Defaults: a staff-made program is pro, a self-serve one free.
  insert into loyalty_programs (client_id, shop_domain, name, points_expire_after, demote_after_inactive, timezone)
  values (v_cs, 'plan-staff.myshopify.com', 'Staff Rewards', '1 year', '6 months', 'UTC') returning id into v_ps;
  v_pf := loyalty_create_default_program('plan-self.myshopify.com', 'Plan Shop', 'UTC');
  update loyalty_programs set client_id = v_co, live_since = now() - interval '2 years' where id = v_pf;
  update loyalty_programs set live_since = now() - interval '2 years' where id = v_ps;
  if (select plan_key from loyalty_programs where id = v_ps) <> 'pro'
     or (select plan_key from loyalty_programs where id = v_pf) <> 'free' then
    raise exception 'FAIL default plans';
  end if;
  raise notice 'ok  staff-made program is pro, self-serve starts free';

  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_ps, 'bronze', 'Bronze', 0, 0), (v_ps, 'silver', 'Silver', 1, 50000);
  insert into loyalty_earn_rules (program_id, key, kind, points, order_count) values (v_ps, 'order_1', 'milestone', 100, 1);
  insert into t values ('staff', v_staff), ('owner', v_owner), ('ps', v_ps), ('pf', v_pf);

  -- 2. plan_allows.
  if loyalty_plan_allows(v_pf, 'expiry') or not loyalty_plan_allows(v_ps, 'growth')
     or loyalty_plan_allows(gen_random_uuid(), 'expiry') then
    raise exception 'FAIL plan_allows';
  end if;

  -- 3. Milestones and blocks: off on free.
  if exists (select 1 from loyalty_milestones_crossed(v_pf, 0, 1)) then
    raise exception 'FAIL free: no milestones';
  end if;
  if loyalty_extension_state(v_pf) is not null or loyalty_extension_state(v_ps) is null then
    raise exception 'FAIL blocks: free gets nothing, pro gets state';
  end if;
  raise notice 'ok  free: no milestones, no checkout blocks';

  -- 4. Expiry and demotion jobs: off on free, on for starter.
  v_mf := loyalty_enroll_member(v_pf, 501, 'old@plan.example', 'Old', 'Member');
  update loyalty_members set points_balance = 400, last_activity_at = now() - interval '18 months',
         enrolled_at = now() - interval '2 years 100 days', tier_key = 'silver', last_order_at = now() - interval '18 months'
   where id = v_mf;
  perform run_loyalty_jobs(now());
  if (select points_balance from loyalty_members where id = v_mf) <> 400
     or (select tier_key from loyalty_members where id = v_mf) <> 'silver' then
    raise exception 'FAIL free: no expiry, no demotion';
  end if;
  raise notice 'ok  free: no expiry, no demotion';

  perform loyalty_set_plan(v_pf, 'starter', 'staff');
  perform run_loyalty_jobs(now());
  if (select points_balance from loyalty_members where id = v_mf) <> 0
     or (select tier_key from loyalty_members where id = v_mf) <> 'bronze' then
    raise exception 'FAIL starter: expiry and demotion run (% %)',
      (select points_balance from loyalty_members where id = v_mf), (select tier_key from loyalty_members where id = v_mf);
  end if;
  if exists (select 1 from loyalty_milestones_crossed(v_pf, 0, 1)) is not true then
    raise exception 'FAIL starter: milestones on';
  end if;
  raise notice 'ok  starter: expiry, demotion, milestones run';

  -- 5. Growth: nudges need it, and moving a self-serve program onto it starts treatment.
  update loyalty_programs set holdout_percent = 0, treatment_since = now() - interval '1 day' where id = v_pf;
  if loyalty_nudges_for(v_mf) then
    raise exception 'FAIL starter: no nudges';
  end if;
  update loyalty_programs set treatment_since = null where id = v_pf;
  v_r := loyalty_set_plan(v_pf, 'growth', 'staff');
  if (select treatment_since from loyalty_programs where id = v_pf) is null or not loyalty_nudges_for(v_mf)
     or v_r->>'from' <> 'starter' or v_r->>'to' <> 'growth' then
    raise exception 'FAIL growth on a self-serve program starts treatment: %', v_r;
  end if;
  perform loyalty_set_plan(v_ps, 'growth', 'staff');
  if (select treatment_since from loyalty_programs where id = v_ps) is not null then
    raise exception 'FAIL staff program: treatment_since left to staff';
  end if;
  raise notice 'ok  growth: nudges on, self-serve treatment starts, staff program untouched';
  if not pg_temp.raises(format('select loyalty_set_plan(%L, %L, %L)', v_pf, 'platinum', 'staff'), 'unknown plan%')
     or not pg_temp.raises(format('select loyalty_set_plan(%L, %L, %L)', v_pf, 'pro', 'stripe'), 'plan source%') then
    raise exception 'FAIL set_plan validation';
  end if;

  -- 6. Usage events: only live orders on a shopify-billed program, once each.
  v_ms := loyalty_enroll_member(v_ps, 601, 'buyer@plan.example', 'Bea', 'Buyer');
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, spend_counted, source, processed_at)
  values (v_ps, 9001, v_ms, 1000, true, 'webhook', now());
  if exists (select 1 from loyalty_usage_events where program_id = v_ps) then
    raise exception 'FAIL staff-billed order queues nothing';
  end if;
  perform loyalty_set_plan(v_pf, 'starter', 'shopify');
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, spend_counted, source, processed_at) values
    (v_pf, 9101, v_mf, 1000, true, 'webhook', now()),
    (v_pf, 9102, v_mf, 1000, true, 'backfill', now() - interval '1 year');
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, spend_counted, source, processed_at)
  values (v_pf, 9101, v_mf, 1000, true, 'webhook', now()) on conflict do nothing;
  select count(*) into v_n from loyalty_usage_events where program_id = v_pf;
  if v_n <> 1 or (select shopify_order_id from loyalty_usage_events where program_id = v_pf) <> 9101 then
    raise exception 'FAIL shopify-billed: one event per live order (got %)', v_n;
  end if;
  raise notice 'ok  usage events: live orders on shopify-billed programs only, once each';

  -- 7. billing_mark: retries, then failed after 5.
  for v_n in 1..4 loop
    perform loyalty_billing_mark((select id from loyalty_usage_events where program_id = v_pf), false, 'HTTP 500');
  end loop;
  if (select status from loyalty_usage_events where program_id = v_pf) <> 'pending' then
    raise exception 'FAIL still pending after 4';
  end if;
  perform loyalty_billing_mark((select id from loyalty_usage_events where program_id = v_pf), false, 'HTTP 500');
  if (select status from loyalty_usage_events where program_id = v_pf) <> 'failed' then
    raise exception 'FAIL failed after 5';
  end if;
  raise notice 'ok  billing_mark: pending until 5 failures, then failed';

  -- 8. billing_due: no public app connected -> no app, no credentials.
  v_r := loyalty_billing_due(v_pf);
  if v_r->>'app_client_id' is not null or v_r->>'credentials' is not null then
    raise exception 'FAIL billing_due without a public app: %', v_r;
  end if;
  perform vault.create_secret('{"client_id":"public-app-1","client_secret":"pub"}', 'test-ll-public');
  insert into loyalty_apps (app_client_id, label, distribution, self_serve, app_secret_ref, scopes, partner_app_gid)
  values ('public-app-1', 'LL Loyalty public (test)', 'public', true, 'test-ll-public', 'read_orders', 'gid://shopify/App/1');
  insert into loyalty_shopify_apps (shop_domain, app_client_id, program_id, app_secret_ref, token_ref, connected_at)
  values ('plan-self.myshopify.com', 'public-app-1', v_pf, 'test-ll-public', 'x', now());
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, spend_counted, source, processed_at)
  values (v_pf, 9103, v_mf, 1000, true, 'webhook', now());
  v_r := loyalty_billing_due(v_pf);
  if v_r->>'app_client_id' <> 'public-app-1' or v_r->>'partner_app_gid' <> 'gid://shopify/App/1'
     or v_r->>'credentials' not like '%"pub"%' or jsonb_array_length(v_r->'events') <> 1 then
    raise exception 'FAIL billing_due with a public app: %', v_r;
  end if;
  raise notice 'ok  billing_due: public app credentials and pending events only';

  -- 9. Usage: this month, against the plan.
  v_r := loyalty_plan_usage(v_pf);
  if (v_r->>'orders')::int <> 2 or (v_r->>'included_orders')::int <> 750 or (v_r->>'over_cap')::boolean then
    raise exception 'FAIL plan usage: %', v_r;
  end if;
  update loyalty_plans set included_orders = 1 where key = 'starter';
  if not (loyalty_plan_usage(v_pf)->>'over_cap')::boolean then
    raise exception 'FAIL over cap';
  end if;
  update loyalty_plans set included_orders = 750 where key = 'starter';
  raise notice 'ok  plan usage counts live orders this month';
end $$;

-- 10. As the merchant (starter): campaign console and insights refused, plan card readable.
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'owner'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_pf uuid := (select v from t where k = 'pf');
begin
  if not pg_temp.raises(format($q$select loyalty_staff_campaign_save(%L, null, '{"name":"x"}')$q$, v_pf), 'Bonus campaigns need the Growth plan%')
     or not pg_temp.raises(format($q$select loyalty_staff_challenge_save(%L, null, '{"name":"x"}')$q$, v_pf), 'Challenges need the Growth plan%')
     or not pg_temp.raises(format('select loyalty_staff_insights(%L, current_date - 30, current_date)', v_pf), 'Results need the Growth plan%')
     or not pg_temp.raises(format('select loyalty_staff_set_plan(%L, %L)', v_pf, 'pro'), 'not_staff') then
    raise exception 'FAIL merchant on starter: console, insights, set plan refused';
  end if;
  if loyalty_staff_plan(v_pf)->>'plan' <> 'starter' or jsonb_array_length(loyalty_staff_plan(v_pf)->'plans') <> 4 then
    raise exception 'FAIL merchant reads plan card';
  end if;
  raise notice 'ok  merchant on starter: campaigns, challenges, insights, set plan refused; plan card readable';
end $$;
reset role;

-- 11. Staff: insights always, set plan logged.
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_pf uuid := (select v from t where k = 'pf');
begin
  perform loyalty_staff_insights(v_pf, current_date - 30, current_date);
  perform loyalty_staff_set_plan(v_pf, 'pro');
end $$;
reset role;
do $$
begin
  if (select plan_key from loyalty_programs where id = (select v from t where k = 'pf')) <> 'pro'
     or not exists (select 1 from loyalty_access_log where action = 'plan_set' and program_id = (select v from t where k = 'pf')) then
    raise exception 'FAIL staff set plan logged';
  end if;
  if has_table_privilege('authenticated', 'loyalty_plans', 'select')
     or has_table_privilege('authenticated', 'loyalty_usage_events', 'select')
     or has_function_privilege('authenticated', 'loyalty_set_plan(uuid, text, text)', 'execute') then
    raise exception 'FAIL privileges';
  end if;
  raise notice 'ok  staff: insights on any plan, set plan logged; tables service role only';
end $$;

rollback;
