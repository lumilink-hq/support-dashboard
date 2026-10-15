-- =============================================================================
-- 0214_loyalty_automations.sql — Phase 1b module 12: bonus campaigns and the
-- new Klaviyo automations (plan §6). Builds on 0200-0213.
--
-- TREATMENT ONLY. Everything here is a Phase 1b feature: nothing happens for
-- a holdout member, and nothing happens at all until the program's
-- treatment_since has passed (loyalty_nudges_for, 0212). The three new event
-- kinds are also added to holdout_suppressed_kinds, so even a direct emit
-- never reaches the holdout.
--
-- BONUS CAMPAIGNS (loyalty_campaigns). A date window and either
--   multiplier  extra points = order points at the member's tier x (multiplier - 1)
--   flat        flat_points once, when the order has min_scope_cents in scope
-- Scope is the whole order, or the products of a Shopify collection or tag:
-- loyalty-shopify resolves those into loyalty_campaign_products (refreshed
-- daily while the campaign is upcoming or running). A scoped campaign whose
-- products aren't resolved yet awards nothing, so create scoped campaigns at
-- least an hour before they start.
-- loyalty_apply_campaigns(program, order) runs after loyalty_record_order on
-- every orders/paid delivery (retries included; one award per campaign per
-- order). The bonus is a ledger 'action' entry (rule_key 'campaign:<key>')
-- and is added to the order's points_earned, so a refund claws it back in
-- proportion like the base points (0201).
--
-- EVENTS (run_loyalty_automations, hourly at :17):
--   near_tier         spend within near_tier_percent (15) of the next tier;
--                     once per tier per quarter
--   balance_reminder  balance covers a reward and nothing redeemed for
--                     balance_reminder_days (30); at most once per that period
--   campaign_started  each treated member when a campaign with announce = true
--                     starts; once per campaign
-- Default Klaviyo names 'LL: Near Tier', 'LL: Balance Reminder',
-- 'LL: Bonus Campaign' (new flows; Joy had none of these).
--
-- PROFILE PROPERTIES for Klaviyo-side flows (tier-at-risk on segment TenXzZ,
-- win-back per tier): 'LL Group' (treatment / holdout: flows filter on it so
-- the holdout gets none of them), 'LL Next Tier', 'LL Spend To Next Tier'
-- (dollars), 'LL Demotion Date' (YYYY-MM-DD the member drops a tier with no
-- new order; null at the entry tier).
--
-- Campaign results in the staff console are module 14.
-- Test: scripts/test_loyalty_automations.sql. Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
alter table loyalty_programs add column if not exists near_tier_percent int not null default 15;
alter table loyalty_programs drop constraint if exists loyalty_programs_near_tier_percent_check;
alter table loyalty_programs add constraint loyalty_programs_near_tier_percent_check check (near_tier_percent between 1 and 50);
alter table loyalty_programs add column if not exists balance_reminder_days int not null default 30;
alter table loyalty_programs drop constraint if exists loyalty_programs_balance_reminder_days_check;
alter table loyalty_programs add constraint loyalty_programs_balance_reminder_days_check check (balance_reminder_days between 7 and 365);

-- New kinds never reach the holdout (0211's list), for existing and new programs.
alter table loyalty_programs alter column holdout_suppressed_kinds set default '{near_tier,balance_reminder,campaign_started}';
update loyalty_programs
   set holdout_suppressed_kinds = array(select distinct k from unnest(holdout_suppressed_kinds || '{near_tier,balance_reminder,campaign_started}'::text[]) k order by k)
 where not holdout_suppressed_kinds @> '{near_tier,balance_reminder,campaign_started}';

-- Klaviyo names: add the new keys, keeping any name already set.
alter table loyalty_programs alter column klaviyo_names set default jsonb_build_object(
  'prop_tier',              'Joy Vip tier',
  'prop_status',            'Joy member status',
  'prop_points',            'Joy Loyalty Points',
  'prop_referral_url',      'Joy Referral URL',
  'prop_birthday',          jsonb_build_array('Birthday', 'dateOfBirth'),
  'prop_group',             'LL Group',
  'prop_next_tier',         'LL Next Tier',
  'prop_to_next_tier',      'LL Spend To Next Tier',
  'prop_demotion_date',     'LL Demotion Date',
  'status_active',          'member',
  'status_excluded',        'excluded',
  'event_reward_eligible',  'Joy: Points Eligible Reward',
  'event_tier_down',        'Joy: Tier Downgrade',
  'event_pre_birthday',     'Joy: 7 Days Pre Birthday',
  'event_birthday',         'Joy: Birthday',
  'event_tier_up',          null,
  'event_milestone',        null,
  'event_demotion_warning', null,
  'event_near_tier',        'LL: Near Tier',
  'event_balance_reminder', 'LL: Balance Reminder',
  'event_campaign_started', 'LL: Bonus Campaign');
update loyalty_programs
   set klaviyo_names = jsonb_build_object(
         'prop_group',             'LL Group',
         'prop_next_tier',         'LL Next Tier',
         'prop_to_next_tier',      'LL Spend To Next Tier',
         'prop_demotion_date',     'LL Demotion Date',
         'event_near_tier',        'LL: Near Tier',
         'event_balance_reminder', 'LL: Balance Reminder',
         'event_campaign_started', 'LL: Bonus Campaign') || klaviyo_names
 where not klaviyo_names ? 'event_near_tier';

alter table loyalty_events drop constraint if exists loyalty_events_kind_check;
alter table loyalty_events add constraint loyalty_events_kind_check check (kind in (
  'demotion_warning', 'pre_birthday', 'birthday', 'tier_up', 'tier_down', 'milestone', 'reward_eligible',
  'near_tier', 'balance_reminder', 'campaign_started'));

-- -----------------------------------------------------------------------------
-- Campaigns
-- -----------------------------------------------------------------------------
create table if not exists loyalty_campaigns (
  id                    uuid        primary key default gen_random_uuid(),
  program_id            uuid        not null references loyalty_programs(id) on delete cascade,
  key                   text        not null check (key ~ '^[a-z0-9_]+$'),
  name                  text        not null,                  -- customer-facing, e.g. 'Double points on new arrivals'
  kind                  text        not null check (kind in ('multiplier', 'flat')),
  multiplier            numeric(4,2) check (multiplier > 1 and multiplier <= 10),
  flat_points           int         check (flat_points > 0),
  min_scope_cents       bigint      not null default 1 check (min_scope_cents >= 1),
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  collection_gid        text        check (collection_gid ~ '^gid://shopify/Collection/[0-9]+$'),
  product_tag           text        check (length(product_tag) between 1 and 255),
  announce              boolean     not null default true,      -- campaign_started event at start
  is_active             boolean     not null default true,      -- false = paused / cancelled
  products_resolved_at  timestamptz,
  products_error        text,
  announced_at          timestamptz,
  created_by            text        not null default 'system',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (program_id, key),
  check (ends_at > starts_at),
  check ((kind = 'multiplier' and multiplier is not null and flat_points is null)
      or (kind = 'flat' and flat_points is not null and multiplier is null)),
  check (collection_gid is null or product_tag is null)
);

create index if not exists idx_loyalty_campaigns_window on loyalty_campaigns(program_id, starts_at, ends_at) where is_active;

drop trigger if exists trg_loyalty_campaigns_updated_at on loyalty_campaigns;
create trigger trg_loyalty_campaigns_updated_at
  before update on loyalty_campaigns
  for each row execute function set_updated_at();

-- A scope change means the resolved products are stale.
create or replace function loyalty_campaign_scope_changed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.collection_gid is distinct from old.collection_gid or new.product_tag is distinct from old.product_tag then
    new.products_resolved_at := null;
    delete from loyalty_campaign_products where campaign_id = new.id;
  end if;
  return new;
end;
$$;

create table if not exists loyalty_campaign_products (
  campaign_id  uuid   not null references loyalty_campaigns(id) on delete cascade,
  product_id   bigint not null check (product_id > 0),
  primary key (campaign_id, product_id)
);

drop trigger if exists trg_loyalty_campaign_scope on loyalty_campaigns;
create trigger trg_loyalty_campaign_scope
  before update on loyalty_campaigns
  for each row execute function loyalty_campaign_scope_changed();

alter table loyalty_campaigns         enable row level security;
alter table loyalty_campaign_products enable row level security;
revoke all on loyalty_campaigns, loyalty_campaign_products from anon, authenticated;
grant select, insert, update, delete on loyalty_campaigns, loyalty_campaign_products to service_role;

-- loyalty_campaign_scope_cents — the part of an order a campaign covers.
-- p_lines: [{product_id, cents}] (line totals after discounts). Unscoped =
-- the whole eligible amount. Never more than the order's eligible amount.
create or replace function loyalty_campaign_scope_cents(p_campaign uuid, p_lines jsonb, p_eligible bigint)
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when c.collection_gid is null and c.product_tag is null then greatest(p_eligible, 0)
    when c.products_resolved_at is null then 0
    else least(greatest(p_eligible, 0), coalesce((
      select sum(greatest((l->>'cents')::bigint, 0))
        from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
       where (l->>'product_id') ~ '^[0-9]{1,19}$'
         and exists (select 1 from loyalty_campaign_products cp
                      where cp.campaign_id = c.id and cp.product_id = (l->>'product_id')::bigint)), 0))
  end
  from loyalty_campaigns c where c.id = p_campaign;
$$;

-- loyalty_apply_campaigns — after loyalty_record_order, for a live order.
-- p_order: the webhook's order ({id, processed_at, eligible_cents, line_items}).
-- Returns the bonus points awarded by this call (0 on a retry).
create or replace function loyalty_apply_campaigns(p_program uuid, p_order jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_o       loyalty_orders%rowtype;
  v_prog    loyalty_programs%rowtype;
  v_mult    numeric;
  v_c       loyalty_campaigns%rowtype;
  v_scope   bigint;
  v_points  int;
  v_r       jsonb;
  v_total   int := 0;
begin
  select * into v_o from loyalty_orders
   where program_id = p_program and shopify_order_id = (p_order->>'id')::bigint and source = 'webhook'
   for update;
  if not found or not loyalty_nudges_for(v_o.member_id) then
    return 0;   -- not a member's live order, holdout, or Phase 1b not live
  end if;
  select * into v_prog from loyalty_programs where id = p_program;
  select t.earn_multiplier into v_mult
    from loyalty_members m join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
   where m.id = v_o.member_id;

  for v_c in
    select * from loyalty_campaigns
     where program_id = p_program and is_active and starts_at <= v_o.processed_at and ends_at > v_o.processed_at
     order by starts_at, key
  loop
    v_scope := loyalty_campaign_scope_cents(v_c.id, p_order->'line_items', v_o.eligible_cents);
    v_points := case
      when v_c.kind = 'multiplier' then floor(v_scope * v_prog.points_per_dollar * v_mult * (v_c.multiplier - 1) / 100)::int
      when v_scope >= v_c.min_scope_cents then v_c.flat_points
      else 0 end;
    continue when v_points <= 0;
    v_r := loyalty_post_entry(
      v_o.member_id, v_points, 'action', 'campaign:' || v_c.id || ':' || v_o.shopify_order_id,
      0, 'campaign:' || v_c.key, 'shopify_order', v_o.shopify_order_id::text, v_c.name, 'system', v_o.processed_at);
    if not (v_r->>'duplicate')::boolean then
      update loyalty_orders set points_earned = points_earned + v_points
       where program_id = p_program and shopify_order_id = v_o.shopify_order_id;
      v_total := v_total + v_points;
    end if;
  end loop;
  return v_total;
end;
$$;

-- -----------------------------------------------------------------------------
-- Product resolution (loyalty-shopify)
-- -----------------------------------------------------------------------------

-- Scoped campaigns that are upcoming or running and unresolved, or resolved
-- more than a day ago.
create or replace function loyalty_campaigns_to_resolve(p_program uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'collection_gid', collection_gid, 'product_tag', product_tag)
                            order by products_resolved_at nulls first), '[]'::jsonb)
    from loyalty_campaigns
   where program_id = p_program and is_active and ends_at > now()
     and (collection_gid is not null or product_tag is not null)
     and (products_resolved_at is null or products_resolved_at < now() - interval '1 day')
     and (products_error is null or updated_at < now() - interval '15 minutes');
$$;

-- p_product_ids null = failed (p_error kept, old products kept).
create or replace function loyalty_campaign_resolved(p_campaign uuid, p_product_ids bigint[], p_error text default null)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_product_ids is null then
    update loyalty_campaigns set products_error = left(coalesce(p_error, 'unknown error'), 500) where id = p_campaign;
    return;
  end if;
  delete from loyalty_campaign_products where campaign_id = p_campaign and not (product_id = any (p_product_ids));
  insert into loyalty_campaign_products (campaign_id, product_id)
  select p_campaign, x from unnest(p_product_ids) x where x > 0
  on conflict do nothing;
  update loyalty_campaigns set products_resolved_at = now(), products_error = null where id = p_campaign;
end;
$$;

-- loyalty_shopify_has_work — 0212's, plus campaigns to resolve.
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
      or (select shopify_definitions_version < 2 from loyalty_programs where id = p_program)
      or jsonb_array_length(loyalty_campaigns_to_resolve(p_program)) > 0;
$$;

-- -----------------------------------------------------------------------------
-- Automations (hourly)
-- -----------------------------------------------------------------------------
create or replace function run_loyalty_automations(p_now timestamptz default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now   timestamptz := coalesce(p_now, now());
  v_p     loyalty_programs%rowtype;
  v_c     loyalty_campaigns%rowtype;
  v_near  int := 0;
  v_bal   int := 0;
  v_camp  int := 0;
  v_n     int;
  v_q     text;
  v_slot  bigint;
begin
  for v_p in
    select * from loyalty_programs where is_active and treatment_since is not null and treatment_since <= v_now
  loop
    v_q := to_char(v_now at time zone v_p.timezone, 'YYYY-"Q"Q');

    -- near_tier: within near_tier_percent of the next tier's threshold.
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

    -- balance_reminder: balance covers a reward, nothing redeemed in the period.
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

    -- campaign_started: once per campaign, to every treated member.
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
  end loop;

  return jsonb_build_object('near_tier', v_near, 'balance_reminder', v_bal, 'campaign_started', v_camp);
end;
$$;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — loyalty automations NOT scheduled. Enable it, then re-run this migration.';
    return;
  end if;
  begin
    perform cron.unschedule('loyalty-automations');
  exception when others then
    null;
  end;
  perform cron.schedule('loyalty-automations', '17 * * * *', $cron$select run_loyalty_automations();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- Profile properties: 0205's, plus group, next tier, spend to it, demotion date.
-- -----------------------------------------------------------------------------
create or replace function loyalty_klaviyo_properties(p_member uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_m     loyalty_members%rowtype;
  v_p     loyalty_programs%rowtype;
  v_t     loyalty_tiers%rowtype;
  v_next  loyalty_tiers%rowtype;
  v_n     jsonb;
  v_props jsonb := '{}'::jsonb;
  v_bday  text;
  v_name  text;
begin
  select * into v_m from loyalty_members where id = p_member;
  select * into v_p from loyalty_programs where id = v_m.program_id;
  select * into v_t from loyalty_tiers where program_id = v_m.program_id and key = v_m.tier_key;
  select * into v_next from loyalty_tiers where program_id = v_m.program_id and rank > v_t.rank order by rank limit 1;
  v_n := v_p.klaviyo_names;

  if v_n->>'prop_tier' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_tier', v_t.name);
  end if;
  if v_n->>'prop_points' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_points', v_m.points_balance);
  end if;
  if v_n->>'prop_status' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_status', v_n->>('status_' || v_m.status));
  end if;
  if v_n->>'prop_referral_url' is not null and v_p.rewards_page_url is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_referral_url', v_p.rewards_page_url || '?ref=' || v_m.referral_code);
  end if;
  if v_m.birthday is not null and jsonb_typeof(v_n->'prop_birthday') = 'array' then
    v_bday := to_char(v_m.birthday, 'MM/DD/YYYY');
    for v_name in select jsonb_array_elements_text(v_n->'prop_birthday') loop
      v_props := v_props || jsonb_build_object(v_name, v_bday);
    end loop;
  end if;
  if v_n->>'prop_group' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_group',
      case when v_m.holdout_bucket < v_p.holdout_percent then 'holdout' else 'treatment' end);
  end if;
  if v_n->>'prop_next_tier' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_next_tier', v_next.name);
  end if;
  if v_n->>'prop_to_next_tier' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_to_next_tier',
      case when v_next.id is null then null else round(greatest(v_next.min_spend_cents - v_m.tier_spend_cents, 0) / 100.0, 2) end);
  end if;
  if v_n->>'prop_demotion_date' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_demotion_date',
      -- Same reference date as run_loyalty_jobs' demotion (0202).
      case when v_t.rank > (select min(rank) from loyalty_tiers where program_id = v_m.program_id)
           then to_char((coalesce(greatest(v_m.last_order_at, v_m.last_demoted_at), v_m.enrolled_at) + v_p.demote_after_inactive)
                        at time zone v_p.timezone, 'YYYY-MM-DD') end);
  end if;
  return v_props;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants: service role only.
-- -----------------------------------------------------------------------------
revoke execute on function loyalty_campaign_scope_changed() from public, anon, authenticated;
revoke execute on function loyalty_campaign_scope_cents(uuid, jsonb, bigint) from public, anon, authenticated;
revoke execute on function loyalty_apply_campaigns(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_campaigns_to_resolve(uuid) from public, anon, authenticated;
revoke execute on function loyalty_campaign_resolved(uuid, bigint[], text) from public, anon, authenticated;
revoke execute on function loyalty_shopify_has_work(uuid) from public, anon, authenticated;
revoke execute on function run_loyalty_automations(timestamptz) from public, anon, authenticated;
revoke execute on function loyalty_klaviyo_properties(uuid) from public, anon, authenticated;

grant execute on function loyalty_campaign_scope_cents(uuid, jsonb, bigint) to service_role;
grant execute on function loyalty_apply_campaigns(uuid, jsonb) to service_role;
grant execute on function loyalty_campaigns_to_resolve(uuid) to service_role;
grant execute on function loyalty_campaign_resolved(uuid, bigint[], text) to service_role;
grant execute on function loyalty_shopify_has_work(uuid) to service_role;
grant execute on function run_loyalty_automations(timestamptz) to service_role;
grant execute on function loyalty_klaviyo_properties(uuid) to service_role;
