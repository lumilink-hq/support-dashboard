-- =============================================================================
-- 0206_loyalty_staff_admin.sql — LL Loyalty module 7: the staff admin
-- (member lookup, point adjustments, tier and birthday changes) and the
-- protected-data access log (plan §8b L2-6). Builds on 0200-0205.
--
-- STAFF, NOT TENANTS. Workspace roles (admin/agent/viewer, 0082) are per
-- client: Tsunami's own admin is an "admin". The loyalty admin is for LumiLink
-- staff only (plan §1), so it has its own list, platform_staff, changed only
-- by SQL (scripts/add-platform-staff.sql). Nobody can add themselves.
--
-- ENFORCED IN THE DATABASE. The /loyalty pages call these RPCs with the
-- signed-in user's normal session (no service role). Each one is SECURITY
-- DEFINER and starts with loyalty_require_staff(), which raises for anyone
-- not in platform_staff. A bug in a page can show an error, never data.
--
-- ACCESS LOG. Every RPC that returns or changes member data writes a
-- loyalty_access_log row itself (who, what, which member, when), so no
-- caller can skip it. Append-only. Member ids are plain uuids, not foreign
-- keys, so the log outlives a privacy deletion (it holds no PII itself).
--
-- Test: scripts/test_loyalty_staff_admin.sql. Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists platform_staff (
  user_id   uuid        primary key references auth.users(id) on delete cascade,
  email     text        not null,
  added_at  timestamptz not null default now(),
  added_by  text        not null default 'sql'
);

alter table platform_staff enable row level security;
revoke all on platform_staff from anon, authenticated;
grant select, insert, update, delete on platform_staff to service_role;

create or replace function current_user_is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from platform_staff where user_id = auth.uid());
$$;

-- -----------------------------------------------------------------------------
-- Access log
-- -----------------------------------------------------------------------------
create table if not exists loyalty_access_log (
  id             bigint      generated always as identity primary key,
  staff_user_id  uuid        not null,
  staff_email    text        not null,
  action         text        not null check (action in ('search', 'view', 'adjust', 'set_tier', 'set_birthday', 'data_requests')),
  program_id     uuid,
  member_id      uuid,
  detail         jsonb       not null default '{}'::jsonb,
  at             timestamptz not null default now()
);

create index if not exists idx_loyalty_access_log_at on loyalty_access_log(at);
create index if not exists idx_loyalty_access_log_member on loyalty_access_log(member_id, at);

drop trigger if exists trg_loyalty_access_log_append_only on loyalty_access_log;
create trigger trg_loyalty_access_log_append_only
  before update or delete on loyalty_access_log
  for each row execute function loyalty_append_only();

drop trigger if exists trg_loyalty_access_log_no_truncate on loyalty_access_log;
create trigger trg_loyalty_access_log_no_truncate
  before truncate on loyalty_access_log
  for each statement execute function loyalty_append_only();

alter table loyalty_access_log enable row level security;
revoke all on loyalty_access_log from anon, authenticated;
grant select, insert on loyalty_access_log to service_role;

-- loyalty_require_staff — raises unless the caller is staff; returns their email.
create or replace function loyalty_require_staff()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  select email into v_email from platform_staff where user_id = auth.uid();
  if v_email is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  return v_email;
end;
$$;

create or replace function loyalty_log_access(p_action text, p_program uuid, p_member uuid, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into loyalty_access_log (staff_user_id, staff_email, action, program_id, member_id, detail)
  select auth.uid(), s.email, p_action, p_program, p_member, coalesce(p_detail, '{}'::jsonb)
    from platform_staff s where s.user_id = auth.uid();
$$;

-- -----------------------------------------------------------------------------
-- Staff reads
-- -----------------------------------------------------------------------------

-- Programs (no member data: not logged).
create or replace function loyalty_staff_programs()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform loyalty_require_staff();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'shop_domain', p.shop_domain, 'client', c.name, 'is_active', p.is_active,
            'live_since', p.live_since, 'klaviyo_enabled_at', p.klaviyo_enabled_at,
            'members', (select count(*) from loyalty_members m where m.program_id = p.id),
            'points_outstanding', (select coalesce(sum(points_balance), 0) from loyalty_members m where m.program_id = p.id),
            'tiers', (select jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name) order by t.rank) from loyalty_tiers t where t.program_id = p.id))
          order by p.name), '[]'::jsonb)
            from loyalty_programs p join clients c on c.id = p.client_id);
end;
$$;

-- Search: email or name contains, or exact Shopify customer id / referral code.
create or replace function loyalty_staff_search(p_program uuid, p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q   text := nullif(trim(p_query), '');
  v_res jsonb;
begin
  perform loyalty_require_staff();
  if v_q is null or length(v_q) < 2 then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(x order by x->>'email'), '[]'::jsonb) into v_res from (
    select jsonb_build_object('id', m.id, 'email', m.email, 'first_name', m.first_name, 'last_name', m.last_name,
                              'shopify_customer_id', m.shopify_customer_id, 'tier', t.name, 'points', m.points_balance,
                              'status', m.status) as x
      from loyalty_members m join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
     where m.program_id = p_program
       and (m.email ilike '%' || v_q || '%'
            or (coalesce(m.first_name, '') || ' ' || coalesce(m.last_name, '')) ilike '%' || v_q || '%'
            or m.shopify_customer_id::text = v_q
            or m.referral_code = upper(v_q))
     order by m.email
     limit 50) s;
  perform loyalty_log_access('search', p_program, null, jsonb_build_object('query', v_q, 'results', jsonb_array_length(v_res)));
  return v_res;
end;
$$;

create or replace function loyalty_staff_member(p_member uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m loyalty_members%rowtype;
begin
  perform loyalty_require_staff();
  select * into v_m from loyalty_members where id = p_member;
  if not found then
    return null;
  end if;
  perform loyalty_log_access('view', v_m.program_id, v_m.id);
  return jsonb_build_object(
    'member', to_jsonb(v_m) - 'klaviyo_synced_hash' - 'shopify_synced_tier' - 'shopify_synced_points',
    'program', (select jsonb_build_object('id', id, 'name', name, 'shop_domain', shop_domain, 'timezone', timezone)
                  from loyalty_programs where id = v_m.program_id),
    'tier', (select jsonb_build_object('key', key, 'name', name, 'multiplier', earn_multiplier) from loyalty_tiers
              where program_id = v_m.program_id and key = v_m.tier_key),
    'tiers', (select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'min_spend_cents', min_spend_cents) order by rank)
                from loyalty_tiers where program_id = v_m.program_id),
    'referred_by', (select jsonb_build_object('id', r.id, 'email', r.email) from loyalty_members r where r.id = v_m.referred_by),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(l) - 'program_id' - 'member_id' order by l.id desc), '[]'::jsonb)
                 from (select * from loyalty_ledger where member_id = v_m.id order by id desc limit 100) l),
    'tier_changes', (select coalesce(jsonb_agg(to_jsonb(c) - 'program_id' - 'member_id' order by c.id desc), '[]'::jsonb)
                       from (select * from loyalty_tier_changes where member_id = v_m.id order by id desc limit 30) c),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('order_id', o.shopify_order_id, 'name', o.order_name, 'eligible_cents', o.eligible_cents,
                                                            'refunded_cents', o.refunded_cents, 'points_earned', o.points_earned,
                                                            'points_clawed', o.points_clawed, 'source', o.source, 'processed_at', o.processed_at)
                                         order by o.processed_at desc), '[]'::jsonb)
                 from (select * from loyalty_orders where member_id = v_m.id order by processed_at desc limit 30) o),
    'codes', (select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'reward_key', c.reward_key, 'value_cents', c.value_cents,
                                                           'points_spent', c.points_spent, 'status', c.status, 'last_error', c.last_error,
                                                           'created_at', c.created_at, 'used_order_id', c.used_order_id)
                                        order by c.created_at desc), '[]'::jsonb)
                from loyalty_discount_codes c where c.member_id = v_m.id),
    'referrals', (select coalesce(jsonb_agg(jsonb_build_object('friend_email', r.friend_email, 'status', r.status,
                                                               'reject_reason', r.reject_reason, 'created_at', r.created_at,
                                                               'completed_at', r.completed_at) order by r.created_at desc), '[]'::jsonb)
                    from loyalty_referrals r where r.referrer_id = v_m.id));
end;
$$;

-- Privacy data requests waiting on staff (customers/data_request webhooks).
create or replace function loyalty_staff_data_requests()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res jsonb;
begin
  perform loyalty_require_staff();
  select coalesce(jsonb_agg(jsonb_build_object('shop_domain', shop_domain, 'outcome', outcome, 'received_at', received_at)
                            order by received_at desc), '[]'::jsonb)
    into v_res
    from loyalty_webhook_receipts where topic = 'customers/data_request' and received_at > now() - interval '90 days';
  perform loyalty_log_access('data_requests', null, null, jsonb_build_object('count', jsonb_array_length(v_res)));
  return v_res;
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff writes. Each takes a note (why) that lands in the ledger / log.
-- -----------------------------------------------------------------------------

-- loyalty_staff_adjust — add or take points. p_request_key makes a double
-- submit of the same form a no-op. Returns {points_balance, duplicate} or
-- raises insufficient_points (an adjustment can't overdraw).
create or replace function loyalty_staff_adjust(p_member uuid, p_points int, p_note text, p_request_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := loyalty_require_staff();
  v_r     jsonb;
  v_prog  uuid;
begin
  if p_points is null or p_points = 0 or abs(p_points) > 100000 then
    raise exception 'points must be a non-zero whole number up to 100,000';
  end if;
  if length(coalesce(trim(p_note), '')) < 3 then
    raise exception 'a note is required (why the adjustment)';
  end if;
  if p_request_key is null or length(p_request_key) < 8 then
    raise exception 'request key required';
  end if;
  select program_id into v_prog from loyalty_members where id = p_member;
  if v_prog is null then
    raise exception 'member not found';
  end if;
  v_r := loyalty_post_entry(p_member, p_points, 'adjust', 'adjust:' || p_request_key, 0, null,
                            'staff', null, trim(p_note), v_email);
  if not (v_r->>'duplicate')::boolean then
    perform loyalty_log_access('adjust', v_prog, p_member, jsonb_build_object('points', p_points, 'note', trim(p_note)));
  end if;
  return jsonb_build_object('points_balance', v_r->'points_balance', 'duplicate', v_r->'duplicate');
end;
$$;

create or replace function loyalty_staff_set_tier(p_member uuid, p_tier_key text, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := loyalty_require_staff();
  v_prog    uuid;
  v_from    text;
  v_changed boolean;
begin
  if length(coalesce(trim(p_note), '')) < 3 then
    raise exception 'a note is required (why the tier change)';
  end if;
  select program_id, tier_key into v_prog, v_from from loyalty_members where id = p_member;
  if v_prog is null then
    raise exception 'member not found';
  end if;
  v_changed := loyalty_set_tier(p_member, p_tier_key, 'staff', v_email);
  if v_changed then
    perform loyalty_log_access('set_tier', v_prog, p_member,
      jsonb_build_object('from', v_from, 'to', p_tier_key, 'note', trim(p_note)));
  end if;
  return v_changed;
end;
$$;

-- Staff can change or clear a birthday the shopper can only set once.
create or replace function loyalty_staff_set_birthday(p_member uuid, p_birthday date, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog uuid;
  v_old  date;
begin
  perform loyalty_require_staff();
  if length(coalesce(trim(p_note), '')) < 3 then
    raise exception 'a note is required (why the change)';
  end if;
  if p_birthday is not null and (p_birthday > current_date or p_birthday < date '1900-01-01') then
    raise exception 'not a valid birthday';
  end if;
  select program_id, birthday into v_prog, v_old from loyalty_members where id = p_member;
  if v_prog is null then
    raise exception 'member not found';
  end if;
  update loyalty_members set birthday = p_birthday, birthday_set_at = case when p_birthday is null then null else now() end
   where id = p_member;
  perform loyalty_log_access('set_birthday', v_prog, p_member,
    jsonb_build_object('from', v_old, 'to', p_birthday, 'note', trim(p_note)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants. The staff RPCs are callable by any signed-in user and refuse
-- everyone not in platform_staff.
-- -----------------------------------------------------------------------------
revoke execute on function current_user_is_staff() from public, anon;
revoke execute on function loyalty_require_staff() from public, anon, authenticated;
revoke execute on function loyalty_log_access(text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_staff_programs() from public, anon;
revoke execute on function loyalty_staff_search(uuid, text) from public, anon;
revoke execute on function loyalty_staff_member(uuid) from public, anon;
revoke execute on function loyalty_staff_data_requests() from public, anon;
revoke execute on function loyalty_staff_adjust(uuid, int, text, text) from public, anon;
revoke execute on function loyalty_staff_set_tier(uuid, text, text) from public, anon;
revoke execute on function loyalty_staff_set_birthday(uuid, date, text) from public, anon;

grant execute on function current_user_is_staff() to authenticated, service_role;
grant execute on function loyalty_staff_programs() to authenticated;
grant execute on function loyalty_staff_search(uuid, text) to authenticated;
grant execute on function loyalty_staff_member(uuid) to authenticated;
grant execute on function loyalty_staff_data_requests() to authenticated;
grant execute on function loyalty_staff_adjust(uuid, int, text, text) to authenticated;
grant execute on function loyalty_staff_set_tier(uuid, text, text) to authenticated;
grant execute on function loyalty_staff_set_birthday(uuid, date, text) to authenticated;
