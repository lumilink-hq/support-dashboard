-- =============================================================================
-- 0215_loyalty_campaign_console.sql — Phase 1b module 14: the staff campaign
-- console (plan §6). Builds on 0214's campaigns.
--
-- Staff + MFA only (0210), like every staff RPC; each change writes the
-- access log (new actions 'campaign_save', 'campaign_active').
--
--   loyalty_staff_campaigns(program)         every campaign with its status
--     (upcoming / running / ended / paused), scope resolution, and results:
--     orders that earned the bonus, bonus points, their net revenue, members
--     reached, announcement events; plus treatment vs holdout over the
--     campaign's window (0211; all Phase 1b features, not this campaign alone).
--   loyalty_staff_campaign_save(program, campaign, fields)   create or edit.
--     Times are store-local ('YYYY-MM-DDTHH:MI', the form's datetime-local).
--     Once a campaign has started only its name, end and announce flag can
--     change, so awards already made keep meaning what they said.
--   loyalty_staff_campaign_set_active(campaign, active)      pause / resume.
--   loyalty_staff_forecast(program)          liability now and points due to
--     expire in each of the next 6 months (inactivity rule, 0202), plus
--     issued-but-unused reward codes.
--
-- Challenges come with module 13; this console gets them then.
-- Test: scripts/test_loyalty_campaign_console.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_access_log drop constraint if exists loyalty_access_log_action_check;
alter table loyalty_access_log add constraint loyalty_access_log_action_check
  check (action in ('search', 'view', 'adjust', 'set_tier', 'set_birthday', 'data_requests', 'campaign_save', 'campaign_active'));

-- -----------------------------------------------------------------------------
-- Reads
-- -----------------------------------------------------------------------------
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
  perform loyalty_require_staff();
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
  perform loyalty_require_staff();
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

-- -----------------------------------------------------------------------------
-- Writes
-- -----------------------------------------------------------------------------

-- p_campaign null = create. p_fields: {key, name, kind, multiplier,
-- flat_points, min_scope_cents, starts_local, ends_local, collection_gid,
-- product_tag, announce}. Returns the campaign id.
create or replace function loyalty_staff_campaign_save(p_program uuid, p_campaign uuid, p_fields jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := loyalty_require_staff();
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

create or replace function loyalty_staff_campaign_set_active(p_campaign uuid, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c loyalty_campaigns%rowtype;
begin
  perform loyalty_require_staff();
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

revoke execute on function loyalty_staff_campaigns(uuid) from public, anon;
revoke execute on function loyalty_staff_forecast(uuid) from public, anon;
revoke execute on function loyalty_staff_campaign_save(uuid, uuid, jsonb) from public, anon;
revoke execute on function loyalty_staff_campaign_set_active(uuid, boolean) from public, anon;
grant execute on function loyalty_staff_campaigns(uuid) to authenticated;
grant execute on function loyalty_staff_forecast(uuid) to authenticated;
grant execute on function loyalty_staff_campaign_save(uuid, uuid, jsonb) to authenticated;
grant execute on function loyalty_staff_campaign_set_active(uuid, boolean) to authenticated;
