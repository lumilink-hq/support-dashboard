-- =============================================================================
-- 0037 — Plan allowances re-synced to the CFO workbook dated 2026-08-16.
--
-- WHAT WAS WRONG. The workbook's "Products & Add-ons" sheet prices Starter at
-- 90 calls / 180 minutes, Growth at 175 / 350 and Scale at 300 / 600. plan_tiers
-- has carried 100 / 250 / 600 since 0031, and lib/entitlements.ts quoted the
-- same. So for two tiers we were SELLING LESS THAN THE MODEL CHARGES FOR — the
-- margin in the workbook assumes a customer who can use 180 minutes on Starter,
-- and we were provisioning 100.
--
-- The DOLLAR prices did not move: 179 / 279 / 449 were already right, which is
-- why this migration touches no Stripe object and needs no new price ids. The
-- only money field that changes is setup_fee_usd, and only to catch up with a
-- decision already taken — setup went to $0 on 2026-08-13 and this table was
-- left at 49.99 because it is display-only and nothing failed.
--
-- WHY RAISING A CAP IS SAFE TO DO IN A MIGRATION. Every change here is upward.
-- No live client loses minutes, no call that would have connected now gets
-- refused, and the worst case is a customer who can talk for longer than they
-- could yesterday. A migration that LOWERED an allowance would belong in a
-- release with a customer notice; this one does not.
--
-- Mirror of this change in the app: lib/entitlements.ts (PLAN_TIERS and
-- STARTER_PLAN). Those two must be edited together — 0031 §7b is the query that
-- catches it when they aren't, and its expected values are restated at the
-- bottom of this file because the ones written into 0031 are now stale.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The tier table.
--
--    Written as an explicit UPDATE per tier rather than a re-run of 0031's
--    upsert: this must not create a tier, and it must not resurrect one that has
--    since been deactivated. If a tier is missing, the notice below says so
--    instead of the row quietly appearing.
-- -----------------------------------------------------------------------------
do $$
declare
  v_touched int;
begin
  update plan_tiers t
     set included_minutes = v.minutes,
         setup_fee_usd    = 0
    from (values
            ('starter', 180),
            ('growth',  350),
            ('scale',   600)
         ) as v(tier, minutes)
   where t.tier = v.tier
     and (t.included_minutes <> v.minutes or t.setup_fee_usd <> 0);

  get diagnostics v_touched = row_count;
  raise notice '0037: % plan_tiers row(s) moved to the 2026-08-16 workbook allowances', v_touched;

  if (select count(*) from plan_tiers where tier in ('starter','growth','scale')) < 3 then
    raise warning '0037: fewer than three named tiers exist — check plan_tiers before deploying /plans';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. The platform default follows the ENTRY tier, as 0025 established.
--
--    default_monthly_minutes is what a client with no explicit voice_caps gets.
--    0025 set it to 100 precisely so an unprovisioned client could not run more
--    minutes than Starter sells; the same reasoning now points at 180. Leaving
--    it at 100 would not be safe-by-default, it would be a second, invisible
--    allowance that contradicts the one on the pricing page.
--
--    default_max_call_secs is NOT touched. 105s sits deliberately under the
--    ElevenLabs 120s hard cut (0025 §1, 0027) and has nothing to do with the
--    monthly allowance.
-- -----------------------------------------------------------------------------
update platform_settings
   set default_monthly_minutes = 180,
       -- Column is `note`, singular, and 0025 appends rather than replaces. Same
       -- separator logic so a first-ever note doesn't start with " | ".
       note = coalesce(nullif(note, ''), '')
              || case when coalesce(note, '') = '' then '' else ' | ' end
              || '0037: entry-tier default raised 100 -> 180 (CFO workbook 2026-08-16)'
 where id = 1
   and default_monthly_minutes <> 180;

-- -----------------------------------------------------------------------------
-- 3. Existing clients get the minutes they are now being sold.
--
--    Changing plan_tiers does NOT change anyone's cap: the allowance is copied
--    into clients.settings->'voice_caps' at provisioning time, so a client
--    provisioned last week still holds 100. Re-running set_plan_tier_caps is the
--    supported way to re-apply it.
--
--    p_overwrite stays FALSE on purpose. In that mode the function is raise-only
--    and it explicitly preserves -1 (unlimited), so a hand-set higher cap or an
--    unlimited client is left exactly as it is. Passing true here would quietly
--    cap the very clients someone deliberately uncapped.
--
--    Only entitlements with a known plan_tier are touched. 0031 §6 deliberately
--    left pre-tier clients null rather than guessing 'starter', and this
--    migration does not get to guess either.
-- -----------------------------------------------------------------------------
do $$
declare
  r        record;
  v_result jsonb;
  v_raised int := 0;
  v_kept   int := 0;
begin
  for r in
    select distinct e.client_id, e.plan_tier
      from entitlements e
      join plan_tiers t on t.tier = e.plan_tier
     where e.feature = 'voice'
       and e.plan_tier is not null
  loop
    v_result := set_plan_tier_caps(r.client_id, r.plan_tier, null, false);

    if coalesce((v_result ->> 'changed')::boolean, false) then
      v_raised := v_raised + 1;
    else
      v_kept := v_kept + 1;
      raise notice '0037: client % left at its existing cap (%)',
        r.client_id, coalesce(v_result ->> 'reason', v_result ->> 'error');
    end if;
  end loop;

  raise notice '0037: raised % client cap(s); left % untouched', v_raised, v_kept;
end $$;

-- =============================================================================
-- 4. VERIFY. Run all three after applying.
-- =============================================================================
--
-- a) The tier table matches the workbook. Must return ZERO rows. This SUPERSEDES
--    the version in 0031 §7b, which still lists 100 and 250:
--
--      select tier, monthly_usd, included_minutes, setup_fee_usd
--        from plan_tiers
--       where (tier, monthly_usd, included_minutes, setup_fee_usd) not in (
--         ('starter', 179.00, 180, 0.00),
--         ('growth',  279.00, 350, 0.00),
--         ('scale',   449.00, 600, 0.00));
--
-- b) No tiered client is still holding a smaller cap than the tier they pay for.
--    Rows here are clients whose provisioning did not take:
--
--      select c.id, e.plan_tier, t.included_minutes,
--             c.settings -> 'voice_caps' ->> 'monthly_minutes' as actual
--        from entitlements e
--        join clients c    on c.id = e.client_id
--        join plan_tiers t on t.tier = e.plan_tier
--       where e.feature = 'voice'
--         and (c.settings -> 'voice_caps' ->> 'monthly_minutes') ~ '^[0-9]+$'
--         and (c.settings -> 'voice_caps' ->> 'monthly_minutes')::int
--             < t.included_minutes;
--
-- c) The unprovisioned default matches Starter:
--
--      select default_monthly_minutes, default_max_call_secs
--        from platform_settings where id = 1;   -- expect 180, 105
--
-- NOT CHANGED BY THIS MIGRATION, and worth knowing:
--   * Stripe. No amount changed, so no new price object and no Payment Link
--     edit. The links keep working and keep granting the right tier.
--   * The workbook's add-on catalogue ($19 phone line, $29 location, $49
--     workflow, $29 integration, $79 optimization). billing_price_map has the
--     `kind`/`addon_key` columns from 0031 §2 but no add-on is sold yet, so
--     there is nothing here to seed.
-- =============================================================================
