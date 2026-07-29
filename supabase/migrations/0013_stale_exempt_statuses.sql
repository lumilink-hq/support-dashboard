-- =============================================================================
-- 0013_stale_exempt_statuses.sql
-- Stop the staleness rule firing on orders that already shipped.
--
-- THE BUG: evaluate_flag (0002) checks order age WITHOUT looking at fulfillment
-- state. So an order placed 3 days ago that shipped, is in transit, and reads
-- FULFILLED still returns {flagged: true, reason: 'order_over_24h'}.
--
-- On email that produced a needless holding reply. On VOICE it is much worse:
-- voice-order-lookup turns `flagged` into should_escalate, and the agent then
-- gives a non-committal holding answer and escalates — on the single most
-- common call there is ("where's my order?", asked precisely BECAUSE it's been
-- a few days), while holding the tracking number in memory. The most common
-- call became the one the bot refuses to answer.
--
-- It's also a unit-economics problem, not just a quality one: escalation adds
-- ~45-60s per call, so on a 100-minute plan it cuts calls served from ~32 to
-- ~15 and generates a callback ticket for nearly every caller.
--
-- THE FIX: a new, OPTIONAL `stale_exempt_statuses` array in
-- clients.abnormal_status_rules. Statuses listed there stop the staleness
-- clock. Absent or empty -> '[]' -> never exempt -> behavior is byte-identical
-- to today, so every existing client (and the live email agent) is unaffected
-- until its rules are updated deliberately.
--
-- Precedence is unchanged and deliberate: abnormal_statuses is still checked
-- FIRST, so listing a status as exempt can never suppress a genuine
-- abnormal-status flag.
--
-- Safe to re-run.
-- =============================================================================

create or replace function evaluate_flag(
  p_client_id       uuid,
  p_store_status    text,
  p_order_placed_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rules       jsonb;
  v_abnormal    jsonb;
  v_exempt      jsonb;
  v_stale_hours numeric;
begin
  select abnormal_status_rules into v_rules from clients where id = p_client_id;
  if v_rules is null then
    return jsonb_build_object('flagged', false, 'reason', null);
  end if;

  v_abnormal    := coalesce(v_rules -> 'abnormal_statuses', '[]'::jsonb);
  v_stale_hours := coalesce((v_rules ->> 'stale_after_hours')::numeric, 24);
  -- NEW in 0013. Absent -> '[]' -> nothing is exempt -> pre-0013 behavior.
  v_exempt      := coalesce(v_rules -> 'stale_exempt_statuses', '[]'::jsonb);

  -- 1. An abnormal status always wins. Checked before the exemption, so a
  --    status that appears in BOTH arrays still flags as abnormal.
  if p_store_status is not null and v_abnormal ? p_store_status then
    return jsonb_build_object('flagged', true, 'reason', 'abnormal_status');

  -- 2. Staleness — but only for orders that haven't reached an exempt state.
  --    A NULL status can't be exempt: we don't know what happened to it, and
  --    "unknown and old" is exactly what a human should look at.
  elsif p_order_placed_at is not null
        and not (p_store_status is not null and v_exempt ? p_store_status)
        and p_order_placed_at < now() - (v_stale_hours::text || ' hours')::interval then
    return jsonb_build_object('flagged', true, 'reason', 'order_over_24h');
  end if;

  return jsonb_build_object('flagged', false, 'reason', null);
end;
$$;

revoke execute on function evaluate_flag(uuid, text, timestamptz) from public;
grant  execute on function evaluate_flag(uuid, text, timestamptz) to service_role;

comment on function evaluate_flag(uuid, text, timestamptz) is
  'Shared email+voice flag rule. abnormal_status_rules keys: abnormal_statuses '
  '(array, checked first), stale_after_hours (number, default 24), '
  'stale_exempt_statuses (array, added 0013 — statuses that stop the staleness '
  'clock, e.g. FULFILLED; absent means nothing is exempt).';

-- -----------------------------------------------------------------------------
-- Client config is DATA, not schema, so it is deliberately not updated here.
-- Apply per client once this is deployed. For Tsunami (Shopify):
--
--   update clients set abnormal_status_rules = jsonb_build_object(
--     'abnormal_statuses', jsonb_build_array(
--        'ON_HOLD','RESTOCKED','REFUNDED','VOIDED','PARTIALLY_REFUNDED'),
--     'stale_after_hours', 48,
--     'stale_exempt_statuses', jsonb_build_array('FULFILLED','PARTIALLY_FULFILLED'))
--   where slug = 'shopify-store';
--
-- NOTE: evaluate_flag is shared with the LIVE EMAIL AGENT. Updating a client's
-- rules changes both channels for that client at once — which is the intent
-- here (email stops sending holding replies about shipped-but-old orders too),
-- but it is a production behavior change on email. Deliberate yes required.
-- -----------------------------------------------------------------------------

-- End of 0013.
