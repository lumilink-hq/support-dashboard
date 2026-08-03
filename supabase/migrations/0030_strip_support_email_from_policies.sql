-- =============================================================================
-- 0030_strip_support_email_from_policies.sql
-- Stop the orders agent reading a support address out of its own reference text.
--
-- WHAT HAPPENED. escalation_mode (0029) governs what the agent does when it
-- ESCALATES. It does not govern what the agent knows. A caller asked Bud Club's
-- agent directly whether there was a support email, and it answered with one —
-- correctly, from the policy blob it had been handed:
--
--   'CONTACT: hey@budclub.com or budclub.com/contact. There is no support
--    phone line. '
--
-- settings.policies is surfaced verbatim as {{store_policies}}, so anything
-- written there is fair game for any question. The fix is two-sided:
--
--   * voice-personalization now prepends a CONTACT RULE above the policies when
--     escalation_mode is 'callback' — a directive outranks the material it
--     introduces.
--   * this migration removes the address from the stored text, so it is not in
--     the model's context to leak in the first place. Asked ten different ways,
--     a model will eventually read whatever is still in front of it.
--
-- WHY NOT A REGEX OVER EVERY CLIENT'S POLICIES. Addresses appear in prose as
-- "hey (at) budclub dot com" and similar, and a false positive silently deletes
-- a real policy sentence. Policies are per-client prose, so they are corrected
-- per client, deliberately.
--
-- The replacement keeps the SUBSTANCE — how to report a damaged item, where lab
-- results live, that there is no phone line — because those are real policies
-- the agent still needs. Only the address goes.
-- =============================================================================

update clients
   set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb),
         '{policies}',
         to_jsonb(
           replace(
             settings ->> 'policies',
             'CONTACT: hey@budclub.com or budclub.com/contact. There is no support phone line. ',
             'CONTACT: there is no support phone line and no support email. If a caller '
             || 'wants a person, take their name and number and log a callback ticket; the '
             || 'team follows up. Written requests such as damage reports or cancellations '
             || 'go through budclub.com/contact. '
           )
         )
       )
 where slug = 'budmember001'
   and settings ->> 'policies' like '%hey@budclub.com%';

-- The legacy column feeds get_client_config's support_emails array, which the
-- over-cap deflection reads. voice-personalization now gates that on
-- escalation_mode, so this is defence in depth rather than the fix.
--
-- NOT NULLED: the address is real and the email agent will want it if that
-- channel comes back. Moved aside instead, so nothing reads it by accident.
update clients
   set settings = coalesce(settings, '{}'::jsonb)
                  || jsonb_build_object('archived_support_email', support_email),
       support_email = null
 where slug in ('budmember001', 'shopify-store')
   and support_email is not null;

-- Verify no client's policy text still contains an address:
--   select slug,
--          settings ->> 'policies' ~ '[[:alnum:]._%+-]+@[[:alnum:].-]+' as has_email
--     from clients
--    where settings ? 'policies';
--
-- Restoring email support later:
--   update clients set support_email = settings ->> 'archived_support_email'
--    where settings ? 'archived_support_email';

-- End of 0030.
