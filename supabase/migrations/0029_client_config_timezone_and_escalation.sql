-- =============================================================================
-- 0029_client_config_timezone_and_escalation.sql
--
-- Two additions to get_client_config, both driven by the agent saying the wrong
-- thing on a live call.
--
-- 1. TIMEZONE — fixes orders being read back on the wrong DAY.
--
--    order_placed_at is stored as a UTC instant and handed to the agent as a
--    raw ISO string. An order placed at 18:00 on 31 July in Los Angeles is
--    2026-08-01T01:00:00Z, so the agent reads it as "August 1" to a caller who
--    placed it "today". Observed 2026-07-31.
--
--    The model has no way to know better: nothing in the payload says which
--    timezone the store keeps. Rather than let it guess, we render the date
--    in the client's own timezone before it ever reaches the prompt.
--
--    client_timezone() (0012) already resolves this from business_hours.tz,
--    falling back to settings.scheduling.timezone, then UTC — and it validates
--    the string against pg_timezone_names so a typo can't throw inside a call.
--    Exposing THAT rather than adding a second lookup keeps one definition of
--    what a client's timezone is.
--
-- 2. ESCALATION MODE — stop pointing callers at a support inbox.
--
--    The email channel is paused, so directing a caller to email support sends
--    them somewhere nobody is reading. Default is now a callback ticket, which
--    is a plan feature ("no customer request disappears") and keeps the thread
--    inside the product.
--
--    Kept configurable because a future client may run a real support inbox and
--    prefer it. Values are explicit rather than a boolean: 'callback' | 'email'
--    reads the same in the prompt, the settings UI and the database, with no
--    polarity to get backwards.
--
-- Additive: existing keys are untouched, so the email orchestration and every
-- other caller keep working.
-- =============================================================================

create or replace function get_client_config(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'client_id',             c.id,
    'name',                  c.name,
    'slug',                  c.slug,
    'is_active',             c.is_active,
    'store_platform',        c.store_platform,
    'store_base_url',        c.store_base_url,
    -- support_emails: prefer the settings.support_emails array; fall back to the
    -- legacy single support_email column; always hand back a (possibly empty) array.
    'support_emails',        coalesce(
                               nullif(c.settings -> 'support_emails', 'null'::jsonb),
                               case
                                 when c.support_email is not null
                                   then jsonb_build_array(c.support_email)
                                 else '[]'::jsonb
                               end
                             ),
    'brand_tone_config',     coalesce(c.brand_tone_config, '{}'::jsonb),
    'business_hours',        coalesce(c.business_hours, '{}'::jsonb),
    'abnormal_status_rules', coalesce(c.abnormal_status_rules, '{}'::jsonb),

    -- NEW. An IANA name, always present, already validated. Callers format
    -- customer-facing dates in this rather than in UTC.
    'timezone',              client_timezone(c.id),

    -- NEW. Where the agent sends a caller it cannot finish with.
    --   'callback' (default) -> take details, create a callback ticket
    --   'email'              -> may offer support_emails[0] instead
    -- Anything unrecognised falls back to 'callback': if the config is wrong we
    -- would rather capture the request than send someone to an unread inbox.
    'escalation_mode',       case
                               when c.settings ->> 'escalation_mode' = 'email'
                                 then 'email'
                               else 'callback'
                             end
  )
  from clients c
  where c.id = p_client_id;
$$;

revoke execute on function get_client_config(uuid) from public;
grant  execute on function get_client_config(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Set our own stores explicitly rather than relying on the default, so the
-- value is visible in the row and an operator can see what was intended.
--
-- Both keep callback tickets. Neither has an inbox anyone is watching while the
-- email channel is paused.
-- -----------------------------------------------------------------------------
update clients
   set settings = coalesce(settings, '{}'::jsonb)
                  || jsonb_build_object('escalation_mode', 'callback')
 where slug in ('shopify-store', 'budmember001', 'northlake-demo')
   and coalesce(settings ->> 'escalation_mode', '') <> 'callback';

-- Verify:
--   select slug,
--          get_client_config(id) ->> 'timezone'        as tz,
--          get_client_config(id) ->> 'escalation_mode' as escalation
--     from clients order by slug;

-- End of 0029.
