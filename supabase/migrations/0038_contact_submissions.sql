-- =============================================================================
-- 0038_contact_submissions.sql
--
-- The public "/contact" form (2026-08-30 repositioning brief). This is NOT a
-- per-tenant table like everything else in this schema — it has no client_id
-- and isn't scoped by current_client_id(). It's LumiLink's own inbox: "new
-- here" and "already a customer" messages sent to LumiLink itself, not to one
-- of LumiLink's clients.
--
-- NO EMAIL PIPELINE EXISTS (docs/BUILD-PLAN-2026-08.md §E: no Resend, no
-- Postmark, no nodemailer anywhere in this repo). Submissions land here and
-- get checked in Supabase Studio for now. That's a deliberate, scoped choice,
-- not an oversight — building an inbox UI or wiring real email is separate
-- work for whenever it's actually needed.
--
-- RLS IS THE WHOLE SECURITY MODEL HERE, READ THIS BEFORE TOUCHING THE TABLE.
-- 0001 sets `alter default privileges ... grant select on tables to anon` and
-- `... grant select, insert, update, delete on tables to authenticated`. That
-- means the instant this table exists, EVERY anonymous visitor has a table
-- grant to SELECT it and EVERY signed-in customer has a table grant to
-- select/insert/update/delete it — table grants, not row access. RLS is what
-- actually gates rows. This migration enables RLS and defines exactly one
-- policy: anyone (anon or authenticated) may INSERT. There is no SELECT,
-- UPDATE, or DELETE policy for anon or authenticated, which means those
-- operations return zero rows / are denied for both — nobody (not even one of
-- LumiLink's own signed-in customers) can read another visitor's submission
-- through the app. service_role bypasses RLS entirely, which is how Supabase
-- Studio (and, later, an admin view or export job) actually reads these.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists contact_submissions (
  id          uuid        primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  -- Which of the two audiences the brief called for. Asked as an explicit
  -- toggle on the form rather than inferred from the message body, so triage
  -- doesn't depend on guessing intent from free text.
  audience    text        not null check (audience in ('new', 'existing')),
  name        text,
  email       text        not null check (email <> ''),
  message     text        not null check (message <> ''),
  -- Which page the form was on ("/contact" today; a per-vertical or
  -- per-partner contact form later would populate this with something more
  -- specific without needing a schema change).
  source_path text,
  -- Lightweight triage, settable from Studio until a real inbox UI exists.
  status      text        not null default 'new' check (status in ('new', 'read', 'handled'))
);

create index if not exists idx_contact_submissions_created_at
  on contact_submissions (created_at desc);

alter table contact_submissions enable row level security;

drop policy if exists contact_submissions_public_insert on contact_submissions;
create policy contact_submissions_public_insert on contact_submissions
  for insert
  to anon, authenticated
  with check (true);

-- Deliberately no select/update/delete policy for anon or authenticated — see
-- the header comment. service_role (Studio, and any future backend job)
-- bypasses RLS and can do all three without a policy.

comment on table contact_submissions is
  'LumiLink''s own "someone contacted us" inbox from the public /contact form. Not tenant-scoped — has no client_id. Read via Supabase Studio (service_role) until an admin view exists.';

-- End of 0038.
