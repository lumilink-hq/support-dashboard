-- =============================================================================
-- 0025_plan_voice_caps.sql
-- Align voice caps with the CFO workbook ("LumiLink Financial Hub" v2.0,
-- as of 2026-07-29) and give provisioning a safe way to apply a plan allowance.
--
-- WHY: three things were out of step with what we actually sell — and one of
-- them was silently breaking every long call in production.
--
--   1. THE PER-CALL CEILING WAS A LIE. ElevenLabs is configured to terminate a
--      call at 120s FLAT. It does that by severing the audio mid-sentence: no
--      warning, no goodbye, indistinguishable from the line dropping.
--
--      voice-order-lookup's checkCallTime() exists to prevent exactly that: it
--      reads max_call_secs from THIS table, computes how long is left, and tells
--      the agent to wind down (remaining <= 45s) and then say goodbye
--      (remaining <= 15s) before the cut lands.
--
--      But default_max_call_secs was 300 (and the runbooks said 180), while the
--      real guillotine is at 120. Wind-down would have fired at 255s elapsed
--      (or 135s at the documented 180) — both AFTER the call was already dead.
--      The graceful-close mechanism could never fire. Every call reaching two
--      minutes was cut off mid-sentence, which DEMO-TEST-CHECKLIST §5.1 had
--      already noticed as a symptom without connecting it to this cause.
--
--      THE FIX: the DB ceiling must sit BELOW the ElevenLabs cap, not at it, so
--      the agent has runway to actually finish speaking. 105s against a 120s
--      guillotine gives wind-down at ~78s and goodbye at ~94s, leaving ~26s of
--      real headroom. Setting it equal to 120 would leave ~12s, which one slow
--      turn erases.
--
--      INVARIANT, and it is the whole point of this section:
--          platform_settings.default_max_call_secs  <  the ElevenLabs agent's
--          "max call duration" setting
--      If anyone raises the ElevenLabs cap, raise this too — and never above it.
--
--   2. default_monthly_minutes = 200, but Starter sells 100. A client left on
--      defaults got twice the allowance they paid for, silently.
--
--   3. Nothing set a per-client cap at provisioning time, so a newly-activated
--      client inherited the platform default rather than their plan's allowance.
--
-- WHAT THIS DOES:
--   * Backfills an EXPLICIT monthly_minutes cap on every existing client, at
--     the value they are effectively on TODAY. Nobody gains or loses allowance
--     when the default changes below — the point is to make the implicit
--     explicit before moving the floor.
--   * Lowers default_monthly_minutes to the entry-tier allowance (100) and
--     default_max_call_secs to 105 (see 1).
--   * Pulls DOWN any per-client max_call_secs override that sits at or above
--     the guillotine, since those clients are the ones actively getting cut off.
--   * Adds set_plan_voice_caps() for provision-feature to call on activation.
--
-- BEHAVIOUR CHANGE ON LIVE TRAFFIC: calls now wind down and close themselves at
-- ~1:45 instead of running to a hard cut at 2:00. Callers get a goodbye and an
-- offer of a callback rather than silence. Average call length drops slightly,
-- which makes the CFO model's "calls at cap = minutes / 2" conservative rather
-- than optimistic. Deploy it deliberately, not incidentally.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- The ElevenLabs agent's hard termination point. NOT enforced here — it lives in
-- the ElevenLabs agent settings — but every value below is derived from it, so
-- it is written down once, in the open, rather than assumed in three places.
-- Keep in sync with docs/TSUNAMI-GO-LIVE.md and the agent config.
--   ELEVENLABS_MAX_CALL_SECS = 120

-- -----------------------------------------------------------------------------
-- 1. Backfill explicit per-client caps BEFORE moving the platform default.
--    Reads the current default and writes it down per client, so the change in
--    section 2 is a no-op for everyone who already exists.
--
--    jsonb_set is deliberately NOT used here: it will not create a missing
--    intermediate object, so it silently does nothing when settings has no
--    'voice_caps' key at all. Merging with || builds the parent and preserves
--    any sibling keys (daily_minutes, cost_per_min_usd, ...).
-- -----------------------------------------------------------------------------
do $$
declare
  v_old_default int;
  v_touched     int;
begin
  select default_monthly_minutes into v_old_default
    from platform_settings where id = 1;

  if v_old_default is null then
    raise notice '0025: no platform_settings row; skipping backfill';
    return;
  end if;

  update clients c
     set settings = coalesce(c.settings, '{}'::jsonb)
                    || jsonb_build_object(
                         'voice_caps',
                         coalesce(c.settings -> 'voice_caps', '{}'::jsonb)
                         || jsonb_build_object('monthly_minutes', v_old_default)
                       )
   where coalesce(c.settings, '{}'::jsonb) -> 'voice_caps' ->> 'monthly_minutes'
         is null;

  get diagnostics v_touched = row_count;
  raise notice '0025: pinned monthly_minutes=% on % client(s)',
    v_old_default, v_touched;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Move the platform defaults to match what we sell.
--    default_monthly_minutes mirrors the ENTRY tier (Starter = 100) so a new
--    client can never default to more than the cheapest plan includes.
--    default_max_call_secs sits 15s under the 120s ElevenLabs guillotine so the
--    agent's goodbye lands before the cut (see the header).
-- -----------------------------------------------------------------------------
update platform_settings
   set default_monthly_minutes = 100,
       default_max_call_secs   = 105,
       note = coalesce(nullif(note, ''), '')
              || case when coalesce(note, '') = '' then '' else ' | ' end
              || '0025: defaults aligned to CFO v2.0 (Starter 100 min); max_call_secs 105 < ElevenLabs 120s hard cut'
 where id = 1
   and (default_monthly_minutes <> 100 or default_max_call_secs <> 105);

-- -----------------------------------------------------------------------------
-- 2b. Pull down per-client overrides that sit at or above the guillotine.
--
--     A client with an explicit max_call_secs of 180 or 300 is precisely the
--     client whose calls are being severed today: checkCallTime measures against
--     their override, so their wind-down and goodbye are scheduled for a moment
--     that arrives after ElevenLabs has already hung up. Section 2 does not
--     reach them — an explicit value always wins over the default — so they
--     have to be corrected directly.
--
--     Only values >= 105 are touched. A client deliberately set LOWER (a short
--     demo line, say) is left exactly as configured.
-- -----------------------------------------------------------------------------
do $$
declare
  v_touched int;
begin
  update clients c
     set settings = coalesce(c.settings, '{}'::jsonb)
                    || jsonb_build_object(
                         'voice_caps',
                         coalesce(c.settings -> 'voice_caps', '{}'::jsonb)
                         || jsonb_build_object('max_call_secs', 105)
                       )
   where (coalesce(c.settings, '{}'::jsonb) -> 'voice_caps' ->> 'max_call_secs')
         is not null
     and (coalesce(c.settings, '{}'::jsonb) -> 'voice_caps' ->> 'max_call_secs')::int
         >= 105;

  get diagnostics v_touched = row_count;
  raise notice '0025: lowered max_call_secs to 105 on % client(s) that were at or above the 120s cut',
    v_touched;
end $$;

-- -----------------------------------------------------------------------------
-- 3. set_plan_voice_caps — apply a plan's allowance to one client.
--
--    Called by provision-feature when a voice entitlement activates. Without it
--    a paying client inherits the platform default instead of their plan, and a
--    $179/100-minute client can run unmetered minutes at real vendor cost.
--
--    DOES NOT OVERWRITE by default. Tiers above Starter are granted manually at
--    launch (see docs/landing-page-plan.md §5), so an operator may have already
--    set 250 or 600 on this client. Re-running provisioning must not knock them
--    back down to the entry allowance. Pass p_overwrite => true to force it.
--
--    Refuses negative minutes on purpose: -1 means "explicitly unlimited" in
--    0012's cap semantics, and provisioning must never be able to grant that.
-- -----------------------------------------------------------------------------
create or replace function set_plan_voice_caps(
  p_client_id       uuid,
  p_monthly_minutes int,
  p_max_call_secs   int default null,
  p_overwrite       boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_caps jsonb;
  v_new  jsonb;
begin
  if p_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'client_id is required');
  end if;
  if p_monthly_minutes is null or p_monthly_minutes < 0 then
    return jsonb_build_object(
      'ok', false,
      'error', 'monthly_minutes must be >= 0 (provisioning may not grant unlimited)');
  end if;

  select coalesce(settings -> 'voice_caps', '{}'::jsonb)
    into v_caps
    from clients
   where id = p_client_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;

  -- An explicit cap already exists and we weren't told to override it.
  --
  -- Tested with ->> rather than the `?` existence operator on purpose: a key
  -- present but JSON-null ({"monthly_minutes": null}) resolves to the platform
  -- default in client_voice_caps, so treating it as "already set" would skip the
  -- client and quietly leave them uncapped. This matches the backfill's
  -- predicate in section 1 exactly.
  if not p_overwrite and (v_caps ->> 'monthly_minutes') is not null then
    return jsonb_build_object(
      'ok', true,
      'changed', false,
      'reason', 'cap_already_set',
      'monthly_minutes', (v_caps ->> 'monthly_minutes')::numeric);
  end if;

  v_new := v_caps || jsonb_build_object('monthly_minutes', p_monthly_minutes);
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
    'monthly_minutes', p_monthly_minutes,
    'max_call_secs', p_max_call_secs);
end;
$$;

-- Orchestration RPC: service_role only, same posture as 0012's gate and meter.
-- A tenant must never be able to raise its own allowance.
revoke execute on function set_plan_voice_caps(uuid, int, int, boolean) from public;
grant  execute on function set_plan_voice_caps(uuid, int, int, boolean) to service_role;

comment on function set_plan_voice_caps(uuid, int, int, boolean) is
  'Applies a plan allowance to one client''s voice_caps. Non-destructive by '
  'default so a manually-granted higher tier survives re-provisioning. Service '
  'role only.';

-- End of 0025.
