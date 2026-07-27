-- =============================================================================
-- 0010_client_phone_unique.sql
-- Structural fix for the duplicate-phone tenant-misrouting bug.
--
-- resolve_client_by_number matches a dialed number against clients.phone_number
-- with LIMIT 1. If two clients carry the same number (or a blank/duplicate row
-- shares one — which already happened once with +12135332469), an inbound call
-- routes to an ARBITRARY tenant → wrong calendar, empty slots. Nulling the stray
-- number fixed that instance, but nothing prevented it recurring.
--
-- This makes it impossible: at most one client per phone-number-digits. It
-- matches on the LAST 10 DIGITS, mirroring how the 0009 _appt_phone_key
-- normalizes numbers (tolerant of +1 / spaces / punctuation). NULL/blank phones
-- are left unconstrained, so any number of clients can have no number yet.
--
-- NOTE: if two live clients already share a number, this CREATE fails with a
-- clear unique-violation. Resolve the duplicate first:
--   update clients set phone_number = null
--    where right(regexp_replace(phone_number,'\D','','g'),10) = '<digits>'
--      and slug <> '<the client that should keep it>';
-- then re-run. Idempotent (if not exists).
-- =============================================================================

create unique index if not exists uq_clients_phone_digits
  on clients ((right(regexp_replace(phone_number, '\D', '', 'g'), 10)))
  where phone_number is not null
    and right(regexp_replace(phone_number, '\D', '', 'g'), 10) <> '';

-- End of 0010.
