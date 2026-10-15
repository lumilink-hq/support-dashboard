-- =============================================================================
-- 0200_loyalty_core.sql — LL Loyalty module 1: config tables, members, an
-- append-only points ledger, and the rules engine every later module calls.
-- Plan: docs/loyalty/PLAN.md (Joy replacement for Tsunami).
--
-- SETTINGS-DRIVEN. Nothing Tsunami-specific lives here. One loyalty_programs
-- row per Shopify store; its tiers, earn rules and rewards are rows too.
-- Tsunami's Joy-matching config is scripts/setup-loyalty-program.sql.
--
-- THE LEDGER IS THE TRUTH. loyalty_ledger is append-only (a trigger rejects
-- update, delete and truncate). A correction is a new row, never an edit.
-- loyalty_members.points_balance / tier_spend_cents / paid_order_count are
-- caches of the ledger, written ONLY by loyalty_post_entry under a row lock on
-- the member. loyalty_verify_balances lists any member whose cache drifted.
--
-- IDEMPOTENT WRITES. Shopify retries webhooks, so every entry carries an
-- idempotency_key, unique per program (e.g. 'order:5512345:earn',
-- 'order:5512345:milestone:order_10'). Posting the same key again returns the
-- original entry and changes nothing.
--
-- BALANCES. Only a 'refund' clawback may take a balance below zero (the points
-- were already spent). Anything else that would overdraw raises
-- 'insufficient_points'.
--
-- TIERS. Earned on spend since loyalty_programs.tier_spend_since. An entry
-- with positive spend can only move a member UP to their spend tier; a
-- refund (negative spend) can only move them DOWN to it. Inactivity demotion
-- (module 3) and staff overrides go through loyalty_set_tier. Every change
-- is logged in loyalty_tier_changes (append-only), which module 6 turns into
-- Klaviyo events.
--
-- ACCESS. Staff-only, never client-facing (plan §1). All tables are RLS-on
-- with NO policies and no grants to anon/authenticated: edge functions and the
-- staff admin use the service role. Member rows hold name + email only
-- (protected customer data, plan §8b L1-1).
--
-- Test: scripts/test_loyalty_core.sql. Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- loyalty_programs — one per Shopify store.
-- -----------------------------------------------------------------------------
create table if not exists loyalty_programs (
  id                        uuid        primary key default gen_random_uuid(),
  client_id                 uuid        not null references clients(id) on delete cascade,
  shop_domain               text        not null unique check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  name                      text        not null,                    -- customer-facing, e.g. 'Wave Rewards'
  points_per_dollar         numeric(8,2) not null default 1 check (points_per_dollar > 0),
  tier_spend_since          date,                                     -- null = all-time spend
  demote_after_inactive     interval    not null default '6 months',  -- one tier down with no order
  demotion_warning_days     int         not null default 7 check (demotion_warning_days >= 0),
  points_expire_after       interval,                                 -- inactivity; null = never
  discount_code_prefix      text        not null default 'LL-',
  is_active                 boolean     not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists idx_loyalty_programs_client on loyalty_programs(client_id);

drop trigger if exists trg_loyalty_programs_updated_at on loyalty_programs;
create trigger trg_loyalty_programs_updated_at
  before update on loyalty_programs
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- loyalty_tiers — the lowest rank is the entry tier (every new member).
-- -----------------------------------------------------------------------------
create table if not exists loyalty_tiers (
  id               uuid        primary key default gen_random_uuid(),
  program_id       uuid        not null references loyalty_programs(id) on delete cascade,
  key              text        not null check (key ~ '^[a-z0-9_]+$'),   -- stable: 'bronze'
  name             text        not null,                                -- display + Klaviyo value: 'Bronze'
  rank             int         not null check (rank >= 0),
  min_spend_cents  bigint      not null check (min_spend_cents >= 0),
  earn_multiplier  numeric(4,2) not null default 1 check (earn_multiplier > 0),
  perks            jsonb       not null default '[]'::jsonb,            -- display copy; enforced perks live in module 4
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (program_id, key),
  unique (program_id, rank),
  unique (program_id, min_spend_cents)
);

drop trigger if exists trg_loyalty_tiers_updated_at on loyalty_tiers;
create trigger trg_loyalty_tiers_updated_at
  before update on loyalty_tiers
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- loyalty_earn_rules — fixed-point awards. Order points come from
-- points_per_dollar x tier multiplier, not from a row here.
--   action    — signup, instagram_follow, newsletter, birthday, anniversary
--   milestone — the Nth paid order (order_count)
--   referral  — the referrer's award
-- -----------------------------------------------------------------------------
create table if not exists loyalty_earn_rules (
  id           uuid        primary key default gen_random_uuid(),
  program_id   uuid        not null references loyalty_programs(id) on delete cascade,
  key          text        not null check (key ~ '^[a-z0-9_]+$'),
  kind         text        not null check (kind in ('action', 'milestone', 'referral')),
  points       int         not null check (points >= 0),
  order_count  int         check (order_count > 0),
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (program_id, key),
  check ((kind = 'milestone') = (order_count is not null))
);

create unique index if not exists uq_loyalty_earn_rules_milestone
  on loyalty_earn_rules(program_id, order_count) where kind = 'milestone';

drop trigger if exists trg_loyalty_earn_rules_updated_at on loyalty_earn_rules;
create trigger trg_loyalty_earn_rules_updated_at
  before update on loyalty_earn_rules
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- loyalty_rewards — what points (or a referral) buy. Turning one into a Shopify
-- discount is module 4. points_cost null = not purchasable with points
-- (the referred friend's coupon).
-- -----------------------------------------------------------------------------
create table if not exists loyalty_rewards (
  id               uuid        primary key default gen_random_uuid(),
  program_id       uuid        not null references loyalty_programs(id) on delete cascade,
  key              text        not null check (key ~ '^[a-z0-9_]+$'),
  name             text        not null,
  kind             text        not null check (kind in ('amount_off_order', 'free_shipping')),
  points_cost      int         check (points_cost > 0),
  value_cents      bigint      not null default 0 check (value_cents >= 0),
  min_order_cents  bigint      not null default 0 check (min_order_cents >= 0),
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (program_id, key)
);

drop trigger if exists trg_loyalty_rewards_updated_at on loyalty_rewards;
create trigger trg_loyalty_rewards_updated_at
  before update on loyalty_rewards
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- loyalty_members — one per Shopify customer per program.
-- -----------------------------------------------------------------------------
create table if not exists loyalty_members (
  id                    uuid        primary key default gen_random_uuid(),
  program_id            uuid        not null references loyalty_programs(id) on delete cascade,
  shopify_customer_id   bigint      not null check (shopify_customer_id > 0),
  email                 text,
  first_name            text,
  last_name             text,
  birthday              date,
  tier_key              text        not null,
  referral_code         text        not null,
  referred_by           uuid        references loyalty_members(id) on delete set null,
  status                text        not null default 'active' check (status in ('active', 'excluded')),
  enrolled_at           timestamptz not null default now(),
  -- ledger caches: written only by loyalty_post_entry
  points_balance        int         not null default 0,
  tier_spend_cents      bigint      not null default 0,
  paid_order_count      int         not null default 0 check (paid_order_count >= 0),
  last_order_at         timestamptz,
  last_activity_at      timestamptz,
  tier_changed_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (program_id, shopify_customer_id),
  unique (program_id, referral_code),
  foreign key (program_id, tier_key) references loyalty_tiers(program_id, key) on update cascade
);

create index if not exists idx_loyalty_members_email on loyalty_members(program_id, lower(email));
create index if not exists idx_loyalty_members_activity on loyalty_members(program_id, last_activity_at);
create index if not exists idx_loyalty_members_last_order on loyalty_members(program_id, last_order_at);

drop trigger if exists trg_loyalty_members_updated_at on loyalty_members;
create trigger trg_loyalty_members_updated_at
  before update on loyalty_members
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- loyalty_ledger — append-only.
--   points       — signed. Negative for redeem, refund clawback, expiry.
--   spend_cents  — signed. Tier spend this entry adds or claws back.
--   occurred_at  — when it happened at the source (backfill keeps Shopify's
--                  order time); created_at is when we wrote it.
-- -----------------------------------------------------------------------------
create table if not exists loyalty_ledger (
  id               bigint      generated always as identity primary key,
  program_id       uuid        not null references loyalty_programs(id) on delete cascade,
  member_id        uuid        not null references loyalty_members(id) on delete cascade,
  points           int         not null,
  spend_cents      bigint      not null default 0,
  reason           text        not null check (reason in (
                     'order', 'refund', 'action', 'milestone', 'referral',
                     'redeem', 'redeem_reversal', 'expire', 'adjust', 'import')),
  rule_key         text,
  source_type      text,       -- 'shopify_order', 'shopify_refund', 'staff', 'job', 'joy_import', …
  source_id        text,
  idempotency_key  text        not null check (length(idempotency_key) between 1 and 200),
  balance_after    int         not null,
  note             text,
  actor            text        not null default 'system',   -- staff email for manual entries
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (program_id, idempotency_key)
);

create index if not exists idx_loyalty_ledger_member on loyalty_ledger(member_id, id);
create index if not exists idx_loyalty_ledger_source on loyalty_ledger(program_id, source_type, source_id);

-- -----------------------------------------------------------------------------
-- loyalty_tier_changes — append-only tier history.
-- -----------------------------------------------------------------------------
create table if not exists loyalty_tier_changes (
  id          bigint      generated always as identity primary key,
  program_id  uuid        not null references loyalty_programs(id) on delete cascade,
  member_id   uuid        not null references loyalty_members(id) on delete cascade,
  from_tier   text,       -- null on enrollment
  to_tier     text        not null,
  direction   text        not null check (direction in ('enroll', 'up', 'down')),
  reason      text        not null check (reason in ('enroll', 'spend', 'refund', 'inactivity', 'staff', 'import')),
  ledger_id   bigint      references loyalty_ledger(id) on delete cascade,
  actor       text        not null default 'system',
  created_at  timestamptz not null default now()
);

create index if not exists idx_loyalty_tier_changes_member on loyalty_tier_changes(member_id, id);
create index if not exists idx_loyalty_tier_changes_recent on loyalty_tier_changes(program_id, created_at);

-- -----------------------------------------------------------------------------
-- Append-only guard. Program/member deletes still cascade (uninstall, GDPR
-- redact): the guard only blocks direct edits, so the cascade is allowed
-- through by checking pg_trigger_depth().
-- -----------------------------------------------------------------------------
create or replace function loyalty_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;   -- cascade from loyalty_members / loyalty_programs
  end if;
  raise exception '% is append-only (% rejected); post a correcting entry instead', tg_table_name, tg_op;
end;
$$;

drop trigger if exists trg_loyalty_ledger_append_only on loyalty_ledger;
create trigger trg_loyalty_ledger_append_only
  before update or delete on loyalty_ledger
  for each row execute function loyalty_append_only();

drop trigger if exists trg_loyalty_ledger_no_truncate on loyalty_ledger;
create trigger trg_loyalty_ledger_no_truncate
  before truncate on loyalty_ledger
  for each statement execute function loyalty_append_only();

drop trigger if exists trg_loyalty_tier_changes_append_only on loyalty_tier_changes;
create trigger trg_loyalty_tier_changes_append_only
  before update or delete on loyalty_tier_changes
  for each row execute function loyalty_append_only();

drop trigger if exists trg_loyalty_tier_changes_no_truncate on loyalty_tier_changes;
create trigger trg_loyalty_tier_changes_no_truncate
  before truncate on loyalty_tier_changes
  for each statement execute function loyalty_append_only();

-- -----------------------------------------------------------------------------
-- Access: service role only.
-- -----------------------------------------------------------------------------
alter table loyalty_programs     enable row level security;
alter table loyalty_tiers        enable row level security;
alter table loyalty_earn_rules   enable row level security;
alter table loyalty_rewards      enable row level security;
alter table loyalty_members      enable row level security;
alter table loyalty_ledger       enable row level security;
alter table loyalty_tier_changes enable row level security;

revoke all on loyalty_programs, loyalty_tiers, loyalty_earn_rules, loyalty_rewards,
              loyalty_members, loyalty_ledger, loyalty_tier_changes
  from anon, authenticated;
grant select, insert, update, delete on loyalty_programs, loyalty_tiers, loyalty_earn_rules,
              loyalty_rewards, loyalty_members to service_role;
-- History tables: insert + read only, even for the service role.
grant select, insert on loyalty_ledger, loyalty_tier_changes to service_role;


-- =============================================================================
-- Rules engine
-- =============================================================================

-- loyalty_tier_for_spend — the highest tier whose threshold the spend meets.
-- Below every threshold (or negative after refunds) is the entry tier.
create or replace function loyalty_tier_for_spend(p_program uuid, p_spend_cents bigint)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select key from loyalty_tiers
      where program_id = p_program and min_spend_cents <= p_spend_cents
      order by rank desc limit 1),
    (select key from loyalty_tiers where program_id = p_program order by rank limit 1));
$$;

-- loyalty_order_points — points for an order's eligible amount at the
-- member's current tier: floor(dollars x points_per_dollar x multiplier).
-- Which amount is "eligible" (subtotal after discounts, no tax/shipping) is
-- the caller's call (module 2).
create or replace function loyalty_order_points(p_member uuid, p_eligible_cents bigint)
returns int
language sql
stable
set search_path = public, pg_temp
as $$
  select floor(greatest(p_eligible_cents, 0) * p.points_per_dollar * t.earn_multiplier / 100)::int
    from loyalty_members m
    join loyalty_programs p on p.id = m.program_id
    join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
   where m.id = p_member;
$$;

-- loyalty_milestones_crossed — active milestone rules with order_count in
-- (p_from, p_to]. Several at once are all returned (Joy awards them all).
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
   order by r.order_count;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_enroll_member — idempotent on (program, shopify customer). A known
-- customer gets their contact fields refreshed (non-null values only) and
-- keeps everything else. Returns the member id.
-- -----------------------------------------------------------------------------
create or replace function loyalty_enroll_member(
  p_program      uuid,
  p_customer_id  bigint,
  p_email        text default null,
  p_first_name   text default null,
  p_last_name    text default null,
  p_enrolled_at  timestamptz default null,   -- null = now
  p_referred_by  uuid default null
)
returns uuid
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_id    uuid;
  v_entry text;
  v_code  text;
begin
  select id into v_id from loyalty_members
   where program_id = p_program and shopify_customer_id = p_customer_id;
  if found then
    update loyalty_members
       set email      = coalesce(p_email, email),
           first_name = coalesce(p_first_name, first_name),
           last_name  = coalesce(p_last_name, last_name)
     where id = v_id;
    return v_id;
  end if;

  select key into v_entry from loyalty_tiers where program_id = p_program order by rank limit 1;
  if v_entry is null then
    raise exception 'loyalty program % has no tiers', p_program;
  end if;
  if p_referred_by is not null
     and not exists (select 1 from loyalty_members where id = p_referred_by and program_id = p_program) then
    raise exception 'referrer % is not in program %', p_referred_by, p_program;
  end if;

  loop
    v_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
    exit when not exists (select 1 from loyalty_members where program_id = p_program and referral_code = v_code);
  end loop;

  insert into loyalty_members (program_id, shopify_customer_id, email, first_name, last_name,
                               tier_key, referral_code, referred_by, enrolled_at, tier_changed_at)
  values (p_program, p_customer_id, p_email, p_first_name, p_last_name,
          v_entry, v_code, p_referred_by, coalesce(p_enrolled_at, now()), coalesce(p_enrolled_at, now()))
  on conflict (program_id, shopify_customer_id) do nothing
  returning id into v_id;

  if v_id is null then   -- lost a race with a concurrent webhook
    select id into v_id from loyalty_members
     where program_id = p_program and shopify_customer_id = p_customer_id;
    return v_id;
  end if;

  insert into loyalty_tier_changes (program_id, member_id, from_tier, to_tier, direction, reason)
  values (p_program, v_id, null, v_entry, 'enroll', 'enroll');
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_set_tier — the one way to move a tier outside of spend: inactivity
-- demotion (module 3), staff override (module 7), Joy import (module 8).
-- Returns true if the tier changed.
-- -----------------------------------------------------------------------------
create or replace function loyalty_set_tier(
  p_member    uuid,
  p_tier_key  text,
  p_reason    text,
  p_actor     text default 'system',
  p_ledger_id bigint default null
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_m        loyalty_members%rowtype;
  v_old_rank int;
  v_new_rank int;
begin
  select * into v_m from loyalty_members where id = p_member for update;
  if not found then
    raise exception 'loyalty member % not found', p_member;
  end if;
  if v_m.tier_key = p_tier_key then
    return false;
  end if;

  select rank into v_old_rank from loyalty_tiers where program_id = v_m.program_id and key = v_m.tier_key;
  select rank into v_new_rank from loyalty_tiers where program_id = v_m.program_id and key = p_tier_key;
  if v_new_rank is null then
    raise exception 'tier % is not in program %', p_tier_key, v_m.program_id;
  end if;

  update loyalty_members set tier_key = p_tier_key, tier_changed_at = now() where id = p_member;
  insert into loyalty_tier_changes (program_id, member_id, from_tier, to_tier, direction, reason, ledger_id, actor)
  values (v_m.program_id, p_member, v_m.tier_key, p_tier_key,
          case when v_new_rank > v_old_rank then 'up' else 'down' end,
          p_reason, p_ledger_id, coalesce(p_actor, 'system'));
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_post_entry — the ONLY write path into the ledger.
--
-- Returns jsonb: {entry_id, duplicate, member_id, points_balance, tier_key,
--                 tier_changed, paid_order_count}
-- A duplicate idempotency_key returns the original entry (duplicate = true)
-- and the member's current state; nothing changes. The same key on a
-- different member is a caller bug and raises.
--
-- reason 'order' counts one paid order and moves last_order_at; a 'refund'
-- never un-counts it (a milestone, once awarded, stays awarded).
-- -----------------------------------------------------------------------------
create or replace function loyalty_post_entry(
  p_member          uuid,
  p_points          int,
  p_reason          text,
  p_idempotency_key text,
  p_spend_cents     bigint default 0,
  p_rule_key        text default null,
  p_source_type     text default null,
  p_source_id       text default null,
  p_note            text default null,
  p_actor           text default 'system',
  p_occurred_at     timestamptz default null   -- null = now
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_m          loyalty_members%rowtype;
  v_existing   loyalty_ledger%rowtype;
  v_balance    int;
  v_spend      bigint;
  v_orders     int;
  v_entry_id   bigint;
  v_spend_tier text;
  v_cur_rank   int;
  v_spend_rank int;
  v_changed    boolean := false;
  v_activity   boolean := p_reason in ('order', 'action', 'milestone', 'referral', 'redeem');
begin
  if p_points is null or p_reason is null or p_idempotency_key is null then
    raise exception 'points, reason and idempotency_key are required';
  end if;
  p_spend_cents := coalesce(p_spend_cents, 0);
  p_occurred_at := coalesce(p_occurred_at, now());
  if p_reason = 'redeem' and p_points >= 0 then
    raise exception 'a redeem entry must take points (got %)', p_points;
  end if;

  -- Lock the member: serializes every write for one member, so the cached
  -- balance and the idempotency check below can't race.
  select * into v_m from loyalty_members where id = p_member for update;
  if not found then
    raise exception 'loyalty member % not found', p_member;
  end if;

  select * into v_existing from loyalty_ledger
   where program_id = v_m.program_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.member_id <> p_member then
      raise exception 'idempotency key % already belongs to another member', p_idempotency_key;
    end if;
    return jsonb_build_object(
      'entry_id', v_existing.id, 'duplicate', true, 'member_id', p_member,
      'points_balance', v_m.points_balance, 'tier_key', v_m.tier_key,
      'tier_changed', false, 'paid_order_count', v_m.paid_order_count);
  end if;

  v_balance := v_m.points_balance + p_points;
  if v_balance < 0 and p_points < 0 and p_reason <> 'refund' then
    raise exception 'insufficient_points: balance %, entry %', v_m.points_balance, p_points
      using errcode = 'P0001';
  end if;
  v_spend  := v_m.tier_spend_cents + p_spend_cents;
  v_orders := v_m.paid_order_count + case when p_reason = 'order' then 1 else 0 end;

  insert into loyalty_ledger (program_id, member_id, points, spend_cents, reason, rule_key,
                              source_type, source_id, idempotency_key, balance_after, note,
                              actor, occurred_at)
  values (v_m.program_id, p_member, p_points, p_spend_cents, p_reason, p_rule_key,
          p_source_type, p_source_id, p_idempotency_key, v_balance, p_note,
          coalesce(p_actor, 'system'), p_occurred_at)
  returning id into v_entry_id;

  update loyalty_members
     set points_balance   = v_balance,
         tier_spend_cents = v_spend,
         paid_order_count = v_orders,
         last_order_at    = case when p_reason = 'order'
                                 then greatest(last_order_at, p_occurred_at) else last_order_at end,
         last_activity_at = case when v_activity
                                 then greatest(last_activity_at, p_occurred_at) else last_activity_at end
   where id = p_member;

  -- Spend moves the tier toward the spend tier, never past it the other way.
  if p_spend_cents <> 0 then
    v_spend_tier := loyalty_tier_for_spend(v_m.program_id, v_spend);
    select rank into v_cur_rank   from loyalty_tiers where program_id = v_m.program_id and key = v_m.tier_key;
    select rank into v_spend_rank from loyalty_tiers where program_id = v_m.program_id and key = v_spend_tier;
    if (p_spend_cents > 0 and v_spend_rank > v_cur_rank)
       or (p_spend_cents < 0 and v_spend_rank < v_cur_rank) then
      v_changed := loyalty_set_tier(p_member, v_spend_tier,
                                    case when p_spend_cents > 0 then 'spend' else 'refund' end,
                                    p_actor, v_entry_id);
    end if;
  end if;

  return jsonb_build_object(
    'entry_id', v_entry_id, 'duplicate', false, 'member_id', p_member,
    'points_balance', v_balance,
    'tier_key', case when v_changed then v_spend_tier else v_m.tier_key end,
    'tier_changed', v_changed, 'paid_order_count', v_orders);
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_verify_balances — members whose cached balance/spend disagrees with
-- the ledger. Should always be empty; used by tests and the parallel run.
-- -----------------------------------------------------------------------------
create or replace function loyalty_verify_balances(p_program uuid)
returns table (member_id uuid, cached_points int, ledger_points bigint,
               cached_spend_cents bigint, ledger_spend_cents numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  select m.id, m.points_balance, coalesce(sum(l.points), 0),
         m.tier_spend_cents, coalesce(sum(l.spend_cents), 0)
    from loyalty_members m
    left join loyalty_ledger l on l.member_id = m.id
   where m.program_id = p_program
   group by m.id
  having m.points_balance <> coalesce(sum(l.points), 0)
      or m.tier_spend_cents <> coalesce(sum(l.spend_cents), 0);
$$;

revoke execute on function loyalty_append_only() from public, anon, authenticated;
revoke execute on function loyalty_tier_for_spend(uuid, bigint) from public, anon, authenticated;
revoke execute on function loyalty_order_points(uuid, bigint) from public, anon, authenticated;
revoke execute on function loyalty_milestones_crossed(uuid, int, int) from public, anon, authenticated;
revoke execute on function loyalty_enroll_member(uuid, bigint, text, text, text, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function loyalty_set_tier(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke execute on function loyalty_post_entry(uuid, int, text, text, bigint, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function loyalty_verify_balances(uuid) from public, anon, authenticated;

grant execute on function loyalty_tier_for_spend(uuid, bigint) to service_role;
grant execute on function loyalty_order_points(uuid, bigint) to service_role;
grant execute on function loyalty_milestones_crossed(uuid, int, int) to service_role;
grant execute on function loyalty_enroll_member(uuid, bigint, text, text, text, timestamptz, uuid) to service_role;
grant execute on function loyalty_set_tier(uuid, text, text, text, bigint) to service_role;
grant execute on function loyalty_post_entry(uuid, int, text, text, bigint, text, text, text, text, text, timestamptz) to service_role;
grant execute on function loyalty_verify_balances(uuid) to service_role;
