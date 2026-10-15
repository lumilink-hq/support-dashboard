-- =============================================================================
-- 0213_loyalty_insights_views.sql — Phase 1b module 10: what the insights
-- pages read (plan §6). Builds on 0211's loyalty_insights.
--
-- STAFF (/loyalty/insights): loyalty_staff_insights (0211) for the headline,
-- groups and trend, plus loyalty_staff_insights_detail here: members and
-- period revenue per tier, and redemptions (codes created / used, points
-- issued / redeemed, redemption rate). Staff + MFA only (0210). Aggregates,
-- so not written to the access log.
--
-- CLIENT (/rewards in the portal): loyalty_client_results. The caller's own
-- workspace only (current_client_id()), any role. AGGREGATES ONLY: no member,
-- email or order is ever returned (plan §1: member data stays staff-only).
--   measuring  true while 0211's aa_check is on (no Phase 1b feature live
--              yet, or it went live inside the period): no extra-revenue
--              claim is made then, only program activity.
--   extra      lift x treatment members, with its 95% range scaled the same
--              way; value = gross profit (or revenue) minus reward cost.
--   roi        extra / treatment reward cost: net return per $1 of rewards.
--
-- Campaign results ("top campaigns") come with module 12, which adds campaigns.
--
-- Test: scripts/test_loyalty_insights_views.sql. Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- loyalty_insights_detail — per tier + redemptions for [p_from, p_to) in the
-- program's time zone. Internal (service role); the staff RPC wraps it.
-- Tier = the member's tier now (what staff act on), period revenue net of refunds.
-- -----------------------------------------------------------------------------
create or replace function loyalty_insights_detail(p_program uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_prog loyalty_programs%rowtype;
  v_from timestamptz;
  v_to   timestamptz;
  v_tiers jsonb;
  v_red   jsonb;
begin
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'period end must be after its start';
  end if;
  v_from := p_from::timestamp at time zone v_prog.timezone;
  v_to   := p_to::timestamp at time zone v_prog.timezone;

  select coalesce(jsonb_agg(jsonb_build_object(
           'key', t.key, 'name', t.name,
           'members', coalesce(s.members, 0),
           'buyers', coalesce(s.buyers, 0),
           'revenue_cents', coalesce(s.rev, 0),
           'points_outstanding', coalesce(s.points, 0)) order by t.rank), '[]'::jsonb)
    into v_tiers
    from loyalty_tiers t
    left join (select m.tier_key,
                      count(*) members,
                      count(*) filter (where o.n > 0) buyers,
                      sum(coalesce(o.rev, 0)) rev,
                      sum(m.points_balance) points
                 from loyalty_members m
                 left join (select member_id, count(*) n, sum(eligible_cents - refunded_cents) rev
                              from loyalty_orders
                             where program_id = p_program and processed_at >= v_from and processed_at < v_to
                             group by member_id) o on o.member_id = m.id
                where m.program_id = p_program and m.status = 'active' and m.enrolled_at < v_to
                group by m.tier_key) s on s.tier_key = t.key
   where t.program_id = p_program;

  select jsonb_build_object(
           'codes_created', (select count(*) from loyalty_discount_codes
                              where program_id = p_program and referral_id is null and created_at >= v_from and created_at < v_to),
           'codes_used', (select count(*) from loyalty_discount_codes
                           where program_id = p_program and referral_id is null and status = 'used' and used_at >= v_from and used_at < v_to),
           'referral_coupons_used', (select count(*) from loyalty_discount_codes
                                      where program_id = p_program and referral_id is not null and status = 'used'
                                        and used_at >= v_from and used_at < v_to),
           'points_issued', i.issued,
           'points_redeemed', i.redeemed,
           'redemption_rate', round(i.redeemed::numeric / nullif(i.issued, 0), 4))
    into v_red
    from (select coalesce(sum(points) filter (where points > 0 and reason in ('order', 'action', 'milestone', 'referral')), 0) issued,
                 -coalesce(sum(points) filter (where reason in ('redeem', 'redeem_reversal')), 0) redeemed
            from loyalty_ledger
           where program_id = p_program and occurred_at >= v_from and occurred_at < v_to) i;

  return jsonb_build_object('tiers', v_tiers, 'redemptions', v_red);
end;
$$;

create or replace function loyalty_staff_insights_detail(p_program uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform loyalty_require_staff();
  if p_to - p_from > 731 then
    raise exception 'period is limited to 2 years';
  end if;
  return loyalty_insights_detail(p_program, p_from, p_to);
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_client_has_program — the sidebar row: does the caller's workspace
-- have a loyalty program? Cheap, called on every dashboard render.
-- -----------------------------------------------------------------------------
create or replace function loyalty_client_has_program()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from loyalty_programs where client_id = current_client_id() and is_active);
$$;

-- -----------------------------------------------------------------------------
-- loyalty_client_results — the caller's own program, aggregates only.
-- null = this workspace has no active program.
-- -----------------------------------------------------------------------------
create or replace function loyalty_client_results(p_from date, p_to date)
returns jsonb
language plpgsql
security definer   -- volatile: loyalty_insights fills a temp table
set search_path = public, pg_temp
as $$
declare
  v_prog loyalty_programs%rowtype;
  v_s    jsonb;
  v_t    jsonb;
  v_h    jsonb;
  v_lift jsonb;
  v_nt   numeric;
  v_cost numeric;
  v_extra numeric;
  v_measuring boolean;
begin
  if current_client_id() is null then
    return null;
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 731 then
    raise exception 'period must be 1 day to 2 years';
  end if;
  select * into v_prog from loyalty_programs
   where client_id = current_client_id() and is_active order by created_at limit 1;
  if not found then
    return null;
  end if;

  v_s    := loyalty_insights(v_prog.id, p_from, p_to);
  v_t    := v_s #> '{groups,treatment}';
  v_h    := v_s #> '{groups,holdout}';
  v_lift := v_s -> 'lift';
  v_measuring := coalesce((v_s ->> 'aa_check')::boolean, true);
  v_nt   := coalesce((v_t ->> 'members')::numeric, 0);
  v_cost := coalesce((v_t ->> 'reward_cost_cents')::numeric, 0);
  v_extra := (v_lift ->> 'incremental_total_cents')::numeric;

  return jsonb_build_object(
    'program', v_prog.name,
    'from', p_from, 'to', p_to,
    'live_since', v_prog.live_since,
    'measuring', v_measuring,
    'basis', v_s ->> 'basis',
    'members', coalesce((v_t ->> 'members')::int, 0) + coalesce((v_h ->> 'members')::int, 0),
    'buyers', coalesce((v_t ->> 'buyers')::int, 0) + coalesce((v_h ->> 'buyers')::int, 0),
    'orders', coalesce((v_t ->> 'orders')::int, 0) + coalesce((v_h ->> 'orders')::int, 0),
    'revenue_cents', coalesce((v_t ->> 'revenue_cents')::bigint, 0) + coalesce((v_h ->> 'revenue_cents')::bigint, 0),
    'reward_cost_cents', coalesce((v_t ->> 'reward_cost_cents')::bigint, 0) + coalesce((v_h ->> 'reward_cost_cents')::bigint, 0)
                         + coalesce((v_s ->> 'referral_coupon_cost_cents')::bigint, 0),
    'redemptions', (loyalty_insights_detail(v_prog.id, p_from, p_to) #>> '{redemptions,codes_used}')::int,
    'influenced_orders', coalesce((v_s #>> '{influenced,treatment,orders}')::int, 0) + coalesce((v_s #>> '{influenced,holdout,orders}')::int, 0),
    'influenced_revenue_cents', coalesce((v_s #>> '{influenced,treatment,revenue_cents}')::bigint, 0)
                                + coalesce((v_s #>> '{influenced,holdout,revenue_cents}')::bigint, 0),
    'liability_cents', (v_s #>> '{liability,cents}')::bigint,
    -- No extra-revenue claim while measuring, or without a lift (too few members).
    'extra', case when v_measuring or v_lift is null then null else jsonb_build_object(
               'total_cents', round(v_extra),
               'low_cents', round((v_lift ->> 'low_cents')::numeric * v_nt),
               'high_cents', round((v_lift ->> 'high_cents')::numeric * v_nt),
               'significant', (v_lift ->> 'significant')::boolean,
               'roi', case when v_cost > 0 then round(v_extra / v_cost, 2) end) end);
end;
$$;

revoke execute on function loyalty_insights_detail(uuid, date, date) from public, anon, authenticated;
revoke execute on function loyalty_staff_insights_detail(uuid, date, date) from public, anon;
revoke execute on function loyalty_client_has_program() from public, anon;
revoke execute on function loyalty_client_results(date, date) from public, anon;
grant execute on function loyalty_insights_detail(uuid, date, date) to service_role;
grant execute on function loyalty_staff_insights_detail(uuid, date, date) to authenticated;
grant execute on function loyalty_client_has_program() to authenticated;
grant execute on function loyalty_client_results(date, date) to authenticated;
