-- =============================================================================
-- 0211_loyalty_measurement.sql — Phase 1b module 9: holdout + ROI numbers
-- (plan §6). Builds on 0200-0210.
--
-- HOLDOUT. Every member gets a fixed bucket 0-99 from a hash of (program,
-- Shopify customer id), stored as a generated column. Members with
-- bucket < loyalty_programs.holdout_percent (default 10) are the holdout.
-- Because the bucket is a pure function of the customer, nothing has to
-- "assign" it: members created by the cutover import, by webhooks, or
-- re-created after a redact all land in the same group every time.
-- Don't change holdout_percent mid-measurement: it moves people between
-- groups and restarts the comparison.
--
-- The holdout keeps Joy parity (earning, tiers, rewards, the existing
-- Klaviyo flows). It only misses Phase 1b features, which must ask
-- loyalty_member_treated(member) before nudging anyone. Event kinds listed
-- in loyalty_programs.holdout_suppressed_kinds are never queued for the
-- holdout (empty now; module 12 adds its kinds there).
--
-- NUMBERS. loyalty_insights(program, from, to) computes everything live from
-- data we already keep (orders, ledger, codes, events, tier changes): refunds
-- landing late are always reflected and there's no rollup to go stale. At
-- Tsunami's size (thousands of members) this is milliseconds.
--   per group (treatment / holdout): members, buyers, orders, net revenue,
--     revenue per member, AOV, purchase and repeat rate, days between
--     orders, points issued / redeemed, reward cost
--   lift: (value per treatment member - value per holdout member), with a
--     95% range (Welch). value = revenue x gross margin - reward cost, or
--     revenue - reward cost when the margin isn't set. Incremental total =
--     lift x treatment members.
--   influenced orders (descriptive, not causal): a reward code or referral
--     coupon was used, a loyalty email event was sent in the attribution
--     window before the order, or the order moved the member up a tier
--   liability: points outstanding at the end of the period, and their value
--     at the cheapest points-per-dollar reward
--   aa_check: true until treatment_since is set (no Phase 1b feature live
--     yet). Both groups get the same thing then, so lift should be ~0: a
--     check that the split is fair.
--
-- loyalty_staff_insights(program, from, to, bucket) is the staff RPC
-- (summary + weekly/monthly series). Aggregates only, no member data, so it
-- isn't written to the access log. Still staff + MFA only (0210).
--
-- Test: scripts/test_loyalty_measurement.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_programs add column if not exists holdout_percent int not null default 10;
alter table loyalty_programs drop constraint if exists loyalty_programs_holdout_percent_check;
alter table loyalty_programs add constraint loyalty_programs_holdout_percent_check
  check (holdout_percent between 0 and 50);
alter table loyalty_programs add column if not exists holdout_suppressed_kinds text[] not null default '{}';
alter table loyalty_programs add column if not exists treatment_since timestamptz;   -- first Phase 1b feature live
alter table loyalty_programs add column if not exists gross_margin_pct numeric(5,2);
alter table loyalty_programs drop constraint if exists loyalty_programs_gross_margin_pct_check;
alter table loyalty_programs add constraint loyalty_programs_gross_margin_pct_check
  check (gross_margin_pct is null or (gross_margin_pct > 0 and gross_margin_pct <= 100));
alter table loyalty_programs add column if not exists attribution_window interval not null default '7 days';

-- 0-99, fixed per (program, customer). hashtextextended is immutable.
alter table loyalty_members add column if not exists holdout_bucket smallint
  generated always as (((hashtextextended(program_id::text || ':' || shopify_customer_id::text, 0) % 100) + 100) % 100) stored;

create index if not exists idx_loyalty_orders_processed on loyalty_orders(program_id, processed_at);
create index if not exists idx_loyalty_events_member_sent on loyalty_events(member_id, sent_at) where status = 'sent';
create index if not exists idx_loyalty_discount_codes_used_order on loyalty_discount_codes(program_id, used_order_id)
  where used_order_id is not null;

-- -----------------------------------------------------------------------------
-- Holdout checks
-- -----------------------------------------------------------------------------
create or replace function loyalty_member_treated(p_member uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select m.holdout_bucket >= p.holdout_percent
    from loyalty_members m join loyalty_programs p on p.id = m.program_id
   where m.id = p_member;
$$;

-- 0205's, plus: kinds the program lists in holdout_suppressed_kinds are never
-- queued for a holdout member.
create or replace function loyalty_emit_event(p_member uuid, p_kind text, p_dedupe_key text, p_payload jsonb default '{}'::jsonb)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if loyalty_quiet() then
    return false;
  end if;
  insert into loyalty_events (program_id, member_id, kind, payload, dedupe_key)
  select m.program_id, m.id, p_kind, coalesce(p_payload, '{}'::jsonb), p_dedupe_key
    from loyalty_members m join loyalty_programs p on p.id = m.program_id
   where m.id = p_member
     and not (p_kind = any (p.holdout_suppressed_kinds) and m.holdout_bucket < p.holdout_percent)
  on conflict (program_id, dedupe_key) do nothing;
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- loyalty_insights — one period [p_from, p_to) in the program's time zone.
-- -----------------------------------------------------------------------------
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
  update pg_temp.li_per set val = case when v_margin is null then rev - cost else rev * v_margin - cost end;

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

-- -----------------------------------------------------------------------------
-- Staff RPC: summary for the period + a weekly or monthly series.
-- -----------------------------------------------------------------------------
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
  perform loyalty_require_staff();
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

revoke execute on function loyalty_member_treated(uuid) from public, anon, authenticated;
revoke execute on function loyalty_insights(uuid, date, date) from public, anon, authenticated;
revoke execute on function loyalty_staff_insights(uuid, date, date, text) from public, anon;
grant execute on function loyalty_member_treated(uuid) to service_role;
grant execute on function loyalty_insights(uuid, date, date) to service_role;
grant execute on function loyalty_staff_insights(uuid, date, date, text) to authenticated;
