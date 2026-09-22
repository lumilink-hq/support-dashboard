-- =============================================================================
-- 0054_seo_action_queue.sql
-- Module 8 (plan.md): findings -> drafts -> approval queue. 0042 already made
-- seo_findings and seo_actions and the tenant approve/reject policy; this adds
-- what the drafting job and the approval UI need on top.
--
-- 1. seo_actions.finding_type / target_url. finding_id is `on delete set null`
--    and seo-crawl deletes-and-reinserts OPEN findings weekly, so an action can
--    outlive its finding. The action carries what it is about on its own.
--
-- 2. One LIVE action per (location, page, field). Without it a second drafting
--    run, or the next weekly crawl re-detecting the same issue, would queue a
--    duplicate draft for a human to approve twice. 'live' = draft,
--    pending_approval or approved (approved but not yet published by module 5).
--
-- 3. protect_seo_actions_tenant_columns. 0042's tenant policy only pins the
--    ROW transition (pending_approval -> approved/rejected). `authenticated`
--    still holds table-wide UPDATE (0001; see 0043 for why a column REVOKE
--    can't narrow that), so a tenant could approve a row AND rewrite
--    proposed_value/diff/previous_value in the same statement: the diff a
--    person approved would no longer be what gets published. This trigger lets
--    `authenticated` change only status, approved_by and approved_at, and
--    stamps the last two itself so an approval can't be attributed to someone
--    else. Comparing to_jsonb(row) minus those columns means a column added
--    later is protected by default, unlike 0043's explicit list.
--
-- 4. seo_draft_targets + request_seo_draft/run_due_seo_drafts: the same
--    pg_cron -> pg_net -> edge function shape as 0049, per LOCATION. Only
--    locations with an open draftable finding and no live action for it are
--    targets, so a clean site costs nothing.
--
-- 5. vendor_budgets row for 'anthropic'. seo-draft reserves against it before
--    each model call (rule 6).
--
-- The DRAFTABLE finding_type list below is duplicated in
-- supabase/functions/seo-draft/lib.ts (DRAFTABLE). Keep them in step.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_actions
  add column if not exists finding_type text,
  add column if not exists target_url   text;

-- Rows from before this migration have no target_field, so they are outside
-- the index (the predicate below requires one).
create unique index if not exists uq_seo_actions_live
  on seo_actions (location_id, coalesce(target_url, ''), target_field)
  where target_field is not null
    and status in ('draft', 'pending_approval', 'approved');

-- -----------------------------------------------------------------------------
-- Tenant column protection
-- -----------------------------------------------------------------------------
create or replace function protect_seo_actions_tenant_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'authenticated' then
    if (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
       is distinct from
       (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
    then
      raise exception
        'a tenant may only approve or reject a draft; the draft itself is read-only '
        '(see 0054_seo_action_queue.sql)'
        using errcode = '42501';
    end if;

    if new.status is distinct from old.status then
      new.approved_by := auth.uid();
      new.approved_at := now();
    elsif new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at then
      raise exception 'approved_by / approved_at are set by the approval itself'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_seo_actions_tenant_columns on seo_actions;
create trigger trg_protect_seo_actions_tenant_columns
  before update on seo_actions
  for each row execute function protect_seo_actions_tenant_columns();

-- -----------------------------------------------------------------------------
-- Vendor budget
-- -----------------------------------------------------------------------------
insert into vendor_budgets (vendor, max_requests, window_seconds, note) values
  ('anthropic', 30, 60, 'seo-draft model calls; placeholder pending the account''s actual rate-limit tier.')
on conflict (vendor) do nothing;

-- -----------------------------------------------------------------------------
-- Scheduling
-- -----------------------------------------------------------------------------
create or replace view seo_draft_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_draft' and ja.entity_id = l.id
where l.is_active
  and exists (
    select 1
      from seo_findings f
     where f.location_id = l.id
       and f.status = 'open'
       and f.module = 'crawl'
       and f.finding_type in (
         'missing_title', 'title_length',
         'missing_meta_description', 'meta_description_length',
         'missing_h1',
         'missing_local_business_schema'
       )
       and not exists (
         select 1
           from seo_actions a
          where a.location_id = f.location_id
            and coalesce(a.target_url, '') = coalesce(f.target_url, '')
            and a.finding_type = f.finding_type
            and (
              a.status in ('draft', 'pending_approval', 'approved')
              -- a rejection is respected for 30 days, so a page the client
              -- said no to isn't re-drafted on the next crawl
              or (a.status = 'rejected' and a.updated_at > now() - interval '30 days')
            )
       )
  );

revoke all on seo_draft_targets from authenticated, anon;
grant select on seo_draft_targets to service_role;

create or replace function request_seo_draft(p_location_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid;
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  select client_id into v_client_id from seo_locations where id = p_location_id;
  if v_client_id is null then
    return null;
  end if;

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request drafting';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_draft', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  -- The model call itself is what vendor_budgets throttles: seo-draft reserves
  -- against 'anthropic' before each one, so it isn't reserved here too.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_draft_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_draft_url / voice_tool_secret not in Vault — cannot request drafting';
    perform complete_job_attempt(v_client_id, 'seo_draft', false, 'missing_vault_secret',
                                  1440, 1440, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 120000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_draft' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_draft(uuid) from public, authenticated;
grant execute on function request_seo_draft(uuid) to service_role;

create or replace function run_due_seo_drafts(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
begin
  for v_row in
    select location_id from seo_draft_targets
     where is_due
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_draft(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_drafts(int) from public, authenticated;
grant execute on function run_due_seo_drafts(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic SEO drafting NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-draft-due');
  exception when others then null;
  end;
  -- Offset from the crawl's :00 tick so drafting sees the crawl's findings. The
  -- daily cadence is the base interval in complete_job_attempt; this tick only
  -- decides how quickly a newly crawled location is picked up.
  perform cron.schedule('seo-draft-due', '20 * * * *', $cron$select run_due_seo_drafts();$cron$);
end;
$$;

comment on table seo_actions is
  'Approval queue (module 8). Drafted by seo-draft (service_role); a tenant can '
  'only approve or reject a pending_approval row, and cannot edit the draft '
  '(0054 trigger). previous_value + idempotency_key are rule 3; the target_field '
  'CHECK is rule 2''s DB-level backstop.';

-- End of 0054.
