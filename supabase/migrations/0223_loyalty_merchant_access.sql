-- =============================================================================
-- 0223_loyalty_merchant_access.sql - LL Loyalty Phase 2 module P2
-- Plan: docs/loyalty/PLAN.md section 7, Merchant access.
--
-- Who may manage a program (loyalty_can_manage):
--   * platform staff - any program, as before
--   * a workspace admin (users.role admin, active) of the client that owns the
--     program, ONLY when the program has merchant_access on. Self-serve
--     programs (0222) get it on creation. Tsunami stays off until someone
--     turns it on, so its admins still cannot open /loyalty (plan section 1).
-- Both need an MFA-verified (aal2) session, the same rule as 0210.
--
-- loyalty_require_manager(program) replaces loyalty_require_staff() in every
-- program-scoped staff RPC. A null program (member, campaign or challenge not
-- found) passes only for staff, who then get the usual not-found error.
-- loyalty_require_staff() itself is unchanged - outbound_require_staff and
-- loyalty_staff_data_requests keep using it, so data requests stay staff only.
--
-- Also staff only: gross margin (merchants can save settings, the margin is
-- kept), the program list across stores (merchants see only their own).
--
-- Access log: rows now record actor_kind (staff or merchant). Columns keep
-- their names (staff_user_id, staff_email hold whoever acted).
--
-- Comment rule (plan section 1): no semicolons or apostrophes in top-level
-- comments.
--
-- Test: scripts/test_loyalty_merchant_access.sql.
-- =============================================================================

alter table loyalty_programs add column if not exists merchant_access boolean not null default false;
alter table loyalty_access_log add column if not exists actor_kind text not null default 'staff'
  check (actor_kind in ('staff', 'merchant'));

update loyalty_programs set merchant_access = true where created_via = 'self_serve' and not merchant_access;

-- Self-serve programs start with merchant access on.
create or replace function loyalty_programs_self_serve_access()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.created_via = 'self_serve' then
    new.merchant_access := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_loyalty_programs_self_serve_access on loyalty_programs;
create trigger trg_loyalty_programs_self_serve_access
  before insert on loyalty_programs
  for each row execute function loyalty_programs_self_serve_access();

create or replace function loyalty_is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from platform_staff where user_id = auth.uid());
$$;

-- loyalty_can_manage - staff, or an active admin of the owning workspace on a
-- program with merchant access. No MFA check here (loyalty_require_manager).
create or replace function loyalty_can_manage(p_program uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select loyalty_is_staff()
      or exists (select 1
                   from loyalty_programs p
                   join users u on u.client_id = p.client_id
                  where p.id = p_program and p.merchant_access
                    and u.id = auth.uid() and u.is_active and u.role = 'admin');
$$;

-- loyalty_require_manager - the gate inside every program-scoped staff RPC.
-- Returns the email of whoever is acting.
create or replace function loyalty_require_manager(p_program uuid)
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
    if p_program is null or not loyalty_can_manage(p_program) then
      raise exception 'not_staff' using errcode = '42501';
    end if;
    select email into v_email from users where id = auth.uid();
  end if;
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
  return v_email;
end;
$$;

-- loyalty_require_manager_any - staff, or a merchant who manages some program.
create or replace function loyalty_require_manager_any()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog uuid;
begin
  if loyalty_is_staff() then
    return loyalty_require_staff();
  end if;
  select p.id into v_prog
    from loyalty_programs p join users u on u.client_id = p.client_id
   where u.id = auth.uid() and p.merchant_access
   limit 1;
  return loyalty_require_manager(v_prog);
end;
$$;

-- loyalty_manager_role - for the pages: staff, merchant or none. Says nothing
-- about MFA (loyalty_staff_access does).
create or replace function loyalty_manager_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when loyalty_is_staff() then 'staff'
    when exists (select 1 from loyalty_programs p
                  where loyalty_can_manage(p.id)) then 'merchant'
    else 'none'
  end;
$$;

-- loyalty_staff_access - now also lets a merchant admin reach the MFA steps.
create or replace function loyalty_staff_access()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when loyalty_manager_role() = 'none' then 'none'
    when not exists (select 1 from auth.mfa_factors f
                      where f.user_id = auth.uid() and f.status = 'verified') then 'enroll'
    when coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then 'verify'
    else 'ok'
  end;
$$;

-- loyalty_log_access - staff rows as before, merchant rows marked merchant.
create or replace function loyalty_log_access(p_action text, p_program uuid, p_member uuid, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into loyalty_access_log (staff_user_id, staff_email, action, program_id, member_id, detail, actor_kind)
  select auth.uid(), a.email, p_action, p_program, p_member, coalesce(p_detail, '{}'::jsonb), a.kind
    from (select s.email, 'staff' as kind from platform_staff s where s.user_id = auth.uid()
          union all
          select u.email, 'merchant' from users u
           where u.id = auth.uid()
             and not exists (select 1 from platform_staff s where s.user_id = auth.uid())
             and loyalty_can_manage(p_program)) a;
$$;

revoke execute on function loyalty_programs_self_serve_access() from public, anon, authenticated;
revoke execute on function loyalty_is_staff() from public, anon, authenticated;
revoke execute on function loyalty_can_manage(uuid) from public, anon, authenticated;
revoke execute on function loyalty_require_manager(uuid) from public, anon, authenticated;
revoke execute on function loyalty_require_manager_any() from public, anon, authenticated;
revoke execute on function loyalty_manager_role() from public, anon;
grant execute on function loyalty_manager_role() to authenticated;

-- -----------------------------------------------------------------------------
-- The staff RPCs again, each from its latest migration, with the staff check
-- replaced by the program check. Nothing else in them changed except the
-- gross margin line in loyalty_staff_program_save (staff only).
-- -----------------------------------------------------------------------------

-- loyalty_staff_search, from 0206_loyalty_staff_admin
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
  perform loyalty_require_manager(p_program);
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

-- loyalty_staff_members, from 0219_loyalty_staff_members_list
create or replace function loyalty_staff_members(
  p_program uuid,
  p_filters jsonb default '{}'::jsonb,
  p_sort    text  default 'points',
  p_dir     text  default 'desc',
  p_page    int   default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p      loyalty_programs%rowtype;
  v_f      jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q      text := nullif(trim(v_f->>'q'), '');
  v_tier   text := nullif(v_f->>'tier', '');
  v_status text := nullif(v_f->>'status', '');
  v_group  text := nullif(v_f->>'group', '');
  v_redeem boolean := coalesce((v_f->>'can_redeem')::boolean, false);
  v_demote boolean := coalesce((v_f->>'demotes_30d')::boolean, false);
  v_expire boolean := coalesce((v_f->>'expires_30d')::boolean, false);
  v_sort   text := case when p_sort in ('points', 'spend', 'last_order') then p_sort else 'points' end;
  v_asc    boolean := lower(coalesce(p_dir, 'desc')) = 'asc';
  v_page   int := greatest(coalesce(p_page, 1), 1);
  v_size   constant int := 50;
  v_cheap  int;
  v_low    int;
  v_soon   timestamptz := now() + interval '30 days';
  v_total  int;
  v_rows   jsonb;
begin
  perform loyalty_require_manager(p_program);
  select * into v_p from loyalty_programs where id = p_program;
  if not found then
    return null;
  end if;
  if v_q is not null and length(v_q) < 2 then
    v_q := null;
  end if;
  select min(points_cost) into v_cheap from loyalty_rewards
   where program_id = p_program and is_active and points_cost is not null;
  select min(rank) into v_low from loyalty_tiers where program_id = p_program;

  with f as (
    select m.*, t.name as tier_name, t.rank as tier_rank
      from loyalty_members m
      join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
     where m.program_id = p_program
       and (v_q is null
            or m.email ilike '%' || v_q || '%'
            or (coalesce(m.first_name, '') || ' ' || coalesce(m.last_name, '')) ilike '%' || v_q || '%'
            or m.shopify_customer_id::text = v_q
            or m.referral_code = upper(v_q))
       and (v_tier is null or m.tier_key = v_tier)
       and (v_status is null or m.status = v_status)
       and (v_group is null
            or (v_group = 'holdout'   and m.holdout_bucket <  v_p.holdout_percent)
            or (v_group = 'treatment' and m.holdout_bucket >= v_p.holdout_percent))
       and (not v_redeem or (v_cheap is not null and m.points_balance >= v_cheap))
       and (not v_demote or (t.rank > v_low and v_p.demote_after_inactive is not null
            and coalesce(greatest(m.last_order_at, m.last_demoted_at), m.enrolled_at) + v_p.demote_after_inactive <= v_soon))
       and (not v_expire or (m.points_balance > 0 and v_p.points_expire_after is not null
            and coalesce(m.last_activity_at, m.enrolled_at) + v_p.points_expire_after <= v_soon))
  ), s as (
    select f.*, count(*) over () as n,
           row_number() over (order by
             case when not v_asc and v_sort = 'points'     then f.points_balance   end desc nulls last,
             case when     v_asc and v_sort = 'points'     then f.points_balance   end asc  nulls last,
             case when not v_asc and v_sort = 'spend'      then f.tier_spend_cents end desc nulls last,
             case when     v_asc and v_sort = 'spend'      then f.tier_spend_cents end asc  nulls last,
             case when not v_asc and v_sort = 'last_order' then f.last_order_at    end desc nulls last,
             case when     v_asc and v_sort = 'last_order' then f.last_order_at    end asc  nulls last,
             f.email, f.id) as rn
      from f
  )
  select coalesce(max(n), 0)::int,
         coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'first_name', s.first_name, 'last_name', s.last_name, 'email', s.email,
           'tier', s.tier_name, 'points', s.points_balance, 'tier_spend_cents', s.tier_spend_cents,
           'orders', s.paid_order_count, 'last_order_at', s.last_order_at,
           'group', case when s.holdout_bucket < v_p.holdout_percent then 'holdout' else 'treatment' end,
           'status', s.status) order by s.rn) filter (where s.rn > (v_page - 1) * v_size and s.rn <= v_page * v_size), '[]'::jsonb)
    into v_total, v_rows
    from s;

  perform loyalty_log_access('list', p_program, null, jsonb_build_object(
    'filters', v_f - 'q' || case when v_q is null then '{}'::jsonb else jsonb_build_object('q', v_q) end,
    'sort', v_sort, 'dir', case when v_asc then 'asc' else 'desc' end,
    'page', v_page, 'results', jsonb_array_length(v_rows), 'total', v_total));

  return jsonb_build_object('total', v_total, 'page', v_page, 'page_size', v_size, 'rows', v_rows,
                            'sort', v_sort, 'dir', case when v_asc then 'asc' else 'desc' end);
end;
$$;

-- loyalty_staff_insights, from 0211_loyalty_measurement
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

-- loyalty_staff_insights_detail, from 0213_loyalty_insights_views
create or replace function loyalty_staff_insights_detail(p_program uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform loyalty_require_manager(p_program);
  if p_to - p_from > 731 then
    raise exception 'period is limited to 2 years';
  end if;
  return loyalty_insights_detail(p_program, p_from, p_to);
end;
$$;

-- loyalty_staff_campaigns, from 0215_loyalty_campaign_console
create or replace function loyalty_staff_campaigns(p_program uuid)
returns jsonb
language plpgsql
security definer   -- volatile: loyalty_insights fills a temp table
set search_path = public, pg_temp
as $$
declare
  v_prog  loyalty_programs%rowtype;
  v_c     loyalty_campaigns%rowtype;
  v_out   jsonb := '[]'::jsonb;
  v_res   jsonb;
  v_from  date;
  v_to    date;
  v_lift  jsonb;
  v_today date;
begin
  perform loyalty_require_manager(p_program);
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  v_today := (now() at time zone v_prog.timezone)::date;

  for v_c in
    select * from loyalty_campaigns where program_id = p_program order by starts_at desc limit 50
  loop
    select jsonb_build_object(
             'orders', count(*),
             'members', count(distinct l.member_id),
             'bonus_points', coalesce(sum(l.points), 0),
             'revenue_cents', coalesce(sum(o.eligible_cents - o.refunded_cents), 0))
      into v_res
      from loyalty_ledger l
      left join loyalty_orders o on o.program_id = l.program_id and o.shopify_order_id::text = l.source_id
     where l.program_id = p_program and l.idempotency_key like 'campaign:' || v_c.id || ':%';

    -- Treatment vs holdout over the window so far (whole days, store-local).
    v_lift := null;
    if v_c.starts_at <= now() then
      v_from := (v_c.starts_at at time zone v_prog.timezone)::date;
      v_to   := least((v_c.ends_at at time zone v_prog.timezone)::date, v_today) + 1;
      if v_to > v_from and v_to - v_from <= 731 then
        v_lift := (select jsonb_build_object('lift', s->'lift', 'aa_check', s->'aa_check', 'basis', s->'basis')
                     from loyalty_insights(p_program, v_from, v_to) s);
      end if;
    end if;

    v_out := v_out || jsonb_build_object(
      'id', v_c.id, 'key', v_c.key, 'name', v_c.name, 'kind', v_c.kind,
      'multiplier', v_c.multiplier, 'flat_points', v_c.flat_points, 'min_scope_cents', v_c.min_scope_cents,
      'starts_at', v_c.starts_at, 'ends_at', v_c.ends_at,
      'starts_local', to_char(v_c.starts_at at time zone v_prog.timezone, 'YYYY-MM-DD"T"HH24:MI'),
      'ends_local', to_char(v_c.ends_at at time zone v_prog.timezone, 'YYYY-MM-DD"T"HH24:MI'),
      'collection_gid', v_c.collection_gid, 'product_tag', v_c.product_tag,
      'announce', v_c.announce, 'announced_at', v_c.announced_at, 'is_active', v_c.is_active,
      'status', case when not v_c.is_active then 'paused'
                     when v_c.starts_at > now() then 'upcoming'
                     when v_c.ends_at <= now() then 'ended'
                     else 'running' end,
      'scope', case when v_c.collection_gid is null and v_c.product_tag is null then null else jsonb_build_object(
                 'resolved_at', v_c.products_resolved_at, 'error', v_c.products_error,
                 'products', (select count(*) from loyalty_campaign_products where campaign_id = v_c.id)) end,
      'events', (select jsonb_build_object('sent', count(*) filter (where status = 'sent'),
                                           'pending', count(*) filter (where status = 'pending'),
                                           'skipped', count(*) filter (where status in ('skipped', 'failed')))
                   from loyalty_events where program_id = p_program and dedupe_key like 'campaign_started:' || v_c.id || ':%'),
      'results', v_res,
      'window', v_lift,
      'created_by', v_c.created_by, 'updated_at', v_c.updated_at);
  end loop;

  return jsonb_build_object(
    'timezone', v_prog.timezone,
    'live', v_prog.treatment_since is not null and v_prog.treatment_since <= now(),
    'campaigns', v_out);
end;
$$;

-- loyalty_staff_campaign_save, from 0215_loyalty_campaign_console
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

-- loyalty_staff_forecast, from 0215_loyalty_campaign_console
create or replace function loyalty_staff_forecast(p_program uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog loyalty_programs%rowtype;
  v_ppv  numeric;
  v_now  timestamptz := now();
begin
  perform loyalty_require_manager(p_program);
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  select min(value_cents::numeric / points_cost) into v_ppv
    from loyalty_rewards where program_id = p_program and is_active and points_cost is not null and kind = 'amount_off_order';

  return jsonb_build_object(
    'cents_per_point', round(v_ppv, 4),
    'outstanding', (select jsonb_build_object('points', coalesce(sum(points_balance), 0),
                                              'members', count(*) filter (where points_balance > 0),
                                              'cents', round(coalesce(sum(points_balance), 0) * v_ppv))
                      from loyalty_members where program_id = p_program and status = 'active'),
    'unused_codes', (select jsonb_build_object('codes', count(*), 'cents', coalesce(sum(value_cents), 0))
                       from loyalty_discount_codes where program_id = p_program and status in ('pending', 'issued')),
    'expiry_rule', case when v_prog.points_expire_after is null then null else v_prog.points_expire_after::text end,
    -- Month by month, store-local: balances whose inactivity clock runs out
    -- in that month if the member does nothing until then.
    'expiring', case when v_prog.points_expire_after is null then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object('month', to_char(mo, 'YYYY-MM'), 'points', pts, 'members', n,
                                                   'cents', round(pts * v_ppv)) order by mo), '[]'::jsonb)
        from (select date_trunc('month', g)::date mo,
                     coalesce((select sum(m.points_balance) from loyalty_members m
                                where m.program_id = p_program and m.status = 'active' and m.points_balance > 0
                                  and ((coalesce(m.last_activity_at, m.enrolled_at) + v_prog.points_expire_after) at time zone v_prog.timezone)
                                      >= greatest(date_trunc('month', g), (v_now at time zone v_prog.timezone))
                                  and ((coalesce(m.last_activity_at, m.enrolled_at) + v_prog.points_expire_after) at time zone v_prog.timezone)
                                      < date_trunc('month', g) + interval '1 month'), 0) pts,
                     (select count(*) from loyalty_members m
                       where m.program_id = p_program and m.status = 'active' and m.points_balance > 0
                         and ((coalesce(m.last_activity_at, m.enrolled_at) + v_prog.points_expire_after) at time zone v_prog.timezone)
                             >= greatest(date_trunc('month', g), (v_now at time zone v_prog.timezone))
                         and ((coalesce(m.last_activity_at, m.enrolled_at) + v_prog.points_expire_after) at time zone v_prog.timezone)
                             < date_trunc('month', g) + interval '1 month') n
                from generate_series(date_trunc('month', v_now at time zone v_prog.timezone),
                                     date_trunc('month', v_now at time zone v_prog.timezone) + interval '5 months',
                                     interval '1 month') g) x) end);
end;
$$;

-- loyalty_staff_challenges, from 0216_loyalty_achievements
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
  perform loyalty_require_manager(p_program);
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

-- loyalty_staff_challenge_save, from 0216_loyalty_achievements
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

-- loyalty_staff_program_config, from 0221_loyalty_program_editor
create or replace function loyalty_staff_program_config(p_program uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_p loyalty_programs%rowtype;
begin
  perform loyalty_require_manager(p_program);
  select * into v_p from loyalty_programs where id = p_program;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'program', jsonb_build_object(
      'id', v_p.id, 'name', v_p.name, 'shop_domain', v_p.shop_domain,
      'points_per_dollar', v_p.points_per_dollar,
      'expire_months', loyalty_interval_months(v_p.points_expire_after),
      'demote_months', loyalty_interval_months(v_p.demote_after_inactive),
      'demotion_warning_days', v_p.demotion_warning_days,
      'balance_reminder_days', v_p.balance_reminder_days,
      'near_tier_percent', v_p.near_tier_percent,
      'gross_margin_pct', v_p.gross_margin_pct,
      'code_prefix', v_p.discount_code_prefix),
    'tiers', (select coalesce(jsonb_agg(jsonb_build_object(
                'key', t.key, 'name', t.name, 'rank', t.rank, 'min_spend_cents', t.min_spend_cents,
                'earn_multiplier', t.earn_multiplier, 'perks', t.perks,
                'members', (select count(*) from loyalty_members m where m.program_id = p_program and m.tier_key = t.key and m.status = 'active'))
                order by t.rank), '[]'::jsonb)
                from loyalty_tiers t where t.program_id = p_program),
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object(
                  'key', r.key, 'name', r.name, 'kind', r.kind, 'points_cost', r.points_cost, 'value_cents', r.value_cents,
                  'min_order_cents', r.min_order_cents, 'max_units', r.max_units, 'is_active', r.is_active,
                  'codes_issued', (select count(*) from loyalty_discount_codes c where c.program_id = p_program and c.reward_key = r.key))
                  order by r.points_cost nulls last, r.key), '[]'::jsonb)
                  from loyalty_rewards r where r.program_id = p_program and r.kind = 'amount_off_order'),
    'earn_rules', (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', e.key, 'kind', e.kind, 'points', e.points, 'order_count', e.order_count,
                     'is_active', e.is_active, 'title', e.title)
                     order by e.kind, e.order_count nulls first, e.key), '[]'::jsonb)
                     from loyalty_earn_rules e where e.program_id = p_program));
end;
$$;

-- loyalty_staff_program_save, from 0221_loyalty_program_editor
create or replace function loyalty_staff_program_save(p_program uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  text;
  v_before jsonb;
  v_ppd    numeric := (p_settings->>'points_per_dollar')::numeric;
  v_exp    int := nullif(p_settings->>'expire_months', '')::int;
  v_dem    int := (p_settings->>'demote_months')::int;
  v_warn   int := (p_settings->>'demotion_warning_days')::int;
  v_rem    int := (p_settings->>'balance_reminder_days')::int;
  v_near   int := (p_settings->>'near_tier_percent')::int;
  v_margin numeric := nullif(p_settings->>'gross_margin_pct', '')::numeric;
begin
  v_actor := loyalty_require_manager(p_program);
  v_before := loyalty_staff_program_config(p_program)->'program';
  if v_before is null then
    raise exception 'program not found';
  end if;
  if v_ppd is null or v_ppd < 0.1 or v_ppd > 100 then raise exception 'Points per $1 must be between 0.1 and 100.'; end if;
  if v_exp is not null and (v_exp < 1 or v_exp > 60) then raise exception 'Expiry must be 1 to 60 months, or never.'; end if;
  if v_dem is null or v_dem < 1 or v_dem > 36 then raise exception 'Demotion must be after 1 to 36 months.'; end if;
  if v_warn is null or v_warn < 0 or v_warn > 60 then raise exception 'The demotion warning must be 0 to 60 days before.'; end if;
  if v_rem is null or v_rem < 7 or v_rem > 365 then raise exception 'The balance reminder must be every 7 to 365 days.'; end if;
  if v_near is null or v_near < 1 or v_near > 50 then raise exception 'Near tier must be 1 to 50 percent.'; end if;
  if v_margin is not null and (v_margin <= 0 or v_margin > 100) then raise exception 'Gross margin must be above 0 and at most 100 percent.'; end if;

  update loyalty_programs set
    points_per_dollar = round(v_ppd, 2),
    points_expire_after = case when v_exp is null then null else make_interval(months => v_exp) end,
    demote_after_inactive = make_interval(months => v_dem),
    demotion_warning_days = v_warn,
    balance_reminder_days = v_rem,
    near_tier_percent = v_near,
    gross_margin_pct = case when loyalty_is_staff() then v_margin else gross_margin_pct end
  where id = p_program;

  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'settings', 'before', v_before, 'after', loyalty_staff_program_config(p_program)->'program'));
  return loyalty_staff_program_config(p_program)->'program';
end;
$$;

-- loyalty_staff_tiers_save, from 0221_loyalty_program_editor
create or replace function loyalty_staff_tiers_save(p_program uuid, p_tiers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    text;
  v_before   jsonb;
  v_t        record;
  v_in       jsonb;
  v_prev     bigint := -1;
  v_first    boolean := true;
  v_quiet    text;
  v_m        record;
  v_promoted int := 0;
  v_perk     jsonb;
begin
  v_actor := loyalty_require_manager(p_program);
  v_before := loyalty_staff_program_config(p_program)->'tiers';
  if v_before is null or jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'program not found or no tiers given';
  end if;
  if jsonb_array_length(p_tiers) <> (select count(*) from loyalty_tiers where program_id = p_program) then
    raise exception 'Send every tier.';
  end if;

  -- Validate in rank order before writing anything.
  for v_t in select * from loyalty_tiers where program_id = p_program order by rank loop
    select x into v_in from jsonb_array_elements(p_tiers) x where x->>'key' = v_t.key;
    if v_in is null then raise exception 'Missing tier %.', v_t.name; end if;
    if (v_in->>'min_spend_cents') is null or (v_in->>'min_spend_cents')::bigint < 0 then
      raise exception '% needs a spend threshold.', v_t.name;
    end if;
    if v_first and (v_in->>'min_spend_cents')::bigint <> 0 then
      raise exception 'The first tier (%) starts at $0.', v_t.name;
    end if;
    if not v_first and (v_in->>'min_spend_cents')::bigint <= v_prev then
      raise exception '% must need more spend than the tier below it.', v_t.name;
    end if;
    if (v_in->>'earn_multiplier') is null or (v_in->>'earn_multiplier')::numeric < 1 or (v_in->>'earn_multiplier')::numeric > 5 then
      raise exception '% needs a multiplier between 1 and 5.', v_t.name;
    end if;
    if jsonb_typeof(coalesce(v_in->'perks', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(v_in->'perks', '[]'::jsonb)) > 8 then
      raise exception '% can list up to 8 perks.', v_t.name;
    end if;
    for v_perk in select * from jsonb_array_elements(coalesce(v_in->'perks', '[]'::jsonb)) loop
      if jsonb_typeof(v_perk) <> 'string' or length(v_perk #>> '{}') not between 1 and 120 then
        raise exception 'Each perk on % is 1 to 120 characters.', v_t.name;
      end if;
    end loop;
    v_prev := (v_in->>'min_spend_cents')::bigint;
    v_first := false;
  end loop;

  update loyalty_tiers t set
    min_spend_cents = (x->>'min_spend_cents')::bigint,
    earn_multiplier = round((x->>'earn_multiplier')::numeric, 2),
    perks = coalesce(x->'perks', '[]'::jsonb)
    from jsonb_array_elements(p_tiers) x
   where t.program_id = p_program and t.key = x->>'key';

  -- Members whose spend now reaches a higher tier move up, without tier_up events.
  v_quiet := coalesce(current_setting('loyalty.quiet', true), '');
  perform set_config('loyalty.quiet', 'on', true);
  for v_m in
    select m.id, loyalty_tier_for_spend(p_program, m.tier_spend_cents) as spend_tier, t.rank as cur_rank
      from loyalty_members m join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
     where m.program_id = p_program and m.status = 'active'
  loop
    if (select rank from loyalty_tiers where program_id = p_program and key = v_m.spend_tier) > v_m.cur_rank then
      perform loyalty_set_tier(v_m.id, v_m.spend_tier, 'staff', v_actor);
      v_promoted := v_promoted + 1;
    end if;
  end loop;
  perform set_config('loyalty.quiet', v_quiet, true);

  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'tiers', 'before', v_before, 'after', loyalty_staff_program_config(p_program)->'tiers', 'promoted', v_promoted));
  return jsonb_build_object('promoted', v_promoted, 'tiers', loyalty_staff_program_config(p_program)->'tiers');
end;
$$;

-- loyalty_staff_reward_save, from 0221_loyalty_program_editor
create or replace function loyalty_staff_reward_save(p_program uuid, p_reward jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  text;
  v_key    text := nullif(p_reward->>'key', '');
  v_old    loyalty_rewards%rowtype;
  v_name   text := trim(coalesce(p_reward->>'name', ''));
  v_cost   int := nullif(p_reward->>'points_cost', '')::int;
  v_value  bigint := (p_reward->>'value_cents')::bigint;
  v_min    bigint := coalesce(nullif(p_reward->>'min_order_cents', '')::bigint, 0);
  v_units  int := nullif(p_reward->>'max_units', '')::int;   -- null = no cap
  v_active boolean := coalesce((p_reward->>'is_active')::boolean, true);
  v_base   text;
  v_n      int := 1;
  v_before jsonb;
begin
  v_actor := loyalty_require_manager(p_program);
  if not exists (select 1 from loyalty_programs where id = p_program) then
    raise exception 'program not found';
  end if;
  if v_key is not null then
    select * into v_old from loyalty_rewards where program_id = p_program and key = v_key and kind = 'amount_off_order';
    if not found then raise exception 'Unknown reward.'; end if;
    v_before := to_jsonb(v_old);
  end if;

  if length(v_name) not between 1 and 60 then raise exception 'Give the reward a name (up to 60 characters).'; end if;
  if v_value is null or v_value < 100 or v_value > 100000 then raise exception 'The value must be $1 to $1,000.'; end if;
  if v_min < 0 or v_min > 1000000 then raise exception 'The minimum order must be $0 to $10,000.'; end if;
  if v_units is not null and (v_units < 1 or v_units > 1000) then raise exception 'Max per code must be 1 to 1,000, or no limit.'; end if;
  -- The referral friend's coupon has no points cost; every other reward needs one.
  if v_old.points_cost is null and v_key is not null then
    v_cost := null;
    v_units := 1;
  elsif v_cost is null or v_cost < 1 or v_cost > 1000000 then
    raise exception 'The points cost must be 1 to 1,000,000.';
  end if;

  if v_key is null then
    v_base := trim(both '_' from regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'));
    if v_base = '' or v_base ~ '^[0-9]' then v_base := 'reward_' || v_base; end if;
    v_base := left(trim(both '_' from v_base), 40);
    v_key := v_base;
    while exists (select 1 from loyalty_rewards where program_id = p_program and key = v_key) loop
      v_n := v_n + 1;
      v_key := v_base || '_' || v_n;
    end loop;
    insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents, min_order_cents, max_units, is_active)
    values (p_program, v_key, v_name, 'amount_off_order', v_cost, v_value, v_min, v_units, v_active);
  else
    update loyalty_rewards set name = v_name, points_cost = v_cost, value_cents = v_value, min_order_cents = v_min,
                               max_units = v_units, is_active = v_active
     where program_id = p_program and key = v_key;
  end if;

  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'reward', 'key', v_key, 'before', v_before,
    'after', (select to_jsonb(r) from loyalty_rewards r where program_id = p_program and key = v_key)));
  return jsonb_build_object('key', v_key);
end;
$$;

-- loyalty_staff_earn_rule_save, from 0221_loyalty_program_editor
create or replace function loyalty_staff_earn_rule_save(p_program uuid, p_key text, p_points int, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text;
  v_old   loyalty_earn_rules%rowtype;
begin
  v_actor := loyalty_require_manager(p_program);
  select * into v_old from loyalty_earn_rules where program_id = p_program and key = p_key;
  if not found then raise exception 'Unknown earning rule.'; end if;
  if p_points is null or p_points < 0 or p_points > 100000 then raise exception 'Points must be 0 to 100,000.'; end if;
  update loyalty_earn_rules set points = p_points, is_active = coalesce(p_active, is_active)
   where program_id = p_program and key = p_key;
  perform loyalty_log_access('program_save', p_program, null, jsonb_build_object(
    'section', 'earn_rule', 'key', p_key,
    'before', jsonb_build_object('points', v_old.points, 'is_active', v_old.is_active),
    'after', jsonb_build_object('points', p_points, 'is_active', coalesce(p_active, v_old.is_active))));
  return jsonb_build_object('key', p_key, 'points', p_points, 'is_active', coalesce(p_active, v_old.is_active));
end;
$$;

-- loyalty_staff_member, from 0206_loyalty_staff_admin
create or replace function loyalty_staff_member(p_member uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m loyalty_members%rowtype;
begin
  perform loyalty_require_manager((select program_id from loyalty_members where id = p_member));
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

-- loyalty_staff_adjust, from 0206_loyalty_staff_admin
create or replace function loyalty_staff_adjust(p_member uuid, p_points int, p_note text, p_request_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := loyalty_require_manager((select program_id from loyalty_members where id = p_member));
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

-- loyalty_staff_set_tier, from 0206_loyalty_staff_admin
create or replace function loyalty_staff_set_tier(p_member uuid, p_tier_key text, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := loyalty_require_manager((select program_id from loyalty_members where id = p_member));
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

-- loyalty_staff_set_birthday, from 0206_loyalty_staff_admin
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
  perform loyalty_require_manager((select program_id from loyalty_members where id = p_member));
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

-- loyalty_staff_campaign_set_active, from 0215_loyalty_campaign_console
create or replace function loyalty_staff_campaign_set_active(p_campaign uuid, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c loyalty_campaigns%rowtype;
begin
  perform loyalty_require_manager((select program_id from loyalty_campaigns where id = p_campaign));
  update loyalty_campaigns set is_active = p_active
   where id = p_campaign and is_active is distinct from p_active
  returning * into v_c;
  if not found then
    return false;   -- unknown, or already in that state
  end if;
  perform loyalty_log_access('campaign_active', v_c.program_id, null,
    jsonb_build_object('campaign_id', v_c.id, 'active', p_active));
  return true;
end;
$$;

-- loyalty_staff_challenge_set_active, from 0216_loyalty_achievements
create or replace function loyalty_staff_challenge_set_active(p_challenge uuid, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c loyalty_challenges%rowtype;
begin
  perform loyalty_require_manager((select program_id from loyalty_challenges where id = p_challenge));
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

-- loyalty_staff_programs, from 0206_loyalty_staff_admin
create or replace function loyalty_staff_programs()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform loyalty_require_manager_any();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'shop_domain', p.shop_domain, 'client', c.name, 'is_active', p.is_active,
            'live_since', p.live_since, 'klaviyo_enabled_at', p.klaviyo_enabled_at,
            'members', (select count(*) from loyalty_members m where m.program_id = p.id),
            'points_outstanding', (select coalesce(sum(points_balance), 0) from loyalty_members m where m.program_id = p.id),
            'tiers', (select jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name) order by t.rank) from loyalty_tiers t where t.program_id = p.id))
          order by p.name), '[]'::jsonb)
            from loyalty_programs p join clients c on c.id = p.client_id
           where loyalty_can_manage(p.id));
end;
$$;
