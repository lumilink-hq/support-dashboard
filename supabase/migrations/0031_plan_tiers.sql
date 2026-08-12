-- =============================================================================
-- 0031_plan_tiers.sql
-- THE TIER LAYER. Makes it safe to sell Growth and Scale self-serve.
--
-- THE BUG THIS CLOSES, stated plainly:
--
--   billing_price_map is FEATURE-level. All three plan prices map to feature
--   'voice', so the webhook could tell you SOMEONE BOUGHT VOICE but never WHICH
--   PLAN. provision-feature therefore hardcoded the entry allowance:
--
--       p_monthly_minutes: STARTER_INCLUDED_MINUTES   -- 100, always
--
--   A Scale customer paying $449 for 600 minutes was provisioned with 100.
--   Nothing errored. Nothing logged. The only signal was a confused customer.
--
--   That was tolerable while Growth and Scale were sold "Talk to us" and an
--   operator raised the cap by hand as part of the sale. The moment a Payment
--   Link exists for them, the manual step disappears and the gap becomes a
--   silent under-delivery on every purchase. 0008's own comment, the seed file
--   and docs/STRIPE-GO-LIVE.md §6 all say: build this before publishing links.
--   This is that.
--
-- WHAT IT ADDS
--   1. plan_tiers            — the tier ladder as DATA. One row per sellable
--                              plan, carrying its minute allowance.
--   2. billing_price_map.plan_tier / kind / addon_key
--                            — a price now says which TIER it sells, not just
--                              which feature. `kind` reserves the add-on slot.
--   3. entitlements.plan_tier — what the client actually bought, so provisioning
--                              (and /billing) can read it back.
--   4. set_plan_tier_caps()  — applies a TIER's allowance, RAISE-ONLY.
--   5. apply_billing_event() — recreated with p_plan_tier.
--
-- WHY plan_tiers IS A TABLE AND NOT AN ENUM. Adding a tier must be an INSERT,
-- not a migration, for the same reason 0008 made status TEXT + CHECK. And the
-- allowance has to live somewhere the DB can read during provisioning; a TS
-- constant cannot be joined against.
--
-- RELATIONSHIP TO lib/entitlements.ts. PLAN_TIERS there is DISPLAY truth (the
-- pricing page); plan_tiers here is ENFORCEMENT truth (what gets provisioned).
-- They are both mirrors of the CFO workbook v2.0 and MUST agree. Section 7 has
-- the query that proves it. If they disagree, the customer is quoted one number
-- and given another.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. plan_tiers — the ladder, as data.
--
-- included_minutes is the load-bearing column; everything else is here so the
-- DB and the pricing page can be checked against each other in one query.
--
-- No RLS: this is public price-list information, not tenant data. It is granted
-- read to authenticated below rather than left to 0001's default grants so the
-- intent is explicit. Nobody but an operator writes it.
-- -----------------------------------------------------------------------------
create table if not exists plan_tiers (
  tier             text        primary key,
  label            text        not null,
  monthly_usd      numeric(12,2) not null check (monthly_usd >= 0),
  setup_fee_usd    numeric(12,2) not null check (setup_fee_usd >= 0),
  -- The allowance provisioning applies. NOT nullable and NOT negative: -1 means
  -- "explicitly unlimited" in 0012's cap semantics, and a plan purchase must
  -- never be able to grant that.
  included_minutes int         not null check (included_minutes >= 0),
  sort_order       int         not null default 0,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

do $$ begin
  create trigger trg_plan_tiers_updated_at
    before update on plan_tiers
    for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- CFO workbook "LumiLink Financial Hub". Mirrors PLAN_TIERS in
-- lib/entitlements.ts. Re-running refreshes the numbers rather than duplicating.
--
-- SETUP FEE, 2026-08-11: a flat 49.99 on all three tiers, down from
-- 299 / 499 / 799. Workbook updated first; these follow it.
--
-- setup_fee_usd is DISPLAY ONLY and nothing bills from it — the charge comes
-- from the one-time price on the Stripe Payment Link, which is a separate
-- object this table cannot reach. Changing the number here without creating
-- new Stripe prices makes the pricing page quote $49.99 while the invoice
-- charges $299, which is worse than either number being wrong on its own.
-- docs/STRIPE-TIERS-RUNBOOK.md §2a is the procedure.
insert into plan_tiers (tier, label, monthly_usd, setup_fee_usd, included_minutes, sort_order)
values
  ('starter', 'Starter', 179.00, 49.99, 100, 1),
  ('growth',  'Growth',  279.00, 49.99, 250, 2),
  ('scale',   'Scale',   449.00, 49.99, 600, 3)
on conflict (tier) do update
  set label            = excluded.label,
      monthly_usd      = excluded.monthly_usd,
      setup_fee_usd    = excluded.setup_fee_usd,
      included_minutes = excluded.included_minutes,
      sort_order       = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 2. billing_price_map learns about tiers and add-ons.
--
--    kind distinguishes a PLAN price (decides the tier and the allowance) from
--    an ADD-ON price (extra number, extra department — billed alongside, grants
--    no tier). Nothing sells add-ons yet; the column exists so that when the
--    Stripe products are created they can be mapped without another migration,
--    and — more importantly — so tier resolution can EXCLUDE them from day one.
--
--    Without `kind`, the first add-on row added to this table becomes a
--    candidate answer to "which tier did they buy?", because the webhook
--    matches every price id on the event. An extra-number line resolving as the
--    plan is exactly the class of bug this migration exists to end.
-- -----------------------------------------------------------------------------
alter table billing_price_map
  add column if not exists plan_tier text references plan_tiers(tier),
  add column if not exists kind      text not null default 'plan',
  add column if not exists addon_key text;

do $$ begin
  alter table billing_price_map
    add constraint billing_price_map_kind_chk check (kind in ('plan', 'addon'));
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- 2b. Backfill plan_tier on the rows that already exist.
--
--     display_amount is the only tier-identifying fact already in the table, and
--     it is reliable here: the six seeded rows (three live, three test) carry
--     179 / 279 / 449 exactly, and the setup-fee prices were deliberately never
--     mapped (see the seed file's closing note), so there is nothing to confuse.
--
--     Doing this in the migration rather than the seed is deliberate — section
--     2c constrains the column immediately afterwards, and a live database with
--     unbackfilled rows would fail that constraint on deploy.
-- -----------------------------------------------------------------------------
do $$
declare
  v_touched int;
begin
  update billing_price_map m
     set plan_tier = t.tier
    from plan_tiers t
   where m.plan_tier is null
     and m.kind = 'plan'
     and m.display_amount = t.monthly_usd;

  get diagnostics v_touched = row_count;
  raise notice '0031: backfilled plan_tier on % price-map row(s)', v_touched;
end $$;

-- -----------------------------------------------------------------------------
-- 2c. A plan price with no tier is the original bug. Refuse to store one.
--
--     NOT VALID is not used: the whole point is that existing rows are checked,
--     and 2b has just fixed them. If this constraint fails on deploy, a plan
--     price is mapped at an amount that matches no tier — resolve it by hand
--     before continuing rather than dropping the constraint. The query is in
--     section 7.
-- -----------------------------------------------------------------------------
do $$ begin
  alter table billing_price_map
    add constraint billing_price_map_plan_needs_tier
    check (kind <> 'plan' or plan_tier is not null);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table billing_price_map
    add constraint billing_price_map_addon_needs_key
    check (kind <> 'addon' or addon_key is not null);
exception when duplicate_object then null; end $$;

-- Tier resolution filters on (processor, kind, is_active) then matches ids.
create index if not exists idx_billing_price_map_plan
  on billing_price_map(processor, kind) where is_active;

-- -----------------------------------------------------------------------------
-- 3. entitlements remembers WHICH PLAN was bought.
--
--    Nullable on purpose. A 'manual' or 'trial' grant has no Stripe price and
--    therefore no tier, and those must keep working exactly as they do today —
--    see the null-tier path in provision-feature. Null means "no tier known",
--    not "starter".
-- -----------------------------------------------------------------------------
alter table entitlements
  add column if not exists plan_tier text references plan_tiers(tier);

comment on column entitlements.plan_tier is
  'Which plan the client bought, resolved from the price map. NULL for manual/'
  'trial grants that never went through checkout. Read by provision-feature to '
  'apply the right minute allowance.';

-- -----------------------------------------------------------------------------
-- 4. set_plan_tier_caps — apply a TIER's allowance to one client.
--
--    RAISE-ONLY by default, and this is the important design decision in the
--    whole migration. The three candidate behaviours, and why the other two are
--    wrong:
--
--    (a) Never overwrite an existing cap — what set_plan_voice_caps does today.
--        0025 backfilled an EXPLICIT monthly_minutes onto every client that
--        existed at the time (at the then-default of 200). A Growth customer in
--        that group would buy 250 minutes and keep 200; a Scale customer would
--        buy 600 and keep 200. Silent under-delivery, which is the exact failure
--        this migration exists to prevent — just moved one layer down.
--
--    (b) Always overwrite — knocks a manually-granted allowance back down every
--        time provisioning re-runs. 0025's header says an operator's higher
--        grant must survive re-provisioning, and that is still right.
--
--    (c) RAISE-ONLY: apply the tier's allowance when it is HIGHER than what is
--        set; leave a higher existing cap alone. A paying customer can never end
--        up below what they bought, and an operator's deliberate top-up is never
--        clobbered. Both of (a)'s and (b)'s failures are excluded.
--
--    THE COST OF (c), stated so nobody discovers it later: a DOWNGRADE does not
--    lower the cap on its own. A Scale customer who moves to Starter keeps 600
--    minutes until someone calls this with p_overwrite => true. Downgrades are
--    sales-assisted and rare; a downgrade that over-delivers is a smaller
--    problem than an upgrade that under-delivers, and unlike the latter it is
--    visible in the usage meter.
--
--    An unknown tier returns ok=false rather than falling back to the entry
--    allowance. Guessing is how the original bug worked. The caller parks the
--    task for a human instead.
-- -----------------------------------------------------------------------------
create or replace function set_plan_tier_caps(
  p_client_id     uuid,
  p_plan_tier     text,
  p_max_call_secs int     default null,
  p_overwrite     boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_minutes int;
  v_caps    jsonb;
  v_current int;
  v_new     jsonb;
begin
  if p_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'client_id is required');
  end if;
  if p_plan_tier is null then
    return jsonb_build_object('ok', false, 'error', 'plan_tier is required');
  end if;

  select included_minutes into v_minutes
    from plan_tiers where tier = p_plan_tier and is_active;

  if v_minutes is null then
    -- Do NOT fall back to the entry allowance. A tier we cannot price is a
    -- configuration gap, and the safe response is to stop and be seen.
    return jsonb_build_object(
      'ok', false,
      'error', format('unknown or inactive plan_tier %L', p_plan_tier));
  end if;

  select coalesce(settings -> 'voice_caps', '{}'::jsonb)
    into v_caps
    from clients
   where id = p_client_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;

  -- Tested with ->> rather than the `?` existence operator, matching 0025: a key
  -- present but JSON-null resolves to the platform default in client_voice_caps,
  -- so treating it as "already set" would leave the client effectively uncapped.
  --
  -- Guarded with CASE rather than a bare cast. settings is free-form jsonb that
  -- operators edit by hand, so monthly_minutes can hold anything; a bare
  -- `::int` on "unlimited" or "100 " raises invalid_text_representation and
  -- takes down the provisioning run for that client. CASE also guarantees the
  -- regex is evaluated before the cast, which a `where x ~ '…' and x::int = …`
  -- does not — Postgres is free to reorder AND branches.
  --
  -- The '-?' is deliberate: -1 means "explicitly unlimited" in 0012's cap
  -- semantics and must be READ correctly so the branch below can preserve it.
  -- An unparseable value reads as null, i.e. "no explicit cap", and the tier
  -- allowance is applied over it — which is the right answer for a junk value.
  v_current := case
    when (v_caps ->> 'monthly_minutes') ~ '^-?[0-9]+$'
      then (v_caps ->> 'monthly_minutes')::int
    else null
  end;

  -- RAISE-ONLY. -1 (explicitly unlimited) is greater than any allowance we sell,
  -- so the >= comparison below correctly leaves it alone... except that -1 is
  -- numerically LESS than any tier, which would silently CAP an unlimited
  -- client. Handle it explicitly rather than relying on the arithmetic.
  if not p_overwrite and v_current is not null and v_current < 0 then
    return jsonb_build_object(
      'ok', true, 'changed', false, 'reason', 'unlimited_cap_preserved',
      'monthly_minutes', v_current);
  end if;

  if not p_overwrite and v_current is not null and v_current >= v_minutes then
    return jsonb_build_object(
      'ok', true, 'changed', false, 'reason', 'existing_cap_is_higher_or_equal',
      'monthly_minutes', v_current, 'plan_tier', p_plan_tier);
  end if;

  v_new := v_caps || jsonb_build_object('monthly_minutes', v_minutes);
  if p_max_call_secs is not null then
    v_new := v_new || jsonb_build_object('max_call_secs', p_max_call_secs);
  end if;

  update clients
     set settings = coalesce(settings, '{}'::jsonb)
                    || jsonb_build_object('voice_caps', v_new)
   where id = p_client_id;

  return jsonb_build_object(
    'ok', true,
    'changed', true,
    'plan_tier', p_plan_tier,
    'monthly_minutes', v_minutes,
    'previous_minutes', v_current,
    'max_call_secs', p_max_call_secs);
end;
$$;

-- Same posture as 0012's gate and 0025's cap setter: orchestration only. A
-- tenant must never be able to raise its own allowance.
revoke execute on function set_plan_tier_caps(uuid, text, int, boolean) from public;
grant  execute on function set_plan_tier_caps(uuid, text, int, boolean) to service_role;

comment on function set_plan_tier_caps(uuid, text, int, boolean) is
  'Applies a plan TIER''s minute allowance to one client. Raise-only by default: '
  'never lowers an existing cap, never leaves a payer below what they bought. '
  'Returns ok=false on an unknown tier rather than guessing. Service role only.';

grant select on plan_tiers to authenticated;

-- -----------------------------------------------------------------------------
-- 5. apply_billing_event — recreated with p_plan_tier.
--
--    DROPPED FIRST, DELIBERATELY. `create or replace` with an extra defaulted
--    parameter does not replace anything: Postgres treats a different argument
--    list as a NEW function, leaving both definitions in place. PostgREST
--    resolves .rpc() calls by argument name, so a call supplying the eight
--    original arguments would match both candidates and fail with
--    "could not choose the best candidate function" — every webhook delivery
--    500ing, on a function that looks correct in isolation. Same class of latent
--    breakage as 0026's boolean = integer, so it gets the same treatment: fix it
--    where it is written, not where it surfaces.
--
--    Behaviour is 0026's, unchanged, plus tier recording:
--      * new grant          -> plan_tier stored on the entitlement
--      * renewal / recovery -> plan_tier UPDATED when the event carries one
--
--    That second line is what makes an upgrade work. Changing the subscription's
--    price in Stripe puts the new price on the next invoice, which resolves to
--    the new tier, which lands here — and provisioning raises the cap on the
--    next run. coalesce() means an event WITHOUT a tier (a cancel, a manual
--    generic-adapter event) never erases the tier we already know.
-- -----------------------------------------------------------------------------
drop function if exists apply_billing_event(
  text, text, text, uuid, feature_t, text, timestamptz, jsonb);

create or replace function apply_billing_event(
  p_processor          text,
  p_external_event_id  text,
  p_event_type         text,
  p_client_id          uuid,
  p_feature            feature_t,
  p_subscription_ref   text          default null,
  p_current_period_end timestamptz   default null,
  p_payload            jsonb         default '{}'::jsonb,
  p_plan_tier          text          default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows         int;
  v_has_existing boolean;
  v_result       text;
  v_existing     entitlements%rowtype;
  v_same_sub     boolean;
  v_tier         text;
begin
  -- 1) Idempotency: first writer wins; a re-delivered event does nothing.
  insert into billing_events (processor, external_event_id, event_type, client_id, feature, payload)
  values (p_processor, p_external_event_id, p_event_type, p_client_id, p_feature, coalesce(p_payload, '{}'::jsonb))
  on conflict (processor, external_event_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('status','duplicate','event_id',p_external_event_id);
  end if;

  -- 2) Must know who + what. If not, park for manual reconciliation.
  if p_client_id is null or p_feature is null then
    v_result := 'unmapped';
    update billing_events set result = v_result, processed_at = now()
     where processor = p_processor and external_event_id = p_external_event_id;
    return jsonb_build_object('status', v_result, 'event_id', p_external_event_id);
  end if;

  -- An unrecognised tier is dropped rather than stored. entitlements.plan_tier
  -- has an FK to plan_tiers, so passing a junk value through would abort the
  -- whole transaction — including the billing_events row that records what
  -- happened. A null tier degrades to today's behaviour; an aborted transaction
  -- degrades to a 500 and a Stripe retry loop.
  select tier into v_tier from plan_tiers where tier = p_plan_tier;

  select * into v_existing from entitlements
    where client_id = p_client_id and feature = p_feature;
  v_has_existing := found;

  -- Does this event concern the SAME subscription we already track? Used to tell a
  -- stale/out-of-order event for an old sub from a genuine new signup. When we have
  -- no ref on either side we can't distinguish, so we treat it as the same.
  v_same_sub := (
    p_subscription_ref is null
    or v_existing.external_subscription_ref is null
    or v_existing.external_subscription_ref = p_subscription_ref
  );

  -- 3) Route.
  if p_event_type in ('subscription_activated','subscription_renewed') then
    if not v_has_existing then
      -- New grant: create as 'pending' and kick off provisioning.
      insert into entitlements (client_id, feature, status, source, processor,
                                external_subscription_ref, current_period_end,
                                plan_tier)
      values (p_client_id, p_feature, 'pending', 'checkout', p_processor,
              p_subscription_ref, p_current_period_end, v_tier);
      perform enqueue_provisioning(p_client_id, p_feature);
      v_result := 'applied';

    elsif v_existing.status = 'canceled' then
      if v_same_sub then
        -- Stale/out-of-order activate|renew for the sub we already canceled (e.g.
        -- a trailing invoice.paid after the cancel). Do NOT resurrect or
        -- re-provision — that would re-buy infra for a dead plan.
        v_result := 'stale_ignored';
      else
        -- Genuinely NEW subscription after the old one was canceled → re-grant.
        -- The new subscription's tier wins outright here: this is a fresh
        -- purchase, so carrying the dead plan's tier forward would provision the
        -- wrong allowance for someone who just re-bought at a different level.
        update entitlements
           set status = 'pending', source = 'checkout',
               processor = coalesce(processor, p_processor),
               external_subscription_ref = p_subscription_ref,
               current_period_end = p_current_period_end,
               plan_tier = coalesce(v_tier, plan_tier),
               canceled_at = null
         where id = v_existing.id;
        perform enqueue_provisioning(p_client_id, p_feature);
        v_result := 'applied';
      end if;

    elsif v_existing.status = 'active' then
      -- Renewal of a live feature: extend the period (monotonic — never shorten on
      -- an out-of-order older event). No re-provision.
      update entitlements
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor),
             plan_tier = coalesce(v_tier, plan_tier)
       where id = v_existing.id;

      -- ...UNLESS THE TIER MOVED. Then the caps are stale and must be re-applied.
      --
      -- Two situations reach this line, and both used to end with a customer on
      -- the wrong allowance:
      --
      --   AN UPGRADE. Changing the subscription's price in Stripe puts the new
      --   price on the next invoice. Recording the new tier without
      --   re-provisioning would leave a customer who is now paying $449 on the
      --   250 minutes they had before, indefinitely.
      --
      --   A LATE TIER. If the grant event carried no tier (link metadata was
      --   missing, so only the price map could answer) the entitlement was
      --   created null and provisioned at the entry allowance. The first
      --   invoice.paid then arrives WITH prices, resolves the real tier, and
      --   lands exactly here. This is the recovery path for a misconfigured
      --   link — without it, that misconfiguration is permanent and silent.
      --
      -- `is distinct from` rather than <>, so a null-to-value transition counts.
      -- Re-provisioning is safe to repeat: the caps are raise-only, the number
      -- already exists so nothing is bought, and the ElevenLabs attach is
      -- idempotent. enqueue_provisioning is a no-op when a task is already open.
      if v_tier is not null and v_tier is distinct from v_existing.plan_tier then
        perform enqueue_provisioning(p_client_id, p_feature);
      end if;

      v_result := 'applied';

    elsif v_existing.status = 'past_due' then
      -- Payment recovered on an already-provisioned feature → back to active
      -- WITHOUT re-provisioning (the infra already exists).
      update entitlements
         set status = 'active',
             current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor),
             plan_tier = coalesce(v_tier, plan_tier)
       where id = v_existing.id;
      v_result := 'applied';

    else
      -- status = 'pending': still provisioning. Update linkage/period and make sure
      -- a provisioning task exists (enqueue is a no-op if one is already open).
      --
      -- Recording the tier here matters more than it looks: the FIRST event of a
      -- purchase (checkout.session.completed) carries a client_id but no price,
      -- so it creates the entitlement with a NULL tier. The tier arrives on the
      -- SECOND event (subscription.created), which lands on exactly this branch.
      -- Without this line a self-serve Growth purchase would be provisioned with
      -- no tier at all.
      update entitlements
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor),
             plan_tier = coalesce(v_tier, plan_tier)
       where id = v_existing.id;
      perform enqueue_provisioning(p_client_id, p_feature);
      v_result := 'applied';
    end if;

  elsif p_event_type = 'payment_failed' then
    update entitlements
       set status = 'past_due'
     where client_id = p_client_id and feature = p_feature
       and status in ('active','pending','past_due')
       and (p_subscription_ref is null
            or external_subscription_ref is null
            or external_subscription_ref = p_subscription_ref);
    v_result := 'applied';

  elsif p_event_type = 'subscription_canceled' then
    -- Only cancel the sub we track — a late cancel of an OLD sub must not kill a
    -- freshly re-subscribed plan.
    update entitlements
       set status = 'canceled', canceled_at = now()
     where client_id = p_client_id and feature = p_feature
       and status <> 'canceled'
       and (p_subscription_ref is null
            or external_subscription_ref is null
            or external_subscription_ref = p_subscription_ref);
    v_result := 'applied';

  else
    v_result := 'ignored';
  end if;

  update billing_events
     set result = v_result, processed_at = now()
   where processor = p_processor and external_event_id = p_external_event_id;

  return jsonb_build_object('status', v_result, 'client_id', p_client_id,
                            'feature', p_feature, 'plan_tier', v_tier);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Backfill plan_tier on entitlements that already exist.
--
--    Only where it can be established WITHOUT guessing: match the client's
--    current explicit cap against a tier's allowance. Everything else stays
--    null, which is the honest answer and which provisioning handles.
--
--    Deliberately NOT defaulting the rest to 'starter'. Those clients were
--    granted before tiers existed and their caps were set by hand or by 0025's
--    backfill; labelling them Starter would be inventing a commercial fact and
--    could later cause set_plan_tier_caps to be called with the wrong tier.
-- -----------------------------------------------------------------------------
do $$
declare
  v_touched int;
begin
  -- Same CASE guard as set_plan_tier_caps, for the same reason: settings is
  -- hand-editable jsonb, and one client with a non-numeric monthly_minutes
  -- would abort the whole migration on a bare ::int cast.
  update entitlements e
     set plan_tier = t.tier
    from clients c
    join plan_tiers t
      on t.included_minutes = case
           when (c.settings -> 'voice_caps' ->> 'monthly_minutes') ~ '^[0-9]+$'
             then (c.settings -> 'voice_caps' ->> 'monthly_minutes')::int
           else null
         end
   where e.plan_tier is null
     and e.feature = 'voice'
     and c.id = e.client_id;

  get diagnostics v_touched = row_count;
  raise notice '0031: inferred plan_tier on % existing voice entitlement(s); the rest stay null by design', v_touched;
end $$;

-- =============================================================================
-- 7. VERIFY. Run all four after applying.
-- =============================================================================
--
-- a) Every active plan price knows its tier and allowance. Six rows expected
--    (three live, three test), none with a null tier:
--
--      select m.external_price_id, m.display_amount, m.plan_tier,
--             t.included_minutes
--        from billing_price_map m
--        left join plan_tiers t on t.tier = m.plan_tier
--       where m.processor = 'stripe' and m.kind = 'plan'
--       order by m.display_amount;
--
-- b) The DB and the pricing page agree. This must return ZERO rows — if it
--    doesn't, /plans is quoting a number the customer will not be given:
--
--      select tier, monthly_usd, included_minutes from plan_tiers
--       where (tier, monthly_usd, included_minutes) not in (
--         ('starter', 179.00, 100),
--         ('growth',  279.00, 250),
--         ('scale',   449.00, 600));
--
--    (Compare against PLAN_TIERS in lib/entitlements.ts by eye; they are the
--    two mirrors of the CFO workbook.)
--
-- c) The function was replaced, not overloaded. Exactly ONE row, 9 arguments:
--
--      select pronargs, pg_get_function_identity_arguments(oid)
--        from pg_proc where proname = 'apply_billing_event';
--
-- d) Raise-only works, without touching a real client:
--
--      select set_plan_tier_caps('<client uuid>', 'growth', 105, false);
--        -> changed:true, monthly_minutes:250   (was 100 or 200)
--      select set_plan_tier_caps('<client uuid>', 'starter', 105, false);
--        -> changed:false, reason:'existing_cap_is_higher_or_equal'
--      select set_plan_tier_caps('<client uuid>', 'nonsense', 105, false);
--        -> ok:false, unknown or inactive plan_tier
--
-- End of 0031.
