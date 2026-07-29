-- =============================================================================
-- test_evaluate_flag_stale.sql — tests for the 0013 stale_exempt_statuses
-- change to evaluate_flag. Wraps everything in a transaction and ROLLS BACK.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_evaluate_flag_stale.sql
--
-- evaluate_flag is shared with the LIVE EMAIL AGENT, so the first block is a
-- backwards-compatibility proof: with no stale_exempt_statuses key, every
-- pre-0013 behavior must be unchanged. If that block ever fails, the email
-- channel's flagging has silently changed.
-- =============================================================================

begin;

do $$
declare
  v_legacy  uuid;
  v_tsunami uuid;
  v_both    uuid;
  v_flag    jsonb;
begin
  -- ---------------------------------------------------------------------------
  -- BLOCK 1 — backwards compatibility. A client with NO stale_exempt_statuses
  -- key must behave exactly as it did before 0013.
  -- ---------------------------------------------------------------------------
  insert into clients (name, slug, is_active, abnormal_status_rules)
  values ('Legacy Co', 'legacy-co', true,
          jsonb_build_object(
            'abnormal_statuses', jsonb_build_array('on-hold','failed'),
            'stale_after_hours', 24))
  returning id into v_legacy;

  select evaluate_flag(v_legacy, 'on-hold', now()) into v_flag;
  assert (v_flag->>'flagged')::boolean is true, 'compat: abnormal status still flags';
  assert v_flag->>'reason' = 'abnormal_status', 'compat: reason abnormal_status';

  select evaluate_flag(v_legacy, 'processing', now() - interval '30 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true, 'compat: stale order still flags';
  assert v_flag->>'reason' = 'order_over_24h', 'compat: reason order_over_24h';

  select evaluate_flag(v_legacy, 'processing', now() - interval '2 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is false, 'compat: fresh order still clean';

  -- The pre-0013 behavior this migration exists to change: with no exempt list,
  -- a COMPLETED order that is simply old still flags. Asserted deliberately, so
  -- the compatibility guarantee is explicit rather than assumed.
  select evaluate_flag(v_legacy, 'completed', now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true,
    'compat: without an exempt list, an old completed order still flags (unchanged)';

  select evaluate_flag(v_legacy, null, now() - interval '30 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true, 'compat: null status + stale flags';

  -- Unknown client -> not flagged, no error.
  select evaluate_flag(gen_random_uuid(), 'on-hold', now()) into v_flag;
  assert (v_flag->>'flagged')::boolean is false, 'compat: unknown client is not flagged';

  -- An explicitly EMPTY exempt array behaves the same as an absent one.
  update clients set abnormal_status_rules =
    abnormal_status_rules || jsonb_build_object('stale_exempt_statuses', '[]'::jsonb)
   where id = v_legacy;
  select evaluate_flag(v_legacy, 'completed', now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true, 'compat: empty exempt array = absent';

  -- ---------------------------------------------------------------------------
  -- BLOCK 2 — the fix, with Tsunami's real Shopify rule shape.
  -- ---------------------------------------------------------------------------
  insert into clients (name, slug, is_active, abnormal_status_rules)
  values ('Tsunami Test', 'tsunami-test', true,
          jsonb_build_object(
            'abnormal_statuses', jsonb_build_array(
              'ON_HOLD','RESTOCKED','REFUNDED','VOIDED','PARTIALLY_REFUNDED'),
            'stale_after_hours', 48,
            'stale_exempt_statuses', jsonb_build_array('FULFILLED','PARTIALLY_FULFILLED')))
  returning id into v_tsunami;

  -- THE HEADLINE CASE: shipped 3 days ago, in transit. Must NOT escalate.
  select evaluate_flag(v_tsunami, 'FULFILLED', now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is false,
    'fix: a FULFILLED order 3 days old must not flag — this is the WISMO call';
  assert v_flag->>'reason' is null, 'fix: no reason when not flagged';

  -- Even very old, once fulfilled, is fine.
  select evaluate_flag(v_tsunami, 'FULFILLED', now() - interval '90 days') into v_flag;
  assert (v_flag->>'flagged')::boolean is false, 'fix: exemption has no time limit';

  select evaluate_flag(v_tsunami, 'PARTIALLY_FULFILLED', now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is false, 'fix: partial fulfillment also exempt';

  -- An order that has NOT shipped and is old is exactly what should still flag.
  select evaluate_flag(v_tsunami, 'UNFULFILLED', now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true,
    'fix: an UNFULFILLED order past the window must still flag';
  assert v_flag->>'reason' = 'order_over_24h', 'fix: reason order_over_24h';

  -- stale_after_hours is respected: 30h < the 48h window.
  select evaluate_flag(v_tsunami, 'UNFULFILLED', now() - interval '30 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is false, 'fix: 48h window respected';

  -- Abnormal statuses still flag regardless of age.
  select evaluate_flag(v_tsunami, 'REFUNDED', now()) into v_flag;
  assert v_flag->>'reason' = 'abnormal_status', 'fix: refunded still abnormal';
  select evaluate_flag(v_tsunami, 'ON_HOLD', now() - interval '72 hours') into v_flag;
  assert v_flag->>'reason' = 'abnormal_status',
    'fix: abnormal wins over staleness for an old order too';

  -- A NULL status cannot be exempt — unknown AND old is what a human should see.
  select evaluate_flag(v_tsunami, null, now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true, 'fix: null status is never exempt';

  -- Case sensitivity: JSONB `?` is exact. A lowercase status does NOT match an
  -- uppercase exempt entry — which is why normalizeStatus() upper-cases before
  -- this is ever called.
  select evaluate_flag(v_tsunami, 'fulfilled', now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true,
    'fix: exemption matching is case-sensitive (statuses must arrive normalized)';

  -- ---------------------------------------------------------------------------
  -- BLOCK 3 — precedence when a status is in BOTH arrays.
  -- ---------------------------------------------------------------------------
  insert into clients (name, slug, is_active, abnormal_status_rules)
  values ('Both Co', 'both-co', true,
          jsonb_build_object(
            'abnormal_statuses',      jsonb_build_array('ON_HOLD'),
            'stale_after_hours',      24,
            'stale_exempt_statuses',  jsonb_build_array('ON_HOLD','FULFILLED')))
  returning id into v_both;

  select evaluate_flag(v_both, 'ON_HOLD', now() - interval '72 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true,
    'precedence: a status in BOTH arrays must still flag as abnormal';
  assert v_flag->>'reason' = 'abnormal_status',
    'precedence: exemption can never suppress an abnormal-status flag';

  raise notice 'ALL EVALUATE_FLAG STALENESS TESTS PASSED';
end;
$$;

rollback;
