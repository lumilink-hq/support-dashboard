-- =============================================================================
-- 0203_loyalty_rewards_shopify.sql — LL Loyalty module 4: rewards and perks as
-- Shopify discounts, and the member tier/points pushed to Shopify.
-- Plan: docs/loyalty/PLAN.md. Builds on 0200-0202.
--
-- CODES (loyalty_discount_codes). A redemption debits the points FIRST
-- (loyalty_redeem: same idempotent ledger, so a double click can't spend
-- twice), then a 'pending' code row waits for the loyalty-shopify edge
-- function to create it in Shopify (discountCodeBasicCreate: single use, this
-- customer only). After 5 failed attempts the code is 'failed' and the points
-- come back as a 'redeem_reversal'. The referred friend's coupon is the same
-- kind of row, created by a trigger when the referral is created (no points;
-- open to any customer, since the friend has no account yet). A paid order
-- that uses a code marks it 'used'.
--
-- PERKS (loyalty_perks). Tier perks are AUTOMATIC Shopify discounts limited to
-- customer segments (2026-10 discounts take context.customerSegments), so no
-- Shopify Function is needed. Each tier gets a segment matching its customer
-- tag ('LL Tier Gold'); a perk applies to its tier and every tier above. When a
-- perk's config changes (config_hash), the old discount is deleted and a new
-- one created. Deactivating a perk deletes its discount.
--
-- MEMBER SYNC. Each member's tier is carried to Shopify as a customer tag
-- (what segments match) and as metafields ll_loyalty.tier / ll_loyalty.points
-- (what the theme reads; merchant-owned namespace, plan §1). A member whose
-- tier or points differ from what was last pushed is due.
--
-- run_due_loyalty_shopify() (pg_cron, every minute) calls the edge function
-- only for programs that have something to do.
--
-- Test: scripts/test_loyalty_rewards_shopify.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_rewards  add column if not exists combines jsonb not null default '{}'::jsonb;
alter table loyalty_rewards  add column if not exists expires_after interval;   -- null = the code never expires
alter table loyalty_tiers    add column if not exists shopify_segment_id text;
alter table loyalty_programs add column if not exists shopify_definitions_at timestamptz;
alter table loyalty_members  add column if not exists shopify_synced_tier text;
alter table loyalty_members  add column if not exists shopify_synced_points int;
alter table loyalty_members  add column if not exists shopify_synced_at timestamptz;
alter table loyalty_members  add column if not exists shopify_sync_error text;

create index if not exists idx_loyalty_members_shopify_due on loyalty_members(program_id)
  where tier_key is distinct from shopify_synced_tier or points_balance is distinct from shopify_synced_points;

-- -----------------------------------------------------------------------------
-- Codes
-- -----------------------------------------------------------------------------
create table if not exists loyalty_discount_codes (
  id                   uuid        primary key default gen_random_uuid(),
  program_id           uuid        not null references loyalty_programs(id) on delete cascade,
  member_id            uuid        references loyalty_members(id) on delete cascade,
  referral_id          uuid        unique references loyalty_referrals(id) on delete cascade,
  reward_key           text        not null,
  code                 text        not null,
  title                text        not null,
  value_cents          bigint      not null check (value_cents > 0),
  min_order_cents      bigint      not null default 0,
  points_spent         int         not null default 0 check (points_spent >= 0),
  combines             jsonb       not null default '{}'::jsonb,
  ends_at              timestamptz,
  request_key          text,
  status               text        not null default 'pending' check (status in ('pending', 'issued', 'failed', 'used')),
  attempts             int         not null default 0,
  last_error           text,
  shopify_discount_id  text,
  issued_at            timestamptz,
  used_order_id        bigint,
  used_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (member_id is not null or referral_id is not null)
);

create unique index if not exists uq_loyalty_discount_codes_code on loyalty_discount_codes(program_id, upper(code));
create unique index if not exists uq_loyalty_discount_codes_request on loyalty_discount_codes(program_id, request_key) where request_key is not null;
create index if not exists idx_loyalty_discount_codes_pending on loyalty_discount_codes(program_id, created_at) where status = 'pending';
create index if not exists idx_loyalty_discount_codes_member on loyalty_discount_codes(member_id);

drop trigger if exists trg_loyalty_discount_codes_updated_at on loyalty_discount_codes;
create trigger trg_loyalty_discount_codes_updated_at
  before update on loyalty_discount_codes
  for each row execute function set_updated_at();

-- loyalty_new_code — prefix + 8 characters with no look-alikes (no 0/O, 1/I/L).
create or replace function loyalty_new_code(p_prefix text)
returns text
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  v_alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := gen_random_bytes(8);
  v_out   text := coalesce(p_prefix, '');
begin
  for i in 0..7 loop
    v_out := v_out || substr(v_alpha, 1 + (get_byte(v_bytes, i) % length(v_alpha)), 1);
  end loop;
  return v_out;
end;
$$;

-- loyalty_redeem — spend points on a reward. p_request_key makes a retried
-- request (double click, network retry) return the same code.
-- Returns {status: 'pending' | 'duplicate' | 'insufficient_points' | 'unknown_reward', code_id, code}.
create or replace function loyalty_redeem(p_member uuid, p_reward_key text, p_request_key text)
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
  select * into v_p from loyalty_programs where id = v_m.program_id;

  begin
    perform loyalty_post_entry(p_member, -v_rw.points_cost, 'redeem', 'redeem:' || p_request_key, 0,
                               v_rw.key, 'reward', v_id::text, null, 'member');
  exception when others then
    if sqlerrm like 'insufficient_points%' then
      return jsonb_build_object('status', 'insufficient_points', 'points_balance', v_m.points_balance, 'points_cost', v_rw.points_cost);
    end if;
    raise;
  end;

  loop
    v_text := loyalty_new_code(v_p.discount_code_prefix);
    exit when not exists (select 1 from loyalty_discount_codes where program_id = v_m.program_id and upper(code) = v_text);
  end loop;
  insert into loyalty_discount_codes (id, program_id, member_id, reward_key, code, title, value_cents,
                                      min_order_cents, points_spent, combines, ends_at, request_key)
  values (v_id, v_m.program_id, p_member, v_rw.key, v_text, v_p.name || ': ' || v_rw.name, v_rw.value_cents,
          v_rw.min_order_cents, v_rw.points_cost, v_rw.combines, now() + v_rw.expires_after, p_request_key);
  return jsonb_build_object('status', 'pending', 'code_id', v_id, 'code', v_text);
end;
$$;

-- Referral: the friend's coupon is created with the referral. BEFORE sets the
-- code on the referral; AFTER queues it for Shopify. No 'referral_friend'
-- reward (or inactive) = no code.
create or replace function loyalty_referral_code_before()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
begin
  if new.discount_code is null
     and exists (select 1 from loyalty_rewards where program_id = new.program_id and key = 'referral_friend' and is_active) then
    select discount_code_prefix into v_prefix from loyalty_programs where id = new.program_id;
    loop
      new.discount_code := loyalty_new_code(v_prefix || 'REF-');
      exit when not exists (select 1 from loyalty_discount_codes where program_id = new.program_id and upper(code) = new.discount_code)
            and not exists (select 1 from loyalty_referrals where program_id = new.program_id and upper(discount_code) = new.discount_code);
    end loop;
  end if;
  return new;
end;
$$;

create or replace function loyalty_referral_code_after()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.discount_code is not null then
    insert into loyalty_discount_codes (program_id, referral_id, reward_key, code, title, value_cents, min_order_cents, combines, ends_at)
    select new.program_id, new.id, r.key, new.discount_code, p.name || ': ' || r.name, r.value_cents, r.min_order_cents,
           r.combines, now() + r.expires_after
      from loyalty_rewards r join loyalty_programs p on p.id = r.program_id
     where r.program_id = new.program_id and r.key = 'referral_friend' and r.is_active
    on conflict do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_loyalty_referral_code_before on loyalty_referrals;
create trigger trg_loyalty_referral_code_before
  before insert on loyalty_referrals
  for each row execute function loyalty_referral_code_before();

drop trigger if exists trg_loyalty_referral_code_after on loyalty_referrals;
create trigger trg_loyalty_referral_code_after
  after insert on loyalty_referrals
  for each row execute function loyalty_referral_code_after();

-- loyalty_codes_to_issue — pending codes for the edge function, oldest first.
create or replace function loyalty_codes_to_issue(p_program uuid, p_limit int default 25)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) from (
    select c.id, c.code, c.title, c.value_cents, c.min_order_cents, c.combines, c.ends_at, c.created_at,
           m.shopify_customer_id as customer_id
      from loyalty_discount_codes c
      left join loyalty_members m on m.id = c.member_id
     where c.program_id = p_program and c.status = 'pending'
     order by c.created_at
     limit p_limit
  ) x;
$$;

create or replace function loyalty_code_issued(p_code uuid, p_shopify_discount_id text)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_discount_codes
     set status = 'issued', shopify_discount_id = p_shopify_discount_id, issued_at = now(), last_error = null
   where id = p_code and status = 'pending';
$$;

-- loyalty_code_failed — one failed attempt. The 5th is final: the code is
-- 'failed', points come back, a referral loses its (never-created) code.
-- Returns true when final.
create or replace function loyalty_code_failed(p_code uuid, p_error text, p_max_attempts int default 5)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_c loyalty_discount_codes%rowtype;
begin
  update loyalty_discount_codes set attempts = attempts + 1, last_error = left(p_error, 500)
   where id = p_code and status = 'pending'
  returning * into v_c;
  if not found or v_c.attempts < p_max_attempts then
    return false;
  end if;
  update loyalty_discount_codes set status = 'failed' where id = p_code;
  if v_c.points_spent > 0 and v_c.member_id is not null then
    perform loyalty_post_entry(v_c.member_id, v_c.points_spent, 'redeem_reversal', 'redeem_reversal:' || v_c.id, 0,
                               v_c.reward_key, 'reward', v_c.id::text, 'Shopify code could not be created', 'system');
  end if;
  if v_c.referral_id is not null then
    update loyalty_referrals set discount_code = null where id = v_c.referral_id;
  end if;
  return true;
end;
$$;

-- loyalty_mark_codes_used — a paid order's discount codes that are ours.
create or replace function loyalty_mark_codes_used(p_program uuid, p_order jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update loyalty_discount_codes
     set status = 'used', used_order_id = (p_order->>'id')::bigint,
         used_at = coalesce(nullif(p_order->>'processed_at', '')::timestamptz, now())
   where program_id = p_program and status in ('issued', 'pending')
     and upper(code) in (select upper(c) from jsonb_array_elements_text(coalesce(p_order->'discount_codes', '[]'::jsonb)) c);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Perks
-- -----------------------------------------------------------------------------
create table if not exists loyalty_perks (
  id                   uuid        primary key default gen_random_uuid(),
  program_id           uuid        not null references loyalty_programs(id) on delete cascade,
  key                  text        not null check (key ~ '^[a-z0-9_]+$'),
  tier_key             text        not null,                 -- this tier and above
  title                text        not null,                 -- shown at checkout
  kind                 text        not null check (kind in ('free_shipping', 'percent_off_products')),
  min_subtotal_cents   bigint      not null default 0 check (min_subtotal_cents >= 0),
  percent              numeric(5,2) check (percent > 0 and percent <= 100),
  collection_gids      text[]      not null default '{}',
  product_gids         text[]      not null default '{}',
  combines             jsonb       not null default '{}'::jsonb,
  is_active            boolean     not null default true,
  shopify_discount_id  text,
  synced_hash          text,
  synced_at            timestamptz,
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (program_id, key),
  foreign key (program_id, tier_key) references loyalty_tiers(program_id, key) on update cascade,
  check (kind <> 'percent_off_products' or (percent is not null and (cardinality(collection_gids) > 0 or cardinality(product_gids) > 0)))
);

drop trigger if exists trg_loyalty_perks_updated_at on loyalty_perks;
create trigger trg_loyalty_perks_updated_at
  before update on loyalty_perks
  for each row execute function set_updated_at();

-- What a perk should look like in Shopify now; its hash says whether to redo it.
create or replace function loyalty_perk_config(p_perk uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'key', k.key, 'title', k.title, 'kind', k.kind, 'min_subtotal_cents', k.min_subtotal_cents,
    'percent', k.percent, 'collection_gids', to_jsonb(k.collection_gids), 'product_gids', to_jsonb(k.product_gids),
    'combines', k.combines,
    'segment_ids', (select coalesce(jsonb_agg(t.shopify_segment_id order by t.rank), '[]'::jsonb)
                      from loyalty_tiers t
                     where t.program_id = k.program_id
                       and t.rank >= (select rank from loyalty_tiers where program_id = k.program_id and key = k.tier_key)))
  from loyalty_perks k where k.id = p_perk;
$$;

-- loyalty_shopify_work — everything the edge function should do for a
-- program: tiers missing a segment, perks to (re)create or remove, and
-- whether the metafield definitions exist.
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
begin
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

  return jsonb_build_object(
    'tiers', v_tiers,
    'segment_min_rank', v_min,
    'perks', v_perks,
    'definitions_needed', (select shopify_definitions_at is null from loyalty_programs where id = p_program));
end;
$$;

create or replace function loyalty_set_tier_segment(p_tier uuid, p_segment_id text)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_tiers set shopify_segment_id = p_segment_id where id = p_tier;
$$;

-- p_discount_id is the discount that exists in Shopify NOW (null = none:
-- removed, or deleted before a failed re-create). The hash only moves on
-- success, so a failure is retried.
create or replace function loyalty_perk_synced(p_perk uuid, p_discount_id text, p_hash text, p_error text default null)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_perks
     set shopify_discount_id = p_discount_id,
         synced_hash         = case when p_error is null then p_hash else synced_hash end,
         synced_at           = case when p_error is null then now() else synced_at end,
         last_error          = left(p_error, 500)
   where id = p_perk;
$$;

create or replace function loyalty_definitions_done(p_program uuid)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_programs set shopify_definitions_at = now() where id = p_program;
$$;

-- -----------------------------------------------------------------------------
-- Member tier/points sync
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
                                'tier_changed', m.tier_key is distinct from m.shopify_synced_tier) as x
        from loyalty_members m
        join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
       where m.program_id = p_program
         and (m.tier_key is distinct from m.shopify_synced_tier or m.points_balance is distinct from m.shopify_synced_points)
       order by m.shopify_synced_at nulls first
       limit p_limit) s), '[]'::jsonb));
$$;

-- p_items: [{member_id, tier_key, points, error}] — what was pushed (error = not pushed).
create or replace function loyalty_mark_members_synced(p_items jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update loyalty_members m
     set shopify_synced_tier   = case when i.error is null then i.tier_key else m.shopify_synced_tier end,
         shopify_synced_points = case when i.error is null then i.points else m.shopify_synced_points end,
         shopify_synced_at     = now(),
         shopify_sync_error    = left(i.error, 500)
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(member_id uuid, tier_key text, points int, error text)
   where m.id = i.member_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Dispatch: only programs with work, every minute.
-- -----------------------------------------------------------------------------
create or replace function loyalty_shopify_has_work(p_program uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from loyalty_discount_codes where program_id = p_program and status = 'pending')
      or exists (select 1 from loyalty_members where program_id = p_program
                  and (tier_key is distinct from shopify_synced_tier or points_balance is distinct from shopify_synced_points)
                  and (shopify_synced_at is null or shopify_sync_error is null or shopify_synced_at < now() - interval '15 minutes'))
      or jsonb_array_length(loyalty_shopify_work(p_program)->'perks') > 0
      or (select shopify_definitions_at is null from loyalty_programs where id = p_program);
$$;

create or replace function request_loyalty_shopify(p_program uuid)
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
    raise notice 'pg_net not installed — cannot request a Shopify sync';
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'loyalty_shopify_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';
  if v_url is null or v_secret is null then
    raise notice 'loyalty_shopify_url / voice_tool_secret not in Vault — cannot request a Shopify sync';
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

create or replace function run_due_loyalty_shopify()
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
       and exists (select 1 from loyalty_shopify_apps a where a.program_id = p.id and a.token_ref is not null)
  loop
    if loyalty_shopify_has_work(v_row.id) and request_loyalty_shopify(v_row.id) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — loyalty Shopify sync NOT scheduled. Enable it, then re-run this migration.';
    return;
  end if;
  begin
    perform cron.unschedule('loyalty-shopify-due');
  exception when others then
    null;
  end;
  perform cron.schedule('loyalty-shopify-due', '* * * * *', $cron$select run_due_loyalty_shopify();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only (as 0200).
-- -----------------------------------------------------------------------------
alter table loyalty_discount_codes enable row level security;
alter table loyalty_perks          enable row level security;
revoke all on loyalty_discount_codes, loyalty_perks from anon, authenticated;
grant select, insert, update, delete on loyalty_discount_codes, loyalty_perks to service_role;

revoke execute on function loyalty_new_code(text) from public, anon, authenticated;
revoke execute on function loyalty_redeem(uuid, text, text) from public, anon, authenticated;
revoke execute on function loyalty_referral_code_before() from public, anon, authenticated;
revoke execute on function loyalty_referral_code_after() from public, anon, authenticated;
revoke execute on function loyalty_codes_to_issue(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_code_issued(uuid, text) from public, anon, authenticated;
revoke execute on function loyalty_code_failed(uuid, text, int) from public, anon, authenticated;
revoke execute on function loyalty_mark_codes_used(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_perk_config(uuid) from public, anon, authenticated;
revoke execute on function loyalty_shopify_work(uuid) from public, anon, authenticated;
revoke execute on function loyalty_set_tier_segment(uuid, text) from public, anon, authenticated;
revoke execute on function loyalty_perk_synced(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function loyalty_definitions_done(uuid) from public, anon, authenticated;
revoke execute on function loyalty_members_to_sync(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_mark_members_synced(jsonb) from public, anon, authenticated;
revoke execute on function loyalty_shopify_has_work(uuid) from public, anon, authenticated;
revoke execute on function request_loyalty_shopify(uuid) from public, anon, authenticated;
revoke execute on function run_due_loyalty_shopify() from public, anon, authenticated;

grant execute on function loyalty_new_code(text) to service_role;
grant execute on function loyalty_redeem(uuid, text, text) to service_role;
grant execute on function loyalty_codes_to_issue(uuid, int) to service_role;
grant execute on function loyalty_code_issued(uuid, text) to service_role;
grant execute on function loyalty_code_failed(uuid, text, int) to service_role;
grant execute on function loyalty_mark_codes_used(uuid, jsonb) to service_role;
grant execute on function loyalty_perk_config(uuid) to service_role;
grant execute on function loyalty_shopify_work(uuid) to service_role;
grant execute on function loyalty_set_tier_segment(uuid, text) to service_role;
grant execute on function loyalty_perk_synced(uuid, text, text, text) to service_role;
grant execute on function loyalty_definitions_done(uuid) to service_role;
grant execute on function loyalty_members_to_sync(uuid, int) to service_role;
grant execute on function loyalty_mark_members_synced(jsonb) to service_role;
grant execute on function loyalty_shopify_has_work(uuid) to service_role;
grant execute on function request_loyalty_shopify(uuid) to service_role;
grant execute on function run_due_loyalty_shopify() to service_role;
