-- =============================================================================
-- 0083_role_checks.sql — viewers are read-only on SEO approvals and the review
-- queue, at the database, not just in the UI.
--
-- Until /team (0082) every workspace had one person, its admin, so "which
-- tenant" was the only question RLS asked. Now an invited viewer has the same
-- JWT shape as anyone else on the client, and the anon key is public: hiding a
-- button stops nobody from calling PostgREST directly. So:
--
--   current_user_can_act()  — caller is an ACTIVE admin or agent.
--   RESTRICTIVE policies    — ANDed with the existing tenant policies, so they
--                             can only narrow access, never widen it. Scoped
--                             `to authenticated`: service_role (edge functions,
--                             voice tools) is untouched.
--   RPC guards              — the three SECURITY DEFINER functions bypass RLS,
--                             so each checks the role itself. Bodies are
--                             otherwise byte-identical to 0055 / 0016.
--
-- Billing is admin-only, but it has no tenant write path in the database: the
-- /api/billing/* routes do it with the service role, and check the role there.
-- Draft edits (/seo-approvals Edit) likewise write via the service role
-- (lib/services/seo-draft-edits.ts) and are checked in the server action.
-- =============================================================================

create or replace function public.current_user_can_act()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users
     where id = auth.uid() and is_active and role in ('admin', 'agent')
  );
$$;

revoke all on function public.current_user_can_act() from public, anon;
grant execute on function public.current_user_can_act() to authenticated;


-- -----------------------------------------------------------------------------
-- SEO approvals: approve / reject is a direct UPDATE (0042's
-- seo_actions_tenant_approve). Tenants have no insert/delete on seo_actions.
-- -----------------------------------------------------------------------------
drop policy if exists seo_actions_role_update on public.seo_actions;
create policy seo_actions_role_update on public.seo_actions
  as restrictive for update to authenticated
  using (public.current_user_can_act())
  with check (public.current_user_can_act());


-- -----------------------------------------------------------------------------
-- Review queue + its notes: 0001 / 0014 tenant policies are FOR ALL, so close
-- insert, update and delete (select stays as it was).
-- -----------------------------------------------------------------------------
drop policy if exists review_queue_role_insert on public.review_queue;
create policy review_queue_role_insert on public.review_queue
  as restrictive for insert to authenticated
  with check (public.current_user_can_act());

drop policy if exists review_queue_role_update on public.review_queue;
create policy review_queue_role_update on public.review_queue
  as restrictive for update to authenticated
  using (public.current_user_can_act())
  with check (public.current_user_can_act());

drop policy if exists review_queue_role_delete on public.review_queue;
create policy review_queue_role_delete on public.review_queue
  as restrictive for delete to authenticated
  using (public.current_user_can_act());

drop policy if exists ticket_notes_role_insert on public.ticket_notes;
create policy ticket_notes_role_insert on public.ticket_notes
  as restrictive for insert to authenticated
  with check (public.current_user_can_act());

drop policy if exists ticket_notes_role_update on public.ticket_notes;
create policy ticket_notes_role_update on public.ticket_notes
  as restrictive for update to authenticated
  using (public.current_user_can_act())
  with check (public.current_user_can_act());

drop policy if exists ticket_notes_role_delete on public.ticket_notes;
create policy ticket_notes_role_delete on public.ticket_notes
  as restrictive for delete to authenticated
  using (public.current_user_can_act());


-- -----------------------------------------------------------------------------
-- request_seo_rollback — same as 0055 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function request_seo_rollback(p_action_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row seo_actions%rowtype;
begin
  select * into v_row from seo_actions where id = p_action_id;
  -- Same answer for "not yours" and "doesn't exist" so it can't probe tenants.
  if not found or v_row.client_id is distinct from current_client_id() then
    return 'not_found';
  end if;
  -- 0083: viewers are read-only. (No service_role caller: auth.uid() is set.)
  if not current_user_can_act() then
    return 'not_allowed';
  end if;
  if v_row.status <> 'published' or v_row.apply_mode is distinct from 'api' then
    return 'not_rollbackable';
  end if;
  update seo_actions set status = 'rollback_requested' where id = p_action_id;
  return 'ok';
end;
$$;

revoke execute on function request_seo_rollback(uuid) from public, anon;
grant execute on function request_seo_rollback(uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- confirm_seo_manual_apply — same as 0055 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function confirm_seo_manual_apply(p_action_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row seo_actions%rowtype;
begin
  select * into v_row from seo_actions where id = p_action_id;
  if not found or v_row.client_id is distinct from current_client_id() then
    return 'not_found';
  end if;
  -- 0083: viewers are read-only.
  if not current_user_can_act() then
    return 'not_allowed';
  end if;
  if v_row.status <> 'manual_required' then
    return 'not_pending_manual';
  end if;
  update seo_actions
     set status = 'published',
         apply_mode = 'manual',
         published_at = now(),
         publish_result = coalesce(publish_result, '{}'::jsonb)
                          || jsonb_build_object('confirmed_manually_by', auth.uid(), 'verified', false)
   where id = p_action_id;
  return 'ok';
end;
$$;

revoke execute on function confirm_seo_manual_apply(uuid) from public, anon;
grant execute on function confirm_seo_manual_apply(uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- record_callback_attempt — same as 0016 plus the role guard. service_role
-- (no auth.uid()) is still trusted: voice tools log callbacks with it.
-- -----------------------------------------------------------------------------
create or replace function record_callback_attempt(
  p_ticket_id uuid,
  p_outcome   text,          -- 'attempted' | 'completed' | 'failed'
  p_note      text default null,
  p_author_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_caller uuid;
  v_att    int;
begin
  select client_id into v_client from review_queue where id = p_ticket_id;
  if v_client is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_ticket');
  end if;

  -- Tenant guard. NULL caller == service_role (no auth.uid()), which is trusted.
  v_caller := current_client_id();
  if v_caller is not null and v_caller <> v_client then
    -- Deliberately the same shape as unknown_ticket so this can't be used to
    -- probe which ticket ids exist in other tenants.
    return jsonb_build_object('ok', false, 'error', 'unknown_ticket');
  end if;

  -- 0083: a signed-in viewer is read-only.
  if auth.uid() is not null and not current_user_can_act() then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;

  if p_outcome not in ('attempted','completed','failed') then
    return jsonb_build_object('ok', false, 'error', 'bad_outcome');
  end if;

  update review_queue
     set callback_status   = p_outcome,
         callback_attempts = callback_attempts + 1,
         last_attempt_at   = now(),
         -- A completed callback closes the ticket; the others leave it open.
         status            = case when p_outcome = 'completed' then 'resolved' else status end,
         resolved_at       = case when p_outcome = 'completed' then now() else resolved_at end
   where id = p_ticket_id
   returning callback_attempts into v_att;

  if p_note is not null and trim(p_note) <> '' then
    insert into ticket_notes (ticket_id, client_id, author_id, body)
    values (p_ticket_id, v_client, p_author_id, p_note);
  end if;

  return jsonb_build_object('ok', true, 'attempts', v_att, 'outcome', p_outcome);
end;
$$;

revoke execute on function record_callback_attempt(uuid, text, text, uuid) from public;
grant  execute on function record_callback_attempt(uuid, text, text, uuid) to authenticated, service_role;

-- Verify: scripts/test_role_checks.sql (runs in a rolled-back transaction).

-- End of 0083.
