-- =============================================================================
-- 0219 — LL Loyalty: staff members table (/loyalty)
--
-- loyalty_staff_members: one page (50) of a program's members with filters and
-- sorting, for LumiLink staff only (loyalty_require_staff: staff + MFA). Every
-- call is one access-log row ('list') with the filters, sort, page and result
-- count. No export: the page is the only way out, 50 rows at a time.
--
-- Filters (p_filters, all optional):
--   q            email / name contains, or exact Shopify customer id / referral code (as 0206's search)
--   tier         tier key
--   status       'active' | 'excluded'
--   group        'treatment' | 'holdout' (0211's fixed bucket vs holdout_percent)
--   can_redeem   true = balance covers the cheapest points reward
--   demotes_30d  true = above the lowest tier and the inactivity clock runs out within 30 days
--   expires_30d  true = has points and the expiry clock runs out within 30 days
-- Sort: 'points' | 'spend' | 'last_order', direction 'desc' (default) | 'asc'.
-- =============================================================================

alter table loyalty_access_log drop constraint if exists loyalty_access_log_action_check;
alter table loyalty_access_log add constraint loyalty_access_log_action_check
  check (action in ('search', 'view', 'adjust', 'set_tier', 'set_birthday', 'data_requests', 'campaign_save', 'campaign_active',
                    'challenge_save', 'challenge_active', 'list'));

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
  perform loyalty_require_staff();
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

revoke execute on function loyalty_staff_members(uuid, jsonb, text, text, int) from public, anon;
grant execute on function loyalty_staff_members(uuid, jsonb, text, text, int) to authenticated;
