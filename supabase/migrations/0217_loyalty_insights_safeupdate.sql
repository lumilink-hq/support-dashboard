-- =============================================================================
-- 0217_loyalty_insights_safeupdate.sql — fix for 0211's loyalty_insights.
--
-- 0211 filled its temp table with an UPDATE that had no WHERE clause.
-- PostgREST runs with pg-safeupdate, which refuses that ("UPDATE requires a
-- WHERE clause"), so every insights RPC (loyalty_staff_insights,
-- loyalty_client_results) failed from the app while passing in psql-based
-- tests. Found 2026-10-15 while checking /rewards locally, after 0211 had
-- already reached production; db push never re-runs an applied migration, so
-- the fix is this one. Same function as 0211, with "where true".
--
-- Rule since: any UPDATE / DELETE in a function the app or an edge function
-- calls needs a WHERE (psql tests can't load safeupdate, so they won't catch it).
-- Idempotent / safe to re-apply.
-- =============================================================================

create or replace function loyalty_insights(p_program uuid, p_from date, p_to date)
returns jsonb
language plpgsql   -- volatile: fills a transaction-local temp table
set search_path = public, pg_temp
as $$
declare
  v_prog     loyalty_programs%rowtype;
  v_from     timestamptz;
  v_to       timestamptz;
  v_margin   numeric;
  v_ppv      numeric;      -- cents per point, cheapest amount-off reward
  v_groups   jsonb;
  v_lift     jsonb;
  v_infl     jsonb;
  v_extra    record;
  v_liab     bigint;
  v_ref_cost bigint;
begin
  select * into v_prog from loyalty_programs where id = p_program;
  if not found then
    raise exception 'loyalty program % not found', p_program;
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'period end must be after its start';
  end if;
  v_from   := p_from::timestamp at time zone v_prog.timezone;
  v_to     := p_to::timestamp at time zone v_prog.timezone;
  v_margin := v_prog.gross_margin_pct / 100.0;
  select min(r.value_cents::numeric / r.points_cost) into v_ppv
    from loyalty_rewards r
   where r.program_id = p_program and r.is_active and r.points_cost is not null and r.kind = 'amount_off_order';

  if to_regclass('pg_temp.li_per') is null then
    create temp table li_per (
      member_id uuid primary key, grp text, rev bigint, n_orders int, cost bigint, val numeric) on commit drop;
  end if;
  truncate pg_temp.li_per;

  -- Everyone active and enrolled before the period ends (intent to treat),
  -- with their period revenue (net of refunds), orders and reward cost.
  insert into pg_temp.li_per
  select m.id,
         case when m.holdout_bucket < v_prog.holdout_percent then 'holdout' else 'treatment' end,
         coalesce(o.rev, 0), coalesce(o.n, 0), coalesce(c.cost, 0), 0
    from loyalty_members m
    left join (select member_id, sum(eligible_cents - refunded_cents) rev, count(*) n
                 from loyalty_orders
                where program_id = p_program and processed_at >= v_from and processed_at < v_to
                group by member_id) o on o.member_id = m.id
    left join (select member_id, sum(value_cents) cost
                 from loyalty_discount_codes
                where program_id = p_program and status = 'used' and member_id is not null and referral_id is null
                  and used_at >= v_from and used_at < v_to
                group by member_id) c on c.member_id = m.id
   where m.program_id = p_program and m.status = 'active' and m.enrolled_at < v_to;
  -- "where true": PostgREST's pg-safeupdate refuses an UPDATE without a WHERE.
  update pg_temp.li_per set val = case when v_margin is null then rev - cost else rev * v_margin - cost end where true;

  select coalesce(jsonb_object_agg(grp, s), '{}'::jsonb) into v_groups
    from (select grp, jsonb_build_object(
            'members',                  count(*),
            'buyers',                   count(*) filter (where n_orders > 0),
            'orders',                   sum(n_orders),
            'revenue_cents',            sum(rev),
            'reward_cost_cents',        sum(cost),
            'revenue_per_member_cents', round(avg(rev), 2),
            'value_per_member_cents',   round(avg(val), 2),
            'aov_cents',                round(sum(rev)::numeric / nullif(sum(n_orders), 0), 2),
            'purchase_rate',            round(count(*) filter (where n_orders > 0)::numeric / count(*), 4),
            'repeat_rate',              round(count(*) filter (where n_orders >= 2)::numeric
                                              / nullif(count(*) filter (where n_orders > 0), 0), 4)) s
            from pg_temp.li_per group by grp) g;

  -- Per group: days between orders (gap to the member's previous order, for
  -- orders in the period) and points issued / redeemed in the period.
  for v_extra in
    select p.grp,
           (select round(avg(extract(epoch from q.gap) / 86400)::numeric, 1)
              from (select o.member_id, o.processed_at,
                           o.processed_at - lag(o.processed_at) over (partition by o.member_id order by o.processed_at) gap
                      from loyalty_orders o where o.program_id = p_program) q
              join pg_temp.li_per x on x.member_id = q.member_id and x.grp = p.grp
             where q.gap is not null and q.processed_at >= v_from and q.processed_at < v_to) days_between,
           (select coalesce(sum(l.points), 0) from loyalty_ledger l join pg_temp.li_per x on x.member_id = l.member_id and x.grp = p.grp
             where l.program_id = p_program and l.points > 0 and l.reason in ('order', 'action', 'milestone', 'referral')
               and l.occurred_at >= v_from and l.occurred_at < v_to) issued,
           (select -coalesce(sum(l.points), 0) from loyalty_ledger l join pg_temp.li_per x on x.member_id = l.member_id and x.grp = p.grp
             where l.program_id = p_program and l.reason in ('redeem', 'redeem_reversal')
               and l.occurred_at >= v_from and l.occurred_at < v_to) redeemed
      from (select distinct grp from pg_temp.li_per) p
  loop
    v_groups := jsonb_set(v_groups, array[v_extra.grp], (v_groups -> v_extra.grp) || jsonb_build_object(
      'avg_days_between_orders', v_extra.days_between,
      'points_issued', v_extra.issued,
      'points_redeemed', v_extra.redeemed));
  end loop;

  -- Lift per member with a 95% range (Welch); needs 2+ members per group.
  select case when nt >= 2 and nh >= 2 then jsonb_build_object(
           'per_member_cents', round(mt - mh, 2),
           'low_cents',  round(mt - mh - 1.96 * sqrt(vt / nt + vh / nh), 2),
           'high_cents', round(mt - mh + 1.96 * sqrt(vt / nt + vh / nh), 2),
           'incremental_total_cents', round((mt - mh) * nt),
           'significant', abs(mt - mh) > 1.96 * sqrt(vt / nt + vh / nh) and (vt > 0 or vh > 0)) end
    into v_lift
    from (select count(*) filter (where grp = 'treatment') nt, count(*) filter (where grp = 'holdout') nh,
                 avg(val) filter (where grp = 'treatment') mt, avg(val) filter (where grp = 'holdout') mh,
                 coalesce(var_samp(val) filter (where grp = 'treatment'), 0) vt,
                 coalesce(var_samp(val) filter (where grp = 'holdout'), 0) vh
            from pg_temp.li_per) s;

  -- Orders loyalty touched (an order can have several reasons).
  select coalesce(jsonb_object_agg(grp, s), '{}'::jsonb) into v_infl
    from (select x.grp, jsonb_build_object(
            'orders', count(*) filter (where code or coupon or emailed or tier_up),
            'revenue_cents', coalesce(sum(net) filter (where code or coupon or emailed or tier_up), 0),
            'reward_code', count(*) filter (where code),
            'referral_coupon', count(*) filter (where coupon),
            'after_email', count(*) filter (where emailed),
            'tier_up', count(*) filter (where tier_up)) s
            from (select o.member_id, o.eligible_cents - o.refunded_cents net,
                         exists (select 1 from loyalty_discount_codes c where c.program_id = p_program
                                  and c.used_order_id = o.shopify_order_id and c.referral_id is null) code,
                         exists (select 1 from loyalty_discount_codes c where c.program_id = p_program
                                  and c.used_order_id = o.shopify_order_id and c.referral_id is not null) coupon,
                         exists (select 1 from loyalty_events e where e.member_id = o.member_id and e.status = 'sent'
                                  and e.sent_at < o.processed_at and e.sent_at >= o.processed_at - v_prog.attribution_window) emailed,
                         exists (select 1 from loyalty_tier_changes t join loyalty_ledger l on l.id = t.ledger_id
                                  where t.member_id = o.member_id and t.direction = 'up' and t.reason = 'spend'
                                    and l.source_type = 'shopify_order' and l.source_id = o.shopify_order_id::text) tier_up
                    from loyalty_orders o
                   where o.program_id = p_program and o.processed_at >= v_from and o.processed_at < v_to) q
            join pg_temp.li_per x on x.member_id = q.member_id
           group by x.grp) g;

  select coalesce(sum(points), 0) into v_liab
    from loyalty_ledger where program_id = p_program and occurred_at < v_to;
  select coalesce(sum(value_cents), 0) into v_ref_cost
    from loyalty_discount_codes
   where program_id = p_program and status = 'used' and referral_id is not null and used_at >= v_from and used_at < v_to;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', v_prog.timezone,
    'holdout_percent', v_prog.holdout_percent,
    'gross_margin_pct', v_prog.gross_margin_pct,
    'basis', case when v_margin is null then 'revenue_minus_rewards' else 'gross_profit_minus_rewards' end,
    'aa_check', v_prog.treatment_since is null or v_prog.treatment_since > v_from,
    'groups', v_groups,
    'lift', v_lift,
    'influenced', v_infl,
    'referral_coupon_cost_cents', v_ref_cost,
    'liability', jsonb_build_object('points', v_liab,
                                    'cents', case when v_ppv is null then null else round(v_liab * v_ppv) end));
end;
$$;

revoke execute on function loyalty_insights(uuid, date, date) from public, anon, authenticated;
grant execute on function loyalty_insights(uuid, date, date) to service_role;
