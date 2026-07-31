-- =============================================================================
-- 0028_entitlement_gates_voice.sql
-- Make cancelling a plan actually stop the phone answering.
--
-- THE GAP. check_voice_allowance (0012) is the pre-call gate: voice-personalization
-- calls it before the agent picks up. It checks the global kill switch,
-- clients.is_active, voice_caps.enabled, and the minute/cost caps. It has never
-- looked at entitlements.
--
-- So `subscription_canceled` sets entitlements.status = 'canceled', /billing
-- flips to "Reactivate"... and the number keeps answering. The client stops
-- paying and we keep paying: ElevenLabs per minute, Twilio per minute, and
-- $1.15/month for a number nobody is billed for. Verified against a real
-- cancellation on 2026-07-31.
--
-- THE FIX, AND WHY IT DEFAULTS OFF. Adding the check unconditionally would take
-- every current client off the air instantly, because none of them have
-- entitlement rows yet — the same lockout that keeps ENFORCE_ENTITLEMENTS off in
-- the app. So the gate is behind a flag that starts false: nothing changes today.
--
-- Flip it in the SAME sitting as the app-side flag, after backfilling:
--   update platform_settings set enforce_entitlements = true where id = 1;
--   -- and set ENFORCE_ENTITLEMENTS=1 in the app
--
-- The two are independent switches over the same policy: the app one controls
-- what a tenant can SEE, this one controls what their phone line can DO. Leaving
-- them out of step is survivable in one direction only — a locked dashboard with
-- a working phone is confusing; an open dashboard with a dead phone is an outage.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

alter table platform_settings
  add column if not exists enforce_entitlements boolean not null default false;

comment on column platform_settings.enforce_entitlements is
  'When true, check_voice_allowance requires a usable voice entitlement '
  '(active or past_due). Default false so clients without entitlement rows keep '
  'working. Flip together with the app''s ENFORCE_ENTITLEMENTS, after backfill.';

-- -----------------------------------------------------------------------------
-- Replaces 0012's check_voice_allowance. Only the entitlement check is new;
-- every other branch, reason string and returned field is unchanged, so callers
-- and the four enforcement points need no edits.
-- -----------------------------------------------------------------------------
create or replace function check_voice_allowance(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caps         jsonb;
  v_tz           text;
  v_plat         platform_settings%rowtype;
  v_active       boolean;
  v_ent_ok       boolean;
  v_month_start  timestamptz;
  v_day_start    timestamptz;
  v_min_month    numeric := 0;
  v_min_day      numeric := 0;
  v_cost_month   numeric := 0;
  v_cap_min      numeric;
  v_cap_day      numeric;
  v_cap_cost     numeric;
  v_pct          numeric := 0;
  v_reason       text    := 'ok';
  v_allowed      boolean := true;
begin
  select is_active into v_active from clients where id = p_client_id;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_client');
  end if;

  v_caps := client_voice_caps(p_client_id);
  v_tz   := client_timezone(p_client_id);
  select * into v_plat from platform_settings where id = 1;

  -- Does this client hold a usable voice entitlement? past_due counts: a failed
  -- card is a dunning problem, and cutting the phone off mid-billing-cycle is a
  -- worse outcome than carrying them for a few days.
  if coalesce(v_plat.enforce_entitlements, false) then
    select exists (
      select 1 from entitlements
       where client_id = p_client_id
         and feature = 'voice'
         and status in ('active', 'past_due')
    ) into v_ent_ok;
  else
    v_ent_ok := true;
  end if;

  v_month_start := (date_trunc('month', (now() at time zone v_tz)) at time zone v_tz);
  v_day_start   := (date_trunc('day',   (now() at time zone v_tz)) at time zone v_tz);

  select coalesce(sum(duration_secs), 0) / 60.0,
         coalesce(sum(est_cost_usd), 0)
    into v_min_month, v_cost_month
  from voice_usage_events
  where client_id = p_client_id and started_at >= v_month_start;

  select coalesce(sum(duration_secs), 0) / 60.0
    into v_min_day
  from voice_usage_events
  where client_id = p_client_id and started_at >= v_day_start;

  v_cap_min  := (v_caps ->> 'monthly_minutes')::numeric;
  v_cap_day  := (v_caps ->> 'daily_minutes')::numeric;
  v_cap_cost := (v_caps ->> 'monthly_cost_usd')::numeric;

  if v_cap_min is not null and v_cap_min > 0 then
    v_pct := round((v_min_month / v_cap_min) * 100, 1);
  end if;

  -- Reason precedence: broadest/most deliberate switch wins. The entitlement
  -- check sits just under the operator switches and above usage caps — "you
  -- don't have a plan" is a truer answer than "you're over your minutes".
  if not coalesce(v_plat.voice_enabled, true) then
    v_allowed := false; v_reason := 'global_pause';
  elsif not coalesce(v_active, true) then
    v_allowed := false; v_reason := 'client_inactive';
  elsif not coalesce((v_caps ->> 'enabled')::boolean, true) then
    v_allowed := false; v_reason := 'client_disabled';
  elsif not v_ent_ok then
    v_allowed := false; v_reason := 'no_entitlement';
  elsif v_cap_min is not null and v_cap_min >= 0 and v_min_month >= v_cap_min then
    v_allowed := false; v_reason := 'over_monthly_minutes';
  elsif v_cap_cost is not null and v_cap_cost >= 0 and v_cost_month >= v_cap_cost then
    v_allowed := false; v_reason := 'over_monthly_cost';
  elsif v_cap_day is not null and v_cap_day >= 0 and v_min_day >= v_cap_day then
    v_allowed := false; v_reason := 'over_daily_minutes';
  end if;

  return jsonb_build_object(
    'allowed',            v_allowed,
    'reason',             v_reason,
    'minutes_used',       round(v_min_month, 2),
    'minutes_cap',        v_cap_min,
    'minutes_remaining',  case
                            when v_cap_min is null or v_cap_min < 0 then null
                            else greatest(round(v_cap_min - v_min_month, 2), 0)
                          end,
    'pct_used',           v_pct,
    'warn',               v_pct >= 80,
    'daily_minutes_used', round(v_min_day, 2),
    'daily_minutes_cap',  v_cap_day,
    'cost_used',          round(v_cost_month, 2),
    'cost_cap',           v_cap_cost,
    'max_call_secs',      (v_caps ->> 'max_call_secs')::int,
    'timezone',           v_tz,
    'period_start',       v_month_start
  );
end;
$$;

revoke execute on function check_voice_allowance(uuid) from public;
grant  execute on function check_voice_allowance(uuid) to service_role;

-- NOTE: the caller turns `allowed=false` into a polite deflect. 'no_entitlement'
-- is a new reason string — check voice-personalization handles an unknown reason
-- gracefully (it should already, since it deflects on any false).

-- End of 0028.
