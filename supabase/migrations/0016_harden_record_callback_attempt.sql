-- =============================================================================
-- 0016_harden_record_callback_attempt.sql
-- Close a cross-tenant write hole in 0014's record_callback_attempt.
--
-- THE BUG: the function is `security definer` (so it bypasses review_queue's
-- RLS) and is granted to `authenticated`, but it never checks that the ticket
-- belongs to the caller's tenant. It selects client_id purely to stamp the
-- ticket_notes row. So any signed-in user of ANY client could pass another
-- tenant's ticket UUID and mark their callback completed — which also flips
-- review_queue.status to 'resolved', silently emptying someone else's queue.
--
-- Ticket UUIDs aren't guessable, so this is not a practical breach today, but
-- it's exactly the kind of definer-function gap the RLS model is supposed to
-- make impossible. Fix it before the dashboard starts calling it.
--
-- THE FIX: compare the ticket's client_id against current_client_id().
-- current_client_id() reads `users.client_id where id = auth.uid()`, so it is
-- NULL for service_role (no JWT). We therefore only enforce when it is
-- non-null: authenticated users are pinned to their own tenant, and the edge
-- functions calling in as service_role keep working unchanged.
--
-- Everything else about the function is byte-identical to 0014.
-- Safe to re-run.
-- =============================================================================

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

-- End of 0016.
