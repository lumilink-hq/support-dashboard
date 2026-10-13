-- =============================================================================
-- 0201_loyalty_shopify_sync.sql — LL Loyalty module 2: Shopify order, refund
-- and customer sync, plus the historical backfill.
-- Plan: docs/loyalty/PLAN.md. Builds on 0200 (loyalty_post_entry).
--
-- loyalty_shopify_apps — which LL Loyalty app(s) serve a store. Keyed by shop +
--   the app's client id, so the Phase 2 public app can sit beside the custom
--   one (plan §1). app_secret_ref names a Vault secret {"client_id",
--   "client_secret"}; token_ref the offline token once installed. The same
--   secret signs webhooks, so it is also how loyalty-webhooks verifies them.
--
-- loyalty_webhook_receipts — one row per delivery (X-Shopify-Webhook-Id): ids
--   and outcome only, never the payload (it carries customer PII).
--
-- loyalty_orders — one row per order we counted: what it earned and how much
--   has been refunded, so refunds/create can claw back proportionally and never
--   past the original.
--
-- ENROLLMENT. Joy auto-enrolls on Shopify ACCOUNT creation, so a customer is
--   enrolled when their state is 'enabled' (has an account), or for any
--   customer when loyalty_programs.enroll_guests is on. A guest who later
--   creates an account is enrolled by customers/update.
--
-- LIVE vs BACKFILL. live_since is set when the app is first installed (token
--   stored). Orders arriving by webhook earn points. The backfill walks orders
--   processed BEFORE live_since and records tier spend and order counts with 0
--   POINTS: opening balances come from the Joy import (module 8), so awarding
--   points here would pay those orders twice. Both paths use the same ledger
--   key 'order:<id>:earn', so an order is only ever counted once.
--
-- SPEND. Eligible amount = order subtotal after discounts, before shipping
--   and tax (shop currency). It counts toward tiers only for orders processed
--   on or after tier_spend_since. Refunds use refund line subtotals, the same
--   basis.
--
-- Test: scripts/test_loyalty_shopify_sync.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_programs add column if not exists enroll_guests boolean not null default false;
alter table loyalty_programs add column if not exists live_since timestamptz;

-- -----------------------------------------------------------------------------
-- Apps + tokens
-- -----------------------------------------------------------------------------
create table if not exists loyalty_shopify_apps (
  shop_domain     text        not null check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  app_client_id   text        not null check (length(app_client_id) between 8 and 100),
  program_id      uuid        not null references loyalty_programs(id) on delete cascade,
  app_secret_ref  text        not null,   -- vault.secrets NAME; JSON {"client_id","client_secret"}
  scopes          text        not null default 'read_orders,read_all_orders,read_customers,write_customers,write_discounts,read_products',
  token_ref       text,                   -- vault.secrets NAME of the offline token, once installed
  connected_at    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (shop_domain, app_client_id)
);

create index if not exists idx_loyalty_shopify_apps_program on loyalty_shopify_apps(program_id);

drop trigger if exists trg_loyalty_shopify_apps_updated_at on loyalty_shopify_apps;
create trigger trg_loyalty_shopify_apps_updated_at
  before update on loyalty_shopify_apps
  for each row execute function set_updated_at();

-- get_loyalty_shopify_apps — every app registered for a shop, with its
-- credentials. Webhook verification tries each; OAuth picks by client id.
create or replace function get_loyalty_shopify_apps(p_shop text)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'shop_domain',   a.shop_domain,
           'app_client_id', a.app_client_id,
           'program_id',    a.program_id,
           'scopes',        a.scopes,
           'credentials',   (select decrypted_secret from vault.decrypted_secrets where name = a.app_secret_ref)
         ) order by a.connected_at desc nulls last), '[]'::jsonb)
    from loyalty_shopify_apps a
   where a.shop_domain = lower(p_shop);
$$;

-- store_loyalty_shopify_token — after a successful OAuth exchange. First
-- install starts the program's live period.
create or replace function store_loyalty_shopify_token(p_shop text, p_app_client_id text, p_access_token text, p_scopes text[])
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_app    loyalty_shopify_apps%rowtype;
  v_name   text;
  v_secret uuid;
begin
  select * into v_app from loyalty_shopify_apps
   where shop_domain = lower(p_shop) and app_client_id = p_app_client_id for update;
  if not found then
    raise exception 'shop % / app % is not registered in loyalty_shopify_apps', p_shop, p_app_client_id;
  end if;
  if p_access_token is null or length(p_access_token) < 10 then
    raise exception 'no access token';
  end if;

  v_name := 'loyalty-shopify-token:' || v_app.shop_domain || ':' || v_app.app_client_id;
  select id into v_secret from vault.secrets where name = v_name;
  if v_secret is null then
    perform vault.create_secret(jsonb_build_object('access_token', p_access_token)::text, v_name,
      'LL Loyalty offline token for ' || v_app.shop_domain);
  else
    perform vault.update_secret(v_secret, jsonb_build_object('access_token', p_access_token)::text);
  end if;

  update loyalty_shopify_apps
     set token_ref = v_name, connected_at = now(), last_error = null,
         scopes = coalesce(array_to_string(p_scopes, ','), scopes)
   where shop_domain = v_app.shop_domain and app_client_id = v_app.app_client_id;
  update loyalty_programs set live_since = coalesce(live_since, now()) where id = v_app.program_id;
  return v_app.program_id;
end;
$$;

create or replace function mark_loyalty_shopify_error(p_shop text, p_app_client_id text, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update loyalty_shopify_apps set last_error = left(p_error, 500)
   where shop_domain = lower(p_shop) and app_client_id = p_app_client_id;
$$;

-- get_loyalty_shopify_token — the newest installed token for a program.
create or replace function get_loyalty_shopify_token(p_program uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
           'shop_domain',  a.shop_domain,
           'access_token', (select decrypted_secret::jsonb->>'access_token'
                              from vault.decrypted_secrets where name = a.token_ref))
    from loyalty_shopify_apps a
   where a.program_id = p_program and a.token_ref is not null
   order by a.connected_at desc
   limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Webhook receipts
-- -----------------------------------------------------------------------------
create table if not exists loyalty_webhook_receipts (
  shop_domain   text        not null,
  webhook_id    text        not null,
  topic         text        not null,
  received_at   timestamptz not null default now(),
  attempts      int         not null default 1,
  processed_at  timestamptz,
  outcome       text,
  error         text,
  primary key (shop_domain, webhook_id)
);

create index if not exists idx_loyalty_webhook_receipts_recent on loyalty_webhook_receipts(received_at);

-- loyalty_webhook_begin — true when this delivery still needs processing
-- (new, or an earlier attempt failed). A delivery already processed is false.
create or replace function loyalty_webhook_begin(p_shop text, p_webhook_id text, p_topic text)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_done timestamptz;
begin
  insert into loyalty_webhook_receipts (shop_domain, webhook_id, topic)
  values (lower(p_shop), p_webhook_id, p_topic)
  on conflict (shop_domain, webhook_id) do update
     set attempts = loyalty_webhook_receipts.attempts + 1
  returning processed_at into v_done;
  return v_done is null;
end;
$$;

create or replace function loyalty_webhook_finish(p_shop text, p_webhook_id text, p_outcome text, p_error text default null)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_webhook_receipts
     set processed_at = case when p_error is null then now() end,
         outcome = p_outcome,
         error = left(p_error, 500)
   where shop_domain = lower(p_shop) and webhook_id = p_webhook_id;
$$;

-- -----------------------------------------------------------------------------
-- Orders we counted
-- -----------------------------------------------------------------------------
create table if not exists loyalty_orders (
  program_id        uuid        not null references loyalty_programs(id) on delete cascade,
  shopify_order_id  bigint      not null check (shopify_order_id > 0),
  member_id         uuid        not null references loyalty_members(id) on delete cascade,
  order_name        text,
  eligible_cents    bigint      not null check (eligible_cents >= 0),
  refunded_cents    bigint      not null default 0 check (refunded_cents >= 0 and refunded_cents <= eligible_cents),
  spend_counted     boolean     not null,
  points_earned     int         not null default 0 check (points_earned >= 0),
  points_clawed     int         not null default 0 check (points_clawed >= 0 and points_clawed <= points_earned),
  source            text        not null check (source in ('webhook', 'backfill')),
  processed_at      timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (program_id, shopify_order_id)
);

create index if not exists idx_loyalty_orders_member on loyalty_orders(member_id);

drop trigger if exists trg_loyalty_orders_updated_at on loyalty_orders;
create trigger trg_loyalty_orders_updated_at
  before update on loyalty_orders
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- loyalty_sync_customer — p_customer: {id, email, first_name, last_name,
-- state, created_at}. Refreshes a member's contact fields, or enrolls the
-- customer if they qualify. Returns the member id, or null (not a member).
-- -----------------------------------------------------------------------------
create or replace function loyalty_sync_customer(p_program uuid, p_customer jsonb)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id     bigint := nullif(p_customer->>'id', '')::bigint;
  v_member uuid;
  v_guests boolean;
begin
  if v_id is null then
    return null;   -- guest checkout with no customer record
  end if;
  select id into v_member from loyalty_members where program_id = p_program and shopify_customer_id = v_id;
  select enroll_guests into v_guests from loyalty_programs where id = p_program and is_active;
  if v_member is null and not (coalesce(v_guests, false) or lower(p_customer->>'state') = 'enabled') then
    return null;
  end if;
  if v_guests is null and v_member is null then
    return null;   -- program inactive: refresh existing members only
  end if;
  return loyalty_enroll_member(
    p_program, v_id,
    nullif(p_customer->>'email', ''), nullif(p_customer->>'first_name', ''), nullif(p_customer->>'last_name', ''),
    nullif(p_customer->>'created_at', '')::timestamptz);
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_record_order — a paid order. p_order: {id, name, processed_at,
-- eligible_cents, net_eligible_cents (optional: after refunds already made;
-- backfill only), customer {…}}. p_source 'webhook' earns points, 'backfill'
-- earns none (see header).
--
-- Returns jsonb {status: 'recorded' | 'duplicate' | 'not_member', member_id,
-- points, orders_before, orders_after}. orders_before/after are for module 3's
-- milestones.
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
  v_r         jsonb;
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

  v_member := loyalty_sync_customer(p_program, p_order->'customer');
  if v_member is null then
    return jsonb_build_object('status', 'not_member');
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

  return jsonb_build_object(
    'status', case when (v_r->>'duplicate')::boolean then 'duplicate' else 'recorded' end,
    'member_id', v_member, 'points', v_points,
    'orders_before', v_before, 'orders_after', (v_r->>'paid_order_count')::int);
end;
$$;

-- loyalty_record_orders — the backfill's batch form. Returns counts by status.
create or replace function loyalty_record_orders(p_program uuid, p_orders jsonb, p_source text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_o      jsonb;
  v_status text;
  v_counts jsonb := '{"recorded":0,"duplicate":0,"not_member":0}'::jsonb;
begin
  for v_o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    v_status := loyalty_record_order(p_program, v_o, p_source)->>'status';
    v_counts := jsonb_set(v_counts, array[v_status], to_jsonb((v_counts->>v_status)::int + 1));
  end loop;
  return v_counts;
end;
$$;

-- loyalty_sync_customers — the backfill's batch customer form.
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
    if loyalty_sync_customer(p_program, v_c) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_record_refund — claws back points and tier spend in proportion to
-- the refunded share of the order's eligible amount. Cumulative, so several
-- partial refunds never take back more than the order earned.
-- Returns 'recorded' | 'duplicate' | 'unknown_order'.
-- -----------------------------------------------------------------------------
create or replace function loyalty_record_refund(
  p_program      uuid,
  p_order_id     bigint,
  p_refund_id    bigint,
  p_refund_cents bigint,
  p_occurred_at  timestamptz default null   -- null = now
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_o        loyalty_orders%rowtype;
  v_refunded bigint;
  v_target   int;
  v_points   int;
  v_spend    bigint;
begin
  select * into v_o from loyalty_orders
   where program_id = p_program and shopify_order_id = p_order_id for update;
  if not found then
    return 'unknown_order';   -- a guest's order, or one before the program existed
  end if;
  if exists (select 1 from loyalty_ledger
              where program_id = p_program and idempotency_key = 'refund:' || p_refund_id) then
    return 'duplicate';
  end if;

  v_refunded := least(v_o.eligible_cents, v_o.refunded_cents + greatest(coalesce(p_refund_cents, 0), 0));
  v_target := case when v_o.eligible_cents = 0 then v_o.points_earned
                   else floor(v_o.points_earned::numeric * v_refunded / v_o.eligible_cents)::int end;
  v_points := v_target - v_o.points_clawed;
  v_spend  := case when v_o.spend_counted then v_refunded - v_o.refunded_cents else 0 end;

  perform loyalty_post_entry(
    v_o.member_id, -v_points, 'refund', 'refund:' || p_refund_id, -v_spend,
    null, 'shopify_refund', p_refund_id::text, 'order ' || coalesce(v_o.order_name, p_order_id::text),
    'system', coalesce(p_occurred_at, now()));

  update loyalty_orders set refunded_cents = v_refunded, points_clawed = v_target
   where program_id = p_program and shopify_order_id = p_order_id;
  return 'recorded';
end;
$$;

-- -----------------------------------------------------------------------------
-- Privacy webhooks (plan §8b L1-8). customers/redact deletes the member and
-- everything hanging off them; shop/redact (48h after uninstall) deletes the
-- store's program, apps, tokens and receipts. Return rows deleted.
-- -----------------------------------------------------------------------------
create or replace function loyalty_redact_customer(p_shop text, p_customer_id bigint)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  delete from loyalty_members m
   using loyalty_programs p
   where p.id = m.program_id and p.shop_domain = lower(p_shop) and m.shopify_customer_id = p_customer_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function loyalty_redact_shop(p_shop text)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_n int;
begin
  delete from vault.secrets
   where name in (select token_ref from loyalty_shopify_apps where shop_domain = lower(p_shop) and token_ref is not null);
  delete from loyalty_webhook_receipts where shop_domain = lower(p_shop);
  delete from loyalty_programs where shop_domain = lower(p_shop);   -- cascades to apps, members, ledger, orders
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Backfill state. One row per program. phase 'customers' then 'orders'.
-- The loyalty-backfill edge function does a time-boxed slice per call and
-- saves its cursor; pg_cron re-invokes it until it reports done.
-- -----------------------------------------------------------------------------
create table if not exists loyalty_backfills (
  program_id     uuid        primary key references loyalty_programs(id) on delete cascade,
  status         text        not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  phase          text        not null default 'customers' check (phase in ('customers', 'orders')),
  cursor         text,
  before         timestamptz not null,   -- orders processed before this (the program's live_since)
  customers_seen int         not null default 0,
  members_synced int         not null default 0,
  orders_seen    int         not null default 0,
  orders_counted int         not null default 0,
  last_error     text,
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz
);

drop trigger if exists trg_loyalty_backfills_updated_at on loyalty_backfills;
create trigger trg_loyalty_backfills_updated_at
  before update on loyalty_backfills
  for each row execute function set_updated_at();

-- start_loyalty_backfill — (re)start from the beginning. Safe to re-run: every
-- order is keyed, so a second pass only fills gaps. Needs the app installed.
create or replace function start_loyalty_backfill(p_program uuid)
returns timestamptz
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_live timestamptz;
begin
  select live_since into v_live from loyalty_programs where id = p_program;
  if v_live is null then
    raise exception 'program % has no live_since yet: install the app first', p_program;
  end if;
  insert into loyalty_backfills (program_id, before)
  values (p_program, v_live)
  on conflict (program_id) do update
     set status = 'pending', phase = 'customers', cursor = null, before = excluded.before,
         customers_seen = 0, members_synced = 0, orders_seen = 0, orders_counted = 0,
         last_error = null, started_at = now(), finished_at = null;
  return v_live;
end;
$$;

-- request_loyalty_backfill — fire one slice. Null when pg_net or the Vault
-- secrets (loyalty_backfill_url, voice_tool_secret) are missing.
create or replace function request_loyalty_backfill(p_program uuid)
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
    raise notice 'pg_net not installed — cannot request a backfill slice';
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'loyalty_backfill_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';
  if v_url is null or v_secret is null then
    raise notice 'loyalty_backfill_url / voice_tool_secret not in Vault — cannot request a backfill slice';
    return null;
  end if;
  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 150000)'
    into v_req
    using v_url,
          jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
          jsonb_build_object('program_id', p_program::text);
  return v_req;
end;
$$;

-- run_due_loyalty_backfills — every minute: fire a slice for each unfinished
-- backfill that isn't mid-slice (a slice runs ~100s and touches updated_at).
create or replace function run_due_loyalty_backfills()
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
    select program_id from loyalty_backfills
     where status = 'pending' or (status = 'running' and updated_at < now() - interval '3 minutes')
  loop
    if request_loyalty_backfill(v_row.program_id) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — loyalty backfill NOT scheduled. Enable it, then re-run this migration.';
    return;
  end if;
  begin
    perform cron.unschedule('loyalty-backfill-due');
  exception when others then
    null;
  end;
  perform cron.schedule('loyalty-backfill-due', '* * * * *', $cron$select run_due_loyalty_backfills();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only (as 0200).
-- -----------------------------------------------------------------------------
alter table loyalty_shopify_apps     enable row level security;
alter table loyalty_webhook_receipts enable row level security;
alter table loyalty_orders           enable row level security;
alter table loyalty_backfills        enable row level security;

revoke all on loyalty_shopify_apps, loyalty_webhook_receipts, loyalty_orders, loyalty_backfills from anon, authenticated;
grant select, insert, update, delete on loyalty_shopify_apps, loyalty_webhook_receipts, loyalty_orders, loyalty_backfills to service_role;

revoke execute on function get_loyalty_shopify_apps(text) from public, anon, authenticated;
revoke execute on function store_loyalty_shopify_token(text, text, text, text[]) from public, anon, authenticated;
revoke execute on function mark_loyalty_shopify_error(text, text, text) from public, anon, authenticated;
revoke execute on function get_loyalty_shopify_token(uuid) from public, anon, authenticated;
revoke execute on function loyalty_webhook_begin(text, text, text) from public, anon, authenticated;
revoke execute on function loyalty_webhook_finish(text, text, text, text) from public, anon, authenticated;
revoke execute on function loyalty_sync_customer(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_record_order(uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function loyalty_record_orders(uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function loyalty_sync_customers(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_record_refund(uuid, bigint, bigint, bigint, timestamptz) from public, anon, authenticated;
revoke execute on function loyalty_redact_customer(text, bigint) from public, anon, authenticated;
revoke execute on function loyalty_redact_shop(text) from public, anon, authenticated;
revoke execute on function start_loyalty_backfill(uuid) from public, anon, authenticated;
revoke execute on function request_loyalty_backfill(uuid) from public, anon, authenticated;
revoke execute on function run_due_loyalty_backfills() from public, anon, authenticated;

grant execute on function get_loyalty_shopify_apps(text) to service_role;
grant execute on function store_loyalty_shopify_token(text, text, text, text[]) to service_role;
grant execute on function mark_loyalty_shopify_error(text, text, text) to service_role;
grant execute on function get_loyalty_shopify_token(uuid) to service_role;
grant execute on function loyalty_webhook_begin(text, text, text) to service_role;
grant execute on function loyalty_webhook_finish(text, text, text, text) to service_role;
grant execute on function loyalty_sync_customer(uuid, jsonb) to service_role;
grant execute on function loyalty_record_order(uuid, jsonb, text) to service_role;
grant execute on function loyalty_record_orders(uuid, jsonb, text) to service_role;
grant execute on function loyalty_sync_customers(uuid, jsonb) to service_role;
grant execute on function loyalty_record_refund(uuid, bigint, bigint, bigint, timestamptz) to service_role;
grant execute on function loyalty_redact_customer(text, bigint) to service_role;
grant execute on function loyalty_redact_shop(text) to service_role;
grant execute on function start_loyalty_backfill(uuid) to service_role;
grant execute on function request_loyalty_backfill(uuid) to service_role;
grant execute on function run_due_loyalty_backfills() to service_role;
