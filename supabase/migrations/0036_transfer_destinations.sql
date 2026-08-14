-- =============================================================================
-- 0036_transfer_destinations.sql
--
-- ADVANCED TRANSFERS, data layer. Turns the single `settings.transfer_number`
-- scalar into an ordered list of routed destinations, and gives the tier ladder
-- a column that says how many of them a client is actually allowed.
--
-- WHY. "Advanced transfers" has been a Growth bullet since the pricing page
-- shipped (lib/entitlements.ts PLAN_TIERS, docs/landing-page-plan.md) with no
-- implementation behind it. 0031 made Growth SELF-SERVE, so since then a
-- customer can pay $279 + setup and receive transfer behaviour byte-identical
-- to Starter's: one number, no conditions, no after-hours rule. This migration
-- is the storage and enforcement half of closing that gap; the routing half is
-- in supabase/functions/voice-personalization/lib.ts.
--
-- WHAT IT ADDS
--   1. plan_tiers.transfer_destinations — the cap, as data, next to
--      included_minutes. Starter 1, Growth 4, Scale 4.
--   2. transfer_destination_limit(client) — the cap for one client, resolved
--      through their active voice entitlement's plan_tier.
--   3. settings.transfer_destinations — the contract, documented below, plus a
--      backfill from the legacy scalar so no live client changes behaviour.
--   4. get_client_config — gains `transfer_destinations`, ADDED TO the current
--      definition (see the 0035 note).
--
-- THE SHAPE. clients.settings.transfer_destinations is a JSON ARRAY. Order is
-- priority: the first entry is the primary, and it is the one the over-cap
-- deflect path and every legacy `transfer_number` reader falls back to.
--
--   [
--     {
--       "label": "Service dispatch",              -- required, human name
--       "number": "+14155550111",                 -- required, E.164
--       "when": "the caller has an existing job or needs a tech today",
--       "transfer_type": "blind",                 -- blind (default) | conference
--       "hours": "always"                         -- always (default) | business | after
--     },
--     ...
--   ]
--
-- WHY transfer_type DEFAULTS TO BLIND. A conference transfer keeps the
-- ElevenLabs leg bridged for the length of the human conversation, and since
-- 2026-08-13 the minute allowance is a HARD CAP — so a warm handoff on a busy
-- line can burn the month's minutes on calls the agent is no longer part of.
-- Blind / SIP REFER releases the leg. Conference stays available per
-- destination, opt-in, for the handoffs where the announcement is worth the
-- spend (typically the owner's mobile, not the main service line).
--
-- WHY `hours` IS HERE AND A FULL ON-CALL SCHEDULE IS NOT. FEATURE-GAPS.md §5
-- wants "who's on call" as a real scheduled thing with a dashboard. That's a
-- bigger build. A per-destination always/business/after flag costs one string,
-- is enforced in the prompt against hours the agent already knows, and covers
-- the common case (day line vs emergency mobile) without a scheduling UI.
--
-- NOT VALIDATED BY A CONSTRAINT, on purpose. `settings` is a shared jsonb blob
-- and a check constraint on it would reject writes to unrelated keys the moment
-- a malformed destination existed. Normalisation and rejection of bad entries
-- live in readTransferDestinations() in the voice-personalization lib, where
-- they are unit tested. §5 has the query for auditing what's actually stored.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The cap, as data.
--
--    Lives on plan_tiers for the same reason included_minutes does (0031 §1):
--    provisioning and the edge function both need to read it, and a TS constant
--    cannot be joined against. Mirrors PLAN_TIERS in lib/entitlements.ts, which
--    stays DISPLAY truth; this column is ENFORCEMENT truth.
--
--    FOUR IS NOT ARBITRARY. The shared ElevenLabs agent carries a fixed set of
--    transfer rules whose destinations are dynamic variables (transfer_1_number
--    … transfer_4_number). Raising this number above 4 without adding matching
--    rules in the agent gets you a destination the prompt offers and the agent
--    cannot dial. See docs/voice-agent-elevenlabs-config.md §5b.
-- -----------------------------------------------------------------------------
alter table plan_tiers
  add column if not exists transfer_destinations int not null default 1
    check (transfer_destinations between 1 and 4);

comment on column plan_tiers.transfer_destinations is
  'How many routed transfer destinations this tier may configure. 1 = the '
  'Starter behaviour (a single human line, no conditions). Capped at 4 by the '
  'number of transfer rule slots on the shared ElevenLabs agent — raising it '
  'requires adding rules there first (docs/voice-agent-elevenlabs-config.md).';

update plan_tiers set transfer_destinations = 1 where tier = 'starter';
update plan_tiers set transfer_destinations = 4 where tier = 'growth';
update plan_tiers set transfer_destinations = 4 where tier = 'scale';

-- -----------------------------------------------------------------------------
-- 2. The cap for one client.
--
--    Resolved through the client's ACTIVE voice entitlement. Three cases:
--
--      active entitlement with a plan_tier  -> that tier's cap
--      active entitlement, plan_tier null   -> 4 (the maximum)
--      no active voice entitlement          -> 1
--
--    THE NULL-TIER CASE IS DELIBERATELY GENEROUS. 0031 established that null
--    means "no tier known", not "starter": manual and trial grants have no
--    Stripe price and therefore no tier, and every pilot client on the system
--    today (Tsunami, Bud Club, the demo lines) is one. Those rows were created
--    by an operator who also writes settings.transfer_destinations by hand — the
--    decision has already been made by a human, and silently truncating their
--    config to one destination would break a live caller's escalation path to
--    enforce a price the client isn't on.
--
--    The cap exists to stop a PAYING STARTER from being handed the Growth
--    feature by a dashboard bug, which is the direction that actually costs
--    money. It is not a policing mechanism for operator grants.
-- -----------------------------------------------------------------------------
create or replace function transfer_destination_limit(p_client_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select case
               when e.plan_tier is null then 4
               else coalesce(t.transfer_destinations, 1)
             end
        from entitlements e
        left join plan_tiers t on t.tier = e.plan_tier
       where e.client_id = p_client_id
         and e.feature   = 'voice'
         and e.status    = 'active'
       order by e.started_at desc
       limit 1
    ),
    1
  );
$$;

revoke execute on function transfer_destination_limit(uuid) from public;
grant  execute on function transfer_destination_limit(uuid) to service_role;

comment on function transfer_destination_limit(uuid) is
  'How many entries of clients.settings.transfer_destinations this client may '
  'use, newest active voice entitlement wins. Null plan_tier (manual/trial '
  'grant) returns the maximum, not the Starter cap — see 0036 §2. No active '
  'voice entitlement returns 1.';

-- -----------------------------------------------------------------------------
-- 3. Backfill: every existing transfer_number becomes destination #1.
--
--    Idempotent and non-destructive. `transfer_number` is LEFT IN PLACE — it is
--    still read by voice-personalization's legacy path, by the over-cap deflect
--    builder, and by seed_hvac_client.sql. Deleting it here would be a silent
--    API change of exactly the kind 0035 exists to warn about; it can be
--    retired in its own migration once nothing reads it.
--
--    label/when are left generic because we do not know this client's routing
--    intent. A single generic destination reproduces today's behaviour exactly:
--    one line, offered when the caller wants a person.
-- -----------------------------------------------------------------------------
update clients c
   set settings = c.settings || jsonb_build_object(
         'transfer_destinations',
         jsonb_build_array(
           jsonb_build_object(
             'label',         'Main line',
             'number',        trim(c.settings ->> 'transfer_number'),
             'when',          'the caller asks for a person, or an emergency needs someone right now',
             'transfer_type', 'blind',
             'hours',         'always'
           )
         )
       )
 where nullif(trim(c.settings ->> 'transfer_number'), '') is not null
   and c.settings -> 'transfer_destinations' is null;

-- -----------------------------------------------------------------------------
-- 4. get_client_config gains the array.
--
--    READ THIS BEFORE EDITING. The object below is 0035's definition VERBATIM
--    with one key appended. It was not retyped from memory or from an older
--    migration — that is precisely what 0029 did, dropping order_number_prefix
--    and order_number_scheme and telling a live caller their order didn't
--    exist. `create or replace function` on a jsonb builder is an API change
--    with no compiler and no error. Start from `\sf get_client_config`, add,
--    never rewrite.
--
--    The new key is the RAW stored array, uncapped. Applying the tier limit
--    here would mean two different callers of this function disagree about a
--    client's config depending on when they called it; the cap is applied once,
--    at the point of use, by the voice-personalization function.
-- -----------------------------------------------------------------------------
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

    -- RESTORED (0017, dropped by 0029). Null when unset; callers must treat
    -- null as "no prefix".
    'order_number_prefix',   nullif(trim(c.settings ->> 'order_number_prefix'), ''),

    -- RESTORED (0022, dropped by 0029). Null when unset; callers must treat
    -- null as 'id'. WooCommerce only: id | search | meta:<key>.
    'order_number_scheme',   nullif(trim(c.settings ->> 'order_number_scheme'), ''),

    -- From 0029. An IANA name, always present, already validated. Callers
    -- format customer-facing dates in this rather than in UTC.
    'timezone',              client_timezone(c.id),

    -- From 0029. Where the agent sends a caller it cannot finish with.
    --   'callback' (default) -> take details, create a callback ticket
    --   'email'              -> may offer support_emails[0] instead
    'escalation_mode',       case
                               when c.settings ->> 'escalation_mode' = 'email'
                                 then 'email'
                               else 'callback'
                             end,

    -- NEW in 0036. Ordered, priority-first; [] when unset. RAW — the tier cap
    -- from transfer_destination_limit() is NOT applied here. Entry shape:
    -- {label, number, when, transfer_type: blind|conference, hours:
    -- always|business|after}. Callers must tolerate missing optional keys.
    'transfer_destinations', coalesce(
                               case
                                 when jsonb_typeof(c.settings -> 'transfer_destinations') = 'array'
                                   then c.settings -> 'transfer_destinations'
                               end,
                               '[]'::jsonb
                             )
  )
  from clients c
  where c.id = p_client_id;
$$;

revoke execute on function get_client_config(uuid) from public;
grant  execute on function get_client_config(uuid) to service_role;

comment on function get_client_config(uuid) is
  'Per-client config for the email and voice agents. settings keys read here: '
  'support_emails, order_number_prefix (0017), order_number_scheme (0022, '
  'WooCommerce only: id | search | meta:<key>), escalation_mode (0029), '
  'transfer_destinations (0036, raw array — apply transfer_destination_limit() '
  'at the point of use). timezone comes from client_timezone(). EDIT BY ADDING '
  'TO THE CURRENT DEFINITION — 0029 retyped this object from an older migration '
  'and silently dropped two keys (see 0035).';

-- -----------------------------------------------------------------------------
-- 5. Verify.
-- -----------------------------------------------------------------------------
-- Regression guard first — 0029's failure mode is a key going missing, so prove
-- the whole set is still there before looking at the new one:
--   select jsonb_object_keys(
--            get_client_config((select id from clients where slug = 'shopify-store'))
--          ) as key
--    order by 1;
--   -- expect: abnormal_status_rules, brand_tone_config, business_hours,
--   -- client_id, escalation_mode, is_active, name, order_number_prefix,
--   -- order_number_scheme, slug, store_base_url, store_platform,
--   -- support_emails, timezone, transfer_destinations
--
-- Backfill landed, and nobody lost their line:
--   select slug,
--          settings ->> 'transfer_number'                        as legacy,
--          jsonb_array_length(coalesce(
--            get_client_config(id) -> 'transfer_destinations', '[]'::jsonb)) as n,
--          transfer_destination_limit(id)                        as cap
--     from clients
--    order by slug;
--
-- Anyone configured beyond their cap (the prompt will silently truncate them —
-- this is the query that tells you why a client says a destination is ignored):
--   select c.slug,
--          jsonb_array_length(c.settings -> 'transfer_destinations') as configured,
--          transfer_destination_limit(c.id)                          as allowed
--     from clients c
--    where jsonb_typeof(c.settings -> 'transfer_destinations') = 'array'
--      and jsonb_array_length(c.settings -> 'transfer_destinations')
--          > transfer_destination_limit(c.id);
--
-- Malformed entries — no constraint enforces this, so audit it here. A bad
-- `number` is DROPPED by readTransferDestinations() and will never be dialled;
-- a missing `label` only costs the destination its name in the prompt:
--   select c.slug, d.value
--     from clients c
--    cross join lateral jsonb_array_elements(c.settings -> 'transfer_destinations') d
--    where jsonb_typeof(c.settings -> 'transfer_destinations') = 'array'
--      and (
--            nullif(trim(d.value ->> 'number'), '') is null
--         or d.value ->> 'number' !~ '^\+[1-9][0-9]{6,14}$'
--         or nullif(trim(d.value ->> 'label'), '')  is null
--          );
--
-- Display truth vs enforcement truth (0031 §7's rule, extended). PLAN_TIERS in
-- lib/entitlements.ts advertises "Advanced transfers" on Growth; this must show
-- Growth > Starter or the bullet is still a lie:
--   select tier, label, included_minutes, transfer_destinations
--     from plan_tiers order by sort_order;

-- End of 0036.
