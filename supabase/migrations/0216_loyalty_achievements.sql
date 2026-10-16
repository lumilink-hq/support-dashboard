-- =============================================================================
-- 0216_loyalty_achievements.sql — Phase 1b module 13: badges, the monthly
-- order streak and challenges (plan §6; the list was set by LumiLink on
-- 2026-10-15, Tsunami had none). Builds on 0200-0215.
--
-- TREATMENT ONLY, LIKE 0214. Nothing is earned, shown or sent for a holdout
-- member, or before treatment_since (loyalty_nudges_for, 0212). The four new
-- event kinds are in holdout_suppressed_kinds.
--
-- CATEGORIES = Shopify product type. Orders/paid line items (0214) are kept
-- per order (loyalty_order_lines); loyalty-shopify looks each new product's
-- type up once (loyalty_products, Admin API, read_products) and re-evaluates
-- the members who bought it. Lines exist only for live (webhook) orders, so
-- categories count from install on. A product without a type counts as none.
--
-- BADGES (loyalty_badges, seeded per program by loyalty_seed_default_badges):
--   explorer    'categories'    3 product types, all time               +200
--   big_basket  'big_order'     an order of $100+ after go-live          +150
--   on_a_roll   'month_streak'  ordered 3 calendar months in a row       +300
--   regular     'month_streak'  6 months in a row                        +600
--   ambassador  'referrals'     3 referred friends completed an order    +300
--   order_1/10/20/30 'milestone' display only: Joy's milestone awards
-- Streak and referral badges also need activity after go-live (an order /
-- a completed referral), so history alone pays nothing at launch.
-- A badge is earned once; its points are a ledger 'action' entry
-- (rule_key 'badge:<key>'), not tied to an order, so refunds don't claw it.
--
-- STREAK: consecutive store-local calendar months with an order that wasn't
-- fully refunded, counted back from this month (or last month while this
-- month is still open). streak_ending events go out in the last 7 days of a
-- month to treated members on a 2+ streak with no order yet this month.
--
-- CHALLENGES (loyalty_challenges, staff create them in the campaign console):
--   order_count     N orders in the window
--   spend           $target (cents) in the window, net of refunds
--   new_categories  N product types bought in the window that weren't bought before it
--   tagged_product  N orders in the window with a product from a tag or collection
--                   (resolved like campaign scopes, 0214)
-- Completion awards the points once ('challenge:<key>'); challenge_started is
-- announced at the start (announce = true), challenge_completed on completion.
--
-- EVALUATION: loyalty_evaluate_member(member) is idempotent and re-runnable.
-- loyalty_after_order (called by loyalty-webhooks after every orders/paid,
-- replacing the direct loyalty_apply_campaigns call) stores the lines, applies
-- campaigns, and evaluates the buyer and, if the order completed a referral,
-- the referrer.
--
-- Test: scripts/test_loyalty_achievements.sql. Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Event kinds, names, holdout
-- -----------------------------------------------------------------------------
alter table loyalty_events drop constraint if exists loyalty_events_kind_check;
alter table loyalty_events add constraint loyalty_events_kind_check check (kind in (
  'demotion_warning', 'pre_birthday', 'birthday', 'tier_up', 'tier_down', 'milestone', 'reward_eligible',
  'near_tier', 'balance_reminder', 'campaign_started',
  'badge_earned', 'challenge_started', 'challenge_completed', 'streak_ending'));

alter table loyalty_programs alter column holdout_suppressed_kinds set default
  '{badge_earned,balance_reminder,campaign_started,challenge_completed,challenge_started,near_tier,streak_ending}';
update loyalty_programs
   set holdout_suppressed_kinds = array(select distinct k from unnest(holdout_suppressed_kinds
         || '{badge_earned,challenge_started,challenge_completed,streak_ending}'::text[]) k order by k)
 where not holdout_suppressed_kinds @> '{badge_earned,challenge_started,challenge_completed,streak_ending}';

alter table loyalty_programs alter column klaviyo_names set default jsonb_build_object(
  'prop_tier',                  'Joy Vip tier',
  'prop_status',                'Joy member status',
  'prop_points',                'Joy Loyalty Points',
  'prop_referral_url',          'Joy Referral URL',
  'prop_birthday',              jsonb_build_array('Birthday', 'dateOfBirth'),
  'prop_group',                 'LL Group',
  'prop_next_tier',             'LL Next Tier',
  'prop_to_next_tier',          'LL Spend To Next Tier',
  'prop_demotion_date',         'LL Demotion Date',
  'status_active',              'member',
  'status_excluded',            'excluded',
  'event_reward_eligible',      'Joy: Points Eligible Reward',
  'event_tier_down',            'Joy: Tier Downgrade',
  'event_pre_birthday',         'Joy: 7 Days Pre Birthday',
  'event_birthday',             'Joy: Birthday',
  'event_tier_up',              null,
  'event_milestone',            null,
  'event_demotion_warning',     null,
  'event_near_tier',            'LL: Near Tier',
  'event_balance_reminder',     'LL: Balance Reminder',
  'event_campaign_started',     'LL: Bonus Campaign',
  'event_badge_earned',         'LL: Badge Earned',
  'event_challenge_started',    'LL: Challenge Started',
  'event_challenge_completed',  'LL: Challenge Completed',
  'event_streak_ending',        'LL: Streak Ending');
update loyalty_programs
   set klaviyo_names = jsonb_build_object(
         'event_badge_earned',        'LL: Badge Earned',
         'event_challenge_started',   'LL: Challenge Started',
         'event_challenge_completed', 'LL: Challenge Completed',
         'event_streak_ending',       'LL: Streak Ending') || klaviyo_names
 where not klaviyo_names ? 'event_badge_earned';

alter table loyalty_access_log drop constraint if exists loyalty_access_log_action_check;
alter table loyalty_access_log add constraint loyalty_access_log_action_check
  check (action in ('search', 'view', 'adjust', 'set_tier', 'set_birthday', 'data_requests', 'campaign_save', 'campaign_active',
                    'challenge_save', 'challenge_active'));

-- -----------------------------------------------------------------------------
-- Order lines + product categories
-- -----------------------------------------------------------------------------
create table if not exists loyalty_order_lines (
  program_id        uuid   not null references loyalty_programs(id) on delete cascade,
  shopify_order_id  bigint not null,
  member_id         uuid   not null references loyalty_members(id) on delete cascade,
  product_id        bigint not null check (product_id > 0),
  cents             bigint not null check (cents >= 0),
  primary key (program_id, shopify_order_id, product_id),
  foreign key (program_id, shopify_order_id) references loyalty_orders(program_id, shopify_order_id) on delete cascade
);
create index if not exists idx_loyalty_order_lines_member on loyalty_order_lines(member_id);
create index if not exists idx_loyalty_order_lines_product on loyalty_order_lines(program_id, product_id);

create table if not exists loyalty_products (
  program_id    uuid        not null references loyalty_programs(id) on delete cascade,
  product_id    bigint      not null check (product_id > 0),
  product_type  text        not null default '',     -- '' = none set, or the product was deleted
  fetched_at    timestamptz not null default now(),
  primary key (program_id, product_id)
);

-- -----------------------------------------------------------------------------
-- Badges
-- -----------------------------------------------------------------------------
create table if not exists loyalty_badges (
  id           uuid        primary key default gen_random_uuid(),
  program_id   uuid        not null references loyalty_programs(id) on delete cascade,
  key          text        not null check (key ~ '^[a-z0-9_]+$'),
  name         text        not null,
  description  text        not null,
  kind         text        not null check (kind in ('categories', 'big_order', 'month_streak', 'referrals', 'milestone')),
  threshold    bigint      not null default 1 check (threshold > 0),   -- count, cents (big_order), months
  points       int         not null default 0 check (points >= 0),
  rule_key     text,                                                  -- milestone: the earn rule it shows
  sort         int         not null default 0,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (program_id, key),
  check ((kind = 'milestone') = (rule_key is not null)),
  check (kind <> 'milestone' or points = 0)    -- the milestone award already paid
);

drop trigger if exists trg_loyalty_badges_updated_at on loyalty_badges;
create trigger trg_loyalty_badges_updated_at
  before update on loyalty_badges
  for each row execute function set_updated_at();

create table if not exists loyalty_member_badges (
  member_id   uuid        not null references loyalty_members(id) on delete cascade,
  badge_id    uuid        not null references loyalty_badges(id) on delete cascade,
  earned_at   timestamptz not null default now(),
  primary key (member_id, badge_id)
);

create or replace function loyalty_seed_default_badges(p_program uuid)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  insert into loyalty_badges (program_id, key, name, description, kind, threshold, points, sort) values
    (p_program, 'explorer',   'Explorer',   'Order from 3 different categories',          'categories',   3,     200, 10),
    (p_program, 'big_basket', 'Big basket', 'Place an order of $100 or more',             'big_order',    10000, 150, 20),
    (p_program, 'on_a_roll',  'On a roll',  'Order 3 months in a row',                    'month_streak', 3,     300, 30),
    (p_program, 'regular',    'Regular',    'Order 6 months in a row',                    'month_streak', 6,     600, 40),
    (p_program, 'ambassador', 'Ambassador', '3 friends you referred placed their first order', 'referrals', 3,   300, 50)
  on conflict (program_id, key) do nothing;
  -- Joy's order milestones, shown as badges (no extra points).
  insert into loyalty_badges (program_id, key, name, description, kind, threshold, points, rule_key, sort)
  select p_program, r.key,
         case when r.order_count = 1 then 'First order' else r.order_count || ' orders' end,
         case when r.order_count = 1 then 'Place your first order' else 'Place ' || r.order_count || ' orders' end,
         'milestone', r.order_count, 0, r.key, r.order_count
    from loyalty_earn_rules r
   where r.program_id = p_program and r.kind = 'milestone'
  on conflict (program_id, key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

select loyalty_seed_default_badges(id) from loyalty_programs;

-- -----------------------------------------------------------------------------
-- Challenges
-- -----------------------------------------------------------------------------
create table if not exists loyalty_challenges (
  id                    uuid        primary key default gen_random_uuid(),
  program_id            uuid        not null references loyalty_programs(id) on delete cascade,
  key                   text        not null check (key ~ '^[a-z0-9_]+$'),
  name                  text        not null,
  description           text,
  kind                  text        not null check (kind in ('order_count', 'spend', 'new_categories', 'tagged_product')),
  target                bigint      not null check (target > 0),     -- orders / cents / categories / orders
  points                int         not null check (points > 0),
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  collection_gid        text        check (collection_gid ~ '^gid://shopify/Collection/[0-9]+$'),
  product_tag           text        check (length(product_tag) between 1 and 255),
  announce              boolean     not null default true,
  is_active             boolean     not null default true,
  products_resolved_at  timestamptz,
  products_error        text,
  announced_at          timestamptz,
  created_by            text        not null default 'system',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (program_id, key),
  check (ends_at > starts_at),
  check ((kind = 'tagged_product') = (collection_gid is not null or product_tag is not null)),
  check (collection_gid is null or product_tag is null)
);
create index if not exists idx_loyalty_challenges_window on loyalty_challenges(program_id, starts_at, ends_at) where is_active;

drop trigger if exists trg_loyalty_challenges_updated_at on loyalty_challenges;
create trigger trg_loyalty_challenges_updated_at
  before update on loyalty_challenges
  for each row execute function set_updated_at();

create table if not exists loyalty_challenge_products (
  challenge_id  uuid   not null references loyalty_challenges(id) on delete cascade,
  product_id    bigint not null check (product_id > 0),
  primary key (challenge_id, product_id)
);

create or replace function loyalty_challenge_scope_changed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.collection_gid is distinct from old.collection_gid or new.product_tag is distinct from old.product_tag then
    new.products_resolved_at := null;
    delete from loyalty_challenge_products where challenge_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_loyalty_challenge_scope on loyalty_challenges;
create trigger trg_loyalty_challenge_scope
  before update on loyalty_challenges
  for each row execute function loyalty_challenge_scope_changed();

create table if not exists loyalty_member_challenges (
  member_id     uuid        not null references loyalty_members(id) on delete cascade,
  challenge_id  uuid        not null references loyalty_challenges(id) on delete cascade,
  completed_at  timestamptz not null default now(),
  primary key (member_id, challenge_id)
);

alter table loyalty_order_lines        enable row level security;
alter table loyalty_products           enable row level security;
alter table loyalty_badges             enable row level security;
alter table loyalty_member_badges      enable row level security;
alter table loyalty_challenges         enable row level security;
alter table loyalty_challenge_products enable row level security;
alter table loyalty_member_challenges  enable row level security;
revoke all on loyalty_order_lines, loyalty_products, loyalty_badges, loyalty_member_badges,
              loyalty_challenges, loyalty_challenge_products, loyalty_member_challenges from anon, authenticated;
grant select, insert, update, delete on loyalty_order_lines, loyalty_products, loyalty_badges, loyalty_member_badges,
              loyalty_challenges, loyalty_challenge_products, loyalty_member_challenges to service_role;

-- -----------------------------------------------------------------------------
-- Building blocks
-- -----------------------------------------------------------------------------

-- loyalty_record_order_lines — the order's lines, summed per product. Live
-- (webhook) orders of members only. Returns lines stored by this call.
create or replace function loyalty_record_order_lines(p_program uuid, p_order jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_o loyalty_orders%rowtype;
  v_n int;
begin
  select * into v_o from loyalty_orders
   where program_id = p_program and shopify_order_id = (p_order->>'id')::bigint and source = 'webhook';
  if not found then
    return 0;
  end if;
  insert into loyalty_order_lines (program_id, shopify_order_id, member_id, product_id, cents)
  select p_program, v_o.shopify_order_id, v_o.member_id, (l->>'product_id')::bigint, sum(greatest(coalesce((l->>'cents')::bigint, 0), 0))
    from jsonb_array_elements(coalesce(p_order->'line_items', '[]'::jsonb)) l
   where (l->>'product_id') ~ '^[0-9]{1,19}$' and (l->>'product_id')::bigint > 0
   group by (l->>'product_id')::bigint
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Product types the member has bought in [p_from, p_to) (null = open).
-- Orders fully refunded don't count.
create or replace function loyalty_member_categories(p_member uuid, p_from timestamptz default null, p_to timestamptz default null)
returns setof text
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct p.product_type
    from loyalty_order_lines l
    join loyalty_orders o on o.program_id = l.program_id and o.shopify_order_id = l.shopify_order_id
    join loyalty_products p on p.program_id = l.program_id and p.product_id = l.product_id
   where l.member_id = p_member and p.product_type <> '' and o.refunded_cents < o.eligible_cents
     and (p_from is null or o.processed_at >= p_from) and (p_to is null or o.processed_at < p_to);
$$;

-- loyalty_member_streak — {months, this_month: ordered this month yet,
-- keep_by: last store-local day to order to keep it going}.
create or replace function loyalty_member_streak(p_member uuid, p_now timestamptz default null)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_tz     text;
  v_now    timestamptz := coalesce(p_now, now());
  v_cur    date;
  v_mo     date;
  v_months date[];
  v_n      int := 0;
  v_this   boolean;
begin
  select p.timezone into v_tz from loyalty_members m join loyalty_programs p on p.id = m.program_id where m.id = p_member;
  if v_tz is null then
    return null;
  end if;
  v_cur := date_trunc('month', v_now at time zone v_tz)::date;
  select array_agg(distinct date_trunc('month', processed_at at time zone v_tz)::date) into v_months
    from loyalty_orders
   where member_id = p_member and refunded_cents < eligible_cents and processed_at <= v_now;
  v_months := coalesce(v_months, '{}');
  v_this := v_cur = any (v_months);
  v_mo := case when v_this then v_cur else (v_cur - interval '1 month')::date end;
  while v_mo = any (v_months) loop
    v_n := v_n + 1;
    v_mo := (v_mo - interval '1 month')::date;
  end loop;
  return jsonb_build_object(
    'months', v_n,
    'this_month', v_this,
    'keep_by', case when v_n = 0 then null
                    when v_this then ((v_cur + interval '2 months')::date - 1)
                    else ((v_cur + interval '1 month')::date - 1) end);
end;
$$;

-- Progress toward a challenge (same unit as target).
create or replace function loyalty_challenge_progress(p_member uuid, p_challenge uuid)
returns bigint
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_c loyalty_challenges%rowtype;
begin
  select * into v_c from loyalty_challenges where id = p_challenge;
  if not found then
    return 0;
  end if;
  return case v_c.kind
    when 'order_count' then (
      select count(*) from loyalty_orders
       where member_id = p_member and refunded_cents < eligible_cents
         and processed_at >= v_c.starts_at and processed_at < v_c.ends_at)
    when 'spend' then (
      select coalesce(sum(eligible_cents - refunded_cents), 0) from loyalty_orders
       where member_id = p_member and processed_at >= v_c.starts_at and processed_at < v_c.ends_at)
    when 'new_categories' then (
      select count(*) from loyalty_member_categories(p_member, v_c.starts_at, v_c.ends_at) c
       where c not in (select loyalty_member_categories(p_member, null, v_c.starts_at)))
    else (
      select count(distinct o.shopify_order_id)
        from loyalty_orders o
        join loyalty_order_lines l on l.program_id = o.program_id and l.shopify_order_id = o.shopify_order_id
        join loyalty_challenge_products cp on cp.challenge_id = v_c.id and cp.product_id = l.product_id
       where o.member_id = p_member and o.refunded_cents < o.eligible_cents
         and o.processed_at >= v_c.starts_at and o.processed_at < v_c.ends_at)
  end;
end;
$$;

-- Progress toward a badge: {have, need}. Milestones read paid_order_count.
create or replace function loyalty_badge_progress(p_member uuid, p_badge uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_b    loyalty_badges%rowtype;
  v_m    loyalty_members%rowtype;
  v_have bigint;
begin
  select * into v_b from loyalty_badges where id = p_badge;
  select * into v_m from loyalty_members where id = p_member;
  v_have := case v_b.kind
    when 'categories'   then (select count(*) from loyalty_member_categories(p_member))
    when 'big_order'    then (select coalesce(max(eligible_cents - refunded_cents), 0) from loyalty_orders where member_id = p_member)
    when 'month_streak' then (loyalty_member_streak(p_member)->>'months')::bigint
    when 'referrals'    then (select count(*) from loyalty_referrals where referrer_id = p_member and status = 'completed')
    else v_m.paid_order_count
  end;
  return jsonb_build_object('have', least(v_have, v_b.threshold), 'need', v_b.threshold);
end;
$$;

-- -----------------------------------------------------------------------------
-- Evaluation
-- -----------------------------------------------------------------------------
create or replace function loyalty_evaluate_member(p_member uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_m       loyalty_members%rowtype;
  v_p       loyalty_programs%rowtype;
  v_b       loyalty_badges%rowtype;
  v_c       loyalty_challenges%rowtype;
  v_ok      boolean;
  v_badges  text[] := '{}';
  v_chall   text[] := '{}';
begin
  select * into v_m from loyalty_members where id = p_member and status = 'active' for update;
  if not found or not loyalty_nudges_for(p_member) then
    return jsonb_build_object('badges', '[]'::jsonb, 'challenges', '[]'::jsonb);
  end if;
  select * into v_p from loyalty_programs where id = v_m.program_id;

  for v_b in
    select * from loyalty_badges b
     where b.program_id = v_m.program_id and b.is_active and b.kind <> 'milestone'
       and not exists (select 1 from loyalty_member_badges mb where mb.member_id = p_member and mb.badge_id = b.id)
     order by b.sort
  loop
    v_ok := case v_b.kind
      when 'categories' then (select count(*) from loyalty_member_categories(p_member)) >= v_b.threshold
      when 'big_order' then exists (select 1 from loyalty_orders where member_id = p_member and processed_at >= v_p.treatment_since
                                     and eligible_cents - refunded_cents >= v_b.threshold)
      when 'month_streak' then (loyalty_member_streak(p_member)->>'months')::int >= v_b.threshold
                               and exists (select 1 from loyalty_orders where member_id = p_member and processed_at >= v_p.treatment_since
                                            and refunded_cents < eligible_cents)
      when 'referrals' then (select count(*) from loyalty_referrals where referrer_id = p_member and status = 'completed') >= v_b.threshold
                            and exists (select 1 from loyalty_referrals where referrer_id = p_member and status = 'completed'
                                         and completed_at >= v_p.treatment_since)
      else false end;
    continue when not v_ok;
    insert into loyalty_member_badges (member_id, badge_id) values (p_member, v_b.id) on conflict do nothing;
    continue when not found;
    if v_b.points > 0 then
      perform loyalty_post_entry(p_member, v_b.points, 'action', 'badge:' || v_b.id || ':' || p_member, 0,
                                 'badge:' || v_b.key, 'badge', v_b.key, v_b.name, 'system', now());
    end if;
    perform loyalty_emit_event(p_member, 'badge_earned', 'badge_earned:' || v_b.id || ':' || p_member,
      jsonb_build_object('badge', v_b.name, 'badge_key', v_b.key, 'description', v_b.description, 'points_awarded', v_b.points));
    v_badges := v_badges || v_b.key;
  end loop;

  -- Running challenges, and ones that ended in the last 2 days (product
  -- types are looked up after the order, so completion can land late).
  for v_c in
    select * from loyalty_challenges c
     where c.program_id = v_m.program_id and c.is_active and c.starts_at <= now() and c.ends_at > now() - interval '2 days'
       and c.starts_at >= v_p.treatment_since - interval '366 days'
       and not exists (select 1 from loyalty_member_challenges mc where mc.member_id = p_member and mc.challenge_id = c.id)
     order by c.starts_at, c.key
  loop
    continue when loyalty_challenge_progress(p_member, v_c.id) < v_c.target;
    insert into loyalty_member_challenges (member_id, challenge_id) values (p_member, v_c.id) on conflict do nothing;
    continue when not found;
    perform loyalty_post_entry(p_member, v_c.points, 'action', 'challenge:' || v_c.id || ':' || p_member, 0,
                               'challenge:' || v_c.key, 'challenge', v_c.key, v_c.name, 'system', now());
    perform loyalty_emit_event(p_member, 'challenge_completed', 'challenge_completed:' || v_c.id || ':' || p_member,
      jsonb_build_object('challenge', v_c.name, 'challenge_key', v_c.key, 'points_awarded', v_c.points));
    v_chall := v_chall || v_c.key;
  end loop;

  return jsonb_build_object('badges', to_jsonb(v_badges), 'challenges', to_jsonb(v_chall));
end;
$$;

-- loyalty_after_order — everything after loyalty_record_order for a live
-- order (loyalty-webhooks, recorded or duplicate): lines, bonus campaigns,
-- then evaluation of the buyer and of a referrer this order completed.
create or replace function loyalty_after_order(p_program uuid, p_order jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order_id bigint := (p_order->>'id')::bigint;
  v_member   uuid;
  v_bonus    int;
  v_eval     jsonb := '{}'::jsonb;
  v_ref      uuid;
begin
  perform loyalty_record_order_lines(p_program, p_order);
  v_bonus := loyalty_apply_campaigns(p_program, p_order);
  select member_id into v_member from loyalty_orders
   where program_id = p_program and shopify_order_id = v_order_id and source = 'webhook';
  if v_member is not null then
    v_eval := loyalty_evaluate_member(v_member);
  end if;
  select referrer_id into v_ref from loyalty_referrals
   where program_id = p_program and shopify_order_id = v_order_id and status = 'completed';
  if v_ref is not null then
    perform loyalty_evaluate_member(v_ref);
  end if;
  return jsonb_build_object('bonus_points', v_bonus, 'badges', coalesce(v_eval->'badges', '[]'::jsonb),
                            'challenges', coalesce(v_eval->'challenges', '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty-shopify: product types and challenge scopes
-- -----------------------------------------------------------------------------
create or replace function loyalty_products_to_fetch(p_program uuid, p_limit int default 250)
returns bigint[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(product_id), '{}') from (
    select distinct l.product_id from loyalty_order_lines l
     where l.program_id = p_program
       and not exists (select 1 from loyalty_products p where p.program_id = p_program and p.product_id = l.product_id)
     limit p_limit) s;
$$;

-- p_items: [{product_id, product_type}] (type '' for none / deleted). Stores
-- them, then re-evaluates the members who bought those products.
create or replace function loyalty_products_fetched(p_program uuid, p_items jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_m uuid;
  v_n int := 0;
begin
  insert into loyalty_products (program_id, product_id, product_type)
  select p_program, (i->>'product_id')::bigint, left(trim(coalesce(i->>'product_type', '')), 255)
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
   where (i->>'product_id') ~ '^[0-9]{1,19}$'
  on conflict (program_id, product_id) do update set product_type = excluded.product_type, fetched_at = now();
  for v_m in
    select distinct l.member_id from loyalty_order_lines l
     where l.program_id = p_program
       and l.product_id in (select (i->>'product_id')::bigint from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
                             where (i->>'product_id') ~ '^[0-9]{1,19}$')
  loop
    perform loyalty_evaluate_member(v_m);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function loyalty_challenges_to_resolve(p_program uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'collection_gid', collection_gid, 'product_tag', product_tag)
                            order by products_resolved_at nulls first), '[]'::jsonb)
    from loyalty_challenges
   where program_id = p_program and is_active and ends_at > now() and kind = 'tagged_product'
     and (products_resolved_at is null or products_resolved_at < now() - interval '1 day')
     and (products_error is null or updated_at < now() - interval '15 minutes');
$$;

create or replace function loyalty_challenge_resolved(p_challenge uuid, p_product_ids bigint[], p_error text default null)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_product_ids is null then
    update loyalty_challenges set products_error = left(coalesce(p_error, 'unknown error'), 500) where id = p_challenge;
    return;
  end if;
  delete from loyalty_challenge_products where challenge_id = p_challenge and not (product_id = any (p_product_ids));
  insert into loyalty_challenge_products (challenge_id, product_id)
  select p_challenge, x from unnest(p_product_ids) x where x > 0
  on conflict do nothing;
  update loyalty_challenges set products_resolved_at = now(), products_error = null where id = p_challenge;
end;
$$;

-- loyalty_shopify_has_work — 0214's, plus product types and challenge scopes.
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
      or jsonb_array_length(loyalty_campaigns_to_resolve(p_program)) > 0
      or jsonb_array_length(loyalty_challenges_to_resolve(p_program)) > 0
      or cardinality(loyalty_products_to_fetch(p_program, 1)) > 0;
$$;

-- -----------------------------------------------------------------------------
-- Automations: 0214's, plus challenge_started and streak_ending.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Storefront: badges, streak and challenges for the logged-in member.
-- null = nothing to show (not a member, holdout, or Phase 1b not live).
-- -----------------------------------------------------------------------------
create or replace function loyalty_storefront_achievements(p_program uuid, p_customer_id bigint)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_m loyalty_members%rowtype;
  v_p loyalty_programs%rowtype;
begin
  if p_customer_id is null then
    return null;
  end if;
  select * into v_m from loyalty_members
   where program_id = p_program and shopify_customer_id = p_customer_id and status = 'active';
  if not found or not loyalty_nudges_for(v_m.id) then
    return null;
  end if;
  select * into v_p from loyalty_programs where id = p_program;

  return jsonb_build_object(
    'badges', (select coalesce(jsonb_agg(jsonb_build_object(
                 'key', b.key, 'name', b.name, 'description', b.description, 'points', b.points, 'kind', b.kind,
                 'earned', case when b.kind = 'milestone' then exists (select 1 from loyalty_ledger l where l.member_id = v_m.id
                                                                         and l.reason in ('milestone', 'import') and l.rule_key = b.rule_key)
                                                                or v_m.paid_order_count >= b.threshold
                                else mb.earned_at is not null end,
                 'earned_at', mb.earned_at,
                 'progress', loyalty_badge_progress(v_m.id, b.id)) order by b.sort, b.key), '[]'::jsonb)
                 from loyalty_badges b
                 left join loyalty_member_badges mb on mb.badge_id = b.id and mb.member_id = v_m.id
                where b.program_id = p_program and b.is_active),
    'streak', loyalty_member_streak(v_m.id),
    'challenges', (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', c.key, 'name', c.name, 'description', c.description, 'kind', c.kind,
                     'target', c.target, 'points', c.points,
                     'progress', least(loyalty_challenge_progress(v_m.id, c.id), c.target),
                     'ends_at', c.ends_at,
                     'completed', mc.completed_at is not null) order by c.ends_at), '[]'::jsonb)
                     from loyalty_challenges c
                     left join loyalty_member_challenges mc on mc.challenge_id = c.id and mc.member_id = v_m.id
                    where c.program_id = p_program and c.is_active and c.starts_at <= now()
                      and (c.ends_at > now() or (mc.completed_at is not null and c.ends_at > now() - interval '7 days'))));
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff: challenges in the campaign console, badges read-only
-- -----------------------------------------------------------------------------
create or replace function loyalty_staff_challenges(p_program uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog loyalty_programs%rowtype;
begin
  perform loyalty_require_staff();
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  return jsonb_build_object(
    'challenges', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'key', c.key, 'name', c.name, 'description', c.description, 'kind', c.kind,
        'target', c.target, 'points', c.points, 'starts_at', c.starts_at, 'ends_at', c.ends_at,
        'starts_local', to_char(c.starts_at at time zone v_prog.timezone, 'YYYY-MM-DD"T"HH24:MI'),
        'ends_local', to_char(c.ends_at at time zone v_prog.timezone, 'YYYY-MM-DD"T"HH24:MI'),
        'collection_gid', c.collection_gid, 'product_tag', c.product_tag,
        'announce', c.announce, 'announced_at', c.announced_at, 'is_active', c.is_active,
        'status', case when not c.is_active then 'paused' when c.starts_at > now() then 'upcoming'
                       when c.ends_at <= now() then 'ended' else 'running' end,
        'scope', case when c.kind <> 'tagged_product' then null else jsonb_build_object(
                   'resolved_at', c.products_resolved_at, 'error', c.products_error,
                   'products', (select count(*) from loyalty_challenge_products where challenge_id = c.id)) end,
        'completed', (select count(*) from loyalty_member_challenges where challenge_id = c.id),
        'points_awarded', (select coalesce(sum(points), 0) from loyalty_ledger
                            where program_id = p_program and idempotency_key like 'challenge:' || c.id || ':%'),
        'created_by', c.created_by) order by c.starts_at desc), '[]'::jsonb)
        from (select * from loyalty_challenges where program_id = p_program order by starts_at desc limit 50) c),
    'badges', (select coalesce(jsonb_agg(jsonb_build_object(
        'key', b.key, 'name', b.name, 'description', b.description, 'kind', b.kind, 'threshold', b.threshold,
        'points', b.points, 'is_active', b.is_active,
        'earned', case when b.kind = 'milestone' then null
                       else (select count(*) from loyalty_member_badges where badge_id = b.id) end) order by b.sort, b.key), '[]'::jsonb)
        from loyalty_badges b where b.program_id = p_program));
end;
$$;

-- p_challenge null = create. p_fields: {name, description, kind, target,
-- points, starts_local, ends_local, collection_gid, product_tag, announce}.
-- Started challenges: only name, description, end and announce change.
create or replace function loyalty_staff_challenge_save(p_program uuid, p_challenge uuid, p_fields jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := loyalty_require_staff();
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

create or replace function loyalty_staff_challenge_set_active(p_challenge uuid, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c loyalty_challenges%rowtype;
begin
  perform loyalty_require_staff();
  update loyalty_challenges set is_active = p_active
   where id = p_challenge and is_active is distinct from p_active
  returning * into v_c;
  if not found then
    return false;
  end if;
  perform loyalty_log_access('challenge_active', v_c.program_id, null,
    jsonb_build_object('challenge_id', v_c.id, 'active', p_active));
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke execute on function loyalty_seed_default_badges(uuid) from public, anon, authenticated;
revoke execute on function loyalty_challenge_scope_changed() from public, anon, authenticated;
revoke execute on function loyalty_record_order_lines(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_member_categories(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function loyalty_member_streak(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function loyalty_challenge_progress(uuid, uuid) from public, anon, authenticated;
revoke execute on function loyalty_badge_progress(uuid, uuid) from public, anon, authenticated;
revoke execute on function loyalty_evaluate_member(uuid) from public, anon, authenticated;
revoke execute on function loyalty_after_order(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_products_to_fetch(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_products_fetched(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_challenges_to_resolve(uuid) from public, anon, authenticated;
revoke execute on function loyalty_challenge_resolved(uuid, bigint[], text) from public, anon, authenticated;
revoke execute on function loyalty_shopify_has_work(uuid) from public, anon, authenticated;
revoke execute on function run_loyalty_automations(timestamptz) from public, anon, authenticated;
revoke execute on function loyalty_storefront_achievements(uuid, bigint) from public, anon, authenticated;
revoke execute on function loyalty_staff_challenges(uuid) from public, anon;
revoke execute on function loyalty_staff_challenge_save(uuid, uuid, jsonb) from public, anon;
revoke execute on function loyalty_staff_challenge_set_active(uuid, boolean) from public, anon;

grant execute on function loyalty_seed_default_badges(uuid) to service_role;
grant execute on function loyalty_record_order_lines(uuid, jsonb) to service_role;
grant execute on function loyalty_member_categories(uuid, timestamptz, timestamptz) to service_role;
grant execute on function loyalty_member_streak(uuid, timestamptz) to service_role;
grant execute on function loyalty_challenge_progress(uuid, uuid) to service_role;
grant execute on function loyalty_badge_progress(uuid, uuid) to service_role;
grant execute on function loyalty_evaluate_member(uuid) to service_role;
grant execute on function loyalty_after_order(uuid, jsonb) to service_role;
grant execute on function loyalty_products_to_fetch(uuid, int) to service_role;
grant execute on function loyalty_products_fetched(uuid, jsonb) to service_role;
grant execute on function loyalty_challenges_to_resolve(uuid) to service_role;
grant execute on function loyalty_challenge_resolved(uuid, bigint[], text) to service_role;
grant execute on function loyalty_shopify_has_work(uuid) to service_role;
grant execute on function run_loyalty_automations(timestamptz) to service_role;
grant execute on function loyalty_storefront_achievements(uuid, bigint) to service_role;
grant execute on function loyalty_staff_challenges(uuid) to authenticated;
grant execute on function loyalty_staff_challenge_save(uuid, uuid, jsonb) to authenticated;
grant execute on function loyalty_staff_challenge_set_active(uuid, boolean) to authenticated;
